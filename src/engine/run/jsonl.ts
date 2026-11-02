import { appendFile } from 'node:fs/promises'
import { RensaError } from '../errors.js'

/**
 * Appends lines to one file in order, never two writes at once; lines
 * pushed while a write is in flight go out together in the next one.
 * `push` returns immediately; `flush` waits for the queue to drain. After a failed write the remaining lines are dropped and every
 * later `flush` rejects with that error: writing past a gap would leave a
 * file that reads as complete.
 */
export class AppendQueue {
  private pending: string[] = []
  private draining: Promise<void> | undefined
  private failure: unknown
  private closed = false

  /** `prepare` runs before every drain, e.g. to create the directory. */
  constructor(
    private readonly file: string,
    private readonly prepare: () => Promise<void> = async () => {},
  ) {}

  /** `line` must not contain a newline; one is added. */
  push(line: string): void {
    if (this.closed) throw new RensaError('INTERNAL', `write to closed file ${this.file}`)
    if (this.failure !== undefined) return
    this.pending.push(`${line}\n`)
    this.draining ??= this.drain()
  }

  async flush(): Promise<void> {
    while (this.draining) await this.draining
    if (this.failure !== undefined) throw this.failure
  }

  async close(): Promise<void> {
    this.closed = true
    await this.flush()
  }

  private async drain(): Promise<void> {
    try {
      await this.prepare()
      // Everything pushed while the previous write was in flight goes out
      // as one write, so a burst of lines costs one syscall, not one each.
      while (this.pending.length > 0) {
        const batch = this.pending.join('')
        this.pending = []
        await appendFile(this.file, batch)
      }
    } catch (err) {
      this.failure = err
      this.pending = []
    } finally {
      this.draining = undefined
    }
  }
}

export interface ParsedLines {
  /** `line` is 1-based, for warnings about the value. */
  values: Array<{ line: number; value: unknown }>
  /** One per skipped line, e.g. `line 3: not valid JSON`. */
  warnings: string[]
}

/**
 * Parses newline-delimited JSON. Blank lines are ignored; a line that
 * does not parse is skipped with a warning; when it is the last line
 * and has no newline, the warning calls it a write cut short.
 */
export function parseJsonLines(text: string): ParsedLines {
  const lines = text.split('\n')
  const truncated = lines[lines.length - 1] !== ''
  const values: ParsedLines['values'] = []
  const warnings: string[] = []
  for (const [i, line] of lines.entries()) {
    if (line.trim() === '') continue
    try {
      values.push({ line: i + 1, value: JSON.parse(line) })
    } catch {
      const last = truncated && i === lines.length - 1
      warnings.push(`line ${i + 1}: ${last ? 'truncated final line' : 'not valid JSON'}`)
    }
  }
  return { values, warnings }
}

/** Sorts `line N: ...` warnings by N, so parse and shape warnings interleave in file order. */
export function inLineOrder(warnings: readonly string[]): string[] {
  const line = (w: string) => Number(/^line (\d+)/.exec(w)?.[1] ?? Number.MAX_SAFE_INTEGER)
  return [...warnings].sort((a, b) => line(a) - line(b))
}

/** True for a non-null, non-array object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
