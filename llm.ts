import type { ChatMessage, LLMDelta, LLMProvider, LLMResult, LLMOptions, LLMUsage, ToolCall, ToolDef } from "./types";

// 默认 LLM 提供者：OpenAI 兼容（DeepSeek 等），fetch 直连，零依赖。
// 换 LLM = 组装时换一个实现 LLMProvider 接口的组件；
// 传 cfg 可覆盖 env（公共资源库 ~/.agents/models.json 的 provider 节点从这里组装，见 providers.ts）。

/** OpenAI 兼容提供者的组装配置。不传则读 LLM_* 环境变量（行为与原来完全一致）。 */
export interface OpenAICompatConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  /** 本地无鉴权端点（如 Ollama）：跳过密钥检查，ready 恒为 true */
  skipKeyCheck?: boolean;
  /** 流式请求是否带 stream_options.include_usage 以拿 usage（默认 true；个别不兼容端点可关掉） */
  streamUsage?: boolean;
}

/** OpenAI 兼容 SSE 的单个 data 块（解析用，字段全部可选）。 */
type SSEChunk = {
  choices?: {
    delta?: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: (ToolCall & { index?: number })[];
    };
    /** 该 choice 的收尾原因（最后一个块上给）：stop/tool_calls 正常，length/content_filter = 被截断。诊断用。 */
    finish_reason?: string | null;
    /** 个别网关把错误放在 choice 上（HTTP 仍 200）。诊断用。 */
    error?: unknown;
  }[];
  /** 网关错误事件（无 choices 的整个块）。诊断用。 */
  error?: unknown;
  usage?: OpenAIUsage;
};

/** OpenAI 兼容响应里的 usage 原始形状（不同 provider 字段略有差异）。 */
export type OpenAIUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** DeepSeek 上下文缓存命中/未命中 tokens */
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  /** OpenAI cached_tokens（prompt_tokens_details.cached_tokens） */
  prompt_tokens_details?: { cached_tokens?: number };
  /** Anthropic 兼容端点可能返回的字段 */
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

/** 把 OpenAI 兼容的 usage 归一化为 LLMUsage。缺字段按 0；total 缺省 = prompt + completion。 */
export function normalizeUsage(u: OpenAIUsage | null | undefined): LLMUsage | undefined {
  if (!u) return undefined;
  const promptTokens = u.prompt_tokens ?? 0;
  const completionTokens = u.completion_tokens ?? 0;
  const cacheHitTokens = u.prompt_cache_hit_tokens
    ?? u.prompt_tokens_details?.cached_tokens
    ?? u.cache_read_input_tokens
    ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: u.total_tokens ?? promptTokens + completionTokens,
    cacheHitTokens,
    cacheMissTokens: Math.max(0, promptTokens - cacheHitTokens),
  };
}

/** 解析 OpenAI 兼容 SSE 流（OpenAI/DeepSeek/Ollama 等事实标准）：逐块提取 content / reasoning_content /
 *  tool_calls（按 index 累积 name/arguments 片段），经 on 回调转发增量，返回累积后的完整结果。
 *  usage 来自流式请求 stream_options.include_usage 的最后一个 data 块。
 *  signal 被 abort 时：返回已累积的部分（toolCalls 置空——中断时它不完整，不能交给工具执行），不抛错。 */
