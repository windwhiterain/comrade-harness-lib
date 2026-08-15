/**
 * `bash` 工具——持久 shell（从 dsh-minimal 库移植，dsh-minimal 与 standard 共享）。
 *
 * 模型面对的核心契约逐字对齐上游 dsh-tool-bash-persistent：
 * - **持久**：同一工具实例内一个常驻 bash，cwd / 环境变量 / 已导出变量跨调用保留；
 * - **marker 协议**：每条命令用随机 nonce 包裹
 *   `printf 'START'; eval -- 'cmd'; status=$?; printf 'END:$status'`，
 *   从 scrollback 里定位 END 提取输出与退出码——管道模式下这比 PTY 提示符
 *   检测更可靠（非交互 bash 不打印 PS1）；
 * - **超时重置**：命令超时（缺省 300s）→ 拿部分输出 → 杀掉 shell → 下一条
 *   命令从干净环境重新开始（SHELL_RESET_MESSAGE 明说）；
 * - **裁剪**：输出超过 maxOutputChars（缺省 16000）以 `<response clipped>`
 *   截断；scrollback 上限 4 MiB / 10000 行，头部丢失时带 LOST_PREFIX_MESSAGE；
 * - **串行化**：同一实例的并发调用排队（上游 per-agent 串行化）。
 *
 * Windows 适配：`translateWindowsPaths` 在 bash 解析之前（命令文本层）把
 * Windows 盘符路径（C:/x、C:\x，含引号包裹）转成 MSYS POSIX 路径（/c/x）。
 * 模型可见的一切——描述、参数 schema、错误消息、退出码格式——逐字不动。
 *
 * 与上游的差异：上游 shell 是 node-pty PTY（交互式命令可用、有前台进程组
 * 信令）；本包是管道后端（非交互），交互式程序不可用——见 terminal.ts。
 */

import { randomUUID } from 'node:crypto'
import type { TerminalHandle } from './terminal'
import { PipeTerminal, type PipeTerminalConfig } from './terminal'
import type { Tool, ToolPackage } from './types'
import { toToolPackage } from './types'

const TRUNCATED_MESSAGE = '<response clipped><NOTE>To save on context only part of this file has been shown to you. You should retry this tool after you have searched inside the file with `grep -n` in order to find the line numbers of what you are looking for.</NOTE>'
const LOST_PREFIX_MESSAGE = '<response clipped><NOTE>The beginning of this command output was dropped by the terminal scrollback limit. The following text is the earliest retained output.</NOTE>\n'
const SHELL_RESET_MESSAGE = 'The persistent bash shell was reset; the next bash call starts from the workspace with a fresh current directory and environment.'
const SHELL_PROMPT = '__DSH_PERSISTENT_BASH_PROMPT__ '
const TIMEOUT_CODE = 'PERSISTENT_BASH_TIMEOUT'
// 一页足够找到刚发出的完成 marker；完整 scrollback 只在命令落定或需要
// 部分输出时组装。
const SCROLLBACK_PAGE_LINES = 1_000
const POLL_INTERVAL_MS = 25

/** 极简模式 preset 里给 bash 工具配置的模型可见描述（与 agent.cordis.yml 逐字一致）。
 * 单一定义源：dsh-minimal 库 re-export 它，保证两个入口的描述逐字相同。 */
export const PRESET_DESCRIPTION = `Run commands in a bash shell
* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.
* You don't have access to the internet via this tool.
* You do have access to a mirror of common linux and python packages via apt and pip.
* State is persistent across command calls and discussions with the user.
* To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.
* Please avoid commands that may produce a very large amount of output.
* Please run long lived commands in the background, e.g. 'sleep 10 &' or start a server in the background.`

