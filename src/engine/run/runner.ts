import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { constants } from 'node:os'
import { getAdapter } from '../adapters/registry.js'
import type { AgentProcess, DoneEvent } from '../adapters/types.js'
import type { AgentStep, ResolvedChain, ShellStep, Step } from '../config/types.js'
import { diag } from '../diag.js'
import { RensaError } from '../errors.js'
import { childEnv } from '../process/env.js'
import { runShellStep } from '../process/shell.js'
import { KillSignal } from '../process/spawn.js'
import type { Namespace, StepResult } from '../template/namespace.js'
import { appendNotes, extractTrailingJson, tail } from '../template/output.js'
import { render } from '../template/render.js'
import { appendSkills, readSkill, stageSkills } from '../template/skills.js'
import { evaluateVars } from '../template/vars.js'
import type { RunDir } from './dir.js'
import type { EventLog } from './events.js'
import type { Lock } from './lock.js'
import { RingBuffer } from './ringBuffer.js'
import { type RunJson, writeRunJson } from './runjson.js'
import { TranscriptWriter } from './transcript.js'
import type {
  NewRunEvent,
  NewTranscriptRecord,
  RunEvent,
  RunStatus,
  StepStatus,
  TranscriptRecord,
  Usage,
} from './types.js'
import { turnUsage } from './usage.js'
import type { RunError, RunResult } from './view.js'

/** Bytes of a shell step's output kept in `steps.<id>.output`. */
const SHELL_OUTPUT_MAX_BYTES = 16_384
const STORAGE_HINT = 'check free space and permissions under .rensa/runs'
const SCOPE = 'engine'
/** Records kept in memory per transcript; older ones remain on disk only. */
const TRANSCRIPT_CAPACITY = 5000

export type RunInput =
  | { kind: 'none' }
  | { kind: 'text'; text: string }
  | { kind: 'file'; path: string }

/** Per-run streams. Every listener is called after the handle's state includes what it reports. */
export interface RunListeners {
  /** One per `events.jsonl` line. */
  event?(event: RunEvent): void
  /** After the record is queued for disk. */
  transcript?(m: { step: string; label: string; record: TranscriptRecord }): void
  /** Streaming text; never on disk. */
  delta?(m: { step: string; label: string; text: string }): void
  /** Exactly once, after the finish sequence, even when `run.finished` could not be written. */
  finished?(result: RunResult): void
}

export interface RunHandle {
  id: string
  /** The run directory. */
  dir: string
  pause(): void
  resume(): void
  kill(): void
  abort(): void
  note(text: string): void
  /** The run's in-memory terminal state; never rejects. */
  done: Promise<RunResult>
  /** Set at the moment `finished` fires. */
  result(): RunResult | undefined
  /**
   * The in-memory transcript of one agent (or `shell`) of one step,
   * created on first use. Holds a record before `'transcript'` reports it.
   */
  transcript(step: string, label: string): RingBuffer<TranscriptRecord>
  /**
   * Every delta received for the key since its last record, concatenated;
   * undefined once a record or the agent's end clears it. Includes a delta
   * before `'delta'` reports it.
   */
  partial(step: string, label: string): string | undefined
  /** Every event so far, in `seq` order. */
  events(): ReadonlyArray<RunEvent>
  /** The history and a subscription, taken in one synchronous step. */
  attach(listeners: RunListeners): {
    events: ReadonlyArray<RunEvent>
    result?: RunResult
    detach(): void
  }
}

export interface RunnerOptions {
  id: string
  runDir: RunDir
  /** Working directory of every step: the repository root. */
  cwd: string
  chain: ResolvedChain
  input: { text?: string; path?: string }
  base: { ref: string; sha: string }
  noPause: boolean
  log: EventLog
  runJson: RunJson
  lock?: Lock
  rensaVersion: string
}

interface StepOutcome {
  status: StepStatus
  exitCode?: number
  /** An engine error (template, config) that ends the run whatever `on_fail` says. */
  error?: RunError
}

type State = 'idle' | 'running' | 'paused' | 'aborting' | 'finished'

