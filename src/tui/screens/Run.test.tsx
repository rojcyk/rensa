import { appendFile } from 'node:fs/promises'
import path from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { Box } from 'ink'
import {
  afterAll,
  afterEach,
  assert,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import {
  openRunDir,
  type ResolvedChain,
  type RunEvent,
  type RunHandle,
  type RunResult,
  runBase,
  type TranscriptRecord,
} from '../../engine/index.js'
import { type EngineRepo, engineRepo, eventMatching, finished } from '../../testing/engine.js'
import { type Frames, renderFrames } from '../../testing/inkFrames.js'
import { type ScriptEvent, type ScriptedRun, scriptedRun } from '../../testing/scriptedRun.js'
import { agentStep, resolvedChain, shellStep } from '../../testing/steps.js'
import type { Navigate } from '../app.js'
import type { HeaderProps } from '../components/Header.js'
import { FRAME_MS } from '../frameRate.js'
import type { KeyHandler } from '../hooks/useKeys.js'
import { SizeProvider } from '../size.js'
import type { Mode } from '../terminalSession.js'
import { theme } from '../theme.js'
import { Run, type RunScreenSource } from './Run.js'

// Colors and backgrounds carry the states and the painting rule; force
// truecolor before Ink (and its chalk) load.
const previousForceColor = vi.hoisted(() => {
  const previous = process.env.FORCE_COLOR
  process.env.FORCE_COLOR = '3'
  return previous
})

afterAll(() => {
  if (previousForceColor === undefined) delete process.env.FORCE_COLOR
  else process.env.FORCE_COLOR = previousForceColor
})

/** The terminal cursor is placed through Ink's `useCursor`; record the last position, passing it on. */
const cursor = vi.hoisted(() => ({ last: undefined as { x: number; y: number } | undefined }))
vi.mock('ink', async (importOriginal) => {
  const ink = await importOriginal<typeof import('ink')>()
  return {
    ...ink,
    useCursor: () => {
      const real = ink.useCursor()
      return {
        setCursorPosition(position: { x: number; y: number } | undefined) {
          cursor.last = position
          real.setCursorPosition(position)
        },
      }
    },
  }
})

/** Every key handler the screen registers, and what each call returned. Passed through unchanged. */
const keys = vi.hoisted(() => ({ handlers: [] as unknown[], returned: [] as unknown[] }))
vi.mock('../hooks/useKeys.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/useKeys.js')>()
  return {
    ...actual,
    useKeys: (handler: KeyHandler, opts: { active: boolean }) => {
      keys.handlers.push(handler)
      actual.useKeys((action, raw) => {
        keys.returned.push(handler(action, raw))
      }, opts)
    },
  }
})

/**
 * Render probes: the agent row formats its config cell once per render
 * (`truncateEnd` on `provider · model · effort`), an `Elapsed` leaf
 * formats once per render. Passed through unchanged.
 */
const formatCalls = vi.hoisted(() => ({ config: 0, elapsed: 0 }))
const CONFIG = 'claude · opus · high'
vi.mock('../format.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../format.js')>()
  return {
    ...actual,
    truncateEnd: (text: string, width: number) => {
      if (text === CONFIG) formatCalls.config++
      return actual.truncateEnd(text, width)
    },
    formatElapsed: (ms: number) => {
      formatCalls.elapsed++
      return actual.formatElapsed(ms)
    },
  }
})

// --- escapes ---------------------------------------------------------------

const fg = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16)
  return `\x1b[38;2;${(n >> 16) & 0xff};${(n >> 8) & 0xff};${n & 0xff}m`
}

function bgOf(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16)
  return `48;2;${(n >> 16) & 0xff};${(n >> 8) & 0xff};${n & 0xff}`
}
const SELECTION_BG = bgOf(theme.selection)
const ROOT_BG = bgOf(theme.background)
/** Any SGR background escape, truecolor or 256-color. */
const ANY_BG = '\x1b[48;'

interface Cell {
  char: string
  bg: string | undefined
}

/** One frame row as cells with their background, from the SGR escapes. */
function cellsOf(row: string): Cell[] {
  const cells: Cell[] = []
  let bg: string | undefined
  const chars = Array.from(row)
  for (let at = 0; at < chars.length; at++) {
    const char = chars[at] ?? ''
    if (char !== '\x1b' || chars[at + 1] !== '[') {
      cells.push({ char, bg })
      continue
    }
    let end = at + 2
    while (end < chars.length && !/[A-Za-z]/.test(chars[end] ?? '')) end++
    const params = chars.slice(at + 2, end).join('')
    if (chars[end] === 'm') bg = applySgr(bg, params)
    at = end
  }
  return cells
}

function applySgr(bg: string | undefined, params: string): string | undefined {
  const codes = params === '' ? ['0'] : params.split(';')
  let next = bg
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i]
    if (code === '0' || code === '49') next = undefined
    else if (code === '48' && codes[i + 1] === '2') {
      next = `48;2;${codes.slice(i + 2, i + 5).join(';')}`
      i += 4
    } else if (code === '48' && codes[i + 1] === '5') {
      next = `48;5;${codes[i + 2]}`
      i += 2
    } else if ((code === '38' || code === '58') && codes[i + 1] === '2') i += 4
    else if ((code === '38' || code === '58') && codes[i + 1] === '5') i += 2
  }
  return next
}

const KEYS = {
  enter: '\r',
  esc: '\x1b',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  pageDown: '\x1b[6~',
  top: '\x1b[1;2D',
  ctrlC: '\x03',
  ctrlF: '\x06',
  ctrlP: '\x10',
  ctrlX: '\x18',
} as const

const SPINNER = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/

// --- fixtures --------------------------------------------------------------

const NOW = new Date('2026-11-08T11:24:12.000Z')
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000).toISOString()

const RUN_ID = '2026-11-08_1120_tdd-review_4f2a'
const RUN_DIR = `/Users/ryowa/Repos/trezor-suite/.rensa/runs/${RUN_ID}`

