import { afterAll, assert, beforeAll, describe, expect, it } from 'vitest'
import { type EngineRepo, engineRepo, finished } from '../../testing/engine.js'
import type { RunHandle } from './runner.js'
import type { NewRunEvent, RunEvent } from './types.js'
import {
  applyEvent,
  applyResult,
  initialSteps,
  type RunProgress,
  type RunResult,
  reduceRun,
  reduceSteps,
  type StepView,
} from './view.js'

const T0 = Date.parse('2026-11-02T14:30:00.000Z')

/** A stamped event as the log would return it; `t` is one second per `seq`. */
function stamped(seq: number, e: NewRunEvent): RunEvent {
  return { seq, t: new Date(T0 + seq * 1000).toISOString(), ...e }
}

function onlyStep(steps: Map<string, StepView>, id: string): StepView {
  const view = steps.get(id)
  assert(view, `no view for step ${id}`)
  return view
}

/** `t` of the first event matching `type` and `step`. */
function timeOf(events: ReadonlyArray<RunEvent>, type: string, step?: string): string {
  const event = events.find((e) => e.type === type && (step === undefined || e.step === step))
  assert(event, `no ${type} for ${step ?? 'the run'}`)
  return event.t
}

/** Events up to and including the first one `match` accepts. */
function prefixThrough(
  events: ReadonlyArray<RunEvent>,
  match: (e: RunEvent) => boolean,
): RunEvent[] {
  const end = events.findIndex(match)
  assert(end !== -1, 'no event ends the prefix')
  return events.slice(0, end + 1)
}

describe('reducing recorded runs', () => {
  let env: EngineRepo
  const recorded: Record<
    'complete' | 'stopped' | 'paused' | 'aborted',
    { events: ReadonlyArray<RunEvent>; steps: Array<{ id: string; kind: 'agent' | 'shell' }> }
  > = {
    complete: { events: [], steps: [] },
    stopped: { events: [], steps: [] },
    paused: { events: [], steps: [] },
    aborted: { events: [], steps: [] },
  }

  // The event sequences come from real runs on the fake provider, so the
  // reducers are checked against what the engine writes, not a guess.
  beforeAll(async () => {
    env = await engineRepo(['three-step', 'shell-stop', 'pause-before'])
    const engine = await env.open()
    const stepsOf = (chain: string) =>
      engine.chain(chain).steps.map(({ id, kind }) => ({ id, kind }))
    const record = async (
      key: keyof typeof recorded,
      chain: string,
      drive: (h: RunHandle) => void = () => {},
    ) => {
      const handle = await env.start(engine, chain)
      drive(handle)
      const { events } = await finished(handle)
      recorded[key] = { events, steps: stepsOf(chain) }
    }
    await record('complete', 'three-step')
    await record('stopped', 'shell-stop')
    await record('paused', 'pause-before', (h) =>
      h.attach({
        event: (e) => {
          if (e.type === 'run.paused') h.resume()
        },
      }),
    )
    await record('aborted', 'three-step', (h) => {
      let fired = false
      h.attach({
        delta: () => {
          if (fired) return
          fired = true
          h.abort()
        },
      })
    })
  })

  afterAll(async () => {
    await env.cleanup()
  })

  it('reports every step ok with the event timestamps when the three-step run completed', () => {
    const { events } = recorded.complete

    const steps = reduceSteps([...events])

    expect([...steps.values()]).toEqual(
      ['baseline', 'review', 'wrap-up'].map((id) => ({
        id,
        kind: id === 'review' ? 'agent' : 'shell',
        status: 'ok',
        startedAt: timeOf(events, 'step.started', id),
        finishedAt: timeOf(events, 'step.finished', id),
        exitCode: 0,
        ...(id === 'review' && {
          agent: {
            label: 'fake',
            provider: 'fake',
            status: 'ok',
            startedAt: timeOf(events, 'agent.spawned', id),
            finishedAt: timeOf(events, 'agent.finished', id),
            usage: { input: 240, output: 42, cache_read: 100 },
          },
        }),
      })),
    )
  })

  it('reports the run complete with its start and finish times when the three-step run completed', () => {
    const { events } = recorded.complete

    expect(reduceRun([...events])).toEqual({
      status: 'complete',
      currentStep: 'wrap-up',
      startedAt: timeOf(events, 'run.started'),
      finishedAt: timeOf(events, 'run.finished'),
    })
  })

  it('leaves a step that never started pending when the chain steps are passed in', () => {
    const { events, steps: chainSteps } = recorded.stopped

    const steps = reduceSteps([...events], chainSteps)

    expect([...steps.keys()]).toEqual(['check', 'report'])
    expect([onlyStep(steps, 'check').status, onlyStep(steps, 'report').status]).toEqual([
      'failed',
      'pending',
    ])
  })

  it('reports the run failed at the failed step when an on_fail stop step failed', () => {
    expect(reduceRun([...recorded.stopped.events])).toMatchObject({
      status: 'failed',
      failedStep: 'check',
    })
  })

  it('marks the step paused at run.paused before it and running again at its step.started', () => {
    const { events, steps: chainSteps } = recorded.paused

    const atPause = reduceSteps(
      prefixThrough(events, (e) => e.type === 'run.paused'),
      chainSteps,
    )
    const atStart = reduceSteps(
      prefixThrough(events, (e) => e.type === 'step.started' && e.step === 'two'),
      chainSteps,
    )

    expect([onlyStep(atPause, 'one').status, onlyStep(atPause, 'two').status]).toEqual([
      'ok',
      'paused',
    ])
    expect(onlyStep(atStart, 'two').status).toBe('running')
    expect(reduceRun(prefixThrough(events, (e) => e.type === 'run.paused'))).toMatchObject({
      status: 'paused',
      currentStep: 'two',
      pausedAt: { before: 'two' },
    })
  })

  it('reports aborted for the whole aborted run and aborting for its prefix ending at the abort action', () => {
    const { events } = recorded.aborted

    const prefix = prefixThrough(events, (e) => e.type === 'user.action')

    expect(reduceRun([...events]).status).toBe('aborted')
    expect(reduceRun(prefix)).toMatchObject({ status: 'aborting', currentStep: 'review' })
  })
})

