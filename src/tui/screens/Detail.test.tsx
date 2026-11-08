import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { Box } from 'ink'
import { afterAll, afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type LaunchCheck,
  RensaError,
  type ResolvedChain,
  type RunHandle,
  type RunResult,
  type Step,
} from '../../engine/index.js'
import { type Frames, renderFrames } from '../../testing/inkFrames.js'
import { agentStep, resolvedChain, shellStep } from '../../testing/steps.js'
import type { Navigate } from '../app.js'
import { Header } from '../components/Header.js'
import { SizeProvider } from '../size.js'
import type { Mode } from '../terminalSession.js'
import { theme } from '../theme.js'
import { Detail, type DetailEngine } from './Detail.js'

// Colors and backgrounds carry the status levels and the painting rule;
// force truecolor before Ink (and its chalk) load.
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
 * The terminal cursor is Ink's, placed through `useCursor`; in debug
 * rendering it never reaches stdout. Record the last position asked for,
 * passing it on to Ink unchanged.
 */
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

const fg = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`
const TEXT = fg(230, 230, 230) // theme.text #e6e6e6
const MUTED = fg(154, 154, 154) // theme.muted #9a9a9a
const WARN = fg(217, 184, 106) // theme.warn #d9b86a
const ERR = fg(212, 122, 122) // theme.err #d47a7a

const KEYS = {
  enter: '\r',
  esc: '\x1b',
  left: '\x1b[D',
  right: '\x1b[C',
  backspace: '\x7f',
  ctrlC: '\x03',
} as const

// --- fixtures --------------------------------------------------------------

const TDD_REVIEW_DESCRIPTION =
  'Tests first, implementation, three reviewers, routed fixes, re-test.'

/** The plan's mock chain. */
const TDD_REVIEW: ResolvedChain = resolvedChain(
  'tdd-review',
  [
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
  ],
  { description: TDD_REVIEW_DESCRIPTION, input: 'text' },
)

const NIGHTLY_AUDIT: ResolvedChain = resolvedChain(
  'nightly-audit',
  [shellStep('audit', 'npm audit --omit=dev')],
  { description: 'Audit dependencies.', input: 'none' },
)

const RELEASE_NOTES: ResolvedChain = resolvedChain(
  'release-notes',
  [agentStep('draft', { label: 'writer', provider: 'claude' })],
  { description: 'Drafts release notes from a brief.', input: 'file' },
)

const LOAD_ERROR = new RensaError(
  'CONFIG_INVALID',
  'agents.codex: unknown provider "codx"',
  '.rensa/broken-chain.yaml',
)

const CLEAN: LaunchCheck = { ok: true, message: 'working tree clean' }
const DIRTY: LaunchCheck = {
  ok: false,
  message: 'working tree has uncommitted changes; commit or stash to start',
  level: 'warn',
}
const RUN_ID = '2026-11-08_1120_tdd-review_4f2a'
const LOCKED: LaunchCheck = {
  ok: false,
  message: 'another run is active: 2026-11-08_1104_tdd-review_9b1c',
  level: 'err',
}

function fakeRun(id: string): RunHandle {
  return {
    id,
    dir: `/Users/ryowa/Repos/trezor-suite/.rensa/runs/${id}`,
    pause() {},
    resume() {},
    kill() {},
    abort() {},
    note() {},
    done: new Promise<RunResult>(() => {}),
    result: () => undefined,
    transcript() {
      throw new Error('the detail screen reads no transcript')
    },
    partial: () => undefined,
    events: () => [],
    attach() {
      throw new Error('the detail screen attaches to no run')
    },
  }
}

/**
 * The engine surface the screen uses. `preflight` answers with `check`
 * at once, or, between `hold()` and `release()`, once released.
 */
class StubEngine implements DetailEngine {
  readonly version = '0.1.0'
  check: LaunchCheck
  private held: Array<() => void> | undefined
  readonly preflight = vi.fn(
    (_name: string): Promise<LaunchCheck> =>
      new Promise((resolve) => {
        const answer = () => resolve(this.check)
        if (this.held === undefined) answer()
        else this.held.push(answer)
      }),
  )
  readonly start = vi.fn<DetailEngine['start']>(async () => fakeRun(RUN_ID))
  readonly recheckProviders = vi.fn<DetailEngine['recheckProviders']>(async () => [])

  constructor(
    readonly root: string,
    private readonly chains: ReadonlyArray<ResolvedChain | { name: string; error: RensaError }>,
    check: LaunchCheck = CLEAN,
  ) {
    this.check = check
  }

  chain(name: string): ResolvedChain {
    const found = this.chains.find((c) => c.name === name)
    if (found === undefined) throw new RensaError('CHAIN_NOT_FOUND', `no chain named \`${name}\``)
    if ('error' in found) throw found.error
    return found
  }

  hold(): void {
    this.held ??= []
  }

  release(): void {
    const held = this.held ?? []
    this.held = undefined
    for (const answer of held) answer()
  }
}

