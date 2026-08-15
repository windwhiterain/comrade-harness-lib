// harness 契约 —— 普通 TS 接口，不是插件 API。
// 两层：
//   - 资源（被加载的部分）：LLMProvider / ToolPackage / MemoryStore / UI 目录 —— 参数组合就够了
//   - 数据流（harness 的灵魂）：core 的 src/index.ts 用普通控制流把 nodes.ts 的节点函数串起来
// 节点 = 普通函数，契约就是类型签名；替换节点 = 换个函数，插入节点 = 加一行调用。

export type Role = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: Role;
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

/** composeMessages 的历史条目：新形状（loadHistory 产出的标准 message）或旧形状 {role,text}（兼容既有调用）。 */
export type HistoryEntry = ChatMessage | { role: Role; text: string };

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: object };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** 工具执行结果。kind=done 表示 agent 任务收尾（不再继续循环）。 */
export type ToolResult = { kind: "result"; text: string } | { kind: "done"; message: string };

/** 流式增量：LLM 逐块吐出的一段文本。reasoning = 思考文本（DeepSeek 的 reasoning_content），text = 正式输出。 */
export type LLMDelta = { type: "reasoning" | "text"; text: string };

export interface LLMResult {
  content: string | null;
  reasoning?: string | null;
  toolCalls: ToolCall[];
  /** 流结束时的 finish_reason（OpenAI 兼容：stop/tool_calls 正常，length/content_filter = 被截断，
   *  缺失 = 网关没给或连接被掐断）。诊断用——空回复时靠它区分"模型正常没说话"和"流被截断"。 */
  finishReason?: string | null;
  /** 流内 error 事件（HTTP 200 但 SSE 里带 error 的网关错误）。诊断用。 */
  error?: string | null;
  /** OpenAI 兼容 usage 的归一化形式（无 usage 时为 undefined，旧 provider 或 abort 流可能没有） */
  usage?: LLMUsage;
}

/**
 * 一次 LLM 补全的用量统计（归一化）：tokens 数 + 缓存命中/未命中。
 * 缓存命中 = DeepSeek prompt_cache_hit_tokens / OpenAI cached_tokens / Anthropic cache_read_input_tokens。
 * 上下文（prompt）tokens 中未命中缓存的部分 = promptTokens - cacheHitTokens。
 */
export interface LLMUsage {
  /** 上下文/输入 tokens（prompt_tokens） */
  promptTokens: number;
  /** 输出 tokens（completion_tokens） */
  completionTokens: number;
  /** 总 tokens（total_tokens；缺省时按 prompt + completion 计算） */
  totalTokens: number;
  /** 命中缓存的输入 tokens */
  cacheHitTokens: number;
  /** 未命中缓存的输入 tokens（promptTokens - cacheHitTokens，不会小于 0） */
  cacheMissTokens: number;
}

/** LLM 调用选项：signal 用于终止（/api/abort 触发；abort 时流式返回已累积的部分，非流式抛 AbortError）。 */
export interface LLMOptions {
  signal?: AbortSignal;
}

/** LLM 提供者：把 messages+tools 变成一次补全。reasoning 是模型的思考文本（DeepSeek 的 reasoning_content），只作展示。
 *  stream 可选：实现了才支持流式（不实现 = 调用方走 chat 兜底，行为与原来一致）。 */
export interface LLMProvider {
  ready(): boolean;
  chat(messages: ChatMessage[], tools: ToolDef[], opts?: LLMOptions): Promise<LLMResult>;
  /** 流式补全：逐块回调增量；返回累积后的完整结果（形状与 chat 相同，流代码拿它记 think/步骤）。
   *  传了 opts.signal 且被 abort 时：返回已累积的部分内容（toolCalls 视为未完成置空），不抛错。 */
  stream?(
    messages: ChatMessage[],
    tools: ToolDef[],
    on: (delta: LLMDelta) => void,
    opts?: LLMOptions,
  ): Promise<LLMResult>;
}