/** The plan's mock chain. `review-codex` is the longest id: leftCols is 18 at 100 columns. */
const TDD_REVIEW: ResolvedChain = resolvedChain('tdd-review', [
  shellStep('baseline', 'npm test'),
  agentStep('write-tests', {
    label: 'tester',
    provider: 'claude',
    model: 'opus',
    effort: 'high',
    tools: 'write',
  }),
  agentStep('implement', {
    label: 'impl',
    provider: 'claude',
    model: 'opus',
    effort: 'high',
    tools: 'write',
  }),
  shellStep('test', 'npm test'),
  agentStep('review-codex', { label: 'codex', provider: 'codex', effort: 'medium' }),
  shellStep('retest', 'npm test'),
])
const LEFT_COLS = 18

const HEADER: HeaderProps = {
  branch: 'main',
  mode: 'in place',
  path: '~/Repos/trezor-suite',
  right: 'tdd-review',
}

function spawned(step: string, label: string, t: string): ScriptEvent {
  return {
    t,
    type: 'agent.spawned',
    step,
    agent: label,
    data: {
      provider: 'claude',
      model: 'opus',
      effort: 'high',
      tools: 'write',
      session_id: `sess_${label}_8f3e21`,
      resumed: false,
    },
  }
}

/** Through `implement` running for 1:39 of a 4:12 run. */
const TO_IMPLEMENT: ScriptEvent[] = [
  {
    t: ago(252),
    type: 'run.started',
    data: {
      chain: 'tdd-review',
      input_kind: 'text',
      base: 'feat/quote-limits',
      base_sha: '3f9c2a1b7e4d5c6a8b9f0e1d2c3b4a5968778695',
      rensa_version: '0.1.0',
    },
  },
  {
    t: ago(252),
    type: 'step.started',
    step: 'baseline',
    data: { kind: 'shell', command: 'npm test' },
  },
  { t: ago(247), type: 'step.finished', step: 'baseline', data: { status: 'ok', exit_code: 0 } },
  { t: ago(247), type: 'step.started', step: 'write-tests', data: { kind: 'agent' } },
  spawned('write-tests', 'tester', ago(247)),
  {
    t: ago(99),
    type: 'agent.finished',
    step: 'write-tests',
    agent: 'tester',
    data: { status: 'ok', exit_code: 0, usage: { input: 12_000, output: 400 } },
  },
  { t: ago(99), type: 'step.finished', step: 'write-tests', data: { status: 'ok', exit_code: 0 } },
  { t: ago(99), type: 'step.started', step: 'implement', data: { kind: 'agent' } },
  spawned('implement', 'impl', ago(99)),
]

/** Paused before `implement` after write-tests finished. */
const PAUSED_BEFORE: ScriptEvent[] = [
  ...TO_IMPLEMENT.slice(0, 7),
  { t: ago(99), type: 'run.paused', data: { before: 'implement', reason: 'declared' } },
]

const IMPLEMENT_RECORDS: TranscriptRecord[] = [
  {
    t: ago(90),
    kind: 'text',
    text: 'Reading the four new tests in quote.ratelimit.test.ts\nto understand the expected window semantics.',
  },
  {
    t: ago(80),
    kind: 'tool',
    name: 'Read',
    input: { file_path: 'src/api/quote.ts' },
    ok: true,
    output: 'export const quoteLimit = 100',
  },
  {
    t: ago(70),
    kind: 'tool',
    name: 'Edit',
    input: { file_path: 'src/middleware/ratelimit.ts' },
    ok: true,
    output: '',
  },
  { t: ago(60), kind: 'text', text: 'Token bucket keyed on the API key header ...' },
]

// --- rendering -------------------------------------------------------------

let mounted: Frames | undefined

beforeEach(() => {
  // Elapsed cells read the clock; the scripted runs are timed against NOW.
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  cursor.last = undefined
  keys.handlers = []
  keys.returned = []
  formatCalls.config = 0
  formatCalls.elapsed = 0
})

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const effects = () => new Promise<void>((resolve) => setImmediate(resolve))

/** Waits for a frame or call caused by something outside React's input path. */
const settles = (assertion: () => void) => vi.waitFor(assertion, { timeout: 2000 })

interface Screen {
  frames: Frames
  navigate: ReturnType<typeof vi.fn<Navigate>>
  requestQuit: ReturnType<typeof vi.fn<() => void>>
  press(input: string, times?: number): Promise<void>
  type(text: string): Promise<void>
  /** The last frame without escapes, trailing spaces trimmed. */
  lines(): string[]
  /** The last frame's rows with their escapes. */
  raw(): string[]
  resize(columns: number, rows: number): void
}

function mount(opts: {
  source: RunScreenSource
  columns?: number
  rows?: number
  mode?: Mode
}): Screen {
  const mode = opts.mode ?? 'inline'
  const navigate = vi.fn<Navigate>()
  const requestQuit = vi.fn<() => void>()
  const tree = (columns: number, rows: number) => {
    const screen = (
      <Run
        source={opts.source}
        navigate={navigate}
        requestQuit={requestQuit}
        active={true}
        mode={mode}
        header={HEADER}
      />
    )
    // What app.tsx does: the fullscreen root alone carries theme.background.
    return (
      <SizeProvider columns={columns} rows={rows}>
        {mode === 'fullscreen' ? (
          <Box
            width={columns}
            height={rows}
            flexDirection="column"
            backgroundColor={theme.background}
          >
            {screen}
          </Box>
        ) : (
          screen
        )}
      </SizeProvider>
    )
  }
  const size = { columns: opts.columns ?? 100, rows: opts.rows ?? 30 }
  const frames = renderFrames(tree(size.columns, size.rows), size)
  mounted = frames
  return {
    frames,
    navigate,
    requestQuit,
    async press(input, times = 1) {
      for (let i = 0; i < times; i++) {
        frames.stdin.write(input)
        await effects()
      }
    },
    async type(text) {
      for (const char of text) {
        frames.stdin.write(char)
        await effects()
      }
    },
    lines: () =>
      stripVTControlCharacters(frames.lastFrame())
        .split('\n')
        .map((l) => l.trimEnd()),
    raw: () => frames.lastFrame().split('\n'),
    resize(columns, rows) {
      frames.resize(columns, rows)
      frames.rerender(tree(columns, rows))
    },
  }
}

