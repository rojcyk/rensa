import type { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dataOf, type EngineRepo, engineRepo, finished, ofType, within } from '../testing/engine.js'
import { killProcessesWithArgs, processesWithArgs } from '../testing/processes.js'
import { git } from '../testing/tmpRepo.js'
import type { SpawnRequest } from './adapters/types.js'
import {
  type RunEvent,
  type RunHandle,
  readEvents,
  readRunJson,
  type TranscriptRecord,
} from './index.js'

let env: EngineRepo | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  await env?.cleanup()
  env = undefined
})

async function setup(chains: string[]): Promise<EngineRepo> {
  env = await engineRepo(chains)
  return env
}

/** What the fake adapter recorded for one agent spawn. */
async function requestOf(
  handle: RunHandle,
  step: string,
  label: string,
): Promise<Omit<SpawnRequest, 'env'>> {
  const file = path.join(handle.dir, 'agents', step, label, 'request.json')
  return JSON.parse(await readFile(file, 'utf8')) as Omit<SpawnRequest, 'env'>
}

function promptOf(handle: RunHandle, step: string, label: string): Promise<string> {
  return readFile(path.join(handle.dir, 'agents', step, label, 'prompt.md'), 'utf8')
}

describe('running a chain to completion', () => {
  it('writes the expected event sequence and run.json when a shell, agent, shell chain completes', async () => {
    const { open, start } = await setup(['three-step'])
    const engine = await open()

    const handle = await start(engine, 'three-step')
    const { result } = await finished(handle)

    expect(result).toEqual({ status: 'complete', finishedAt: expect.any(String) })
    const { events, warnings } = await readEvents(path.join(handle.dir, 'events.jsonl'))
    expect(warnings).toEqual([])
    expect(events.map((e) => [e.type, e.step])).toEqual([
      ['run.started', undefined],
      ['step.started', 'baseline'],
      ['step.finished', 'baseline'],
      ['step.started', 'review'],
      ['agent.spawned', 'review'],
      ['agent.finished', 'review'],
      ['step.finished', 'review'],
      ['step.started', 'wrap-up'],
      ['step.finished', 'wrap-up'],
      ['run.finished', undefined],
    ])
    expect(dataOf(events.at(-1))).toEqual({ status: 'complete' })
    const runJson = await readRunJson(path.join(handle.dir, 'run.json'))
    expect({ status: runJson.status, steps: runJson.steps }).toEqual({
      status: 'complete',
      steps: {
        baseline: { status: 'ok', agents: {} },
        review: { status: 'ok', agents: { fake: 'ok' } },
        'wrap-up': { status: 'ok', agents: {} },
      },
    })
  })

  it('records run.started with the chain, base, base sha and the dev version when run under vitest', async () => {
    const { open, start, repo } = await setup(['three-step'])
    const engine = await open()
    const sha = (await git(repo.dir, ['rev-parse', 'HEAD'])).trim()

    const handle = await start(engine, 'three-step')
    await finished(handle)

    expect(handle.events()[0]).toMatchObject({
      seq: 1,
      type: 'run.started',
      data: {
        chain: 'three-step',
        input_kind: 'none',
        base: 'main',
        base_sha: sha,
        rensa_version: 'dev',
      },
    })
  })

  it('delivers each shell output line as one text record under the shell label when a shell step prints', async () => {
    const { open, start } = await setup(['three-step'])
    const engine = await open()
    const records: Array<{ step: string; label: string; record: TranscriptRecord }> = []

    const handle = await start(engine, 'three-step')
    handle.attach({ transcript: (m) => records.push(m) })
    await finished(handle)

    expect(records.filter((r) => r.label === 'shell')).toEqual([
      {
        step: 'baseline',
        label: 'shell',
        record: { kind: 'text', text: 'baseline-ok', t: expect.any(String) },
      },
      {
        step: 'wrap-up',
        label: 'shell',
        record: { kind: 'text', text: 'wrap-up-ok', t: expect.any(String) },
      },
    ])
  })
})

describe('agent sessions', () => {
  it('resumes the same session without the persona when a named agent runs in a second step', async () => {
    const { open, start } = await setup(['named-resume'])
    const engine = await open()

    const handle = await start(engine, 'named-resume')
    const { result } = await finished(handle)

    expect(result.status).toBe('complete')
    const first = await requestOf(handle, 'draft', 'impl')
    const second = await requestOf(handle, 'refine', 'impl')
    expect({
      first: { session: first.session, persona: first.persona },
      second: { session: second.session, persona: second.persona },
    }).toEqual({
      first: {
        session: { id: expect.stringMatching(/^[0-9a-f]{8}-/), resume: false },
        persona: 'You are a careful implementer who keeps changes small.\n',
      },
      second: { session: { id: first.session.id, resume: true }, persona: undefined },
    })
    const runJson = await readRunJson(path.join(handle.dir, 'run.json'))
    expect(runJson.sessions).toEqual({ impl: first.session.id })
  })

  it('starts a new session with the persona each time when a from: agent runs in two steps', async () => {
    const { open, start } = await setup(['fresh-twice'])
    const engine = await open()

    const handle = await start(engine, 'fresh-twice')
    await finished(handle)

    const first = await requestOf(handle, 'first-pass', 'reviewer')
    const second = await requestOf(handle, 'second-pass', 'reviewer')
    const persona = 'You are a strict reviewer who reports every defect.\n'
    expect([first.session.resume, first.persona, second.session.resume, second.persona]).toEqual([
      false,
      persona,
      false,
      persona,
    ])
    expect(second.session.id).not.toBe(first.session.id)
  })
})

