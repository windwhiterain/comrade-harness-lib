/**
 * 持久 shell 的终端层（上游 dsh-terminal + dsh-terminal-bash 的独立移植）。
 *
 * 上游用 node-pty 提供真 PTY（tty 语义、前台进程组、可交互命令）；
 * 本包为零依赖改用**管道后端**：非交互 bash（--noprofile --norc），stdout/stderr
 * 合并进有界 scrollback。极简模式的核心契约（状态跨调用持久、marker 包裹的
 * 命令执行、超时重置、输出裁剪）与上游完全一致；代价是没有 tty 的命令
 * （vim/less/交互式程序）不可用、没有前台进程组信令。
 *
 * `TerminalHandle` 是抽象缝：想换回 PTY 时实现同一个接口即可（node-pty 的
 * handle 形态与上游 SubprocessTerminalHandle 相同）。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { TerminalSanitizer } from './sanitize'

/** 一次终端读请求：offset 是从**末尾**倒数多少行开始。 */
export interface TerminalReadRequest {
  offset?: number
  count?: number
}

/** 一次终端读的结果（与上游 TerminalReadResult 同形）。 */
export interface TerminalReadResult {
  text: string
  totalLines: number
  lineBegin: number
  lineEnd: number
  truncated: boolean
}

/** 一次发送的结果：写完后立刻可见的视口。 */
export interface TerminalSendResult {
  viewport: string
  truncated: boolean
}

/** 进程退出的结果。 */
export interface TerminalOutcome {
  exitCode: number | null
  signal: NodeJS.Signals | null
}

/** 持久 shell 的终端句柄（bash.ts 只依赖这个缝）。 */
export interface TerminalHandle {
  readonly pid: number
  /** 进程是否已退出。 */
  readonly exited: boolean
  /** 进程退出时 resolve。 */
  readonly done: Promise<TerminalOutcome>
  /** 当前 scrollback 全文快照（未裁剪，供发送前基线用）。 */
  snapshot(): string
  /** 写入输入；submit 为 true 时追加换行提交。 */
  send(text: string, submit: boolean): Promise<TerminalSendResult>
  /** 读 scrollback（offset 从末尾倒数）。 */
  read(request?: TerminalReadRequest): TerminalReadResult
  /** 终止进程（win32 用 taskkill 杀进程树，POSIX SIGTERM → 宽限 → SIGKILL）。 */
  terminate(reason: string): Promise<void>
}

/** 管道终端的配置（默认值与上游 terminal-bash config.ts 一致）。 */
export interface PipeTerminalConfig {
  /** shell 工作目录（缺省 process.cwd()）。 */
  cwd?: string
  /** shell 可执行文件（缺省 `bash`，走 PATH；Windows 上需 Git Bash 在 PATH）。 */
  shellPath?: string
  /** shell 参数（缺省 `--noprofile --norc`，非交互）。 */
  shellArgs?: string[]
  /** scrollback 保留的最大逻辑行数（缺省 10000）。 */
  scrollbackLines?: number
  /** scrollback 保留的最大 UTF-8 字节数（缺省 4 MiB）。 */
  scrollbackMaxBytes?: number
  /** 单次 read 或视口返回的最大字节数（缺省 256 KiB）。 */
  maxReadBytes?: number
  /** 关闭时 SIGTERM 后等待 SIGKILL 的宽限（缺省 3000）。 */
  disposeGraceMs?: number
}

const DEFAULTS: Required<Pick<PipeTerminalConfig, 'shellPath' | 'shellArgs' | 'scrollbackLines' | 'scrollbackMaxBytes' | 'maxReadBytes' | 'disposeGraceMs'>> = {
  shellPath: 'bash',
  shellArgs: ['--noprofile', '--norc'],
  scrollbackLines: 10_000,
  scrollbackMaxBytes: 4 * 1024 * 1024,
  maxReadBytes: 256 * 1024,
  disposeGraceMs: 3_000,
}

function utf8Tail(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false }
  const chars = Array.from(text)
  let bytes = 0
  let start = chars.length
  while (start > 0) {
    const next = Buffer.byteLength(chars[start - 1] as string)
    if (bytes + next > maxBytes) break
    bytes += next
    start -= 1
  }
  return { text: chars.slice(start).join(''), truncated: true }
}

/** 有界文本缓冲（上游 BoundedTextBuffer 移植：超行数丢头、超字节留尾）。 */
class BoundedTextBuffer {
  private value = ''
  private dropped = false

  constructor(
    private readonly maxBytes: number,
    private readonly maxLines?: number,
  ) {}

  append(text: string): void {
    if (text.length === 0) return
    this.value += text
    if (this.maxLines !== undefined) {
      const lines = this.value.split('\n')
      if (lines.length > this.maxLines) {
        this.value = lines.slice(lines.length - this.maxLines).join('\n')
        this.dropped = true
      }
    }
    const tail = utf8Tail(this.value, this.maxBytes)
    this.value = tail.text
    this.dropped ||= tail.truncated
  }

  snapshot(): { text: string; truncated: boolean } {
    return { text: this.value, truncated: this.dropped }
  }
}

/** 管道后端：一个非交互 bash 子进程。 */
export class PipeTerminal implements TerminalHandle {
  readonly pid: number
  private readonly child: ChildProcess
  private readonly config: Required<Pick<PipeTerminalConfig, 'scrollbackLines' | 'scrollbackMaxBytes' | 'maxReadBytes' | 'disposeGraceMs'>>
  private readonly scrollback: BoundedTextBuffer
  private readonly sanitizer: TerminalSanitizer
  private readonly completion: Promise<TerminalOutcome>
  private outcome: TerminalOutcome | undefined
  private closePromise: Promise<void> | undefined
  private readonly outputEnded = Promise.withResolvers<void>()

