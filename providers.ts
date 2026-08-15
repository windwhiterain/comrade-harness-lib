import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { llmOpenAI } from "./llm";
import type { LLMProvider, ModelSelector } from "./types";

// 公共资源库的 provider 节点：从 ~/.agents/models.json（.agents 协议约定位置，RESOURCES_DIR 可覆盖）
// 读 provider 的 baseUrl 和密钥（apiKey 直接配置，或 apiKeyEnv 环境变量引用），模型信息（列表）通过
// API GET {baseUrl}/models 获取——公共目录只放最小字段（地址 + 密钥），对 schema 漂移免疫；
// 模型目录永远是 provider 自己的真相，不会过期。
// 除了配置文件，还默认检查常见 Key 环境变量（DEEPSEEK_API_KEY 等）：找到了就自动配成一个 provider，
// 相同 base_url 的 models.json 条目会覆盖它（显式配置 > 隐式发现）。
// 节点 = 普通函数；默认进口处理 importProviders 是组合好的，harness 也可以只用单个节点自己组装。

export interface ProviderEntry {
  id: string;
  baseUrl: string;
  /** 密钥直接写在文件里（用户偏好；文件在本机 ~/.agents，注意不要提交进 git） */
  apiKey?: string;
  /** 或：密钥经环境变量引用（公共目录只存变量名） */
  apiKeyEnv?: string;
}

/** 公共资源目录：RESOURCES_DIR env 可覆盖（daemon 后续注入），缺省 ~/.agents（.agents 协议约定位置）。 */
export function resourcesDir(): string {
  return process.env.RESOURCES_DIR ?? join(homedir(), ".agents");
}

/** 常见 Key 环境变量的自动发现表：变量名 → 默认 provider（id + baseUrl，OpenAI 兼容端点）。
 *  设了 key 就自动配成一个 provider，模型列表照常走 GET /models（provider 自己的真相）。 */
export interface EnvProviderDef {
  env: string;
  id: string;
  baseUrl: string;
}