describe('on_fail', () => {
  it('ends the run failed at the step when a stop shell step fails', async () => {
    const { open, start } = await setup(['shell-stop'])
    const engine = await open()

    const handle = await start(engine, 'shell-stop')
    const { result, events } = await finished(handle)

    expect(result).toEqual({
      status: 'failed',
      failedStep: 'check',
      finishedAt: expect.any(String),
    })
    expect(ofType(events, 'step.started').map((e) => e.step)).toEqual(['check'])
    expect(dataOf(ofType(events, 'step.finished')[0])).toEqual({ status: 'failed', exit_code: 2 })
    expect(dataOf(events.at(-1))).toEqual({ status: 'failed', failed_step: 'check' })
  })

  it('renders passed as false in the next prompt when a continue shell step fails', async () => {
    const { open, start } = await setup(['shell-continue'])
    const engine = await open()

    const handle = await start(engine, 'shell-continue')
    const { result } = await finished(handle)

    expect(result.status).toBe('complete')
    expect(await promptOf(handle, 'report', 'fake')).toBe('The check passed: false.\n')
  })
})

describe('shell step timeout', () => {
  it('finishes the step with timeout when a shell step outlives its timeout', async () => {
    const { open, start } = await setup(['shell-timeout'])
    const engine = await open()

    try {
      const handle = await start(engine, 'shell-timeout')
      const { result, events } = await finished(handle)

      expect(dataOf(ofType(events, 'step.finished')[0])).toEqual({
        status: 'timeout',
        exit_code: 143,
      })
      expect(result).toMatchObject({ status: 'failed', failedStep: 'slow' })
      expect(await processesWithArgs('sleep 5.6461')).toEqual([])
    } finally {
      await killProcessesWithArgs('sleep 5.6461')
    }
  })

  it('renders exit code 143 and passed false in the next prompt when a continue shell step times out', async () => {
    const { open, start } = await setup(['timeout-continue'])
    const engine = await open()

    try {
      const handle = await start(engine, 'timeout-continue')
      const { result } = await finished(handle)

      expect(result.status).toBe('complete')
      expect(await promptOf(handle, 'report', 'fake')).toBe(
        'The slow check exited with 143; passed: false.\n',
      )
    } finally {
      await killProcessesWithArgs('sleep 5.6471')
    }
  })
})

describe('notes', () => {
  it('logs applies_from as the empty string when a note is sent after the last step started', async () => {
    const { open, start } = await setup(['read-only'])
    const engine = await open()

    const handle = await start(engine, 'read-only')
    handle.attach({
      event(e) {
        if (e.type === 'step.started') handle.note('Mention the license as well.')
      },
    })
    const { result, events } = await finished(handle)

    expect(result.status).toBe('complete')
    expect(ofType(events, 'user.note').map(dataOf)).toEqual([
      { text: 'Mention the license as well.', applies_from: '' },
    ])
    expect(await promptOf(handle, 'review', 'fake')).toBe(
      'Review the README and report what it contains.\n',
    )
  })
})

describe('attaching to a run', () => {
  it('returns the whole file history and fires nothing afterwards when attaching after done', async () => {
    const { open, start } = await setup(['read-only'])
    const engine = await open()
    const handle = await start(engine, 'read-only')
    const result = await within(handle.done, 10_000, 'run to finish')
    const event = vi.fn()
    const finishedListener = vi.fn()

    const attached = handle.attach({ event, finished: finishedListener })
    // Anything still queued for the listener would run in these turns.
    await new Promise((resolve) => setImmediate(resolve))

    const { events: onDisk } = await readEvents(path.join(handle.dir, 'events.jsonl'))
    expect(attached.events).toEqual(onDisk)
    expect(attached.events[0]?.type).toBe('run.started')
    expect(attached.result).toBe(result)
    expect([event.mock.calls.length, finishedListener.mock.calls.length]).toEqual([0, 0])
  })

  it('returns only run.started and delivers every later event once in seq order when attaching right after start', async () => {
    const { open, start } = await setup(['read-only'])
    const engine = await open()
    const live: RunEvent[] = []

    const handle = await start(engine, 'read-only')
    const attached = handle.attach({ event: (e) => live.push(e) })
    await finished(handle)

    expect(attached.events.map((e) => e.type)).toEqual(['run.started'])
    expect(live.map((e) => e.seq)).toEqual(
      Array.from({ length: handle.events().length - 1 }, (_, i) => i + 2),
    )
    expect(live).toEqual(handle.events().slice(1))
  })

  it('keeps each run stream on its own handle when two read-only runs run at once in one engine', async () => {
    const { open, start } = await setup(['read-only'])
    const engine = await open()
    // Calls through; only records what the engine emitter carried.
    const emitter: EventEmitter = engine
    const emit = vi.spyOn(emitter, 'emit')
    const seenA: RunEvent[] = []
    const seenB: RunEvent[] = []

    const a = await start(engine, 'read-only')
    a.attach({ event: (e) => seenA.push(e) })
    const b = await start(engine, 'read-only')
    b.attach({ event: (e) => seenB.push(e) })
    const [ra, rb] = await within(Promise.all([a.done, b.done]), 10_000, 'both runs')

    expect([ra.status, rb.status]).toEqual(['complete', 'complete'])
    const historyA = a.events()
    const historyB = b.events()
    expect(seenA.every((e) => historyA.includes(e) && !historyB.includes(e))).toBe(true)
    expect(seenB.every((e) => historyB.includes(e) && !historyA.includes(e))).toBe(true)
    expect(seenA.length).toBe(historyA.length - 1)
    expect(seenB.length).toBe(historyB.length - 1)
    expect(emit.mock.calls.map(([name]) => name).filter((name) => name !== 'providers')).toEqual([])
  })
})