/**
 * One run's state machine. The loop advances step by step; commands
 * change state and signal the running step, and only the loop, through
 * `finish`, ends the run.
 *
 * Rule: every state change is complete before the event that announces
 * it is emitted. Listeners run synchronously inside `emit` and may call
 * any command at once, so a command must find the state, the wake
 * callback and the kill signal it acts on already in place.
 */
export class Runner implements RunHandle {
  readonly id: string
  readonly dir: string
  readonly done: Promise<RunResult>

  private resolveDone: (result: RunResult) => void = () => {}
  private state: State = 'idle'
  /** Set from the first finish action on; commands are ignored after it. */
  private finishing = false
  private readonly history: RunEvent[] = []
  private readonly listeners = new Set<RunListeners>()
  private current: { id: string; kill: KillSignal } | undefined
  private pendingPause = false
  private wake: (() => void) | undefined
  /** Index of the first step that has not started. */
  private nextIndex = 0
  private readonly notes: Array<{ text: string; from: number }> = []
  private readonly results: Record<string, StepResult> = {}
  private readonly writers = new Set<TranscriptWriter>()
  private readonly buffers = new Map<string, RingBuffer<TranscriptRecord>>()
  private readonly partials = new Map<string, string>()
  /** The first engine or storage error; once set the run stops advancing and ends `failed`. */
  private fatal: { error: RunError; step?: string } | undefined
  private finalResult: RunResult | undefined

