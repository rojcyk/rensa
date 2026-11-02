import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  dataOf,
  type EngineRepo,
  engineRepo,
  eventMatching,
  finished,
  ofType,
  within,
} from '../testing/engine.js'
import { killProcessesWithArgs, processesWithArgs } from '../testing/processes.js'
import { type RunEvent, type RunHandle, readEvents } from './index.js'

// A lost wake or a missed command leaves a run waiting forever; every
// run in this file has a deadline that turns that into a failure.
const DEADLINE_MS = 4_000

let env: EngineRepo | undefined

afterEach(async () => {
  await env?.cleanup()
  env = undefined
})

async function setup(chains: string[]): Promise<EngineRepo> {
  env = await engineRepo(chains)
  return env
}

function actions(events: ReadonlyArray<RunEvent>, action: string): RunEvent[] {
  return ofType(events, 'user.action').filter((e) => dataOf(e).action === action)
}

/** Calls `fn` once, on the first streamed delta of the agent step. */
function onFirstDelta(handle: RunHandle, fn: () => void): void {
  let fired = false
  handle.attach({
    delta() {
      if (fired) return
      fired = true
      fn()
    },
  })
}

describe('pausing before a step', () => {
  it('waits at the declared pause until resume() and puts a note sent while paused into the next prompt', async () => {
    const { open, start } = await setup(['pause-before'])
    const engine = await open()
    const handle = await start(engine, 'pause-before')

    const paused = await eventMatching(handle, (e) => e.type === 'run.paused')
    const twoStarted = vi.waitFor(
      () =>
        expect(handle.events().some((e) => e.type === 'step.started' && e.step === 'two')).toBe(
          true,
        ),
      { timeout: 300 },
    )
    await expect(twoStarted).rejects.toThrow('expected false to be true')
    handle.note('Keep the public API unchanged.')
    handle.resume()
    const { result, events } = await finished(handle, DEADLINE_MS)

    expect(dataOf(paused)).toEqual({ before: 'two', reason: 'declared' })
    expect(ofType(events, 'user.note').map(dataOf)).toEqual([
      { text: 'Keep the public API unchanged.', applies_from: 'two' },
    ])
    expect(result.status).toBe('complete')
    const prompt = await readFile(
      path.join(handle.dir, 'agents', 'two', 'fake', 'prompt.md'),
      'utf8',
    )
    expect(prompt).toBe(
      'Review the README and report what it contains.\n\n\n## User notes\n\n1. Keep the public API unchanged.',
    )
  })
})

describe('kill', () => {
  it('finishes the agent step killed and fails the stop run when kill() lands during the agent step', async () => {
    const { open, start } = await setup(['read-only'])
    const engine = await open()
    const handle = await start(engine, 'read-only')
    onFirstDelta(handle, () => handle.kill())

    const { result, events } = await finished(handle, DEADLINE_MS)

    expect(dataOf(ofType(events, 'agent.finished')[0])).toMatchObject({ status: 'killed' })
    expect(dataOf(ofType(events, 'step.finished')[0])).toEqual({ status: 'killed' })
    expect(actions(events, 'kill').map(dataOf)).toEqual([{ action: 'kill', step: 'review' }])
    expect(result).toMatchObject({ status: 'failed', failedStep: 'review' })
  })
})

