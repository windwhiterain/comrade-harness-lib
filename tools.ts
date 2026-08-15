import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { ToolDef, ToolPackage, ToolResult } from "./types";
import { translateWindowsPaths } from "./bash";

// 默认工具包：core 工作区的读写/执行/快照/回滚/fork + daemon 交互。
// 与 daemon 的交互走 REST（DAEMON_URL，COCKPIT_TOKEN 可选）；路径守卫内建。
//
// 工作区规则（两个根）：
//  - 自己的目录（CORE_DIR，daemon 注入；fork 出的 core 可能在项目外）
//  - cores 目录（CORES_DIR，所有 core 共享）
// 相对路径默认指自己；首段是已知 core id（含项目外 fork，daemon /api/cores 提供映射）时指那个 core。

const CORES_DIR = process.env.CORES_DIR ?? resolve("cores");
const CORE_ID = process.env.CORE_ID ?? "core";
const CORE_DIR = process.env.CORE_DIR ?? join(CORES_DIR, CORE_ID);
const DAEMON_URL = process.env.DAEMON_URL ?? "";
const TOKEN = process.env.COCKPIT_TOKEN?.trim() ?? "";
const MAX_OUT = 4000;

function authHeaders(): Record<string, string> {
  return TOKEN ? { authorization: `Bearer ${TOKEN}` } : {};
}

/** id → 实际目录 的映射（daemon /api/cores 提供；10s 缓存）。
 *  fork 出的 core 默认在 ~/.comrade-harness/cores（项目外），路径按 id 解析才能找到。 */
let dirCache: { at: number; map: Map<string, string> } | null = null;
async function coreDirMap(): Promise<Map<string, string>> {
  const now = Date.now();
  if (dirCache && now - dirCache.at < 10_000) return dirCache.map;
  const map = new Map<string, string>();
  try {
    const r = await fetch(`${DAEMON_URL}/api/cores`, { headers: authHeaders() });
    if (r.ok) {
      for (const c of (await r.json()) as { id: string; dir: string }[]) {
        if (c.dir) map.set(c.id, c.dir);
      }
    }
  } catch {}
  dirCache = { at: now, map };
  return map;
}

/** 工作区路径解析：
 *  绝对路径 → 必须落在本 core 目录 / cores 目录 / 某个 core 目录内（防越权读写）；
 *  相对路径 → 首段是本 core id 或已知 core id → 那个 core 的目录；否则 → 本 core 目录。 */
async function resolveWorkspace(p: string): Promise<string> {
  if (isAbsolute(p)) {
    const norm = (x: string) => x.replaceAll("/", sep);
    const full = resolve(p);
    const map = await coreDirMap();
    const roots = [norm(CORE_DIR), norm(CORES_DIR), ...[...map.values()].map(norm)];
    if (!roots.some((r) => full === r || full.startsWith(r + sep))) throw new Error(`路径越界: ${p}`);
    return full;
  }
  const first = p.split(/[\\/]/)[0];
  const rest = p.slice(first.length).replace(/^[\\/]/, "");
  if (first === CORE_ID) return resolve(CORE_DIR, rest);
  const map = await coreDirMap();
  if (map.has(first)) return resolve(map.get(first)!, rest);
  // daemon 不可达时的兜底：项目 cores/ 下真实存在的目录按 cores/ 解析
  if (existsSync(join(CORES_DIR, first))) return resolve(CORES_DIR, p);
  return resolve(CORE_DIR, p);
}

async function daemon(action: string, id: string, extra: Record<string, string> = {}, signal?: AbortSignal): Promise<string> {
  const q = new URLSearchParams(extra).toString();
  const r = await fetch(`${DAEMON_URL}/api/${action}/${id}${q ? `?${q}` : ""}`, {
    method: "POST",
    headers: authHeaders(),
    signal,
  });
  return JSON.stringify(await r.json());
}

async function readFileTool(args: { path: string }): Promise<string> {
  try {
    return await readFile(await resolveWorkspace(args.path), "utf-8");
  } catch (e) {
    return `读取失败: ${e instanceof Error ? e.message : e}`;
  }
}

async function writeFileTool(args: { path: string; content: string }): Promise<string> {
  try {
    const full = await resolveWorkspace(args.path);
    await mkdir(resolve(full, ".."), { recursive: true });
    await writeFile(full, args.content, "utf-8");
    return `已写入 ${args.path}（${args.content.length} 字符）`;
  } catch (e) {
    return `写入失败: ${e instanceof Error ? e.message : e}`;
  }
}