// --- rendering -------------------------------------------------------------

let view: Frames | undefined
let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'rensa-detail-'))
  cursor.last = undefined
})

afterEach(async () => {
  view?.unmount()
  view = undefined
  await rm(root, { recursive: true, force: true })
})

/** Lets React run the passive effects the last render scheduled. */
const effects = () => new Promise<void>((resolve) => setImmediate(resolve))

/** Waits for a frame or call caused by a promise outside React's input path. */
const settles = (assertion: () => void) => vi.waitFor(assertion, { timeout: 1000 })

interface Cell {
  char: string
  /** The SGR background behind the cell, e.g. `48;2;42;42;42`; undefined when none. */
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

/** The background after one SGR sequence's parameters. */
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

/** Any SGR background escape, truecolor or 256-color. */
const ANY_BG = '\x1b[48;'

function bgOf(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16)
  return `48;2;${(n >> 16) & 0xff};${(n >> 8) & 0xff};${n & 0xff}`
}
const SELECTION_BG = bgOf(theme.selection)
const ROOT_BG = bgOf(theme.background)

interface Screen {
  view: Frames
  engine: StubEngine
  navigate: ReturnType<typeof vi.fn<Navigate>>
  requestQuit: ReturnType<typeof vi.fn<() => void>>
  press(input: string, times?: number): Promise<void>
  type(text: string): Promise<void>
  /** The last frame without escapes, trailing spaces trimmed. */
  lines(): string[]
  /** The last frame's rows with their escapes. */
  raw(): string[]
}

function mount(opts: {
  engine: StubEngine
  chain: string
  columns?: number
  rows?: number
  mode?: Mode
  active?: boolean
}): Screen {
  const { engine, chain } = opts
  const columns = opts.columns ?? 74
  const rows = opts.rows ?? 30
  const mode = opts.mode ?? 'inline'
  const navigate = vi.fn<Navigate>()
  const requestQuit = vi.fn<() => void>()
  const detail = (
    <Detail
      engine={engine}
      chain={chain}
      navigate={navigate}
      requestQuit={requestQuit}
      active={opts.active ?? true}
      mode={mode}
      header={
        <Header
          branch="feat/quote-limits"
          mode="in place"
          path="~/Repos/trezor-suite"
          right={chain}
        />
      }
    />
  )
  // What app.tsx does: the fullscreen root alone carries theme.background.
  const tree = (
    <SizeProvider columns={columns} rows={rows}>
      {mode === 'fullscreen' ? (
        <Box
          width={columns}
          height={rows}
          flexDirection="column"
          backgroundColor={theme.background}
        >
          {detail}
        </Box>
      ) : (
        detail
      )}
    </SizeProvider>
  )
  const v = renderFrames(tree, { columns, rows })
  view = v
  return {
    view: v,
    engine,
    navigate,
    requestQuit,
    async press(input, times = 1) {
      for (let i = 0; i < times; i++) {
        v.stdin.write(input)
        await effects()
      }
    },
    async type(text) {
      for (const char of text) {
        v.stdin.write(char)
        await effects()
      }
    },
    lines: () =>
      stripVTControlCharacters(v.lastFrame())
        .split('\n')
        .map((l) => l.trimEnd()),
    raw: () => v.lastFrame().split('\n'),
  }
}

