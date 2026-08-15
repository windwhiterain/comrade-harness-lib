import { buildSystemPrompt, composeMessages, loadHistory, runTools, streamLLM } from "./nodes";
import type {
  ChatMessage,
  CutStep,
  Flow,
  FlowContext,
  HistoryStep,
  LLMDelta,
  LLMResult,
  LLMUsage,
  ToolCall,
} from "./types";

// 子图（层级 1）= 数据流的可复用片段：普通函数，用控制流把节点（nodes.ts，层级 0）串成完整语义。
// 层级 2 的 standardFlow 是三个子图的默认组合，core 的 src/index.ts 一行 standardFlow() 即完整 harness。
// 定制阶梯（逐层深入，每层都可替换）：
//   1. 选项：换 systemPrompt / 历史窗口（history: N）
//   2. hooks：工具拦截/审批（loop.hooks.beforeTools）、吞 LLM 错误（loop.hooks.llmError）、换 LLM 节点（loop.llm）
//   3. 整层换函数：load / loop / save 直接传函数
//   4. 不用 standardFlow：手拼子图（loadContext → 插入节点 → agentLoop → saveTurn）
//   5. 用节点完全手写
// 没有注册表、没有图结构——子图就是普通函数。

export interface LoadContextOptions {
  /** 系统提示词：缺省 buildSystemPrompt(ctx.coreId)；传函数 = 动态生成。 */
  systemPrompt?: string | ((ctx: FlowContext) => string);
  /** 显式窗口：只取最近 history 条消息（缺省 = 全量，不过滤不截断）；0 = 不读历史（每轮独立）。 */
  history?: number;
}

/** 上下文子图：系统提示词 + 历史 + 本条用户消息 → LLM 消息数组。
 *  默认全量历史进上下文，消息按 OpenAI 标准形状原样回传（严格存储严格重建，见 nodes.ts loadHistory）。
 *  重新生成模式（ctx.regen）：不新增用户消息，LLM 输入的最后一条 = 历史中最后一条 user/assistant（重新回答它）。
 *  允许空消息（交互理念：给用户最大的上下文控制）：文本为空也拼一条 user{content:""} 空消息——
 *  空消息是用户手动"继续"的显式表达，进历史进上下文，模型看到空 user 消息自然接着继续。
 *  不自动插入任何"（继续）"——继续与否完全由用户控制（发空消息）。 */
export function loadContext(ctx: FlowContext, opts: LoadContextOptions = {}): ChatMessage[] {
  const system =
    typeof opts.systemPrompt === "function"
      ? opts.systemPrompt(ctx)
      : (opts.systemPrompt ?? buildSystemPrompt(ctx.coreId));
  const history = loadHistory(ctx.memory, opts.history);
  if (ctx.regen) {
    // 重新回答最后一条 user/assistant/tool（tool 结尾 = UI 的"工具结果"大框请求：以最后一条工具
    // 结果为上下文终点重新生成）；历史为空时没有可重生成的消息，退回纯历史（不生成空 user 消息）
    const last = ctx.memory.list().reverse()
      .find((m) => m.role === "user" || m.role === "assistant" || m.role === "tool")?.content ?? "";
    return last ? composeMessages(system, history, last) : [{ role: "system", content: system }, ...history];
  }
  // 允许空消息：文本为空 = 一条空 user 消息（用户手动"继续"的显式表达，进上下文，模型接着继续）
  return composeMessages(system, history, ctx.userText);
}

export interface AgentLoopHooks {
  /** 工具执行前拦截/审批：包 next(...) 或在前后加逻辑；缺省直接执行。 */
  beforeTools?(
    ctx: FlowContext,
    toolCalls: ToolCall[],
    next: (calls: ToolCall[]) => Promise<{ messages: ChatMessage[]; done: string | null }>,
  ): Promise<{ messages: ChatMessage[]; done: string | null }>;
  /** LLM 调用抛错：返回回复文本 = 吞掉错误、用它的回复继续；不返回 = 默认「LLM 调用失败: …」。 */
  llmError?(ctx: FlowContext, err: unknown): string | null;
}

export interface AgentLoopOptions {
  /** 换 LLM 节点（多模型路由/流式/重试）：缺省 streamLLM(ctx.llm, ctx.tools, …)；自换时记得接 ctx.abortSignal。 */
  llm?: (ctx: FlowContext, messages: ChatMessage[], onDelta: (d: LLMDelta) => void) => Promise<LLMResult>;
  hooks?: AgentLoopHooks;
  /** 实时落盘（默认 true）：每条消息产生后立即写进 ctx.memory（流式内容随时中断不丢）。
   *  false = 循环结束后由 saveTurn 一次性写（旧行为）。standardFlow 默认 live 并用它接管落盘。 */
  live?: boolean;
}

