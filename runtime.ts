import { existsSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { llmOpenAI } from "./llm";
import { sqliteSessionStore } from "./memory";
import { toolsCore } from "./tools";
import type { Flow, HarnessConfig, LLMProvider, MemoryStore, SessionStore, StreamEvent } from "./types";

// harness 运行时壳：HTTP 服务 + 资源注入 + 调用 core 的数据流。
// 它不知道 agent 循环长什么样——那属于 core 的 flow（src/index.ts 里的数据流代码）。
// 运行契约由 daemon 注入：PORT / CORE_ID / DB_PATH / DAEMON_URL / CORES_DIR；必须提供 GET /health → 200。

const PORT = Number(process.env.PORT ?? 8080);
const CORE_ID = process.env.CORE_ID ?? "core";
const CORES_DIR = process.env.CORES_DIR ?? resolve("cores");
const CORE_DIR = process.env.CORE_DIR ?? join(CORES_DIR, CORE_ID); // 本 core 实际目录（fork 出的可能在项目外）
// 模板 = 目录位于项目 cores/（搜索路径）之下（与 daemon 的 isTemplate 同源判定）：
// 模板可运行、可被 fork，但用户不能对它 commit；提示词据此告知 agent"你是模板，别改自己，要改先 fork"。
const IS_TEMPLATE =
  resolve(CORE_DIR).toLowerCase() === resolve(CORES_DIR).toLowerCase() ||
  resolve(CORE_DIR).toLowerCase().startsWith(resolve(CORES_DIR).toLowerCase() + sep);
// 可选控制面令牌：daemon 设置了 COCKPIT_TOKEN 时，/api/* 也要求同样的令牌（/health 保持开放供健康检查）
const TOKEN = process.env.COCKPIT_TOKEN?.trim() ?? "";

const json = (d: unknown, status = 200) =>
  new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });

/** SSE 响应：把 run 里 emit 的事件编码成 `event: <type>\ndata: <json>\n\n` 流出。
 *  客户端断开后 enqueue 会抛——emit 静默吞掉，flow 照常跑完（历史照存，busy 正常释放）。 */
function sseStream(run: (emit: (type: string, data: unknown) => void) => Promise<void>): Response {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      controller = null;
    },
  });
  const enc = new TextEncoder();
  const emit = (type: string, data: unknown) => {
    if (!controller) return;
    try {
      controller.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
    } catch {
      controller = null;
    }
  };
  // 独立函数收尾：captured 变量在外层流里会被收窄成初始值 null，读 controller 的收尾逻辑放这里（函数边界重置收窄）
  const finish = () => {
    if (!controller) return;
    try {
      controller.close();
    } catch {}
    controller = null;
  };
  void (async () => {
    try {
      await run(emit);
    } catch (e) {
      emit("error", { message: e instanceof Error ? e.message : String(e) });
    } finally {
      finish();
    }
  })();
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

/** 请求方要求 SSE 流式：Accept: text/event-stream。不带则返回与原来完全一致的 JSON。 */
const wantsSSE = (req: Request) => req.headers.get("accept")?.includes("text/event-stream") === true;

/** 请求里的会话 id：缺省 "default"（无 session 的请求 = 兼容锚点会话，行为与单会话时代一致）。 */
const resolveSession = (sid: unknown): string =>
  typeof sid === "string" && sid.trim() ? sid.trim() : "default";

function authed(req: Request, url: URL): boolean {
  if (!TOKEN) return true;
  if (req.headers.get("authorization") === `Bearer ${TOKEN}`) return true;
  return url.searchParams.get("token") === TOKEN;
}

