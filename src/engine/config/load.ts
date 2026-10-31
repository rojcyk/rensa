import { readFile } from 'node:fs/promises'
import { parse, YAMLParseError } from 'yaml'
import type { z } from 'zod'
import { RensaError } from '../errors.js'
import { zodToRensaError } from './issues.js'
import { describe, isMapping } from './types.js'

/**
 * Parses one YAML file and checks it against `schema`. The result has the
 * schema's shape and nothing more: `resolve.ts` and `validate.ts` apply
 * the rules that need context beyond the document itself.
 */
export async function loadYaml<T>(file: string, schema: z.ZodType<T>): Promise<T> {
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
  return parseRaw(schema, doc, file)
}

/**
 * Checks a parsed document against its schema. A failure is a
 * `CONFIG_INVALID` error naming `file` and the dotted path of the problem.
 */
export function parseRaw<T>(schema: z.ZodType<T>, doc: unknown, file: string): T {
  const result = schema.safeParse(doc)
  if (!result.success) throw zodToRensaError(result.error, file)
  return result.data
}
