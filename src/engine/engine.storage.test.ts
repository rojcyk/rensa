import { chmodSync, existsSync } from 'node:fs'
import { chmod } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dataOf, type EngineRepo, engineRepo, finished, ofType } from '../testing/engine.js'
import { applyResult, type RunEvent, type RunResult, readEvents, reduceRun } from './index.js'

const DEADLINE_MS = 10_000

let env: EngineRepo | undefined
/** Paths whose permissions a test changed, with the mode to restore so cleanup can remove them. */
let restore: Array<{ file: string; mode: number }> = []

afterEach(async () => {
  for (const { file, mode } of restore) await chmod(file, mode).catch(() => {})
  restore = []
  await env?.cleanup()
  env = undefined
})

async function setup(chains: string[]): Promise<EngineRepo> {
  env = await engineRepo(chains)
  return env
}

function chmodNow(file: string, mode: number, restoreTo: number): void {
  restore.push({ file, mode: restoreTo })
  chmodSync(file, mode)
}

describe('a write to events.jsonl fails mid-run', () => {
  it('resolves done failed with a STORAGE error, delivers no run.finished and releases the lock when events.jsonl becomes read-only before the first step.finished', async () => {
    const { open, start, lockFile } = await setup(['agent-write'])
    const engine = await open()
    vi.stubEnv('RENSA_FAKE_DELAY_MS', '100')
    const handle = await start(engine, 'agent-write')
    const eventsFile = path.join(handle.dir, 'events.jsonl')
    const finishedCalls: RunResult[] = []
    const live: RunEvent[] = []
    handle.attach({
      event(e) {
        live.push(e)
        if (e.type === 'agent.spawned') chmodNow(eventsFile, 0o444, 0o644)
      },
      finished: (r) => finishedCalls.push(r),
    })

    const { result, events } = await finished(handle, DEADLINE_MS)

    expect(result).toMatchObject({
      status: 'failed',
      error: {
        code: 'STORAGE',
        message: expect.stringContaining('EACCES'),
        hint: 'check free space and permissions under .rensa/runs',
      },
    })
    expect(finishedCalls).toHaveLength(1)
    expect(finishedCalls[0]).toBe(result)
    expect(handle.result()).toBe(result)
    expect(existsSync(lockFile)).toBe(false)
    expect(handle.attach({}).result).toBe(result)
    const { events: onDisk } = await readEvents(eventsFile)
    expect(ofType(onDisk, 'run.finished')).toEqual([])
    expect(ofType(events, 'run.finished')).toEqual([])
    expect(ofType(live, 'run.finished')).toEqual([])
  })

  it('reports the failed result over the events and returns the same progress for a matching result when applyResult is given each run', async () => {
    const { open, start } = await setup(['agent-write'])
    const engine = await open()
    const complete = await start(engine, 'agent-write')
    const { result: completeResult, events: completeEvents } = await finished(complete, DEADLINE_MS)
    vi.stubEnv('RENSA_FAKE_DELAY_MS', '100')
    const failing = await start(engine, 'agent-write')
    const eventsFile = path.join(failing.dir, 'events.jsonl')
    failing.attach({
      event(e) {
        if (e.type === 'agent.spawned') chmodNow(eventsFile, 0o444, 0o644)
      },
    })
    const { result: failedResult, events: failedEvents } = await finished(failing, DEADLINE_MS)

    const failedProgress = reduceRun(failedEvents)
    const completeProgress = reduceRun(completeEvents)

    expect(applyResult(failedProgress, failedResult)).toMatchObject({
      status: 'failed',
      error: { code: 'STORAGE', message: expect.stringContaining('EACCES') },
    })
    expect(applyResult(completeProgress, completeResult)).toBe(completeProgress)
  })
})

describe('run.json cannot be written at the finish', () => {
  it('delivers run.finished failed, never complete, when the run directory turns read-only while paused', async () => {
    const { open, start } = await setup(['pause-before'])
    const engine = await open()
    const handle = await start(engine, 'pause-before')
    const finishedStatuses: unknown[] = []
    const finishedCalls: RunResult[] = []
    handle.attach({
      event(e) {
        if (e.type === 'run.finished') finishedStatuses.push(dataOf(e).status)
        if (e.type === 'run.paused') {
          chmodNow(handle.dir, 0o555, 0o755)
          handle.resume()
        }
      },
      finished: (r) => finishedCalls.push(r),
    })

    const { result, events } = await finished(handle, DEADLINE_MS)

    expect(finishedStatuses).toEqual(['failed'])
    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'STORAGE', message: expect.stringContaining('EACCES') },
    })
    expect(finishedCalls).toHaveLength(1)
    expect(finishedCalls[0]).toBe(result)
    const { events: onDisk } = await readEvents(path.join(handle.dir, 'events.jsonl'))
    expect(events.map((e) => e.seq)).toEqual(onDisk.map((e) => e.seq))
  })
})

describe('run.finished cannot be made durable', () => {
  it('delivers no run.finished, resolves failed with a STORAGE error and releases the lock when events.jsonl turns read-only at the last step.finished', async () => {
    const { open, start, lockFile } = await setup(['three-step'])
    const engine = await open()
    const handle = await start(engine, 'three-step')
    const eventsFile = path.join(handle.dir, 'events.jsonl')
    const live: RunEvent[] = []
    handle.attach({
      event(e) {
        live.push(e)
        if (e.type === 'step.finished' && e.step === 'wrap-up') chmodNow(eventsFile, 0o444, 0o644)
      },
    })

    const { result, events } = await finished(handle, DEADLINE_MS)

    expect(result).toMatchObject({ status: 'failed', error: { code: 'STORAGE' } })
    expect(ofType(live, 'run.finished')).toEqual([])
    expect(ofType(events, 'run.finished')).toEqual([])
    expect(existsSync(lockFile)).toBe(false)
  })
})