/** A scripted live run of TDD_REVIEW. */
function live(history: ReadonlyArray<ScriptEvent>, records = IMPLEMENT_RECORDS): ScriptedRun {
  const run = scriptedRun({ id: RUN_ID, dir: RUN_DIR, history })
  run.seed('implement', 'impl', records)
  return run
}

/** The runner's `pause()` while a step runs: it logs the pause action for the current step. */
function pauseEmits(run: ScriptedRun, step: string): void {
  run.handle.pause.mockImplementation(() =>
    run.event({ t: ago(0), type: 'user.action', data: { action: 'pause', step } }),
  )
}

function mountLive(
  run: ScriptedRun,
  opts: { columns?: number; rows?: number; mode?: Mode } = {},
): Screen {
  return mount({ source: { handle: run.handle, chain: TDD_REVIEW }, ...opts })
}

/** The left-column text of each step row, `○ baseline` etc., top to bottom. */
function stepRows(s: Screen): string[] {
  const ids = TDD_REVIEW.steps.map((step) => step.id)
  return s
    .lines()
    .map((l) => l.slice(0, LEFT_COLS).trim())
    .filter((l) => ids.some((id) => l.split(' ')[1] === id))
}

/** The id of the step row painted with the selection background. */
function selectedStep(s: Screen): string | undefined {
  for (const row of s.raw()) {
    const cells = cellsOf(row).slice(0, LEFT_COLS)
    if (cells.length === 0 || cells[0]?.bg !== SELECTION_BG) continue
    return cells
      .map((c) => c.char)
      .join('')
      .trim()
      .split(' ')[1]
  }
  return undefined
}

/** The status row: the line after the header rule. */
function statusRow(s: Screen): string {
  return s.lines()[2] ?? ''
}

/** The note box's text row. */
function noteRow(s: Screen): string {
  return s.lines().find((l) => l.startsWith('│ ›')) ?? ''
}

// --- tests -----------------------------------------------------------------

describe('focus routing between the screen and the note box', () => {
  it('moves the caret and leaves the step selection and follow mode alone when abc is typed and left pressed twice', async () => {
    const s = mountLive(live(TO_IMPLEMENT))
    await effects()
    const stepsBefore = stepRows(s)

    await s.type('abc')
    const caretAfterTyping = cursor.last?.x
    await s.press(KEYS.left, 2)

    // Border and padding (2), the `› ` prompt (2), then the caret's cell.
    expect(caretAfterTyping).toBe(2 + 2 + 3)
    expect(cursor.last?.x).toBe(2 + 2 + 1)
    expect(noteRow(s)).toContain('› abc')
    expect(selectedStep(s)).toBe('implement')
    expect(stepRows(s)).toEqual(stepsBefore)
    expect(s.lines().join('\n')).not.toContain('⟳')
  })

  it('sends the note once, never resumes, clears the box and returns focus to main when enter is pressed in the box', async () => {
    const run = live(TO_IMPLEMENT)
    const s = mountLive(run)
    await effects()
    await s.type('abc')

    await s.press(KEYS.enter)

    expect(run.handle.note.mock.calls).toEqual([['abc']])
    expect(run.handle.resume).not.toHaveBeenCalled()
    expect(noteRow(s)).toContain('› note for the next steps…')
    expect(cursor.last).toBeUndefined()
    await s.press(KEYS.left)
    expect(selectedStep(s)).toBe('write-tests')
  })

  it('sends nothing when enter is pressed in an empty box', async () => {
    const run = live(TO_IMPLEMENT)
    const s = mountLive(run)
    await effects()
    await s.type(' ')
    await s.press('\x7f')

    await s.press(KEYS.enter)

    expect(run.handle.note).not.toHaveBeenCalled()
  })

  it('resumes once and sends no note when enter is pressed in main while paused', async () => {
    const run = live(PAUSED_BEFORE, [])
    const s = mountLive(run)
    await effects()

    await s.press(KEYS.enter)

    expect(run.handle.resume).toHaveBeenCalledTimes(1)
    expect(run.handle.note).not.toHaveBeenCalled()
  })

  it('kills once and keeps the half-typed note when ctrl+x then y is pressed in the box', async () => {
    const run = live(TO_IMPLEMENT)
    const s = mountLive(run)
    await effects()
    await s.type('hal')

    await s.press(KEYS.ctrlX)
    expect(statusRow(s)).toBe('  kill implement? y/n')
    await s.press('y')

    expect(run.handle.kill).toHaveBeenCalledTimes(1)
    expect(noteRow(s)).toContain('› hal')
    expect(statusRow(s)).toMatch(/run 4f2a · \d+:\d\d · running$/)
    await s.type('f')
    expect(noteRow(s)).toContain('› half')
  })

  it('pauses and shows `pausing after implement` when ctrl+p is pressed while typing', async () => {
    const run = live(TO_IMPLEMENT)
    pauseEmits(run, 'implement')
    const s = mountLive(run)
    await effects()
    await s.type('ab')

    await s.press(KEYS.ctrlP)

    expect(run.handle.pause).toHaveBeenCalledTimes(1)
    await settles(() => expect(statusRow(s)).toMatch(/· pausing after implement$/))
    expect(noteRow(s)).toContain('› ab')
  })

  it('keeps the text and does not navigate when esc is pressed in the box', async () => {
    const s = mountLive(live(TO_IMPLEMENT))
    await effects()
    await s.type('abc')
    expect(cursor.last).toBeDefined()

    s.frames.stdin.write(KEYS.esc)
    await settles(() => expect(cursor.last).toBeUndefined())

    expect(s.navigate).not.toHaveBeenCalled()
    expect(noteRow(s)).toContain('› abc')
  })

  it('navigates back to chains when esc is pressed in main', async () => {
    const s = mountLive(live(TO_IMPLEMENT))
    await effects()

    s.frames.stdin.write(KEYS.esc)

    await settles(() => expect(s.navigate).toHaveBeenCalledWith({ name: 'chains' }))
  })

  it('calls the app quit path when ctrl+c is pressed in main', async () => {
    const s = mountLive(live(TO_IMPLEMENT))
    await effects()

    await s.press(KEYS.ctrlC)

    expect(s.requestQuit).toHaveBeenCalledTimes(1)
  })
})

