import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, assert, beforeEach, describe, expect, it } from 'vitest'
import { type TmpDir, tmpDir } from '../../../testing/tmpRepo.js'
import { drainDiag } from '../../diag.js'
import type { AgentEvent, DoneEvent, SpawnRequest } from '../types.js'
import { loadFixture } from './fixture.js'
import { fakeAdapter, parseFake } from './index.js'

const HELLO = path.resolve(import.meta.dirname, '../../../../test/fixtures/fake/hello')

let tmp: TmpDir

beforeEach(async () => {
  drainDiag()
  tmp = await tmpDir('rensa-fake-')
})

afterEach(async () => {
  await tmp.cleanup()
})

async function* fromLines(lines: readonly string[]): AsyncGenerator<string> {
  yield* lines
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

const parse = (lines: readonly string[]) => collect(parseFake(fromLines(lines)))

const line = (value: object) => JSON.stringify(value)

function request(overrides: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    cwd: tmp.dir,
    env: { RENSA_FAKE_DELAY_MS: '0' },
    message: 'Summarize README.md in one sentence.',
    tools: 'read',
    session: { id: 'ses_4f2a9c71', resume: false },
    stagingDir: path.join(tmp.dir, '.rensa', 'runs', 'r_8c1d0e', 'agents', 'review', 'fake'),
    timeoutMs: 60_000,
    ...overrides,
  }
}

/** Writes a fixture whose raw.jsonl holds `lines`; returns its path relative to tmp.dir. */
async function rawFixture(name: string, lines: readonly string[]): Promise<string> {
  const dir = path.join(tmp.dir, 'fixtures', name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'raw.jsonl'), `${lines.join('\n')}\n`)
  return path.join('fixtures', name)
}

const KILLED = { kind: 'exit', message: 'killed' } as const

