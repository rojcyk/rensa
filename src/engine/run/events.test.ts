import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, assert, beforeEach, describe, expect, it } from 'vitest'
import { type TmpDir, tmpDir } from '../../testing/tmpRepo.js'
import { RensaError } from '../errors.js'
import { EventLog, readEvents } from './events.js'
import type { NewRunEvent, RunEvent } from './types.js'

const STARTED: NewRunEvent = {
  type: 'run.started',
  data: {
    chain: 'tdd-review',
    input_kind: 'text',
    base: 'main',
    base_sha: '3f9c2a7e1b04d6c58e2f7a91b3d04e6c2a5f8b17',
    rensa_version: '0.1.0',
  },
}

const SPAWNED: NewRunEvent = {
  type: 'agent.spawned',
  step: 'review',
  agent: 'codex',
  data: {
    provider: 'codex',
    model: 'gpt-5-codex',
    effort: 'high',
    tools: 'read',
    session_id: '019a2f4e-7c1d-7b3a-9e52-4d8f1c6a0b93',
    resumed: false,
  },
}

const FINISHED: NewRunEvent = {
  type: 'agent.finished',
  step: 'review',
  agent: 'codex',
  data: { status: 'ok', exit_code: 0, usage: { input: 18_432, output: 2_107, cache_read: 9_216 } },
}

let tmp: TmpDir
let file: string

beforeEach(async () => {
  tmp = await tmpDir('rensa-events-')
  file = path.join(tmp.dir, 'events.jsonl')
})

afterEach(async () => {
  await tmp.cleanup()
})

describe('appending events', () => {
  it('writes 1000 lines with seq 1 to 1000 in order when appended from a tight loop', async () => {
    const log = await EventLog.create(file)

    for (let i = 0; i < 1000; i++) {
      log.append({ type: 'user.note', data: { text: `note ${i}`, applies_from: 'review' } })
    }
    await log.flush()

    const lines = (await readFile(file, 'utf8')).split('\n')
    expect(lines.pop()).toBe('')
    const seqs = lines.map((line) => (JSON.parse(line) as RunEvent).seq)
    expect(seqs).toEqual(Array.from({ length: 1000 }, (_, i) => i + 1))
  })

  it('returns the event stamped with the next seq and an ISO time when appended', async () => {
    const log = await EventLog.create(file)
    log.append(STARTED)

    const event = log.append(SPAWNED)

    expect(event).toEqual({ ...SPAWNED, seq: 2, t: expect.any(String) })
    expect(new Date(event.t).toISOString()).toBe(event.t)
  })

  it('emits the returned event synchronously when an event is appended', async () => {
    const log = await EventLog.create(file)
    const emitted: RunEvent[] = []
    log.on('event', (e) => emitted.push(e))

    const event = log.append(STARTED)

    // Checked with no await in between: a deferred emit would leave this empty.
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toBe(event)
  })

  it('throws RensaError INTERNAL when an event is appended after close', async () => {
    const log = await EventLog.create(file)
    log.append(STARTED)
    await log.close()

    let err: unknown
    try {
      log.append(SPAWNED)
    } catch (e) {
      err = e
    }

    assert(err instanceof RensaError, `expected RensaError, got ${String(err)}`)
    expect(err.code).toBe('INTERNAL')
    expect((await readEvents(file)).events.map((e) => e.type)).toEqual(['run.started'])
  })

  it('writes events appended just before close when close is awaited', async () => {
    const log = await EventLog.create(file)
    log.append(STARTED)
    log.append(SPAWNED)

    await log.close()

    expect((await readEvents(file)).events.map((e) => e.seq)).toEqual([1, 2])
  })
})

describe('creating the event log', () => {
  it('creates an empty file when none exists', async () => {
    await EventLog.create(file)

    expect(await readFile(file, 'utf8')).toBe('')
  })

  it('rejects with EEXIST and leaves the file untouched when the file already exists', async () => {
    const existing = `${JSON.stringify({ ...STARTED, seq: 1, t: '2026-10-28T09:12:03.418Z' })}\n`
    await writeFile(file, existing)

    await expect(EventLog.create(file)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(file, 'utf8')).toBe(existing)
  })
})

describe('reading events back', () => {
  it('returns exactly the appended events and no warnings when the file is intact', async () => {
    const log = await EventLog.create(file)
    const written = [log.append(STARTED), log.append(SPAWNED), log.append(FINISHED)]
    await log.close()

    expect(await readEvents(file)).toEqual({ events: written, warnings: [] })
  })

  it('reports two warnings when the file has a garbage middle line and a truncated last line', async () => {
    const first: RunEvent = { ...STARTED, seq: 1, t: '2026-10-28T09:12:03.418Z' }
    const second: RunEvent = { ...SPAWNED, seq: 2, t: '2026-10-28T09:12:04.007Z' }
    await writeFile(
      file,
      [
        JSON.stringify(first),
        '\u0000\u0000\u0000garbage',
        JSON.stringify(second),
        '{"seq":3,"t":"2026-10-28T09:14:',
      ].join('\n'),
    )

    expect(await readEvents(file)).toEqual({
      events: [first, second],
      warnings: ['line 2: not valid JSON', 'line 4: truncated final line'],
    })
  })

  it('passes an event of an unknown type through with all its fields', async () => {
    const future = {
      seq: 1,
      t: '2026-10-28T09:12:03.418Z',
      type: 'step.retried',
      step: 'review',
      data: { attempt: 2, reason: 'usage_limit' },
    }
    await writeFile(file, `${JSON.stringify(future)}\n`)

    expect(await readEvents(file)).toEqual({ events: [future], warnings: [] })
  })

  it.each<[string, unknown]>([
    ['seq is missing', { t: '2026-10-28T09:12:03.418Z', type: 'run.started' }],
    ['seq is a string', { seq: '1', t: '2026-10-28T09:12:03.418Z', type: 'run.started' }],
    ['t is missing', { seq: 1, type: 'run.started' }],
    ['type is missing', { seq: 1, t: '2026-10-28T09:12:03.418Z' }],
    ['step is a number', { seq: 1, t: '2026-10-28T09:12:03.418Z', type: 'step.started', step: 2 }],
    ['agent is null', { seq: 1, t: '2026-10-28T09:12:03.418Z', type: 'run.started', agent: null }],
    ['the line is an array', [1, '2026-10-28T09:12:03.418Z', 'run.started']],
  ])('skips a line with a not an event warning when %s', async (_, value) => {
    const valid: RunEvent = { ...STARTED, seq: 1, t: '2026-10-28T09:12:03.418Z' }
    await writeFile(file, `${JSON.stringify(valid)}\n${JSON.stringify(value)}\n`)

    expect(await readEvents(file)).toEqual({
      events: [valid],
      warnings: ['line 2: not an event'],
    })
  })
})
