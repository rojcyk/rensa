import { EFFORT } from '../../config/effort.js'
import type { Tools } from '../../config/types.js'
import { RensaError } from '../../errors.js'
import type { SpawnRequest } from '../types.js'

// Flags verified against codex-cli 0.166.0 (`codex --help`,
// `codex exec --help`, `codex exec resume --help`, and real runs) on
// 2026-11-08.
//
// - No `--skip-git-repo-check`: 0.166.0 runs in a repository's
//   subdirectory without it, and runs always execute in a checkout.
// - No `--full-auto`: 0.166.0 removed it (`unexpected argument`). `exec`
//   never asks for approval, so `--sandbox workspace-write` alone lets an
//   agent edit files and run commands inside the checkout.
// - Never `--ephemeral`: sessions must persist on disk for resume.
// - `exec resume` takes neither `--cd` nor `--sandbox`; every option goes
//   before the `resume` subcommand, where 0.166.0 applies it to the
//   resumed session too (checked for the sandbox, model and effort).

/**
 * Bytes the persona may take as one argv string. Linux caps a single
 * argument at 128 KiB (MAX_ARG_STRLEN) and macOS caps argv plus the
 * environment at 1 MiB. The message itself goes to stdin and has no limit.
 */
export const ARGV_TEXT_LIMIT_BYTES = 100_000

const TOOL_FLAGS: Record<Tools, readonly string[]> = {
  read: ['--sandbox', 'read-only'],
  write: ['--sandbox', 'workspace-write'],
}

/**
 * The persona when it fits a `-c developer_instructions=...` argument on a
 * session's first use. A resumed session already holds its persona; one
 * too long for argv travels in the message instead (`promptText`).
 *
 * `developer_instructions`, not `instructions`: on 0.166.0 `instructions`
 * replaces Codex's own base instructions (about 5,000 fewer input tokens
 * in a hello turn), while `developer_instructions` adds a developer
 * message next to them, as Claude's `--append-system-prompt-file` does.
 */
function configPersona(req: SpawnRequest): string | undefined {
  if (req.persona === undefined || req.session.resume) return undefined
  return fitsArgv(req.persona) ? req.persona : undefined
}

/**
 * The prompt sent on stdin for this turn: the message, with the persona
 * prepended under a `# Role` heading when it is too long for argv.
 */
export function promptText(req: SpawnRequest): string {
  if (req.persona === undefined || req.session.resume || fitsArgv(req.persona)) {
    return req.message
  }
  return `# Role\n\n${req.persona}\n\n# Task\n\n${req.message}`
}

/** Whether `text` is small enough to pass as one argv string. */
export function fitsArgv(text: string): boolean {
  return Buffer.byteLength(text, 'utf8') <= ARGV_TEXT_LIMIT_BYTES
}

/**
 * `text` as a TOML basic string, the form `-c key=value` parses its value
 * in. JSON's string escapes are a subset of TOML's, except that TOML also
 * refuses a raw DEL and an escaped lone surrogate; a value that fails to
 * parse as TOML would be taken literally, quotes and escapes included.
 */
export function tomlString(text: string): string {
  const wellFormed = text.replace(LONE_SURROGATE, '�')
  return JSON.stringify(wellFormed).replaceAll('\u007f', '\\u007f')
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/**
 * The command line for one Codex turn. The prompt is not in it: the
 * trailing `-` makes Codex read it from stdin (`promptText`), so its size
 * is not bounded by ARG_MAX. The session id is Codex's own, read from the
 * stream on first use; on resume it is the one the engine recorded.
 */
export function buildArgv(req: SpawnRequest): string[] {
  const argv: string[] = ['codex', 'exec', '--json', '--cd', req.cwd, ...TOOL_FLAGS[req.tools]]
  if (req.model !== undefined) argv.push('-m', req.model)
  if (req.effort !== undefined) {
    const mapped = EFFORT.codex[req.effort]
    // Chain validation rejects an effort the provider has no value for.
    if (typeof mapped !== 'string') {
      throw new RensaError('INTERNAL', `codex has no effort level for \`${req.effort}\``)
    }
    argv.push('-c', `model_reasoning_effort=${mapped}`)
  }
  const persona = configPersona(req)
  if (persona !== undefined) argv.push('-c', `developer_instructions=${tomlString(persona)}`)
  if (req.session.resume) argv.push('resume', req.session.id)
  argv.push('-')
  return argv
}
