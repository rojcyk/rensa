import { performance } from 'node:perf_hooks'
import stringWidth from 'string-width'
import { assert, describe, expect, it } from 'vitest'
import { RingBuffer, type TranscriptRecord } from '../engine/index.js'
import { ELLIPSIS } from './format.js'
import {
  EXPAND_INDENT,
  normalize,
  recordText,
  TranscriptViewport,
  type VisibleRow,
} from './viewport.js'

// --- fixtures --------------------------------------------------------------

const T = '2026-11-08T11:20:00.000Z'
const INDENT = ' '.repeat(EXPAND_INDENT)

function text(body: string): TranscriptRecord {
  return { t: T, kind: 'text', text: body }
}

function note(body: string): TranscriptRecord {
  return { t: T, kind: 'note', text: body }
}

function tool(name: string, input: unknown, output: string): TranscriptRecord {
  return { t: T, kind: 'tool', name, input, ok: true, output }
}

function bufferOf(records: ReadonlyArray<TranscriptRecord>, capacity = 5000) {
  const buffer = new RingBuffer<TranscriptRecord>(capacity)
  for (const record of records) buffer.push(record)
  return buffer
}

function viewportOf(records: ReadonlyArray<TranscriptRecord>, width: number, capacity = 5000) {
  const buffer = bufferOf(records, capacity)
  const viewport = new TranscriptViewport(buffer, { width, capacity: buffer.capacity })
  return { buffer, viewport }
}

/** Every line, top to bottom, with the viewport following (the window then starts at 0). */
function allLines(viewport: TranscriptViewport): string[] {
  return viewport.visible(viewport.totalLines()).flatMap((row) => row.lines)
}

/** One line per record, 1 line each at any width ≥ 8: `Entry 00`, `Entry 01`, … */
function entries(from: number, count: number): TranscriptRecord[] {
  return Array.from({ length: count }, (_, i) => text(`Entry ${String(from + i).padStart(2, '0')}`))
}

const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789'

/**
 * Checks that `rows` are the rows of `text` (already normalized): each
 * logical line is cut into non-empty rows whose concatenation is the line,
 * and an empty logical line is exactly one empty row. Returns the problems.
 */
function partitionProblems(rows: ReadonlyArray<string>, body: string): string[] {
  const problems: string[] = []
  let at = 0
  for (const [n, line] of body.split('\n').entries()) {
    if (line === '') {
      if (rows[at] !== '') problems.push(`logical line ${n} is empty but row ${at} is ${rows[at]}`)
      at++
      continue
    }
    let joined = ''
    while (joined.length < line.length && at < rows.length) {
      const row = rows[at++] ?? ''
      if (row === '') problems.push(`row ${at - 1} is empty inside logical line ${n}`)
      joined += row
    }
    if (joined !== line) problems.push(`logical line ${n}: rows give ${joined}, text is ${line}`)
  }
  if (at !== rows.length) problems.push(`${rows.length - at} rows past the end of the text`)
  return problems
}

// --- normalization and the width policy ------------------------------------

describe('normalizing transcript text for measuring and display', () => {
  it('expands a tab to the next 8-column stop when text precedes it', () => {
    expect(normalize('a\tb')).toBe(`a${' '.repeat(7)}b`)
  })

  it('expands a tab to a full 8 columns when the text before it ends on a stop', () => {
    expect(normalize('abcdefgh\tx')).toBe(`abcdefgh${' '.repeat(8)}x`)
  })

  it('counts wide characters as two columns when placing a tab stop', () => {
    expect(normalize('日本\tx')).toBe(`日本${' '.repeat(4)}x`)
  })

  it('restarts the tab stops on each line when the text has several lines', () => {
    expect(normalize('ab\ncd\te\t\tz')).toBe(
      `ab\ncd${' '.repeat(6)}e${' '.repeat(7)}${' '.repeat(8)}z`,
    )
  })

  it('drops carriage returns when a line ends in CRLF or rewrites itself with \\r', () => {
    expect(normalize('progress 10%\rprogress 100%\r\ndone')).toBe('progress 10%progress 100%\ndone')
  })

  it('keeps blank lines and a trailing newline when the text has them', () => {
    expect(normalize('first\n\nthird\n')).toBe('first\n\nthird\n')
  })

  it('composes a combining mark with its base when the text is decomposed', () => {
    expect(normalize('Café au lait')).toBe('Café au lait')
  })

  it('strips ANSI colour sequences when shell output carries them', () => {
    expect(normalize('\x1b[31mFAIL\x1b[0m src/api/quote.test.ts')).toBe(
      'FAIL src/api/quote.test.ts',
    )
  })
})

