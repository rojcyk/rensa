import { stripVTControlCharacters } from 'node:util'
import { Box, Text, useWindowSize } from 'ink'
import { type ReactNode, useMemo } from 'react'
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Frames, renderFrames } from '../../testing/inkFrames.js'
import { layoutBudget } from '../layout.js'
import { SizeProvider, useBudget, useSize } from '../size.js'
import type { Mode } from '../terminalSession.js'
import { Layout, type LayoutProps } from './Layout.js'

let view: Frames | undefined

beforeEach(() => {
  // setImmediate stays real: React's scheduler runs passive effects on it.
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  })
})

afterEach(() => {
  view?.unmount()
  view = undefined
  vi.useRealTimers()
})

const effects = () => new Promise<void>((resolve) => setImmediate(resolve))

async function elapse(ms: number): Promise<void> {
  await effects()
  await vi.advanceTimersByTimeAsync(ms)
  await effects()
}

function linesOf(frame: string): string[] {
  return stripVTControlCharacters(frame).split('\n')
}

/** What app.tsx does: one useWindowSize, published through SizeProvider. */
function Root(props: { children: ReactNode }): ReactNode {
  const { columns, rows } = useWindowSize()
  return (
    <SizeProvider columns={columns} rows={rows}>
      {props.children}
    </SizeProvider>
  )
}

function Lines(props: { lines: string[] }): ReactNode {
  return (
    <Box flexDirection="column">
      {props.lines.map((line) => (
        <Text key={line} wrap="truncate">
          {line}
        </Text>
      ))}
    </Box>
  )
}

const HEADER = <Lines lines={['⎇ feat/quote-limits  ~/Repos/trezor-suite', 'header rule']} />
const FOOTER = <Lines lines={['footer: esc back  ctrl+c quit', 'footer second row']} />

function layoutAt(
  mode: Mode,
  size: { columns: number; rows: number },
  props: Partial<LayoutProps> = {},
): Frames {
  view = renderFrames(
    <Root>
      <Layout
        mode={mode}
        header={HEADER}
        headerRows={2}
        body={<Lines lines={Array.from({ length: 60 }, (_, i) => `body row ${i + 1}`)} />}
        footer={FOOTER}
        footerRows={2}
        {...props}
      />
    </Root>,
    size,
  )
  return view
}

describe('row budgets at different terminal sizes', () => {
  it.each([
    ['normal', 120, 40],
    ['narrow', 50, 24],
    ['very short', 80, 6],
  ])(
    'fills exactly the rows in fullscreen when the terminal is %s (%ix%i)',
    async (_, columns, rows) => {
      const v = layoutAt('fullscreen', { columns, rows })
      await effects()

      expect(linesOf(v.lastFrame())).toHaveLength(rows)
    },
  )

  it.each([
    ['normal', 120, 40],
    ['narrow', 50, 24],
    ['very short', 80, 6],
  ])(
    'takes at most the rows inline when the body is longer than the terminal is %s (%ix%i)',
    async (_, columns, rows) => {
      const v = layoutAt('inline', { columns, rows })
      await effects()

      expect(linesOf(v.lastFrame()).length).toBeLessThanOrEqual(rows)
    },
  )

  it('takes only the rows it needs inline when the content is shorter than the terminal', async () => {
    const v = layoutAt(
      'inline',
      { columns: 120, rows: 40 },
      { body: <Lines lines={['one body row']} /> },
    )
    await effects()

    expect(linesOf(v.lastFrame())).toHaveLength(5)
  })

  it('puts the header in its two rows and the footer in its last two rows in fullscreen at 120x40', async () => {
    const v = layoutAt(
      'fullscreen',
      { columns: 120, rows: 40 },
      {
        body: <Lines lines={['body row 1', 'body row 2']} />,
      },
    )
    await effects()

    const lines = linesOf(v.lastFrame()).map((l) => l.trimEnd())
    expect(lines.slice(0, 4)).toEqual([
      '⎇ feat/quote-limits  ~/Repos/trezor-suite',
      'header rule',
      'body row 1',
      'body row 2',
    ])
    expect(lines.slice(-3)).toEqual(['', 'footer: esc back  ctrl+c quit', 'footer second row'])
  })

  it('collapses header and footer to one row each and gives the body the other six when short at 80x8', async () => {
    const v = layoutAt(
      'fullscreen',
      { columns: 80, rows: 8 },
      {
        header: <Text>{'⎇ feat/quote-limits  ~/Repos/trezor-suite'}</Text>,
        footer: <Text>{'footer: esc back  ctrl+c quit'}</Text>,
        body: <Lines lines={Array.from({ length: 6 }, (_, i) => `body row ${i + 1}`)} />,
      },
    )
    await effects()

    const lines = linesOf(v.lastFrame()).map((l) => l.trimEnd())
    expect(lines).toEqual([
      '⎇ feat/quote-limits  ~/Repos/trezor-suite',
      'body row 1',
      'body row 2',
      'body row 3',
      'body row 4',
      'body row 5',
      'body row 6',
      'footer: esc back  ctrl+c quit',
    ])
  })
})