/** Mounts and waits for the mount-time launch check to reach the screen. */
async function mounted(opts: Parameters<typeof mount>[0]): Promise<Screen> {
  const s = mount(opts)
  await settles(() => expect(opts.engine.preflight).toHaveBeenCalled())
  await effects()
  return s
}

const rule = (n: number) => '─'.repeat(n)

/**
 * The plan's mock at 74 columns, by the plan's rules where the drawing
 * disagrees with them: the frame spans the width with one space of
 * padding (step 11's `Frame`), and the id column is the longest id
 * (`review-codex`, 12) + 2.
 */
const MOCK_FRAME = [
  '⎇ feat/quote-limits (in place)  ~/Repos/trezor-suite            tdd-review',
  rule(74),
  '',
  `╭${rule(72)}╮`,
  `│ rensa 0.1.0${' '.repeat(60)}│`,
  `│${' '.repeat(72)}│`,
  `│ tdd-review${' '.repeat(61)}│`,
  `│ ${TDD_REVIEW_DESCRIPTION}${' '.repeat(71 - TDD_REVIEW_DESCRIPTION.length)}│`,
  `╰${rule(72)}╯`,
  '',
  '  ○ baseline      npm test',
  '  ○ write-tests',
  '    tester        claude · opus · high',
  '  ○ implement',
  '    impl          claude · opus · high',
  '  ○ test          npm test',
  '  ○ review-codex',
  '    codex         codex · default · medium',
  '  ○ retest        npm test',
  '',
  '  working tree clean',
  '',
  `╭${rule(72)}╮`,
  `│ ›${' '.repeat(70)}│`,
  `╰${rule(72)}╯`,
]

/** The row index of the input box's text row: the one that starts with `│ ›`. */
function promptRow(lines: string[]): number {
  return lines.findIndex((l) => l.startsWith('│ ›'))
}

// --- tests -----------------------------------------------------------------

describe('the frame of a chain with a text input', () => {
  it('matches the plan mock when the tdd-review chain is shown on a clean tree', async () => {
    const s = await mounted({ engine: new StubEngine(root, [TDD_REVIEW]), chain: 'tdd-review' })

    expect(s.lines()).toEqual(MOCK_FRAME)
  })

  it('draws the version and description in muted and the chain name in text', async () => {
    const s = await mounted({ engine: new StubEngine(root, [TDD_REVIEW]), chain: 'tdd-review' })

    const frame = s.view.lastFrame()
    expect(frame).toContain(`${MUTED}rensa 0.1.0`)
    expect(frame).toContain(`${TEXT}tdd-review`)
    expect(frame).toContain(`${MUTED}${TDD_REVIEW_DESCRIPTION}`)
  })

  it('renders the input box with the › prompt and no press enter line when input is text', async () => {
    const s = await mounted({ engine: new StubEngine(root, [TDD_REVIEW]), chain: 'tdd-review' })

    const lines = s.lines()
    expect(lines.slice(-3)).toEqual(MOCK_FRAME.slice(-3))
    expect(lines).not.toContain('  press enter to start')
  })

  it('shows the placeholder path to file in the box when input is file and the box is empty', async () => {
    const s = await mounted({
      engine: new StubEngine(root, [RELEASE_NOTES]),
      chain: 'release-notes',
    })

    expect(s.lines().at(-2)).toBe(`│ › path to file${' '.repeat(57)}│`)
  })
})

describe('the frame of a chain with no input', () => {
  it('renders press enter to start in muted and no input box when input is none', async () => {
    const s = await mounted({
      engine: new StubEngine(root, [NIGHTLY_AUDIT], { ok: true }),
      chain: 'nightly-audit',
    })

    const lines = s.lines()
    expect(lines.at(-1)).toBe('  press enter to start')
    expect(s.view.lastFrame()).toContain(`${MUTED}  press enter to start`)
    expect(promptRow(lines)).toBe(-1)
  })
})