describe('wrapping records at the viewport width', () => {
  it('cuts CJK between characters into rows of at most the width when there are no spaces', () => {
    const { viewport } = viewportOf([text('日本語のテキストです')], 8)

    expect(allLines(viewport)).toEqual(['日本語の', 'テキスト', 'です'])
    expect(viewport.totalLines()).toBe(3)
  })

  it('keeps a combining mark on the row of its base when the row is full', () => {
    const { viewport } = viewportOf([text('abx́yz')], 3)

    expect(allLines(viewport)).toEqual(['abx́', 'yz'])
    expect(viewport.totalLines()).toBe(2)
  })

  it('measures a decomposed é as one cell when wrapping', () => {
    const { viewport } = viewportOf([text('Café au lait')], 6)

    expect(allLines(viewport)).toEqual(['Café ', 'au ', 'lait'])
    expect(viewport.totalLines()).toBe(3)
  })

  it('keeps ZWJ, flag and skin-tone sequences whole and counts each as two cells', () => {
    const { viewport } = viewportOf([text('👨‍👩‍👧🇯🇵👍🏽')], 4)

    expect(allLines(viewport)).toEqual(['👨‍👩‍👧🇯🇵', '👍🏽'])
    expect(viewport.totalLines()).toBe(2)
  })

  it('wraps tab-expanded text at the width when tabs push it past the edge', () => {
    const { viewport } = viewportOf([text('key\tvalue\tnote')], 12)

    // `key` + 5 spaces, `value` + 3 spaces, `note`: 20 cells.
    expect(allLines(viewport)).toEqual(['key     ', 'value   note'])
    expect(viewport.totalLines()).toBe(2)
  })

  it('shows blank lines and a trailing newline as empty rows when a record has them', () => {
    const { viewport } = viewportOf([text('first\n\nthird\n')], 20)

    expect(allLines(viewport)).toEqual(['first', '', 'third', ''])
    expect(viewport.totalLines()).toBe(4)
  })

  it('hard-wraps a word longer than the width when it stands alone', () => {
    const { viewport } = viewportOf([text('supercalifragilistic')], 8)

    expect(allLines(viewport)).toEqual(['supercal', 'ifragili', 'stic'])
    expect(viewport.totalLines()).toBe(3)
  })

  it('hard-wraps a long word after a short one when both share the first row', () => {
    const { viewport } = viewportOf([text('go supercalifragilistic')], 8)

    expect(allLines(viewport)).toEqual(['go super', 'califrag', 'ilistic'])
    expect(viewport.totalLines()).toBe(3)
  })

  it('draws a note as `» text` when the record is a note', () => {
    const { viewport } = viewportOf([note('keep the public API unchanged')], 40)

    expect(allLines(viewport)).toEqual(['» keep the public API unchanged'])
  })

  it('never puts an escape byte in a row when the text carries ANSI colour', () => {
    const { viewport } = viewportOf([text('\x1b[1m\x1b[32mPASS\x1b[39m\x1b[22m 12 tests')], 6)

    const lines = allLines(viewport)

    expect(lines).toEqual(['PASS ', '12 ', 'tests'])
    expect(lines.join('')).not.toContain('\x1b')
  })
})

