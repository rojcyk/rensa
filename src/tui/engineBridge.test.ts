import { chmodSync } from 'node:fs'
import { chmod } from 'node:fs/promises'
import path from 'node:path'
import {
  afterAll,
  afterEach,
  assert,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import {
  applyResult,
  RingBuffer,
  type RunEvent,
  type RunHandle,
  type RunListeners,
  type RunResult,
  reduceRun,
  reduceSteps,
  type TranscriptRecord,
} from '../engine/index.js'
import { type EngineRepo, engineRepo, finished } from '../testing/engine.js'
import { type ScriptEvent, scriptedRun } from '../testing/scriptedRun.js'
import { type ChainStepRef, type RunState, RunView } from './engineBridge.js'
import { FRAME_MS } from './frameRate.js'

const THREE_STEP: ChainStepRef[] = [
  { id: 'baseline', kind: 'shell' },
  { id: 'review', kind: 'agent' },
  { id: 'wrap-up', kind: 'shell' },
]
const READ_ONLY: ChainStepRef[] = [{ id: 'review', kind: 'agent' }]
const AGENT_WRITE: ChainStepRef[] = [{ id: 'implement', kind: 'agent' }]

/** Waits until the batcher has delivered what the handle reported. */
async function settledTo(view: RunView, expected: (s: RunState) => void): Promise<void> {
  await vi.waitFor(() => expected(view.store.getState()), { timeout: 2_000, interval: FRAME_MS })
}

describe('a RunView on a live engine handle', () => {
  let env: EngineRepo | undefined
  const views: RunView[] = []
  let restore: Array<{ file: string; mode: number }> = []

  afterEach(async () => {
    for (const view of views.splice(0)) view.dispose()
    for (const { file, mode } of restore) await chmod(file, mode).catch(() => {})
    restore = []
    await env?.cleanup()
    env = undefined
  })

  function view(handle: RunHandle, steps: ReadonlyArray<ChainStepRef>): RunView {
    const v = new RunView(handle, steps)
    views.push(v)
    return v
  }

  it('renders the final status, every step final and versions of buffer length + 1 on the first getState when the run already finished', async () => {
    env = await engineRepo(['three-step'])
    const engine = await env.open()
    const handle = await env.start(engine, 'three-step')
    const { result, events } = await finished(handle)

    const state = view(handle, THREE_STEP).store.getState()

    expect(state.progress).toEqual(applyResult(reduceRun(events), result))
    expect(state.progress.status).toBe('complete')
    expect(state.steps).toEqual(reduceSteps(events, THREE_STEP))
    expect([...state.steps.values()].map((s) => [s.id, s.status])).toEqual([
      ['baseline', 'ok'],
      ['review', 'ok'],
      ['wrap-up', 'ok'],
    ])
    expect(state.transcriptVersions).toEqual(
      new Map([
        ['baseline/shell', 1 + handle.transcript('baseline', 'shell').length],
        ['review/fake', 1 + handle.transcript('review', 'fake').length],
        ['wrap-up/shell', 1 + handle.transcript('wrap-up', 'shell').length],
      ]),
    )
    expect(handle.transcript('review', 'fake').length).toBe(3)
  })

  it("shows run.started's timestamp on the first getState and later events through the batcher when built right after start", async () => {
    env = await engineRepo(['three-step'])
    const engine = await env.open()
    const handle = await env.start(engine, 'three-step')

    const v = view(handle, THREE_STEP)
    const first = v.store.getState()
    const started = handle.events().find((e) => e.type === 'run.started')
    assert(started, 'run.started is in the history when start resolves')
    expect(first.progress.startedAt).toBe(started.t)
    expect(first.progress.status).toBe('running')

    const { events } = await finished(handle)
    await settledTo(v, (s) => expect(s.progress.status).toBe('complete'))
    expect(v.store.getState().steps).toEqual(reduceSteps(events, THREE_STEP))
    expect(v.events).toEqual(events)
  })

  it('keeps each view to its own events when two runs go at once', async () => {
    env = await engineRepo(['read-only'])
    const engine = await env.open()
    const first = await env.start(engine, 'read-only')
    const firstView = view(first, READ_ONLY)
    const second = await env.start(engine, 'read-only')
    const secondView = view(second, READ_ONLY)

    await Promise.all([finished(first), finished(second)])

    expect(firstView.events).toEqual(first.events())
    expect(secondView.events).toEqual(second.events())
  })

  it('yields the same state as a view that stayed attached when one is disposed midway and another is built on the same handle', async () => {
    env = await engineRepo(['three-step'])
    const engine = await env.open()
    const handle = await env.start(engine, 'three-step')
    const stayed = view(handle, THREE_STEP)
    const left = new RunView(handle, THREE_STEP)
    let disposedMidway = false
    handle.attach({
      event(e) {
        if (e.type === 'agent.spawned' && !disposedMidway) {
          disposedMidway = true
          left.dispose()
        }
      },
    })

    await finished(handle)
    const reentered = view(handle, THREE_STEP)
    // Versions are per-view change counters (bumped once per batch, seeded
    // at buffer length + 1), so two views agree on which transcripts
    // exist, not on the counts.
    const shape = (s: RunState) => ({
      progress: s.progress,
      steps: s.steps,
      transcripts: [...s.transcriptVersions.keys()].sort(),
    })
    await settledTo(stayed, (s) => expect(shape(s)).toEqual(shape(reentered.store.getState())))

    expect(disposedMidway).toBe(true)
    expect(reentered.events).toEqual(stayed.events)
  })

  function failOnSpawn(handle: RunHandle): void {
    const eventsFile = path.join(handle.dir, 'events.jsonl')
    handle.attach({
      event(e) {
        if (e.type === 'agent.spawned') {
          restore.push({ file: eventsFile, mode: 0o644 })
          chmodSync(eventsFile, 0o444)
        }
      },
    })
  }

  it('shows failed with the STORAGE error although no run.finished exists when the view was attached before a storage failure', async () => {
    env = await engineRepo(['agent-write'])
    const engine = await env.open()
    vi.stubEnv('RENSA_FAKE_DELAY_MS', '100')
    const handle = await env.start(engine, 'agent-write')
    const v = view(handle, AGENT_WRITE)
    failOnSpawn(handle)

    const { events } = await finished(handle)

    expect(events.filter((e) => e.type === 'run.finished')).toEqual([])
    await settledTo(v, (s) =>
      expect(s.progress).toMatchObject({ status: 'failed', error: { code: 'STORAGE' } }),
    )
  })

  it('shows failed with the STORAGE error on the first getState when the view is built after a storage failure', async () => {
    env = await engineRepo(['agent-write'])
    const engine = await env.open()
    vi.stubEnv('RENSA_FAKE_DELAY_MS', '100')
    const handle = await env.start(engine, 'agent-write')
    failOnSpawn(handle)
    const { events } = await finished(handle)

    const state = view(handle, AGENT_WRITE).store.getState()

    expect(events.filter((e) => e.type === 'run.finished')).toEqual([])
    expect(state.progress).toMatchObject({ status: 'failed', error: { code: 'STORAGE' } })
  })
})

/**
 * A handle that replays what a test feeds it: `emit` delivers to the
 * listeners attached, after appending an event to the history or a
 * record to the buffer, as the runner does.
 */
function stubHandle(history: ReadonlyArray<RunEvent> = []) {
  const events = [...history]
  const listeners = new Set<RunListeners>()
  const buffers = new Map<string, RingBuffer<TranscriptRecord>>()
  const buffer = (step: string, label: string) => {
    const key = `${step}\u0000${label}`
    let b = buffers.get(key)
    if (!b) {
      b = new RingBuffer<TranscriptRecord>(5000)
      buffers.set(key, b)
    }
    return b
  }
  const handle: RunHandle = {
    id: '20261106-163000-quote-limits',
    dir: '/tmp/rensa-stub-run',
    pause() {},
    resume() {},
    kill() {},
    abort() {},
    note() {},
    done: new Promise<RunResult>(() => {}),
    result: () => undefined,
    transcript: buffer,
    partial: () => undefined,
    events: () => events.slice(),
    attach(l) {
      listeners.add(l)
      return { events: events.slice(), detach: () => listeners.delete(l) }
    },
  }
  return {
    handle,
    event(e: RunEvent) {
      events.push(e)
      for (const l of listeners) l.event?.(e)
    },
    transcript(step: string, label: string, record: TranscriptRecord) {
      buffer(step, label).push(record)
      for (const l of listeners) l.transcript?.({ step, label, record })
    },
  }
}

describe('folding a batch of engine events into the store', () => {
  let recorded: ReadonlyArray<RunEvent> = []
  let env: EngineRepo | undefined

  beforeAll(async () => {
    env = await engineRepo(['three-step'])
    const engine = await env.open()
    const handle = await env.start(engine, 'three-step')
    recorded = (await finished(handle)).events
  })

  afterAll(async () => {
    await env?.cleanup()
  })

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('yields steps equal to reduceSteps and progress equal to reduceRun when a recorded fake-provider sequence is fed and flushed', async () => {
    const stub = stubHandle()
    const v = new RunView(stub.handle, THREE_STEP)

    for (const e of recorded) stub.event(e)
    await vi.advanceTimersByTimeAsync(FRAME_MS)

    const state = v.store.getState()
    expect(state.steps).toEqual(reduceSteps(recorded, THREE_STEP))
    expect(state.progress).toEqual(reduceRun(recorded))
    v.dispose()
  })

  it('keeps the same state reference and notifies nobody when a batch holds only user.note and unknown events', async () => {
    const midRun = recorded.slice(0, 5)
    const stub = stubHandle(midRun)
    const v = new RunView(stub.handle, THREE_STEP)
    const before = v.store.getState()
    const listener = vi.fn()
    v.store.subscribe(listener)
    const seq = midRun.length

    stub.event({
      seq: seq + 1,
      t: '2026-11-06T16:30:01.000Z',
      type: 'user.note',
      data: { text: 'keep the public API unchanged', applies_from: 'review' },
    })
    stub.event({ seq: seq + 2, t: '2026-11-06T16:30:01.100Z', type: 'review.requested' })
    stub.event({
      seq: seq + 3,
      t: '2026-11-06T16:30:01.200Z',
      type: 'user.note',
      data: { text: 'also check the README', applies_from: 'review' },
    })
    await vi.advanceTimersByTimeAsync(FRAME_MS * 2)

    expect(listener).not.toHaveBeenCalled()
    expect(v.store.getState()).toBe(before)
    v.dispose()
  })

  it('bumps only that key and keeps the steps reference when a transcript record arrives for a/tester', async () => {
    const t = '2026-11-06T16:30:00.000Z'
    const history: RunEvent[] = [
      {
        seq: 1,
        t,
        type: 'run.started',
        data: {
          chain: 'pair-review',
          input_kind: 'none',
          base: 'main',
          base_sha: '3f9c2a1b7e4d5c6a8b9f0e1d2c3b4a5968778695',
          rensa_version: 'dev',
        },
      },
      { seq: 2, t, type: 'step.started', step: 'a', data: { kind: 'agent' } },
      {
        seq: 3,
        t,
        type: 'agent.spawned',
        step: 'a',
        agent: 'tester',
        data: { provider: 'fake', tools: 'read', session_id: 'b4d7e9a1-0c2f', resumed: false },
      },
      { seq: 4, t, type: 'step.started', step: 'b', data: { kind: 'agent' } },
      {
        seq: 5,
        t,
        type: 'agent.spawned',
        step: 'b',
        agent: 'reviewer',
        data: { provider: 'fake', tools: 'read', session_id: 'c7a3b2d4-9e1f', resumed: false },
      },
    ]
    const stub = stubHandle(history)
    const v = new RunView(stub.handle, [
      { id: 'a', kind: 'agent' },
      { id: 'b', kind: 'agent' },
    ])
    const before = v.store.getState()

    stub.transcript('a', 'tester', { t, kind: 'text', text: 'Running the test suite.' })
    await vi.advanceTimersByTimeAsync(FRAME_MS)

    const after = v.store.getState()
    expect(before.transcriptVersions).toEqual(
      new Map([
        ['a/tester', 1],
        ['b/reviewer', 1],
      ]),
    )
    expect(after.transcriptVersions).toEqual(
      new Map([
        ['a/tester', 2],
        ['b/reviewer', 1],
      ]),
    )
    expect(after.steps).toBe(before.steps)
    v.dispose()
  })

  it('bumps a/tester on an agent.finished batch with no record or delta, and bumps no key on a batch of step-only events', async () => {
    const t = '2026-11-06T16:30:00.000Z'
    const history: RunEvent[] = [
      {
        seq: 1,
        t,
        type: 'run.started',
        data: {
          chain: 'pair-review',
          input_kind: 'none',
          base: 'main',
          base_sha: '3f9c2a1b7e4d5c6a8b9f0e1d2c3b4a5968778695',
          rensa_version: 'dev',
        },
      },
      { seq: 2, t, type: 'step.started', step: 'a', data: { kind: 'agent' } },
      {
        seq: 3,
        t,
        type: 'agent.spawned',
        step: 'a',
        agent: 'tester',
        data: { provider: 'fake', tools: 'read', session_id: 'b4d7e9a1-0c2f', resumed: false },
      },
    ]
    const stub = stubHandle(history)
    const v = new RunView(stub.handle, [
      { id: 'a', kind: 'agent' },
      { id: 'b', kind: 'agent' },
    ])
    const before = v.store.getState()

    // The runner drops a/tester's partial and emits agent.finished; no
    // record or delta for a/tester follows in this batch.
    stub.event({
      seq: 4,
      t: '2026-11-06T16:30:05.000Z',
      type: 'agent.finished',
      step: 'a',
      agent: 'tester',
      data: { status: 'ok', exit_code: 0 },
    })
    await vi.advanceTimersByTimeAsync(FRAME_MS)
    const afterAgent = v.store.getState()

    stub.event({
      seq: 5,
      t: '2026-11-06T16:30:05.100Z',
      type: 'step.finished',
      step: 'a',
      data: { status: 'ok' },
    })
    stub.event({
      seq: 6,
      t: '2026-11-06T16:30:05.200Z',
      type: 'step.started',
      step: 'b',
      data: { kind: 'agent' },
    })
    await vi.advanceTimersByTimeAsync(FRAME_MS)
    const afterSteps = v.store.getState()

    expect(before.transcriptVersions).toEqual(new Map([['a/tester', 1]]))
    expect(afterAgent.transcriptVersions).toEqual(new Map([['a/tester', 2]]))
    expect(afterSteps.steps.get('b')?.startedAt).toBe('2026-11-06T16:30:05.200Z')
    expect(afterSteps.transcriptVersions).toBe(afterAgent.transcriptVersions)
    v.dispose()
  })
})

describe('the progress reference when a pending pause does not change', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const t = '2026-11-06T16:30:00.000Z'
  const PAUSING: ScriptEvent[] = [
    {
      t,
      type: 'run.started',
      data: {
        chain: 'pair-review',
        input_kind: 'none',
        base: 'main',
        base_sha: '3f9c2a1b7e4d5c6a8b9f0e1d2c3b4a5968778695',
        rensa_version: 'dev',
      },
    },
    { t, type: 'step.started', step: 'review', data: { kind: 'agent' } },
    { t, type: 'user.action', data: { action: 'pause', step: 'review' } },
  ]

  it.each<[string, ScriptEvent]>([
    [
      'a repeated pause action',
      { t, type: 'user.action', data: { action: 'pause', step: 'review' } },
    ],
    [
      'a user.note',
      { t, type: 'user.note', data: { text: 'also check the README', applies_from: 'wrap-up' } },
    ],
    ['a kill action', { t, type: 'user.action', data: { action: 'kill', step: 'review' } }],
  ])('keeps the same progress reference with pausing set when %s arrives', async (_, extra) => {
    const run = scriptedRun({
      id: '20261106-163000-pair-review',
      dir: '/tmp/rensa-stub-run',
      history: PAUSING,
    })
    const v = new RunView(run.handle, THREE_STEP)
    const before = v.store.getState().progress

    run.event(extra)
    await vi.advanceTimersByTimeAsync(FRAME_MS * 2)

    expect(before.pausing).toBe('review')
    expect(v.store.getState().progress).toBe(before)
    v.dispose()
  })
})