describe('clipping content taller than its slot', () => {
  it('shows the first 36 body rows and then the footer when the body has 60 rows at 120x40', async () => {
    const v = layoutAt('fullscreen', { columns: 120, rows: 40 })
    await effects()

    const lines = linesOf(v.lastFrame()).map((l) => l.trimEnd())
    expect(lines.slice(2)).toEqual([
      ...Array.from({ length: 36 }, (_, i) => `body row ${i + 1}`),
      'footer: esc back  ctrl+c quit',
      'footer second row',
    ])
  })

  it('shows the first two header lines and the first body row when the header has three lines and a budget of two', async () => {
    const v = layoutAt(
      'fullscreen',
      { columns: 120, rows: 40 },
      {
        header: <Lines lines={['header one', 'header two', 'header three']} />,
        body: <Lines lines={['body row 1']} />,
      },
    )
    await effects()

    const lines = linesOf(v.lastFrame()).map((l) => l.trimEnd())
    expect(lines.slice(0, 3)).toEqual(['header one', 'header two', 'body row 1'])
  })

  it('shows only the first header line and the first footer line when short collapses two-line slots to one row at 80x8', async () => {
    const v = layoutAt(
      'fullscreen',
      { columns: 80, rows: 8 },
      {
        body: <Lines lines={['body row 1']} />,
      },
    )
    await effects()

    const lines = linesOf(v.lastFrame()).map((l) => l.trimEnd())
    expect([lines[0], lines[7]]).toEqual([
      '⎇ feat/quote-limits  ~/Repos/trezor-suite',
      'footer: esc back  ctrl+c quit',
    ])
  })
})

describe('the status-only body in short mode', () => {
  it('shows only the status line in the body when short leaves fewer than 3 body rows', async () => {
    const v = layoutAt(
      'fullscreen',
      { columns: 80, rows: 4 },
      {
        header: <Text>{'⎇ feat/quote-limits  ~/Repos/trezor-suite'}</Text>,
        footer: <Text>{'footer: esc back  ctrl+c quit'}</Text>,
        status: <Text>step 3/6 implement running</Text>,
      },
    )
    await effects()

    const lines = linesOf(v.lastFrame()).map((l) => l.trimEnd())
    expect(lines).toEqual([
      '⎇ feat/quote-limits  ~/Repos/trezor-suite',
      'step 3/6 implement running',
      '',
      'footer: esc back  ctrl+c quit',
    ])
  })

  it('shows the body, not the status line, when short leaves 3 body rows', async () => {
    const v = layoutAt(
      'fullscreen',
      { columns: 80, rows: 5 },
      {
        header: <Text>{'⎇ feat/quote-limits  ~/Repos/trezor-suite'}</Text>,
        footer: <Text>{'footer: esc back  ctrl+c quit'}</Text>,
        body: <Lines lines={['body row 1', 'body row 2', 'body row 3']} />,
        status: <Text>step 3/6 implement running</Text>,
      },
    )
    await effects()

    const lines = linesOf(v.lastFrame()).map((l) => l.trimEnd())
    expect(lines.slice(1, 4)).toEqual(['body row 1', 'body row 2', 'body row 3'])
  })
})

const LONG_ID = 'implement-the-quote-limits-validation-and-its-tests-for-trezor-suite'