describe('collapsed and expanded tool records', () => {
  const READ = tool(
    'Read',
    { file_path: 'src/api/quote.ts', limit: 40 },
    'export const quoteLimit = 100',
  )

  it('shows one `▸ name summary` line from the first string field when collapsed', () => {
    const { viewport } = viewportOf([READ], 40)

    expect(allLines(viewport)).toEqual(['▸ Read src/api/quote.ts'])
    expect(viewport.totalLines()).toBe(1)
  })

  it('adds the pretty JSON input and the output beneath, indented, when expanded', () => {
    const { viewport } = viewportOf([READ], 40)

    viewport.setExpanded(0, true)

    expect(allLines(viewport)).toEqual([
      '▸ Read src/api/quote.ts',
      '  {',
      '    "file_path": "src/api/quote.ts",',
      '    "limit": 40',
      '  }',
      '  export const quoteLimit = 100',
    ])
    expect(viewport.totalLines()).toBe(6)
  })

  it('wraps the body at width − EXPAND_INDENT so indented rows fit the width when expanded', () => {
    const width = 20
    const { viewport } = viewportOf([READ], width)

    viewport.setExpanded(0, true)
    const lines = allLines(viewport)

    expect(lines.slice(1).every((l) => l.startsWith(INDENT))).toBe(true)
    expect(lines.filter((l) => stringWidth(l) > width)).toEqual([])
    expect(
      partitionProblems(
        lines.slice(1).map((l) => l.slice(EXPAND_INDENT)),
        recordText(READ, true).split('\n').slice(1).join('\n'),
      ),
    ).toEqual([])
  })

  it('truncates the header with … to the width when the summary is longer than the pane', () => {
    const width = 16
    const { viewport } = viewportOf([READ], width)

    const [header] = allLines(viewport)

    expect(header).toBe(`▸ Read src/api/${ELLIPSIS}`)
    expect(stringWidth(header ?? '')).toBeLessThanOrEqual(width)
  })

  it('returns to one line and the old total when a record is collapsed again', () => {
    const { viewport } = viewportOf([READ], 40)
    viewport.setExpanded(0, true)

    viewport.setExpanded(0, false)

    expect(allLines(viewport)).toEqual(['▸ Read src/api/quote.ts'])
    expect(viewport.totalLines()).toBe(1)
  })

  it('ignores an expansion request when the record is not a tool', () => {
    const { viewport } = viewportOf([text('The coupon is applied after tax.')], 40)

    viewport.setExpanded(0, true)

    expect(allLines(viewport)).toEqual(['The coupon is applied after tax.'])
  })
})

describe('trailer rows after a failed agent', () => {
  it('appends the error then the transcript path after the records and the tail', () => {
    const { viewport } = viewportOf([text('Reading the tests.')], 30)
    viewport.setPartial('Then I')

    viewport.setTrailer([
      { kind: 'error', text: 'claude exited with code 1' },
      { kind: 'info', text: '(transcript: .rensa/runs/4f2a/agents/implement/impl)' },
    ])
    const rows = viewport.visible(viewport.totalLines())

    expect(rows.map((r) => [r.kind, r.lines])).toEqual([
      ['text', ['Reading the tests.']],
      ['partial', ['Then I']],
      ['error', ['claude exited with code 1']],
      ['info', ['(transcript: .rensa/runs/4f2a/', 'agents/implement/impl)']],
    ])
    expect(viewport.totalLines()).toBe(5)
  })
})

// --- reachability ----------------------------------------------------------

const EXPANDED_TOOL = 152

