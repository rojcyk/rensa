import { stripVTControlCharacters } from 'node:util'
import { Box, Text } from 'ink'
import type { ReactNode } from 'react'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { type Frames, renderFrames } from '../../testing/inkFrames.js'
import { SizeProvider } from '../size.js'
import { Ratchet } from './Ratchet.js'

// "No background of its own" is checked on the escapes; force truecolor
// before Ink (and its chalk) load.
const previousForceColor = vi.hoisted(() => {
  const previous = process.env.FORCE_COLOR
  process.env.FORCE_COLOR = '3'
  return previous
})

afterAll(() => {
  if (previousForceColor === undefined) delete process.env.FORCE_COLOR
  else process.env.FORCE_COLOR = previousForceColor
})

let view: Frames | undefined

afterEach(() => {
  view?.unmount()
  view = undefined
})

/** Lets React run the passive effects the last render scheduled. */
const effects = () => new Promise<void>((resolve) => setImmediate(resolve))

/** Waits for the frame a measurement effect causes, which lands a tick after the render. */
const frameSettles = (assertion: () => void) => vi.waitFor(assertion, { timeout: 1000 })

const BELOW = 'status line below the timeline'

/** `rows` lines inside the ratchet, then a line whose row is the ratchet's height. */
function Probe(props: { rows: number }): ReactNode {
  return (
    <Box flexDirection="column">
      <Ratchet>
        {Array.from({ length: props.rows }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed rows, never reordered
          <Text key={i}>{`○ step-${i + 1}`}</Text>
        ))}
      </Ratchet>
      <Text>{BELOW}</Text>
    </Box>
  )
}

interface Mounted {
  /** The row the line below the ratchet is drawn on: the ratchet's height. */
  heightNow(): number
  show(rows: number, size?: { columns: number; rows: number }): Promise<void>
  frame(): string
}

async function mount(rows: number, size = { columns: 80, rows: 24 }): Promise<Mounted> {
  let current = size
  const tree = (n: number, s: { columns: number; rows: number }) => (
    <SizeProvider columns={s.columns} rows={s.rows}>
      <Probe rows={n} />
    </SizeProvider>
  )
  const v = renderFrames(tree(rows, current), current)
  view = v
  await effects()
  const heightNow = () =>
    stripVTControlCharacters(v.lastFrame())
      .split('\n')
      .findIndex((l) => l.startsWith(BELOW))
  return {
    heightNow,
    async show(n, s = current) {
      if (s !== current) {
        current = s
        v.resize(s.columns, s.rows)
      }
      v.rerender(tree(n, s))
      await effects()
    },
    frame: () => v.lastFrame(),
  }
}

describe('the grow-only height at one terminal size', () => {
  it('keeps the box at 5 rows when its content shrinks from 5 rows to 3', async () => {
    const r = await mount(5)
    await frameSettles(() => expect(r.heightNow()).toBe(5))

    await r.show(3)
    await effects()

    expect(r.heightNow()).toBe(5)
  })

  it('grows the box to 7 rows when its content grows from 3 rows to 7', async () => {
    const r = await mount(3)
    await frameSettles(() => expect(r.heightNow()).toBe(3))

    await r.show(7)

    await frameSettles(() => expect(r.heightNow()).toBe(7))
  })

  it('keeps the tallest height seen when the content goes 3, 7, then 4 rows', async () => {
    const r = await mount(3)
    await r.show(7)
    await frameSettles(() => expect(r.heightNow()).toBe(7))

    await r.show(4)
    await effects()

    expect(r.heightNow()).toBe(7)
  })
})

describe('resetting the height when the terminal bounds change', () => {
  it('shrinks to 3 rows when the content goes from 7 rows to 3 together with a resize', async () => {
    const r = await mount(7, { columns: 80, rows: 24 })
    await frameSettles(() => expect(r.heightNow()).toBe(7))

    await r.show(3, { columns: 100, rows: 30 })

    await frameSettles(() => expect(r.heightNow()).toBe(3))
  })

  it('shrinks to 3 rows when only the terminal height changes with the content', async () => {
    const r = await mount(7, { columns: 80, rows: 24 })
    await frameSettles(() => expect(r.heightNow()).toBe(7))

    await r.show(3, { columns: 80, rows: 20 })

    await frameSettles(() => expect(r.heightNow()).toBe(3))
  })

  it('ratchets again at the new size when the content shrinks after the resize', async () => {
    const r = await mount(3, { columns: 80, rows: 24 })
    await r.show(6, { columns: 100, rows: 30 })
    await frameSettles(() => expect(r.heightNow()).toBe(6))

    await r.show(2)
    await effects()

    expect(r.heightNow()).toBe(6)
  })
})

describe('painting', () => {
  it('paints no background when it holds content that has none', async () => {
    const r = await mount(5)
    await r.show(3)

    // Any SGR background, truecolor or 256-color.
    expect(r.frame()).not.toContain('\x1b[48;')
  })
})
