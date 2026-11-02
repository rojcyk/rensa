// The only way engine code reports anything to the user. Nothing under
// src/engine/ writes to stdout, stderr or the console: the TUI repaints
// with a cursor-relative writer, and one foreign line misaligns its frame.
// Entries are buffered and handed to listeners; the frontend decides
// where they go and whether to show them at all.

export interface DiagEntry {
  /** ISO 8601. */
  t: string
  scope: string
  message: string
}

const CAPACITY = 200

let buffer: DiagEntry[] = []
const listeners = new Set<(entry: DiagEntry) => void>()

/**
 * Records a diagnostic. Cheap and unconditional; gating is the frontend's.
 * Never throws: callers sit on paths such as a timeout that must still
 * resolve afterwards, so a listener's error is recorded, not raised.
 */
export function diag(scope: string, message: string): void {
  const entry = record(scope, message)
  for (const fn of listeners) {
    try {
      fn(entry)
    } catch (err) {
      // Buffered only: notifying listeners again could re-enter the one that threw.
      const why = err instanceof Error ? err.message : String(err)
      record('diag', `listener threw on a ${scope} entry: ${why}`)
    }
  }
}

function record(scope: string, message: string): DiagEntry {
  const entry: DiagEntry = { t: new Date().toISOString(), scope, message }
  buffer.push(entry)
  if (buffer.length > CAPACITY) buffer.shift()
  return entry
}

/** Calls `fn` for every later entry. Returns a function that removes it. */
export function onDiag(fn: (entry: DiagEntry) => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Returns the buffered entries, oldest first, and empties the buffer. */
export function drainDiag(): ReadonlyArray<DiagEntry> {
  const entries = buffer
  buffer = []
  return entries
}
