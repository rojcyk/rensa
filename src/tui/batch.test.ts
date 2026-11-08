import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBatcher } from './batch.js'
import { FRAME_MS, MAX_FPS } from './frameRate.js'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

/** A flush that records every batch it receives. */
function recorder<T>(): { flush: (items: T[]) => void; batches: T[][] } {
  const batches: T[][] = []
  return { flush: (items) => batches.push(items), batches }
}

describe('coalescing a burst of engine events', () => {
  it('flushes the first push at once and the other 999 together at the window end when 1000 pushes arrive in a loop', async () => {
    const { flush, batches } = recorder<number>()
    const batcher = createBatcher(flush)

    for (let i = 0; i < 1000; i++) batcher.push(i)
    const immediate = batches.map((b) => b.slice())
    await vi.advanceTimersByTimeAsync(FRAME_MS)

    expect(immediate).toEqual([[0]])
    expect(batches).toEqual([[0], Array.from({ length: 999 }, (_, i) => i + 1)])
  })

  it('flushes at most one batch per frame when pushes continue for a fake-timer second', async () => {
    const { flush, batches } = recorder<number>()
    const batcher = createBatcher(flush)

    let pushed = 0
    for (let t = 0; t < 1000; t += 5) {
      batcher.push(pushed++)
      await vi.advanceTimersByTimeAsync(5)
    }
    const flushesWithinTheSecond = batches.length
    batcher.flushNow()

    expect(flushesWithinTheSecond).toBeLessThanOrEqual(MAX_FPS + 1)
    expect(batches.flat()).toEqual(Array.from({ length: pushed }, (_, i) => i))
  })

  it('delivers pending items synchronously when flushNow is called inside the window', () => {
    const { flush, batches } = recorder<string>()
    const batcher = createBatcher(flush)
    batcher.push('run.started')
    batcher.push('step.started')
    batcher.push('agent.spawned')

    batcher.flushNow()

    expect(batches).toEqual([['run.started'], ['step.started', 'agent.spawned']])
  })

  it('does not flush an empty batch when flushNow is called with nothing pending', () => {
    const { flush, batches } = recorder<string>()
    const batcher = createBatcher(flush)

    batcher.flushNow()

    expect(batches).toEqual([])
  })

  it('flushes the next push at once again when a whole quiet window has passed', async () => {
    const { flush, batches } = recorder<string>()
    const batcher = createBatcher(flush)
    batcher.push('step.started')
    await vi.advanceTimersByTimeAsync(FRAME_MS * 3)

    batcher.push('step.finished')

    expect(batches).toEqual([['step.started'], ['step.finished']])
  })

  it('holds a push made inside the window until a full frame has passed since the first flush', async () => {
    const { flush, batches } = recorder<string>()
    const batcher = createBatcher(flush)
    batcher.push('step.started')
    batcher.push('agent.spawned')

    await vi.advanceTimersByTimeAsync(FRAME_MS - 1)
    const beforeTheFrameEnds = batches.length
    await vi.advanceTimersByTimeAsync(1)

    expect({ beforeTheFrameEnds, batches }).toEqual({
      beforeTheFrameEnds: 1,
      batches: [['step.started'], ['agent.spawned']],
    })
  })
})

describe('disposing a batcher', () => {
  it('delivers pending items and then drops later pushes when disposed', async () => {
    const { flush, batches } = recorder<string>()
    const batcher = createBatcher(flush)
    batcher.push('run.started')
    batcher.push('step.started')

    batcher.dispose()
    batcher.push('step.finished')
    await vi.advanceTimersByTimeAsync(FRAME_MS * 2)

    expect(batches).toEqual([['run.started'], ['step.started']])
  })
})
