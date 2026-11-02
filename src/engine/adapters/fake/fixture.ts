import { deepStrictEqual } from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { PROVIDERS } from '../../config/types.js'
import { RensaError } from '../../errors.js'
import { isRecord } from '../../run/jsonl.js'
import { type TranscriptRecord, TranscriptRecordSchema } from '../../run/types.js'
import { type AgentEvent, type DoneEvent, DoneEventSchema, type Parser } from '../types.js'

// A fixture is a directory holding a provider's captured stdout and the
// output its parser must produce from it:
//
//   meta.json          where and how it was captured
//   raw.jsonl          the provider's stdout, one line per line
//   transcript.jsonl   the expected normalized records
//   reply.md           the expected final reply
//   done.json          the parser's expected `done` minus `kind` and `reply`
//
// Fixtures pin `parse`, not `spawn`, so `done.json` holds the parser's
// provisional `done` (see `Parser`), not the one `spawn` reconciles with
// the process: its `exitCode` is usually null.

const MetaSchema = z
  .object({
    provider: z.enum(PROVIDERS),
    /** YYYY-MM-DD. */
    captured: z.string(),
    /** The command line that produced `raw.jsonl`; absent for hand-written fixtures. */
    argv: z.array(z.string()).optional(),
    note: z.string().optional(),
  })
  .strict()
export type FixtureMeta = z.infer<typeof MetaSchema>

const DoneFileSchema = DoneEventSchema.omit({ kind: true, reply: true }).strict()

export interface Fixture {
  dir: string
  meta: FixtureMeta
  /** `raw.jsonl` split into lines, without the final newline's empty line. */
  raw: string[]
  transcript: TranscriptRecord[]
  reply: string
  done: DoneEvent
}

/** Reads and checks a fixture directory; throws on the first file that does not fit. */
export async function loadFixture(dir: string): Promise<Fixture> {
  const file = (name: string) => path.join(dir, name)
  const read = (name: string) => readFile(file(name), 'utf8')
  const [metaText, rawText, transcriptText, reply, doneText] = await Promise.all([
    read('meta.json'),
    read('raw.jsonl'),
    read('transcript.jsonl'),
    read('reply.md'),
    read('done.json'),
  ])
  const done = parseJson(doneText, DoneFileSchema, file('done.json'))
  return {
    dir,
    meta: parseJson(metaText, MetaSchema, file('meta.json')),
    raw: splitLines(rawText),
    transcript: parseTranscript(transcriptText, file('transcript.jsonl')),
    reply,
    done: { kind: 'done', reply, ...done },
  }
}

/**
 * Feeds a fixture's `raw.jsonl` through `parse` and asserts that the raw
 * lines come back unchanged, the records match `transcript.jsonl` (each
 * stamped with the fixture's `t`, which a parser does not produce), and
 * exactly one `done`, last, matches `reply.md` and `done.json`. Throws an
 * `AssertionError` with a diff on the first mismatch.
 */
export async function fixtureTest(adapter: { parse: Parser }, dir: string): Promise<void> {
  const fixture = await loadFixture(dir)
  const events: AgentEvent[] = []
  for await (const event of adapter.parse(fromArray(fixture.raw))) events.push(event)

  const raw = events.flatMap((e) => (e.kind === 'raw' ? [e.line] : []))
  deepStrictEqual(raw, fixture.raw, `raw lines differ from ${dir}/raw.jsonl`)

  const records = events.filter((e) => e.kind === 'text' || e.kind === 'tool' || e.kind === 'note')
  const stamped = records.map((record, i) => ({
    t: fixture.transcript[i]?.t ?? '(no such line in fixture)',
    ...record,
  }))
  deepStrictEqual(stamped, fixture.transcript, `records differ from ${dir}/transcript.jsonl`)

  const dones = events.filter((e) => e.kind === 'done')
  deepStrictEqual(dones.length, 1, `expected exactly one done event, got ${dones.length}`)
  deepStrictEqual(events.at(-1), fixture.done, `done differs from ${dir}/reply.md + done.json`)
}

function parseJson<T>(text: string, schema: z.ZodType<T>, file: string): T {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new RensaError('INTERNAL', `fixture ${file}: not valid JSON`, file)
  }
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new RensaError('INTERNAL', `fixture ${file}: ${z.prettifyError(parsed.error)}`, file)
  }
  return parsed.data
}

function parseTranscript(text: string, file: string): TranscriptRecord[] {
  return splitLines(text).map((line, i) => {
    const where = `fixture ${file} line ${i + 1}`
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      throw new RensaError('INTERNAL', `${where}: not valid JSON`, file)
    }
    const parsed = TranscriptRecordSchema.safeParse(value)
    if (!parsed.success) {
      const kind = isRecord(value) ? ` (kind ${JSON.stringify(value.kind)})` : ''
      throw new RensaError(
        'INTERNAL',
        `${where}${kind} is not a transcript record: ${z.prettifyError(parsed.error)}`,
        file,
      )
    }
    return parsed.data
  })
}

/** Lines of a newline-terminated file; an empty file has none. */
export function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

async function* fromArray(lines: readonly string[]): AsyncGenerator<string> {
  yield* lines
}