describe('applying one event to the step map', () => {
  const chainSteps = [
    { id: 'baseline', kind: 'shell' },
    { id: 'review', kind: 'agent' },
  ] as const

  it('returns the same map when the event is a user.note', () => {
    const steps = initialSteps(chainSteps)

    const next = applyEvent(
      steps,
      stamped(2, { type: 'user.note', data: { text: 'Skip the docs.', applies_from: 'review' } }),
    )

    expect(next).toBe(steps)
  })

  it('returns the same map when the event is a user.action', () => {
    const steps = initialSteps(chainSteps)

    const next = applyEvent(steps, stamped(2, { type: 'user.action', data: { action: 'pause' } }))

    expect(next).toBe(steps)
  })

  it('returns the same map when the event type is unknown to this version', () => {
    const steps = initialSteps(chainSteps)
    const fromNewerVersion: RunEvent = {
      seq: 2,
      t: '2026-11-02T14:30:02.000Z',
      type: 'step.retried',
      step: 'baseline',
      data: { attempt: 2 },
    }

    expect(applyEvent(steps, fromNewerVersion)).toBe(steps)
  })

  it('returns a new map with the step running when the event is step.started', () => {
    const steps = initialSteps(chainSteps)
    const started = stamped(2, { type: 'step.started', step: 'baseline', data: { kind: 'shell' } })

    const next = applyEvent(steps, started)

    expect(next).not.toBe(steps)
    expect(onlyStep(next, 'baseline')).toEqual({
      id: 'baseline',
      kind: 'shell',
      status: 'running',
      startedAt: started.t,
    })
    expect(onlyStep(steps, 'baseline').status).toBe('pending')
  })

  it('returns the same map when step.finished names a step the map does not hold', () => {
    const steps = initialSteps(chainSteps)

    const next = applyEvent(
      steps,
      stamped(3, { type: 'step.finished', step: 'deploy', data: { status: 'ok' } }),
    )

    expect(next).toBe(steps)
  })

  it('leaves the finished step and the next step untouched when the run pauses after a step', () => {
    const steps = reduceSteps(
      [
        stamped(2, { type: 'step.started', step: 'baseline', data: { kind: 'shell' } }),
        stamped(3, {
          type: 'step.finished',
          step: 'baseline',
          data: { status: 'ok', exit_code: 0 },
        }),
      ],
      chainSteps,
    )

    const next = applyEvent(
      steps,
      stamped(4, { type: 'run.paused', data: { after: 'baseline', reason: 'declared' } }),
    )

    expect(next).toBe(steps)
  })
})

describe('merging the run result over the event progress', () => {
  const completeProgress: RunProgress = {
    status: 'complete',
    currentStep: 'wrap-up',
    startedAt: '2026-11-02T14:30:01.000Z',
    finishedAt: '2026-11-02T14:30:09.000Z',
  }
  const failedResult: RunResult = {
    status: 'failed',
    failedStep: 'wrap-up',
    finishedAt: '2026-11-02T14:30:10.000Z',
    error: {
      code: 'STORAGE',
      message: "EACCES: permission denied, open '/repo/.rensa/runs/r1/run.json'",
      hint: 'check free space and permissions under .rensa/runs',
    },
  }

  it('replaces an earlier complete with the failed result, its error, failed step and finish time', () => {
    const next = applyResult(completeProgress, failedResult)

    expect(next).toEqual({
      status: 'failed',
      currentStep: 'wrap-up',
      startedAt: '2026-11-02T14:30:01.000Z',
      finishedAt: '2026-11-02T14:30:10.000Z',
      failedStep: 'wrap-up',
      error: failedResult.error,
    })
  })

  it('returns the same reference when the same result is applied to its own output', () => {
    const once = applyResult(completeProgress, failedResult)

    expect(applyResult(once, failedResult)).toBe(once)
  })

  it('returns the same reference when the result matches the progress', () => {
    const result: RunResult = { status: 'complete', finishedAt: '2026-11-02T14:30:09.000Z' }

    expect(applyResult(completeProgress, result)).toBe(completeProgress)
  })

  it('returns a new progress when only the error hint differs', () => {
    const once = applyResult(completeProgress, failedResult)
    const otherHint: RunResult = {
      ...failedResult,
      error: {
        code: 'STORAGE',
        message: failedResult.error?.message ?? '',
        hint: 'free some space',
      },
    }

    expect(applyResult(once, otherHint).error?.hint).toBe('free some space')
  })
})
