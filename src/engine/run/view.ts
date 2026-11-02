import type { AgentError, RunEvent, RunStatus, StepStatus, Usage } from './types.js'

// Interpreting the event log is engine logic. Every consumer that needs
// "what state is step X in" derives it here, never by switching on event
// types itself.

export interface AgentView {
  label: string
  provider: string
  model?: string
  effort?: string
  status: 'pending' | 'running' | StepStatus
  startedAt?: string
  finishedAt?: string
  usage?: Usage
  error?: AgentError
}

export interface StepView {
  id: string
  kind: 'agent' | 'shell'
  status: 'pending' | 'running' | 'paused' | StepStatus
  startedAt?: string
  finishedAt?: string
  exitCode?: number
  agent?: AgentView
}

export interface RunError {
  code: string
  message: string
  hint?: string
}

export interface RunProgress {
  status: 'running' | 'paused' | 'aborting' | RunStatus
  /** The running or paused step. */
  currentStep?: string
  pausedAt?: { before?: string; after?: string }
  failedStep?: string
  startedAt?: string
  finishedAt?: string
  /** From the `RunResult`, never from an event. */
  error?: RunError
}

/** A run's in-memory terminal state, held by its handle whatever reached disk. */
export interface RunResult {
  status: RunStatus
  failedStep?: string
  finishedAt: string
  /** Set when the run ended on an engine or storage error. */
  error?: RunError
}

type StepRef = { id: string; kind: 'agent' | 'shell' }

/** Every step `pending`, in chain order. */
export function initialSteps(steps: ReadonlyArray<StepRef>): Map<string, StepView> {
  return new Map(steps.map(({ id, kind }) => [id, { id, kind, status: 'pending' }]))
}

/**
 * Applies one event. Returns the same map when the event changes
 * nothing, and a new map otherwise, so a store can skip a render.
 */
export function applyEvent(steps: Map<string, StepView>, event: RunEvent): Map<string, StepView> {
  switch (event.type) {
    case 'step.started': {
      if (event.step === undefined) return steps
      const data = event.data as { kind?: unknown } | undefined
      const current = steps.get(event.step)
      const kind = current?.kind ?? (data?.kind === 'shell' ? 'shell' : 'agent')
      return replace(steps, { id: event.step, kind, status: 'running', startedAt: event.t })
    }
    case 'step.finished': {
      const current = event.step === undefined ? undefined : steps.get(event.step)
      if (!current) return steps
      const data = event.data as { status: StepStatus; exit_code?: number }
      const next: StepView = { ...current, status: data.status, finishedAt: event.t }
      if (data.exit_code !== undefined) next.exitCode = data.exit_code
      return replace(steps, next)
    }
    case 'agent.spawned': {
      const current = event.step === undefined ? undefined : steps.get(event.step)
      if (!current || event.agent === undefined) return steps
      const data = event.data as { provider: string; model?: string; effort?: string }
      const agent: AgentView = {
        label: event.agent,
        provider: data.provider,
        status: 'running',
        startedAt: event.t,
      }
      if (data.model !== undefined) agent.model = data.model
      if (data.effort !== undefined) agent.effort = data.effort
      return replace(steps, { ...current, agent })
    }
    case 'agent.finished': {
      const current = event.step === undefined ? undefined : steps.get(event.step)
      if (!current?.agent || current.agent.label !== event.agent) return steps
      const data = event.data as { status: StepStatus; usage?: Usage; error?: AgentError }
      const agent: AgentView = { ...current.agent, status: data.status, finishedAt: event.t }
      if (data.usage !== undefined) agent.usage = data.usage
      if (data.error !== undefined) agent.error = data.error
      return replace(steps, { ...current, agent })
    }
    case 'run.paused': {
      const data = event.data as { before?: string }
      const current = data.before === undefined ? undefined : steps.get(data.before)
      if (!current || current.status === 'paused') return steps
      return replace(steps, { ...current, status: 'paused' })
    }
    default:
      return steps
  }
}

export function reduceSteps(
  events: ReadonlyArray<RunEvent>,
  steps?: ReadonlyArray<StepRef>,
): Map<string, StepView> {
  return events.reduce(applyEvent, initialSteps(steps ?? []))
}

/** Folds the run-level events into a `RunProgress`. */
export function reduceRun(events: ReadonlyArray<RunEvent>): RunProgress {
  let progress: RunProgress = { status: 'running' }
  for (const event of events) {
    switch (event.type) {
      case 'run.started':
        progress = { ...progress, startedAt: event.t }
        break
      case 'run.paused': {
        if (isTerminal(progress.status) || progress.status === 'aborting') break
        const data = event.data as { before?: string; after?: string }
        const pausedAt: RunProgress['pausedAt'] = {}
        if (data.before !== undefined) pausedAt.before = data.before
        if (data.after !== undefined) pausedAt.after = data.after
        progress = { ...progress, status: 'paused', pausedAt }
        const step = data.before ?? data.after
        if (step !== undefined) progress.currentStep = step
        break
      }
      case 'step.started': {
        if (event.step === undefined || isTerminal(progress.status)) break
        const { pausedAt: _, ...rest } = progress
        progress = {
          ...rest,
          status: progress.status === 'aborting' ? 'aborting' : 'running',
          currentStep: event.step,
        }
        break
      }
      case 'user.action': {
        const data = event.data as { action?: string }
        if (data.action !== 'abort' || isTerminal(progress.status)) break
        progress = { ...progress, status: 'aborting' }
        break
      }
      case 'run.finished': {
        const data = event.data as { status: RunStatus; failed_step?: string }
        const { pausedAt: _, ...rest } = progress
        progress = { ...rest, status: data.status, finishedAt: event.t }
        if (data.failed_step !== undefined) progress.failedStep = data.failed_step
        break
      }
      default:
        break
    }
  }
  return progress
}

/**
 * Merges the in-memory terminal state over what the events gave. The
 * result is authoritative: it replaces the status, failed step, finish
 * time and error the events implied whenever they differ, including an
 * earlier terminal status (a `run.finished` the engine announced before
 * a later write failed). Returns the same reference when the progress
 * already agrees with the result, so a store can skip a render.
 */
export function applyResult(progress: RunProgress, result: RunResult): RunProgress {
  if (
    progress.status === result.status &&
    progress.failedStep === result.failedStep &&
    sameError(progress.error, result.error)
  ) {
    return progress
  }
  const { pausedAt: _, failedStep: __, error: ___, ...rest } = progress
  const next: RunProgress = { ...rest, status: result.status, finishedAt: result.finishedAt }
  if (result.failedStep !== undefined) next.failedStep = result.failedStep
  if (result.error !== undefined) next.error = result.error
  return next
}

function sameError(a: RunError | undefined, b: RunError | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.code === b.code && a.message === b.message && a.hint === b.hint
}

function isTerminal(status: RunProgress['status']): status is RunStatus {
  return status === 'complete' || status === 'failed' || status === 'aborted'
}

/** A copy of `steps` with `view` in place, unless it equals the current entry. */
function replace(steps: Map<string, StepView>, view: StepView): Map<string, StepView> {
  const current = steps.get(view.id)
  if (current && sameStep(current, view)) return steps
  const next = new Map(steps)
  next.set(view.id, view)
  return next
}

function sameStep(a: StepView, b: StepView): boolean {
  return (
    a.kind === b.kind &&
    a.status === b.status &&
    a.startedAt === b.startedAt &&
    a.finishedAt === b.finishedAt &&
    a.exitCode === b.exitCode &&
    a.agent === b.agent
  )
}