describe('the kill confirmation', () => {
  it('dismisses without killing when n is pressed', async () => {
    const run = live(TO_IMPLEMENT)
    const s = mountLive(run)
    await effects()

    await s.press(KEYS.ctrlX)
    await s.press('n')

    expect(run.handle.kill).not.toHaveBeenCalled()
    expect(statusRow(s)).toMatch(/· running$/)
  })

  it('dismisses without killing or navigating when esc is pressed', async () => {
    const run = live(TO_IMPLEMENT)
    const s = mountLive(run)
    await effects()
    await s.press(KEYS.ctrlX)

    s.frames.stdin.write(KEYS.esc)
    await settles(() => expect(statusRow(s)).toMatch(/· running$/))

    expect(run.handle.kill).not.toHaveBeenCalled()
    expect(s.navigate).not.toHaveBeenCalled()
  })

  it('dismisses itself and kills nothing on y when the named step is no longer running', async () => {
    const run = live(TO_IMPLEMENT)
    const s = mountLive(run)
    await effects()
    await s.press(KEYS.ctrlX)

    run.event({
      t: ago(5),
      type: 'agent.finished',
      step: 'implement',
      agent: 'impl',
      data: { status: 'ok', exit_code: 0 },
    })
    run.event({
      t: ago(5),
      type: 'step.finished',
      step: 'implement',
      data: { status: 'ok', exit_code: 0 },
    })
    run.event({
      t: ago(5),
      type: 'step.started',
      step: 'test',
      data: { kind: 'shell', command: 'npm test' },
    })
    await settles(() => expect(statusRow(s)).toMatch(/· running$/))
    await s.press('y')

    expect(run.handle.kill).not.toHaveBeenCalled()
  })

  it('dismisses itself when the run leaves running', async () => {
    const run = live(TO_IMPLEMENT)
    const s = mountLive(run)
    await effects()
    await s.press(KEYS.ctrlX)

    run.event({ t: ago(5), type: 'run.paused', data: { after: 'implement', reason: 'user' } })

    await settles(() => expect(statusRow(s)).toMatch(/· paused after implement$/))
  })

  it('calls the quit path and drops the question when ctrl+c is pressed while it shows', async () => {
    const run = live(TO_IMPLEMENT)
    const s = mountLive(run)
    await effects()
    await s.press(KEYS.ctrlX)

    await s.press(KEYS.ctrlC)

    expect(s.requestQuit).toHaveBeenCalledTimes(1)
    expect(statusRow(s)).toMatch(/· running$/)
    await s.press('y')
    expect(run.handle.kill).not.toHaveBeenCalled()
  })

  it('ignores ctrl+p and ctrl+f while the question shows', async () => {
    const run = live(TO_IMPLEMENT)
    const s = mountLive(run)
    await effects()
    await s.press(KEYS.right)
    await s.press(KEYS.ctrlX)

    await s.press(KEYS.ctrlP)
    await s.press(KEYS.ctrlF)

    expect(run.handle.pause).not.toHaveBeenCalled()
    expect(statusRow(s)).toBe('  kill implement? y/n')
    await s.press('n')
    expect(selectedStep(s)).toBe('test')
    expect(s.lines().join('\n')).toContain('● implement ⟳')
  })
})

describe('pause and paused states', () => {
  it('shows `pausing after implement` until the pause lands, then `paused after implement`', async () => {
    const run = live(TO_IMPLEMENT)
    pauseEmits(run, 'implement')
    const s = mountLive(run)
    await effects()

    await s.press(KEYS.ctrlP)
    await settles(() =>
      expect(statusRow(s)).toMatch(/^ +run 4f2a · 4:12 · pausing after implement$/),
    )
    run.event({ t: ago(0), type: 'run.paused', data: { after: 'implement', reason: 'user' } })

    await settles(() =>
      expect(statusRow(s)).toMatch(/^ +run 4f2a · 4:12 · paused after implement$/),
    )
  })

  it('still reads `pausing after implement` on the first frame when the screen is left and opened again on the same run', async () => {
    const run = live(TO_IMPLEMENT)
    pauseEmits(run, 'implement')
    const leaving = mountLive(run)
    await effects()
    await leaving.press(KEYS.ctrlP)
    await settles(() => expect(statusRow(leaving)).toMatch(/· pausing after implement$/))
    leaving.frames.unmount()

    const back = mountLive(run)

    const first = stripVTControlCharacters(back.frames.frames[0] ?? '')
      .split('\n')[2]
      ?.trimEnd()
    expect(first).toMatch(/^ +run 4f2a · 4:12 · pausing after implement$/)
  })

  it('renders ‖ in warn on the step and `paused before implement` in the status line when paused before it', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW })
    const s = mountLive(live(PAUSED_BEFORE, []))
    await effects()

    expect(stepRows(s)).toContain('‖ implement')
    expect(s.frames.lastFrame()).toContain(`${fg(theme.warn)}‖`)
    expect(statusRow(s)).toMatch(/^ +run 4f2a · 4:12 · paused before implement$/)
    expect(s.raw()[2]).toContain(`${fg(theme.accent)}paused before implement`)
  })
})

