import { writeSync } from 'node:fs'
import { format } from 'node:util'
import { type Instance, render } from 'ink'
import { createContext, type ReactElement } from 'react'
import { onDiag, onShutdown } from '../engine/index.js'
import { MAX_FPS } from './frameRate.js'

// The terminal session: mode resolution, Ink's render options, normal
// quit and the fatal restore. The restore's writes below are the one
// sanctioned use of process.stdout under src/tui/; nothing else in the TUI
// writes to the terminal except Ink.

export type Mode = 'inline' | 'fullscreen'

/** Until step 11b decides; the one place the default lives. */
const DEFAULT_MODE: Mode = 'inline'

const LEAVE_ALTERNATE_SCREEN = '\x1b[?1049l'
const SHOW_CURSOR = '\x1b[?25h'
const RESET_ATTRIBUTES = '\x1b[0m'

/** A command-line misuse; the CLI exits 64. */
export class UsageError extends Error {
  override name = 'UsageError'
}

/**
 * The session mode, resolved once at startup. Not a terminal on stdout
 * means inline whatever the flags say. `env` is where step 11b may add a
 * `TERM_PROGRAM` rule.
 */
export function resolveMode(
  flags: { fullscreen?: boolean; inline?: boolean },
  _env: NodeJS.ProcessEnv,
  stdoutIsTTY: boolean = Boolean(process.stdout.isTTY),
): Mode {
  if (flags.fullscreen && flags.inline) {
    throw new UsageError('--fullscreen and --inline cannot be combined')
  }
  if (!stdoutIsTTY) return 'inline'
  if (flags.fullscreen) return 'fullscreen'
  if (flags.inline) return 'inline'
  return DEFAULT_MODE
}

/** Cleanup callbacks the UI owns: engine subscriptions, batchers, intervals. */
export interface Teardown {
  /** Registers `fn` to run once at teardown; returns its unregister function. */
  add(fn: () => void): () => void
  /** Runs every registered callback once. Later calls run only later registrations. */
  run(): void
}

export function createTeardown(): Teardown {
  const fns = new Set<() => void>()
  return {
    add(fn) {
      fns.add(fn)
      return () => {
        fns.delete(fn)
      }
    },
    run() {
      const pending = [...fns]
      fns.clear()
      for (const fn of pending) {
        try {
          fn()
        } catch {
          // One failing cleanup must not keep the others from running.
        }
      }
    },
  }
}

/** What components may ask of the session. */
export interface SessionControls {
  /** Normal quit; see `Session.quit`. Never call `process.exit` from a component. */
  quit(): Promise<void>
  /** Registers UI-owned cleanup to run on quit, before Ink unmounts. */
  onTeardown(fn: () => void): () => void
}

/** Components reach the session through this; the default does nothing (tests). */
export const SessionContext = createContext<SessionControls>({
  quit: () => Promise.resolve(),
  onTeardown: () => () => {},
})

export interface Session {
  /** Normal quit: teardown, unmount, wait for Ink. Idempotent: returns the same promise. */
  quit(): Promise<void>
  /** Settles when Ink has exited, however that happened; rejects on a React crash. */
  readonly done: Promise<void>
  /**
   * Foreign output captured during the session (diagnostics, `console.*`,
   * Node warnings), oldest first, printed or not.
   */
  readonly captured: ReadonlyArray<string>
  /**
   * The captured lines not yet printed, and marks them printed: each line
   * is handed out once, whether to `main.ts` after `done` or to the fatal
   * restore, which prints what is left itself.
   */
  drainCaptured(): string[]
}

/**
 * What this process acquired of the terminal. Before `render` a flag
 * means "Ink will have entered this"; after, "Ink holds this". Every path
 * that releases the terminal clears what it released.
 */
interface Ownership {
  alternateScreen: boolean
  cursorHidden: boolean
  rendered: boolean
  rawMode: boolean
}

/**
 * Configures Ink and renders `app`. The fatal restore is registered with
 * the engine's shutdown registry before anything else, so a throw from
 * `render` itself still leaves a sane terminal on exit.
 */