describe('two-column body', () => {
  it('truncates a step id longer than the left budget with … and keeps the right column at its width', async () => {
    const columns = 120
    const v = layoutAt(
      'fullscreen',
      { columns, rows: 20 },
      {
        split: {
          left: <Text wrap="truncate-end">{LONG_ID}</Text>,
          leftIdWidth: LONG_ID.length,
        },
        body: <Text wrap="truncate">{'x'.repeat(200)}</Text>,
      },
    )
    await effects()

    const budget = layoutBudget(
      { columns, rows: 20 },
      {
        headerRows: 2,
        footerRows: 2,
        leftIdWidth: LONG_ID.length,
      },
    )
    const line = linesOf(v.lastFrame())[2]
    assert(line !== undefined, 'the first body row is drawn')
    expect(budget.leftCols).toBe(42)
    expect(line.slice(0, budget.leftCols)).toBe(`${LONG_ID.slice(0, budget.leftCols - 1)}…`)
    expect(line[budget.leftCols]).toBe('│')
    expect(line.slice(budget.leftCols + 3).trimEnd()).toHaveLength(budget.transcriptCols)
  })

  it('gives the body a content width of transcriptCols when split at 100 columns', async () => {
    const columns = 100
    const v = layoutAt(
      'fullscreen',
      { columns, rows: 20 },
      {
        split: { left: <Text>implement</Text>, leftIdWidth: 9 },
        body: <Text wrap="truncate">{'x'.repeat(200)}</Text>,
      },
    )
    await effects()

    const { transcriptCols } = layoutBudget(
      { columns, rows: 20 },
      {
        headerRows: 2,
        footerRows: 2,
        leftIdWidth: 9,
      },
    )
    const bodyCells = (linesOf(v.lastFrame())[2] ?? '').match(/x+…/)?.[0]
    expect(bodyCells).toHaveLength(transcriptCols)
  })

  it('drops the left column, shows the strip, and gives the body a content width of transcriptCols when narrow at 50 columns', async () => {
    const columns = 50
    const v = layoutAt(
      'fullscreen',
      { columns, rows: 20 },
      {
        split: {
          left: <Text>left column content</Text>,
          leftIdWidth: 9,
          strip: <Text>step 3/6 implement</Text>,
        },
        body: <Text wrap="truncate">{'x'.repeat(200)}</Text>,
      },
    )
    await effects()

    const { transcriptCols } = layoutBudget(
      { columns, rows: 20 },
      {
        headerRows: 2,
        footerRows: 2,
        leftIdWidth: 9,
      },
    )
    const lines = linesOf(v.lastFrame())
    expect(lines[2]?.trimEnd()).toBe('step 3/6 implement')
    expect(lines[3]).toBe(`  ${'x'.repeat(transcriptCols - 1)}…`)
    expect(lines.join('\n')).not.toContain('left column content')
  })
})

const WANT = { headerRows: 2, footerRows: 0, leftIdWidth: 30 }
const PARAGRAPH =
  'The validator now rejects quotes above the configured limit and reports the limit in the error message, ' +
  'so the send form can show it next to the amount field. Tests cover the boundary, one unit above it, ' +
  'and a missing limit, which falls back to the network default.'

/** Greedy word wrap at `width` columns. */
function wrapAt(text: string, width: number): string[] {
  const rows: string[] = []
  let row = ''
  for (const word of text.split(' ')) {
    if (row === '') row = word
    else if (row.length + 1 + word.length <= width) row += ` ${word}`
    else {
      rows.push(row)
      row = word
    }
  }
  if (row !== '') rows.push(row)
  return rows
}

interface TranscriptRecord {
  /** Each distinct set of pre-wrapped rows the body rendered. */
  wrapped: string[][]
  /** Each settledColumns value, once per change. */
  settled: number[]
}

/** A step-14-like body: rows wrapped at the settled width, each truncated to the current one. */
function Transcript(props: { record: TranscriptRecord }): ReactNode {
  const { wrapped, settled } = props.record
  const { settled: budget } = useBudget(WANT)
  const { settledColumns } = useSize()
  if (settled.at(-1) !== settledColumns) settled.push(settledColumns)
  const rows = useMemo(() => wrapAt(PARAGRAPH, budget.transcriptCols), [budget.transcriptCols])
  if (wrapped.at(-1) !== rows) wrapped.push(rows)
  return (
    <Box flexDirection="column">
      {rows.map((row) => (
        <Box key={row} overflow="hidden">
          <Text wrap="truncate">{row}</Text>
        </Box>
      ))}
    </Box>
  )
}