describe('parsing the fake dialect', () => {
  it('emits each line raw before the event derived from it and ends with one done', async () => {
    const lines = [
      line({ type: 'delta', text: 'Reading' }),
      line({ type: 'text', text: 'Reading the README.' }),
      line({
        type: 'tool',
        name: 'Read',
        input: { path: 'README.md' },
        ok: true,
        output: '# shop',
      }),
      line({ type: 'usage', input: 310, output: 27 }),
      line({ type: 'done', exit: 0 }),
    ]

    const events = await parse(lines)

    const expected: AgentEvent[] = [
      { kind: 'raw', line: lines[0] as string },
      { kind: 'delta', text: 'Reading' },
      { kind: 'raw', line: lines[1] as string },
      { kind: 'text', text: 'Reading the README.' },
      { kind: 'raw', line: lines[2] as string },
      { kind: 'tool', name: 'Read', input: { path: 'README.md' }, ok: true, output: '# shop' },
      { kind: 'raw', line: lines[3] as string },
      { kind: 'usage', usage: { input: 310, output: 27 } },
      { kind: 'raw', line: lines[4] as string },
      {
        kind: 'done',
        reply: 'Reading the README.',
        exitCode: 0,
        usage: { input: 310, output: 27 },
      },
    ]
    expect(events).toEqual(expected)
  })

  it('replies with the last text record and reports the last usage when there are several', async () => {
    const events = await parse([
      line({ type: 'text', text: 'First block.' }),
      line({ type: 'usage', input: 100, output: 10 }),
      line({ type: 'text', text: 'Second block.' }),
      line({ type: 'usage', input: 220, output: 35, cache_read: 80 }),
      line({ type: 'done', exit: 0 }),
    ])

    const expected: DoneEvent = {
      kind: 'done',
      reply: 'Second block.',
      exitCode: 0,
      usage: { input: 220, output: 35, cache_read: 80 },
    }
    expect(events.at(-1)).toEqual(expected)
  })

  it('carries the exit code and error of a done line that has one', async () => {
    const events = await parse([
      line({ type: 'done', exit: 1, error: { kind: 'auth', message: 'Not logged in' } }),
    ])

    const expected: DoneEvent = {
      kind: 'done',
      reply: '',
      exitCode: 1,
      error: { kind: 'auth', message: 'Not logged in' },
    }
    expect(events.at(-1)).toEqual(expected)
  })

  it('still emits raw for lines after the done line but nothing else, and keeps done last', async () => {
    const after = [
      line({ type: 'text', text: 'Too late.' }),
      line({ type: 'usage', input: 999, output: 999 }),
      line({ type: 'done', exit: 1 }),
    ]

    const events = await parse([
      line({ type: 'text', text: 'On time.' }),
      line({ type: 'done', exit: 0 }),
      ...after,
    ])

    expect(events.slice(-4)).toEqual([
      ...after.map((l) => ({ kind: 'raw', line: l })),
      { kind: 'done', reply: 'On time.', exitCode: 0 },
    ])
    expect(events.filter((e) => e.kind === 'done')).toHaveLength(1)
  })

  it('reports no_output with a null exit code when the input has no done line', async () => {
    const events = await parse([
      line({ type: 'text', text: 'Partial answer.' }),
      line({ type: 'usage', input: 50, output: 5 }),
    ])

    expect(events.at(-1)).toEqual({
      kind: 'done',
      reply: 'Partial answer.',
      exitCode: null,
      usage: { input: 50, output: 5 },
      error: { kind: 'no_output', message: 'no done line in the stream' },
    })
  })

  it('emits only a no_output done when the input is empty', async () => {
    const events = await parse([])

    expect(events).toEqual([
      {
        kind: 'done',
        reply: '',
        exitCode: null,
        error: { kind: 'no_output', message: 'no done line in the stream' },
      },
    ])
  })

  it.each([
    ['is not JSON', 'Error: unexpected token'],
    ['is JSON of an unknown type', line({ type: 'result', text: 'done' })],
    ['is a known type with a bad field', line({ type: 'text', text: 42 })],
  ])('reports a line that %s through diag and emits only its raw', async (_, bad) => {
    const events = await parse([bad, line({ type: 'done', exit: 0 })])

    expect(events.slice(0, 2)).toEqual([
      { kind: 'raw', line: bad },
      { kind: 'raw', line: line({ type: 'done', exit: 0 }) },
    ])
    const entries = drainDiag()
    expect(entries.map((e) => e.scope)).toEqual(['fake'])
    expect(entries[0]?.message).toMatch(/^line 1: not a fake event: /)
  })

  it('emits only raw for a blank line without reporting it', async () => {
    const events = await parse(['', line({ type: 'done', exit: 0 })])

    expect(events[0]).toEqual({ kind: 'raw', line: '' })
    expect(events[1]).toEqual({ kind: 'raw', line: line({ type: 'done', exit: 0 }) })
    expect(drainDiag()).toEqual([])
  })
})

describe('replaying a fixture through spawn', () => {
  it('replays the hello fixture when RENSA_FAKE_FIXTURE is unset', async () => {
    const hello = await loadFixture(HELLO)

    const events = await collect(fakeAdapter.spawn(request()).events)

    expect(events).toEqual(await parse(hello.raw))
    expect(events.at(-1)).toEqual(hello.done)
  })

  it('replays the fixture named by RENSA_FAKE_FIXTURE relative to the request cwd', async () => {
    const lines = [
      line({ type: 'text', text: 'From the custom fixture.' }),
      line({ type: 'done', exit: 0 }),
    ]
    const fixture = await rawFixture('custom', lines)

    const events = await collect(
      fakeAdapter.spawn(request({ env: { RENSA_FAKE_DELAY_MS: '0', RENSA_FAKE_FIXTURE: fixture } }))
        .events,
    )

    expect(events).toEqual(await parse(lines))
  })

  it('emits a single exit done naming the file when the fixture does not exist', async () => {
    const env = { RENSA_FAKE_DELAY_MS: '0', RENSA_FAKE_FIXTURE: 'fixtures/missing' }

    const events = await collect(fakeAdapter.spawn(request({ env })).events)

    expect(events).toEqual([
      {
        kind: 'done',
        reply: '',
        exitCode: null,
        error: {
          kind: 'exit',
          message: expect.stringContaining(path.join(tmp.dir, 'fixtures', 'missing', 'raw.jsonl')),
        },
      },
    ])
  })

  it('waits RENSA_FAKE_DELAY_MS before each replayed line', async () => {
    const fixture = await rawFixture('paced', [
      line({ type: 'text', text: 'One.' }),
      line({ type: 'text', text: 'Two.' }),
      line({ type: 'done', exit: 0 }),
    ])
    const started = performance.now()

    await collect(
      fakeAdapter.spawn(
        request({ env: { RENSA_FAKE_DELAY_MS: '40', RENSA_FAKE_FIXTURE: fixture } }),
      ).events,
    )

    // Three lines, 40 ms before each; a little slack for timer rounding.
    expect(performance.now() - started).toBeGreaterThanOrEqual(110)
  })

  it('waits 20 ms before each line when RENSA_FAKE_DELAY_MS is unset', async () => {
    const started = performance.now()

    await collect(fakeAdapter.spawn(request({ env: {} })).events)

    // The hello fixture has nine lines.
    expect(performance.now() - started).toBeGreaterThanOrEqual(9 * 20 - 10)
  })

  it('falls back to the default delay and reports it when RENSA_FAKE_DELAY_MS is not a number', async () => {
    const fixture = await rawFixture('short', [line({ type: 'done', exit: 0 })])

    const events = await collect(
      fakeAdapter.spawn(
        request({ env: { RENSA_FAKE_DELAY_MS: 'soon', RENSA_FAKE_FIXTURE: fixture } }),
      ).events,
    )

    expect(events.at(-1)).toEqual({ kind: 'done', reply: '', exitCode: 0 })
    expect(drainDiag().map((e) => e.message)).toEqual([
      'ignoring RENSA_FAKE_DELAY_MS=soon; expected a non-negative number of milliseconds',
    ])
  })
})