function mixedFixture(): TranscriptRecord[] {
  const records: TranscriptRecord[] = []
  for (let i = 0; i < 300; i++) {
    switch (i % 7) {
      case 0:
        records.push(
          text(`Step ${i}: the limiter ${'ratelimit'.repeat(3 + (i % 9))} keyed on the API key.`),
        )
        break
      case 1:
        records.push(
          text(
            `見積もりのレート制限は${i}番目のウィンドウで適用されます。トークンバケットはキーごとです。`,
          ),
        )
        break
      case 2:
        records.push(text(`Deploy ${i} 👨‍👩‍👧 done 🇯🇵 ok 👍🏽👍🏿 ${'🎉'.repeat(i % 13)} café x`))
        break
      case 3:
        records.push(text(`Paragraph ${i}\n\n\nafter two blank lines\n`))
        break
      case 4:
        records.push(note(`Focus on the rounding in total() for case ${i}`))
        break
      case 5:
        records.push(
          tool(
            'Bash',
            { command: `npx vitest run src/api/quote-${i}.ratelimit.test.ts --reporter verbose` },
            `✓ quote ${i} › refills the bucket every second\n\tindented ${'detail'.repeat(5)}\n`,
          ),
        )
        break
      default:
        records.push(text(`col1\tcol2\tcol3 ${i}\r\nnext line 日本語`))
    }
  }
  return records
}

describe('every record is reachable by paging from top to bottom', () => {
  it.each([20, 37, 57, 80])(
    'yields each record’s normalized text from its visible rows at width %i',
    (width) => {
      const records = mixedFixture()
      assert(records[EXPANDED_TOOL]?.kind === 'tool', 'the expanded record is a tool record')
      const { viewport } = viewportOf(records, width)
      viewport.setExpanded(EXPANDED_TOOL, true)
      const height = 9
      viewport.visible(height)
      viewport.scrollTo('top')

      const seen = new Map<number, string[]>()
      const tooWide: string[] = []
      const pages = Math.ceil(viewport.totalLines() / height) + 1
      for (let page = 0; page < pages; page++) {
        for (const row of viewport.visible(height)) {
          const lines = seen.get(row.record) ?? []
          for (const [i, line] of row.lines.entries()) {
            lines[row.firstLine + i] = line
            if (stringWidth(line) > width) tooWide.push(line)
          }
          seen.set(row.record, lines)
        }
        viewport.scrollBy(height)
      }

      const problems: string[] = []
      for (const [index, record] of records.entries()) {
        const rows = seen.get(index) ?? []
        if (rows.length === 0 || rows.includes(undefined as unknown as string)) {
          problems.push(`record ${index}: not every row was seen`)
          continue
        }
        if (record.kind !== 'tool') {
          for (const p of partitionProblems(rows, recordText(record, false))) {
            problems.push(`record ${index}: ${p}`)
          }
          continue
        }
        const expanded = index === EXPANDED_TOOL
        const [headerText = '', ...bodyText] = recordText(record, expanded).split('\n')
        const [header = '', ...body] = rows
        const headerFits = stringWidth(headerText) <= width
        if (headerFits ? header !== headerText : !headerText.startsWith(header.slice(0, -1))) {
          problems.push(`record ${index}: header ${header} is not ${headerText}`)
        }
        if (!headerFits && !header.endsWith(ELLIPSIS)) {
          problems.push(`record ${index}: cut header ${header} has no ellipsis`)
        }
        if (!expanded) {
          if (body.length > 0) problems.push(`record ${index}: collapsed but has a body`)
          continue
        }
        if (body.some((l) => !l.startsWith(INDENT))) {
          problems.push(`record ${index}: a body row is not indented`)
        }
        for (const p of partitionProblems(
          body.map((l) => l.slice(EXPAND_INDENT)),
          bodyText.join('\n'),
        )) {
          problems.push(`record ${index}: body ${p}`)
        }
      }

      expect(problems).toEqual([])
      expect(tooWide).toEqual([])
    },
  )
})

// --- the logical anchor ----------------------------------------------------