/** 组装一个 core：Bun.serve + /health + /api/status(busy) + /api/messages(含 delete/truncate) + /api/chat + 静态托管。 */
export function createHarness(cfg: HarnessConfig) {
  const llm = cfg.llm ?? llmOpenAI();
  const tools = cfg.tools ?? [toolsCore()];
  // 记忆：缺省 = 会话化存储（消息池 + 会话引用列表，多会话）；自定义纯 MemoryStore → 单会话退化（无会话 API）
  const memory = cfg.memory ?? sqliteSessionStore(process.env.DB_PATH);
  const sessionStore: SessionStore | null = "session" in memory ? memory : null;
  const plainMemory: MemoryStore | null = "session" in memory ? null : memory;
  const memFor = (sessionId: string): MemoryStore =>
    sessionStore ? sessionStore.session(sessionId) : (plainMemory as MemoryStore);
  const selector = cfg.modelSelector ?? null;
  /** 会话级模型：该会话记过的 (provider, model) 固定构造一个 LLM——不污染全局、跨会话不串台、
   *  reload 后不丢（记录在 sessions 表）；无记录 / 记录失效 / 自定义选择器无 pinned → 回落全局 llm（当前选中项）。 */
  const llmFor = (sid: string): LLMProvider => {
    if (selector?.pinned && sessionStore?.sessionModel) {
      const m = sessionStore.sessionModel(sid);
      if (m) {
        const pinned = selector.pinned(m.providerId, m.modelId);
        if (pinned) return pinned;
      }
    }
    return llm;
  };
  const flow: Flow = cfg.flow;

  // 静态托管：core 的 ui.dir 优先，缺失文件回落 shared（缺省 = lib 自带 ui/——模板只需放变体差异；shared: null 关闭回落）
  const PUBLIC = cfg.ui ? resolve(cfg.ui.dir) : null;
  const SHARED =
    cfg.ui == null || cfg.ui.shared === null
      ? null
      : resolve(cfg.ui.shared ?? join(import.meta.dir, "ui"));
  const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
  };
  const serveStatic = (pathname: string): Response | null => {
    let rel: string;
    try {
      rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
    } catch {
      return null; // 畸形 URI（如孤立 %），按 404 处理
    }
    for (const root of [PUBLIC, SHARED]) {
      if (!root) continue;
      const file = resolve(root, rel);
      if (!file.startsWith(root + sep)) return null; // 防目录穿越（任一根命中即返回）
      if (existsSync(file) && statSync(file).isFile()) {
        const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
        // 不缓存：UI 是"改了刷新即生效"的开发工件，浏览器缓存会让人以为改动没生效
        return new Response(Bun.file(file), {
          headers: { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": "no-store" },
        });
      }
    }
    return null;
  };

  /** 会话级单飞互斥：同一会话同一时刻只跑一个任务（不同会话可并行——流是纯 ctx 函数，记忆是会话视图）。
   *  daemon 退役轮询 /api/status 的 busy = 任一会话在忙：换血时等所有在途任务说完。 */
  const busySessions = new Set<string>();
  /** 各会话当前任务的终止开关：POST /api/abort（带 session 只停该会话；不带 = 停全部）触发（幂等；无任务时 no-op）。 */
  const aborts = new Map<string, AbortController>();
  /** 逐步暂停：会话开关（每次消息请求的 pause 字段同步——暂停中也能改，关了后面的步骤不再停）
   *  + 暂停门（每步暂停时挂起任务，等用户继续/终止；busy 但暂停中 = 继续，不 409）。 */
  const pauseFlags = new Map<string, boolean>();
  type PauseResult = { text: string } | { aborted: true };
  const pauseGates = new Map<string, (r: PauseResult) => void>();

  /** 逐步暂停门：开关开启时暂停当前任务——发 pause 事件并挂起，等用户继续（消息插入/空继续）或终止。
   *  开关没开 → 立即返回 { text: "" }（零开销）。暂停期间流不写数据，Bun 的 idleTimeout（上限 255s）
   *  会剪长静默连接——每 30s 重发一次 pause 事件保活（UI 幂等处理）。abort 信号 → 返回 { aborted: true }。 */
  async function pauseFor(sid: string, emit: (ev: StreamEvent) => void, signal: AbortSignal): Promise<PauseResult> {
    if (!pauseFlags.get(sid)) return { text: "" };
    emit({ type: "pause" });
    const heartbeat = setInterval(() => emit({ type: "pause" }), 30_000);
    try {
      return await new Promise<PauseResult>((resolve) => {
        const finish = (r: PauseResult) => {
          if (pauseGates.get(sid) !== finish) return; // 已被其他路径解决（幂等）
          pauseGates.delete(sid);
          resolve(r);
        };
        pauseGates.set(sid, finish);
        signal.addEventListener("abort", () => finish({ aborted: true }), { once: true });
      });
    } finally {
      clearInterval(heartbeat);
    }
  }

  /** "以某条为最后一条"的上下文视图：list 截至 atId；insert 连续插在 atId 之后（返回新 id 供链式插入）。
   *  存储不支持时（纯 MemoryStore 无 listUntil/insertAfter）返回原视图——at 模式在请求层已被拒。 */
  function untilView(mem: MemoryStore, atId: number): MemoryStore {
    let last = atId;
    return {
      list: () => (mem.listUntil ? mem.listUntil(atId) : mem.list()),
      insert: (role: string, text: string) => {
        if (mem.insertAfter) {
          const id = mem.insertAfter(last, role, text);
          if (id != null) last = id;
        }
      },
      delete: mem.delete,
      truncate: mem.truncate,
    };
  }

  async function runFlowTask(text: string, sessionId: string, emit: (ev: StreamEvent) => void, atId?: number, regen?: boolean): Promise<string> {
    busySessions.add(sessionId);
    const ac = new AbortController();
    aborts.set(sessionId, ac);
    try {
      console.log(`[${CORE_ID}/${sessionId}] 收到: ${text.slice(0, 200)}${atId != null ? ` (at ${atId})` : ""}${regen ? " (regen)" : ""}`);
      const mem = memFor(sessionId);
      const { reply } = await flow({
        coreId: CORE_ID,
        template: IS_TEMPLATE,
        sessionId,
        userText: regen ? "" : text,
        regen,
        memory: atId != null ? untilView(mem, atId) : mem,
        llm: llmFor(sessionId),
        tools,
        emit,
        pause: () => pauseFor(sessionId, emit, ac.signal),
        abortSignal: ac.signal,
      });
      console.log(`[${CORE_ID}/${sessionId}] 回复: ${reply.slice(0, 300)}`);
      return reply;
    } finally {
      aborts.delete(sessionId);
      busySessions.delete(sessionId);
    }
  }

  const llmMissing = (sid: string) =>
    !llmFor(sid).ready()
      ? "未配置 LLM 密钥：设置环境变量 LLM_API_KEY（或 DEEPSEEK_API_KEY）。可用 .env 文件，Bun 会自动加载。"
      : null;

  Bun.serve({
    port: PORT,
    idleTimeout: 255, // Bun 上限；agent 循环可能跑几分钟，不能留默认 10s
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") return new Response("ok");
      // daemon 设置 COCKPIT_TOKEN 时，/api/* 需要同样的令牌；/health 保持开放
      if (url.pathname.startsWith("/api/") && !authed(req, url)) return json({ error: "unauthorized" }, 401);
      // daemon 换血时轮询这个端点：busy=true（任一会话在忙）表示旧进程还有在途 agent 任务，等它说完再退役
      if (url.pathname === "/api/status")
        return json({ core: CORE_ID, status: "healthy", busy: busySessions.size > 0, busySessions: [...busySessions] });
      // ---- 会话（多会话）：列表 / 新建（可 fork）/ 删除 / 导出 JSONL。default 是无 session 请求的兼容锚点。 ----
      if (url.pathname === "/api/sessions" && sessionStore) {
        if (req.method === "GET") return json(sessionStore.listSessions());
        if (req.method === "POST") {
          const { name, fork, at, settingsFrom } = (await req.json()) as
            { name?: unknown; fork?: unknown; at?: unknown; settingsFrom?: unknown };
          if (typeof name !== "string" || !name.trim()) return json({ error: "需要 name" }, 400);
          const atId = typeof at === "number" && Number.isInteger(at) && at > 0 ? at : undefined;
          const res = sessionStore.createSession(
            name,
            typeof fork === "string" && fork ? fork : undefined,
            atId,
            typeof settingsFrom === "string" && settingsFrom ? settingsFrom : undefined,
          );
          if ("error" in res) return json({ error: res.error }, 400);
          return json({ ok: true, id: res.id });
        }
      }
      if (url.pathname === "/api/sessions/delete" && sessionStore && req.method === "POST") {
        const { id } = (await req.json()) as { id?: unknown };
        if (typeof id !== "string" || !id) return json({ error: "需要 id" }, 400);
        // 运行中的会话禁止删除：flow 结束时还会往它的引用列表写消息，删了会留下脏状态。
        // 先停止（/api/abort）再删；检查与删除之间无 await（deleteSession 是同步的），原子。
        if (busySessions.has(id)) return json({ error: `会话 ${id} 正在跑任务，先停止再删除` }, 409);
        const err = sessionStore.deleteSession(id);
        if (err) return json({ error: err }, 400);
        return json({ ok: true });
      }
      // 导出：GET /api/sessions/<id>/export → JSONL（一行一条消息，含 step；备份/审计/调试用）
      const exportMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/export$/);
      if (exportMatch && sessionStore && req.method === "GET") {
        const out = sessionStore.exportSession(decodeURIComponent(exportMatch[1]));
        if (out == null) return json({ error: "没有这个会话" }, 404);
        return new Response(out, { headers: { "content-type": "application/x-ndjson; charset=utf-8" } });
      }
      // provider/模型切换（UI 用；GET 只读，POST 变更——与其余控制面同策略，需要令牌）。
      // 未配置选择器（无 ~/.agents/models.json）时该端点不存在，UI 自动隐藏选择行
      if (url.pathname === "/api/models" && selector) {
        if (req.method === "GET") {
          // session 参数：该会话记过的模型优先；无记录 = 全局当前选择（llmFor 的实际回落项）。
          // 显示必须等于实际将用的模型——旧的"启动锚点"会在全局被切换后让 UI 下拉说谎。
          const sid = url.searchParams.get("session");
          let current = selector.state();
          if (sid && sessionStore?.sessionModel) {
            const m = sessionStore.sessionModel(sid);
            if (m) current = m;
          }
          return json({ catalog: selector.catalog(), current });
        }
        if (req.method === "POST") {
          const { providerId, modelId, session } = (await req.json()) as {
            providerId?: unknown; modelId?: unknown; session?: unknown;
          };
          if (typeof providerId !== "string" || typeof modelId !== "string")
            return json({ error: "需要 providerId 和 modelId" }, 400);
          const err = selector.set(providerId, modelId);
          if (err) return json({ error: err }, 400);
          // 带 session 的切换：把选择记到该会话（无 session 的旧请求只切全局，不落库）
          if (session && sessionStore?.setSessionModel) {
            sessionStore.setSessionModel(resolveSession(session), providerId, modelId);
          }
          return json({ ok: true, current: selector.state() });
        }
      }
      if (url.pathname === "/api/messages" && req.method === "GET")
        return json(memFor(resolveSession(url.searchParams.get("session"))).list());
      if (url.pathname === "/api/messages" && req.method === "POST") {
        const { text, session, at, regen, pause } = (await req.json()) as
          { text?: unknown; session?: unknown; at?: unknown; regen?: unknown; pause?: unknown };
        const isRegen = regen === true;
        const sid = resolveSession(session);
        // 逐步暂停开关随每条消息同步（暂停中也能改：关了后面的步骤不再停）
        if (typeof pause === "boolean") pauseFlags.set(sid, pause);
        const gate = pauseGates.get(sid);
        if (gate) {
          // 会话暂停中：这条消息 = 继续——文本非空则插入为一条 user 消息（落在两步之间），空 = 只继续不插入
          if (isRegen || at != null) return json({ error: "会话暂停中，不支持 at/重新生成" }, 400);
          const msg = typeof text === "string" ? text.trim() : "";
          gate({ text: msg });
          return json({ ok: true, resumed: true });
        }
        if (busySessions.has(sid)) return json({ error: `${CORE_ID} 的会话 ${sid} 正忙，请等上一条消息结束` }, 409);
        const missing = llmMissing(sid);
        if (missing) return json({ ok: false, error: missing }, 500);
        // 空消息合法（允许发送空消息：UI 按"继续"用；暂停中的"空 = 只继续不插入"走上面的 gate 分支）
        const msg = typeof text === "string" ? text.trim() : "";
        // at 模式："以这条消息为最后一条"——上下文截至 at，新消息插入 at 之后（后续消息保留）
        const mem = memFor(sid);
        let atId: number | undefined;
        if (typeof at === "number" && Number.isInteger(at) && at > 0) {
          if (!mem.listUntil || !mem.insertAfter)
            return json({ error: "当前存储不支持在指定消息后插入（at）" }, 400);
          if (mem.listUntil(at).length === 0) return json({ error: "这条消息不在当前会话里" }, 400);
          atId = at;
        }
        if (isRegen && atId == null) return json({ error: "重新生成需要 at（以哪条消息为最后一条）" }, 400);
        if (wantsSSE(req)) {
          return sseStream(async (emit) => {
            const reply = await runFlowTask(msg, sid, (ev) => emit(ev.type, ev), atId, isRegen);
            emit("done", { reply });
          });
        }
        return json({ ok: true, reply: await runFlowTask(msg, sid, () => {}, atId, isRegen) });
      }
      // 终止任务：带 session 只停该会话；不带 = 停全部在跑任务（旧 UI/curl 兼容）。
      // abort 后 flow 在安全点退出：LLM 调用被中断并保留已生成部分；信号传给工具（run_cmd 杀子进程、
      // daemon 调用中断 fetch），工具轮之间也检查——随后回复"（已停止）"，busy 随之释放。
      if (url.pathname === "/api/abort" && req.method === "POST") {
        const { session } = (await req.json().catch(() => ({}))) as { session?: unknown };
        const targets = typeof session === "string" && session ? [session] : [...aborts.keys()];
        let aborted = false;
        for (const sid of targets) {
          const ac = aborts.get(sid);
          if (ac) {
            ac.abort();
            aborted = true;
          }
        }
        return json({ ok: true, aborted });
      }
      // 消息管理：删除单条 / 截断（删 id 及其之后的所有消息）——只动本会话的引用，共享的消息行留在池里。
      // 状态变更一律 POST（CSRF 防护，与 daemon 控制面同策略）。
      if (url.pathname === "/api/messages/delete" && req.method === "POST") {
        const { id, session } = (await req.json()) as { id?: unknown; session?: unknown };
        if (typeof id !== "number" || !Number.isInteger(id) || id < 1) return json({ error: "invalid id" }, 400);
        memFor(resolveSession(session)).delete(id);
        return json({ ok: true });
      }
      if (url.pathname === "/api/messages/truncate" && req.method === "POST") {
        const { id, session } = (await req.json()) as { id?: unknown; session?: unknown };
        if (typeof id !== "number" || !Number.isInteger(id) || id < 1) return json({ error: "invalid id" }, 400);
        memFor(resolveSession(session)).truncate(id);
        return json({ ok: true });
      }
      // 修改消息内容（copy-on-edit：只改本会话的引用，共享该消息的其他会话不受影响）
      if (url.pathname === "/api/messages/update" && req.method === "POST") {
        const { id, text, session } = (await req.json()) as { id?: unknown; text?: unknown; session?: unknown };
        if (typeof id !== "number" || !Number.isInteger(id) || id < 1) return json({ error: "invalid id" }, 400);
        if (typeof text !== "string" || !text.trim()) return json({ error: "内容不能为空" }, 400);
        const mem = memFor(resolveSession(session));
        if (!mem.updateText) return json({ error: "当前存储不支持修改消息" }, 400);
        if (mem.updateText(id, text) == null) return json({ error: "没有这条消息" }, 400);
        return json({ ok: true });
      }
      // agent 直连入口（daemon /api/chat 转发到这里；curl 也可直接打）
      if (url.pathname === "/api/chat" && req.method === "POST") {
        const { message, session, pause } = (await req.json()) as { message?: unknown; session?: unknown; pause?: unknown };
        const sid = resolveSession(session);
        if (typeof pause === "boolean") pauseFlags.set(sid, pause);
        const gate = pauseGates.get(sid);
        if (gate) {
          // 会话暂停中：这条消息 = 继续（语义与 /api/messages 一致：空 = 只继续不插入）
          const msg = typeof message === "string" ? message.trim() : "";
          gate({ text: msg });
          return json({ ok: true, resumed: true });
        }
        if (typeof message !== "string") return json({ error: "missing message" }, 400);
        const missing = llmMissing(sid);
        if (missing) return json({ error: missing }, 500);
        if (busySessions.has(sid)) return json({ error: `${CORE_ID} 的会话 ${sid} 忙，请等上一条任务结束` }, 409);
        if (wantsSSE(req)) {
          return sseStream(async (emit) => {
            const reply = await runFlowTask(message, sid, (ev) => emit(ev.type, ev));
            emit("done", { reply });
          });
        }
        return json({ reply: await runFlowTask(message, sid, () => {}) });
      }
      return serveStatic(url.pathname) ?? new Response("not found", { status: 404 });
    },
  });
  console.log(`[${CORE_ID}] 启动完成, 端口 ${PORT}, pid ${process.pid}`);
}