describe('recording the request', () => {
  it('writes the request to stagingDir/request.json', async () => {
    const req = request({
      persona: 'You are a careful reviewer.',
      model: 'fake-large',
      effort: 'high',
      session: { id: 'ses_9b31e0d2', resume: true },
    })

    await collect(fakeAdapter.spawn(req).events)

    const written: unknown = JSON.parse(
      await readFile(path.join(req.stagingDir, 'request.json'), 'utf8'),
    )
    expect(written).toEqual(req)
  })

  it('keeps only RENSA_* variables from the environment when writing request.json', async () => {
    const env = {
      RENSA_FAKE_DELAY_MS: '0',
      RENSA_DEV: '1',
      HOME: '/Users/alice',
      PATH: '/opt/homebrew/bin:/usr/bin:/bin',
      GITHUB_TOKEN: 'ghp_7Kq2vX9mN4pL8rT3wY6zB1cD5fH0jA',
    }
    const req = request({ env })

    await collect(fakeAdapter.spawn(req).events)

    const text = await readFile(path.join(req.stagingDir, 'request.json'), 'utf8')
    expect(JSON.parse(text).env).toEqual({ RENSA_FAKE_DELAY_MS: '0', RENSA_DEV: '1' })
    expect(text).not.toContain('ghp_7Kq2vX9mN4pL8rT3wY6zB1cD5fH0jA')
  })
})

