import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { diag } from '../../diag.js'
import { type Child, type SpawnResult, spawnProcess } from '../../process/spawn.js'
import type { AgentError } from '../../run/types.js'
import type { Adapter, AgentEvent, AgentProcess, DoneEvent, SpawnRequest } from '../types.js'
import { buildArgv, stdinMessage } from './argv.js'
import { claudeAvailability } from './auth.js'
import { classifyText, parseClaude } from './parse.js'

// Claude Code as a provider: one headless `claude -p` process per turn,
// on the user's own login. The message goes to stdin as one stream-json
// line (see `stdinMessage`), so its size is not bounded by ARG_MAX.

const SCOPE = 'claude'
const PERSONA_FILE = 'persona.md'

export const claudeAdapter: Adapter = {
  provider: 'claude',

  capabilities() {
    return {
      resume: true,
      model: true,
      effort: ['low', 'medium', 'high', 'max'],
      tools: ['read', 'write'],
    }
  },

  available: claudeAvailability,

  spawn(req): AgentProcess {
    const events = new Channel<AgentEvent>()
    const proc: AgentProcess = { kill: () => control.kill(), events }
    // `pid` appears once the child exists, after the persona is staged.
    const control = new Control((pid) => {
      proc.pid = pid
    })
    void drive(req, control, events)
    return proc
  },

  parse: parseClaude,
}

/**
 * Writes the persona to `<stagingDir>/persona.md` on a session's first
 * use and returns its path; a resumed session already holds its persona.
 * Nothing else is written.
 */
export async function stagePersona(req: SpawnRequest): Promise<string | undefined> {
  if (req.persona === undefined || req.session.resume) return undefined
  await mkdir(req.stagingDir, { recursive: true })
  const file = path.join(req.stagingDir, PERSONA_FILE)
  await writeFile(file, req.persona)
  return file
}

/** How the process went: it never started (with the reason), or its result. */
export type ProcessOutcome =
  | { started: false; message: string }
  | { started: true; result: SpawnResult }

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
  const error = processError(parsed.error, result, stderr)
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
): AgentError | undefined {
  if (result.killed) return { kind: 'exit', message: result.timedOut ? 'timed out' : 'killed' }
  if (parsed) {
    if (parsed.kind === 'auth' || parsed.kind === 'usage_limit') return parsed
    return stderrError(stderr) ?? parsed
  }
  if (result.exitCode === 0 && result.signal === null) return undefined
  const how =
    result.signal === null ? `exited with code ${result.exitCode}` : `got ${result.signal}`
  const last = stderr.findLast((line) => line.trim() !== '')
  return stderrError(stderr) ?? { kind: 'exit', message: last ?? `claude ${how}` }
}

/** The first stderr line that reads as `usage_limit` or `auth`, as that error. */
function stderrError(stderr: readonly string[]): AgentError | undefined {
  for (const line of stderr) {
    const kind = classifyText(line)
    if (kind !== undefined) return { kind, message: line }
  }
  return undefined
}

const NOTHING_PARSED: DoneEvent = { kind: 'done', reply: '', exitCode: null }

/** Runs the agent, forwarding events into `out`, then pushes the final `done` and closes it. */
async function drive(req: SpawnRequest, control: Control, out: Channel<AgentEvent>): Promise<void> {
  try {
    out.push(await run(req, control, out))
  } catch (err) {
    // `run` turns every expected failure into a done; this is the backstop.
    out.push(reconcileDone(NOTHING_PARSED, { started: false, message: describe(err) }, []))
  } finally {
    out.close()
  }
}

async function run(
  req: SpawnRequest,
  control: Control,
  out: Channel<AgentEvent>,
): Promise<DoneEvent> {
  let argv: string[]
  try {
    const personaFile = await stagePersona(req)
    argv = buildArgv(req, personaFile === undefined ? {} : { personaFile })
  } catch (err) {
    return reconcileDone(NOTHING_PARSED, { started: false, message: describe(err) }, [])
  }
  if (control.killed) {
    return reconcileDone(NOTHING_PARSED, { started: false, message: 'killed' }, [])
  }

  const stdout = new Channel<string>()
  const stderr: string[] = []
  let parsed: DoneEvent | undefined
  const parsing = (async () => {
    for await (const event of parseClaude(stdout)) {
      // The parser's done is provisional; the process result refines it below.
      if (event.kind === 'done') parsed = event
      else out.push(event)
    }
  })().catch((err: unknown) => diag(SCOPE, `parser failed: ${describe(err)}`))

  let outcome: ProcessOutcome
  try {
    const child = spawnProcess({
      argv,
      cwd: req.cwd,
      env: req.env,
      stdin: stdinMessage(req.message),
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
  return reconcileDone(parsed ?? noOutput, outcome, stderr)
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
