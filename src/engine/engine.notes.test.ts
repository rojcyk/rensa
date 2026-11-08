import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  dataOf,
  type EngineRepo,
  engineRepo,
  eventMatching,
  finished,
  ofType,
} from '../testing/engine.js'
import { type RunHandle, readTranscript, type TranscriptRecord } from './index.js'

// A note becomes the first record of the transcript of the step it applies
// from (`applies_from`), in the file, the ring buffer and the `transcript`
// stream; later steps get it in their prompt only.

const DEADLINE_MS = 4_000
const NOTE = 'Keep the public API unchanged.'

let env: EngineRepo | undefined

afterEach(async () => {
  await env?.cleanup()
  env = undefined
})

/** Every record the `transcript` stream reports for one step, in order. */
function streamed(
  handle: RunHandle,
  step: string,
): Array<{ label: string; record: TranscriptRecord }> {
  const seen: Array<{ label: string; record: TranscriptRecord }> = []
  handle.attach({
    transcript(m) {
      if (m.step === step) seen.push({ label: m.label, record: m.record })
    },
  })
  return seen
}

async function fileRecords(handle: RunHandle, step: string, label: string) {
  const file = path.join(handle.dir, 'agents', step, label, 'transcript.jsonl')
  return (await readTranscript(file)).records
}

const kindAndText = (r: TranscriptRecord) =>
  r.kind === 'tool' ? { kind: r.kind, name: r.name } : { kind: r.kind, text: r.text }

describe('a note in the transcript of the step it applies from', () => {
  it('is the first record of the agent step’s file, buffer and stream when sent while paused before it', async () => {
    env = await engineRepo(['pause-before-agents'])
    const engine = await env.open()
    const handle = await env.start(engine, 'pause-before-agents')
    await eventMatching(handle, (e) => e.type === 'run.paused')
    const stream = streamed(handle, 'two')

    handle.note(NOTE)
    handle.resume()
    const { result, events } = await finished(handle, DEADLINE_MS)

    const note = { kind: 'note', text: NOTE }
    expect(result.status).toBe('complete')
    expect(ofType(events, 'user.note').map(dataOf)).toEqual([{ text: NOTE, applies_from: 'two' }])
    expect((await fileRecords(handle, 'two', 'fake')).map(kindAndText)).toEqual([
      note,
      { kind: 'text', text: 'Hello, I will look at the README.' },
      { kind: 'tool', name: 'Read' },
      { kind: 'text', text: 'The README is a single heading.' },
    ])
    expect(handle.transcript('two', 'fake').slice(0, 99).map(kindAndText)[0]).toEqual(note)
    expect(stream.map(({ label, record }) => [label, kindAndText(record)])[0]).toEqual([
      'fake',
      note,
    ])
  })

  it('writes no copy to the next step’s transcript while its prompt still lists the note', async () => {
    env = await engineRepo(['pause-before-agents'])
    const engine = await env.open()
    const handle = await env.start(engine, 'pause-before-agents')
    await eventMatching(handle, (e) => e.type === 'run.paused')
    const stream = streamed(handle, 'three')

    handle.note(NOTE)
    handle.resume()
    await finished(handle, DEADLINE_MS)

    const prompt = await readFile(
      path.join(handle.dir, 'agents', 'three', 'fake', 'prompt.md'),
      'utf8',
    )
    const isNote = (r: TranscriptRecord) => r.kind === 'note'
    expect(prompt).toContain(`## User notes\n\n1. ${NOTE}`)
    expect((await fileRecords(handle, 'three', 'fake')).filter(isNote)).toEqual([])
    expect(handle.transcript('three', 'fake').slice(0, 99).filter(isNote)).toEqual([])
    expect(stream.filter(({ record }) => isNote(record))).toEqual([])
  })

  it('is the first record under label shell when the step it applies from is a shell step', async () => {
    env = await engineRepo(['pause-before-shell'])
    const engine = await env.open()
    const handle = await env.start(engine, 'pause-before-shell')
    await eventMatching(handle, (e) => e.type === 'run.paused')
    const stream = streamed(handle, 'check')

    handle.note(NOTE)
    handle.resume()
    const { result, events } = await finished(handle, DEADLINE_MS)

    const note = { kind: 'note', text: NOTE }
    expect(result.status).toBe('complete')
    expect(ofType(events, 'user.note').map(dataOf)).toEqual([{ text: NOTE, applies_from: 'check' }])
    expect((await fileRecords(handle, 'check', 'shell')).map(kindAndText)[0]).toEqual(note)
    expect(handle.transcript('check', 'shell').slice(0, 99).map(kindAndText)[0]).toEqual(note)
    expect(stream.map(({ label, record }) => [label, kindAndText(record)])[0]).toEqual([
      'shell',
      note,
    ])
  })

  it('writes no note record anywhere when the note is sent after the last step started', async () => {
    env = await engineRepo(['read-only'])
    const engine = await env.open()
    vi.stubEnv('RENSA_FAKE_DELAY_MS', '100')
    const handle = await env.start(engine, 'read-only')
    await eventMatching(handle, (e) => e.type === 'agent.spawned' && e.step === 'review')
    const stream = streamed(handle, 'review')

    handle.note(NOTE)
    const { events } = await finished(handle, DEADLINE_MS)

    const isNote = (r: TranscriptRecord) => r.kind === 'note'
    expect(ofType(events, 'user.note').map(dataOf)).toEqual([{ text: NOTE, applies_from: '' }])
    expect((await fileRecords(handle, 'review', 'fake')).filter(isNote)).toEqual([])
    expect(handle.transcript('review', 'fake').slice(0, 99).filter(isNote)).toEqual([])
    expect(stream.filter(({ record }) => isNote(record))).toEqual([])
  })
})
