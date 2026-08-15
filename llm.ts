import type { ChatMessage, LLMDelta, LLMProvider, LLMResult, LLMOptions, ToolCall, ToolDef } from "./types";

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
}

/** OpenAI 兼容 SSE 的单个 data 块（解析用，字段全部可选）。 */
type SSEChunk = {
  choices?: {
    delta?: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: (ToolCall & { index?: number })[];
    };
  }[];
};

/** 解析 OpenAI 兼容 SSE 流（OpenAI/DeepSeek/Ollama 等事实标准）：逐块提取 content / reasoning_content /
 *  tool_calls（按 index 累积 name/arguments 片段），经 on 回调转发增量，返回累积后的完整结果。
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
      const d = chunk?.choices?.[0]?.delta;
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
  return {
    content: content || null,
    reasoning: reasoning || null,
    toolCalls: toolCalls.filter((t) => t.function.name && t.function.arguments),
  };
}

export function llmOpenAI(cfg: OpenAICompatConfig = {}): LLMProvider {
  const BASE = cfg.baseUrl ?? process.env.LLM_BASE_URL ?? "https://api.deepseek.com";
  const KEY = cfg.apiKey ?? process.env.LLM_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? "";
  const MODEL = cfg.model ?? process.env.LLM_MODEL ?? "deepseek-chat";
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
        choices?: { message?: { content?: string | null; reasoning_content?: string | null; tool_calls?: ToolCall[] } }[];
      };
      const msg = data.choices?.[0]?.message;
      if (!msg) throw new Error("LLM 返回空响应");
      // reasoning_content 是 DeepSeek 推理模型的思考字段（OpenAI 兼容生态里只有它用它），单独暴露给流去记 think 步骤
      return { content: msg.content ?? null, reasoning: msg.reasoning_content ?? null, toolCalls: msg.tool_calls ?? [] };
    },
    async stream(messages: ChatMessage[], tools: ToolDef[], on: (delta: LLMDelta) => void, opts?: LLMOptions) {
      const r = await fetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ model: MODEL, messages, tools, temperature: 0.2, max_tokens: 4096, stream: true }),
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
