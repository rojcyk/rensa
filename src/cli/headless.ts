import {
  applyEvent,
  Engine,
  initialSteps,
  onInterrupt,
  RensaError,
  type ResolvedChain,
  type RunEvent,
  type RunHandle,
  type RunResult,
  type RunStatus,
  reduceRun,
  type StepView,
  type TranscriptRecord,
} from '../engine/index.js'
import type { OutputMode, RunArgs } from './args.js'
import {
  formatError,
  formatEvent,
  formatRecord,
  formatRunFinished,
  type MajorKeyword,
  onStdoutClosed,
  type Paint,
  paintFor,
  streamDiag,
  writeLines,
} from './format.js'

/** A second ctrl+c within this window exits at once. */
const DOUBLE_PRESS_MS = 2000
const EXIT_INTERRUPTED = 130
const MAJOR: ReadonlySet<string> = new Set<MajorKeyword>(['run', 'step', 'agent'])
const TERMINAL: ReadonlySet<string> = new Set<RunStatus>(['complete', 'failed', 'aborted'])

/** `rensa run`: runs a chain with no UI, printing lines to stdout. Returns the exit code. */
export async function runHeadless(
  args: RunArgs,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const errPaint = paintFor(process.stderr, env)
  // Before anything starts, so diagnostics from the provider check show too.
  const stopDiag = streamDiag(env)
  const stopper = new Stopper()
  const stopInterrupt = onInterrupt(() => stopper.press())
  const stopReader = onStdoutClosed(() => stopper.readerGone())
  try {
    let started: { handle: RunHandle; chain: ResolvedChain }
    try {
      started = await start(args, cwd)
    } catch (err) {
      if (!(err instanceof RensaError)) throw err
      writeLines(process.stderr, formatError(err, errPaint))
      return stopper.interrupted ? EXIT_INTERRUPTED : 1
    }
    stopper.bind(started.handle)
    const printer = new RunPrinter(started.handle.id, started.chain, args.output, {
      out: paintFor(process.stdout, env),
      err: errPaint,
    })
    const result = await follow(started.handle, printer)
    return result.status === 'complete' ? 0 : 1
  } finally {
    stopInterrupt()
    stopReader()
    stopDiag()
  }
}

async function start(
  args: RunArgs,
  cwd: string,
): Promise<{ handle: RunHandle; chain: ResolvedChain }> {
  const engine = await Engine.open(cwd)
  const chain = engine.chain(args.chain)
  const handle = await engine.start(args.chain, args.input, {
    headless: true,
    noPause: args.noPause,
    ...(args.base !== undefined && { base: args.base }),
  })
  return { handle, chain }
}

/**
 * Subscribes, then prints the history the subscription was taken with,
 * before any live event can arrive (listeners fire only after this
 * synchronous code returns).
 */
function follow(handle: RunHandle, printer: RunPrinter): Promise<RunResult> {
  const { events, result } = handle.attach({
    event: (event) => printer.event(event),
    transcript: (m) => printer.transcript(m),
    finished: (r) => printer.finished(r),
  })
  for (const event of events) printer.event(event)
  if (result) printer.finished(result)
  return handle.done
}

/**
 * Prints one run. Keeps the step views and the events seen so far so
 * durations come from the engine's view functions; it never works out
 * state itself.
 */
class RunPrinter {
  private steps: Map<string, StepView>
  private readonly events: RunEvent[] = []

  constructor(
    private readonly runId: string,
    chain: ResolvedChain,
    private readonly mode: OutputMode,
    private readonly paint: { out: Paint; err: Paint },
  ) {
    this.steps = initialSteps(chain.steps)
  }

  event(event: RunEvent): void {
    this.steps = applyEvent(this.steps, event)
    this.events.push(event)
    if (this.mode === 'json') {
      writeLines(process.stdout, [JSON.stringify(event)])
      return
    }
    const line = formatEvent(event, {
      runId: this.runId,
      steps: this.steps,
      events: this.events,
      paint: this.paint.out,
    })
    if (this.mode === 'quiet' && !MAJOR.has(line.keyword)) return
    writeLines(process.stdout, [line.text])
  }

  transcript(m: { step: string; label: string; record: TranscriptRecord }): void {
    if (this.mode === 'json') writeLines(process.stdout, [JSON.stringify(m)])
    else if (this.mode === 'lines') writeLines(process.stdout, formatRecord(m, this.paint.out))
  }

  /**
   * The finish line is the `run.finished` event's job; this prints one
   * only when no such event arrived (it could not be written), judged by
   * the engine's view of the printed events.
   */
  finished(result: RunResult): void {
    const progress = reduceRun(this.events)
    if (!TERMINAL.has(progress.status)) {
      const line =
        this.mode === 'json'
          ? JSON.stringify({ result })
          : formatRunFinished(result, progress.startedAt, this.paint.out)
      writeLines(process.stdout, [line])
    }
    if (result.error) writeLines(process.stderr, formatError(result.error, this.paint.err))
  }
}

/**
 * Ends the run early. ctrl+c: the first press aborts the run, which ends
 * once the child has exited and the lock is released; a second press
 * within 2 s exits at once, and the exit path's shutdown callbacks do the
 * cleanup. A reader that closes stdout (`| head`) aborts the same way:
 * nobody is left to see the run.
 */
class Stopper {
  private lastPress: number | undefined
  private requested = false
  private handle: RunHandle | undefined

  /** ctrl+c was pressed. */
  get interrupted(): boolean {
    return this.lastPress !== undefined
  }

  press(): void {
    const now = Date.now()
    if (this.lastPress !== undefined && now - this.lastPress <= DOUBLE_PRESS_MS) {
      process.exit(EXIT_INTERRUPTED)
    }
    this.lastPress = now
    this.abort('aborting…')
  }

  readerGone(): void {
    this.abort('aborting: stdout was closed')
  }

  /** A request that came while the run was starting aborts it as soon as it exists. */
  bind(handle: RunHandle): void {
    this.handle = handle
    if (this.requested) handle.abort()
  }

  private abort(notice: string): void {
    if (!this.requested) writeLines(process.stderr, [notice])
    this.requested = true
    this.handle?.abort()
  }
}