/** provider/模型选择器：runtime 暴露 GET/POST /api/models 供 UI 切换；chat 委托给当前选中的 provider。
 *  把它当 llm 注入，流里照常用 ctx.llm，不用改流。 */
export interface ModelSelector extends LLMProvider {
  /** 当前选择。 */
  state(): { providerId: string; modelId: string };
  /** 切换选择；null = 成功，字符串 = 错误信息（未知 provider / 无此模型）。 */
  set(providerId: string, modelId: string): string | null;
  /** 按指定 provider/模型构造一个固定的 LLMProvider（会话级模型绑定时用：runtime 按会话记录取它，不污染全局）。
   *  未知 provider/模型返回 null。可选——自定义选择器可以不实现（runtime 回落全局选择）。 */
  pinned?(providerId: string, modelId: string): LLMProvider | null;
  /** 模型目录（UI 用它填充下拉）。 */
  catalog(): { id: string; models: string[] }[];
}

/** 工具包：一组工具的集合。exec 收到的是该包内工具的原始参数字符串（JSON）。
 *  signal：/api/abort 的终止信号。长任务必须响应它——run_cmd 杀子进程、daemon 调用中断 fetch；
 *  短任务（读写文件）可忽略，runTools 会在工具之间检查信号，终止后不再调度剩余工具。 */
export interface ToolPackage {
  name: string;
  tools: ToolDef[];
  exec(name: string, rawArgs: string, signal?: AbortSignal): Promise<ToolResult>;
  /** 释放持有的资源（如持久 shell）；无资源时可省略。 */
  dispose?(): Promise<void>;
}

/** 工具参数 schema（OpenAI 风格，properties 内单个参数）。 */
export interface ToolParameter {
  type: 'string' | 'integer' | 'array';
  required?: boolean;
  enum?: string[];
  description?: string;
  items?: { type: 'string' | 'integer' };
}

/** 内部工具形态：schema + 执行函数（execute 收已解析的参数对象）。
 *  bash 这类需要持有资源（持久 shell）的工具用这个形态，再包成 ToolPackage。
 *  signal：/api/abort 的终止信号（可空——工具被独立使用时没有）；长命令（bash）应中止执行并复位 shell。 */
export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
  dispose?(): Promise<void>;
}

/** 把内部 Tool 转成 OpenAI function-calling 的 ToolDef。 */
export function toToolDef(tool: Tool): ToolDef {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, param] of Object.entries(tool.parameters)) {
    const { required: isRequired, ...rest } = param;
    properties[name] = rest;
    if (isRequired) required.push(name);
  }
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
      },
    },
  };
}

