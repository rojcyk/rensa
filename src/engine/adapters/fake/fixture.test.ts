import { AssertionError } from 'node:assert'
import { copyFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type TmpDir, tmpDir } from '../../../testing/tmpRepo.js'
import { RensaError } from '../../errors.js'
import type { AgentEvent, DoneEvent, Parser } from '../types.js'
import { fixtureTest, loadFixture, splitLines } from './fixture.js'
import { parseFake } from './index.js'

const HELLO = path.resolve(import.meta.dirname, '../../../../test/fixtures/fake/hello')

type FixtureFile = 'meta.json' | 'raw.jsonl' | 'transcript.jsonl' | 'reply.md' | 'done.json'

let tmp: TmpDir

beforeEach(async () => {
  tmp = await tmpDir('rensa-fixture-')
})

afterEach(async () => {
  await tmp.cleanup()
})

/** A copy of the hello fixture in the temp dir with some files replaced. */
async function helloWith(overrides: Partial<Record<FixtureFile, string>>): Promise<string> {
  for (const name of await readdir(HELLO)) {
    await copyFile(path.join(HELLO, name), path.join(tmp.dir, name))
  }
  for (const [name, text] of Object.entries(overrides)) {
    await writeFile(path.join(tmp.dir, name), text)
  }
  return tmp.dir
}

/** The fake parser with its event stream rewritten by `edit`. */
function editedParser(edit: (events: AgentEvent[]) => AgentEvent[]): { parse: Parser } {
  return {
    async *parse(lines) {
      const events: AgentEvent[] = []
      for await (const event of parseFake(lines)) events.push(event)
      yield* edit(events)
    },
  }
}

describe('loading a fixture', () => {
  it('reads the hello fixture with its done built from reply.md and done.json', async () => {
    const fixture = await loadFixture(HELLO)

    const expectedDone: DoneEvent = {
      kind: 'done',
      reply: 'The README is a single heading.',
      exitCode: 0,
      usage: { input: 240, output: 42, cache_read: 100 },
    }
    expect(fixture.done).toEqual(expectedDone)
    expect(fixture.meta.provider).toBe('fake')
    expect(fixture.raw.at(-1)).toBe('{"type":"done","exit":0}')
    expect(fixture.transcript.map((r) => r.kind)).toEqual(['text', 'tool', 'text'])
  })

  it('names the file and line when a transcript.jsonl line is not JSON', async () => {
    const dir = await helloWith({
      'transcript.jsonl':
        '{"t":"2026-11-02T10:00:00.000Z","kind":"text","text":"Hello"}\n{"t":"2026-11-02T10:00:00.100Z","kind":"text",\n',
    })

    await expect(loadFixture(dir)).rejects.toThrow(
      expect.objectContaining({
        name: 'RensaError',
        code: 'INTERNAL',
        message: `fixture ${path.join(dir, 'transcript.jsonl')} line 2: not valid JSON`,
      }),
    )
  })

  it('names the file, line and kind when a transcript.jsonl line is not a record', async () => {
    const dir = await helloWith({
      'transcript.jsonl': '{"t":"2026-11-02T10:00:00.000Z","kind":"text","txt":"Hello"}\n',
    })

    const loading = loadFixture(dir)

    await expect(loading).rejects.toThrow(RensaError)
    await expect(loading).rejects.toThrow(
      `fixture ${path.join(dir, 'transcript.jsonl')} line 1 (kind "text") is not a transcript record`,
    )
  })

  it('reports a mistyped transcript as a fixture error, not a diff, when fixtureTest runs', async () => {
    const dir = await helloWith({
      'transcript.jsonl': '{"kind":"text","text":"Hello, I will look at the README."}\n',
    })

    await expect(fixtureTest({ parse: parseFake }, dir)).rejects.toThrow(RensaError)
  })

  it.each([
    ['kind', '{ "kind": "done", "exitCode": 0 }'],
    ['reply', '{ "reply": "The README is a single heading.", "exitCode": 0 }'],
    ['an unknown key', '{ "exitCode": 0, "durationMs": 1200 }'],
  ])('rejects done.json when it holds %s', async (_, doneJson) => {
    const dir = await helloWith({ 'done.json': doneJson })

    await expect(loadFixture(dir)).rejects.toThrow(
      expect.objectContaining({
        code: 'INTERNAL',
        message: expect.stringContaining(`fixture ${path.join(dir, 'done.json')}:`),
      }),
    )
  })

  it('rejects done.json when it is missing exitCode', async () => {
    const dir = await helloWith({ 'done.json': '{ "usage": { "input": 240, "output": 42 } }' })

    await expect(loadFixture(dir)).rejects.toThrow(RensaError)
  })
})