describe('abort', () => {
  it('holds the lock until the killed agent has drained and ends aborted when abort() lands during an agent step', async () => {
    const { open, start, lockFile } = await setup(['agent-write'])
    const engine = await open()
    vi.stubEnv('RENSA_FAKE_KILL_DELAY_MS', '300')
    const handle = await start(engine, 'agent-write')
    let settled = false
    const done = handle.done.then((result) => {
      settled = true
      return { result, lockAtDone: existsSync(lockFile) }
    })
    let abortedAt = 0
    onFirstDelta(handle, () => {
      abortedAt = Date.now()
      handle.abort()
    })

    await eventMatching(handle, (e) => e.type === 'user.action')
    await new Promise((resolve) => setTimeout(resolve, 100 - (Date.now() - abortedAt)))
    const during = { lock: existsSync(lockFile), settled }
    const { result, lockAtDone } = await within(done, DEADLINE_MS, 'aborted run to finish')

    expect(during).toEqual({ lock: true, settled: false })
    expect(lockAtDone).toBe(false)
    expect(result).toEqual({ status: 'aborted', finishedAt: expect.any(String) })
    const { events: onDisk } = await readEvents(path.join(handle.dir, 'events.jsonl'))
    expect(onDisk.slice(-3).map((e) => [e.type, dataOf(e).status])).toEqual([
      ['agent.finished', 'killed'],
      ['step.finished', 'killed'],
      ['run.finished', 'aborted'],
    ])
  })

  it('ends the wait, starts no further step and releases the lock when abort() lands while paused', async () => {
    const { open, start, lockFile } = await setup(['pause-before'])
    const engine = await open()
    const handle = await start(engine, 'pause-before')
    await eventMatching(handle, (e) => e.type === 'run.paused')
    const lockWhilePaused = existsSync(lockFile)

    handle.abort()
    const { result, events } = await finished(handle, DEADLINE_MS)

    expect(lockWhilePaused).toBe(true)
    expect(result.status).toBe('aborted')
    expect(ofType(events, 'step.started').map((e) => e.step)).toEqual(['one'])
    expect(dataOf(events.at(-1))).toEqual({ status: 'aborted' })
    expect(existsSync(lockFile)).toBe(false)
  })

  it('logs only start, abort and finish and creates no agent directory when abort() is called right after start()', async () => {
    const { open, start, lockFile } = await setup(['sleep-first'])
    const engine = await open()

    const handle = await start(engine, 'sleep-first')
    handle.abort()
    const { result, events } = await finished(handle, DEADLINE_MS)

    try {
      expect(result.status).toBe('aborted')
      expect(events.map((e) => [e.type, dataOf(e).action ?? dataOf(e).status])).toEqual([
        ['run.started', undefined],
        ['user.action', 'abort'],
        ['run.finished', 'aborted'],
      ])
      expect(await readdir(path.join(handle.dir, 'agents'))).toEqual([])
      expect(existsSync(lockFile)).toBe(false)
      expect(await processesWithArgs('sleep 30.6451')).toEqual([])
    } finally {
      await killProcessesWithArgs('sleep 30.6451')
    }
  })
})

describe('engine errors inside a step', () => {
  it('ends the run failed with a TEMPLATE error and spawns nothing when a var command fails on a continue step', async () => {
    const { open, start } = await setup(['vars-fail'])
    const engine = await open()

    const handle = await start(engine, 'vars-fail')
    const { result, events } = await finished(handle, DEADLINE_MS)

    expect(result).toMatchObject({
      status: 'failed',
      failedStep: 'prep',
      error: { code: 'TEMPLATE', message: expect.stringContaining('exited with 3') },
    })
    expect(ofType(events, 'agent.spawned')).toEqual([])
    expect(ofType(events, 'step.started').map((e) => e.step)).toEqual(['prep'])
    expect(dataOf(ofType(events, 'step.finished')[0])).toEqual({ status: 'failed' })
    expect(dataOf(events.at(-1))).toEqual({ status: 'failed', failed_step: 'prep' })
  })

  it('finishes the step killed with no error within a second when abort() lands during var evaluation', async () => {
    const SLEEP = 'sleep 30.6431'
    const { open, start } = await setup(['vars-slow'])
    const engine = await open()
    try {
      const handle = await start(engine, 'vars-slow')
      await eventMatching(handle, (e) => e.type === 'step.started')
      await vi.waitFor(async () => expect(await processesWithArgs(SLEEP)).toHaveLength(1), {
        timeout: 5_000,
      })

      const abortedAt = Date.now()
      handle.abort()
      const { result, events } = await finished(handle, DEADLINE_MS)
      const elapsed = Date.now() - abortedAt

      expect(elapsed).toBeLessThan(1_000)
      expect(result).toEqual({ status: 'aborted', finishedAt: expect.any(String) })
      expect(ofType(events, 'agent.spawned')).toEqual([])
      expect(dataOf(ofType(events, 'step.finished')[0])).toEqual({ status: 'killed' })
      expect(await processesWithArgs(SLEEP)).toEqual([])
    } finally {
      await killProcessesWithArgs(SLEEP)
    }
  })
})