describe('keys on the run screen', () => {
  it('selects the next step and marks the running one with ⟳ when right is pressed', async () => {
    const s = mountLive(live(TO_IMPLEMENT))
    await effects()

    await s.press(KEYS.right)

    expect(selectedStep(s)).toBe('test')
    expect(stepRows(s)).toContain('● implement ⟳')
    expect(s.lines().filter((l) => l.slice(LEFT_COLS) === '│  test')).toHaveLength(1)
  })

  it('reattaches to the running step and drops ⟳ when ctrl+f is pressed after moving away', async () => {
    const s = mountLive(live(TO_IMPLEMENT))
    await effects()
    await s.press(KEYS.left, 2)

    await s.press(KEYS.ctrlF)

    expect(selectedStep(s)).toBe('implement')
    expect(s.lines().join('\n')).not.toContain('⟳')
  })

  it('follows a newly started step when following and the run moves on', async () => {
    const run = live(TO_IMPLEMENT)
    const s = mountLive(run)
    await effects()

    run.event({
      t: ago(0),
      type: 'agent.finished',
      step: 'implement',
      agent: 'impl',
      data: { status: 'ok', exit_code: 0 },
    })
    run.event({
      t: ago(0),
      type: 'step.finished',
      step: 'implement',
      data: { status: 'ok', exit_code: 0 },
    })
    run.event({
      t: ago(0),
      type: 'step.started',
      step: 'test',
      data: { kind: 'shell', command: 'npm test' },
    })

    await settles(() => expect(selectedStep(s)).toBe('test'))
  })

  it('moves the transcript window by half its height when pageDown is pressed after top', async () => {
    const records: TranscriptRecord[] = Array.from({ length: 80 }, (_, i) => ({
      t: ago(90),
      kind: 'text',
      text: `Line ${String(i).padStart(2, '0')} of the limiter notes`,
    }))
    const s = mountLive(live(TO_IMPLEMENT, records), { mode: 'fullscreen' })
    await effects()
    const firstShown = () =>
      s
        .lines()
        .find((l) => l.includes('Line '))
        ?.slice(LEFT_COLS + 3)

    await s.press(KEYS.top)
    const atTop = firstShown()
    await s.press(KEYS.pageDown)

    // 30 rows: header 4, note box 3, body 23; the block takes 4, the transcript 19; half is 9.
    expect(atTop).toBe('Line 00 of the limiter notes')
    expect(firstShown()).toBe('Line 09 of the limiter notes')
  })

  it('expands the tool record under the cursor and collapses it again when enter is pressed twice', async () => {
    const s = mountLive(live(TO_IMPLEMENT))
    await effects()
    await s.press(KEYS.down)
    const header = s.raw().find((r) => stripVTControlCharacters(r).includes('▸ Read'))
    expect(header).toContain(`\x1b[${SELECTION_BG}m`)

    await s.press(KEYS.enter)
    const expanded = s.lines().map((l) => l.slice(LEFT_COLS + 3))
    await s.press(KEYS.enter)

    expect(expanded).toContain('  export const quoteLimit = 100')
    expect(s.lines().map((l) => l.slice(LEFT_COLS + 3))).not.toContain(
      '  export const quoteLimit = 100',
    )
  })

  it('moves the cursor to the next tool record when down is pressed again', async () => {
    const s = mountLive(live(TO_IMPLEMENT))
    await effects()

    await s.press(KEYS.down, 2)
    await s.press(KEYS.enter)

    const shown = s.lines().map((l) => l.slice(LEFT_COLS + 3))
    expect(shown).toContain('    "file_path": "src/middleware/ratelimit.ts"')
    expect(shown).not.toContain('  export const quoteLimit = 100')
  })

  it('clears the tool cursor when another step is selected and selected back', async () => {
    const s = mountLive(live(TO_IMPLEMENT))
    await effects()
    await s.press(KEYS.down)

    await s.press(KEYS.right)
    await s.press(KEYS.left)
    await s.press(KEYS.enter)

    const header = s.raw().find((r) => stripVTControlCharacters(r).includes('▸ Read'))
    expect(header).not.toContain(SELECTION_BG)
    expect(s.lines().map((l) => l.slice(LEFT_COLS + 3))).not.toContain(
      '  export const quoteLimit = 100',
    )
  })

  it('shows the tokens of the selected agent as input + output when its usage is known', async () => {
    const s = mountLive(live(TO_IMPLEMENT))
    await effects()

    await s.press(KEYS.left)

    const row = s.lines().find((l) => l.includes('› tester')) ?? ''
    expect(row.trimEnd().endsWith('12.4k')).toBe(true)
  })
})

describe('input priority over the stream', () => {
  it('moves the selection in the next frame while several hundred transcript events are still pending', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: NOW })
    const run = live(TO_IMPLEMENT)
    const s = mountLive(run)
    await effects()
    // The first record is delivered at once and opens a batch window; the rest wait for it.
    run.record('implement', 'impl', { kind: 'text', text: 'First streamed record.' })
    await effects()
    for (let i = 0; i < 400; i++) {
      run.record('implement', 'impl', { kind: 'text', text: `Streamed record ${i}` })
    }
    const framesBefore = s.frames.frames.length

    await s.press(KEYS.right)

    expect(selectedStep(s)).toBe('test')
    expect(s.frames.frames.length).toBeGreaterThan(framesBefore)
    await s.press(KEYS.left)
    expect(s.lines().join('\n')).not.toContain('Streamed record 399')
    await vi.advanceTimersByTimeAsync(FRAME_MS)
    await effects()
    expect(s.lines().join('\n')).toContain('Streamed record 399')
  })

  it('registers only synchronous key handlers that return nothing', async () => {
    const s = mountLive(live(TO_IMPLEMENT))
    await effects()

    await s.press(KEYS.right)
    await s.type('a')
    await s.press(KEYS.enter)

    expect(keys.handlers.length).toBeGreaterThan(0)
    expect(new Set(keys.handlers.map((h) => (h as object).constructor.name))).toEqual(
      new Set(['Function']),
    )
    expect(keys.returned.length).toBeGreaterThan(0)
    expect(keys.returned.filter((r) => r !== undefined)).toEqual([])
  })
})