async function runCmdTool(args: { command: string }, signal?: AbortSignal): Promise<string> {
  const command = args.command?.trim();
  if (!command) return "(空命令)";
  // bun/bunx 前缀重写为当前 Bun 可执行文件（Windows 兼容，保留原行为）
  const rewritten = command
    .replace(/^bunx(\s)/, `${process.execPath} x$1`)
    .replace(/^bun(\s)/, `${process.execPath}$1`);
  // 必须异步 spawn（不能用 spawnSync）：同步阻塞会让整个 core 冻结——命令执行期间 /api/abort、
  // /health、其他会话的请求全都进不来（这正是"停止"无效的根因）；异步 + 信号才能真正杀掉命令。
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(["bash", "-c", translateWindowsPaths(rewritten)], {
      cwd: CORE_DIR,
      stdin: "ignore", // 命令读 stdin 直接 EOF，不挂着
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (e) {
    return `执行失败: ${e instanceof Error ? e.message : e}`;
  }
  // 并发排空 stdout/stderr：不读会撑爆管道缓冲，子进程写不进去而卡死
  const out: string[] = [];
  const drain = async (stream: ReadableStream<Uint8Array> | null) => {
    if (!stream) return;
    const reader = stream.getReader();
    const dec = new TextDecoder();
    for (;;) {
      let res: { done: boolean; value?: Uint8Array };
      try {
        res = await reader.read();
      } catch {
        break;
      }
      if (res.done) break;
      out.push(dec.decode(res.value, { stream: true }));
    }
  };
  const drained = Promise.all([drain(proc.stdout), drain(proc.stderr)]);

  // 终止：Windows 上 bash 的子进程不会随 bash 死，taskkill /T /F 连进程树一起杀（异步 spawn，不阻塞）；非 Windows 直接 kill。
  const killTree = () => {
    if (process.platform === "win32") {
      try {
        Bun.spawn(["taskkill", "/PID", String(proc.pid), "/T", "/F"], { stdio: ["ignore", "ignore", "ignore"] });
      } catch {}
    }
    try {
      proc.kill();
    } catch {}
  };
  let stopped: "timeout" | "abort" | null = null;
  const onAbort = () => {
    stopped = "abort";
    killTree();
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const exited = proc.exited.catch(() => null);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      stopped = "timeout";
      killTree();
      resolve(null);
    }, 60_000);
  });
  await Promise.race([exited, timedOut]);
  if (timer) clearTimeout(timer);
  if (signal) signal.removeEventListener("abort", onAbort);
  await Promise.race([drained, new Promise((r) => setTimeout(r, 500))]); // kill 后管道可能慢一拍才关

  const text = out.join("").trim();
  if (stopped === "timeout") return `命令超时（60s）\n${text.slice(-MAX_OUT)}`;
  if (stopped === "abort") return `（已停止）命令被终止\n${text.slice(-MAX_OUT)}`;
  return `exit=${await exited}\n${text.slice(-MAX_OUT)}`;
}

const snapshotTool = async (args: { id: string; message: string }, signal?: AbortSignal) => {
  return daemon("snapshot", args.id, { message: args.message }, signal);
};
const reloadTool = async (args: { id: string }, signal?: AbortSignal) => {
  return daemon("reload", args.id, {}, signal);
};
const rollbackTool = async (args: { id: string; sha: string }, signal?: AbortSignal) => {
  return daemon("rollback", args.id, { sha: args.sha }, signal);
};
const forkTool = async (args: { source: string; name?: string }, signal?: AbortSignal) => {
  // fork 不改源：允许 fork 任意 core（含模板）作来源。fork 直接基于源的最新提交——
  // 源有未提交修改时不会进新 core，daemon 会在结果里带 warning，先 snapshot 再 fork。
  const extra: Record<string, string> = {};
  if (args.name) extra.name = args.name;
  return daemon("fork", args.source, extra, signal);
};
const deleteCoreTool = async (args: { id: string }, signal?: AbortSignal) => {
  return daemon("delete", args.id, {}, signal);
};

async function coreInfoTool(signal?: AbortSignal): Promise<string> {
  try {
    const r = await fetch(`${DAEMON_URL}/api/cores`, { headers: authHeaders(), signal });
    return JSON.stringify(await r.json());
  } catch (e) {
    return `获取失败: ${e instanceof Error ? e.message : e}`;
  }
}

const TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "读取某个文件的内容。path 规则：自己的代码用相对路径（如 src/index.ts）；其他 core 用 <core id>/ 开头（如 standard/src/index.ts，工具自动知道每个 core 的实际位置，含项目外 fork）；也可用绝对路径",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "覆盖写入某个文件。path 规则同 read_file：自己的代码用相对路径（如 src/index.ts）；其他 core 用 <core id>/ 开头；也可用绝对路径。改动前先 read_file 了解现状，改动要小而精准",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_cmd",
      description:
        "在你自己的 core 目录里执行命令并返回输出。命令按 bash 语法执行（支持 &&、管道、重定向、通配符；Windows 盘符路径如 C:/x 会自动转换）。常用：bunx tsc --noEmit -p tsconfig.json 检查自己的类型；检查项目内其他 core 用 -p ../<id>/tsconfig.json（项目外 fork 用绝对路径）",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  },
  {
    type: "function",
    function: {
      name: "snapshot",
      description: "给指定 core 打 git 快照（提交当前工作区状态），返回新 sha。改动落盘后建议打快照",
      parameters: {
        type: "object",
        properties: { id: { type: "string" }, message: { type: "string" } },
        required: ["id", "message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reload",
      description:
        "对指定 core 做蓝绿重载（门禁 typecheck → spawn 新进程 → 健康检查 → 换血）。返回 {ok, error}；ok:false 时 error 是门禁/健康检查错误，据此修复",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
  },
  {
    type: "function",
    function: {
      name: "rollback",
      description: "把指定 core 回滚到某个快照 sha 并重载",
      parameters: {
        type: "object",
        properties: { id: { type: "string" }, sha: { type: "string" } },
        required: ["id", "sha"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fork_core",
      description:
        "从已有 core 复制出一个新 core（git clone：新 core 拥有源的全部 git 历史，之后独立演化）。源 core 不受影响。可以 fork 任意 core（含模板）。fork 直接基于源的最新提交——源有未提交修改时不会进新 core（daemon 会带 warning），必要时先 snapshot。name 省略时默认 <source>-fork",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", description: "要复制的源 core id，如 standard" },
          name: { type: "string", description: "新 core 名字（小写字母/数字/连字符），省略时默认 <source>-fork" },
        },
        required: ["source"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_core",
      description:
        "永久删除一个 core（不可恢复）：终止进程，删除它的目录（含全部 git 历史）和聊天数据库。删除前确认其中没有还需要的东西——没有后悔药",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "要删除的 core id" } },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "core_info",
      description:
        "返回所有 core 的实时状态（id/status/port/sha）。reload 自己或任何 core 之后，用它在 daemon 的视角确认新端口",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "done",
      description: "任务完成，用中文总结你做了什么。调用后任务结束",
      parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
    },
  },
];

/** 默认工具包：core 工作区（读写/执行/daemon 控制/fork）。 */
export function toolsCore(): ToolPackage {
  return {
    name: "core",
    tools: TOOLS,
    async exec(name: string, rawArgs: string, signal?: AbortSignal): Promise<ToolResult> {
      if (signal?.aborted) return { kind: "result", text: "（已停止）" }; // 终止请求：不再开始新工具
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(rawArgs || "{}");
      } catch {
        return { kind: "result", text: `参数不是合法 JSON: ${rawArgs}` };
      }
      try {
        switch (name) {
          case "read_file":
            return { kind: "result", text: await readFileTool(args as never) };
          case "write_file":
            return { kind: "result", text: await writeFileTool(args as never) };
          case "run_cmd":
            return { kind: "result", text: await runCmdTool(args as never, signal) };
          case "snapshot":
            return { kind: "result", text: await snapshotTool(args as never, signal) };
          case "reload":
            return { kind: "result", text: await reloadTool(args as never, signal) };
          case "rollback":
            return { kind: "result", text: await rollbackTool(args as never, signal) };
          case "fork_core":
            return { kind: "result", text: await forkTool(args as never, signal) };
          case "delete_core":
            return { kind: "result", text: await deleteCoreTool(args as never, signal) };
          case "core_info":
            return { kind: "result", text: await coreInfoTool(signal) };
          case "done":
            return { kind: "done", message: String(args.message ?? "") };
          default:
            return { kind: "result", text: `未知工具: ${name}` };
        }
      } catch (e) {
        return { kind: "result", text: `工具错误: ${e instanceof Error ? e.message : e}` };
      }
    },
  };
}