describe('keeping the reading position', () => {
  it('keeps the same grapheme on the top line when the width changes', () => {
    const long = ALNUM.repeat(5)
    const { viewport } = viewportOf([text('Intro.'), text(long)], 10)
    viewport.visible(4)
    viewport.scrollTo('top')
    // Line 0 is the intro; line 9 is the long record's row 8, starting at grapheme 80.
    viewport.scrollBy(9)
    const before = viewport.visible(4)[0]
    assert(before, 'a top row before the width change')
    expect([before.record, before.firstLine, before.lines[0]]).toEqual([1, 8, long.slice(80, 90)])

    viewport.setWidth(7)
    const after = viewport.visible(4)[0]

    // At width 7 grapheme 80 is on row 11, which starts at grapheme 77.
    expect([after?.record, after?.firstLine, after?.lines[0]]).toEqual([1, 11, long.slice(77, 84)])
  })

  it('keeps the top line when a tool record above it is expanded', () => {
    const long = ALNUM.repeat(3)
    const records = [
      text('Reading the four new tests.'),
      tool('Read', { file_path: 'src/api/quote.ts' }, 'export const quoteLimit = 100'),
      text(long),
    ]
    const { viewport } = viewportOf(records, 10)
    viewport.visible(4)
    viewport.scrollTo('top')
    viewport.scrollBy(3 + 1 + 5)
    const before = viewport.visible(4)[0]
    const totalBefore = viewport.totalLines()

    viewport.setExpanded(1, true)
    const after = viewport.visible(4)[0]

    expect(viewport.totalLines()).toBeGreaterThan(totalBefore)
    expect(after).toEqual(before)
    expect([after?.record, after?.firstLine, after?.lines[0]]).toEqual([2, 5, long.slice(50, 60)])
  })

  it('clamps to the earliest retained record when the anchored record is evicted', () => {
    const { buffer, viewport } = viewportOf(entries(0, 10), 40, 10)
    viewport.visible(4)
    viewport.scrollTo('top')
    viewport.scrollBy(3)
    expect(viewport.visible(4)[0]?.record).toBe(3)

    for (const record of entries(10, 5)) buffer.push(record)
    viewport.sync()

    expect(viewport.anchor).toEqual({ record: buffer.start, offset: 0 })
    expect(viewport.visible(4).map((r) => r.lines[0])).toEqual([
      'Entry 05',
      'Entry 06',
      'Entry 07',
      'Entry 08',
    ])
  })

  it('stays on the anchored record when only records above it are evicted', () => {
    const { buffer, viewport } = viewportOf(entries(0, 10), 40, 10)
    viewport.visible(4)
    viewport.scrollTo('top')
    viewport.scrollBy(6)

    for (const record of entries(10, 3)) buffer.push(record)
    viewport.sync()

    expect(viewport.visible(4).map((r) => r.lines[0])).toEqual([
      'Entry 06',
      'Entry 07',
      'Entry 08',
      'Entry 09',
    ])
  })
})

// --- follow mode -----------------------------------------------------------

