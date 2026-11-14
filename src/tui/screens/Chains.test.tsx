import { EventEmitter } from 'node:events'
import { stripVTControlCharacters } from 'node:util'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { ChainSummary, ProviderStatus } from '../../engine/index.js'
import { RensaError } from '../../engine/index.js'
import { type Frames, renderFrames } from '../../testing/inkFrames.js'
import type { Navigate } from '../app.js'
import { createWheelHub, type WheelHub } from '../mouse.js'
import { SizeProvider } from '../size.js'
import { SessionContext, type SessionControls } from '../terminalSession.js'
import { Chains, type ChainsEngine } from './Chains.js'

// Colors carry the selection and the provider states; force truecolor
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

const fg = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`
const TEXT = fg(230, 230, 230) // theme.text #e6e6e6
const MUTED = fg(154, 154, 154) // theme.muted #9a9a9a
const DIM = fg(92, 92, 92) // theme.dim #5c5c5c
const ACCENT = fg(232, 137, 63) // theme.accent #e8893f
const WARN = fg(217, 184, 106) // theme.warn #d9b86a
const ERR = fg(212, 122, 122) // theme.err #d47a7a

const KEYS = {
  up: '\x1b[A',
  down: '\x1b[B',
  enter: '\r',
  esc: '\x1b',
  ctrlR: '\x12',
  ctrlC: '\x03',
} as const

// --- engine stub -----------------------------------------------------------

const CLAUDE_READY: ProviderStatus = {
  provider: 'claude',
  availability: { status: 'ready', version: '2.1.3' },
}
const CODEX_LOGGED_OUT: ProviderStatus = {
  provider: 'codex',
  availability: { status: 'not_logged_in', version: '0.48', hint: 'run: codex login' },
}
const GROK_MISSING: ProviderStatus = {
  provider: 'grok',
  availability: { status: 'not_installed' },
}
const MOCK_STATUSES: ProviderStatus[] = [CLAUDE_READY, CODEX_LOGGED_OUT, GROK_MISSING]

interface ChainFixture {
  name: string
  description?: string
  error?: RensaError
  /** Providers the chain uses; the stub derives `missingProviders` from them as the engine does. */
  uses: ProviderStatus['provider'][]
}

const TDD_REVIEW: ChainFixture = {
  name: 'tdd-review',
  description: 'Tests first, implementation, three reviewers, routed fixes, re-test.',
  uses: ['claude', 'grok'],
}
const REVIEW_ONLY: ChainFixture = {
  name: 'review-only',
  description: 'Three reviewers on the current diff.',
  uses: ['claude'],
}
const NIGHTLY_AUDIT: ChainFixture = {
  name: 'nightly-audit',
  error: new RensaError(
    'CONFIG_INVALID',
    'agents.codex: unknown provider "codx"',
    '.rensa/nightly-audit.yaml',
  ),
  uses: [],
}
const MOCK_CHAINS: ChainFixture[] = [TDD_REVIEW, REVIEW_ONLY, NIGHTLY_AUDIT]

/**
 * The engine surface the screen reads, with the engine's contract:
 * `providers()` is undefined until a check completes, `missingProviders`
 * is empty until then, and a completed check emits `'providers'`.
 */
class StubEngine extends EventEmitter<{ providers: [ProviderStatus[]] }> {
  private statuses: ProviderStatus[] | undefined
  /** Resolves the recheck in flight, if any. */
  private pendingRecheck: ((statuses: ProviderStatus[]) => void) | undefined
  readonly recheckProviders = vi.fn(
    () =>
      new Promise<ProviderStatus[]>((resolve) => {
        this.pendingRecheck = resolve
      }),
  )

  constructor(
    private readonly fixtures: ChainFixture[],
    statuses?: ProviderStatus[],
  ) {
    super()
    this.statuses = statuses
  }

  providers(): ProviderStatus[] | undefined {
    return this.statuses
  }

  chains(): ChainSummary[] {
    return this.fixtures.map((f) => ({
      name: f.name,
      ...(f.description !== undefined && { description: f.description }),
      ...(f.error !== undefined && { error: f.error }),
      missingProviders: this.missing(f.uses),
    }))
  }

  /** A check landing: stores the statuses, then emits as the engine does. */
  completeCheck(statuses: ProviderStatus[]): void {
    this.statuses = statuses
    this.pendingRecheck?.(statuses)
    this.pendingRecheck = undefined
    this.emit('providers', statuses)
  }

  private missing(uses: ProviderStatus['provider'][]): ProviderStatus[] {
    const statuses = this.statuses
    if (statuses === undefined) return []
    return uses.flatMap((p) => {
      const status = statuses.find((s) => s.provider === p)
      return status !== undefined && status.availability.status !== 'ready' ? [status] : []
    })
  }
}

// --- rendering -------------------------------------------------------------

let view: Frames | undefined

afterEach(() => {
  view?.unmount()
  view = undefined
  vi.unstubAllEnvs()
})

/**
 * The stub as the screen's engine. `ChainsEngine` picks `on`/`off` from
 * `Engine`, whose `this` return type is `Engine`, so no stub satisfies it
 * structurally; the screen never uses the return value.
 */
const asChainsEngine = (stub: StubEngine): ChainsEngine => stub as unknown as ChainsEngine

/** Lets React run the passive effects the last render scheduled. */
const effects = () => new Promise<void>((resolve) => setImmediate(resolve))

/**
 * Waits for the frame an engine event outside React's input path causes:
 * React commits it on a later scheduler tick than a key press.
 */
const frameSettles = (assertion: () => void) => vi.waitFor(assertion, { timeout: 1000 })

interface Screen {
  view: Frames
  engine: StubEngine
  navigate: ReturnType<typeof vi.fn<Navigate>>
  requestQuit: ReturnType<typeof vi.fn<() => void>>
  press(input: string, times?: number): Promise<void>
  /** The last frame without escapes, trailing spaces trimmed. */
  lines(): string[]
  /** Names of the chain rows behind the `›` marker; fails if one is not in `accent`. */
  selectedNames(): string[]
  /** The row (0-based, within the body) a chain's name is drawn on, or -1. */
  rowOf(name: string): number
  resize(rows: number): void
  /** A terminal width change; wrapping follows once the width settles. */
  resizeColumns(columns: number): void
  /** What the app does when an overlay comes up (false) or goes away (true). */
  setActive(active: boolean): void
}

function mount(opts: {
  engine: StubEngine
  columns?: number
  rows?: number
  initialChain?: string
  active?: boolean
  /** Wheel turns reach the screen from this hub, as the app's session hands them out. */
  wheel?: WheelHub
}): Screen {
  const { engine } = opts
  let columns = opts.columns ?? 80
  let rows = opts.rows ?? 24
  let active = opts.active ?? true
  const navigate = vi.fn<Navigate>()
  const requestQuit = vi.fn<() => void>()
  const session: SessionControls = {
    quit: () => Promise.resolve(),
    onTeardown: () => () => {},
    onWheel: (opts.wheel ?? createWheelHub()).subscribe,
  }
  const tree = (r: number) => (
    <SessionContext value={session}>
      <SizeProvider columns={columns} rows={r}>
        <Chains
          engine={asChainsEngine(engine)}
          navigate={navigate}
          requestQuit={requestQuit}
          active={active}
          footerRows={0}
          {...(opts.initialChain !== undefined && { initialChain: opts.initialChain })}
        />
      </SizeProvider>
    </SessionContext>
  )
  const v = renderFrames(tree(rows), { columns, rows })
  view = v
  const lines = () =>
    stripVTControlCharacters(v.lastFrame())
      .split('\n')
      .map((l) => l.trimEnd())
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
    lines,
    selectedNames() {
      const marked = v
        .lastFrame()
        .split('\n')
        .filter((raw) => stripVTControlCharacters(raw).startsWith('› '))
      for (const raw of marked) expect(raw).toContain(ACCENT)
      return marked.map((raw) => stripVTControlCharacters(raw).trimEnd().slice(2))
    },
    rowOf(name) {
      return lines().findIndex((l) => l === `  ${name}` || l === `› ${name}`)
    },
    resize(next) {
      rows = next
      v.resize(columns, next)
      v.rerender(tree(next))
    },
    resizeColumns(next) {
      columns = next
      v.resize(next, rows)
      v.rerender(tree(rows))
    },
    setActive(next) {
      active = next
      v.rerender(tree(rows))
    },
  }
}

/** The rule under the provider line, at the mount's default 80 columns. */
const RULE = '─'.repeat(80)

/** The plan's mock, body only: the header belongs to the app. */
const MOCK_FRAME = [
  '  claude 2.1.3   codex 0.48 · not logged in   grok not installed',
  RULE,
  '',
  '› tdd-review',
  '  Tests first, implementation, three reviewers, routed fixes, re-test.',
  '  ! needs grok',
  '',
  '  review-only',
  '  Three reviewers on the current diff.',
  '',
  '  nightly-audit',
  '  ! agents.codex: unknown provider "codx"',
]

/** Six chains, two rows each (name and description): three rows per chain with the gap. */
const SIX_CHAINS: ChainFixture[] = [
  'tdd-review',
  'review-only',
  'nightly-audit',
  'release-notes',
  'dependency-bump',
  'flaky-triage',
].map((name) => ({ name, description: `Runs the ${name} chain.`, uses: ['claude'] }))

describe('the frame with providers checked', () => {
  it('matches the mock when three providers are in the three states and one chain is broken', async () => {
    const s = mount({ engine: new StubEngine(MOCK_CHAINS, MOCK_STATUSES) })
    await effects()

    expect(s.lines()).toEqual(MOCK_FRAME)
  })

  it('colors ready providers in text, logged-out ones in muted and missing ones in dim', async () => {
    const s = mount({ engine: new StubEngine(MOCK_CHAINS, MOCK_STATUSES) })
    await effects()

    const providerLine = s.view.lastFrame().split('\n')[0] ?? ''
    expect(providerLine).toContain(`${TEXT}claude 2.1.3`)
    expect(providerLine).toContain(`${MUTED}codex 0.48 · not logged in`)
    expect(providerLine).toContain(`${DIM}grok not installed`)
  })

  it('draws the first row in accent, descriptions in muted, load errors in err and annotations in warn on mount', async () => {
    const s = mount({ engine: new StubEngine(MOCK_CHAINS, MOCK_STATUSES) })
    await effects()

    const frame = s.view.lastFrame()
    expect(s.selectedNames()).toEqual(['tdd-review'])
    expect(frame).toContain(`${TEXT}  review-only`)
    expect(frame).toContain(`${MUTED}  Three reviewers on the current diff.`)
    expect(frame).toContain(`${ERR}  ! agents.codex: unknown provider "codx"`)
    expect(frame).toContain(`${WARN}  ! needs grok`)
  })

  it('labels a logged-out provider "not logged in" and comma-joins several missing providers', async () => {
    const engine = new StubEngine(
      [{ name: 'cross-vendor', description: 'Every vendor once.', uses: ['grok', 'codex'] }],
      MOCK_STATUSES,
    )
    const s = mount({ engine })
    await effects()

    expect(s.lines()).toContain('  ! needs grok, codex not logged in')
  })

  it('hides the fake provider when RENSA_DEV is not 1', async () => {
    vi.stubEnv('RENSA_DEV', undefined)
    const fake: ProviderStatus = {
      provider: 'fake',
      availability: { status: 'ready', version: 'dev' },
    }
    const s = mount({ engine: new StubEngine(MOCK_CHAINS, [...MOCK_STATUSES, fake]) })
    await effects()

    expect(s.lines()[0]).toBe(MOCK_FRAME[0])
  })

  it('lists the fake provider last when RENSA_DEV is 1', async () => {
    vi.stubEnv('RENSA_DEV', '1')
    const fake: ProviderStatus = {
      provider: 'fake',
      availability: { status: 'ready', version: 'dev' },
    }
    const s = mount({ engine: new StubEngine(MOCK_CHAINS, [...MOCK_STATUSES, fake]) })
    await effects()

    expect(s.lines()[0]).toBe(`${MOCK_FRAME[0]}   fake dev`)
  })
})

describe('the frame before the first provider check completes', () => {
  it('shows checking providers… in muted and no provider annotation when providers() is undefined', async () => {
    const s = mount({ engine: new StubEngine(MOCK_CHAINS) })
    await effects()

    expect(s.lines()).toEqual([
      '  checking providers…',
      RULE,
      '',
      '› tdd-review',
      '  Tests first, implementation, three reviewers, routed fixes, re-test.',
      '',
      '  review-only',
      '  Three reviewers on the current diff.',
      '',
      '  nightly-audit',
      '  ! agents.codex: unknown provider "codx"',
    ])
    expect(s.view.lastFrame().split('\n')[0]).toContain(`${MUTED}  checking providers…`)
  })

  it('renders the checked frame on the providers event without remounting when the check lands', async () => {
    const engine = new StubEngine(MOCK_CHAINS)
    const s = mount({ engine })
    await effects()
    // A remount would put the selection back on the first row.
    await s.press(KEYS.down)

    engine.completeCheck(MOCK_STATUSES)

    await frameSettles(() =>
      expect(s.lines()).toEqual(
        MOCK_FRAME.map((l) =>
          l === '› tdd-review' ? '  tdd-review' : l === '  review-only' ? '› review-only' : l,
        ),
      ),
    )
    expect(s.selectedNames()).toEqual(['review-only'])
  })

  it('shows the checked frame when the check lands between the first render and the subscription', async () => {
    const engine = new StubEngine(MOCK_CHAINS)
    const s = mount({ engine })

    engine.completeCheck(MOCK_STATUSES)

    await frameSettles(() => expect(s.lines()).toEqual(MOCK_FRAME))
  })

  it('stops listening for providers events when unmounted', async () => {
    const engine = new StubEngine(MOCK_CHAINS)
    const s = mount({ engine })
    await effects()

    s.view.unmount()
    view = undefined
    await effects()

    expect(engine.listenerCount('providers')).toBe(0)
  })
})

describe('the empty state', () => {
  it('shows no chains in .rensa/ in muted when the engine lists no chains', async () => {
    const s = mount({ engine: new StubEngine([], MOCK_STATUSES) })
    await effects()

    expect(s.lines()).toEqual([MOCK_FRAME[0], RULE, '', '  no chains in .rensa/'])
    expect(s.view.lastFrame()).toContain(`${MUTED}  no chains in .rensa/`)
  })

  it('does not navigate on enter when there are no chains', async () => {
    const s = mount({ engine: new StubEngine([], MOCK_STATUSES) })
    await effects()

    await s.press(KEYS.enter)

    expect(s.navigate).not.toHaveBeenCalled()
  })
})

describe('moving the selection and opening a chain', () => {
  it('opens the detail screen for the selected chain when enter is pressed after down', async () => {
    const s = mount({ engine: new StubEngine(MOCK_CHAINS, MOCK_STATUSES) })
    await effects()

    await s.press(KEYS.down)
    await s.press(KEYS.enter)

    expect(s.navigate.mock.calls).toEqual([[{ name: 'detail', chain: 'review-only' }]])
  })

  it('opens the detail screen for a broken chain when it is selected', async () => {
    const s = mount({ engine: new StubEngine(MOCK_CHAINS, MOCK_STATUSES) })
    await effects()

    await s.press(KEYS.down, 2)
    await s.press(KEYS.enter)

    expect(s.navigate.mock.calls).toEqual([[{ name: 'detail', chain: 'nightly-audit' }]])
  })

  it('stays on the last row when down is pressed past the end', async () => {
    const s = mount({ engine: new StubEngine(MOCK_CHAINS, MOCK_STATUSES) })
    await effects()

    await s.press(KEYS.down, 5)
    const selected = s.selectedNames()
    await s.press(KEYS.enter)

    expect(selected).toEqual(['nightly-audit'])
    expect(s.navigate.mock.calls).toEqual([[{ name: 'detail', chain: 'nightly-audit' }]])
  })

  it('stays on the first row when up is pressed at the top', async () => {
    const s = mount({ engine: new StubEngine(MOCK_CHAINS, MOCK_STATUSES) })
    await effects()

    await s.press(KEYS.up, 2)
    await s.press(KEYS.enter)

    expect(s.selectedNames()).toEqual(['tdd-review'])
    expect(s.navigate.mock.calls).toEqual([[{ name: 'detail', chain: 'tdd-review' }]])
  })

  it('ignores keys while an app-level overlay holds them (active false)', async () => {
    const s = mount({ engine: new StubEngine(MOCK_CHAINS, MOCK_STATUSES), active: false })
    await effects()

    await s.press(KEYS.down)
    await s.press(KEYS.enter)
    await s.press(KEYS.ctrlR)

    expect(s.selectedNames()).toEqual(['tdd-review'])
    expect(s.navigate).not.toHaveBeenCalled()
    expect(s.engine.recheckProviders).not.toHaveBeenCalled()
  })

  it('asks the app to quit when esc or ctrl+c is pressed', async () => {
    const s = mount({ engine: new StubEngine(MOCK_CHAINS, MOCK_STATUSES) })
    await effects()

    await s.press(KEYS.ctrlC)
    const afterCtrlC = s.requestQuit.mock.calls.length
    await s.press(KEYS.esc)

    expect(afterCtrlC).toBe(1)
    // Ink holds a lone ESC for 20 ms in case an escape sequence follows.
    await vi.waitFor(() => expect(s.requestQuit).toHaveBeenCalledTimes(2), { timeout: 1000 })
    expect(s.navigate).not.toHaveBeenCalled()
  })
})

describe('moving the selection with the mouse wheel', () => {
  it('selects the next chain on each wheel down and the previous one on wheel up', async () => {
    const wheel = createWheelHub()
    const s = mount({ engine: new StubEngine(MOCK_CHAINS, MOCK_STATUSES), wheel })
    await effects()

    wheel.emit('down')
    wheel.emit('down')
    await frameSettles(() => expect(s.selectedNames()).toEqual(['nightly-audit']))
    wheel.emit('up')

    await frameSettles(() => expect(s.selectedNames()).toEqual(['review-only']))
  })

  it('opens the chain the wheel selected when enter is pressed after a wheel down', async () => {
    const wheel = createWheelHub()
    const s = mount({ engine: new StubEngine(MOCK_CHAINS, MOCK_STATUSES), wheel })
    await effects()

    wheel.emit('down')
    await frameSettles(() => expect(s.selectedNames()).toEqual(['review-only']))
    await s.press(KEYS.enter)

    expect(s.navigate.mock.calls).toEqual([[{ name: 'detail', chain: 'review-only' }]])
  })

  it('stays on the last chain when the wheel turns down past the end', async () => {
    const wheel = createWheelHub()
    const s = mount({ engine: new StubEngine(MOCK_CHAINS, MOCK_STATUSES), wheel })
    await effects()

    // Four turns from the first of three chains: wrapping would land on review-only.
    for (let i = 0; i < 4; i++) wheel.emit('down')
    await frameSettles(() => expect(s.selectedNames()).toEqual(['nightly-audit']))

    wheel.emit('up')
    await frameSettles(() => expect(s.selectedNames()).toEqual(['review-only']))
  })

  // The provider check landing renders in the same batch as a selection
  // change queued before it, so once its frame shows, a wheel turn the
  // screen had taken would show too.

  it('ignores the wheel while an app-level overlay holds the input (active false)', async () => {
    const wheel = createWheelHub()
    const engine = new StubEngine(MOCK_CHAINS)
    const s = mount({ engine, wheel, active: false })
    await effects()

    wheel.emit('down')
    engine.completeCheck(MOCK_STATUSES)

    await frameSettles(() => expect(s.lines()[0]).toBe(MOCK_FRAME[0]))
    expect(s.selectedNames()).toEqual(['tdd-review'])
  })

  it('stops following the wheel when an overlay comes up after the screen took wheel turns', async () => {
    const wheel = createWheelHub()
    const engine = new StubEngine(MOCK_CHAINS)
    const s = mount({ engine, wheel })
    await effects()
    wheel.emit('down')
    await frameSettles(() => expect(s.selectedNames()).toEqual(['review-only']))

    s.setActive(false)
    await effects()
    wheel.emit('down')
    engine.completeCheck(MOCK_STATUSES)

    await frameSettles(() => expect(s.lines()[0]).toBe(MOCK_FRAME[0]))
    expect(s.selectedNames()).toEqual(['review-only'])
  })

  it('follows the wheel again when the overlay goes away', async () => {
    const wheel = createWheelHub()
    const s = mount({ engine: new StubEngine(MOCK_CHAINS, MOCK_STATUSES), wheel, active: false })
    await effects()

    s.setActive(true)
    await effects()
    wheel.emit('down')

    await frameSettles(() => expect(s.selectedNames()).toEqual(['review-only']))
  })
})

describe('rechecking providers', () => {
  it('calls engine.recheckProviders when ctrl+r is pressed', async () => {
    const s = mount({ engine: new StubEngine(MOCK_CHAINS, MOCK_STATUSES) })
    await effects()

    await s.press(KEYS.ctrlR)

    expect(s.engine.recheckProviders).toHaveBeenCalledTimes(1)
  })

  it('keeps the previous provider line until the recheck lands, then shows the new statuses and annotations', async () => {
    const engine = new StubEngine(MOCK_CHAINS, MOCK_STATUSES)
    const s = mount({ engine })
    await effects()

    await s.press(KEYS.ctrlR)
    const during = s.lines()
    const grokReady: ProviderStatus = {
      provider: 'grok',
      availability: { status: 'ready', version: '0.9.1' },
    }
    engine.completeCheck([CLAUDE_READY, CODEX_LOGGED_OUT, grokReady])

    expect(during).toEqual(MOCK_FRAME)
    await frameSettles(() =>
      expect(s.lines()[0]).toBe('  claude 2.1.3   codex 0.48 · not logged in   grok 0.9.1'),
    )
    // The same frame: the chain list was re-read with the new statuses.
    expect(s.lines()).not.toContain('  ! needs grok')
  })
})

describe('the rule under the provider line', () => {
  it('spans the terminal width when the terminal is 120 columns wide', async () => {
    const s = mount({ engine: new StubEngine(MOCK_CHAINS, MOCK_STATUSES), columns: 120 })
    await effects()

    expect(s.lines()[1]).toBe('─'.repeat(120))
  })

  it('is dropped, like the header rule, when the terminal is short', async () => {
    const s = mount({ engine: new StubEngine(MOCK_CHAINS, MOCK_STATUSES), rows: 9 })
    await effects()

    expect(s.lines().slice(0, 3)).toEqual([MOCK_FRAME[0], '', '› tdd-review'])
  })
})

describe('scrolling at a short terminal height', () => {
  // 12 rows: header 2, body 10, provider line and rule 2, list 8 = two chains of three rows.
  const ROWS = 12
  const BODY_ROWS = ROWS - 2

  it('keeps the selected row and its description inside the body when moving to the last chain', async () => {
    const s = mount({ engine: new StubEngine(SIX_CHAINS, MOCK_STATUSES), rows: ROWS })
    await effects()

    await s.press(KEYS.down, 5)

    const row = s.rowOf('flaky-triage')
    expect(s.selectedNames()).toEqual(['flaky-triage'])
    expect(row).toBeGreaterThan(0)
    expect(row + 1).toBeLessThan(BODY_ROWS)
    expect(s.lines()[row + 1]).toBe('  Runs the flaky-triage chain.')
    expect(s.rowOf('tdd-review')).toBe(-1)
    expect(s.lines()[0]).toBe(MOCK_FRAME[0])
  })

  it('brings the first chain back into view when moving up to the top again', async () => {
    const s = mount({ engine: new StubEngine(SIX_CHAINS, MOCK_STATUSES), rows: ROWS })
    await effects()

    await s.press(KEYS.down, 5)
    await s.press(KEYS.up, 5)

    expect(s.selectedNames()).toEqual(['tdd-review'])
    expect(s.rowOf('tdd-review')).toBe(3)
  })

  it('keeps every intermediate selection inside the body while stepping down', async () => {
    const s = mount({ engine: new StubEngine(SIX_CHAINS, MOCK_STATUSES), rows: ROWS })
    await effects()

    const rows: number[] = []
    for (const chain of SIX_CHAINS.slice(1)) {
      await s.press(KEYS.down)
      rows.push(s.rowOf(chain.name) + 1) // the description row
    }

    expect(rows.filter((r) => r <= 0 || r >= BODY_ROWS)).toEqual([])
  })

  it('keeps the selected row inside the body when the terminal gets shorter', async () => {
    const s = mount({ engine: new StubEngine(SIX_CHAINS, MOCK_STATUSES), rows: 24 })
    await effects()
    await s.press(KEYS.down, 4)

    s.resize(ROWS)
    await effects()

    const row = s.rowOf('dependency-bump')
    expect(s.selectedNames()).toEqual(['dependency-bump'])
    expect(row).toBeGreaterThan(0)
    expect(row + 1).toBeLessThan(BODY_ROWS)
  })
})

describe('the selection restored on mount', () => {
  it('selects the initialChain row and keeps it in view when the terminal is short', async () => {
    const rows = 12
    const s = mount({
      engine: new StubEngine(SIX_CHAINS, MOCK_STATUSES),
      rows,
      initialChain: 'flaky-triage',
    })
    await effects()

    const row = s.rowOf('flaky-triage')
    expect(s.selectedNames()).toEqual(['flaky-triage'])
    expect(row).toBeGreaterThan(0)
    expect(row + 1).toBeLessThan(rows - 2)
  })

  it('opens the restored chain when enter is pressed right after mount', async () => {
    const s = mount({
      engine: new StubEngine(SIX_CHAINS, MOCK_STATUSES),
      rows: 12,
      initialChain: 'release-notes',
    })
    await effects()

    await s.press(KEYS.enter)

    expect(s.navigate.mock.calls).toEqual([[{ name: 'detail', chain: 'release-notes' }]])
  })

  it('selects the first row when initialChain names no listed chain', async () => {
    const s = mount({
      engine: new StubEngine(SIX_CHAINS, MOCK_STATUSES),
      rows: 12,
      initialChain: 'deleted-chain',
    })
    await effects()

    await s.press(KEYS.enter)

    expect(s.selectedNames()).toEqual(['tdd-review'])
    expect(s.rowOf('tdd-review')).toBe(3)
    expect(s.navigate.mock.calls).toEqual([[{ name: 'detail', chain: 'tdd-review' }]])
  })
})

// --- long descriptions -----------------------------------------------------

/** 40 columns leave 38 cells for a description after its two-column indent. */
const NARROW = 40
const NARROW_RULE = '─'.repeat(NARROW)

/** Wraps onto exactly three lines at `NARROW`. */
const RELEASE_NOTES: ChainFixture = {
  name: 'release-notes',
  description:
    'Plans the release, drafts notes from merged PRs, and opens a draft release for review.',
  uses: ['claude'],
}
const RELEASE_NOTES_LINES = [
  '  Plans the release, drafts notes from',
  '  merged PRs, and opens a draft release',
  '  for review.',
]

/** Needs more than three lines at `NARROW`. */
const DEPENDENCY_BUMP: ChainFixture = {
  name: 'dependency-bump',
  description:
    'Bumps one dependency at a time, runs the full test suite after each bump, reverts any bump that breaks the build, and opens one pull request per package that passed.',
  uses: ['claude'],
}

describe('a long description wrapped to the terminal width', () => {
  it('shows a description on two lines with no ellipsis when it wraps onto exactly two lines at 40 columns', async () => {
    const s = mount({ engine: new StubEngine([REVIEW_ONLY, TDD_REVIEW]), columns: NARROW })
    await effects()

    // The last chain: nothing follows its second line.
    expect(s.lines().slice(s.rowOf('tdd-review'))).toEqual([
      '  tdd-review',
      '  Tests first, implementation, three',
      '  reviewers, routed fixes, re-test.',
    ])
  })

  it('shows a description on three lines with no ellipsis and starts the next chain after them when it wraps onto exactly three lines', async () => {
    const s = mount({
      engine: new StubEngine([RELEASE_NOTES, REVIEW_ONLY], MOCK_STATUSES),
      columns: NARROW,
    })
    await effects()

    expect(s.lines().slice(1)).toEqual([
      NARROW_RULE,
      '',
      '› release-notes',
      ...RELEASE_NOTES_LINES,
      '',
      '  review-only',
      '  Three reviewers on the current diff.',
    ])
  })

  it('cuts a description to three lines ending in an ellipsis within the width when it needs more', async () => {
    const s = mount({
      engine: new StubEngine([DEPENDENCY_BUMP, REVIEW_ONLY], MOCK_STATUSES),
      columns: NARROW,
    })
    await effects()

    expect(s.lines().slice(1)).toEqual([
      NARROW_RULE,
      '',
      '› dependency-bump',
      '  Bumps one dependency at a time, runs',
      '  the full test suite after each bump,',
      '  reverts any bump that breaks the buil…',
      '',
      '  review-only',
      '  Three reviewers on the current diff.',
    ])
  })

  it('draws every wrapped description line in muted when the description wraps', async () => {
    const s = mount({
      engine: new StubEngine([RELEASE_NOTES], MOCK_STATUSES),
      columns: NARROW,
    })
    await effects()

    const frame = s.view.lastFrame()
    for (const line of RELEASE_NOTES_LINES) expect(frame).toContain(`${MUTED}${line}`)
  })

  it('puts the missing-provider warning below the last wrapped line when a chain has both', async () => {
    const s = mount({
      engine: new StubEngine([TDD_REVIEW, REVIEW_ONLY], MOCK_STATUSES),
      columns: NARROW,
    })
    await effects()

    expect(s.lines().slice(1)).toEqual([
      NARROW_RULE,
      '',
      '› tdd-review',
      '  Tests first, implementation, three',
      '  reviewers, routed fixes, re-test.',
      '  ! needs grok',
      '',
      '  review-only',
      '  Three reviewers on the current diff.',
    ])
  })

  it('re-wraps the description to the new width once it settles when the terminal gets narrower', async () => {
    const s = mount({ engine: new StubEngine([TDD_REVIEW, REVIEW_ONLY], MOCK_STATUSES) })
    await effects()

    s.resizeColumns(NARROW)

    await frameSettles(() =>
      expect(s.lines().slice(3, 7)).toEqual([
        '› tdd-review',
        '  Tests first, implementation, three',
        '  reviewers, routed fixes, re-test.',
        '  ! needs grok',
      ]),
    )
    expect(s.rowOf('review-only')).toBe(8)
  })
})

describe('scrolling when descriptions wrap onto several lines', () => {
  // 12 rows: header 2, body 10, provider line and rule 2, list 8. At 40
  // columns a three-line chain takes five rows with its gap, so only one fits.
  const ROWS = 12
  const BODY_ROWS = ROWS - 2

  /** Six chains whose descriptions wrap onto three lines at 40 columns. */
  const WRAPPED: ChainFixture[] = [
    'tdd-review',
    'review-only',
    'nightly-audit',
    'release-notes',
    'dependency-bump',
    'flaky-triage',
  ].map((name) => ({
    name,
    description: `Runs the ${name} chain on the current checkout, then posts a summary of every step to the run log.`,
    uses: ['claude'],
  }))

  /** Rows from the selected chain's name through its last row, within the body. */
  function selectedSpan(s: Screen, name: string): { first: number; last: number } {
    const first = s.rowOf(name)
    let last = first
    while ((s.lines()[last + 1] ?? '') !== '') last++
    return { first, last }
  }

  it('shows the whole wrapped description of the last chain inside the body when moving to it', async () => {
    const s = mount({
      engine: new StubEngine(WRAPPED, MOCK_STATUSES),
      columns: NARROW,
      rows: ROWS,
    })
    await effects()

    await s.press(KEYS.down, 5)

    expect(s.lines().slice(1)).toEqual([
      NARROW_RULE,
      '',
      '› flaky-triage',
      '  Runs the flaky-triage chain on the',
      '  current checkout, then posts a summary',
      '  of every step to the run log.',
    ])
  })

  it('keeps every selected chain and all its wrapped lines inside the body while stepping down and back up', async () => {
    const s = mount({
      engine: new StubEngine(WRAPPED, MOCK_STATUSES),
      columns: NARROW,
      rows: ROWS,
    })
    await effects()

    const outside: string[] = []
    const visit = (name: string) => {
      const { first, last } = selectedSpan(s, name)
      if (first <= 0 || last - first !== 3 || last >= BODY_ROWS)
        outside.push(`${name}@${first}-${last}`)
    }
    for (const chain of WRAPPED.slice(1)) {
      await s.press(KEYS.down)
      visit(chain.name)
    }
    for (const chain of WRAPPED.slice(0, -1).reverse()) {
      await s.press(KEYS.up)
      visit(chain.name)
    }

    expect(outside).toEqual([])
    expect(s.rowOf('tdd-review')).toBe(3)
  })

  it('keeps the selected chain and its wrapped lines inside the body when two- and three-line descriptions alternate', async () => {
    // Blocks of four and five rows: no two neighbours fit the eight list rows together.
    const mixed: ChainFixture[] = WRAPPED.map((c, i) =>
      i % 2 === 0
        ? c
        : { ...c, description: 'Reviews the current diff with three reviewers and routes fixes.' },
    )
    const s = mount({
      engine: new StubEngine(mixed, MOCK_STATUSES),
      columns: NARROW,
      rows: ROWS,
    })
    await effects()

    const outside: string[] = []
    const visit = (name: string) => {
      const { first, last } = selectedSpan(s, name)
      if (first <= 0 || last >= BODY_ROWS) outside.push(`${name}@${first}-${last}`)
    }
    for (const chain of mixed.slice(1)) {
      await s.press(KEYS.down)
      visit(chain.name)
    }
    for (const chain of mixed.slice(0, -1).reverse()) {
      await s.press(KEYS.up)
      visit(chain.name)
    }

    expect(outside).toEqual([])
  })

  it('shows the whole wrapped description of initialChain at the top of the list on mount', async () => {
    const s = mount({
      engine: new StubEngine(WRAPPED, MOCK_STATUSES),
      columns: NARROW,
      rows: ROWS,
      initialChain: 'dependency-bump',
    })
    await effects()

    // Rows below the body are the app's to clip; the selected chain fills the list.
    expect(s.lines().slice(2, 7)).toEqual([
      '',
      '› dependency-bump',
      '  Runs the dependency-bump chain on the',
      '  current checkout, then posts a summary',
      '  of every step to the run log.',
    ])
  })
})
