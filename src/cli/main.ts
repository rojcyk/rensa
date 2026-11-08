import { Engine, RensaError } from '../engine/index.js'
import { parseArgs, type TuiArgs, USAGE } from './args.js'
import { runCapture } from './capture.js'
import { doctor } from './doctor.js'
import { formatError, guardOutput, paintFor, writeLines } from './format.js'
import { runHeadless } from './headless.js'

declare const __RENSA_VERSION__: string

/** sysexits EX_USAGE. */
const EXIT_USAGE = 64

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv)
  if (!parsed.ok) {
    writeLines(process.stderr, [`rensa: ${parsed.message}`, USAGE])
    return EXIT_USAGE
  }
  const { command } = parsed
  switch (command.kind) {
    case 'version':
      writeLines(process.stdout, [__RENSA_VERSION__])
      return 0
    case 'help':
      writeLines(process.stdout, [USAGE])
      return 0
    case 'tui':
      return runTui(command)
    case 'doctor':
      return doctor(process.cwd(), process.env)
    case 'run':
      return runHeadless(command, process.cwd(), process.env)
    case 'capture':
      if (process.env.RENSA_DEV !== '1') {
        writeLines(process.stderr, ['rensa: capture is a development command; set RENSA_DEV=1'])
        return EXIT_USAGE
      }
      return runCapture(command, process.cwd(), process.env)
  }
}

/**
 * Opens the engine, loads the TUI alongside, renders, and waits for Ink
 * to exit. The order is deliberate: `Engine.open` starts the provider
 * check subprocesses before its first await, and Ink and React load
 * through a dynamic import while they run (and stay out of `rensa run`
 * and `rensa doctor` entirely).
 *
 * Every outcome ends the process through `exitTui`: a provider check
 * still running would otherwise hold the event loop after the UI is gone.
 */
async function runTui(args: TuiArgs): Promise<never> {
  const opening = Engine.open(process.cwd())
  const loaded = await Promise.all([opening, import('../tui/app.js')]).catch((err: unknown) => {
    if (err instanceof RensaError) return err
    throw err
  })
  if (loaded instanceof RensaError) {
    // Before anything rendered: no terminal state to restore.
    writeLines(process.stderr, formatError(loaded, paintFor(process.stderr, process.env)))
    return exitTui(1)
  }
  const [engine, tui] = loaded

  let mode: ReturnType<typeof tui.resolveMode>
  try {
    mode = tui.resolveMode(args, process.env)
  } catch (err) {
    if (!(err instanceof tui.UsageError)) throw err
    writeLines(process.stderr, [`rensa: ${err.message}`, USAGE])
    return exitTui(EXIT_USAGE)
  }

  const session = tui.start(
    engine,
    args.chain !== undefined ? { name: 'detail', chain: args.chain } : { name: 'chains' },
    mode,
  )
  try {
    await session.done
  } catch (error) {
    // A React crash. Ink has restored the terminal, so this lands on the
    // primary screen. The run would otherwise go on with no UI.
    writeLines(process.stderr, [
      ...session.drainCaptured(),
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    ])
    return exitTui(1)
  }
  // Only now, after Ink restored the terminal: what was captured meanwhile.
  if (process.env.RENSA_DEBUG === '1') writeLines(process.stderr, session.drainCaptured())
  return exitTui(0)
}

/**
 * Waits until everything written to stderr has been handed to the OS
 * (a pipe is asynchronous on macOS), then exits. Exiting runs the
 * shutdown registry: provider and step children are killed and the lock
 * released, so nothing the engine started keeps the process alive.
 */
async function exitTui(code: number): Promise<never> {
  if (process.stderr.writable) {
    await new Promise<void>((resolve) => {
      process.stderr.write('', () => resolve())
    })
  }
  process.exit(code)
}

// A rejection reaches the engine's uncaughtException handler, which runs
// the shutdown callbacks and exits 1. For the headless commands the exit
// code is set rather than forced so buffered stdout drains to a pipe
// before the process ends; the TUI path exits itself (`exitTui`).
guardOutput()
void main(process.argv.slice(2)).then((code) => {
  process.exitCode = code
})
