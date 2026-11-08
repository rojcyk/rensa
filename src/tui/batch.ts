import { FRAME_MS } from './frameRate.js'

export interface Batcher<T> {
  push(item: T): void
  /** Delivers pending items synchronously. */
  flushNow(): void
  /** Delivers pending items, then stops; later pushes are dropped. */
  dispose(): void
}

/**
 * Coalesces a stream into at most one `flush` per window. The first item
 * in a quiet period is delivered at once and opens a window; items
 * arriving within it are delivered together, in order, when it ends,
 * which opens the next window. A window that ends with nothing pending
 * closes, and the stream is quiet again.
 */
export function createBatcher<T>(flush: (items: T[]) => void, ms = FRAME_MS): Batcher<T> {
  let pending: T[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const deliver = () => {
    if (pending.length === 0) return
    const items = pending
    pending = []
    flush(items)
  }

  const windowEnded = () => {
    timer = undefined
    if (pending.length === 0) return
    timer = setTimeout(windowEnded, ms)
    deliver()
  }

  return {
    push(item) {
      if (disposed) return
      pending.push(item)
      if (timer !== undefined) return
      timer = setTimeout(windowEnded, ms)
      deliver()
    },
    flushNow: deliver,
    dispose() {
      if (disposed) return
      deliver()
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    },
  }
}