/** 把内部 Tool 包成 ToolPackage（exec 与 toolsCore 同风格：JSON 解析失败与执行错误都转成 result 文本）。 */
export function toToolPackage(name: string, tool: Tool): ToolPackage {
  const defs = [toToolDef(tool)];
  return {
    name,
    tools: defs,
    async exec(rawName: string, rawArgs: string, signal?: AbortSignal): Promise<ToolResult> {
      if (rawName !== tool.name) return { kind: "result", text: `未知工具: ${rawName}` };
      if (signal?.aborted) return { kind: "result", text: "（已停止）" };
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(rawArgs || "{}") as Record<string, unknown>;
      } catch {
        return { kind: "result", text: `参数不是合法 JSON: ${rawArgs}` };
      }
      try {
        return { kind: "result", text: await tool.execute(args, signal) };
      } catch (error: unknown) {
        if (signal?.aborted) return { kind: "result", text: "（已停止）" };
        return { kind: "result", text: `工具错误: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
    dispose: tool.dispose !== undefined ? () => tool.dispose!() : undefined,
  };
}

/** 一条已存储的消息（id 是 SQLite 自增主键，UI 按它删除/截断）。 */
export interface MessageRecord {
  id: number;
  role: string;
  text: string;
  ts: string;
}

/**
 * 过程步骤：agent 在回答用户前的中间过程，以 role="step" 的 JSON 行存进历史（think/tool），
 * 只作 UI 展示（可折叠卡片），loadHistory 按标准 message 格式重建喂给 LLM。
 * user 变体 = 逐步暂停时用户插入的消息：不存 step JSON，saveTurn 按序写成 role="user" 行（落在两步之间）。
 */
export type ThinkStep = { type: "think"; content: string };
export type ToolStep = { type: "tool"; name: string; args: string; result?: string };
export type StepUser = { type: "user"; text: string };
/** LLM 用量步骤：agent 循环里每次 LLM 响应记一条，UI 显示上下文/缓存命中统计。 */
export type LLMStep = { type: "llm"; usage: LLMUsage };
export type HistoryStep = ThinkStep | ToolStep | StepUser | LLMStep;

/** 记忆/消息存储：对话历史的持久化（进程可死，历史不丢）。 */
export interface MemoryStore {
  list(): MessageRecord[];
  insert(role: string, text: string): void;
  /** 删除单条消息（本会话内：共享的消息只删引用，其他会话不受影响）。 */
  delete(id: number): void;
  /** 截断：删除 id 及其之后的所有消息（对话回退到该条之前；同样只动本会话的引用）。 */
  truncate(fromId: number): void;
  /** 截至 id（含）的消息列表——"以这条为最后一条"的上下文视图。可选：不支持时 at 请求被拒。 */
  listUntil?(id: number): MessageRecord[];
  /** 在 id 之后插入一条消息（中间插入，后续引用的 pos 自动重排；返回新消息 id，便于连续插入）。可选。 */
  insertAfter?(id: number, role: string, text: string): number | null;
  /** 修改消息内容（copy-on-edit：新行替换本会话的引用，共享该消息的其他会话不受影响；返回新消息 id，消息不存在返回 null）。可选。 */
  updateText?(id: number, text: string): number | null;
}

/** 会话摘要：会话列表（UI 会话栏）用。 */
export interface SessionInfo {
  id: string;
  name: string;
  created: string;
  updated: string;
  /** 会话内消息条数（含 step 行）。 */
  count: number;
  /** 最后一条非 step 消息的文本（截断，供列表预览）。 */
  preview: string | null;
}

/** 会话存储：消息池（messages，只追加，内容唯一储存）+ 会话（sessions）+ 有序引用列表（session_messages）。
 *  多会话共享零复制——共享靠引用而非结构，前缀/中间/后缀消息都能被任意会话引用；
 *  删除/截断/删会话都是"删引用"，消息行留在池里（孤儿，可恢复），彻底清除留给将来的 purge。
 *  session(id) 返回该会话的 MemoryStore 视图：流代码不用改，loadHistory/saveHistory 照常。 */
export interface SessionStore {
  /** 会话维度视图：id 不存在时自动创建（API 请求带任意 session 都能用）。 */
  session(id: string): MemoryStore;
  /** 新建会话；forkId 给定时复制该会话的引用列表（内容零复制），atMessageId 给定时只复制到该消息为止（"从这条消息分叉"）；
   *  settingsFrom 给定时复制该会话的 provider/model 设置（新建沿用当前会话的选择）。返回 {id} 或 {error}。 */
  createSession(name: string, forkId?: string, atMessageId?: number, settingsFrom?: string): { id: string } | { error: string };
  listSessions(): SessionInfo[];
  /** 删除会话（引用 + 会话行；消息行留在池里）。返回错误信息或 null（成功）。default 会话不可删。 */
  deleteSession(id: string): string | null;
  /** 导出会话为 JSONL（一行一条消息，含 step；round-trip 无损）。id 不存在返回 null。 */
  exportSession(id: string): string | null;
  /** 会话记住的模型选择（无记录返回 null）——多会话：每个会话独立记忆自己的 provider/model，切换会话自动恢复。 */
  sessionModel?(id: string): { providerId: string; modelId: string } | null;
  setSessionModel?(id: string, providerId: string, modelId: string): void;
}

/** 数据流上下文：createHarness 注入的资源 + 本次请求数据。节点函数共用。
 *  emit：把过程实时推给请求方（SSE）。runtime 恒注入；JSON 模式是 no-op——流代码可以无条件调用，两种模式行为一致。
 *  abortSignal：POST /api/abort 触发（当前任务终止）。LLM 调用传给节点（流式中止返回已生成部分）；
 *  也传给工具执行（run_cmd 杀子进程、daemon 调用中断 fetch），runTools 在工具轮之间会检查——
 *  流的代码在每轮结束时再检查它决定是否继续。 */
export interface FlowContext {
  coreId: string;
  sessionId: string;
  userText: string;
  /** 重新生成模式（右键消息"请求"）：不插入用户消息行，LLM 输入的最后一条 = 上下文最后一条（重新回答它）。 */
  regen?: boolean;
  memory: MemoryStore;
  llm: LLMProvider;
  tools: ToolPackage[];
  emit: (ev: StreamEvent) => void;
  /** 逐步暂停（每完成一步后停下来等用户继续）：返回 { text } = 用户插入的消息文本（空串 = 未插入，仅继续）；
   *  { aborted: true } = 用户终止了任务（流应以"（已停止）"收尾）。未开启逐步暂停时立即返回 { text: "" }（零开销）。
   *  runtime 恒注入；agentLoop 每步收尾调用它。 */
  pause: () => Promise<{ text: string } | { aborted: true }>;
  abortSignal: AbortSignal;
}

/** 流可以发射的过程事件（实时上屏；最终历史仍以 role="step" 行为准，done 后 UI 重绘对齐）。
 *  think：思考文本增量（每个 LLM 轮开一段）；tool：工具调用开始；toolResult：工具结果；delta：最终回复文本增量。
 *  pause：逐步暂停——该步已完成，任务挂起等用户继续（暂停期间每 30s 重发一次保活，UI 幂等处理）。 */
export type StreamEvent =
  | { type: "think"; delta: string }
  | { type: "tool"; name: string; args: string }
  | { type: "toolResult"; name: string; result: string }
  | { type: "llm"; usage: LLMUsage }
  | { type: "delta"; text: string }
  | { type: "pause" };

/** 数据流的返回。 */
export interface FlowReply {
  reply: string;
  /** 本次数据流中每次 LLM 响应的用量（按调用顺序；与 llm 步骤行/SSE 事件同源）。 */
  usage?: LLMUsage[];
}

/** 数据流：消息 → 回复。由 core 的代码用 lib 节点函数写成（普通代码控制流，不是图数据结构）。 */
export type Flow = (ctx: FlowContext) => Promise<FlowReply>;

/** 组装配置：flow 必需（数据流是 harness 的灵魂），其余是资源（都有默认值）。 */
export interface HarnessConfig {
  flow: Flow;
  /** 缺省 = OpenAI 兼容（DeepSeek），LLM_* 环境变量配置 */
  llm?: LLMProvider;
  /** 缺省 = 默认工作区工具包（toolsCore） */
  tools?: ToolPackage[];
  /** 静态 UI：dir 是 core 自己的覆盖目录（优先）；shared 是回落目录，缺省 = lib 自带 ui/（模板只需放变体差异），显式 null 关闭回落（纯本地）；null 关闭静态托管 */
  ui?: { dir: string; shared?: string | null } | null;
  /** provider/模型选择器：有则暴露 GET/POST /api/models 供 UI 切换；通常也作为 llm 传入 */
  modelSelector?: ModelSelector | null;
  /** 缺省 = 会话化 SQLite 消息历史（DB_PATH 环境变量）；传纯 MemoryStore（如 sqliteMemory）则退化为单会话模式（无会话 API） */
  memory?: MemoryStore | SessionStore;
}