/** agent 循环子图：LLM 节点 ↔ 工具节点，普通 for + if。
 *  不设步数上限——循环只在两种情况下退出：LLM 不再调用工具（拿到最终回复），或工具返回 done（任务收尾）。
 *  每轮 LLM 响应按 OpenAI 标准消息原样累积进 messages（assistant{content, reasoning_content, tool_calls}
 *  三字段一体；工具结果 = 独立 tool 消息）——**实时落盘（live，默认开）**：每条消息产生后立即写进
 *  ctx.memory（含日志行 role="step"），不等回合结束——流式内容随时中断（abort/断连/刷新）都已存库，
 *  重绘/重载后内容不丢；UI 的 SSE 事件与 DB 同源同构。live: false 时回到旧行为（循环结束后由 saveTurn
 *  一次性写）。**严格存储严格重建**：存的就是标准消息，loadHistory 原样回传，不拆不并。
 *  同时经 ctx.emit 实时推给请求方（SSE）：思考/工具实时上屏，最终回复逐字流出（JSON 模式是 no-op，行为一致）。
 *  终止（ctx.abortSignal，POST /api/abort）：LLM 调用被中断——半截思考落库（思考过程，UI 显示思考卡），
 *  半截 content 绝不落成最终回复（手动 abort 后思考泄露进回复是真实踩过的坑），只记 cut(aborted) 日志；
 *  信号也传给工具——run_cmd 会杀掉子进程、daemon 调用中断（工具不再"原子跑完"）；工具轮之间也检查，
 *  终止后不再进下一轮。已完成的步骤照存。 */
/** 自动续跑上限：截断后带半截思考重试的轮数。防网关硬顶（每轮输入更大）时无限重试烧钱；
 *  达到上限放弃本轮（cut 日志 giveUp，不落空回复）。 */
const MAX_RESUME = 5;

