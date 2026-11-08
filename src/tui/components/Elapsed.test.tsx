import { stripVTControlCharacters } from 'node:util'
import { Text } from 'ink'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Frames, renderFrames } from '../../testing/inkFrames.js'
import { Elapsed } from './Elapsed.js'
import { Spinner } from './Spinner.js'

// A render-count probe: Elapsed formats exactly once per render.
const formatCalls = vi.hoisted(() => ({ count: 0 }))
vi.mock('../format.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../format.js')>()
  return {
    ...actual,
    formatElapsed: (ms: number) => {
      formatCalls.count++
      return actual.formatElapsed(ms)
    },
  }
})

const NOW = new Date('2026-11-06T16:30:00.000Z')
const SIZE = { columns: 80, rows: 10 }

let view: Frames | undefined

beforeEach(() => {
  // setImmediate stays real: React's scheduler runs passive effects on it.
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
    now: NOW,
  })
  formatCalls.count = 0
})

afterEach(() => {
  view?.unmount()
  view = undefined
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const effects = () => new Promise<void>((resolve) => setImmediate(resolve))

async function elapse(ms: number): Promise<void> {
  await effects()
  await vi.advanceTimersByTimeAsync(ms)
  await effects()
}

const frame = (v: Frames) => stripVTControlCharacters(v.lastFrame())
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000).toISOString()

describe('an elapsed cell that is still counting', () => {
  it('renders 1:30 when since is 90 s ago and 1:31 after one second', async () => {
    view = renderFrames(<Elapsed since={ago(90)} />, SIZE)
    await effects()
    const first = frame(view)

    await elapse(1000)

    expect([first, frame(view)]).toEqual(['1:30', '1:31'])
  })

  it('renders h:mm:ss when since is more than an hour ago', async () => {
    view = renderFrames(<Elapsed since={ago(3600 + 5 * 60 + 7)} />, SIZE)
    await effects()

    expect(frame(view)).toBe('1:05:07')
  })

  it('stops ticking when unmounted', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')
    view = renderFrames(<Elapsed since={ago(90)} />, SIZE)
    await effects()
    const ticking = setIntervalSpy.mock.results
      .filter((_, i) => setIntervalSpy.mock.calls[i]?.[1] === 1000)
      .map((r) => r.value)

    view.unmount()
    view = undefined

    expect(ticking).toHaveLength(1)
    expect(clearIntervalSpy.mock.calls.map((c) => c[0])).toContain(ticking[0])
  })
})

describe('an elapsed cell with until set', () => {
  it('renders the fixed difference and does not change as time passes', async () => {
    view = renderFrames(<Elapsed since={ago(150)} until={ago(30)} />, SIZE)
    await effects()

    await elapse(5000)

    expect(frame(view)).toBe('2:00')
  })

  it('schedules no interval', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    view = renderFrames(<Elapsed since={ago(150)} until={ago(30)} />, SIZE)
    await effects()

    expect(setIntervalSpy.mock.calls.filter((c) => c[1] === 1000)).toEqual([])
  })
})

/** A step row: re-renders on its label, passes the same `since` to its Elapsed cell. */
function Row(props: { label: string; since: string }): ReactNode {
  return (
    <Text>
      {props.label} <Elapsed since={props.since} />
    </Text>
  )
}

describe('memoized leaves', () => {
  it('does not re-render Elapsed when its parent re-renders with the same props', async () => {
    const since = ago(90)
    view = renderFrames(<Row label="implement" since={since} />, SIZE)
    await effects()
    const rendersAfterMount = formatCalls.count

    view.rerender(<Row label="implement (running)" since={since} />)
    await effects()

    expect(frame(view)).toBe('implement (running) 1:30')
    expect(formatCalls.count).toBe(rendersAfterMount)
  })

  it('changes the spinner frame across an animation tick', async () => {
    view = renderFrames(<Spinner />, SIZE)
    await effects()
    const first = frame(view)

    await elapse(80)

    expect(first).toBe('⠋')
    expect(frame(view)).toBe('⠙')
  })

  it('unmounts the spinner without a later frame or error', async () => {
    view = renderFrames(<Spinner />, SIZE)
    await effects()
    const v = view

    v.unmount()
    view = undefined
    const framesAtUnmount = v.frames.length
    await elapse(500)

    expect(v.frames.length).toBe(framesAtUnmount)
    expect(v.stderrFrames).toEqual([])
  })
})