describe('follow mode', () => {
  it('starts following and shows the last lines when first drawn', () => {
    const { viewport } = viewportOf(entries(0, 10), 40)

    expect(viewport.following).toBe(true)
    expect(viewport.visible(3).map((r) => r.record)).toEqual([7, 8, 9])
  })

  it('detaches and moves up one line when scrolled by −1', () => {
    const { viewport } = viewportOf(entries(0, 10), 40)
    viewport.visible(3)

    viewport.scrollBy(-1)

    expect(viewport.following).toBe(false)
    expect(viewport.visible(3).map((r) => r.record)).toEqual([6, 7, 8])
  })

  it('keeps the window still when records arrive while detached', () => {
    const { buffer, viewport } = viewportOf(entries(0, 10), 40)
    viewport.visible(3)
    viewport.scrollBy(-1)

    for (const record of entries(10, 4)) buffer.push(record)
    viewport.sync()

    expect(viewport.visible(3).map((r) => r.record)).toEqual([6, 7, 8])
  })

  it('reattaches to the bottom, new records included, when follow() is called', () => {
    const { buffer, viewport } = viewportOf(entries(0, 10), 40)
    viewport.visible(3)
    viewport.scrollBy(-1)
    for (const record of entries(10, 2)) buffer.push(record)
    viewport.sync()

    viewport.follow()

    expect(viewport.following).toBe(true)
    expect(viewport.visible(3).map((r) => r.record)).toEqual([9, 10, 11])
  })

  it('detaches at the first line when scrolled to the top', () => {
    const { viewport } = viewportOf(entries(0, 10), 40)
    viewport.visible(3)

    viewport.scrollTo('top')

    expect(viewport.following).toBe(false)
    expect(viewport.visible(3).map((r) => r.record)).toEqual([0, 1, 2])
  })

  it('reattaches when scrolled to the bottom', () => {
    const { buffer, viewport } = viewportOf(entries(0, 10), 40)
    viewport.visible(3)
    viewport.scrollTo('top')

    viewport.scrollTo('bottom')
    buffer.push(text('Entry 10'))
    viewport.sync()

    expect(viewport.following).toBe(true)
    expect(viewport.visible(3).map((r) => r.record)).toEqual([8, 9, 10])
  })

  it('follows the growing tail when following and a partial arrives', () => {
    const { buffer, viewport } = viewportOf(entries(0, 10), 40)

    viewport.setPartial('Token bucket keyed')
    const rows = viewport.visible(2)

    expect(rows.map((r) => [r.record, r.kind, r.lines])).toEqual([
      [9, 'text', ['Entry 09']],
      [buffer.length, 'partial', ['Token bucket keyed']],
    ])
  })
})

// --- the streaming tail ----------------------------------------------------

const LINE_1 = 'Reading the four new tests in quote.ratelimit.test.ts to understand the window.'
const LINE_2 = 'The token bucket is keyed on the API key header and refills every second.'
const LINE_3 = 'Next I will edit src/middleware/ratelimit.ts to add the limiter and its tests.'

describe('the streaming tail', () => {
  it('rewraps only the growing last line per update when 200 deltas build three lines', () => {
    const full = `${LINE_1}\n${LINE_2}\n${LINE_3}`
    const width = 23
    const { viewport } = viewportOf([], width)
    const updates = 200
    const cuts = Array.from({ length: updates }, (_, k) =>
      Math.round(((k + 1) * full.length) / updates),
    )

    const unexpected: string[] = []
    let shown = 0
    for (const cut of cuts) {
      const delta = full.slice(shown, cut)
      const before = viewport.stats.wraps
      viewport.setPartial(full.slice(0, cut))
      const wraps = viewport.stats.wraps - before
      const completed = delta.split('\n').length - 1
      if (wraps !== 1 + completed) unexpected.push(`at ${cut}: ${wraps} wraps for ${completed} \\n`)
      shown = cut
    }
    const rows = viewport.visible(viewport.totalLines())

    expect(unexpected).toEqual([])
    expect(rows.map((r) => r.kind)).toEqual(['partial'])
    expect(partitionProblems(rows[0]?.lines ?? [], full)).toEqual([])
    expect((rows[0]?.lines ?? []).filter((l) => stringWidth(l) > width)).toEqual([])
  })

  it('stays correct and costs one rewrap per update when a 100 KB tail has no newline', async ({
    annotate,
  }) => {
    const width = 57
    // ASCII words: wide and emoji graphemes are covered above; here the length is the point.
    const words = ['token', 'bucket', 'refill', 'window', 'header', 'limiter', 'keyed', 'quote']
    let full = ''
    for (let i = 0; full.length < 100 * 1024; i++) full += `${words[i % words.length]} `
    const { viewport } = viewportOf([], width)

    const problems: string[] = []
    const started = performance.now()
    for (let k = 1; k <= 50; k++) {
      const shown = full.slice(0, Math.round((k * full.length) / 50))
      const before = viewport.stats.wraps
      viewport.setPartial(shown)
      const wraps = viewport.stats.wraps - before
      if (wraps !== 1) problems.push(`update ${k}: ${wraps} wraps`)
      const lines = allLines(viewport)
      if (lines.length !== viewport.totalLines()) problems.push(`update ${k}: line count`)
      for (const p of partitionProblems(lines, shown)) problems.push(`update ${k}: ${p}`)
      if (lines.some((l) => stringWidth(l) > width)) problems.push(`update ${k}: a row is too wide`)
    }
    await annotate(
      `50 updates of a ${full.length}-char tail: ${(performance.now() - started).toFixed(0)} ms`,
    )

    expect(problems).toEqual([])
  })

  it('joins a combining mark to its base when it arrives in a later update', () => {
    const { viewport } = viewportOf([], 5)
    viewport.setPartial('abcde')

    viewport.setPartial('abcdé')

    expect(allLines(viewport)).toEqual(['abcdé'])
  })

  it('moves an emoji to the next row when a variation selector widens it in a later update', () => {
    const { viewport } = viewportOf([], 4)
    viewport.setPartial('abc❤')
    expect(allLines(viewport)).toEqual(['abc❤'])

    viewport.setPartial('abc❤️')

    expect(allLines(viewport)).toEqual(['abc', '❤️'])
  })

  it('shows no tail when the partial is cleared after its record arrives', () => {
    const { buffer, viewport } = viewportOf([], 40)
    viewport.setPartial('The README is a single')

    buffer.push(text('The README is a single heading.'))
    viewport.sync()
    viewport.setPartial(undefined)

    expect(viewport.visible(10).map((r) => [r.kind, r.lines])).toEqual([
      ['text', ['The README is a single heading.']],
    ])
  })
})