describe('the frame of a chain that failed to load', () => {
  it('shows the load error in err in place of the description and only esc back below the frame', async () => {
    const s = mount({
      engine: new StubEngine(root, [{ name: 'broken-chain', error: LOAD_ERROR }]),
      chain: 'broken-chain',
    })
    await effects()

    const lines = s.lines()
    const bottom = lines.findIndex((l) => l.startsWith('╰'))
    expect(lines[bottom - 1]).toBe(`│ agents.codex: unknown provider "codx"${' '.repeat(71 - 37)}│`)
    expect(s.view.lastFrame()).toContain(`${ERR}agents.codex: unknown provider "codx"`)
    expect(lines.slice(bottom + 1).filter((l) => l !== '')).toEqual(['  esc back'])
  })

  it('goes back to chains on esc and starts nothing on enter when the chain failed to load', async () => {
    const engine = new StubEngine(root, [{ name: 'broken-chain', error: LOAD_ERROR }])
    const s = mount({ engine, chain: 'broken-chain' })
    await effects()

    await s.press(KEYS.enter)
    await effects()
    await s.press(KEYS.esc)

    await settles(() => expect(s.navigate.mock.calls).toEqual([[{ name: 'chains' }]]))
    expect(engine.start).not.toHaveBeenCalled()
  })
})

describe('the status line from the launch check', () => {
  it('shows working tree clean in muted when the check passes with that message', async () => {
    const s = await mounted({ engine: new StubEngine(root, [TDD_REVIEW]), chain: 'tdd-review' })

    expect(s.view.lastFrame()).toContain(`${MUTED}  working tree clean`)
  })

  it('shows nothing on the status line when the check passes without a message', async () => {
    const s = await mounted({
      engine: new StubEngine(root, [TDD_REVIEW], { ok: true }),
      chain: 'tdd-review',
    })

    const lines = s.lines()
    expect(lines[20]).toBe('')
    expect(lines.join('\n')).not.toContain('working tree')
  })

  it('shows the dirty tree refusal in warn when the check fails with level warn', async () => {
    const s = await mounted({
      engine: new StubEngine(root, [TDD_REVIEW], DIRTY),
      chain: 'tdd-review',
    })

    expect(s.lines()[20]).toBe('  ! working tree has uncommitted changes; commit or stash to start')
    expect(s.view.lastFrame()).toContain(
      `${WARN}  ! working tree has uncommitted changes; commit or stash to start`,
    )
  })

  it.each([
    ['a missing provider', 'grok is not installed; this chain cannot start'],
    ['a logged-out provider', 'codex is not logged in (run: codex login); this chain cannot start'],
    ['another active run', 'another run is active: 2026-11-08_1104_tdd-review_9b1c'],
  ])('shows the refusal in err when the check fails for %s', async (_, message) => {
    const s = await mounted({
      engine: new StubEngine(root, [TDD_REVIEW], { ok: false, message, level: 'err' }),
      chain: 'tdd-review',
    })

    expect(s.lines()[20]).toBe(`  ! ${message}`)
    expect(s.view.lastFrame()).toContain(`${ERR}  ! ${message}`)
  })

  it('shows the new check after a key press when the tree became dirty since mount', async () => {
    const engine = new StubEngine(root, [TDD_REVIEW])
    const s = await mounted({ engine, chain: 'tdd-review' })

    engine.check = DIRTY
    await s.type('f')

    await settles(() =>
      expect(s.lines()[20]).toBe(
        '  ! working tree has uncommitted changes; commit or stash to start',
      ),
    )
  })
})

