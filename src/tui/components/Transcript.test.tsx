import { stripVTControlCharacters } from 'node:util'
import { type ReactNode, type Ref, useRef } from 'react'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptRecord } from '../../engine/index.js'
import { type Frames, renderFrames } from '../../testing/inkFrames.js'
import { type ScriptEvent, type ScriptedRun, scriptedRun } from '../../testing/scriptedRun.js'
import { RunView } from '../engineBridge.js'
import { FRAME_MS } from '../frameRate.js'
import type { LayoutWant } from '../layout.js'
import { SETTLE_MS, SizeProvider, useBudget } from '../size.js'
import { theme } from '../theme.js'
import { TranscriptViewport } from '../viewport.js'
import { Transcript, type TranscriptControls } from './Transcript.js'

// Colors carry the record kinds; force truecolor before Ink (and its chalk) load.
const previousForceColor = vi.hoisted(() => {
  const previous = process.env.FORCE_COLOR
  process.env.FORCE_COLOR = '3'
  return previous
})

afterAll(() => {
  if (previousForceColor === undefined) delete process.env.FORCE_COLOR
  else process.env.FORCE_COLOR = previousForceColor
})

/**
 * A render probe on Ink's `Text`: every line a transcript row draws is
 * one `Text`, so the texts rendered during an update are the rows that
 * re-rendered. Passed through to Ink unchanged.
 */
const probe = vi.hoisted(() => ({ texts: [] as string[] }))
vi.mock('ink', async (importOriginal) => {
  const ink = await importOriginal<typeof import('ink')>()
  const { createElement } = await import('react')
  function Text(props: Parameters<typeof ink.Text>[0]) {
    const { children } = props
    probe.texts.push(typeof children === 'string' ? children : '')
    return createElement(ink.Text, props)
  }
  return { ...ink, Text }
})

const fg = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16)
  return `\x1b[38;2;${(n >> 16) & 0xff};${(n >> 8) & 0xff};${n & 0xff}m`
}

const RUN_ID = '2026-11-08_1120_tdd-review_4f2a'
const RUN_DIR = `/Users/ryowa/Repos/trezor-suite/.rensa/runs/${RUN_ID}`
const T0 = '2026-11-08T11:20:00.000Z'
const STEP = 'implement'
const LABEL = 'impl'
/** `implement` is the longest id: `leftCols` is 9 + 6 = 15 at 100 columns. */
const WANT: LayoutWant = { headerRows: 4, footerRows: 3, leftIdWidth: 9 }

const STARTED: ScriptEvent[] = [
  {
    t: T0,
    type: 'run.started',
    data: {
      chain: 'tdd-review',
      input_kind: 'text',
      base: 'feat/quote-limits',
      base_sha: '3f9c2a1b7e4d5c6a8b9f0e1d2c3b4a5968778695',
      rensa_version: '0.1.0',
    },
  },
  { t: T0, type: 'step.started', step: STEP, data: { kind: 'agent' } },
  {
    t: T0,
    type: 'agent.spawned',
    step: STEP,
    agent: LABEL,
    data: {
      provider: 'claude',
      model: 'opus',
      effort: 'high',
      tools: 'write',
      session_id: 'sess_8f3e21',
      resumed: false,
    },
  },
]

const line = (n: number) => `Record ${String(n).padStart(4, '0')}: the bucket refills`

function textRecord(body: string): TranscriptRecord {
  return { t: T0, kind: 'text', text: body }
}

let view: Frames | undefined
let runView: RunView | undefined

beforeEach(() => {
  // setImmediate stays real: React's scheduler runs passive effects on it.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  probe.texts = []
})

