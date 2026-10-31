import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, assert, beforeEach, describe, expect, it } from 'vitest'
import { type TmpDir, tmpDir } from '../../testing/tmpRepo.js'
import { RensaError } from '../errors.js'
import { createRunDir, type RunDir } from './dir.js'
import { readTranscript, TranscriptWriter } from './transcript.js'
import type { NewTranscriptRecord, TranscriptRecord } from './types.js'

const STEP = 'review'
const LABEL = 'codex'

const TEXT: NewTranscriptRecord = { kind: 'text', text: 'The coupon is applied after tax.' }
const TOOL: NewTranscriptRecord = {
  kind: 'tool',
  name: 'shell',
  input: { command: ['npm', 'test', '--', 'cart'] },
  ok: false,
  output: 'FAIL src/cart.test.ts\n  ✕ applies coupon before tax (12 ms)',
}
const NOTE: NewTranscriptRecord = { kind: 'note', text: 'Focus on the rounding in total().' }

let tmp: TmpDir
let run: RunDir

beforeEach(async () => {
  tmp = await tmpDir('rensa-transcript-')
  run = await createRunDir(path.join(tmp.dir, 'runs'), '2026-10-28_0912_tdd-review_7f3a')
})

afterEach(async () => {
  await tmp.cleanup()
})

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  )
}

describe('lazy agent directory', () => {
  it('creates no agent directory when the writer is constructed and closed without writes', async () => {
    const writer = new TranscriptWriter(run, STEP, LABEL)

    await writer.close()

    expect(await readdir(path.join(run.root, 'agents'))).toEqual([])
  })

  it('creates the agent directory on the first raw line', async () => {
    const writer = new TranscriptWriter(run, STEP, LABEL)
    expect(await exists(run.agentDir(STEP, LABEL))).toBe(false)

    writer.raw('{"type":"thread.started"}')
    await writer.close()

    expect(await readdir(run.agentDir(STEP, LABEL))).toEqual(['raw.jsonl'])
  })

  it('creates the agent directory when the prompt is the first thing written', async () => {
    const writer = new TranscriptWriter(run, STEP, LABEL)

    await writer.prompt('# Review\n\nReview the diff against main.\n')

    expect(await readFile(run.agentFile(STEP, LABEL, 'prompt.md'), 'utf8')).toBe(
      '# Review\n\nReview the diff against main.\n',
    )
  })
})

describe('writing agent files', () => {
  it('appends raw provider lines verbatim and in order', async () => {
    const writer = new TranscriptWriter(run, STEP, LABEL)
    const lines = [
      '{"type":"thread.started","thread_id":"019a2f4e"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"Done."}}',
      'not json: provider printed a warning',
    ]

    for (const line of lines) writer.raw(line)
    await writer.close()

    expect(await readFile(run.agentFile(STEP, LABEL, 'raw.jsonl'), 'utf8')).toBe(
      `${lines.join('\n')}\n`,
    )
  })

  it('returns each record stamped with an ISO time when recorded', () => {
    const writer = new TranscriptWriter(run, STEP, LABEL)

    const stamped = writer.record(TEXT)

    expect(stamped).toEqual({ ...TEXT, t: expect.any(String) })
    expect(new Date(stamped.t).toISOString()).toBe(stamped.t)
  })

  it('writes raw and transcript lines to separate files when both are used before close', async () => {
    const writer = new TranscriptWriter(run, STEP, LABEL)

    writer.raw('{"type":"turn.started"}')
    const record = writer.record(TEXT)
    await writer.close()

    expect(await readFile(run.agentFile(STEP, LABEL, 'raw.jsonl'), 'utf8')).toBe(
      '{"type":"turn.started"}\n',
    )
    expect(await readTranscript(run.agentFile(STEP, LABEL, 'transcript.jsonl'))).toEqual([record])
  })

  it('writes reply.md with the given text', async () => {
    const writer = new TranscriptWriter(run, STEP, LABEL)

    await writer.reply('{"verdict":"fail","issues":["coupon applied after tax"]}\n')

    expect(await readFile(run.agentFile(STEP, LABEL, 'reply.md'), 'utf8')).toBe(
      '{"verdict":"fail","issues":["coupon applied after tax"]}\n',
    )
  })

  it('throws RensaError INTERNAL when a record is written after close', async () => {
    const writer = new TranscriptWriter(run, STEP, LABEL)
    await writer.close()

    let err: unknown
    try {
      writer.record(NOTE)
    } catch (e) {
      err = e
    }

    assert(err instanceof RensaError, `expected RensaError, got ${String(err)}`)
    expect(err.code).toBe('INTERNAL')
  })
})

describe('reading a transcript', () => {
  it('returns the text, tool and note records exactly as recorded', async () => {
    const writer = new TranscriptWriter(run, STEP, LABEL)
    const written = [writer.record(TEXT), writer.record(TOOL), writer.record(NOTE)]
    await writer.close()

    expect(await readTranscript(run.agentFile(STEP, LABEL, 'transcript.jsonl'))).toEqual(written)
  })

  it('skips lines that are not records, including a final line still being written', async () => {
    const file = path.join(tmp.dir, 'transcript.jsonl')
    const record: TranscriptRecord = {
      t: '2026-10-28T09:13:22.051Z',
      kind: 'text',
      text: 'Looking at src/cart.ts.',
    }
    await writeFile(
      file,
      [
        JSON.stringify(record),
        'garbage',
        JSON.stringify({ t: '2026-10-28T09:13:23.000Z', text: 'no kind' }),
        JSON.stringify({ kind: 'text', text: 'no time' }),
        JSON.stringify([record]),
        '{"t":"2026-10-28T09:13:24.',
      ].join('\n'),
    )

    expect(await readTranscript(file)).toEqual([record])
  })
})