describe('typing and starting a run with a text input', () => {
  it('does not call start when enter is pressed with an empty box', async () => {
    const engine = new StubEngine(root, [TDD_REVIEW])
    const s = await mounted({ engine, chain: 'tdd-review' })

    await s.press(KEYS.enter)
    // Whatever enter set off has answered: no check is pending and none is held.
    await effects()
    await effects()

    expect(engine.start).not.toHaveBeenCalled()
    expect(s.navigate).not.toHaveBeenCalled()
  })

  it('does not call start when enter is pressed with only spaces in the box', async () => {
    const engine = new StubEngine(root, [TDD_REVIEW])
    const s = await mounted({ engine, chain: 'tdd-review' })

    await s.type('   ')
    await s.press(KEYS.enter)
    await effects()
    await effects()

    expect(engine.start).not.toHaveBeenCalled()
  })

  it('calls start once with the typed text and navigates to the run when enter is pressed', async () => {
    const engine = new StubEngine(root, [TDD_REVIEW])
    const s = await mounted({ engine, chain: 'tdd-review' })

    await s.type('fix the flaky quote test')
    await s.press(KEYS.enter)

    await settles(() => expect(s.navigate).toHaveBeenCalled())
    expect(engine.start.mock.calls).toEqual([
      ['tdd-review', { kind: 'text', text: 'fix the flaky quote test' }],
    ])
    const [[screen]] = s.navigate.mock.calls as [[Parameters<Navigate>[0]]]
    assert(screen.name === 'run', 'navigated to the run screen')
    expect([screen.chain, screen.run.id]).toEqual(['tdd-review', RUN_ID])
  })

  it('calls start exactly once when enter is pressed twice after typing', async () => {
    const engine = new StubEngine(root, [TDD_REVIEW])
    const s = await mounted({ engine, chain: 'tdd-review' })

    await s.type('fix the flaky quote test')
    await s.press(KEYS.enter, 2)
    await settles(() => expect(s.navigate).toHaveBeenCalled())
    await s.press(KEYS.enter)
    await effects()
    await effects()

    expect(engine.start).toHaveBeenCalledTimes(1)
    expect(s.navigate).toHaveBeenCalledTimes(1)
  })

  it('moves the caret on left and right without changing the text, starting or navigating', async () => {
    const engine = new StubEngine(root, [TDD_REVIEW])
    const s = await mounted({ engine, chain: 'tdd-review' })
    await s.type('fix')

    await s.press(KEYS.left, 2)
    const afterLeft = s.lines()[promptRow(s.lines())]
    await s.press(KEYS.right)
    await s.type('X')
    await effects()

    expect(afterLeft).toBe(`│ › fix${' '.repeat(66)}│`)
    expect(engine.start).not.toHaveBeenCalled()
    expect(s.navigate).not.toHaveBeenCalled()
    expect(s.requestQuit).not.toHaveBeenCalled()
    // left, left, right puts the caret after `fi`.
    expect(s.lines()[promptRow(s.lines())]).toBe(`│ › fiXx${' '.repeat(65)}│`)
  })

  it('puts the terminal cursor on the box text row after the typed text when focused', async () => {
    const s = await mounted({ engine: new StubEngine(root, [TDD_REVIEW]), chain: 'tdd-review' })

    await s.type('fix')
    await effects()

    const lines = s.lines()
    // `│ › ` is four cells, then the three typed.
    expect(cursor.last).toEqual({ x: 4 + 3, y: promptRow(lines) })
  })

  it('shows a start rejection in err on the status line and starts on a later enter', async () => {
    const engine = new StubEngine(root, [TDD_REVIEW])
    engine.start.mockRejectedValueOnce(
      new RensaError('LOCKED', 'another run holds the lock: 2026-11-08_1119_tdd-review_0c3d'),
    )
    const s = await mounted({ engine, chain: 'tdd-review' })
    await s.type('fix the flaky quote test')

    await s.press(KEYS.enter)
    await settles(() =>
      expect(s.lines()[20]).toBe('  ! another run holds the lock: 2026-11-08_1119_tdd-review_0c3d'),
    )
    const refusal = s.view.lastFrame()
    await s.press(KEYS.enter)

    await settles(() => expect(s.navigate).toHaveBeenCalledTimes(1))
    expect(refusal).toContain(`${ERR}  ! another run holds the lock`)
    expect(engine.start).toHaveBeenCalledTimes(2)
  })
})

