import { StringDecoder } from 'node:string_decoder'

/**
 * Calls `onLine` for each `\n`-terminated line of `stream`, without the
 * newline or a trailing `\r`, then for the final unterminated line at
 * end. UTF-8 characters split across chunks are reassembled. Resolves
 * when the stream ends; a stream destroyed before its end resolves on
 * close without emitting its partial line.
 */
export function lineReader(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8')
    let partial = ''
    const emitLine = (line: string) => onLine(line.endsWith('\r') ? line.slice(0, -1) : line)
    const take = (text: string) => {
      if (!text.includes('\n')) {
        partial += text
        return
      }
      const lines = (partial + text).split('\n')
      partial = lines.pop() ?? ''
      for (const line of lines) emitLine(line)
    }
    stream.on('data', (chunk: Buffer | string) => {
      take(typeof chunk === 'string' ? chunk : decoder.write(chunk))
    })
    stream.once('end', () => {
      take(decoder.end())
      if (partial !== '') emitLine(partial)
      partial = ''
      resolve()
    })
    stream.once('close', () => resolve())
    stream.once('error', reject)
  })
}