export function startSession(
  mode: Mode,
  app: ReactElement,
  teardown: Teardown = createTeardown(),
): Session {
  const owned: Ownership = {
    alternateScreen: false,
    cursorHidden: false,
    rendered: false,
    rawMode: false,
  }
  let instance: Instance | undefined
  const captured: string[] = []
  let printed = 0
  const drainCaptured = () => {
    const lines = captured.slice(printed)
    printed = captured.length
    return lines
  }
  let stopCapture: () => void = () => {}
  /** Set once Ink has exited and the session released the terminal. */
  let ended = false

  onShutdown(() => {
    // Running while the session is still live means it did not end
    // through Ink (uncaught exception, signal, a foreign process.exit):
    // an abnormal end, whose captured lines are always printed.
    const abnormal = !ended
    stopCapture()
    restoreTerminal(instance, owned)
    // After the restore, so the lines land on the primary screen.
    if (abnormal || process.env.RENSA_DEBUG === '1') writeStderrSync(drainCaptured())
  })

  const { stdout, stdin } = process
  // Ink enters the alternate screen and hides the cursor in its
  // constructor, under exactly this condition, before anything that can throw.
  const entersAlternateScreen = mode === 'fullscreen' && Boolean(stdout.isTTY) && !inCi()
  owned.alternateScreen = entersAlternateScreen
  owned.cursorHidden = entersAlternateScreen

  stopCapture = captureForeignOutput(captured)
  instance = render(app, {
    alternateScreen: mode === 'fullscreen',
    incrementalRendering: true,
    maxFps: MAX_FPS,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  owned.rendered = true
  // The root always mounts useInput, which puts a TTY stdin in raw mode.
  owned.rawMode = Boolean(stdin.isTTY)

  const exited = instance.waitUntilExit()
  /** Ink has released the terminal; only our own state is left. */
  const released = () => {
    ended = true
    teardown.run()
    stopCapture()
    owned.alternateScreen = false
    owned.cursorHidden = false
    owned.rendered = false
    owned.rawMode = false
  }
  const done = exited.then(
    () => released(),
    (error: unknown) => {
      released()
      throw error
    },
  )
  // `main.ts` awaits `done`; this only keeps an early crash from being
  // reported as an unhandled rejection before it does.
  done.catch(() => {})

  const ink = instance
  let quitting: Promise<void> | undefined
  return {
    done,
    captured,
    drainCaptured,
    quit() {
      quitting ??= (async () => {
        teardown.run()
        ink.unmount()
        try {
          await exited
        } catch {
          // A crash that raced the quit is reported through `done`.
        }
        released()
      })()
      return quitting
    },
  }
}

/**
 * The fatal restore, run synchronously from the shutdown registry. Stage
 * one lets Ink tear itself down; stage two restores whatever the record
 * still marks acquired. Idempotent: every write clears its flag.
 */
function restoreTerminal(instance: Instance | undefined, owned: Ownership): void {
  if (instance && owned.rendered) {
    try {
      instance.unmount()
      owned.alternateScreen = false
      owned.cursorHidden = false
      owned.rendered = false
      owned.rawMode = false
    } catch {
      // Leave the record as it is: stage two restores what Ink did not.
    }
  }
  if (owned.rawMode) {
    owned.rawMode = false
    try {
      process.stdin.setRawMode?.(false)
    } catch {
      // Nothing left to restore it with.
    }
  }
  if (owned.alternateScreen) {
    owned.alternateScreen = false
    writeTerminal(LEAVE_ALTERNATE_SCREEN)
  }
  if (owned.cursorHidden) {
    owned.cursorHidden = false
    writeTerminal(SHOW_CURSOR)
  }
  if (owned.rendered) {
    owned.rendered = false
    writeTerminal(RESET_ATTRIBUTES)
  }
}

/** Synchronous: inside the shutdown registry the event loop is gone. */
function writeStderrSync(lines: readonly string[]): void {
  if (lines.length === 0) return
  try {
    writeSync(2, `${lines.join('\n')}\n`)
  } catch {
    // Nowhere left to report to.
  }
}

function writeTerminal(sequence: string): void {
  try {
    process.stdout.write(sequence)
  } catch {
    // The terminal is gone; there is nothing to restore.
  }
}

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const

/**
 * Routes the process's foreign output into `lines` while Ink owns the
 * terminal: engine diagnostics, `console.*` from dependencies, and Node
 * warnings (whose default listener would print them). Returns the
 * function that puts everything back; calling it again does nothing.
 */
function captureForeignOutput(lines: string[]): () => void {
  // biome-ignore lint/suspicious/noConsole: saved to be restored, never called
  const originals = CONSOLE_METHODS.map((method) => [method, console[method]] as const)
  for (const method of CONSOLE_METHODS) {
    console[method] = (...args: unknown[]) => {
      lines.push(format(...args))
    }
  }
  const warningListeners = process.listeners('warning')
  process.removeAllListeners('warning')
  const onWarning = (warning: Error) => {
    lines.push(`${warning.name}: ${warning.message}`)
  }
  process.on('warning', onWarning)
  const stopDiag = onDiag((entry) => {
    lines.push(`diag ${entry.scope}: ${entry.message}`)
  })

  let active = true
  return () => {
    if (!active) return
    active = false
    for (const [method, original] of originals) console[method] = original
    process.off('warning', onWarning)
    for (const listener of warningListeners) process.on('warning', listener)
    stopDiag()
  }
}

/** Ink's CI detection (`is-in-ci`), read at call time. */
function inCi(env: NodeJS.ProcessEnv = process.env): boolean {
  const set = (key: string) => key in env && env[key] !== '0' && env[key] !== 'false'
  return set('CI') || set('CONTINUOUS_INTEGRATION')
}