async function readSSE(r: Response, on: (delta: LLMDelta) => void, signal?: AbortSignal): Promise<LLMResult> {
  const reader = r.body?.getReader();
  if (!reader) throw new Error("LLM 流式响应无 body");
  // 终止请求时不依赖 fetch 对 abort 的处理（Bun 会把已缓冲的 body 继续读完）：
  // 主动 cancel body 流，让挂起的 read() 立即结束（resolve done 或抛错），循环随即退出、返回已生成的部分。
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await readSSEBody(reader, on, signal);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

async function readSSEBody(
  reader: { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> },
  on: (delta: LLMDelta) => void,
  signal?: AbortSignal,
): Promise<LLMResult> {
  const dec = new TextDecoder();
  let buf = "";
  let content = "";
  let reasoning = "";
  let finishReason: string | null = null;
  let streamError: string | null = null;
  let usage: LLMUsage | undefined;
  const toolCalls: ToolCall[] = [];
  while (true) {
    // 终止请求：每次迭代都检查——Bun 的 fetch 会把已缓冲的 body 继续喂给 read()，
    // 不在这里中断就会把整段响应读完（abort 形同虚设）。中断后已 emit 的增量保留，未读的丢弃。
    if (signal?.aborted) break;
    let res: { done: boolean; value?: Uint8Array };
    try {
      res = await reader.read();
    } catch (e) {
      if (signal?.aborted) break; // 终止请求：保留已生成的部分
      throw e;
    }
    if (res.done) break;
    buf += dec.decode(res.value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = block.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let chunk: SSEChunk | null = null;
      try {
        chunk = JSON.parse(payload) as SSEChunk;
      } catch {
        continue;
      }
      if (chunk?.usage) usage = normalizeUsage(chunk.usage);
      const d = chunk?.choices?.[0]?.delta;
      // 诊断：网关在流里给的 finish_reason 与 error 事件（HTTP 200 也可能带 error）。
      // 之前完全忽略——流中途被网关截断时被当成"正常结束的空回复"，DB 里没有任何原因。
      const ch = chunk?.choices?.[0];
      if (ch?.finish_reason) finishReason = ch.finish_reason;
      const rawErr = chunk?.error ?? ch?.error;
      if (rawErr) streamError = JSON.stringify(rawErr).slice(0, 300);
      if (chunk?.usage) usage = normalizeUsage(chunk.usage);
      if (!d) continue;
      if (d.reasoning_content) {
        reasoning += d.reasoning_content;
        on({ type: "reasoning", text: d.reasoning_content });
      }
      if (d.content) {
        content += d.content;
        on({ type: "text", text: d.content });
      }
      if (Array.isArray(d.tool_calls)) {
        for (const frag of d.tool_calls) {
          let tc = toolCalls[frag.index ?? toolCalls.length];
          if (!tc) {
            tc = { id: frag.id ?? `call_${frag.index ?? toolCalls.length}`, type: "function", function: { name: "", arguments: "" } };
            toolCalls[frag.index ?? toolCalls.length] = tc;
          }
          if (frag.id) tc.id = frag.id;
          if (frag.function?.name) tc.function.name += frag.function.name;
          if (frag.function?.arguments) tc.function.arguments += frag.function.arguments;
        }
      }
    }
  }
  if (signal?.aborted) return { content: content || null, reasoning: reasoning || null, toolCalls: [] };
  const out: LLMResult = {
    content: content || null,
    reasoning: reasoning || null,
    toolCalls: toolCalls.filter((t) => t.function.name && t.function.arguments),
    finishReason,
    error: streamError,
    usage,
  };
  // 异常收尾（finish 非正常 / 流内 error / 内容为空且无工具调用）＝截断信号：
  // 日志里留下网关给的原因，别再让"流被掐断"和"模型正常没说话"在库里长得一样。
  const abnormal =
    streamError !== null ||
    (finishReason !== null && finishReason !== "stop" && finishReason !== "tool_calls") ||
    (!content && toolCalls.length === 0);
  if (abnormal) {
    console.warn(
      `[llm] 流结束异常: finish=${finishReason ?? "-"} error=${streamError ?? "-"} ` +
        `reasoning=${reasoning.length}B content=${content.length}B toolCalls=${toolCalls.length}`,
    );
  }
  return out;
}

export function llmOpenAI(cfg: OpenAICompatConfig = {}): LLMProvider {
  const BASE = cfg.baseUrl ?? process.env.LLM_BASE_URL ?? "https://api.deepseek.com";
  const KEY = cfg.apiKey ?? process.env.LLM_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? "";
  const MODEL = cfg.model ?? process.env.LLM_MODEL ?? "deepseek-chat";
  const STREAM_USAGE = cfg.streamUsage ?? true;
  return {
    ready: () => KEY.length > 0 || cfg.skipKeyCheck === true,
    async chat(messages: ChatMessage[], tools: ToolDef[], opts?: LLMOptions) {
      const r = await fetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ model: MODEL, messages, tools, temperature: 0.2, max_tokens: 4096 }),
        signal: opts?.signal,
      });
      if (!r.ok) {
        const body = await r.text();
        throw new Error(`LLM ${r.status}: ${body.slice(0, 500)}`);
      }
      const data = (await r.json()) as {
        choices?: { message?: { content?: string | null; reasoning_content?: string | null; tool_calls?: ToolCall[] }; finish_reason?: string | null }[];
        usage?: OpenAIUsage;
      };
      const msg = data.choices?.[0]?.message;
      if (!msg) throw new Error("LLM 返回空响应");
      // reasoning_content 是 DeepSeek 推理模型的思考字段（OpenAI 兼容生态里只有它用它），单独暴露给流去记 think 步骤
      return {
        content: msg.content ?? null,
        reasoning: msg.reasoning_content ?? null,
        toolCalls: msg.tool_calls ?? [],
        finishReason: data.choices?.[0]?.finish_reason ?? null,
        usage: normalizeUsage(data.usage),
      };
    },
    async stream(messages: ChatMessage[], tools: ToolDef[], on: (delta: LLMDelta) => void, opts?: LLMOptions) {
      const r = await fetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
        body: JSON.stringify({
          model: MODEL,
          messages,
          tools,
          temperature: 0.2,
          max_tokens: 4096,
          stream: true,
          ...(STREAM_USAGE ? { stream_options: { include_usage: true } } : {}),
        }),
        signal: opts?.signal,
      });
      if (!r.ok) {
        const body = await r.text();
        throw new Error(`LLM ${r.status}: ${body.slice(0, 500)}`);
      }
      return readSSE(r, on, opts?.signal);
    },
  };
}