  private constructor(child: ChildProcess, config: Required<Pick<PipeTerminalConfig, 'cwd' | 'shellPath' | 'shellArgs' | 'scrollbackLines' | 'scrollbackMaxBytes' | 'maxReadBytes' | 'disposeGraceMs'>>) {
    this.child = child
    this.pid = child.pid ?? -1
    this.config = config
    this.scrollback = new BoundedTextBuffer(config.scrollbackMaxBytes, config.scrollbackLines)
    this.sanitizer = new TerminalSanitizer(config.maxReadBytes)

    const decoder = new TextDecoder()
    const onData = (chunk: Buffer | string): void => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
      const sanitized = this.sanitizer.push(decoder.decode(bytes, { stream: true }))
      this.scrollback.append(sanitized.text)
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)

    this.completion = new Promise<TerminalOutcome>((resolve) => {
      child.once('close', (code, signal) => {
        // stdout/stderr 都已 end；冲刷解码器与清洗器的残留。
        const flushed = this.sanitizer.push(decoder.decode())
        if (flushed.text.length > 0) this.scrollback.append(flushed.text)
        const finalFlush = this.sanitizer.flush()
        if (finalFlush.length > 0) this.scrollback.append(finalFlush)
        this.outputEnded.resolve()
        const outcome: TerminalOutcome = { exitCode: code, signal }
        this.outcome = outcome
        resolve(outcome)
      })
    })
  }

  /**
   * 派生一个管道 bash。
   * @throws 派生失败（shell 不存在等）时以带 shellPath 的明确错误拒绝。
   */
  static spawn(config: PipeTerminalConfig = {}): Promise<PipeTerminal> {
    const resolved = { ...DEFAULTS, ...config, cwd: config.cwd ?? process.cwd() }
    return new Promise<PipeTerminal>((resolvePromise, reject) => {
      const child = spawn(resolved.shellPath, resolved.shellArgs, {
        cwd: resolved.cwd ?? process.cwd(),
        env: {
          ...process.env,
          TERM: 'dumb',
          PAGER: 'cat',
          GIT_PAGER: 'cat',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      const terminal = new PipeTerminal(child, resolved)
      child.once('error', (error) => {
        reject(new Error(`bash tool: failed to spawn shell "${resolved.shellPath}" (${error.message}); is it installed and on PATH?`))
        void terminal.terminate('spawn failed').catch(() => {})
      })
      child.once('spawn', () => resolvePromise(terminal))
    })
  }

  get exited(): boolean {
    return this.outcome !== undefined
  }

  get done(): Promise<TerminalOutcome> {
    return this.completion
  }

  snapshot(): string {
    return this.scrollback.snapshot().text
  }

  async send(text: string, submit: boolean): Promise<TerminalSendResult> {
    if (this.exited || this.child.stdin === null || this.child.stdin.destroyed) {
      throw new Error('persistent bash shell has exited')
    }
    const input = `${text}${submit ? '\n' : ''}`
    if (input.length > 0) {
      const ok = this.child.stdin.write(input)
      if (!ok) {
        await new Promise<void>((resolve) => this.child.stdin!.once('drain', resolve))
      }
    }
    // 让一个宏任务过去，使紧随写入的输出落入视口（与上游 send 等待期间
    // 累积输出到 viewport 的语义近似）。
    await new Promise<void>((resolve) => setImmediate(resolve))
    const snapshot = this.scrollback.snapshot()
    return { viewport: snapshot.text, truncated: snapshot.truncated }
  }

  read(request: TerminalReadRequest = {}): TerminalReadResult {
    const snapshot = this.scrollback.snapshot()
    const lines = snapshot.text.split('\n')
    const totalLines = snapshot.text.length === 0 ? 0 : lines.length
    const offset = request.offset ?? 0
    const count = request.count ?? 500
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('terminal read offset must be a non-negative safe integer')
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error('terminal read count must be a positive safe integer')
    if (offset >= totalLines) {
      return { text: '', totalLines, lineBegin: offset, lineEnd: offset, truncated: snapshot.truncated }
    }
    const end = totalLines - offset
    const start = Math.max(0, end - count)
    const requested = lines.slice(start, end).join('\n')
    const bounded = utf8Tail(requested, this.config.maxReadBytes)
    const returnedLines = bounded.text.length === 0 ? 0 : bounded.text.split('\n').length
    return {
      text: bounded.text,
      totalLines,
      lineBegin: offset,
      lineEnd: offset + returnedLines,
      truncated: snapshot.truncated || bounded.truncated,
    }
  }

  terminate(reason: string): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise
    this.closePromise = this.closeOnce(reason)
    return this.closePromise
  }

  private async closeOnce(reason: string): Promise<void> {
    if (this.exited) return
    if (process.platform === 'win32') {
      // child.kill() = 直接 TerminateProcess，close 事件即时触发；再异步 taskkill /T 收进程树
      // （bash 的 fork 子进程不随 bash 死）。不能只靠 taskkill：它在 MSYS bash 上杀完进程后
      // close 事件会迟到命令自然结束，等它会让 abort/超时看起来"无效"（实测）。
      // 也不 await completion——进程被杀后 OS 会回收，close 迟到无副作用。
      this.child.kill()
      spawn('taskkill', ['/pid', String(this.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => {})
      return
    }
    this.child.kill('SIGTERM')
    await Promise.race([
      this.completion,
      new Promise<void>((resolve) => setTimeout(resolve, this.config.disposeGraceMs)),
    ])
    if (!this.exited) this.child.kill('SIGKILL')
    await this.completion.catch(() => {})
    await this.outputEnded.promise
  }
}
