import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { lineReader } from './lines.js'

/** Feeds `chunks` to a lineReader and collects every emitted line. */
async function readLines(chunks: Array<string | Buffer>): Promise<string[]> {
  const stream = new PassThrough()
  const lines: string[] = []
  const done = lineReader(stream, (line) => lines.push(line))
  for (const chunk of chunks) stream.write(chunk)
  stream.end()
  await done
  return lines
}

describe('splitting into lines', () => {
  it('reassembles lines when chunks split them mid-line', async () => {
    expect(await readLines(['Compil', 'ing src/cart.ts\nTes', 'ts passed\n'])).toEqual([
      'Compiling src/cart.ts',
      'Tests passed',
    ])
  })

  it('emits the final line at end when it has no trailing newline', async () => {
    expect(await readLines(['first\nsecond'])).toEqual(['first', 'second'])
  })

  it('emits no extra empty line when the input ends with a newline', async () => {
    expect(await readLines(['first\n'])).toEqual(['first'])
  })

  it('keeps empty lines when the input holds consecutive newlines', async () => {
    expect(await readLines(['one\n\n', '\ntwo\n'])).toEqual(['one', '', '', 'two'])
  })

  it('emits nothing when the stream ends without data', async () => {
    expect(await readLines([])).toEqual([])
  })
})

describe('carriage returns', () => {
  it('strips the \\r of a \\r\\n ending even when the \\n arrives in the next chunk', async () => {
    expect(await readLines(['dos line\r', '\nnext\r\n'])).toEqual(['dos line', 'next'])
  })

  it('keeps a \\r inside a line when only the trailing one is stripped', async () => {
    expect(await readLines(['progress 10%\rprogress 90%\r\n'])).toEqual([
      'progress 10%\rprogress 90%',
    ])
  })

  it('strips a trailing \\r from the final unterminated line', async () => {
    expect(await readLines(['last\r'])).toEqual(['last'])
  })
})

describe('UTF-8 across chunk boundaries', () => {
  it('decodes a two-byte character split between chunks', async () => {
    const bytes = Buffer.from('café\n')
    const split = bytes.indexOf(0xa9) // second byte of é

    expect(await readLines([bytes.subarray(0, split), bytes.subarray(split)])).toEqual(['café'])
  })

  it('decodes a four-byte character split across three chunks', async () => {
    const bytes = Buffer.from('ship 🚀 now\n')
    const start = bytes.indexOf(0xf0)

    const chunks = [
      bytes.subarray(0, start + 1),
      bytes.subarray(start + 1, start + 3),
      bytes.subarray(start + 3),
    ]

    expect(await readLines(chunks)).toEqual(['ship 🚀 now'])
  })

  it('decodes a character split right before the end when the last line is unterminated', async () => {
    const bytes = Buffer.from('日本')

    expect(await readLines([bytes.subarray(0, 4), bytes.subarray(4)])).toEqual(['日本'])
  })
})

describe('stream termination', () => {
  it('resolves without emitting the partial line when the stream is destroyed before its end', async () => {
    const stream = new PassThrough()
    const lines: string[] = []
    const done = lineReader(stream, (line) => lines.push(line))
    stream.write('complete\npartial')
    await new Promise((resolve) => setImmediate(resolve))

    stream.destroy()
    await done

    expect(lines).toEqual(['complete'])
  })

  it('rejects with the stream error when the stream fails', async () => {
    const stream = new PassThrough()
    const done = lineReader(stream, () => {})

    stream.destroy(new Error('read EIO'))

    await expect(done).rejects.toThrow('read EIO')
  })
})