/** `bash` 工具的配置。 */
export interface BashToolConfig {
  /** shell 工作目录（缺省 process.cwd()）。 */
  cwd?: string
  /** shell 可执行文件（缺省 `bash`；Windows 需 Git Bash 在 PATH）。 */
  shellPath?: string
  /** 单条命令的墙钟上限（缺省 300000）。 */
  timeoutMs?: number
  /** 返回输出在裁剪前的最大字符数（缺省 16000）。 */
  maxOutputChars?: number
  /** 模型可见的工具描述（缺省为极简模式 preset 的描述）。 */
  description?: string
  /** 透传给 PipeTerminal 的额外配置。 */
  terminal?: Omit<PipeTerminalConfig, 'cwd' | 'shellPath'>
}

interface ResolvedConfig {
  cwd: string
  shellPath: string
  timeoutMs: number
  maxOutputChars: number
  description: string
}

interface CommandMarkers {
  start: string
  end: string
}

interface RetainedOutput {
  text: string
  truncated: boolean
}

interface CapturedOutput {
  text: string
  incomplete: boolean
  exitCode?: number
}

function maybeTruncate(content: string, maxOutputChars: number, incomplete = false): string {
  if (content.length <= maxOutputChars && !incomplete) return content
  return content.length <= maxOutputChars
    ? content + TRUNCATED_MESSAGE
    : content.slice(0, maxOutputChars) + TRUNCATED_MESSAGE
}

function markers(): CommandMarkers {
  const nonce = randomUUID()
  return {
    start: `__DSH_PERSISTENT_BASH_START_${nonce}__`,
    end: `__DSH_PERSISTENT_BASH_END_${nonce}:`,
  }
}

function quoteForBash(value: string): string {
  return `$'${value
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'")
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')}'`
}

/**
 * 把命令文本里的 Windows 盘符路径（`C:/x`、`C:\x`，含引号包裹的带空格路径）
 * 转成 MSYS POSIX 路径（`/c/x`）。适配发生在 bash 解析之前（命令文本层），
 * 模型可见的一切——描述、参数 schema、错误消息、退出码格式——逐字不动，
 * 过拟合保护面不变。
 *
 * 背景：Git Bash 的 bash 是 MSYS 程序，不认 `C:/...` / `C:\...` 盘符路径
 * （bash 内建 cd 能转换，外部命令 ls/cat/sed 等不转换；裸写 `C:\foo` 的
 * 反斜杠还会被 bash 当转义符吃掉）。模型按 Windows 习惯给路径必然失败，
 * 只能靠临场推理绕到 `/c/...`——这里是把它变成确定性行为。
 *
 * 诚实边界：命令里的字符串字面量若恰好含 `X:/` 模式（如 `echo "C:/foo"`、
 * `grep 'C:/x'`）也会被转换——启发式翻译的固有代价；bash 的主流用途是
 * 路径操作（cat/ls/sed/...），收益远大于此。
 */