export async function agentLoop(
  ctx: FlowContext,
  messages: ChatMessage[],
  opts: AgentLoopOptions = {},
): Promise<{ reply: string; messages: ChatMessage[]; logs: HistoryStep[]; usage: LLMUsage[] }> {
  const live = opts.live ?? true; // 实时落盘：每条消息产生后立即写库（默认开——流式内容随时中断不丢）
  const logs: HistoryStep[] = [];
  const usage: LLMUsage[] = [];
  let reply: string | null = null;
  let resumeCount = 0;
  const initialLen = messages.length; // loadContext 的输出（历史 + 用户消息）；循环内 push 的 = 本次新增，落库
  const runLLM = opts.llm ?? ((c, msgs, on) => streamLLM(c.llm, c.tools, msgs, on, { signal: c.abortSignal }));
  // 实时落盘：写库 + 累积 messages/logs 保持同步（live: false 时纯累积，由 saveTurn 一次性写）
  const push = (msg: ChatMessage) => {
    messages.push(msg);
    if (live) ctx.memory.insert(msg);
  };
  const pushLog = (log: HistoryStep) => {
    logs.push(log);
    if (live) ctx.memory.insert({ role: "step", content: JSON.stringify(log) });
  };
  for (let step = 1; ; step++) {
    console.log(`[${ctx.coreId}] ── step ${step} ──`);
    let res: LLMResult;
    try {
      res = await runLLM(ctx, messages, (d) => {
        // ← 换 LLM 行为（多模型路由/流式/重试）就换 opts.llm
        if (d.type === "reasoning") ctx.emit({ type: "think", delta: d.text });
        else ctx.emit({ type: "delta", text: d.text });
      });
      if (res.usage) {
        usage.push(res.usage);
        pushLog({ type: "llm", usage: res.usage });
        ctx.emit({ type: "llm", usage: res.usage });
      }
    } catch (e) {
      if (ctx.abortSignal.aborted) {
        reply = "（已停止）";
        break;
      }
      const msg = `${e instanceof Error ? e.message : e}`;
      reply = opts.hooks?.llmError?.(ctx, e) ?? `LLM 调用失败: ${msg}`;
      // LLM 失败要落一行可见日志（UI 显示错误行）——不落的话 done 后重绘无变化，用户看到"回复凭空消失"
      pushLog({ type: "cut", error: `LLM 调用失败: ${msg}` });
      ctx.emit({ type: "cut", error: `LLM 调用失败: ${msg}` });
      break;
    }
    if (res.toolCalls.length === 0) {
      if (ctx.abortSignal.aborted) {
        // 终止在流式中途发生（readSSE 返回已生成的部分）：半截思考落库当思考过程（UI 显示思考卡，
        // 后续空消息请求还能接着续），半截 content 绝不落成最终回复（abort 泄露是真实踩过的坑），
        // 只记 aborted 日志。回复如实标"（已停止）"。
        if (res.reasoning) push({ role: "assistant", content: "", reasoning_content: res.reasoning });
        if (res.content?.trim()) pushLog({ type: "cut", aborted: true });
        reply = "（已停止）";
        break;
      }
      const text = (res.content ?? "").trim();
      if (text) {
        // 最终回复：一条标准 assistant 消息（content + reasoning_content 一体）落库
        push({ role: "assistant", content: res.content ?? "", ...(res.reasoning ? { reasoning_content: res.reasoning } : {}) });
        reply = text;
      } else {
        // 空回复：对话里不出现空消息/截断事件——只记 cut 日志行（像 LLM 统计那样展示，不进 LLM 上下文），
        // 不落 assistant 行。截断（finish=length/content_filter、流内 error、未收到 finish_reason）且有半截思考
        // → 自动续跑：半截思考以 assistant 的 reasoning_content 字段回传（DeepSeek 思考模式官方拼接语义——
        // 带 tools 的请求必须完整回传 reasoning_content，同轮内模型会继续之前的思考）。不自动插入"（继续）"——
        // 交互理念：继续与否完全由用户控制（发空消息）。MAX_RESUME 上限防网关硬顶（每轮输入更大）时
        // 无限重试烧钱；达到上限放弃本轮（cut 日志 giveUp），用户可手动空消息继续半截思考。
        const abnormal =
          res.error !== undefined ||
          res.finishReason === null ||
          (res.finishReason !== "stop" && res.finishReason !== "tool_calls");
        const cut: CutStep = {
          type: "cut",
          finish: res.finishReason ?? undefined,
          error: res.error ?? undefined,
          stopped: !abnormal,
        };
        if (abnormal && res.reasoning) {
          if (resumeCount >= MAX_RESUME) {
            const giveUp: CutStep = { ...cut, giveUp: true };
            pushLog(giveUp);
            ctx.emit(giveUp);
            reply = "";
            break;
          }
          pushLog(cut);
          ctx.emit(cut);
          resumeCount++;
          push({ role: "assistant", content: "", reasoning_content: res.reasoning });
          continue;
        }
        pushLog(cut);
        ctx.emit(cut);
        reply = "";
      }
      break;
    }
    // 工具轮：一条标准 assistant 消息（content + reasoning_content + tool_calls 一体，原样回传——
    // DeepSeek 要求带 tools 的请求必须完整回传 reasoning_content，这是模型"继续之前的思考"的官方机制）
    push({
      role: "assistant",
      content: res.content ?? "",
      ...(res.reasoning ? { reasoning_content: res.reasoning } : {}),
      tool_calls: res.toolCalls,
    });
    for (const tc of res.toolCalls) {
      console.log(`[${ctx.coreId}] 工具: ${tc.function.name} ${tc.function.arguments.slice(0, 100)}`);
      ctx.emit({ type: "tool", name: tc.function.name, args: tc.function.arguments });
    }
    const exec = (calls: ToolCall[]) => runTools(ctx.tools, calls, ctx.abortSignal);
    // ← 加工具拦截/审批就包这行（opts.hooks.beforeTools）
    let toolMsgs: ChatMessage[];
    let doneMsg = "";
    try {
      const { messages: tm, done: d } = opts.hooks?.beforeTools
        ? await opts.hooks.beforeTools(ctx, res.toolCalls, exec)
        : await exec(res.toolCalls);
      toolMsgs = tm;
      doneMsg = d ?? "";
    } catch (e) {
      // 工具执行失败：落一行可见日志再收尾——否则整个流 error 中断，UI 只看到"回复消失"（live 已落盘的部分仍保留）
      const msg = `${e instanceof Error ? e.message : e}`;
      pushLog({ type: "cut", error: `工具执行失败: ${msg}` });
      ctx.emit({ type: "cut", error: `工具执行失败: ${msg}` });
      reply = `工具执行失败: ${msg}`;
      break;
    }
    for (const tm of toolMsgs) {
      if (tm.role === "tool") ctx.emit({ type: "toolResult", name: res.toolCalls.find((t) => t.id === tm.tool_call_id)?.function.name ?? "?", result: tm.content });
    }
    if (doneMsg) {
      // 工具收尾（持久 bash 的 done 消息）：作为最终回复落一条 assistant
      push({ role: "assistant", content: doneMsg });
      reply = doneMsg;
      break;
    }
    for (const tm of toolMsgs) push(tm);
    if (ctx.abortSignal.aborted) {
      // 终止请求（工具轮已结束/被打断，不再进下一轮 LLM）——落一行"已停止"日志，UI 可见（不落的话 abort
      // 后重绘无变化，用户看到"回复消失"）
      pushLog({ type: "cut", aborted: true });
      ctx.emit({ type: "cut", aborted: true });
      reply = "（已停止）";
      break;
    }
    // 逐步暂停（请求带 pause: true，UI 输入框的 toggle）：每完成一步（工具已执行、结果已进上下文）停下来
    // 等用户继续——用户可输入消息插入步骤（空 = 只继续不插入），或终止（/api/abort → { aborted: true }，
    // 回复"（已停止）"）。开关没开时 ctx.pause 立即返回。
    const p = await ctx.pause();
    if ("aborted" in p) {
      reply = "（已停止）";
      break;
    }
    if (p.text) {
      push({ role: "user", content: p.text });
    }
  }
  return { reply: reply ?? "任务未完成（没有收到最终回复）。", messages: messages.slice(initialLen), logs, usage };
}