describe('the agent row redraws only on its own status', () => {
  it('re-renders the elapsed leaves but not the row when 5 s pass, nor when a record arrives on its step', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
      now: NOW,
    })
    const run = live(TO_IMPLEMENT)
    const s = mountLive(run)
    await effects()
    const agentRow = () => s.lines().find((l) => l.includes('› impl')) ?? ''
    expect(agentRow()).toContain('1:39')
    const rowRenders = formatCalls.config
    const leafRenders = formatCalls.elapsed

    await vi.advanceTimersByTimeAsync(5000)
    await effects()
    const afterTicks = { row: formatCalls.config, leaves: formatCalls.elapsed, shown: agentRow() }
    run.record('implement', 'impl', { kind: 'text', text: 'Adding the limiter now.' })
    await vi.advanceTimersByTimeAsync(FRAME_MS)
    await effects()

    expect(rowRenders).toBeGreaterThan(0)
    expect(afterTicks.shown).toContain('1:44')
    expect(afterTicks.leaves).toBeGreaterThanOrEqual(leafRenders + 5)
    expect(afterTicks.row).toBe(rowRenders)
    expect(s.lines().join('\n')).toContain('Adding the limiter now.')
    expect(formatCalls.config).toBe(rowRenders)
  })
})

describe('a run whose storage failed', () => {
  const MESSAGE = `EACCES: permission denied, open '${RUN_DIR}/events.jsonl'`
  const STORAGE_FAILED: RunResult = {
    status: 'failed',
    finishedAt: ago(30),
    error: { code: 'STORAGE', message: MESSAGE },
  }

  it('reads `failed · EACCES…` in err, truncated to the width, with no run.finished event', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW })
    const run = scriptedRun({
      id: RUN_ID,
      dir: RUN_DIR,
      history: TO_IMPLEMENT,
      result: STORAGE_FAILED,
    })
    assert(!run.handle.events().some((e) => e.type === 'run.finished'), 'no run.finished on record')

    const s = mountLive(run)
    await effects()

    const status = statusRow(s)
    expect(status).toMatch(/^run 4f2a · 3:42 · failed · EACCES: permission denied, .*…$/)
    expect(status.length).toBeLessThanOrEqual(100)
    expect(s.raw()[2]).toContain(`${fg(theme.err)}failed · EACCES`)
  })

  it('unmounts every spinner and stops every elapsed cell when the run failed on storage', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
      now: NOW,
    })
    const run = scriptedRun({
      id: RUN_ID,
      dir: RUN_DIR,
      history: TO_IMPLEMENT,
      result: STORAGE_FAILED,
    })
    const s = mountLive(run)
    await effects()
    const before = s.lines()

    await vi.advanceTimersByTimeAsync(5000)
    await effects()

    expect(before.join('\n')).not.toMatch(SPINNER)
    expect(s.lines()).toEqual(before)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('end states', () => {
  it('turns the status to complete in ok, unmounts the spinner and makes the note box inert when the run finishes', async () => {
    const run = live(TO_IMPLEMENT)
    const s = mountLive(run)
    await effects()
    expect(s.lines().join('\n')).toMatch(SPINNER)

    run.event({
      t: ago(0),
      type: 'agent.finished',
      step: 'implement',
      agent: 'impl',
      data: { status: 'ok', exit_code: 0 },
    })
    run.event({
      t: ago(0),
      type: 'step.finished',
      step: 'implement',
      data: { status: 'ok', exit_code: 0 },
    })
    run.event({ t: ago(0), type: 'run.finished', data: { status: 'complete' } })
    run.finish({ status: 'complete', finishedAt: ago(0) })
    await settles(() => expect(statusRow(s)).toMatch(/· complete$/))
    await s.type('a')

    expect(s.raw()[2]).toContain(`${fg(theme.ok)}complete`)
    expect(s.lines().join('\n')).not.toMatch(SPINNER)
    expect(selectedStep(s)).toBe('implement')
    expect(noteRow(s)).toContain('› note for the next steps…')
    expect(cursor.last).toBeUndefined()
  })

  it('reads aborting… in warn between the abort and run.finished', async () => {
    const run = live(TO_IMPLEMENT)
    const s = mountLive(run)
    await effects()

    run.event({ t: ago(0), type: 'user.action', data: { action: 'abort' } })

    await settles(() => expect(statusRow(s)).toMatch(/· aborting…$/))
    expect(s.raw()[2]).toContain(`${fg(theme.warn)}aborting…`)
  })

  it('reads aborted in err when the run was aborted', async () => {
    const run = live(TO_IMPLEMENT)
    const s = mountLive(run)
    await effects()

    run.event({ t: ago(0), type: 'run.finished', data: { status: 'aborted' } })

    await settles(() => expect(statusRow(s)).toMatch(/· aborted$/))
    expect(s.raw()[2]).toContain(`${fg(theme.err)}aborted`)
  })
})

describe('narrow terminals', () => {
  it('drops the left column and shows `step 3/6 implement` above the right column below 60 columns', async () => {
    const s = mountLive(live(TO_IMPLEMENT), { columns: 50 })
    await effects()

    const body = s.lines().slice(4, -3)
    expect(body.slice(0, 2)).toEqual(['step 3/6 implement', '  implement'])
    expect(body.filter((l) => l.includes('○ test') || l.includes('│'))).toEqual([])
  })
})

