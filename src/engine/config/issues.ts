import type { z } from 'zod'
import { RensaError } from '../errors.js'
import { child, invalid, type Loc } from './loc.js'

/**
 * Turns a failed schema parse into one `CONFIG_INVALID` error: the first
 * issue is the error, the rest ride along as `details`. Each issue keeps
 * zod's wording behind its dotted path, except an unrecognized key, which
 * is reported as a reserved key, one error per key.
 */
export function zodToRensaError(error: z.ZodError, file: string): RensaError {
  const root: Loc = { file, at: '' }
  const [first, ...rest] = error.issues.flatMap((issue) => render(issue, root))
  if (first === undefined) {
    return new RensaError(
      'INTERNAL',
      `${file}: the schema rejected the document without an issue`,
      file,
    )
  }
  return new RensaError(
    first.code,
    first.message,
    first.path,
    first.hint,
    rest.map((e) => e.message),
  )
}

function render(issue: z.core.$ZodIssue, root: Loc): RensaError[] {
  const loc = issue.path.reduce<Loc>(
    (at, key) => child(at, typeof key === 'number' ? key : String(key)),
    root,
  )
  if (issue.code === 'unrecognized_keys') {
    const where = loc.at || 'the top level'
    return issue.keys.map((key) =>
      invalid(child(loc, key), `unknown key \`${key}\` at ${where}; not supported in this version`),
    )
  }
  return [invalid(loc, loc.at ? `${loc.at}: ${issue.message}` : issue.message)]
}