describe('starting only on a fresh launch check', () => {
  it.each([
    ['a text input', TDD_REVIEW, 'fix the flaky quote test'],
    ['no input', NIGHTLY_AUDIT, ''],
  ])(
    'does not start while the lock is held, then starts once on enter when the check passes, with %s',
    async (_, chain, text) => {
      const engine = new StubEngine(root, [chain], LOCKED)
      const s = await mounted({ engine, chain: chain.name })
      await s.type(text)

      await s.press(KEYS.enter)
      await settles(() => expect(engine.preflight.mock.calls.length).toBeGreaterThan(1))
      await effects()
      const startsWhileLocked = engine.start.mock.calls.length
      const refusal = s.lines().find((l) => l.startsWith('  !'))

      engine.check = { ok: true }
      await s.press(KEYS.enter)
      await settles(() => expect(s.navigate).toHaveBeenCalled())

      expect(startsWhileLocked).toBe(0)
      expect(refusal).toBe('  ! another run is active: 2026-11-08_1104_tdd-review_9b1c')
      expect(engine.start).toHaveBeenCalledTimes(1)
    },
  )

  it.each([
    ['a text input', TDD_REVIEW, 'fix the flaky quote test'],
    ['no input', NIGHTLY_AUDIT, ''],
  ])(
    'starts once when enter is pressed twice while the fresh check is still pending, with %s',
    async (_, chain, text) => {
      const engine = new StubEngine(root, [chain], LOCKED)
      const s = await mounted({ engine, chain: chain.name })
      await s.type(text)
      engine.check = { ok: true }
      engine.hold()

      await s.press(KEYS.enter)
      await s.press(KEYS.enter)
      const startsWhilePending = engine.start.mock.calls.length
      engine.release()
      await settles(() => expect(s.navigate).toHaveBeenCalled())
      await effects()
      await effects()

      expect(startsWhilePending).toBe(0)
      expect(engine.start).toHaveBeenCalledTimes(1)
    },
  )

  it('does not start when the mount check passed but the fresh check on enter fails', async () => {
    const engine = new StubEngine(root, [TDD_REVIEW])
    const s = await mounted({ engine, chain: 'tdd-review' })
    await s.type('fix the flaky quote test')
    const callsBefore = engine.preflight.mock.calls.length

    engine.check = LOCKED
    await s.press(KEYS.enter)
    await settles(() =>
      expect(s.lines()[20]).toBe('  ! another run is active: 2026-11-08_1104_tdd-review_9b1c'),
    )

    expect(engine.preflight.mock.calls.length).toBeGreaterThan(callsBefore)
    expect(engine.start).not.toHaveBeenCalled()
  })

  it('calls start with input none when enter is pressed on a chain with no input', async () => {
    const engine = new StubEngine(root, [NIGHTLY_AUDIT], { ok: true })
    const s = await mounted({ engine, chain: 'nightly-audit' })

    await s.press(KEYS.enter)

    await settles(() => expect(s.navigate).toHaveBeenCalled())
    expect(engine.start.mock.calls).toEqual([['nightly-audit', { kind: 'none' }]])
  })
})

describe('starting a run with a file input', () => {
  it('starts with the absolute path when the typed path relative to the repo root exists', async () => {
    await mkdir(path.join(root, 'notes'))
    await writeFile(path.join(root, 'notes', 'brief.md'), '# Release 26.11\n')
    const engine = new StubEngine(root, [RELEASE_NOTES])
    const s = await mounted({ engine, chain: 'release-notes' })

    await s.type('notes/brief.md')
    await s.press(KEYS.enter)

    await settles(() => expect(s.navigate).toHaveBeenCalled())
    expect(engine.start.mock.calls).toEqual([
      ['release-notes', { kind: 'file', path: path.join(root, 'notes', 'brief.md') }],
    ])
  })

  it('shows file not found in err and does not start when the typed path does not exist', async () => {
    const engine = new StubEngine(root, [RELEASE_NOTES])
    const s = await mounted({ engine, chain: 'release-notes' })

    await s.type('notes/missing.md')
    await s.press(KEYS.enter)
    await effects()
    await effects()

    const status = s.lines().find((l) => l.includes('file not found'))
    expect(status).toBe('  ! file not found: notes/missing.md')
    expect(s.view.lastFrame()).toContain(`${ERR}  ! file not found: notes/missing.md`)
    expect(engine.start).not.toHaveBeenCalled()
  })

  it('does not call start when enter is pressed with an empty path', async () => {
    const engine = new StubEngine(root, [RELEASE_NOTES])
    const s = await mounted({ engine, chain: 'release-notes' })

    await s.press(KEYS.enter)
    await effects()
    await effects()

    expect(engine.start).not.toHaveBeenCalled()
    expect(s.lines().join('\n')).not.toContain('file not found')
  })
})