afterEach(() => {
  view?.unmount()
  view = undefined
  runView?.dispose()
  runView = undefined
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const effects = () => new Promise<void>((resolve) => setImmediate(resolve))

async function elapse(ms: number): Promise<void> {
  await effects()
  await vi.advanceTimersByTimeAsync(ms)
  await effects()
}

/** What the run screen does: the pane is `current.transcriptCols` wide, the budget from the same want. */
function Pane(props: {
  view: RunView
  height: number
  expanded?: ReadonlySet<number>
  cursor?: number
  controls?: Ref<TranscriptControls>
}): ReactNode {
  const { current } = useBudget(WANT)
  const empty = useRef<ReadonlySet<number>>(new Set()).current
  return (
    <Transcript
      view={props.view}
      step={STEP}
      label={LABEL}
      height={props.height}
      width={current.transcriptCols}
      expanded={props.expanded ?? empty}
      want={WANT}
      {...(props.cursor !== undefined && { cursor: props.cursor })}
      {...(props.controls !== undefined && { ref: props.controls })}
    />
  )
}

interface Mounted {
  run: ScriptedRun
  frames: Frames
  lines(): string[]
  /** A new terminal width: bounds now, settled after SETTLE_MS. */
  resize(columns: number): void
}

function mount(opts: {
  records?: ReadonlyArray<TranscriptRecord>
  history?: ReadonlyArray<ScriptEvent>
  height?: number
  columns?: number
  expanded?: ReadonlySet<number>
  cursor?: number
  controls?: Ref<TranscriptControls>
}): Mounted {
  const run = scriptedRun({ id: RUN_ID, dir: RUN_DIR, history: opts.history ?? STARTED })
  run.seed(STEP, LABEL, opts.records ?? [])
  const v = new RunView(run.handle, [{ id: STEP, kind: 'agent' }])
  runView = v
  const height = opts.height ?? 20
  const tree = (columns: number) => (
    <SizeProvider columns={columns} rows={40}>
      <Pane
        view={v}
        height={height}
        {...(opts.expanded !== undefined && { expanded: opts.expanded })}
        {...(opts.cursor !== undefined && { cursor: opts.cursor })}
        {...(opts.controls !== undefined && { controls: opts.controls })}
      />
    </SizeProvider>
  )
  const columns = opts.columns ?? 100
  const frames = renderFrames(tree(columns), { columns, rows: 40 })
  view = frames
  return {
    run,
    frames,
    lines: () =>
      stripVTControlCharacters(frames.lastFrame())
        .split('\n')
        .map((l) => l.trimEnd()),
    resize(next) {
      frames.resize(next, 40)
      frames.rerender(tree(next))
    },
  }
}

const recordTexts = () => probe.texts.filter((t) => t.startsWith('Record '))

describe('mounting only the visible rows', () => {
  it('mounts at most 20 rows when a 5000-record buffer is shown at height 20', async () => {
    const records = Array.from({ length: 5000 }, (_, i) => textRecord(line(i)))

    const m = mount({ records, height: 20 })
    await effects()

    expect(recordTexts().length).toBeLessThanOrEqual(20)
    expect(
      m
        .lines()
        .filter((l) => l.startsWith('Record '))
        .at(-1),
    ).toBe(line(4999))
  })

  it('re-renders only the rows that entered when the pane pages down', async () => {
    const controls: { current: TranscriptControls | null } = { current: null }
    const records = Array.from({ length: 100 }, (_, i) => textRecord(line(i)))
    const m = mount({ records, height: 20, controls })
    await effects()
    controls.current?.scroll('top')
    await vi.waitFor(() => expect(m.lines()[0]).toBe(line(0)))
    probe.texts = []

    controls.current?.scroll('pageDown')
    await vi.waitFor(() => expect(m.lines()[0]).toBe(line(10)))

    expect(recordTexts()).toEqual(Array.from({ length: 10 }, (_, i) => line(20 + i)))
  })

  it('re-renders the pane and only the bottom row when one record is appended while following', async () => {
    const records = Array.from({ length: 100 }, (_, i) => textRecord(line(i)))
    const m = mount({ records, height: 20 })
    await effects()
    probe.texts = []

    m.run.record(STEP, LABEL, { kind: 'text', text: line(100) })
    await elapse(FRAME_MS)

    expect(recordTexts()).toEqual([line(100)])
    const shown = m.lines().filter((l) => l.startsWith('Record '))
    expect([shown[0], shown.at(-1)]).toEqual([line(81), line(100)])
  })
})

describe('the wrap width', () => {
  const LONG = `${'Token bucket keyed on the API key header '.repeat(2)}and refilled.`

  it('wraps at transcriptCols 82, not the terminal width, when the terminal is 100 columns and leftCols is 15', async () => {
    const widths: number[] = []
    const visible = TranscriptViewport.prototype.visible
    vi.spyOn(TranscriptViewport.prototype, 'visible').mockImplementation(function (
      this: TranscriptViewport,
      height: number,
    ) {
      widths.push(this.width)
      return visible.call(this, height)
    })

    const m = mount({ records: [textRecord(LONG)], columns: 100 })
    await effects()

    expect(new Set(widths)).toEqual(new Set([82]))
    expect(m.lines().filter((l) => l !== '').length).toBe(2)
  })

  it('sets the wrap width to 57 when the terminal crosses to 59 columns and settles', async () => {
    const m = mount({ records: [textRecord(LONG)], columns: 100 })
    await effects()
    const setWidth = vi.spyOn(TranscriptViewport.prototype, 'setWidth')

    m.resize(59)
    await elapse(SETTLE_MS)

    expect(setWidth.mock.calls.map(([w]) => w)).toEqual([57])
  })

  it('truncates rows without rewrapping when only the bounds have changed', async () => {
    const m = mount({ records: [textRecord(LONG)], columns: 100 })
    await effects()
    const before = m.lines().filter((l) => l !== '')
    const setWidth = vi.spyOn(TranscriptViewport.prototype, 'setWidth')

    m.resize(80)
    await effects()

    // transcriptCols at 80 columns is 80 − 15 − 3 = 62: the 82-wide rows are cut, not rewrapped.
    const after = m.lines().filter((l) => l !== '')
    expect(setWidth).not.toHaveBeenCalled()
    expect(before).toEqual([
      'Token bucket keyed on the API key header Token bucket keyed on the API key header',
      'and refilled.',
    ])
    expect(after).toEqual([`${before[0]?.slice(0, 61)}…`, 'and refilled.'])
  })

  it('rewraps at the settled transcriptCols when the new width has held for SETTLE_MS', async () => {
    const m = mount({ records: [textRecord(LONG)], columns: 100 })
    await effects()
    const setWidth = vi.spyOn(TranscriptViewport.prototype, 'setWidth')

    m.resize(80)
    await elapse(SETTLE_MS)

    expect(setWidth.mock.calls.map(([w]) => w)).toEqual([62])
    expect(m.lines().filter((l) => l !== '')).toEqual([
      'Token bucket keyed on the API key header Token bucket keyed on',
      ' the API key header and refilled.',
    ])
  })
})

describe('record kinds and their colors', () => {
  it('draws a text record in text and the streaming tail in muted', async () => {
    const m = mount({ records: [textRecord('Reading the four new tests.')] })
    await effects()

    m.run.delta(STEP, LABEL, 'Token bucket keyed')
    await elapse(FRAME_MS)

    const frame = m.frames.lastFrame()
    expect(frame).toContain(`${fg(theme.text)}Reading the four new tests.`)
    expect(frame).toContain(`${fg(theme.muted)}Token bucket keyed`)
  })

  it('draws a collapsed tool record as one muted `▸ name summary` line', async () => {
    const records: TranscriptRecord[] = [
      {
        t: T0,
        kind: 'tool',
        name: 'Read',
        input: { file_path: 'src/api/quote.ts' },
        ok: true,
        output: 'export const quoteLimit = 100',
      },
    ]

    const m = mount({ records })
    await effects()

    expect(m.lines().filter((l) => l !== '')).toEqual(['▸ Read src/api/quote.ts'])
    expect(m.frames.lastFrame()).toContain(`${fg(theme.muted)}▸ Read src/api/quote.ts`)
  })

  it('draws the pretty JSON input and the output in dim beneath the header when expanded', async () => {
    const records: TranscriptRecord[] = [
      {
        t: T0,
        kind: 'tool',
        name: 'Read',
        input: { file_path: 'src/api/quote.ts' },
        ok: true,
        output: 'export const quoteLimit = 100',
      },
    ]

    const m = mount({ records, expanded: new Set([0]) })
    await effects()

    expect(m.lines().filter((l) => l !== '')).toEqual([
      '▸ Read src/api/quote.ts',
      '  {',
      '    "file_path": "src/api/quote.ts"',
      '  }',
      '  export const quoteLimit = 100',
    ])
    expect(m.frames.lastFrame()).toContain(`${fg(theme.dim)}  export const quoteLimit = 100`)
  })

  it('draws a note as `» text` in warn', async () => {
    const records: TranscriptRecord[] = [
      { t: T0, kind: 'note', text: 'keep the public API unchanged' },
    ]

    const m = mount({ records })
    await effects()

    expect(m.frames.lastFrame()).toContain(`${fg(theme.warn)}» keep the public API unchanged`)
  })

  it('shows `not started` in dim when the step has not started', async () => {
    const history: ScriptEvent[] = STARTED.slice(0, 1)

    const m = mount({ history })
    await effects()

    expect(m.lines().filter((l) => l !== '')).toEqual(['not started'])
    expect(m.frames.lastFrame()).toContain(`${fg(theme.dim)}not started`)
  })

  it('ends with the error in err and the transcript directory in dim when the agent failed', async () => {
    const history: ScriptEvent[] = [
      ...STARTED,
      {
        t: '2026-11-08T11:20:38.000Z',
        type: 'agent.finished',
        step: STEP,
        agent: LABEL,
        data: {
          status: 'failed',
          exit_code: 1,
          error: { kind: 'exit', message: 'claude exited with code 1' },
        },
      },
    ]

    const m = mount({ history, records: [textRecord('Reading the four new tests.')], columns: 160 })
    await effects()

    const dir = `${RUN_DIR}/agents/${STEP}/${LABEL}`
    expect(m.lines().filter((l) => l !== '')).toEqual([
      'Reading the four new tests.',
      'claude exited with code 1',
      `(transcript: ${dir})`,
    ])
    const frame = m.frames.lastFrame()
    expect(frame).toContain(`${fg(theme.err)}claude exited with code 1`)
    expect(frame).toContain(`${fg(theme.dim)}(transcript: ${dir})`)
  })

  it('highlights the header row of the tool record under the cursor with the selection background', async () => {
    const records: TranscriptRecord[] = [
      textRecord('Reading the four new tests.'),
      {
        t: T0,
        kind: 'tool',
        name: 'Edit',
        input: { file_path: 'src/middleware/ratelimit.ts' },
        ok: true,
        output: '',
      },
    ]

    const m = mount({ records, cursor: 1 })
    await effects()

    const n = Number.parseInt(theme.selection.slice(1), 16)
    const bg = `48;2;${(n >> 16) & 0xff};${(n >> 8) & 0xff};${n & 0xff}`
    const rows = m.frames.lastFrame().split('\n')
    const header = rows.find((r) => stripVTControlCharacters(r).startsWith('▸ Edit'))
    const text = rows.find((r) => stripVTControlCharacters(r).startsWith('Reading'))
    expect(header).toContain(bg)
    expect(text).not.toContain(bg)
  })
})
