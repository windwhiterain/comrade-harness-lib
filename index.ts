// comrade-harness-lib 包入口：core 从这里静态 import 节点函数 + 资源（类型检查完整）。
// 三层：
//   - 节点（nodes.ts）：普通函数，core 的 src/index.ts 用普通控制流把它们串成 harness
//   - 子图（flow.ts）：数据流的可复用片段（loadContext / agentLoop / saveTurn / standardFlow），
//     逐层深入定制（选项 → hooks → 整层换函数 → 手拼）
//   - 资源：llm / tools / memory / createHarness 运行时壳（参数组合即可）
// bash.ts：持久 shell 工具（从 dsh-minimal 库移植，dsh-minimal 与 standard 共享）。
export { createHarness } from "./runtime";
export { llmOpenAI } from "./llm";
export type { OpenAICompatConfig } from "./llm";
export { sqliteMemory, sqliteSessionStore } from "./memory";
export { toolsCore } from "./tools";
export {
  createBashTool,
  bashPackage,
  translateWindowsPaths,
  PRESET_DESCRIPTION,
  type BashToolConfig,
} from "./bash";
export { PipeTerminal, type PipeTerminalConfig, type TerminalHandle } from "./terminal";
export {
  fetchProviderModels,
  importProviders,
  loadModelResources,
  makeProviderLLM,
  parseProviderCatalog,
  providerSelector,
  resourcesDir,
} from "./providers";
export type { ProviderEntry } from "./providers";
export { buildSystemPrompt, callLLM, composeMessages, loadHistory, runTools, saveHistory, splitThinkBlock, streamLLM } from "./nodes";
export { agentLoop, loadContext, saveTurn, standardFlow } from "./flow";
export type { AgentLoopHooks, AgentLoopOptions, LoadContextOptions, StandardFlowOptions } from "./flow";
export { toToolDef, toToolPackage } from "./types";
export type {
  ChatMessage,
  Flow,
  FlowContext,
  FlowReply,
  HarnessConfig,
  HistoryEntry,
  HistoryStep,
  LLMDelta,
  LLMResult,
  ModelSelector,
  ThinkStep,
  Tool,
  ToolCall,
  ToolDef,
  ToolPackage,
  ToolParameter,
  ToolResult,
  ToolStep,
  StreamEvent,
  LLMProvider,
  MemoryStore,
  MessageRecord,
  Role,
  SessionInfo,
  SessionStore,
} from "./types";
