import { randomBytes } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import type { InputKind, ResolvedChain } from '../config/types.js'
import { RensaError } from '../errors.js'
import { isRecord } from './jsonl.js'
import type { RunStatus, StepStatus } from './types.js'

/**
 * A run's summary, written once at start and once at the end. `steps` is
 * a cache: where it disagrees with `events.jsonl`, the event log wins.
 */
export interface RunJson {
  id: string
  chain: ResolvedChain
  input: { kind: InputKind; text?: string; path?: string }
  base: { ref: string; sha: string }
  started_at: string
  finished_at?: string
  status?: RunStatus
  /** Named agent → session id. */
  sessions: Record<string, string>
  steps: Record<string, { status?: StepStatus; agents: Record<string, StepStatus | undefined> }>
}

/** Atomic: writes a temp file next to `file`, then renames it over. */
export async function writeRunJson(file: string, r: RunJson): Promise<void> {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(tmp, `${JSON.stringify(r, null, 2)}\n`)
    await rename(tmp, file)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}

export async function readRunJson(file: string): Promise<RunJson> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'))
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new RensaError('INTERNAL', `${file} is not valid JSON: ${err.message}`, file)
    }
    throw err
  }
  if (!isRecord(parsed) || typeof parsed.id !== 'string' || !isRecord(parsed.chain)) {
    throw new RensaError('INTERNAL', `${file} is not a run.json`, file)
  }
  // Shape spot-checked above; the rest is trusted as rensa's own output.
  return parsed as unknown as RunJson
}
