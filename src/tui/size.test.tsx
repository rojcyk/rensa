import { Text } from 'ink'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Frames, renderFrames } from '../testing/inkFrames.js'
import { type Size, SizeProvider, useBudget, useSize } from './size.js'

let view: Frames | undefined

beforeEach(() => {
  // setImmediate stays real: React's scheduler runs passive effects on it.
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  })
})

/** Lets React run the passive effects the last render scheduled. */
const effects = () => new Promise<void>((resolve) => setImmediate(resolve))

/** Runs pending effects, moves the fake clock, then lets React commit what the timers set. */
async function elapse(ms: number): Promise<void> {
  await effects()
  await vi.advanceTimersByTimeAsync(ms)
  await effects()
}

afterEach(() => {
  view?.unmount()
  view = undefined
  vi.useRealTimers()
})

interface SizeRecord {
  /** Every distinct size the probe rendered with. */
  sizes: Size[]
  /** Every settledColumns value, once per change. */
  settled: number[]
}

function SizeProbe(props: { record: SizeRecord }): ReactNode {
  const { sizes, settled } = props.record
  const size = useSize()
  if (sizes.at(-1) !== size) sizes.push(size)
  if (settled.at(-1) !== size.settledColumns) settled.push(size.settledColumns)
  return <Text>{`${size.columns}x${size.rows} settled ${size.settledColumns}`}</Text>
}

type BudgetRecord = Array<{ current: number; settled: number }>

function BudgetProbe(props: { record: BudgetRecord }): ReactNode {
  const { current, settled } = useBudget({ headerRows: 2, footerRows: 1, leftIdWidth: 12 })
  props.record.push({ current: current.transcriptCols, settled: settled.transcriptCols })
  return <Text>budget</Text>
}

function sizeProbe(): { probe: ReactNode } & SizeRecord {
  const record: SizeRecord = { sizes: [], settled: [] }
  return { probe: <SizeProbe record={record} />, ...record }
}

function mount(probe: ReactNode, columns: number, rows: number): Frames {
  view = renderFrames(
    <SizeProvider columns={columns} rows={rows}>
      {probe}
    </SizeProvider>,
    { columns, rows },
  )
  return view
}

function resizeTo(v: Frames, probe: ReactNode, columns: number, rows: number): void {
  v.rerender(
    <SizeProvider columns={columns} rows={rows}>
      {probe}
    </SizeProvider>,
  )
}

describe('settling the wrap width during a drag', () => {
  it('updates settledColumns once, 50 ms after the last of five width changes 10 ms apart', async () => {
    const { probe, sizes, settled } = sizeProbe()
    const v = mount(probe, 120, 40)

    for (const columns of [110, 100, 90, 80, 70]) {
      resizeTo(v, probe, columns, 40)
      await elapse(10)
    }
    // 10 ms of the 50 have passed since the last change.
    await elapse(39)
    const settledBeforeQuiet = settled.slice()
    await elapse(1)

    expect(settledBeforeQuiet).toEqual([120])
    expect(settled).toEqual([120, 70])
    expect(sizes.map((s) => s.columns)).toEqual([120, 110, 100, 90, 80, 70, 70])
  })

  it('applies columns and rows on the same render as each change', () => {
    const { probe, sizes } = sizeProbe()
    const v = mount(probe, 120, 40)

    resizeTo(v, probe, 100, 30)

    expect(sizes.at(-1)).toEqual({ columns: 100, rows: 30, settledColumns: 120 })
    expect(v.lastFrame()).toBe('100x30 settled 120')
  })

  it('leaves settledColumns alone when only the height changes', async () => {
    const { probe, sizes, settled } = sizeProbe()
    const v = mount(probe, 120, 40)

    resizeTo(v, probe, 120, 20)
    await elapse(200)

    expect(sizes.map((s) => s.rows)).toEqual([40, 20])
    expect(settled).toEqual([120])
  })

  it('does not change settledColumns when the width returns to the settled value before settling', async () => {
    const { probe, settled } = sizeProbe()
    const v = mount(probe, 120, 40)

    resizeTo(v, probe, 90, 40)
    await elapse(20)
    resizeTo(v, probe, 120, 40)
    await elapse(200)

    expect(settled).toEqual([120])
  })
})

describe('budgets for the current and the settled width', () => {
  it('computes current from columns and settled from settledColumns with the same function while a width is settling', async () => {
    const budgets: BudgetRecord = []
    const probe = <BudgetProbe record={budgets} />
    const v = mount(probe, 120, 40)

    resizeTo(v, probe, 50, 40)
    const during = budgets.at(-1)
    await elapse(50)

    // 120 columns, left 18: 102 - 3. 50 columns is narrow: 50 - 2.
    expect(during).toEqual({ current: 48, settled: 99 })
    expect(budgets.at(-1)).toEqual({ current: 48, settled: 48 })
  })
})