export const COMMON_ENV_PROVIDERS: EnvProviderDef[] = [
  { env: "DEEPSEEK_API_KEY", id: "deepseek", baseUrl: "https://api.deepseek.com" },
  { env: "OPENAI_API_KEY", id: "openai", baseUrl: "https://api.openai.com/v1" },
  { env: "MOONSHOT_API_KEY", id: "moonshot", baseUrl: "https://api.moonshot.cn/v1" },
  { env: "ZHIPUAI_API_KEY", id: "zhipu", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
  { env: "DASHSCOPE_API_KEY", id: "dashscope", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { env: "GEMINI_API_KEY", id: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { env: "GROQ_API_KEY", id: "groq", baseUrl: "https://api.groq.com/openai/v1" },
  { env: "OPENROUTER_API_KEY", id: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
  { env: "XAI_API_KEY", id: "xai", baseUrl: "https://api.x.ai/v1" },
  { env: "MISTRAL_API_KEY", id: "mistral", baseUrl: "https://api.mistral.ai/v1" },
  { env: "TOGETHER_API_KEY", id: "together", baseUrl: "https://api.together.xyz/v1" },
];

/** 从环境变量自动发现 provider 条目：有 key 才配（密钥直配 apiKey），没设的变量跳过。
 *  LLM_API_KEY 是项目 legacy 配置（baseUrl 缺省 DeepSeek，LLM_BASE_URL 可覆盖），放最后兜底。 */
export function discoverEnvProviders(): ProviderEntry[] {
  const out: ProviderEntry[] = [];
  for (const d of COMMON_ENV_PROVIDERS) {
    const key = process.env[d.env]?.trim();
    if (key) out.push({ id: d.id, baseUrl: d.baseUrl, apiKey: key });
  }
  const legacy = process.env.LLM_API_KEY?.trim();
  if (legacy) out.push({ id: "llm", baseUrl: process.env.LLM_BASE_URL?.trim() || "https://api.deepseek.com", apiKey: legacy });
  return out;
}

const normBase = (u: string) => u.replace(/\/+$/, "").toLowerCase();

/** 合并条目：models.json 条目优先（保序）；环境变量自动发现的补在后面，
 *  与配置文件条目相同 base_url（归一化后）或相同 id 的自动条目跳过——显式配置覆盖隐式发现。 */
export function mergeProviderEntries(configEntries: ProviderEntry[]): ProviderEntry[] {
  const entries = [...configEntries];
  const seenBase = new Set(configEntries.map((e) => normBase(e.baseUrl)));
  const seenId = new Set(configEntries.map((e) => e.id));
  for (const e of discoverEnvProviders()) {
    const nb = normBase(e.baseUrl);
    if (seenBase.has(nb) || seenId.has(e.id)) continue;
    console.log(`[providers] 环境变量 ${e.id} 自动配置 (${e.baseUrl})`);
    entries.push(e);
    seenBase.add(nb);
    seenId.add(e.id);
  }
  return entries;
}

/** 节点①：读 + 校验 models.json，只留 {id, baseUrl, apiKeyEnv} 三个字段（其余字段一律忽略）。
 *  缺文件/JSON 坏 → []；坏条目警告跳过，不炸。 */
export function parseProviderCatalog(dir?: string): ProviderEntry[] {
  const file = join(dir ?? resourcesDir(), "models.json");
  if (!existsSync(file)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf-8"));
  } catch (e) {
    console.log(`[providers] ${file} 解析失败: ${e instanceof Error ? e.message : e}`);
    return [];
  }
  const list = (raw as { providers?: unknown } | null)?.providers;
  if (!Array.isArray(list)) {
    console.log(`[providers] ${file} 缺少 providers 数组`);
    return [];
  }
  const out: ProviderEntry[] = [];
  for (const item of list) {
    const it = item as Record<string, unknown> | null;
    if (!it || typeof it.id !== "string" || typeof it.baseUrl !== "string" || !it.id.trim() || !it.baseUrl.trim()) {
      console.log(`[providers] ${file} 跳过无效条目: ${JSON.stringify(it)}`);
      continue;
    }
    const apiKey = typeof it.apiKey === "string" && it.apiKey.trim() ? it.apiKey : undefined;
    const apiKeyEnv = typeof it.apiKeyEnv === "string" && it.apiKeyEnv.trim() ? it.apiKeyEnv : undefined;
    out.push({ id: it.id, baseUrl: it.baseUrl, apiKey, apiKeyEnv });
  }
  return out;
}

/** 解析条目的密钥：优先 apiKey（文件直配），否则 apiKeyEnv 环境变量引用。 */
function entryKey(entry: ProviderEntry): string {
  return entry.apiKey?.trim() ?? (entry.apiKeyEnv ? process.env[entry.apiKeyEnv] ?? "" : "");
}

/** 节点②：GET {baseUrl}/models（有 key 带 Bearer），返回模型 id 列表。
 *  OpenAI 兼容端点的事实标准（OpenAI/DeepSeek/Ollama/vLLM 等都实现）；失败抛错，由调用方决定怎么处理。 */
export async function fetchProviderModels(entry: ProviderEntry): Promise<string[]> {
  const base = entry.baseUrl.replace(/\/+$/, "");
  const key = entryKey(entry);
  const r = await fetch(`${base}/models`, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`GET /models ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = (await r.json()) as { data?: { id?: unknown }[] };
  const ids = (data.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === "string" && x.length > 0);
  if (ids.length === 0) throw new Error("GET /models 返回空模型列表");
  return ids;
}

/** 节点③：组装 LLMProvider。密钥优先取文件里直接配置的 apiKey，否则按 apiKeyEnv 从环境变量解析；
 *  完全没配密钥的条目视为本地无鉴权端点（如 Ollama），跳过密钥检查。 */
export function makeProviderLLM(entry: ProviderEntry, modelId: string): LLMProvider {
  const key = entryKey(entry);
  return llmOpenAI({
    baseUrl: entry.baseUrl,
    apiKey: key,
    model: modelId,
    skipKeyCheck: !entry.apiKey && !entry.apiKeyEnv,
  });
}

/** 组合节点（默认进口处理）：parse → 逐个 fetch → 组装。
 *  单 provider 失败 → 警告跳过，不炸 core；显式 LLM_MODEL 且在该 provider 列表里时覆盖模型选择，否则取列表第一个。
 *  models 返回每个 provider 的模型 id 列表，供流的模型选择节点使用；entries 是原始条目（供选择器按需组装）。 */
export async function importProviders(
  dir?: string,
): Promise<{ providers: LLMProvider[]; models: Record<string, string[]>; entries: ProviderEntry[] }> {
  const entries = mergeProviderEntries(parseProviderCatalog(dir));
  const providers: LLMProvider[] = [];
  const models: Record<string, string[]> = {};
  const override = process.env.LLM_MODEL?.trim();
  for (const entry of entries) {
    try {
      const ids = await fetchProviderModels(entry);
      models[entry.id] = ids;
      const modelId = override && ids.includes(override) ? override : ids[0];
      providers.push(makeProviderLLM(entry, modelId));
      console.log(`[providers] ${entry.id}: ${ids.length} 个模型, 选用 ${modelId}`);
    } catch (e) {
      console.log(`[providers] ${entry.id} 跳过: ${e instanceof Error ? e.message : e}`);
    }
  }
  return { providers, models, entries };
}

/** 选择器节点：provider 工厂表 + 模型目录 → 一个可切换的 LLMProvider。
 *  runtime 把它当作 ctx.llm 注入，流不变；UI 通过 /api/models 切换。
 *  初始缺省 = 第一个 provider + LLM_MODEL（在该 provider 列表里时）或它的第一个模型。 */
export function providerSelector(
  factories: Record<string, (modelId: string) => LLMProvider>,
  catalog: Record<string, string[]>,
  initial?: { providerId: string; modelId: string },
): ModelSelector {
  const order = Object.keys(factories);
  const valid = (s: { providerId: string; modelId: string }) =>
    !!factories[s.providerId] && catalog[s.providerId]?.includes(s.modelId);
  const envModel = process.env.LLM_MODEL?.trim();
  const first = order[0] ?? "";
  let current =
    initial && valid(initial)
      ? initial
      : envModel && catalog[first]?.includes(envModel)
        ? { providerId: first, modelId: envModel }
        : { providerId: first, modelId: catalog[first]?.[0] ?? "" };
  let cached: LLMProvider | null = null;
  const build = (): LLMProvider | null => {
    const f = factories[current.providerId];
    return f ? f(current.modelId) : null;
  };
  return {
    state: () => ({ ...current }),
    set(providerId, modelId) {
      if (!factories[providerId]) return `未知 provider: ${providerId}`;
      if (!catalog[providerId]?.includes(modelId)) return `provider ${providerId} 没有模型 ${modelId}`;
      current = { providerId, modelId };
      cached = null;
      return null;
    },
    catalog: () => order.map((id) => ({ id, models: catalog[id] ?? [] })),
    ready: () => {
      const p = (cached ??= build());
      return !!p && p.ready();
    },
    async chat(messages, tools, opts) {
      const p = (cached ??= build());
      if (!p) throw new Error("没有可用 provider（检查 ~/.agents/models.json 配置）");
      return p.chat(messages, tools, opts);
    },
    async stream(messages, tools, on, opts) {
      const p = (cached ??= build());
      if (!p) throw new Error("没有可用 provider（检查 ~/.agents/models.json 配置）");
      if (p.stream) return p.stream(messages, tools, on, opts);
      const r = await p.chat(messages, tools, opts); // 极旧 provider 无流式：chat 兜底，一次性回调
      if (r.reasoning) on({ type: "reasoning", text: r.reasoning });
      if (r.content) on({ type: "text", text: r.content });
      return r;
    },
  };
}

/** 资源组装（默认进口处理）：公共资源库 provider 目录 → 可选的选择器 + 回落 LLM。
 *  core 的组装里一行拿到 llm + modelSelector，不用重复 importProviders/工厂表/回落逻辑；
 *  想自定义选择器（如固定 provider、改初始选择）就自己用 importProviders + providerSelector 拼。 */
export async function loadModelResources(): Promise<{ llm: LLMProvider; modelSelector: ModelSelector | null }> {
  const { providers, models, entries } = await importProviders();
  const factories: Record<string, (modelId: string) => LLMProvider> = {};
  for (const e of entries) factories[e.id] = (modelId: string) => makeProviderLLM(e, modelId);
  const selector = providers.length > 0 ? providerSelector(factories, models) : null;
  return { llm: selector ?? llmOpenAI(), modelSelector: selector };
}
