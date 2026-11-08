/**
 * A bounded append-only buffer with absolute indices. `length` counts
 * every item ever pushed, `start` is the oldest index still retained, and
 * `get`/`slice` return nothing for evicted indices, so an index keeps
 * naming the same item for as long as it exists.
 */
export class RingBuffer<T> {
  private readonly items: T[] = []
  private total = 0

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`ring buffer capacity must be a positive integer, got ${capacity}`)
    }
  }

  /** Total items ever pushed; one past the newest index. */
  get length(): number {
    return this.total
  }

  /** The oldest index still retained. */
  get start(): number {
    return Math.max(0, this.total - this.capacity)
  }

  push(item: T): void {
    this.items[this.total % this.capacity] = item
    this.total++
  }

  /** The item at absolute `index`, or undefined when evicted or not yet pushed. */
  get(index: number): T | undefined {
    if (!Number.isInteger(index) || index < this.start || index >= this.total) return undefined
    return this.items[index % this.capacity]
  }

  /** Retained items with absolute indices in `[from, to)`, oldest first. */
  slice(from: number, to: number): T[] {
    const lo = Math.max(Math.ceil(from), this.start)
    const hi = Math.min(Math.floor(to), this.total)
    const out: T[] = []
    for (let i = lo; i < hi; i++) {
      const item = this.items[i % this.capacity]
      if (item !== undefined) out.push(item)
    }
    return out
  }
}
