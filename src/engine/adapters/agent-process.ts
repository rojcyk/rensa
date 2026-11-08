import { diag } from '../diag.js'
import { type Child, type SpawnResult, spawnProcess } from '../process/spawn.js'
import type { AgentError } from '../run/types.js'
import type { AgentEvent, AgentProcess, DoneEvent, Parser, SpawnRequest } from './types.js'

// The process side of an adapter, shared by every CLI that runs one
// headless process per turn: start it, pipe stdout through the parser,
// keep stderr for classification, and emit the one final `done` by the
// rules on `Adapter.spawn`. Each adapter supplies only what differs: the
// command line, its parser, and how its error messages read.

/** `usage_limit` or `auth` when a provider's message reads like one. */
export type ClassifyText = (text: string) => 'usage_limit' | 'auth' | undefined

/** How one turn is started. */
export interface CommandLine {
  argv: string[]
  /** Written to the child's stdin, which is then closed. Absent: stdin is closed at once. */
  stdin?: string
}

/** What a provider adds to the shared process handling. */
export interface AgentDriver {
  /** Names the provider in diagnostics and in fallback error messages. */
  provider: string
  parse: Parser
  classifyText: ClassifyText
  /**
   * Stages whatever the turn needs inside `stagingDir` and returns its
   * command line. A throw means the process never started.
   */
  prepare(req: SpawnRequest): Promise<CommandLine>
}

/** How the process went: it never started (with the reason), or its result. */
export type ProcessOutcome =
  | { started: false; message: string }
  | { started: true; result: SpawnResult }

/** Starts one turn of `driver`'s CLI; `events` ends with the one final `done`. */
export function spawnAgent(req: SpawnRequest, driver: AgentDriver): AgentProcess {
  const events = new Channel<AgentEvent>()
  const proc: AgentProcess = { kill: () => control.kill(), events }
  // `pid` appears once the child exists, after `prepare` has staged its files.
  const control = new Control((pid) => {
    proc.pid = pid
  })
  void drive({ req, driver, control, out: events })
  return proc
}

/**
 * The one final `done`, from the parser's provisional one, the process
 * outcome and the stderr lines, by the rules on `Adapter.spawn`: reply
 * and usage from the parser, exit code from the process, and the error
 * of the first rule that applies.
 */
export function reconcileDone(
  parsed: DoneEvent,
  outcome: ProcessOutcome,
  stderr: readonly string[],
  driver: Pick<AgentDriver, 'provider' | 'classifyText'>,
): DoneEvent {
  const { reply, usage, sessionId } = parsed
  const base = {
    kind: 'done' as const,
    reply,
    ...(usage && { usage }),
    ...(sessionId !== undefined && { sessionId }),
  }
  if (!outcome.started) {
    return { ...base, exitCode: null, error: { kind: 'exit', message: outcome.message } }
  }
  const { result } = outcome
  const error = processError(parsed.error, result, stderr, driver)
  return {
    ...base,
    exitCode: result.signal === null ? result.exitCode : null,
    ...(error && { error }),
  }
}

function processError(
  parsed: AgentError | undefined,
  result: SpawnResult,
  stderr: readonly string[],
  driver: Pick<AgentDriver, 'provider' | 'classifyText'>,
): AgentError | undefined {
  if (result.killed) return { kind: 'exit', message: result.timedOut ? 'timed out' : 'killed' }
  if (parsed) {
    if (parsed.kind === 'auth' || parsed.kind === 'usage_limit') return parsed
    return stderrError(stderr, driver.classifyText) ?? parsed
  }
  if (result.exitCode === 0 && result.signal === null) return undefined
  const how =
    result.signal === null ? `exited with code ${result.exitCode}` : `got ${result.signal}`
  const last = stderr.findLast((line) => line.trim() !== '')
  return (
    stderrError(stderr, driver.classifyText) ?? {
      kind: 'exit',
      message: last ?? `${driver.provider} ${how}`,
    }
  )
}