describe('painting', () => {
  /** The rows of the body: between the header slot (4) and the note box (3). */
  const bodyRows = (s: Screen) => s.raw().slice(4, -3)

  it('paints the selected step row with the selection background on every cell to the column edge in fullscreen', async () => {
    const s = mountLive(live(TO_IMPLEMENT), { mode: 'fullscreen' })
    await effects()

    const row = bodyRows(s).find((r) => stripVTControlCharacters(r).includes('● implement'))
    assert(row, 'the implement row is drawn')
    const cells = cellsOf(row).slice(0, LEFT_COLS)

    expect(cells.filter((c) => c.bg !== SELECTION_BG)).toEqual([])
  })

  it('fills empty transcript cells and the gap beside the separator with the root background in fullscreen', async () => {
    const s = mountLive(live(TO_IMPLEMENT, []), { mode: 'fullscreen' })
    await effects()

    const rows = bodyRows(s).map(cellsOf)
    const last = rows.at(-1) ?? []
    const gap = rows.map((cells) => cells.slice(LEFT_COLS + 1, LEFT_COLS + 3))

    expect(rows.length).toBe(23)
    expect(last.slice(LEFT_COLS + 1).filter((c) => c.bg !== ROOT_BG)).toEqual([])
    expect(gap.flat().filter((c) => c.bg !== ROOT_BG)).toEqual([])
  })

  it('draws the separator cell on the root background in fullscreen', async () => {
    const s = mountLive(live(TO_IMPLEMENT, []), { mode: 'fullscreen' })
    await effects()

    const separators = bodyRows(s).map((r) => cellsOf(r)[LEFT_COLS])

    expect(separators.filter((c) => c?.char !== '│')).toEqual([])
    expect(separators.filter((c) => c?.bg !== ROOT_BG)).toEqual([])
  })

  it('leaves no stale cells when `paused before implement` is replaced by `running`', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW })
    const run = live(PAUSED_BEFORE, [])
    const s = mountLive(run, { mode: 'fullscreen' })
    await effects()
    expect(statusRow(s)).toMatch(/paused before implement$/)

    run.event({ t: ago(0), type: 'step.started', step: 'implement', data: { kind: 'agent' } })
    await settles(() => expect(statusRow(s)).toMatch(/· running$/))

    const status = cellsOf(s.raw()[2] ?? '')
    const shown = 'run 4f2a · 4:12 · running'
    expect(status.map((c) => c.char).join('')).toBe(`${' '.repeat(100 - shown.length)}${shown}`)
    expect(status.filter((c) => c.bg !== ROOT_BG)).toEqual([])
  })

  it('moves the selection background with the selection when left is pressed', async () => {
    const s = mountLive(live(TO_IMPLEMENT), { mode: 'fullscreen' })
    await effects()

    await s.press(KEYS.left)

    const painted = bodyRows(s)
      .map((r) => cellsOf(r).slice(0, LEFT_COLS))
      .filter((cells) => cells.some((c) => c.bg === SELECTION_BG))
      .map((cells) =>
        cells
          .map((c) => c.char)
          .join('')
          .trim(),
      )
    expect(painted).toEqual(['✓ write-tests'])
  })

  it('fills the new area with the root background after the terminal grows', async () => {
    const s = mountLive(live(TO_IMPLEMENT), { mode: 'fullscreen' })
    await effects()

    s.resize(120, 40)
    await settles(() => expect(s.raw().length).toBe(40))
    await effects()

    const rows = s.raw().map(cellsOf)
    const body = rows.slice(4, -3)
    const unfilled = body.flatMap((cells, y) =>
      cells
        .map((c, x) => ({ c, x }))
        .filter(({ c, x }) => x >= 100 && c.bg !== ROOT_BG)
        .map(({ x }) => `${x},${y + 4}`),
    )
    expect(rows.every((cells) => cells.length === 120)).toBe(true)
    expect(unfilled).toEqual([])
    expect((body.at(-1) ?? []).slice(LEFT_COLS + 1).filter((c) => c.bg !== ROOT_BG)).toEqual([])
  })

  it('paints no background in inline mode except on the selected step row', async () => {
    const s = mountLive(live(TO_IMPLEMENT), { mode: 'inline' })
    await effects()

    const raw = s.raw()
    const selected = raw.filter((r) => stripVTControlCharacters(r).includes('● implement'))
    const others = raw.filter((r) => !stripVTControlCharacters(r).includes('● implement'))

    expect(selected.length).toBe(1)
    expect(selected[0]).toContain(ANY_BG)
    expect(others.filter((r) => r.includes(ANY_BG))).toEqual([])
  })
})

describe('notes and long elapsed times in the right column', () => {
  it('renders a note record as `» text` in warn in the step’s transcript', async () => {
    const records: TranscriptRecord[] = [
      { t: ago(99), kind: 'note', text: 'Keep the public API unchanged.' },
      ...IMPLEMENT_RECORDS,
    ]
    const s = mountLive(live(TO_IMPLEMENT, records))
    await effects()

    const shown = s.lines().map((l) => l.slice(LEFT_COLS + 3))
    expect(shown).toContain('» Keep the public API unchanged.')
    expect(s.frames.lastFrame()).toContain(`${fg(theme.warn)}» Keep the public API unchanged.`)
  })

  it('shows `✓ 1:00:00` unclipped in the status cell, then the tokens, when the agent ran an hour', async () => {
    const history: ScriptEvent[] = [
      ...TO_IMPLEMENT.slice(0, 7),
      { t: ago(3700), type: 'step.started', step: 'implement', data: { kind: 'agent' } },
      spawned('implement', 'impl', ago(3700)),
      {
        t: ago(100),
        type: 'agent.finished',
        step: 'implement',
        agent: 'impl',
        data: { status: 'ok', exit_code: 0, usage: { input: 12_000, output: 400 } },
      },
    ]
    const s = mountLive(live(history, []))
    await effects()

    const row = (s.lines().find((l) => l.includes('› impl')) ?? '').slice(LEFT_COLS + 3)
    // marker 2, name 11, config 27, status 10, tokens 7 (right-aligned): 57 columns.
    expect(row).toBe(`› impl${' '.repeat(7)}${CONFIG.padEnd(27)}${'✓ 1:00:00'.padEnd(10)}  12.4k`)
  })
})

// --- engine-backed runs ----------------------------------------------------

