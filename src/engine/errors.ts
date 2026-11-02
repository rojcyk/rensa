export type RensaErrorCode =
  | 'NOT_A_REPO'
  | 'CONFIG_PARSE'
  | 'CONFIG_INVALID'
  | 'CHAIN_NOT_FOUND'
  | 'PROVIDER_UNAVAILABLE'
  | 'DIRTY_TREE'
  | 'LOCKED'
  | 'INPUT_REQUIRED'
  | 'TEMPLATE'
  | 'PROCESS'
  | 'STORAGE'
  | 'INTERNAL'

export class RensaError extends Error {
  constructor(
    public readonly code: RensaErrorCode,
    message: string,
    /** File or dotted config path the error points at. */
    public readonly path?: string,
    /** One-line remedy, e.g. "run: claude auth login". */
    public readonly hint?: string,
    /** Further errors found alongside this one, as messages. */
    public readonly details?: string[],
  ) {
    super(message)
    this.name = 'RensaError'
  }
}