/** The first stderr line that reads as `usage_limit` or `auth`, as that error. */
function stderrError(stderr: readonly string[], classify: ClassifyText): AgentError | undefined {
  for (const line of stderr) {
    const kind = classify(line)
    if (kind !== undefined) return { kind, message: line }
  }
  return undefined
}

const NOTHING_PARSED: DoneEvent = { kind: 'done', reply: '', exitCode: null }

/** One turn in flight: what was asked, by which driver, and where its events go. */
interface Turn {
  req: SpawnRequest
  driver: AgentDriver
  control: Control
  out: Channel<AgentEvent>
}

/** Runs the agent, forwarding events into `turn.out`, then pushes the final `done` and closes it. */
async function drive(turn: Turn): Promise<void> {
  try {
    turn.out.push(await run(turn))
  } catch (err) {
    // `run` turns every expected failure into a done; this is the backstop.
    const message = describe(err)
    turn.out.push(reconcileDone(NOTHING_PARSED, { started: false, message }, [], turn.driver))
  } finally {
    turn.out.close()
  }
}

async function run({ req, driver, control, out }: Turn): Promise<DoneEvent> {
  let command: CommandLine
  try {
    command = await driver.prepare(req)
  } catch (err) {
    return reconcileDone(NOTHING_PARSED, { started: false, message: describe(err) }, [], driver)
  }
  if (control.killed) {
    return reconcileDone(NOTHING_PARSED, { started: false, message: 'killed' }, [], driver)
  }

  const stdout = new Channel<string>()
  const stderr: string[] = []
  let parsed: DoneEvent | undefined
  const parsing = (async () => {
    for await (const event of driver.parse(stdout)) {
      // The parser's done is provisional; the process result refines it below.
      if (event.kind === 'done') parsed = event
      else out.push(event)
    }
  })().catch((err: unknown) => diag(driver.provider, `parser failed: ${describe(err)}`))

  let outcome: ProcessOutcome
  try {
    const child = spawnProcess({
      argv: command.argv,
      cwd: req.cwd,
      env: req.env,
      ...(command.stdin !== undefined && { stdin: command.stdin }),
      timeoutMs: req.timeoutMs,
      onStdout: (line) => stdout.push(line),
      onStderr: (line) => {
        stderr.push(line)
        out.push({ kind: 'raw', line: `stderr: ${line}` })
      },
    })
    control.attach(child)
    outcome = { started: true, result: await child.result }
  } catch (err) {
    outcome = { started: false, message: describe(err) }
  }
  // The result settles only after both pipes have ended: no more lines come.
  stdout.close()
  await parsing
  const noOutput: DoneEvent = {
    ...NOTHING_PARSED,
    error: { kind: 'no_output', message: 'the parser ended without a done' },
  }
  return reconcileDone(parsed ?? noOutput, outcome, stderr, driver)
}

/** Carries `kill()` to a child that may not exist yet. */
class Control {
  private child: Child | undefined
  private wasKilled = false

  constructor(private readonly onPid: (pid: number) => void) {}

  get killed(): boolean {
    return this.wasKilled
  }

  kill(): void {
    this.wasKilled = true
    this.child?.kill()
  }

  attach(child: Child): void {
    this.child = child
    if (child.pid !== undefined) this.onPid(child.pid)
    if (this.wasKilled) child.kill()
  }
}

/** An unbounded queue read once as an async iterable; ends after `close()`. */
class Channel<T> implements AsyncIterable<T> {
  private items: T[] = []
  private closed = false
  private wake: (() => void) | undefined

  push(item: T): void {
    if (this.closed) return
    this.items.push(item)
    this.notify()
  }

  close(): void {
    this.closed = true
    this.notify()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      if (this.items.length > 0) {
        yield* this.items.splice(0)
        continue
      }
      if (this.closed) return
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
    }
  }

  private notify(): void {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