describe('runs from the fake provider', () => {
  let env: EngineRepo | undefined

  beforeEach(() => {
    vi.useRealTimers()
  })

  afterEach(async () => {
    mounted?.unmount()
    mounted = undefined
    await env?.cleanup()
    env = undefined
  })

  it('shows the end state, the run base and every transcript on the first frame when the run already completed', async () => {
    env = await engineRepo(['three-step'])
    const engine = await env.open()
    const handle = await env.start(engine, 'three-step')
    const { events } = await finished(handle)
    const base = runBase(events)
    assert(
      base !== undefined && base !== 'feat/quote-limits',
      'the base differs from the header branch',
    )

    const s = mount({
      source: { handle, chain: engine.chain('three-step') },
      columns: 100,
      rows: 30,
    })
    const first = stripVTControlCharacters(s.frames.frames[0] ?? '')
    await s.press(KEYS.left)
    const review = s.lines().join('\n')
    await s.press(KEYS.left)
    const baseline = s.lines().join('\n')

    expect(first).toContain(`⎇ ${base} (in place)`)
    expect(first).toMatch(/· complete\n/)
    expect(first).toContain('wrap-up-ok')
    expect(
      s.frames.frames.map((f) => stripVTControlCharacters(f)).filter((f) => f.includes('running')),
    ).toEqual([])
    expect(review).toContain('Hello, I will look at the README.')
    expect(review).toContain('▸ Read README.md')
    expect(review).toContain('The README is a single heading.')
    expect(baseline).toContain('baseline-ok')
  }, 20_000)

  it('shows only its own steps and transcripts when the screen is left mid-run, a second chain runs, and the first is opened again', async () => {
    env = await engineRepo(['sleep-first', 'fresh-twice'])
    const engine = await env.open()
    const first = await env.start(engine, 'sleep-first')
    await eventMatching(first, (e) => e.type === 'step.started' && e.step === 'wait')
    const firstChain = engine.chain('sleep-first')

    const leaving = mount({ source: { handle: first, chain: firstChain } })
    await effects()
    leaving.frames.stdin.write(KEYS.esc)
    await settles(() => expect(leaving.navigate).toHaveBeenCalledWith({ name: 'chains' }))
    leaving.frames.unmount()

    const second = await env.start(engine, 'fresh-twice')
    const other = mount({ source: { handle: second, chain: engine.chain('fresh-twice') } })
    await finished(second)
    await settles(() => expect(other.lines().join('\n')).toContain('README'))
    other.frames.unmount()

    const back = mount({ source: { handle: first, chain: firstChain } })
    await effects()
    const onWait = back.lines().join('\n')
    await back.press(KEYS.right)
    const onReview = back.lines().join('\n')

    for (const frame of [onWait, onReview]) {
      expect(frame).not.toContain('first-pass')
      expect(frame).not.toContain('second-pass')
      expect(frame).not.toContain('README')
      expect(frame).toContain(`run ${first.id.slice(-4)}`)
    }
    expect(onWait).toMatch(/● wait/)
    expect(onWait).toMatch(/· running\n/)
    expect(onReview).toContain('not started')
  }, 20_000)

  it('renders a finished run from its directory without a handle, a crashed writer’s partial lines skipped', async () => {
    env = await engineRepo(['three-step'])
    const engine = await env.open()
    const handle = await env.start(engine, 'three-step')
    await finished(handle)
    const dir = openRunDir(path.dirname(handle.dir), path.basename(handle.dir))
    await appendFile(dir.events, '{"seq":11,"t":"2026-11-08T11:2')
    await appendFile(dir.agentFile('review', 'fake', 'transcript.jsonl'), '{"t":"2026-11-08T11:2')

    const s = mount({ source: { dir } })
    await settles(() => expect(statusRow(s)).toMatch(/· complete$/))
    await s.type('a')
    const onWrapUp = s.lines().join('\n')
    await s.press(KEYS.left)
    const onReview = s.lines().join('\n')

    expect(onWrapUp).toContain('wrap-up-ok')
    expect(onWrapUp).toContain(`run ${handle.id.slice(-4)}`)
    expect(noteRow(s)).toContain('› note for the next steps…')
    expect(onReview).toContain('The README is a single heading.')
    expect(onReview).toContain('› fake')
  }, 20_000)
})

// --- the running mock ------------------------------------------------------

describe('the running mock fed with a fake-provider run', () => {
  let env: EngineRepo | undefined
  let recorded: {
    events: ReadonlyArray<RunEvent>
    review: TranscriptRecord[]
    chain: ResolvedChain
  }

  beforeAll(async () => {
    env = await engineRepo(['three-step'])
    const engine = await env.open()
    const handle: RunHandle = await env.start(engine, 'three-step')
    const { events } = await finished(handle)
    recorded = {
      events,
      review: handle.transcript('review', 'fake').slice(0, 99),
      chain: engine.chain('three-step'),
    }
  })

  afterAll(async () => {
    await env?.cleanup()
  })

  it('draws the plan’s layout while the agent step is running', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW })
    // The recorded events through the review agent's spawn, retimed: a 4:12 run, the agent 1:39 in.
    const through = recorded.events.filter((e) => e.seq <= 5)
    const times = [252, 252, 251, 99, 99]
    const history = through.map((e, i) => ({ ...e, t: ago(times[i] ?? 0) }))
    const run = scriptedRun({ id: '2026-11-08_1120_three-step_7f3a', dir: RUN_DIR, history })
    run.seed('review', 'fake', recorded.review.slice(0, 2))
    run.delta('review', 'fake', 'The README is a single')

    const s = mount({
      source: { handle: run.handle, chain: recorded.chain },
      columns: 80,
      rows: 16,
    })
    await effects()

    const rule = (n: number) => '─'.repeat(n)
    expect(s.lines()).toEqual([
      `⎇ main (in place)  ~/Repos/trezor-suite${' '.repeat(31)}tdd-review`,
      rule(80),
      `${' '.repeat(55)}run 7f3a · 4:12 · running`,
      '',
      // leftCols: `baseline` (8) + 6 = 14; transcriptCols: 80 − 14 − 3 = 63.
      '  ✓ baseline  │  review',
      `  ● review    │  ${rule(63)}`,
      '  ○ wrap-up   │  › fake       fake · default             ⠋ 1:39',
      `              │  ${rule(63)}`,
      '              │  Hello, I will look at the README.',
      '              │  ▸ Read README.md',
      '              │  The README is a single',
      '              │',
      '              │',
      `╭${rule(78)}╮`,
      `│ › note for the next steps…${' '.repeat(51)}│`,
      `╰${rule(78)}╯`,
    ])
  })
})
