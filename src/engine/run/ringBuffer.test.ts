import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type EngineRepo, engineRepo, finished } from '../../testing/engine.js'
import { type RunHandle, readTranscript, type TranscriptRecord } from '../index.js'
import { RingBuffer } from './ringBuffer.js'

describe('a ring buffer within capacity', () => {
  it('returns every pushed item by its absolute index when fewer items than capacity were pushed', () => {
    const buffer = new RingBuffer<string>(5)
    buffer.push('Reading README.md')
    buffer.push('Running npm test')
    buffer.push('All 42 tests pass')

    expect({
      start: buffer.start,
      length: buffer.length,
      items: [buffer.get(0), buffer.get(1), buffer.get(2)],
    }).toEqual({
      start: 0,
      length: 3,
      items: ['Reading README.md', 'Running npm test', 'All 42 tests pass'],
    })
  })

  it('returns the half-open range oldest first when sliced inside the pushed range', () => {
    const buffer = new RingBuffer<number>(10)
    for (let i = 0; i < 6; i++) buffer.push(i * 100)

    expect(buffer.slice(1, 4)).toEqual([100, 200, 300])
  })

  it('clamps the slice to the pushed range when the bounds reach past either end', () => {
    const buffer = new RingBuffer<number>(10)
    for (let i = 0; i < 4; i++) buffer.push(i)

    expect(buffer.slice(-5, 50)).toEqual([0, 1, 2, 3])
  })

  it('returns undefined for an index not yet pushed', () => {
    const buffer = new RingBuffer<string>(4)
    buffer.push('first line')

    expect([buffer.get(1), buffer.get(-1)]).toEqual([undefined, undefined])
  })

  it('reports length 0 and start 0 and an empty slice when nothing was pushed', () => {
    const buffer = new RingBuffer<string>(4)

    expect({ start: buffer.start, length: buffer.length, slice: buffer.slice(0, 10) }).toEqual({
      start: 0,
      length: 0,
      slice: [],
    })
  })

  it('throws a RangeError when the capacity is not a positive integer', () => {
    expect(() => new RingBuffer<string>(0)).toThrow(RangeError)
  })
})

describe('a ring buffer past capacity', () => {
  const CAPACITY = 5

  function filled(count: number): RingBuffer<string> {
    const buffer = new RingBuffer<string>(CAPACITY)
    for (let i = 0; i < count; i++) buffer.push(`record-${i}`)
    return buffer
  }

  it('keeps counting length and moves start when capacity + 3 items were pushed', () => {
    const buffer = filled(CAPACITY + 3)

    expect({ start: buffer.start, length: buffer.length }).toEqual({
      start: 3,
      length: CAPACITY + 3,
    })
  })

  it('returns undefined for an evicted index and the fourth item at index 3 when capacity + 3 items were pushed', () => {
    const buffer = filled(CAPACITY + 3)

    expect([buffer.get(2), buffer.get(3)]).toEqual([undefined, 'record-3'])
  })

  it('returns the newest item at length - 1 when capacity + 3 items were pushed', () => {
    const buffer = filled(CAPACITY + 3)

    expect(buffer.get(buffer.length - 1)).toBe(`record-${CAPACITY + 2}`)
  })

  it('omits evicted indices from a slice that starts before start', () => {
    const buffer = filled(CAPACITY + 3)

    expect(buffer.slice(0, buffer.length)).toEqual([
      'record-3',
      'record-4',
      'record-5',
      'record-6',
      'record-7',
    ])
  })
})

describe('engine-owned transcript buffers on a run handle', () => {
  let env: EngineRepo | undefined

  afterEach(async () => {
    await env?.cleanup()
    env = undefined
  })

  async function startThreeStep(): Promise<RunHandle> {
    env = await engineRepo(['three-step'])
    const engine = await env.open()
    return env.start(engine, 'three-step')
  }

  it('holds exactly the records readTranscript returns, in order, when the fake-provider run finished', async () => {
    const handle = await startThreeStep()
    await finished(handle)

    const onDisk = await readTranscript(
      path.join(handle.dir, 'agents', 'review', 'fake', 'transcript.jsonl'),
    )
    const buffer = handle.transcript('review', 'fake')
    expect(buffer.slice(buffer.start, buffer.length)).toEqual(onDisk.records)
  })

  it('already holds the record when the matching transcript listener runs', async () => {
    const handle = await startThreeStep()
    const observed: Array<{ newest: TranscriptRecord | undefined; record: TranscriptRecord }> = []
    handle.attach({
      transcript: ({ step, label, record }) => {
        const buffer = handle.transcript(step, label)
        observed.push({ newest: buffer.get(buffer.length - 1), record })
      },
    })

    await finished(handle)

    // Two shell lines and the fake `hello` fixture's three records.
    expect(observed).toHaveLength(5)
    expect(observed.filter((o) => o.newest !== o.record)).toEqual([])
  })

  it('reports the deltas received so far in partial when a delta listener runs, and undefined when the next transcript listener runs', async () => {
    const handle = await startThreeStep()
    const seen: Array<{ on: 'delta' | 'transcript'; partial: string | undefined }> = []
    handle.attach({
      delta: ({ step, label }) => {
        seen.push({ on: 'delta', partial: handle.partial(step, label) })
      },
      transcript: ({ step, label }) => {
        if (label !== 'fake') return
        seen.push({ on: 'transcript', partial: handle.partial(step, label) })
      },
    })

    await finished(handle)

    // The fake `hello` fixture: two deltas, the text record, a tool record,
    // one delta, the text record.
    expect(seen).toEqual([
      { on: 'delta', partial: 'Hello' },
      { on: 'delta', partial: 'Hello, I will look at the README.' },
      { on: 'transcript', partial: undefined },
      { on: 'transcript', partial: undefined },
      { on: 'delta', partial: 'The README is a single heading.' },
      { on: 'transcript', partial: undefined },
    ])
  })

  it('leaves no partial behind when the agent has finished', async () => {
    const handle = await startThreeStep()
    await finished(handle)

    expect(handle.partial('review', 'fake')).toBeUndefined()
  })

  it('delivers a shell step line as a transcript record under label shell and never as a delta', async () => {
    const handle = await startThreeStep()
    const deltaKeys: string[] = []
    const shellRecords: Array<{ step: string; record: TranscriptRecord }> = []
    handle.attach({
      delta: ({ step, label }) => deltaKeys.push(`${step}/${label}`),
      transcript: ({ step, label, record }) => {
        if (label === 'shell') shellRecords.push({ step, record })
      },
    })

    await finished(handle)

    expect({
      deltaKeys,
      shellRecords,
      baselineBuffer: handle.transcript('baseline', 'shell').slice(0, 10),
    }).toEqual({
      deltaKeys: ['review/fake', 'review/fake', 'review/fake'],
      shellRecords: [
        { step: 'baseline', record: { kind: 'text', text: 'baseline-ok', t: expect.any(String) } },
        { step: 'wrap-up', record: { kind: 'text', text: 'wrap-up-ok', t: expect.any(String) } },
      ],
      baselineBuffer: [{ kind: 'text', text: 'baseline-ok', t: expect.any(String) }],
    })
  })

  it('returns the same buffer for the same key on every call', async () => {
    const handle = await startThreeStep()
    await finished(handle)

    expect(handle.transcript('review', 'fake')).toBe(handle.transcript('review', 'fake'))
  })
})