export function translateWindowsPaths(command: string): string {
  // `\\` 折叠为 `\`（双引号内模型常写 `C:\\foo`），再统一转正斜杠。
  const toPosix = (p: string): string => p.replaceAll('\\\\', '\\').replaceAll('\\', '/')
  const drive = (d: string): string => d.toLowerCase()
  // ① 双引号包裹的整体路径（含空格路径需要引号，保留引号）
  let out = command.replace(/"([A-Za-z]):([\\/][^"]*)"/g, (_m, d: string, p: string) => `"/${drive(d)}${toPosix(p)}"`)
  // ② 单引号包裹的整体路径（单引号内反斜杠是字面量，同样折叠转正斜杠）
  out = out.replace(/'([A-Za-z]):([\\/][^']*)'/g, (_m, d: string, p: string) => `'/${drive(d)}${toPosix(p)}'`)
  // ③ 裸 token（不含空白/引号/$——保持 bash 原有的分词边界；前导非字母
  //    约束防误伤 `http://` 这类 `X:/` 模式）
  return out.replace(/(^|[^A-Za-z0-9])([A-Za-z]):([\\/][^\s"'$]+)/g, (_m, pre: string, d: string, p: string) => `${pre}/${drive(d)}${toPosix(p)}`)
}

function wrapCommand(command: string, marker: CommandMarkers): string {
  // 包裹体保持单物理行。交互式 bash 会在执行缓冲前为内嵌换行打印 PS2，
  // 把终端提示符和 marker 源文本泄漏进模型可见结果。
  return `printf '%s\\n' ${quoteForBash(marker.start)}; eval -- ${quoteForBash(command)}; __dsh_persistent_bash_status=$?; printf '%s%s\\n' ${quoteForBash(marker.end)} "$__dsh_persistent_bash_status"`
}

function stripPrompt(text: string): string {
  let result = text.replace(/\r?\n$/, '')
  while (result.endsWith(SHELL_PROMPT)) {
    result = result.slice(0, -SHELL_PROMPT.length)
  }
  return result.endsWith('\n') ? result.slice(0, -1) : result
}

function commandOutput(
  snapshot: RetainedOutput,
  marker: CommandMarkers,
): CapturedOutput | undefined {
  const text = snapshot.text
  const end = text.lastIndexOf(marker.end)
  const status = /^(\d+)\r?\n/.exec(text.slice(end + marker.end.length))?.[1]
  if (status === undefined) return undefined
  const startMarker = text.lastIndexOf(marker.start, end)
  const start = startMarker < 0 ? 0 : startMarker + marker.start.length
  return {
    text: stripPrompt(text.slice(start, end).replace(/^\r?\n/, '')),
    incomplete: startMarker < 0,
    exitCode: Number(status),
  }
}

function partialOutput(
  snapshot: RetainedOutput,
  marker: CommandMarkers,
  fallback: string,
  fallbackTruncated = false,
): CapturedOutput {
  const startMarker = snapshot.text.lastIndexOf(marker.start)
  if (startMarker >= 0) {
    return {
      text: stripPrompt(snapshot.text.slice(startMarker + marker.start.length).replace(/^\r?\n/, '')),
      incomplete: false,
    }
  }
  const fallbackStart = fallback.lastIndexOf(marker.start)
  const afterStart = fallbackStart < 0
    ? fallback
    : fallback.slice(fallbackStart + marker.start.length).replace(/^\r?\n/, '')
  const fallbackEnd = afterStart.lastIndexOf(marker.end)
  const beforeEnd = fallbackEnd < 0 ? afterStart : afterStart.slice(0, fallbackEnd)
  return {
    text: stripPrompt(beforeEnd.replaceAll(SHELL_PROMPT, '')),
    incomplete: fallbackTruncated || fallbackStart < 0,
  }
}

async function pause(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
}

/** scrollback 里自 prior 之后的增量文本（prior 被头裁时保守返回全文）。 */
function incrementalTail(text: string, prior: string): string {
  if (prior.length === 0) return text
  const index = text.lastIndexOf(prior)
  return index < 0 ? text : text.slice(index + prior.length)
}

function nextScrollbackOffset(page: { text: string; lineEnd: number }, offset: number): number | undefined {
  if (page.text.length === 0 || page.lineEnd <= offset) return undefined
  return page.lineEnd
}

function retainedScrollback(
  terminal: TerminalHandle,
  latest = terminal.read({ offset: 0, count: SCROLLBACK_PAGE_LINES }),
): RetainedOutput {
  const pages: string[] = latest.text.length === 0 ? [] : [latest.text]
  let offset = latest.lineEnd
  let truncated = latest.truncated
  while (true) {
    if (offset >= latest.totalLines) break
    const page = terminal.read({ offset, count: SCROLLBACK_PAGE_LINES })
    truncated ||= page.truncated
    if (page.text.length > 0) pages.unshift(page.text)
    const next = nextScrollbackOffset(page, offset)
    if (next === undefined || next >= page.totalLines) break
    offset = next
  }
  return { text: pages.join('\n'), truncated }
}

function renderCaptured(output: CapturedOutput, maxOutputChars: number): string {
  const rendered = maybeTruncate(output.text, maxOutputChars, output.incomplete)
  const withPrefix = output.incomplete && output.text.length > 0
    ? LOST_PREFIX_MESSAGE + rendered
    : rendered
  const marker = output.exitCode !== undefined && output.exitCode !== 0
    ? `[exit code: ${output.exitCode}]`
    : undefined
  return appendStatusMarker(withPrefix, marker)
}

function appendStatusMarker(content: string, marker: string | undefined): string {
  if (marker === undefined) return content
  return content.length === 0 ? marker : `${content}\n${marker}`
}

function renderShellExitStatus(
  content: string,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
): string {
  const marker = signal !== null
    ? `[shell killed by signal: ${signal}]`
    : exitCode !== null
      ? `[shell exited: code ${exitCode}]`
      : '[shell exited]'
  return appendStatusMarker(content, marker)
}

/** 一个 deadline：上游 dsh-timeout 的 deadline() 简化移植。 */
interface Deadline {
  signal: AbortSignal
  /** 超时发生返回 { timeoutMs }，否则 undefined。 */
  timeoutOf(): { timeoutMs: number } | undefined
}

function deadline(upstream: AbortSignal, timeoutMs: number): Deadline {
  const timer = AbortSignal.timeout(timeoutMs)
  const signal = AbortSignal.any([upstream, timer])
  return {
    signal,
    timeoutOf() {
      return timer.aborted ? { timeoutMs } : undefined
    },
  }
}

/** 每个工具实例一个持久 shell（上游按 agent 拥有，这里按实例拥有）。 */
function persistentShells(config: ResolvedConfig): {
  get(signal: AbortSignal): Promise<TerminalHandle>
  reset(reason: string): Promise<void>
} {
  // pending 在上游是 per-owner 永久缓存：只在 reset 时清除——这正是
  // 「持久」的机制（同一条已 resolve 的创建承诺 = 同一个 shell）。
  let pending: Promise<TerminalHandle> | undefined
  let live: TerminalHandle | undefined

  const reset = async (reason: string): Promise<void> => {
    pending = undefined
    const terminal = live
    live = undefined
    if (terminal !== undefined) await terminal.terminate(reason).catch(() => {})
  }

  const get = (signal: AbortSignal): Promise<TerminalHandle> => {
    if (pending !== undefined) return pending
    const creation = (async () => {
      try {
        const terminal = await PipeTerminal.spawn({
          cwd: config.cwd,
          shellPath: config.shellPath,
        })
        live = terminal
        void terminal.done.then(() => {
          if (live === terminal) live = undefined
        })
        return terminal
      } catch (error: unknown) {
        await reset('persistent bash spawn failed')
        throw error
      }
    })()
    pending = creation
    return creation
  }

  return { get, reset }
}

async function executeCommand(
  shells: ReturnType<typeof persistentShells>,
  command: string,
  config: ResolvedConfig,
  upstream: AbortSignal,
): Promise<string> {
  const deadlineHandle = deadline(upstream, config.timeoutMs)
  const terminal = await shells.get(deadlineHandle.signal)
  const marker = markers()
  const wrapped = wrapCommand(translateWindowsPaths(command), marker)
  let first = true
  let fallback = ''
  let fallbackTruncated = false
  let lastPolled = ''

  while (true) {
    let operation
    try {
      const before = terminal.snapshot()
      operation = await terminal.send(first ? wrapped : '', first)
      first = false
      // 视口增量 = 写入后立刻可见的输出（与上游 send 期间累积的 viewport 近似）。
      const viewport = incrementalTail(operation.viewport, before)
      fallback = viewport
      lastPolled = operation.viewport
    } catch (error: unknown) {
      await shells.reset('persistent bash send failed')
      throw error
    }
    const latest = terminal.read({ offset: 0, count: SCROLLBACK_PAGE_LINES })
    const delta = incrementalTail(latest.text, lastPolled)
    fallback = fallback.length === 0 ? delta : fallback + delta
    fallbackTruncated ||= latest.truncated
    lastPolled = latest.text

    const timedOut = deadlineHandle.timeoutOf()
    if (timedOut !== undefined) {
      const snapshot = retainedScrollback(terminal, latest)
      const partial = renderCaptured(
        partialOutput(snapshot, marker, fallback, fallbackTruncated),
        config.maxOutputChars,
      )
      await shells.reset('persistent bash command timed out')
      return [
        `Your command timed out after ${Math.round(timedOut.timeoutMs / 1000)} seconds or experienced an OOM error. Below is partial output:`,
        partial,
        SHELL_RESET_MESSAGE,
      ].join('\n')
    }
    if (upstream.aborted) {
      await shells.reset('persistent bash command aborted')
      upstream.throwIfAborted()
    }
    if (latest.text.includes(marker.end)) {
      const complete = commandOutput(retainedScrollback(terminal, latest), marker)
      if (complete !== undefined) return renderCaptured(complete, config.maxOutputChars)
    }
    if (terminal.exited) {
      const snapshot = retainedScrollback(terminal, latest)
      await shells.reset('persistent bash shell exited')
      const outcome = await terminal.done
      return [
        renderShellExitStatus(
          renderCaptured(partialOutput(snapshot, marker, fallback, fallbackTruncated), config.maxOutputChars),
          outcome.exitCode,
          outcome.signal,
        ),
        SHELL_RESET_MESSAGE,
      ].filter(part => part.length > 0).join('\n')
    }
    await pause()
  }
}

/** 创建一个持久 `bash` 工具（极简模式的第一个工具）。 */
export function createBashTool(config: BashToolConfig = {}): Tool {
  const resolved: ResolvedConfig = {
    cwd: config.cwd ?? process.cwd(),
    shellPath: config.shellPath ?? 'bash',
    timeoutMs: config.timeoutMs ?? 300_000,
    maxOutputChars: config.maxOutputChars ?? 16_000,
    description: config.description ?? PRESET_DESCRIPTION,
  }
  if (resolved.shellPath.trim().length === 0) {
    throw new Error('bash: shellPath must be non-empty')
  }
  if (!Number.isSafeInteger(resolved.timeoutMs) || resolved.timeoutMs <= 0) {
    throw new Error('bash: timeoutMs must be a positive safe integer')
  }
  if (!Number.isSafeInteger(resolved.maxOutputChars) || resolved.maxOutputChars <= 0) {
    throw new Error('bash: maxOutputChars must be a positive safe integer')
  }
  if (resolved.description.trim().length === 0) {
    throw new Error('bash: description must be non-empty')
  }

  const shells = persistentShells(resolved)
  let queue: Promise<void> = Promise.resolve()

  return {
    name: 'bash',
    description: resolved.description,
    parameters: {
      command: {
        type: 'string',
        required: true,
        description: 'The bash command to run. Relative path is preferred in the command.',
      },
    },
    async execute(args, signal?: AbortSignal) {
      const command = args.command
      if (typeof command !== 'string' || command.trim().length === 0) {
        throw new Error('command must be a non-empty string')
      }
      // 外部终止信号（harness 的 /api/abort → runTools → exec 透传）；独立使用（demo/脚本）时无信号 → 永不中止
      const upstream = signal ?? new AbortController().signal
      const run = queue.then(
        () => executeCommand(shells, command, resolved, upstream),
        () => executeCommand(shells, command, resolved, upstream),
      )
      queue = run.then(() => undefined, () => undefined)
      return run
    },
    async dispose() {
      await shells.reset('bash tool disposed')
    },
  }
}

/** 把持久 `bash` 工具包成 ToolPackage（comrade-harness 子 harness 直接 import 用）。 */
export function bashPackage(config: BashToolConfig = {}): ToolPackage {
  return toToolPackage('dsh-minimal-bash', createBashTool(config))
}