describe('leaving the screen', () => {
  it.each([
    ['text', TDD_REVIEW],
    ['none', NIGHTLY_AUDIT],
  ])('goes back to chains on esc when input is %s', async (_, chain) => {
    const s = await mounted({ engine: new StubEngine(root, [chain]), chain: chain.name })

    await s.press(KEYS.esc)

    // Ink holds a lone ESC for 20 ms in case an escape sequence follows.
    await settles(() => expect(s.navigate.mock.calls).toEqual([[{ name: 'chains' }]]))
  })

  it('asks the app to quit on ctrl+c', async () => {
    const s = await mounted({ engine: new StubEngine(root, [TDD_REVIEW]), chain: 'tdd-review' })

    await s.press(KEYS.ctrlC)

    expect(s.requestQuit).toHaveBeenCalledTimes(1)
    expect(s.navigate).not.toHaveBeenCalled()
  })

  it('ignores typing, enter and esc while an app-level overlay holds the keys (active false)', async () => {
    const engine = new StubEngine(root, [TDD_REVIEW])
    const s = await mounted({ engine, chain: 'tdd-review', active: false })

    await s.type('fix')
    await s.press(KEYS.enter)
    await s.press(KEYS.esc)
    // Past Ink's 20 ms hold on a lone ESC.
    await new Promise((resolve) => setTimeout(resolve, 50))
    await effects()

    expect(s.lines()[promptRow(s.lines())]).toBe(MOCK_FRAME.at(-2))
    expect(engine.start).not.toHaveBeenCalled()
    expect(s.navigate).not.toHaveBeenCalled()
  })
})