  constructor(private readonly o: RunnerOptions) {
    this.id = o.id
    this.dir = o.runDir.root
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve
    })
  }

  /** Emits `run.started` and schedules the loop after the caller's continuation. */
  begin(): void {
    const { chain, base, input } = this.o
    this.emit({
      type: 'run.started',
      data: {
        chain: chain.name,
        input_kind: chain.input,
        ...(input.path !== undefined && { input_path: input.path }),
        base: base.ref,
        base_sha: base.sha,
        rensa_version: this.o.rensaVersion,
      },
    })
    // A macrotask, so a caller that calls abort() right after start()
    // resolves sees no step start first.
    setImmediate(() => {
      void this.run()
    })
  }

  // -------------------------------------------------------------------------
  // Handle
  // -------------------------------------------------------------------------

  result(): RunResult | undefined {
    return this.finalResult
  }

  events(): ReadonlyArray<RunEvent> {
    return this.history.slice()
  }

  transcript(step: string, label: string): RingBuffer<TranscriptRecord> {
    const key = transcriptKey(step, label)
    let buffer = this.buffers.get(key)
    if (!buffer) {
      buffer = new RingBuffer<TranscriptRecord>(TRANSCRIPT_CAPACITY)
      this.buffers.set(key, buffer)
    }
    return buffer
  }

  partial(step: string, label: string): string | undefined {
    return this.partials.get(transcriptKey(step, label))
  }

  attach(listeners: RunListeners): {
    events: ReadonlyArray<RunEvent>
    result?: RunResult
    detach(): void
  } {
    const events = this.history.slice()
    if (this.finalResult) {
      return { events, result: this.finalResult, detach: () => {} }
    }
    this.listeners.add(listeners)
    return { events, detach: () => this.listeners.delete(listeners) }
  }

  pause(): void {
    if (this.finishing || this.pendingPause) return
    if (this.state === 'paused' || this.state === 'aborting') return
    this.pendingPause = true
    this.emit({
      type: 'user.action',
      data: { action: 'pause', ...(this.current && { step: this.current.id }) },
    })
  }

  resume(): void {
    if (this.finishing || this.state !== 'paused') return
    // Running from here on, so a pause() right after this is a new request.
    this.state = 'running'
    this.takeWake()?.()
  }

  kill(): void {
    const current = this.current
    if (this.finishing || !current || current.kill.killed) return
    current.kill.kill()
    this.emit({ type: 'user.action', data: { action: 'kill', step: current.id } })
  }

  abort(): void {
    if (this.finishing || this.state === 'aborting') return
    this.state = 'aborting'
    const current = this.current
    current?.kill.kill()
    this.takeWake()?.()
    this.emit({
      type: 'user.action',
      data: { action: 'abort', ...(current && { step: current.id }) },
    })
  }

  note(text: string): void {
    if (this.finishing) return
    const next = this.o.chain.steps[this.nextIndex]
    this.notes.push({ text, from: this.nextIndex })
    // After the last step has started a note applies to no step.
    this.emit({ type: 'user.note', data: { text, applies_from: next?.id ?? '' } })
  }

  /** Removes and returns the pending wake callback, so it fires at most once. */
  private takeWake(): (() => void) | undefined {
    const wake = this.wake
    this.wake = undefined
    return wake
  }

  // -------------------------------------------------------------------------
  // Loop
  // -------------------------------------------------------------------------

  private stopping(): boolean {
    return this.state === 'aborting' || this.fatal !== undefined
  }

  private async run(): Promise<void> {
    let status: RunStatus = 'complete'
    let failedStep: string | undefined
    try {
      for (const [index, step] of this.o.chain.steps.entries()) {
        if (this.stopping()) break
        const declaredBefore = step.pause === 'before' && !this.o.noPause
        if (declaredBefore || this.pendingPause) {
          await this.pauseAt({ before: step.id }, declaredBefore ? 'declared' : 'user')
          if (this.stopping()) break
        }

        this.nextIndex = index + 1
        this.state = 'running'
        const kill = new KillSignal()
        this.current = { id: step.id, kill }
        this.emit({
          type: 'step.started',
          step: step.id,
          data:
            step.kind === 'shell' ? { kind: 'shell', command: step.command } : { kind: 'agent' },
        })
        const outcome =
          step.kind === 'shell'
            ? await this.runShell(step, index, kill)
            : await this.runAgent(step, index, kill)
        this.o.runJson.steps[step.id] = {
          ...this.o.runJson.steps[step.id],
          status: outcome.status,
          agents: this.o.runJson.steps[step.id]?.agents ?? {},
        }
        if (outcome.error) this.fatal ??= { error: outcome.error, step: step.id }
        // The step is over before it is announced: a kill() from a
        // step.finished listener has nothing left to kill.
        this.current = undefined
        this.emit({
          type: 'step.finished',
          step: step.id,
          data: {
            status: outcome.status,
            ...(outcome.exitCode !== undefined && { exit_code: outcome.exitCode }),
          },
        })
        await this.flushLog(step.id)
        if (this.stopping()) break

        if (outcome.status !== 'ok' && step.onFail === 'stop') {
          status = 'failed'
          failedStep = step.id
          break
        }
        const declaredAfter = step.pause === 'after' && !this.o.noPause
        if (declaredAfter || this.pendingPause) {
          await this.pauseAt({ after: step.id }, declaredAfter ? 'declared' : 'user')
          if (this.stopping()) break
        }
      }
    } catch (err) {
      // Nothing above is meant to throw; this keeps `done` from hanging if it does.
      this.fatal ??= {
        error: { code: 'INTERNAL', message: describe(err) },
        ...(this.current && { step: this.current.id }),
      }
      this.current?.kill.kill()
    }
    this.current = undefined
    await this.finish(status, failedStep)
  }

  private async pauseAt(
    at: { before: string } | { after: string },
    reason: 'declared' | 'user',
  ): Promise<void> {
    this.pendingPause = false
    this.state = 'paused'
    // The executor runs synchronously: `wake` is in place before any
    // run.paused listener can call resume() or abort().
    const woken = new Promise<void>((resolve) => {
      this.wake = resolve
    })
    this.emit({ type: 'run.paused', data: { ...at, reason } })
    // resume() leaves `running`, abort() leaves `aborting`.
    await woken
  }

  // -------------------------------------------------------------------------
  // Steps
  // -------------------------------------------------------------------------

  private async runShell(step: ShellStep, index: number, kill: KillSignal): Promise<StepOutcome> {
    if (this.stopping() || kill.killed) return { status: 'killed' }
    const writer = this.writer(step.id, 'shell')
    this.recordNotes(step, index, writer)
    try {
      const res = await runShellStep({
        command: step.command,
        cwd: this.o.cwd,
        env: this.stepEnv(step.id),
        timeoutMs: step.timeoutMs,
        outputPath: this.o.runDir.stepOutput(step.id),
        onLine: (line) => this.record(step.id, 'shell', writer, { kind: 'text', text: line }),
        signal: kill,
      })
      const exitCode = res.exitCode ?? signalExitCode(res.signal)
      this.results[step.id] = {
        kind: 'shell',
        output: tail(res.output, SHELL_OUTPUT_MAX_BYTES, res.outputPath),
        passed: res.status === 'ok',
        exit_code: exitCode,
      }
      return { status: res.status, exitCode }
    } catch (err) {
      this.storageFailed(err)
      return { status: 'failed' }
    } finally {
      await this.closeWriter(writer)
    }
  }

  private async runAgent(step: AgentStep, index: number, kill: KillSignal): Promise<StepOutcome> {
    const { agent } = step
    const { label } = agent
    const halted = () => this.stopping() || kill.killed
    if (halted()) return { status: 'killed' }

    const ns = this.namespace()
    let vars: Record<string, unknown>
    try {
      vars = await evaluateVars(
        step.vars,
        ns,
        this.o.cwd,
        childEnv(process.env, { allowApiKeys: this.o.chain.allowApiKeys }),
        kill,
      )
    } catch (err) {
      return halted() ? { status: 'killed' } : this.engineFailure(err)
    }
    if (halted()) return { status: 'killed' }

    const session = this.session(step)
    let message: string
    let persona: string | undefined
    try {
      message = render(await readText(step.prompt, 'step prompt'), vars, ns)
      if (halted()) return { status: 'killed' }
      // A resumed session already holds its persona and skills.
      if (!session.resume) {
        if (agent.skills.length > 0) {
          const staged = await stageSkills(
            this.o.runDir,
            agent.skills.map((dir) => ({ dir })),
          )
          if (halted()) return { status: 'killed' }
          const withBodies = await Promise.all(
            staged.map(async (s) => ({
              name: s.name,
              dir: s.dir,
              body: (await readSkill(s.dir)).body,
            })),
          )
          message = appendSkills(message, withBodies)
        }
        if (agent.prompt !== undefined) {
          persona = render(await readText(agent.prompt, 'agent prompt'), vars, ns)
        }
      }
      message = appendNotes(
        message,
        this.notes.filter((n) => n.from <= index).map((n) => n.text),
      )
    } catch (err) {
      if (halted()) return { status: 'killed' }
      if (!(err instanceof RensaError)) {
        this.storageFailed(err)
        return { status: 'failed' }
      }
      return this.engineFailure(err)
    }
    if (halted()) return { status: 'killed' }

    const writer = this.writer(step.id, label)
    this.recordNotes(step, index, writer)
    try {
      return await this.spawnAgent(step, kill, writer, session, message, persona)
    } finally {
      await this.closeWriter(writer)
    }
  }

  private async spawnAgent(
    step: AgentStep,
    kill: KillSignal,
    writer: TranscriptWriter,
    session: { id: string; resume: boolean },
    message: string,
    persona: string | undefined,
  ): Promise<StepOutcome> {
    const { agent } = step
    const { label } = agent
    try {
      await writer.prompt(message)
    } catch (err) {
      this.storageFailed(err)
      return { status: 'failed' }
    }
    if (this.stopping() || kill.killed) return { status: 'killed' }
    if (agent.session === 'named' && agent.name !== undefined) {
      this.o.runJson.sessions[agent.name] = session.id
    }

    this.emit({
      type: 'agent.spawned',
      step: step.id,
      agent: label,
      data: {
        provider: agent.provider,
        ...(agent.model !== undefined && { model: agent.model }),
        ...(agent.effort !== undefined && { effort: agent.effort }),
        tools: agent.tools,
        session_id: session.id,
        resumed: session.resume,
      },
    })

    let done: DoneEvent | undefined
    let usage: Usage | undefined
    let timedOut = false
    let proc: AgentProcess | undefined
    let sessionTotals = false
    try {
      const adapter = getAdapter(agent.provider)
      sessionTotals = adapter.capabilities().usage === 'session_total'
      proc = adapter.spawn({
        cwd: this.o.cwd,
        env: this.stepEnv(step.id),
        message,
        ...(persona !== undefined && { persona }),
        ...(agent.model !== undefined && { model: agent.model }),
        ...(agent.effort !== undefined && { effort: agent.effort }),
        tools: agent.tools,
        session,
        stagingDir: this.o.runDir.agentDir(step.id, label),
        timeoutMs: step.timeoutMs,
      })
    } catch (err) {
      done = {
        kind: 'done',
        reply: '',
        exitCode: null,
        error: { kind: 'exit', message: describe(err) },
      }
    }

    if (proc) {
      const running = proc
      const timer = setTimeout(() => {
        timedOut = true
        running.kill()
      }, step.timeoutMs)
      const dropKill = kill.onKill(() => running.kill())
      try {
        for await (const event of running.events) {
          switch (event.kind) {
            case 'raw':
              writer.raw(event.line)
              break
            case 'delta':
              this.delta(step.id, label, event.text)
              break
            case 'text':
            case 'tool':
            case 'note':
              this.record(step.id, label, writer, event)
              break
            case 'usage':
              usage = event.usage
              break
            case 'done':
              this.partials.delete(transcriptKey(step.id, label))
              done = event
              break
            default:
              diag(SCOPE, `unknown agent event: ${JSON.stringify(event).slice(0, 200)}`)
          }
        }
      } catch (err) {
        // The contract says events never throw; stop the agent if they do.
        diag(SCOPE, `${step.id}/${label}: agent events failed: ${describe(err)}`)
        running.kill()
        done ??= {
          kind: 'done',
          reply: '',
          exitCode: null,
          error: { kind: 'exit', message: describe(err) },
        }
      } finally {
        clearTimeout(timer)
        dropKill()
        // An agent that ended without a final event leaves no partial behind either.
        this.partials.delete(transcriptKey(step.id, label))
      }
    }
    done ??= {
      kind: 'done',
      reply: '',
      exitCode: null,
      error: { kind: 'no_output', message: 'the agent ended without a final event' },
    }

    try {
      await writer.reply(done.reply)
    } catch (err) {
      this.storageFailed(err)
    }
    const status: StepStatus = timedOut
      ? 'timeout'
      : kill.killed
        ? 'killed'
        : done.exitCode === 0 && !done.error
          ? 'ok'
          : 'failed'
    const reported = done.usage ?? usage
    const finalUsage = sessionTotals ? this.turnUsage(step, session, reported) : reported
    this.emit({
      type: 'agent.finished',
      step: step.id,
      agent: label,
      data: {
        status,
        ...(done.exitCode !== null && { exit_code: done.exitCode }),
        ...(finalUsage !== undefined && { usage: finalUsage }),
        ...(done.error !== undefined && { error: done.error }),
      },
    })
    if (done.sessionId !== undefined && agent.session === 'named' && agent.name !== undefined) {
      this.o.runJson.sessions[agent.name] = done.sessionId
    }
    this.o.runJson.steps[step.id] = { status, agents: { [label]: status } }
    this.results[step.id] = {
      kind: 'agent',
      output: { [label]: extractTrailingJson(done.reply) ?? done.reply },
      text: done.reply,
    }
    return { status, ...(done.exitCode !== null && { exitCode: done.exitCode }) }
  }

  /**
   * The usage `agent.finished` reports for one turn of a provider whose
   * capabilities say `usage: 'session_total'` (Codex): it reports the
   * session's running totals, where the others report the turn's own
   * usage and skip this. For a named agent the totals are
   * kept in run.json (`session_usage`) and a resumed turn reports the
   * difference from the previous ones, so every provider's numbers mean
   * the same. The subtraction is here, not in the adapter, because only
   * the engine knows a session's earlier turns; the parser stays pure. The
   * baseline moves only when this turn reported totals; a turn that failed
   * or was killed before reporting any leaves it as it was.
   */
  private turnUsage(
    step: AgentStep,
    session: { resume: boolean },
    reported: Usage | undefined,
  ): Usage | undefined {
    const { agent } = step
    // A fresh agent's session has one turn, so its totals are the turn's.
    if (agent.session !== 'named' || agent.name === undefined) return reported
    const baselines = this.o.runJson.session_usage
    const baseline = session.resume ? baselines?.[agent.name] : undefined
    if (reported === undefined) {
      // A first use that reported nothing leaves no baseline for its session.
      if (!session.resume && baselines) delete baselines[agent.name]
      return undefined
    }
    this.o.runJson.session_usage = { ...baselines, [agent.name]: reported }
    if (baseline === undefined) return reported
    const { usage, clamped } = turnUsage(reported, baseline)
    if (clamped) {
      diag(
        SCOPE,
        `${step.id}/${agent.label}: session usage totals fell below the previous turn's; clamped at 0`,
      )
    }
    return usage
  }

  /** Named agents resume their session after the first use; fresh ones never do. */
  private session(step: AgentStep): { id: string; resume: boolean } {
    const { agent } = step
    if (agent.session === 'named' && agent.name !== undefined) {
      const existing = this.o.runJson.sessions[agent.name]
      if (existing !== undefined) return { id: existing, resume: true }
    }
    return { id: randomUUID(), resume: false }
  }

  private namespace(): Namespace {
    const { input, base, chain } = this.o
    return {
      ...(chain.input !== 'none' && input.text !== undefined && { input: input.text }),
      ...(input.path !== undefined && { input_path: input.path }),
      base: base.ref,
      run_id: this.id,
      steps: { ...this.results },
    }
  }

  private stepEnv(stepId: string): NodeJS.ProcessEnv {
    return childEnv(process.env, {
      allowApiKeys: this.o.chain.allowApiKeys,
      extra: { RENSA_RUN_ID: this.id, RENSA_STEP: stepId, RENSA_BASE: this.o.base.ref },
    })
  }

  // -------------------------------------------------------------------------
  // Emission
  // -------------------------------------------------------------------------

  /** Appends to the log, then delivers. */
  private emit(e: NewRunEvent): void {
    this.deliver(this.o.log.append(e))
  }

  /** Adds an appended event to the history, then tells the listeners. */
  private deliver(event: RunEvent): void {
    this.history.push(event)
    for (const l of [...this.listeners]) call(() => l.event?.(event))
  }

  private record(
    step: string,
    label: string,
    writer: TranscriptWriter,
    r: NewTranscriptRecord,
  ): void {
    const record = writer.record(r)
    this.transcript(step, label).push(record)
    this.partials.delete(transcriptKey(step, label))
    for (const l of [...this.listeners]) call(() => l.transcript?.({ step, label, record }))
  }

  /**
   * The notes that apply from this step (`applies_from`), as the first
   * records of its transcript: once, in this step only. Later steps get
   * them in their prompt (`appendNotes`) but not in their transcript. A
   * note sent after the last step started matches no step.
   */
  private recordNotes(step: Step, index: number, writer: TranscriptWriter): void {
    const label = step.kind === 'agent' ? step.agent.label : 'shell'
    for (const note of this.notes) {
      if (note.from === index) {
        this.record(step.id, label, writer, { kind: 'note', text: note.text })
      }
    }
  }

  private delta(step: string, label: string, text: string): void {
    const key = transcriptKey(step, label)
    this.partials.set(key, (this.partials.get(key) ?? '') + text)
    for (const l of [...this.listeners]) call(() => l.delta?.({ step, label, text }))
  }

  private writer(step: string, label: string): TranscriptWriter {
    const writer = new TranscriptWriter(this.o.runDir, step, label)
    this.writers.add(writer)
    return writer
  }

  private async closeWriter(writer: TranscriptWriter): Promise<void> {
    this.writers.delete(writer)
    try {
      await writer.close()
    } catch (err) {
      this.storageFailed(err)
    }
  }

  /** `step` is the step that just finished, for the failure's `failedStep`. */
  private async flushLog(step: string): Promise<void> {
    try {
      await this.o.log.flush()
    } catch (err) {
      this.storageFailed(err, step)
    }
  }

  // -------------------------------------------------------------------------
  // Failure and finish
  // -------------------------------------------------------------------------

  /** A failed write: remember the first, stop advancing, stop the running child. */
  private storageFailed(err: unknown, step: string | undefined = this.current?.id): void {
    this.fatal ??= {
      error: { code: 'STORAGE', message: describe(err), hint: STORAGE_HINT },
      ...(step !== undefined && { step }),
    }
    this.current?.kill.kill()
  }

  private engineFailure(err: unknown): StepOutcome {
    if (err instanceof RensaError) {
      diag(SCOPE, `${err.code}: ${err.message}`)
      return {
        status: 'failed',
        error: {
          code: err.code,
          message: err.message,
          ...(err.hint !== undefined && { hint: err.hint }),
        },
      }
    }
    return { status: 'failed', error: { code: 'INTERNAL', message: describe(err) } }
  }

  /**
   * Runs once, after the loop has ended and no child is running.
   *
   * Success is announced only once it is durable. Transcripts, the log so
   * far and run.json are written first; then run.finished is appended,
   * flushed, and only then delivered to listeners. Any failure turns the
   * run `failed`. A run.finished that did not reach disk is never
   * delivered, so the history matches the file. The result, which every
   * live consumer receives through `finished` and `done`, is the
   * authority either way. Writes are best-effort once storage has
   * failed; the lock release and the result are not.
   */
  private async finish(status: RunStatus, failedStep: string | undefined): Promise<void> {
    this.finishing = true
    if (this.state === 'aborting') status = 'aborted'

    for (const writer of [...this.writers]) await this.attempt(() => writer.close())
    this.writers.clear()
    await this.attempt(() => this.o.log.flush())
    ;({ status, failedStep } = this.settle(status, failedStep))

    const runJson = this.o.runJson
    const finishedAt = new Date().toISOString()
    runJson.finished_at = finishedAt
    runJson.status = status
    await this.attempt(() => writeRunJson(this.o.runDir.runJson, runJson))
    ;({ status, failedStep } = this.settle(status, failedStep))

    const finished = this.o.log.append({
      type: 'run.finished',
      data: { status, ...(failedStep !== undefined && { failed_step: failedStep }) },
    })
    const durable = await this.attempt(() => this.o.log.close())
    if (durable) {
      this.deliver(finished)
    } else {
      ;({ status, failedStep } = this.settle(status, failedStep))
      // run.json may already say otherwise; correct it if the disk lets us.
      if (runJson.status !== status) {
        runJson.status = status
        await this.attempt(() => writeRunJson(this.o.runDir.runJson, runJson))
      }
    }

    try {
      this.o.lock?.release()
    } catch (err) {
      // Left registered; the shutdown callback tries again at exit.
      diag(SCOPE, `cannot release ${this.o.lock?.path}: ${describe(err)}`)
    }

    const result: RunResult = {
      status,
      finishedAt: durable ? finished.t : finishedAt,
      ...(failedStep !== undefined && { failedStep }),
      ...(this.fatal && { error: this.fatal.error }),
    }
    this.finalResult = result
    this.state = 'finished'
    const listeners = [...this.listeners]
    this.listeners.clear()
    for (const l of listeners) call(() => l.finished?.(result))
    this.resolveDone(result)
  }

  /** Once an engine or storage error is recorded, the run is `failed`. */
  private settle(
    status: RunStatus,
    failedStep: string | undefined,
  ): { status: RunStatus; failedStep: string | undefined } {
    if (!this.fatal) return { status, failedStep }
    return { status: 'failed', failedStep: this.fatal.step ?? failedStep }
  }

  /**
   * A finish write. Returns whether it succeeded. A failure is the run's
   * first storage error only if none came before.
   */
  private async attempt(fn: () => Promise<void>): Promise<boolean> {
    try {
      await fn()
      return true
    } catch (err) {
      this.fatal ??= { error: { code: 'STORAGE', message: describe(err), hint: STORAGE_HINT } }
      return false
    }
  }
}

/** Step ids and labels never contain a NUL, so the pair maps to one key. */
function transcriptKey(step: string, label: string): string {
  return `${step}\u0000${label}`
}

/** A listener's error never reaches the runner. */
function call(fn: () => void): void {
  try {
    fn()
  } catch (err) {
    diag(SCOPE, `run listener threw: ${describe(err)}`)
  }
}

async function readText(file: string, what: string): Promise<string> {
  try {
    return await readFile(file, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? describe(err)
    throw new RensaError('TEMPLATE', `cannot read ${what} ${file}: ${code}`, file)
  }
}

/** The shell convention for a death by signal: 128 + its number (SIGTERM → 143). */
function signalExitCode(signal: NodeJS.Signals | null): number {
  const number = signal === null ? undefined : constants.signals[signal]
  return number === undefined ? 1 : 128 + number
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
