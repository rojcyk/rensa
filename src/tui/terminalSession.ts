import { writeSync } from 'node:fs'
import { format } from 'node:util'
import { type Instance, render } from 'ink'
import { createContext, type ReactElement } from 'react'
import { onDiag, onShutdown } from '../engine/index.js'
import { MAX_FPS } from './frameRate.js'
import {
  createWheelHub,
  DISABLE_MOUSE,
  ENABLE_MOUSE,
  filterMouseReads,
  type WheelDirection,
  type WheelHub,
} from './mouse.js'

// The terminal session: the terminal check, Ink's render options, normal
// quit and the fatal restore. The TUI always draws the full window on the
// alternate screen, with mouse reporting on so the wheel scrolls rensa's
// panes instead of the terminal's scrollback. The restore's writes, the
// mouse mode switches and the resize erase below are the only sanctioned
// uses of process.stdout under src/tui/; nothing else in the TUI writes to
// the terminal except Ink.

const LEAVE_ALTERNATE_SCREEN = '\x1b[?1049l'
const SHOW_CURSOR = '\x1b[?25h'
const RESET_ATTRIBUTES = '\x1b[0m'
/** Cursor to the top-left cell, then erase to the end of the screen. */
const HOME_AND_ERASE_DOWN = '\x1b[H\x1b[J'

/**
 * Why the TUI cannot start here, or undefined when it can. It needs a
 * terminal on stdout to draw the full window, and one on stdin for the
 * keys: without them Ink would unmount on its own and the alternate
 * screen would take the output with it.
 */
export function terminalProblem(
  stdoutIsTTY: boolean = Boolean(process.stdout.isTTY),
  stdinIsTTY: boolean = Boolean(process.stdin.isTTY),
): string | undefined {
  if (stdoutIsTTY && stdinIsTTY) return undefined
  const missing =
    !stdoutIsTTY && !stdinIsTTY ? 'stdin and stdout' : stdoutIsTTY ? 'stdin' : 'stdout'
  return `the TUI needs a terminal on ${missing}; use \`rensa run <chain>\` to run a chain with no UI`
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
  /** Registers `fn` for every mouse wheel turn; returns its unregister function. */
  onWheel(fn: (direction: WheelDirection) => void): () => void
}

/** Components reach the session through this; the default does nothing (tests). */
export const SessionContext = createContext<SessionControls>({
  quit: () => Promise.resolve(),
  onTeardown: () => () => {},
  onWheel: () => () => {},
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
  mouse: boolean
}

/**
 * Configures Ink and renders `app`. The fatal restore is registered with
 * the engine's shutdown registry before anything else, so a throw from
 * `render` itself still leaves a sane terminal on exit. Wheel turns go to
 * `wheel`'s subscribers.
 */
export function startSession(
  app: ReactElement,
  teardown: Teardown = createTeardown(),
  wheel: WheelHub = createWheelHub(),
): Session {
  const owned: Ownership = {
    alternateScreen: false,
    cursorHidden: false,
    rendered: false,
    rawMode: false,
    mouse: false,
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
  let stopRepaint: () => void = () => {}
  let stopMouseFilter: () => void = () => {}
  /** Turns mouse reporting off and gives Ink stdin unfiltered again. */
  const releaseMouse = () => {
    if (owned.mouse) {
      owned.mouse = false
      writeTerminal(DISABLE_MOUSE)
    }
    stopMouseFilter()
  }
  /** Set once Ink has exited and the session released the terminal. */
  let ended = false

  onShutdown(() => {
    // Running while the session is still live means it did not end
    // through Ink (uncaught exception, signal, a foreign process.exit):
    // an abnormal end, whose captured lines are always printed.
    const abnormal = !ended
    stopRepaint()
    stopCapture()
    releaseMouse()
    restoreTerminal(instance, owned)
    // After the restore, so the lines land on the primary screen.
    if (abnormal || process.env.RENSA_DEBUG === '1') writeStderrSync(drainCaptured())
  })

  const { stdout, stdin } = process
  // Ink enters the alternate screen and hides the cursor in its
  // constructor, under exactly this condition, before anything that can
  // throw. `interactive: true` keeps Ink from switching to its CI mode,
  // which draws only the last frame, when a terminal has CI set.
  const entersAlternateScreen = Boolean(stdout.isTTY)
  owned.alternateScreen = entersAlternateScreen
  owned.cursorHidden = entersAlternateScreen

  stopCapture = captureForeignOutput(captured)
  instance = render(app, {
    alternateScreen: true,
    interactive: true,
    incrementalRendering: true,
    maxFps: MAX_FPS,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  owned.rendered = true
  // The root always mounts useInput, which puts a TTY stdin in raw mode.
  owned.rawMode = Boolean(stdin.isTTY)
  if (entersAlternateScreen) {
    stopRepaint = repaintOnResize(stdout, instance)
    teardown.add(stopRepaint)
  }
  // Only with a key reader: without raw mode the reports would echo as text.
  if (entersAlternateScreen && owned.rawMode) {
    stopMouseFilter = filterMouseReads(stdin, wheel.emit)
    owned.mouse = true
    writeTerminal(ENABLE_MOUSE)
  }

  const exited = instance.waitUntilExit()
  /** Ink has released the terminal; only our own state is left. */
  const released = () => {
    ended = true
    teardown.run()
    releaseMouse()
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
        releaseMouse()
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

/**
 * Ink updates a frame relative to where it last left the cursor, and
 * rewrites only the lines that changed. A resize can break that: a frame
 * written after the window shrank but before the resize event arrived
 * wraps, and a terminal that reflows its screen moves rows, so later
 * frames land offset and leave stale copies behind. On every size change,
 * before Ink's own resize listener runs, this erases the screen from the
 * top-left cell and empties Ink's record of the previous frame, so the
 * next frame is drawn whole from an absolute position. Returns the
 * function that stops listening; calling it again does nothing.
 */
function repaintOnResize(stdout: NodeJS.WriteStream, instance: Instance): () => void {
  let { columns, rows } = stdout
  const onResize = () => {
    if (stdout.columns === columns && stdout.rows === rows) return
    columns = stdout.columns
    rows = stdout.rows
    // Ink's clear erases relative to a cursor that may be off; the
    // absolute erase after it is what leaves the screen blank.
    instance.clear()
    writeTerminal(HOME_AND_ERASE_DOWN)
  }
  stdout.prependListener('resize', onResize)
  return () => {
    stdout.off('resize', onResize)
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