describe('layout at the terminal size', () => {
  /** 20 shell steps: more than the 14 timeline rows 100×30 leaves. */
  const LONG_CHAIN: ResolvedChain = resolvedChain(
    'long-chain',
    Array.from(
      { length: 20 },
      (_, i): Step => shellStep(`check-${i + 1}`, `npm run check:${i + 1}`),
    ),
    { description: 'Twenty checks in a row.', input: 'text' },
  )

  it.each<Mode>(['fullscreen', 'inline'])(
    'keeps the input box on the last rows and clips the timeline when the steps do not fit at 100x30 (%s)',
    async (mode) => {
      const s = await mounted({
        engine: new StubEngine(root, [LONG_CHAIN]),
        chain: 'long-chain',
        columns: 100,
        rows: 30,
        mode,
      })

      const lines = s.lines()
      const stepRows = lines.filter((l) => /^ {2}○ check-\d+ /.test(l))
      const shownIds = stepRows.map((l) => l.trim().split(/\s+/)[1])
      expect(lines).toHaveLength(30)
      expect(lines.slice(-3).map((l) => l[0])).toEqual(['╭', '│', '╰'])
      expect(lines[27]).toMatch(/^╭─+╮$/)
      expect(lines[28]).toMatch(/^│ › +│$/)
      expect(lines).toContain('  working tree clean')
      expect(lines.indexOf('  working tree clean')).toBeGreaterThan(
        lines.indexOf(stepRows.at(-1) ?? ''),
      )
      expect(shownIds).toEqual(Array.from({ length: shownIds.length }, (_, i) => `check-${i + 1}`))
      expect(shownIds.length).toBeGreaterThan(0)
      expect(shownIds.length).toBeLessThan(20)
    },
  )

  it('truncates the description and a long step detail with … when narrow at 50 columns', async () => {
    const chain = resolvedChain(
      'tdd-review',
      [shellStep('baseline', 'npm test -- --run src/engine/engine.preflight.test.ts')],
      { description: TDD_REVIEW_DESCRIPTION, input: 'text' },
    )
    const s = await mounted({
      engine: new StubEngine(root, [chain]),
      chain: 'tdd-review',
      columns: 50,
    })

    const lines = s.lines()
    const description = lines.find((l) => l.startsWith('│ Tests first'))
    const baseline = lines.find((l) => l.startsWith('  ○ baseline'))
    expect(description).toBe(`│ ${TDD_REVIEW_DESCRIPTION.slice(0, 45)}… │`)
    expect(baseline).toBe(
      `  ○ baseline  ${'npm test -- --run src/engine/engine.preflight.test.ts'.slice(0, 35)}…`,
    )
    expect(lines.every((l) => l.length <= 50)).toBe(true)
  })

  it('collapses the footer to one bare row with the › prompt and the typed text when short at 60x8', async () => {
    const s = await mounted({
      engine: new StubEngine(root, [TDD_REVIEW]),
      chain: 'tdd-review',
      columns: 60,
      rows: 8,
      mode: 'fullscreen',
    })

    await s.type('fix the flaky test')
    await effects()

    const lines = s.lines()
    const last = s.raw().at(-1) ?? ''
    const promptCells = cellsOf(last).slice(1, 1 + '› fix the flaky test'.length)
    expect(lines).toHaveLength(8)
    expect(lines.at(-1)).toBe(' › fix the flaky test')
    expect(lines.filter((l) => l.includes('›'))).toEqual([' › fix the flaky test'])
    expect(promptCells.map((c) => c.char).join('')).toBe('› fix the flaky test')
    expect(promptCells.filter((c) => c.bg !== SELECTION_BG)).toEqual([])
    // One cell of padding, `› `, then the typed text.
    expect(cursor.last).toEqual({ x: 1 + 2 + 'fix the flaky test'.length, y: 7 })
  })
})

describe('painting', () => {
  /** The input box: its three rows and, on the text row, the interior between the borders. */
  function inputBox(raw: string[]): { border: Cell[]; interior: Cell[] } {
    const rows = raw.slice(-3).map(cellsOf)
    const [top = [], middle = [], bottom = []] = rows
    return {
      border: [...top, middle[0], middle.at(-1), ...bottom].filter(
        (c): c is Cell => c !== undefined,
      ),
      interior: middle.slice(1, -1),
    }
  }

  it('paints the focused box interior with theme.selection and its border with the root background in fullscreen', async () => {
    const s = await mounted({
      engine: new StubEngine(root, [TDD_REVIEW]),
      chain: 'tdd-review',
      mode: 'fullscreen',
    })
    await s.type('fix')
    await effects()

    const { border, interior } = inputBox(s.raw())

    expect(
      interior
        .map((c) => c.char)
        .join('')
        .trimEnd(),
    ).toBe(' › fix')
    expect(interior.filter((c) => c.bg !== SELECTION_BG)).toEqual([])
    expect(border.filter((c) => c.bg !== ROOT_BG)).toEqual([])
  })

  it('paints no background anywhere but the focused box interior in inline mode', async () => {
    const s = await mounted({
      engine: new StubEngine(root, [TDD_REVIEW]),
      chain: 'tdd-review',
      mode: 'inline',
    })
    await s.type('fix')
    await effects()

    const raw = s.raw()
    const { interior } = inputBox(raw)
    const elsewhere = [...raw.slice(0, -3).flatMap(cellsOf), ...inputBox(raw).border].filter(
      (c) => c.bg !== undefined,
    )

    expect(interior.filter((c) => c.bg !== SELECTION_BG)).toEqual([])
    expect(elsewhere).toEqual([])
  })

  it('paints no background at all in inline mode when the chain has no input box', async () => {
    const s = await mounted({
      engine: new StubEngine(root, [NIGHTLY_AUDIT], { ok: true }),
      chain: 'nightly-audit',
      mode: 'inline',
    })

    expect(s.view.lastFrame()).not.toContain(ANY_BG)
  })
})