describe('checking a parser against a fixture', () => {
  it('passes when the fake parser replays the hand-written hello fixture', async () => {
    await expect(fixtureTest({ parse: parseFake }, HELLO)).resolves.toBeUndefined()
  })

  it('fails when the parser emits a record that differs from transcript.jsonl', async () => {
    const parser = editedParser((events) =>
      events.map((e) => (e.kind === 'tool' ? { ...e, output: '# shop\n' } : e)),
    )

    const checking = fixtureTest(parser, HELLO)

    await expect(checking).rejects.toBeInstanceOf(AssertionError)
    await expect(checking).rejects.toThrow('records differ from')
  })

  it('fails when the parser emits a record transcript.jsonl does not have', async () => {
    const parser = editedParser((events) => [{ kind: 'note', text: 'replay started' }, ...events])

    await expect(fixtureTest(parser, HELLO)).rejects.toThrow('records differ from')
  })

  it('fails when the parser drops a raw line', async () => {
    const parser = editedParser((events) => {
      const firstRaw = events.findIndex((e) => e.kind === 'raw')
      return events.filter((_, i) => i !== firstRaw)
    })

    const checking = fixtureTest(parser, HELLO)

    await expect(checking).rejects.toBeInstanceOf(AssertionError)
    await expect(checking).rejects.toThrow('raw lines differ from')
  })

  it('fails when the parser emits two done events', async () => {
    const parser = editedParser((events) => [...events, ...events.filter((e) => e.kind === 'done')])

    const checking = fixtureTest(parser, HELLO)

    await expect(checking).rejects.toBeInstanceOf(AssertionError)
    await expect(checking).rejects.toThrow('expected exactly one done event, got 2')
  })

  it('fails when the parser emits no done event', async () => {
    const parser = editedParser((events) => events.filter((e) => e.kind !== 'done'))

    await expect(fixtureTest(parser, HELLO)).rejects.toThrow(
      'expected exactly one done event, got 0',
    )
  })

  it('fails when the done event is not the last event', async () => {
    const parser = editedParser((events) => {
      const done = events.filter((e) => e.kind === 'done')
      return [...done, ...events.filter((e) => e.kind !== 'done')]
    })

    await expect(fixtureTest(parser, HELLO)).rejects.toThrow('done differs from')
  })

  it('fails when the done event differs from done.json', async () => {
    const parser = editedParser((events) =>
      events.map((e) => (e.kind === 'done' ? { ...e, exitCode: null } : e)),
    )

    const checking = fixtureTest(parser, HELLO)

    await expect(checking).rejects.toBeInstanceOf(AssertionError)
    await expect(checking).rejects.toThrow('done differs from')
  })

  it('fails when reply.md ends in a newline the parser reply lacks', async () => {
    const dir = await helloWith({ 'reply.md': 'The README is a single heading.\n' })

    await expect(fixtureTest({ parse: parseFake }, dir)).rejects.toThrow('done differs from')
  })
})

describe('splitting a file into lines', () => {
  it.each([
    ['an empty file', '', []],
    ['a newline-terminated file', 'one\ntwo\n', ['one', 'two']],
    ['a file without a final newline', 'one\ntwo', ['one', 'two']],
    ['a file with a blank line inside', 'one\n\ntwo\n', ['one', '', 'two']],
    ['a file of a single newline', '\n', ['']],
  ])('returns the lines of %s', (_, text, expected) => {
    expect(splitLines(text)).toEqual(expected)
  })
})
