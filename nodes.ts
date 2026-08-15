import type {
  ChatMessage,
  LLMDelta,
  LLMProvider,
  LLMResult,
  LLMOptions,
  MemoryStore,
  Role,
  ToolCall,
  ToolDef,
  ToolPackage,
  ToolResult,
} from "./types";

// 节点 = 普通函数：(输入) → (输出)。它们本身不构成 harness——
// harness 是 core 的 src/index.ts 里把它们串起来的**数据流代码**（顺序/循环/分支）。
// 替换节点 = 换个函数；插入节点 = 在流里加一行调用。没有注册表，没有图结构。

/** 提示词节点：按 core 身份生成系统提示词。
 *  模板（standard/dsh-minimal，目录位于项目 cores/ 下）是**可运行的参考实现 + 迁移源**：用户 fork 它、跟它对话，
 *  让它把最新代码同步到用户的 fork；模板自己不可 commit（daemon 拒绝），被改了也只会被 git 回滚——提示词是唯一的护栏。
 *  不再有 .immutable 之类的硬权限——agent 就是开发者，安全网是 git。 */
export function buildSystemPrompt(coreId: string, isTemplate: boolean): string {
  const identity = isTemplate
    ? `你运行在 ${coreId} core 里——它是**模板**（项目 cores/ 目录下的参考实现，不是任何人的私有资产）。用户会 fork 你，也可能直接跟你对话：你的价值是作为最新参考，帮助用户理解代码、把这份实现迁移/同步到他们的 fork core（你有读写任意 core 的工具）。**不要修改自己**：你的改动不属于用户资产，会被项目仓库覆盖；要修改先让用户 fork_core（你被 fork 出的副本可以随便改）。你被改了也只会被 git 回滚——这不是惩罚，是设计。`
    : `你运行在 ${coreId} core 里。core 是一个普通的 Bun/TS 服务，你是它的 agent：可以自由修改它——包括修改你自己：改完 tsc + reload 自己后，你会用新代码继续工作。`;
  return `${identity}

工作区（read_file / write_file / run_cmd 的路径都围绕它）：
- 自己的代码：相对路径默认指向你自己的目录（如 src/index.ts）。
- 其他 core：路径以 <core id>/ 开头（如 standard/src/index.ts）——工具自动知道每个 core 的实际位置，无论它在项目 cores/ 下还是 ~/.comrade-harness/cores/ 下（fork 出的 core 默认都在那里）。
- 绝对路径也可（限 core 目录范围内）。
- run_cmd 在你自己的目录里执行：检查自己 bunx tsc --noEmit -p tsconfig.json；检查项目内其他 core 用 -p ../<id>/tsconfig.json；项目外 fork 用它的绝对路径。

core 的运行契约（必须遵守，不要破坏）：
- 入口 src/index.ts
- 依赖 daemon 注入的环境变量 PORT / CORE_ID / CORE_DIR / DB_PATH / DAEMON_URL / CORES_DIR
- 必须提供 GET /health → 200
- 其余完全自由：core 就是普通代码，没有任何插件 API

工作准则：
1. 先 read_file 再改。改动小而精准，不要整文件重写。
2. 每次改完必须验证：run_cmd 执行 bunx tsc --noEmit -p <对应 tsconfig>（规则见上方工作区），通过后再 reload(<core名>)。
3. reload 是蓝绿换血，会等待门禁和健康检查。返回 ok:true 即代表健康检查已通过 —— 不要再探测端口、不要再 curl 页面、不要再查进程。返回 ok:false 时，仔细读 error 修复后重试，不要重复同样的错误。
4. 环境是 Windows：没有 ps / ss / /tmp 这些工具，不要尝试使用它们。不要读环境变量里的 PORT 值，它属于 daemon 管理，reload 返回已够用。
5. 需要确认实时端口时用 core_info 工具（返回所有 core 的端口/状态）。reload 之后，用 core_info 拿新端口，再用 run_cmd + bun -e "fetch('http://127.0.0.1:<端口>/<路径>').then(r=>r.text()).then(console.log)" 验证新端点。
6. 模板 core（standard / dsh-minimal，位于项目 cores/ 目录，UI 上标 📦）是 fork 来源：只能 read 作参考，不要 write_file 修改它们——模板只影响之后 fork 出的新 core，你的改动也会被项目仓库覆盖。其他 core（包括你自己）都可以修改；修改自己之前想清楚：改完 reload 后，你会用新代码继续工作。
7. 你可以 read 任何 core 的文件作为参考。
8. git 快照与回滚由 daemon 管理，需要时调用 snapshot / rollback 工具。每次完成一轮有效改动后打一次快照即可，不要重复打。
9. 少而准：每一步只做一件必要的事；已经确认过的信息不要重复验证。
10. 完成任务后用 done(message) 收尾，message 用中文简要总结。`;
}