// --- eviction --------------------------------------------------------------

describe('memory bounded by the buffer capacity', () => {
  it('never retains more entries than capacity and drops evicted heights when 500 records pass through 50 slots', () => {
    const capacity = 50
    const buffer = new RingBuffer<TranscriptRecord>(capacity)
    const viewport = new TranscriptViewport(buffer, { width: 40, capacity })

    const over: string[] = []
    let pushed = 0
    while (pushed < 500) {
      for (const record of entries(pushed, 7)) buffer.push(record)
      pushed += 7
      viewport.sync()
      viewport.visible(10)
      if (viewport.retained > capacity) over.push(`${viewport.retained} after ${pushed}`)
      if (viewport.totalLines() !== Math.min(pushed, capacity)) {
        over.push(`${viewport.totalLines()} lines after ${pushed}`)
      }
    }

    expect(over).toEqual([])
    expect(viewport.visible(1)[0]?.record).toBe(pushed - 1)
  })
})

// --- performance contract --------------------------------------------------

/** Records 1–3 lines tall at width 57, varied so heights differ. */
function history(count: number, from = 0): TranscriptRecord[] {
  return Array.from({ length: count }, (_, i) => {
    const n = from + i
    if (n % 11 === 0) return tool('Read', { file_path: `src/api/quote-${n}.ts` }, '')
    return text(`Record ${n}: ${'the bucket refills every second '.repeat(1 + (n % 4))}`.trim())
  })
}

