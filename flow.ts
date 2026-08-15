import { buildSystemPrompt, composeMessages, loadHistory, runTools, streamLLM } from "./nodes";
import type {
  ChatMessage,
  Flow,
  FlowContext,
  HistoryStep,
  LLMDelta,
  LLMResult,
  LLMUsage,
  ToolCall,
  ToolStep,
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
 *  默认全量历史进上下文，step 行按标准 message 格式重建（think → assistant 文本；
 *  tool → assistant.tool_calls + tool 角色消息对，见 nodes.ts loadHistory）。
 *  重新生成模式（ctx.regen）：不新增用户消息，LLM 输入的最后一条 = 历史中最后一条 user/agent（重新回答它）。 */
export function loadContext(ctx: FlowContext, opts: LoadContextOptions = {}): ChatMessage[] {
  const system =
    typeof opts.systemPrompt === "function"
      ? opts.systemPrompt(ctx)
      : (opts.systemPrompt ?? buildSystemPrompt(ctx.coreId));
  const history = loadHistory(ctx.memory, opts.history);
  if (!ctx.regen) return composeMessages(system, history, ctx.userText);
  const last = ctx.memory.list().reverse().find((m) => m.role === "user" || m.role === "agent")?.text ?? "";
  return composeMessages(system, history, last);
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
}

/** agent 循环子图：LLM 节点 ↔ 工具节点，普通 for + if。
 *  不设步数上限——循环只在两种情况下退出：LLM 不再调用工具（拿到最终回复），或工具返回 done（任务收尾）。
 *  每轮的思考片段与工具调用（含参数/结果）收进返回的 steps（由 saveTurn 存库，UI 渲染 role="step" 卡片），
 *  同时经 ctx.emit 实时推给请求方（SSE）：思考/工具实时上屏，最终回复逐字流出（JSON 模式是 no-op，行为一致）。
 *  终止（ctx.abortSignal，POST /api/abort）：LLM 调用被中断——已生成的部分（思考或半截文本）收进 think 步骤
 *  当过程，回复标「（已停止）」，绝不把半截输出落成最终回复（手动 abort 后思考泄露进回复是真实踩过的坑）；
 *  信号也传给工具——run_cmd 会杀掉子进程、daemon 调用中断（工具不再"原子跑完"）；工具轮之间也检查，
 *  终止后不再进下一轮。已完成的步骤照存。 */
export async function agentLoop(
  ctx: FlowContext,
  messages: ChatMessage[],
  opts: AgentLoopOptions = {},
): Promise<{ reply: string; steps: HistoryStep[]; usage: LLMUsage[] }> {
  const steps: HistoryStep[] = [];
  const usage: LLMUsage[] = [];
  let reply: string | null = null;
  const runLLM = opts.llm ?? ((c, msgs, on) => streamLLM(c.llm, c.tools, msgs, on, { signal: c.abortSignal }));
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
        steps.push({ type: "llm", usage: res.usage });
        ctx.emit({ type: "llm", usage: res.usage });
      }
    } catch (e) {
      if (ctx.abortSignal.aborted) {
        reply = "（已停止）";
        break;
      }
      reply = opts.hooks?.llmError?.(ctx, e) ?? `LLM 调用失败: ${e instanceof Error ? e.message : e}`;
      break;
    }
    if (res.toolCalls.length === 0) {
      if (res.reasoning) steps.push({ type: "think", content: res.reasoning });
      const text = (res.content ?? "").trim();
      if (ctx.abortSignal.aborted) {
        // 终止在流式中途发生（readSSE 返回已生成的部分）：全部收进 think 步骤当过程——思考或半截文本都算，
        // 绝不落成最终回复（手动 abort 后思考泄露进回复是真实踩过的坑）。回复如实标"（已停止）"。
        if (text) steps.push({ type: "think", content: text });
        reply = "（已停止）";
      } else if (text) {
        reply = text;
      } else if (res.error || (res.finishReason && res.finishReason !== "stop" && res.finishReason !== "tool_calls")) {
        // 网关截流（finish=length/content_filter 或流内 error）：明说原因，别当普通空回复吞掉
        reply = `(空回复 · 流被网关截断: finish=${res.finishReason ?? "-"}${res.error ? ` error=${res.error}` : ""})`;
      } else if (!res.finishReason) {
        // OpenAI 兼容协议正常收尾必带 finish_reason；没有且内容为空 = 连接被掐断
        reply = "(空回复 · 流中断：未收到 finish_reason，连接疑似被网关掐断)";
      } else {
        reply = "(空回复)";
      }
      break;
    }
    if (res.reasoning) steps.push({ type: "think", content: res.reasoning });
    if (res.content?.trim()) {
      // 模型在工具轮里的注释性文本（如"我来查一下"）原样存成 think 步骤：只作过程展示，
      // 不冒充最终回复——最终回复只在不再调用工具的那一轮产生
      steps.push({ type: "think", content: res.content.trim() });
    }
    messages.push({ role: "assistant", content: res.content ?? "", tool_calls: res.toolCalls });
    const toolSteps: ToolStep[] = [];
    for (const tc of res.toolCalls) {
      console.log(`[${ctx.coreId}] 工具: ${tc.function.name} ${tc.function.arguments.slice(0, 100)}`);
      ctx.emit({ type: "tool", name: tc.function.name, args: tc.function.arguments });
      toolSteps.push({ type: "tool", name: tc.function.name, args: tc.function.arguments });
    }
    const exec = (calls: ToolCall[]) => runTools(ctx.tools, calls, ctx.abortSignal);
    // ← 加工具拦截/审批就包这行（opts.hooks.beforeTools）
    const { messages: toolMsgs, done } = opts.hooks?.beforeTools
      ? await opts.hooks.beforeTools(ctx, res.toolCalls, exec)
      : await exec(res.toolCalls);
    if (done) {
      toolSteps.forEach((s) => {
        s.result = done;
        ctx.emit({ type: "toolResult", name: s.name, result: done });
      });
      reply = done;
      break;
    }
    for (let i = 0; i < res.toolCalls.length; i++) {
      const tm = toolMsgs.find((m) => m.tool_call_id === res.toolCalls[i].id);
      if (tm) {
        toolSteps[i].result = tm.content;
        ctx.emit({ type: "toolResult", name: toolSteps[i].name, result: tm.content });
      }
    }
    steps.push(...toolSteps);
    messages.push(...toolMsgs);
    if (ctx.abortSignal.aborted) {
      // 终止请求（工具轮已结束/被打断，不再进下一轮 LLM）
      reply = "（已停止）";
      break;
    }
    // 逐步暂停（请求带 pause: true，UI 输入框的 toggle）：每完成一步（工具已执行、结果已进上下文）停下来
    // 等用户继续——用户可输入消息插入步骤（空 = 只继续不插入；steps 记 user 行由 saveTurn 按序写库），
    // 或终止（/api/abort → { aborted: true }，回复"（已停止）"）。开关没开时 ctx.pause 立即返回。
    const p = await ctx.pause();
    if ("aborted" in p) {
      reply = "（已停止）";
      break;
    }
    if (p.text) {
      messages.push({ role: "user", content: p.text });
      steps.push({ type: "user", text: p.text });
    }
  }
  return { reply: reply ?? "任务未完成（没有收到最终回复）。", steps, usage };
}

