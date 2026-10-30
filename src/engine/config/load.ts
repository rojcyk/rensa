import { readFile } from 'node:fs/promises'
import { parse, YAMLParseError } from 'yaml'
import { RensaError } from '../errors.js'

/**
 * Parses one YAML file whose top level must be a mapping. The result is
 * unchecked beyond that: `T` is the raw shape the caller expects, and
 * `validate.ts` checks it against that shape before anything trusts it.
 */
export async function loadYaml<T>(file: string): Promise<T> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    throw new RensaError('CONFIG_PARSE', `cannot read ${file}: ${code ?? String(err)}`, file)
  }
  let doc: unknown
  try {
    doc = parse(text)
  } catch (err) {
    if (!(err instanceof YAMLParseError)) throw err
    const pos = err.linePos?.[0]
    const where = pos ? `:${pos.line}:${pos.col}` : ''
    const reason = err.message.split('\n')[0]
    throw new RensaError('CONFIG_PARSE', `${file}${where}: ${reason}`, file)
  }
  if (!isMapping(doc)) {
    throw new RensaError(
      'CONFIG_INVALID',
      `${file}: expected a mapping at the top level, got ${describe(doc)}`,
      file,
    )
  }
  // Boundary cast: the shape is checked by validate.ts before use.
  return doc as T
}

export function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function describe(value: unknown): string {
  if (value === null || value === undefined) return 'nothing'
  if (Array.isArray(value)) return 'a list'
  return `a ${typeof value === 'object' ? 'mapping' : typeof value}`
}
