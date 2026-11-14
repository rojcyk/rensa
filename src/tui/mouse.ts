// Mouse wheel input for the full-window TUI. While mouse reporting is on,
// the terminal sends wheel turns to the process instead of scrolling its
// own scrollback. Ink parses mouse reports as keys with no name and drops
// them, so the session filters them out of stdin before Ink reads it and
// hands the wheel turns to `WheelHub` subscribers.

/** Normal tracking (presses, releases, wheel) reported in SGR encoding. */
export const ENABLE_MOUSE = '\x1b[?1000h\x1b[?1006h'
export const DISABLE_MOUSE = '\x1b[?1006l\x1b[?1000l'

export type WheelDirection = 'up' | 'down'

/** A complete SGR mouse report: `ESC [ < button ; column ; row` then `M` (press) or `m` (release). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape sequences
const SGR_REPORT = /\x1b\[<(\d+);\d+;\d+[Mm]/
/** The start of an SGR report cut off at the end of a chunk. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape sequences
const SGR_PREFIX = /\x1b\[<[\d;]*$/

/** Bit 6 marks a wheel button; the low two bits say which way. */
const WHEEL_BIT = 64
/** Shift, meta and ctrl bits, which do not change the direction. */
const MODIFIER_BITS = 4 | 8 | 16

/** The wheel direction of an SGR button code, or undefined for any other mouse event. */
export function wheelOf(button: number): WheelDirection | undefined {
  const code = button & ~MODIFIER_BITS
  if (code === WHEEL_BIT) return 'up'
  if (code === WHEEL_BIT + 1) return 'down'
  return undefined
}

/** Fan-out of wheel turns to the components listening. */
export interface WheelHub {
  /** Registers `fn` for every wheel turn; returns its unregister function. */
  subscribe(fn: (direction: WheelDirection) => void): () => void
  emit(direction: WheelDirection): void
}

export function createWheelHub(): WheelHub {
  const fns = new Set<(direction: WheelDirection) => void>()
  return {
    subscribe(fn) {
      fns.add(fn)
      return () => {
        fns.delete(fn)
      }
    },
    emit(direction) {
      for (const fn of [...fns]) fn(direction)
    },
  }
}

/** The part of a readable stream the filter replaces. */
export interface ReadableSource {
  read(size?: number): string | Buffer | null
}

/**
 * Replaces `stream.read` so the chunks Ink reads carry no mouse reports,
 * and each wheel turn goes to `onWheel`. Input order is kept: text before
 * a report is returned first, and the report is handled on the next read,
 * after Ink has acted on that text. A report cut off at the end of a chunk
 * is held back and joined to the next one. Returns the function that puts
 * the original `read` back; calling it again does nothing.
 */
export function filterMouseReads(
  stream: ReadableSource,
  onWheel: (direction: WheelDirection) => void,
): () => void {
  const original = stream.read
  /** Read from the stream but not yet handed to Ink or `onWheel`. */
  let pending = ''
  const filtered = function (this: ReadableSource, size?: number): string | null {
    for (;;) {
      const report = SGR_REPORT.exec(pending)
      if (report?.index === 0) {
        pending = pending.slice(report[0].length)
        const direction = wheelOf(Number(report[1]))
        if (direction !== undefined) onWheel(direction)
        continue
      }
      if (report !== null) {
        const text = pending.slice(0, report.index)
        pending = pending.slice(report.index)
        return text
      }
      // A bare ESC is a key of its own; only a started `ESC [ <` waits for more.
      const cut = SGR_PREFIX.exec(pending)?.[0] ?? ''
      const text = pending.slice(0, pending.length - cut.length)
      pending = cut
      if (text !== '') return text
      const chunk = original.call(this, size)
      if (chunk === null) return null
      pending += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    }
  }
  stream.read = filtered
  let active = true
  return () => {
    if (!active) return
    active = false
    if (stream.read === filtered) stream.read = original
  }
}