describe('commands from inside listeners', () => {
  it('completes the run when resume() is called inside the run.paused listener', async () => {
    const { open, start } = await setup(['pause-before'])
    const engine = await open()
    const handle = await start(engine, 'pause-before')
    handle.attach({
      event(e) {
        if (e.type === 'run.paused') handle.resume()
      },
    })

    const { result } = await finished(handle, DEADLINE_MS)

    expect(result.status).toBe('complete')
  })

  it('ends the run aborted when abort() is called inside the run.paused listener', async () => {
    const { open, start } = await setup(['pause-before'])
    const engine = await open()
    const handle = await start(engine, 'pause-before')
    handle.attach({
      event(e) {
        if (e.type === 'run.paused') handle.abort()
      },
    })

    const { result } = await finished(handle, DEADLINE_MS)

    expect(result.status).toBe('aborted')
  })

  it('runs the step and pauses after it with one pause action when resume() then pause() are called inside the run.paused listener', async () => {
    const { open, start } = await setup(['pause-before'])
    const engine = await open()
    const handle = await start(engine, 'pause-before')
    handle.attach({
      event(e) {
        if (e.type !== 'run.paused') return
        if (dataOf(e).before === 'two') {
          handle.resume()
          handle.pause()
        } else {
          handle.resume()
        }
      },
    })

    const { result, events } = await finished(handle, DEADLINE_MS)

    expect(result.status).toBe('complete')
    expect(
      events
        .filter((e) => ['run.paused', 'step.started', 'step.finished'].includes(e.type))
        .map((e) => [e.type, e.step ?? dataOf(e)]),
    ).toEqual([
      ['step.started', 'one'],
      ['step.finished', 'one'],
      ['run.paused', { before: 'two', reason: 'declared' }],
      ['step.started', 'two'],
      ['step.finished', 'two'],
      ['run.paused', { after: 'two', reason: 'user' }],
    ])
    expect(actions(events, 'pause')).toHaveLength(1)
  })

  it('logs no kill action when kill() is called inside the step.finished listener', async () => {
    const { open, start } = await setup(['read-only'])
    const engine = await open()
    const handle = await start(engine, 'read-only')
    handle.attach({
      event(e) {
        if (e.type === 'step.finished') handle.kill()
      },
    })

    const { result, events } = await finished(handle, DEADLINE_MS)

    expect(result.status).toBe('complete')
    expect(actions(events, 'kill')).toEqual([])
  })

  it('logs exactly one kill action when kill() is called again inside the user.action kill listener', async () => {
    const { open, start } = await setup(['read-only'])
    const engine = await open()
    const handle = await start(engine, 'read-only')
    handle.attach({
      event(e) {
        if (e.type === 'user.action' && dataOf(e).action === 'kill') handle.kill()
      },
    })
    onFirstDelta(handle, () => handle.kill())

    const { events } = await finished(handle, DEADLINE_MS)

    expect(actions(events, 'kill')).toHaveLength(1)
  })

  it('logs one abort action and no kill action when abort() and kill() are called inside the user.action abort listener', async () => {
    const { open, start } = await setup(['read-only'])
    const engine = await open()
    const handle = await start(engine, 'read-only')
    handle.attach({
      event(e) {
        if (e.type === 'user.action' && dataOf(e).action === 'abort') {
          handle.abort()
          handle.kill()
        }
      },
    })
    onFirstDelta(handle, () => handle.abort())

    const { result, events } = await finished(handle, DEADLINE_MS)

    expect(result.status).toBe('aborted')
    expect([actions(events, 'abort').length, actions(events, 'kill').length]).toEqual([1, 0])
  })
})