/** 记忆子图：把这一轮写回历史（user → step 过程行 → agent 最终回复）。重新生成模式不新增用户行。
 *  steps 里的 user 行（逐步暂停时插入的消息）按序写成 role="user"，落在两步之间。 */
export function saveTurn(ctx: FlowContext, turn: { steps: HistoryStep[]; reply: string }): void {
  if (!ctx.regen) ctx.memory.insert("user", ctx.userText);
  for (const s of turn.steps) {
    if (s.type === "user") ctx.memory.insert("user", s.text);
    else ctx.memory.insert("step", JSON.stringify(s));
  }
  ctx.memory.insert("agent", turn.reply);
}

export interface StandardFlowOptions {
  /** 系统提示词：缺省 buildSystemPrompt(ctx.coreId)；传函数 = 动态生成。 */
  systemPrompt?: string | ((ctx: FlowContext) => string);
  /** 上下文子图：选项对象（history 窗口）或整层替换函数。 */
  load?: LoadContextOptions | ((ctx: FlowContext) => ChatMessage[]);
  /** agent 循环子图：选项对象（llm 替换 / hooks）或整层替换函数。 */
  loop?: AgentLoopOptions | ((ctx: FlowContext, messages: ChatMessage[]) => Promise<{ reply: string; steps: HistoryStep[]; usage?: LLMUsage[] }>);
  /** 记忆子图：false = 不写回；函数 = 替换默认 saveTurn。 */
  save?: false | ((ctx: FlowContext, turn: { steps: HistoryStep[]; reply: string }) => void);
}

/** 标准流（层级 2）：loadContext → agentLoop → saveTurn 的默认组合。
 *  定制阶梯见本文件顶部注释；替换点 = 旧注释「就换这行 / 就包这行」的位置。 */
export function standardFlow(opts: StandardFlowOptions = {}): Flow {
  return async (ctx) => {
    const messages =
      typeof opts.load === "function"
        ? await opts.load(ctx)
        : loadContext(ctx, { ...opts.load, systemPrompt: opts.systemPrompt });
    const { reply, steps, usage } =
      typeof opts.loop === "function"
        ? await opts.loop(ctx, messages)
        : await agentLoop(ctx, messages, opts.loop);
    if (opts.save !== false) (typeof opts.save === "function" ? opts.save : saveTurn)(ctx, { reply, steps });
    return { reply, usage };
  };
}