/** 记忆子图：把这一轮写回历史（**严格 OpenAI 标准**：user 消息 + 每条 LLM 响应的标准 assistant 消息
 *  （content/reasoning_content/tool_calls 一体）+ 工具结果 tool 消息，按序落库；日志行（cut/llm）以
 *  role="step" 存 JSON，只给 UI 展示、不进 LLM 上下文）。
 *  允许空消息：userText 为空也落一条空 user 消息（用户手动"继续"的显式表达，进历史进上下文，模型可见）。
 *  重新生成模式（ctx.regen，右键消息"请求"）不新增用户行——重生成目标消息是历史已有内容的重发，不落新行。 */
export function saveTurn(ctx: FlowContext, turn: { messages: ChatMessage[]; logs: HistoryStep[]; reply: string }): void {
  if (!ctx.regen) ctx.memory.insert({ role: "user", content: ctx.userText });
  for (const msg of turn.messages) ctx.memory.insert(msg);
  for (const log of turn.logs) ctx.memory.insert({ role: "step", content: JSON.stringify(log) });
}

export interface StandardFlowOptions {
  /** 系统提示词：缺省 buildSystemPrompt(ctx.coreId)；传函数 = 动态生成。 */
  systemPrompt?: string | ((ctx: FlowContext) => string);
  /** 上下文子图：选项对象（history 窗口）或整层替换函数。 */
  load?: LoadContextOptions | ((ctx: FlowContext) => ChatMessage[]);
  /** agent 循环子图：选项对象（llm 替换 / hooks / live）或整层替换函数。
   *  messages = 循环内新增的标准消息（live 时已实时落盘）；logs = 日志行（cut/llm）。 */
  loop?: AgentLoopOptions | ((ctx: FlowContext, messages: ChatMessage[]) => Promise<{ reply: string; messages: ChatMessage[]; logs?: HistoryStep[]; usage?: LLMUsage[] }>);
  /** 记忆写回：缺省 = **实时落盘**（agentLoop live，每条消息产生后立即写库——流式内容随时中断不丢；
   *  user 消息在循环前写入，回合结束不再整批写）。false = 完全不落盘；函数 = 自定义保存
   *  （此时 agentLoop 关 live，回到"循环结束后一次性写"的旧行为，save 收到完整 turn）。 */
  save?: false | ((ctx: FlowContext, turn: { messages: ChatMessage[]; logs: HistoryStep[]; reply: string }) => void);
}

/** 标准流（层级 2）：loadContext → agentLoop → 落盘（默认实时）的默认组合。
 *  定制阶梯见本文件顶部注释；替换点 = 旧注释「就换这行 / 就包这行」的位置。 */
export function standardFlow(opts: StandardFlowOptions = {}): Flow {
  return async (ctx) => {
    const messages =
      typeof opts.load === "function"
        ? await opts.load(ctx)
        : loadContext(ctx, { ...opts.load, systemPrompt: opts.systemPrompt });
    if (typeof opts.loop === "function") {
      // 整层替换：行为完全由函数决定，落盘照旧（saveTurn 或自定义 save）
      const { reply, messages: added, logs = [], usage } = await opts.loop(ctx, messages);
      if (opts.save !== false) (typeof opts.save === "function" ? opts.save : saveTurn)(ctx, { messages: added, logs, reply });
      return { reply, usage };
    }
    // 选项对象：agentLoop。默认实时落盘（live）——user 消息循环前写入，循环内消息 agentLoop 边产生边写。
    // 显式 save: false = 完全不落盘；save: 函数 = 关 live，循环结束后由自定义 save 一次性写。
    const live = opts.save !== false && typeof opts.save !== "function" && (opts.loop?.live ?? true);
    if (live && !ctx.regen) ctx.memory.insert({ role: "user", content: ctx.userText });
    const loopOpts: AgentLoopOptions = { ...opts.loop, live };
    const { reply, messages: added, logs = [], usage } = await agentLoop(ctx, messages, loopOpts);
    if (!live && opts.save !== false) (typeof opts.save === "function" ? opts.save : saveTurn)(ctx, { messages: added, logs, reply });
    return { reply, usage };
  };
}