describe('killing a replay', () => {
  it('stops forwarding events and ends with one killed done when killed mid-replay', async () => {
    const agent = fakeAdapter.spawn(request())
    const before: AgentEvent[] = []
    const iterator = agent.events[Symbol.asyncIterator]()
    for (;;) {
      const next = await iterator.next()
      assert(!next.done, 'replay ended before its first text record')
      before.push(next.value)
      if (next.value.kind === 'text') break
    }

    agent.kill()
    const after: AgentEvent[] = []
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
      after.push(next.value)
    }

    expect(before.filter((e) => e.kind === 'done')).toEqual([])
    expect(after).toEqual([
      { kind: 'done', reply: 'Hello, I will look at the README.', exitCode: null, error: KILLED },
    ])
  })

  it('keeps the last usage seen on the killed done', async () => {
    const fixture = await rawFixture('usage-then-wait', [
      line({ type: 'usage', input: 75, output: 9 }),
      line({ type: 'text', text: 'Never reached.' }),
      line({ type: 'done', exit: 0 }),
    ])
    const agent = fakeAdapter.spawn(
      request({ env: { RENSA_FAKE_DELAY_MS: '0', RENSA_FAKE_FIXTURE: fixture } }),
    )
    const iterator = agent.events[Symbol.asyncIterator]()
    let next = await iterator.next()
    while (!next.done && next.value.kind !== 'usage') next = await iterator.next()

    agent.kill()
    const rest: AgentEvent[] = []
    for (next = await iterator.next(); !next.done; next = await iterator.next()) {
      rest.push(next.value)
    }

    expect(rest).toEqual([
      { kind: 'done', reply: '', exitCode: null, usage: { input: 75, output: 9 }, error: KILLED },
    ])
  })

  it('emits only a killed done when killed while waiting for the first line', async () => {
    // A minute per line: the replay is still waiting for line one when killed.
    const agent = fakeAdapter.spawn(request({ env: { RENSA_FAKE_DELAY_MS: '60000' } }))
    const events = collect(agent.events)

    // Give the replay time to reach its first one-minute wait, so the kill
    // has to cut that wait short; if it did not, the test would time out.
    // Killed earlier, the outcome must be the same.
    await new Promise((resolve) => setTimeout(resolve, 50))
    agent.kill()

    expect(await events).toEqual([{ kind: 'done', reply: '', exitCode: null, error: KILLED }])
  })

  it('delivers the killed done only after RENSA_FAKE_KILL_DELAY_MS has passed', async () => {
    const agent = fakeAdapter.spawn(
      request({ env: { RENSA_FAKE_DELAY_MS: '0', RENSA_FAKE_KILL_DELAY_MS: '150' } }),
    )
    const iterator = agent.events[Symbol.asyncIterator]()
    await iterator.next()

    agent.kill()
    const killedAt = performance.now()
    const next = await iterator.next()
    const elapsed = performance.now() - killedAt

    expect(next.value).toMatchObject({ kind: 'done', error: KILLED })
    expect(elapsed).toBeGreaterThanOrEqual(140)
    expect((await iterator.next()).done).toBe(true)
  })

  it('changes nothing when killed after the done has been emitted', async () => {
    const hello = await loadFixture(HELLO)
    const agent = fakeAdapter.spawn(request())
    const iterator = agent.events[Symbol.asyncIterator]()
    const events: AgentEvent[] = []
    for (;;) {
      const next = await iterator.next()
      assert(!next.done, 'replay ended without a done')
      events.push(next.value)
      if (next.value.kind === 'done') break
    }

    agent.kill()
    const afterKill = await iterator.next()

    expect(events.at(-1)).toEqual(hello.done)
    expect(afterKill.done).toBe(true)
  })
})

describe('reporting availability', () => {
  it('reports ready with version fake when no hook is set', async () => {
    await expect(fakeAdapter.available({})).resolves.toEqual({ status: 'ready', version: 'fake' })
  })

  it('reports not installed when RENSA_FAKE_AVAILABILITY=not_installed', async () => {
    await expect(
      fakeAdapter.available({ RENSA_FAKE_AVAILABILITY: 'not_installed' }),
    ).resolves.toEqual({ status: 'not_installed' })
  })

  it('reports not logged in with a login hint when RENSA_FAKE_AVAILABILITY=not_logged_in', async () => {
    await expect(
      fakeAdapter.available({ RENSA_FAKE_AVAILABILITY: 'not_logged_in' }),
    ).resolves.toEqual({ status: 'not_logged_in', version: 'fake', hint: 'fake login' })
  })

  it('reports ready and records a diagnostic when RENSA_FAKE_AVAILABILITY is unrecognized', async () => {
    const availability = await fakeAdapter.available({ RENSA_FAKE_AVAILABILITY: 'offline' })

    expect(availability).toEqual({ status: 'ready', version: 'fake' })
    expect(drainDiag().map((e) => e.message)).toEqual([
      'ignoring RENSA_FAKE_AVAILABILITY=offline; expected not_installed or not_logged_in',
    ])
  })

  it('answers only after RENSA_FAKE_AVAILABLE_DELAY_MS has passed', async () => {
    const started = performance.now()

    await fakeAdapter.available({ RENSA_FAKE_AVAILABLE_DELAY_MS: '100' })

    expect(performance.now() - started).toBeGreaterThanOrEqual(90)
  })
})

describe('declaring capabilities', () => {
  it('supports resume, models, every effort level and both tool modes', () => {
    expect(fakeAdapter.capabilities()).toEqual({
      resume: true,
      model: true,
      effort: ['low', 'medium', 'high', 'max'],
      tools: ['read', 'write'],
    })
  })
})