describe('the performance contract, by operation counts', () => {
  it('does no wrapping and an O(log capacity) number of lookups per scroll when the cache is warm', async ({
    annotate,
  }) => {
    const capacity = 5000
    const { viewport } = viewportOf(history(capacity), 57, capacity)
    viewport.visible(20)
    const before = { ...viewport.stats }
    const bound = 100 * (Math.ceil(Math.log2(capacity)) + 2)

    const started = performance.now()
    for (let i = 0; i < 100; i++) {
      viewport.scrollBy(-7)
      viewport.visible(20)
    }
    await annotate(
      `100 scrolls over ${capacity} records: ${(performance.now() - started).toFixed(1)} ms`,
    )

    expect(viewport.stats.wraps).toBe(before.wraps)
    expect(viewport.stats.measured).toBe(before.measured)
    expect(viewport.stats.lookups - before.lookups).toBeLessThanOrEqual(bound)
  })

  it('wraps exactly the 50 new records when 50 are appended', () => {
    const { buffer, viewport } = viewportOf(history(1000), 57)
    viewport.visible(20)
    const before = viewport.stats.wraps

    for (const record of history(50, 1000)) buffer.push(record)
    viewport.sync()
    viewport.visible(20)

    expect(viewport.stats.wraps - before).toBe(50)
  })

  it('wraps the 50 new records and one tail when 50 are appended and a partial is published', () => {
    const { buffer, viewport } = viewportOf(history(1000), 57)
    viewport.visible(20)
    const before = viewport.stats.wraps

    for (const record of history(50, 1000)) buffer.push(record)
    viewport.sync()
    viewport.setPartial('Next I will edit the limiter')
    viewport.visible(20)

    expect(viewport.stats.wraps - before).toBe(51)
  })

  it('wraps only the new records when appending evicts old ones from a full buffer', () => {
    const capacity = 5000
    const { buffer, viewport } = viewportOf(history(capacity), 57, capacity)
    viewport.visible(20)
    const before = viewport.stats.wraps

    for (const record of history(50, capacity)) buffer.push(record)
    viewport.sync()
    viewport.visible(20)

    expect(viewport.stats.wraps - before).toBe(50)
    expect(viewport.retained).toBe(capacity)
  })

  it('rewraps at most the retained records when the width changes', async ({ annotate }) => {
    const capacity = 1000
    const { viewport } = viewportOf(history(3000), 57, capacity)
    viewport.visible(20)
    const before = viewport.stats.wraps

    const started = performance.now()
    viewport.setWidth(37)
    viewport.visible(20)
    await annotate(
      `setWidth over ${capacity} retained records: ${(performance.now() - started).toFixed(1)} ms`,
    )

    expect(viewport.stats.wraps - before).toBeGreaterThan(0)
    expect(viewport.stats.wraps - before).toBeLessThanOrEqual(viewport.retained)
    expect(viewport.retained).toBe(capacity)
  })

  it('rewraps no history when scrolling, following or redrawing at the same width', () => {
    const { viewport } = viewportOf(history(1000), 57)
    viewport.visible(20)
    const before = viewport.stats.wraps

    viewport.scrollTo('top')
    viewport.visible(20)
    viewport.scrollBy(300)
    viewport.visible(20)
    viewport.follow()
    viewport.visible(20)
    viewport.setWidth(57)
    viewport.visible(20)

    expect(viewport.stats.wraps).toBe(before)
  })

  it('wraps only the toggled record when a tool record is expanded', () => {
    const { viewport } = viewportOf(history(1000), 57)
    viewport.visible(20)
    const before = viewport.stats.wraps

    viewport.setExpanded(990, true)

    expect(viewport.stats.wraps - before).toBe(1)
  })

  it('returns at most 20 rows covering exactly 20 lines when the buffer holds 5000 records', () => {
    const { viewport } = viewportOf(history(5000), 57)

    const rows: VisibleRow[] = viewport.visible(20)

    expect(rows.length).toBeLessThanOrEqual(20)
    expect(rows.reduce((n, r) => n + r.lines.length, 0)).toBe(20)
  })
})

describe('grapheme offsets in the anchor', () => {
  it('counts an emoji sequence as one grapheme when it is anchored past one', () => {
    const body = `${'👨‍👩‍👧'.repeat(6)}tail`
    const { viewport } = viewportOf([text(body)], 4)
    viewport.visible(1)
    viewport.scrollTo('top')

    viewport.scrollBy(1)
    viewport.visible(1)

    // Row 0 holds two families (4 cells), so row 1 starts at grapheme 2.
    expect(viewport.anchor).toEqual({ record: 0, offset: 2 })
  })
})
