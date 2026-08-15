/**
 * 终端输出清洗（上游 dsh-terminal-bash sanitize.ts 的 1:1 移植）。
 *
 * 剥掉 CSI/OSC/短转义序列，同时保留跨 chunk 的序列搬运；CRLF/孤立 CR 归一为 LF。
 * 管道模式下的 shell 输出同样可能夹带颜色/光标控制序列（如 `ls --color`），
 * 模型看到的必须是干净文本。
 */

import { Buffer } from 'node:buffer'

/** 受控 bash 在每个提示符前发出的 OSC 标记前缀。 */
export const PROMPT_MARKER_PREFIX = '133;D;'

/** 标记后打印的精确提示符文本。 */
export const CONTROLLED_PROMPT = 'dsh> '

/** 一个清洗后的 chunk：可见文本 + 是否含受控提示符标记。 */
export interface SanitizedChunk {
  text: string
  prompt: boolean
  /** 本 chunk 内最新受控标记之后的可见文本。 */
  promptTail?: string
}

/**
 * 去除 CSI/OSC/短转义序列，支持跨 chunk 的未完成序列搬运。
 * 完整终端模拟刻意不做；普通行输出与私有提示符标记是受支持契约。
 */
export class TerminalSanitizer {
  private pending = ''
  private discardMode: 'osc' | 'csi' | undefined
  private discardOscEscape = false
  private trailingCarriageReturn = false
  private trackingPromptTail = false

  constructor(private readonly maxPendingBytes: number) {}

  /**
   * 消费一个解码后的终端数据 chunk。
   * @returns 可见文本，以及是否完成了受控提示符标记。
   */
  push(chunk: string): SanitizedChunk {
    this.pending += this.discardPrefix(chunk)
    let text = ''
    let prompt = false
    let includePromptTail = this.trackingPromptTail
    let promptTail = ''
    let index = 0
    const appendText = (value: string): void => {
      text += value
      if (this.trackingPromptTail) promptTail += value
    }
    while (index < this.pending.length) {
      const escape = this.pending.indexOf('\x1b', index)
      if (escape < 0) {
        appendText(this.pending.slice(index))
        index = this.pending.length
        break
      }
      appendText(this.pending.slice(index, escape))
      if (escape + 1 >= this.pending.length) {
        index = escape
        break
      }
      const kind = this.pending[escape + 1]
      if (kind === ']') {
        const bel = this.pending.indexOf('\x07', escape + 2)
        const stringTerminator = this.pending.indexOf('\x1b\\', escape + 2)
        let end = -1
        if (bel >= 0 && stringTerminator >= 0) end = Math.min(bel + 1, stringTerminator + 2)
        else if (bel >= 0) end = bel + 1
        else if (stringTerminator >= 0) end = stringTerminator + 2
        if (end < 0) {
          index = escape
          break
        }
        const terminatorBytes = this.pending[end - 1] === '\x07' ? 1 : 2
        const content = this.pending.slice(escape + 2, end - terminatorBytes)
        if (content.startsWith(PROMPT_MARKER_PREFIX)) {
          prompt = true
          this.trackingPromptTail = true
          includePromptTail = true
          promptTail = ''
        }
        index = end
        continue
      }
      if (kind === '[') {
        let end = escape + 2
        while (end < this.pending.length) {
          const code = this.pending.charCodeAt(end)
          if (code >= 0x40 && code <= 0x7e) break
          end += 1
        }
        if (end >= this.pending.length) {
          index = escape
          break
        }
        index = end + 1
        continue
      }
      // 两字节转义族（save/restore cursor 等）。
      index = escape + 2
    }
    this.pending = this.pending.slice(index)
    this.enforcePendingBound()
    return {
      text: this.normalizeText(text),
      prompt,
      ...includePromptTail ? { promptTail } : {},
    }
  }

  /**
   * 冲刷终端退出时残留的可打印片段。
   * @returns 剩余可见文本；未完成的转义序列被丢弃。
   */
  flush(): string {
    const text = this.pending.startsWith('\x1b') ? '' : this.pending
    this.pending = ''
    this.discardMode = undefined
    this.discardOscEscape = false
    this.trackingPromptTail = false
    const normalized = this.normalizeText(text)
    if (!this.trailingCarriageReturn) return normalized
    this.trailingCarriageReturn = false
    return `${normalized}\n`
  }

  private normalizeText(text: string): string {
    let complete = this.trailingCarriageReturn ? `\r${text}` : text
    this.trailingCarriageReturn = false
    if (complete.endsWith('\r')) {
      complete = complete.slice(0, -1)
      this.trailingCarriageReturn = true
    }
    return normalizeTerminalText(complete)
  }

  private enforcePendingBound(): void {
    if (Buffer.byteLength(this.pending) <= this.maxPendingBytes) return
    this.discardMode = this.pending[1] === ']' ? 'osc' : 'csi'
    this.pending = ''
  }

  private discardPrefix(chunk: string): string {
    if (this.discardMode === undefined) return chunk
    if (this.discardMode === 'csi') {
      for (let index = 0; index < chunk.length; index += 1) {
        const code = chunk.charCodeAt(index)
        if (code >= 0x40 && code <= 0x7e) {
          this.discardMode = undefined
          return chunk.slice(index + 1)
        }
      }
      return ''
    }

    let index = 0
    if (this.discardOscEscape) {
      this.discardOscEscape = false
      if (chunk.startsWith('\\')) {
        this.discardMode = undefined
        return chunk.slice(1)
      }
    }
    while (index < chunk.length) {
      if (chunk[index] === '\x07') {
        this.discardMode = undefined
        return chunk.slice(index + 1)
      }
      if (chunk[index] === '\x1b') {
        if (chunk[index + 1] === '\\') {
          this.discardMode = undefined
          return chunk.slice(index + 2)
        }
        if (index + 1 === chunk.length) this.discardOscEscape = true
      }
      index += 1
    }
    return ''
  }
}

/**
 * 归一化 CRLF 与孤立回车，供行导向渲染使用。
 * @param text - 已清洗的终端文本。
 * @returns 行归一化、去掉 BEL 的文本。
 */
export function normalizeTerminalText(text: string): string {
  return text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').replaceAll('\x07', '')
}
