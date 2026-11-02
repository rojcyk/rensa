import { appendFile, mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest'
import { type TmpDir, tmpDir } from '../../testing/tmpRepo.js'
import { RensaError } from '../errors.js'
import { AppendQueue, inLineOrder, isRecord, parseJsonLines } from './jsonl.js'

// appendFile calls through to the real one, so every case behaves as with
// the unmocked module; the batching cases count its calls, and the
// write-gate helpers below hold or fail one call at a time.
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, appendFile: vi.fn(fs.appendFile) }
})
const { appendFile: realAppendFile } =
  await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const appendFileSpy = vi.mocked(appendFile)

let tmp: TmpDir

beforeEach(async () => {
  tmp = await tmpDir('rensa-jsonl-')
})

afterEach(async () => {
  await tmp.cleanup()
})

describe('appending lines through the queue', () => {
  it('writes every pushed line in push order with a trailing newline when flushed', async () => {
    const file = path.join(tmp.dir, 'raw.jsonl')
    const queue = new AppendQueue(file)
    const lines = Array.from({ length: 200 }, (_, i) => `{"type":"delta","n":${i}}`)

    for (const line of lines) queue.push(line)
    await queue.flush()

    expect(await readFile(file, 'utf8')).toBe(`${lines.join('\n')}\n`)
  })

  it('writes lines pushed after an earlier flush has resolved', async () => {
    const file = path.join(tmp.dir, 'raw.jsonl')
    const queue = new AppendQueue(file)
    queue.push('{"type":"start"}')
    await queue.flush()

    queue.push('{"type":"end"}')
    await queue.flush()

    expect(await readFile(file, 'utf8')).toBe('{"type":"start"}\n{"type":"end"}\n')
  })

  it('runs prepare before the first write when the target directory does not exist yet', async () => {
    const agentDir = path.join(tmp.dir, 'agents', 'review', 'codex')
    const file = path.join(agentDir, 'raw.jsonl')
    const queue = new AppendQueue(file, async () => {
      await mkdir(agentDir, { recursive: true })
    })

    queue.push('{"type":"start"}')
    await queue.flush()

    expect(await readFile(file, 'utf8')).toBe('{"type":"start"}\n')
  })

  it('resolves flush immediately when nothing was ever pushed, creating no file', async () => {
    const file = path.join(tmp.dir, 'raw.jsonl')
    const queue = new AppendQueue(file)

    await queue.flush()

    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('write failures', () => {
  it('rejects flush with the write error when the target directory is missing', async () => {
    const queue = new AppendQueue(path.join(tmp.dir, 'missing', 'raw.jsonl'))

    queue.push('{"type":"start"}')

    await expect(queue.flush()).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('drops lines pushed after a failed write even once the file is writable again', async () => {
    const dir = path.join(tmp.dir, 'agents')
    const file = path.join(dir, 'raw.jsonl')
    await mkdir(dir)
    const queue = new AppendQueue(file)
    queue.push('{"n":1}')
    await queue.flush()
    await rm(dir, { recursive: true })
    queue.push('{"n":2}')
    await expect(queue.flush()).rejects.toMatchObject({ code: 'ENOENT' })
    await mkdir(dir)

    queue.push('{"n":3}')

    // Writing n=3 after the gap would leave a file that reads as complete.
    await expect(queue.flush()).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects close with the write error when an earlier write failed', async () => {
    const queue = new AppendQueue(path.join(tmp.dir, 'missing', 'raw.jsonl'))
    queue.push('{"type":"start"}')

    await expect(queue.close()).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects flush with the prepare error and writes nothing when prepare fails', async () => {
    const file = path.join(tmp.dir, 'raw.jsonl')
    const queue = new AppendQueue(file, async () => {
      throw new Error('EACCES: permission denied, mkdir')
    })

    queue.push('{"type":"start"}')

    await expect(queue.flush()).rejects.toThrow('EACCES: permission denied, mkdir')
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('closing the queue', () => {
  it('writes lines still pending when close is called before they drain', async () => {
    const file = path.join(tmp.dir, 'raw.jsonl')
    const queue = new AppendQueue(file)
    queue.push('{"n":1}')
    queue.push('{"n":2}')

    await queue.close()

    expect(await readFile(file, 'utf8')).toBe('{"n":1}\n{"n":2}\n')
  })

  it('throws RensaError INTERNAL when a line is pushed after close', async () => {
    const file = path.join(tmp.dir, 'raw.jsonl')
    const queue = new AppendQueue(file)
    await queue.close()

    let err: unknown
    try {
      queue.push('{"n":1}')
    } catch (e) {
      err = e
    }

    assert(err instanceof RensaError, `expected RensaError, got ${String(err)}`)
    expect(err.code).toBe('INTERNAL')
    expect(err.message).toBe(`write to closed file ${file}`)
  })
})

describe('parsing newline-delimited JSON', () => {
  it('returns each value with its 1-based line number and skips blank lines', () => {
    const text = '{"seq":1}\n\n   \n{"seq":2}\n'

    expect(parseJsonLines(text)).toEqual({
      values: [
        { line: 1, value: { seq: 1 } },
        { line: 4, value: { seq: 2 } },
      ],
      warnings: [],
    })
  })

  it('warns not valid JSON for a garbage line in the middle and keeps the lines around it', () => {
    const text = '{"seq":1}\nrensa crashed here\n{"seq":2}\n'

    expect(parseJsonLines(text)).toEqual({
      values: [
        { line: 1, value: { seq: 1 } },
        { line: 3, value: { seq: 2 } },
      ],
      warnings: ['line 2: not valid JSON'],
    })
  })

  it('warns truncated final line when the last line has no newline and does not parse', () => {
    const text = '{"seq":1}\n{"seq":2,"t":"2026-10-'

    expect(parseJsonLines(text)).toEqual({
      values: [{ line: 1, value: { seq: 1 } }],
      warnings: ['line 2: truncated final line'],
    })
  })

  it('keeps a complete last value when only its trailing newline is missing', () => {
    const text = '{"seq":1}\n{"seq":2}'

    expect(parseJsonLines(text).values).toEqual([
      { line: 1, value: { seq: 1 } },
      { line: 2, value: { seq: 2 } },
    ])
  })

  it('calls an unparsable last line not valid JSON when it does end with a newline', () => {
    const text = '{"seq":1}\n{"seq":2,\n'

    expect(parseJsonLines(text).warnings).toEqual(['line 2: not valid JSON'])
  })

  it('returns no values and no warnings for an empty file', () => {
    expect(parseJsonLines('')).toEqual({ values: [], warnings: [] })
  })
})

describe('ordering warnings', () => {
  it('sorts warnings by their line number when two sources contributed out of order', () => {
    const warnings = [
      'line 2: not valid JSON',
      'line 10: truncated final line',
      'line 3: not an event',
    ]

    expect(inLineOrder(warnings)).toEqual([
      'line 2: not valid JSON',
      'line 3: not an event',
      'line 10: truncated final line',
    ])
  })
})

describe('recognising a JSON object', () => {
  it.each<[string, boolean, unknown]>([
    ['an object', true, { kind: 'text' }],
    ['an empty object', true, {}],
    ['null', false, null],
    ['an array', false, [{ kind: 'text' }]],
    ['a string', false, 'text'],
    ['a number', false, 42],
  ])('treats %s as a record: %s', (_, expected, value) => {
    expect(isRecord(value)).toBe(expected)
  })
})

/** The text of every appendFile call so far, in call order. */
function writes(): string[] {
  return appendFileSpy.mock.calls.map(([, data]) => String(data))
}

/**
 * Holds the next appendFile call until `release()`; it then writes for
 * real, or rejects with `failWith` when one is given. `started` resolves
 * once the call is in flight.
 */
function holdNextWrite(failWith?: Error): { started: Promise<void>; release: () => void } {
  let markStarted = () => {}
  let release = () => {}
  const started = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  appendFileSpy.mockImplementationOnce(async (...args) => {
    markStarted()
    await released
    if (failWith) throw failWith
    return realAppendFile(...args)
  })
  return { started, release }
}

function diskFull(): Error {
  return Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
}

describe('batching lines into writes', () => {
  beforeEach(() => {
    appendFileSpy.mockClear()
  })

  afterEach(() => {
    // Drops any held or failing write a failed case left unconsumed.
    appendFileSpy.mockReset()
    appendFileSpy.mockImplementation(realAppendFile)
  })

  it('writes a synchronous burst of 10,000 lines in at most two writes', async () => {
    const file = path.join(tmp.dir, 'output.txt')
    const queue = new AppendQueue(file)
    const lines = Array.from({ length: 10_000 }, (_, i) => `{"type":"delta","seq":${i}}`)

    for (const line of lines) queue.push(line)
    await queue.flush()

    expect(writes().length).toBeLessThanOrEqual(2)
    expect(await readFile(file, 'utf8')).toBe(`${lines.join('\n')}\n`)
  })

  it('sends every line pushed during an in-flight write together in the next write, in push order', async () => {
    const file = path.join(tmp.dir, 'output.txt')
    const queue = new AppendQueue(file)
    const first = holdNextWrite()
    queue.push('{"seq":1}')
    queue.push('{"seq":2}')
    await first.started

    queue.push('{"seq":3}')
    await Promise.resolve()
    queue.push('{"seq":4}')
    queue.push('{"seq":5}')
    first.release()
    await queue.flush()

    expect(writes()).toEqual(['{"seq":1}\n{"seq":2}\n', '{"seq":3}\n{"seq":4}\n{"seq":5}\n'])
    expect(await readFile(file, 'utf8')).toBe(
      '{"seq":1}\n{"seq":2}\n{"seq":3}\n{"seq":4}\n{"seq":5}\n',
    )
  })

  it('keeps push order with no line lost or repeated when pushes interleave with several writes', async () => {
    const file = path.join(tmp.dir, 'output.txt')
    const queue = new AppendQueue(file)
    const lines = Array.from({ length: 600 }, (_, i) => `{"type":"delta","seq":${i}}`)

    for (const [i, line] of lines.entries()) {
      queue.push(line)
      // Yield to the event loop now and then, so writes complete between pushes.
      if (i % 100 === 99) await new Promise((resolve) => setImmediate(resolve))
    }
    await queue.flush()

    expect(writes().length).toBeGreaterThan(1)
    expect(await readFile(file, 'utf8')).toBe(`${lines.join('\n')}\n`)
  })

  it('drops the failed batch and the lines pushed during it but keeps earlier batches when a batched write fails', async () => {
    const file = path.join(tmp.dir, 'output.txt')
    const queue = new AppendQueue(file)
    const first = holdNextWrite()
    const second = holdNextWrite(diskFull())
    queue.push('{"seq":1}')
    await first.started
    queue.push('{"seq":2}')
    queue.push('{"seq":3}')
    first.release()
    await second.started

    queue.push('{"seq":4}')
    second.release()

    await expect(queue.flush()).rejects.toMatchObject({ code: 'ENOSPC' })
    expect(writes()).toEqual(['{"seq":1}\n', '{"seq":2}\n{"seq":3}\n'])
    expect(await readFile(file, 'utf8')).toBe('{"seq":1}\n')
  })

  it('rejects close with the batch error and writes nothing more when lines arrive after the failure', async () => {
    const file = path.join(tmp.dir, 'output.txt')
    const queue = new AppendQueue(file)
    const failing = holdNextWrite(diskFull())
    queue.push('{"seq":1}')
    queue.push('{"seq":2}')
    await failing.started
    failing.release()
    await expect(queue.flush()).rejects.toMatchObject({ code: 'ENOSPC' })

    queue.push('{"seq":3}')

    await expect(queue.close()).rejects.toMatchObject({ code: 'ENOSPC' })
    expect(writes()).toEqual(['{"seq":1}\n{"seq":2}\n'])
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