describe('a live resize of a two-column body', () => {
  function probes() {
    const record: TranscriptRecord = { wrapped: [], settled: [] }
    return { transcript: <Transcript record={record} />, ...record }
  }

  function mount(transcript: ReactNode): Frames {
    view = renderFrames(
      <Root>
        <Layout
          mode="fullscreen"
          header={<Lines lines={['⎇ main  ~/Repos/rensa', 'rule']} />}
          headerRows={2}
          split={{ left: <Text wrap="truncate-end">{'a'.repeat(30)}</Text>, leftIdWidth: 30 }}
          body={transcript}
        />
      </Root>,
      { columns: 120, rows: 40 },
    )
    return view
  }

  /** The body cells of each body row of a frame: after the left column and the gutter. */
  function bodyCells(frame: string, leftCols: number, rowCount: number): string[] {
    return linesOf(frame)
      .slice(2, 2 + rowCount)
      .map((line) => line.slice(leftCols + 3).trimEnd())
  }

  async function resize(v: Frames, columns: number, rows: number): Promise<string> {
    const before = v.frames.length
    v.resize(columns, rows)
    await effects()
    const next = v.frames[before]
    assert(next !== undefined, 'a frame follows the resize')
    return next
  }

  it('narrows the bounds on the very next frame, keeps the pre-wrapped rows truncated, and rewraps once 50 ms later when shrunk from 120 to 60 columns', async () => {
    const { transcript, wrapped, settled } = probes()
    const v = mount(transcript)
    await effects()
    const wide = layoutBudget({ columns: 120, rows: 40 }, WANT)
    const narrow = layoutBudget({ columns: 60, rows: 40 }, WANT)
    const rowsAt120 = wrapped.at(-1)
    assert(rowsAt120, 'the transcript rendered')

    const next = await resize(v, 60, 40)

    expect(narrow.leftCols).toBeLessThan(wide.leftCols)
    expect(linesOf(next)[2]?.[narrow.leftCols]).toBe('│')
    expect(wrapped.at(-1)).toBe(rowsAt120)
    expect(bodyCells(next, narrow.leftCols, rowsAt120.length)).toEqual(
      rowsAt120.map((row) =>
        row.length <= narrow.transcriptCols ? row : expect.stringMatching(/…$/),
      ),
    )
    expect(
      bodyCells(next, narrow.leftCols, rowsAt120.length).every(
        (cells, i) =>
          cells.length <= narrow.transcriptCols &&
          rowsAt120[i]?.startsWith(cells.replace(/…$/, '')) === true,
      ),
    ).toBe(true)

    await elapse(49)
    expect(settled).toEqual([120])
    await elapse(1)

    expect(settled).toEqual([120, 60])
    expect(wrapped.at(-1)).toEqual(wrapAt(PARAGRAPH, narrow.transcriptCols))
  })

  it('widens the bounds on the very next frame and rewraps once 50 ms later when grown back from 60 to 120 columns', async () => {
    const { transcript, wrapped, settled } = probes()
    const v = mount(transcript)
    await effects()
    await resize(v, 60, 40)
    await elapse(50)
    const wide = layoutBudget({ columns: 120, rows: 40 }, WANT)
    const narrow = layoutBudget({ columns: 60, rows: 40 }, WANT)
    const rowsAt60 = wrapped.at(-1)
    assert(rowsAt60, 'the transcript rewrapped at 60 columns')

    const next = await resize(v, 120, 40)

    expect(linesOf(next)[2]?.[wide.leftCols]).toBe('│')
    expect(wrapped.at(-1)).toBe(rowsAt60)
    expect(bodyCells(next, wide.leftCols, rowsAt60.length)).toEqual(rowsAt60)

    await elapse(50)

    expect(settled).toEqual([120, 60, 120])
    expect(wrapped.at(-1)).toEqual(wrapAt(PARAGRAPH, wide.transcriptCols))
    expect(narrow.transcriptCols).toBeLessThan(wide.transcriptCols)
  })

  it('never changes settledColumns and fills the new rows when only the height changes from 40 to 20', async () => {
    const { transcript, wrapped, settled } = probes()
    const v = mount(transcript)
    await effects()
    const rowsBefore = wrapped.at(-1)

    const next = await resize(v, 120, 20)
    await elapse(200)

    expect(linesOf(next)).toHaveLength(20)
    expect(settled).toEqual([120])
    expect(wrapped.at(-1)).toBe(rowsBefore)
  })
})
