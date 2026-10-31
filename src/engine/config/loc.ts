import { RensaError } from '../errors.js'

/** Where in which file a config value sits. `at` is a dotted path. */
export interface Loc {
  file: string
  at: string
}

/** A `CONFIG_INVALID` error whose `path` is the dotted config path. */
export function invalid(loc: Loc, message: string): RensaError {
  return new RensaError('CONFIG_INVALID', `${loc.file}: ${message}`, loc.at)
}

export function child(loc: Loc, key: string | number): Loc {
  if (typeof key === 'number') return { file: loc.file, at: `${loc.at}[${key}]` }
  return { file: loc.file, at: loc.at ? `${loc.at}.${key}` : key }
}