/** 记忆节点：读历史进上下文。默认**全量**——不过滤、不截断，step 过程行（思考/工具痕迹）也进，
 *  映射为 assistant（过程痕迹是上下文的一部分，不是只作展示的废料）。
 *  显式传 limit 才窗口化：最近 limit 条；0 = 不读历史（每轮独立）。
 *  role 映射：user→user，agent/step→assistant。 */
export function loadHistory(memory: MemoryStore, limit?: number): { role: Role; text: string }[] {
  const rows = memory.list();
  const slice = limit === undefined ? rows : rows.slice(Math.max(0, rows.length - limit));
  return slice.map((m) => ({ role: m.role === "user" ? "user" : "assistant", text: m.text }));
}

/** 消息组装节点：system + 历史 + 本条用户消息 → LLM 消息数组。 */
export function composeMessages(
  system: string,
  history: { role: Role; text: string }[],
  userText: string,
): ChatMessage[] {
  return [
    { role: "system", content: system },
    ...history.map((h) => ({ role: h.role, content: h.text })),
    { role: "user", content: userText },
  ];
}

/** LLM 节点：一次补全。失败会抛出，流的代码决定怎么处理（重试/降级/报错）。 */
export async function callLLM(
  llm: LLMProvider,
  tools: ToolPackage[],
  messages: ChatMessage[],
  opts?: LLMOptions,
): Promise<LLMResult> {
  const toolDefs: ToolDef[] = tools.flatMap((p) => p.tools);
  return llm.chat(messages, toolDefs, opts);
}

/** LLM 流式节点：逐块把增量喂给 on（reasoning = 思考文本，text = 正式输出），返回累积后的完整结果。
 *  provider 没实现 stream（旧实现/选择器）→ chat 兜底，把完整文本各发一次单条增量——UI 表现退回非流式，但行为正确。
 *  opts.signal 被 abort 时：返回已生成的部分（不抛错），流的代码据此给出"已停止"回复。 */
export async function streamLLM(
  llm: LLMProvider,
  tools: ToolPackage[],
  messages: ChatMessage[],
  on: (delta: LLMDelta) => void,
  opts?: LLMOptions,
): Promise<LLMResult> {
  const toolDefs: ToolDef[] = tools.flatMap((p) => p.tools);
  if (llm.stream) return llm.stream(messages, toolDefs, on, opts);
  const res = await llm.chat(messages, toolDefs, opts);
  if (res.reasoning) on({ type: "reasoning", text: res.reasoning });
  if (res.content) on({ type: "text", text: res.content });
  return res;
}

/** 工具节点：执行全部 tool_calls。signal 终止时停止调度剩余工具，并把它透传给 exec——
 *  长任务（run_cmd / daemon 调用）据此真正中止。返回要追加进对话的消息；done 表示任务收尾（携带最终回复）。 */
export async function runTools(
  tools: ToolPackage[],
  toolCalls: ToolCall[],
  signal?: AbortSignal,
): Promise<{ messages: ChatMessage[]; done: string | null }> {
  const messages: ChatMessage[] = [];
  let done: string | null = null;
  for (const tc of toolCalls) {
    if (signal?.aborted) break; // 终止请求：不再执行剩余工具（已完成的结果照常返回）
    const pkg = tools.find((p) => p.tools.some((t) => t.function.name === tc.function.name));
    const result: ToolResult = pkg
      ? await pkg.exec(tc.function.name, tc.function.arguments, signal)
      : { kind: "result", text: `未知工具: ${tc.function.name}` };
    if (result.kind === "done") {
      done = result.message;
      break;
    }
    messages.push({ role: "tool", tool_call_id: tc.id, content: result.text });
  }
  return { messages, done };
}

/** 记忆节点：把这一轮对话写入历史（user 先、agent 后）。 */
export function saveHistory(memory: MemoryStore, userText: string, reply: string): void {
  memory.insert("user", userText);
  memory.insert("agent", reply);
}
