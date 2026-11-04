import type { RunInput } from '../engine/index.js'

export const USAGE = `usage:
  rensa                                     open the TUI
  rensa run <chain> [input text]            run a chain with no UI
        [--input-file <path>]               read the input from a file
        [--base <ref>]                      override the chain's base ref
        [--no-pause]                        run declared pauses as if absent
        [--quiet | --json]                  only run/step/agent lines, or JSONL
  rensa doctor                              show provider availability
  rensa --version | --help`

/** `rensa run` output: every line, only run/step/agent lines, or JSONL. */
export type OutputMode = 'lines' | 'quiet' | 'json'

export interface RunArgs {
  chain: string
  input: RunInput
  base?: string
  noPause: boolean
  output: OutputMode
}

export type Command =
  | { kind: 'tui' }
  | { kind: 'version' }
  | { kind: 'help' }
  | { kind: 'doctor' }
  | ({ kind: 'run' } & RunArgs)

/** A command, or the reason the arguments are not one (usage error, exit 64). */
export type ParsedArgs = { ok: true; command: Command } | { ok: false; message: string }

/** Parses `process.argv.slice(2)`. Never throws. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [first, ...rest] = argv
  switch (first) {
    case undefined:
      return { ok: true, command: { kind: 'tui' } }
    case '--version':
    case '-v':
      return rest.length === 0 ? ok({ kind: 'version' }) : extra(rest)
    case '--help':
    case '-h':
      return ok({ kind: 'help' })
    case 'doctor':
      if (rest.includes('--help') || rest.includes('-h')) return ok({ kind: 'help' })
      return rest.length === 0 ? ok({ kind: 'doctor' }) : extra(rest)
    case 'run':
      return parseRun(rest)
    default:
      return fail(first.startsWith('-') ? `unknown flag ${first}` : `unknown command ${first}`)
  }
}

function parseRun(argv: readonly string[]): ParsedArgs {
  const positional: string[] = []
  let inputFile: string | undefined
  let base: string | undefined
  let noPause = false
  let quiet = false
  let json = false

  const queue = [...argv]
  for (let arg = queue.shift(); arg !== undefined; arg = queue.shift()) {
    if (arg === '--') {
      positional.push(...queue)
      break
    }
    if (!arg.startsWith('-') || arg === '-') {
      positional.push(arg)
      continue
    }
    const [flag, inline] = splitFlag(arg)
    switch (flag) {
      case '--help':
      case '-h':
        return ok({ kind: 'help' })
      case '--no-pause':
      case '--quiet':
      case '--json':
        if (inline !== undefined) return fail(`${flag} takes no value`)
        if (flag === '--no-pause') noPause = true
        else if (flag === '--quiet') quiet = true
        else json = true
        break
      case '--input-file':
      case '--base': {
        const value = inline ?? queue.shift()
        if (value === undefined || value === '') return fail(`${flag} needs a value`)
        if (flag === '--input-file') inputFile = value
        else base = value
        break
      }
      default:
        return fail(`unknown flag ${flag}`)
    }
  }

  const [chain, ...text] = positional
  if (chain === undefined) return fail('rensa run needs a chain name')
  if (text.length > 0 && inputFile !== undefined) {
    return fail('give the input as text or with --input-file, not both')
  }
  if (quiet && json) return fail('--quiet and --json cannot be combined')

  const input: RunInput =
    inputFile !== undefined
      ? { kind: 'file', path: inputFile }
      : text.length > 0
        ? { kind: 'text', text: text.join(' ') }
        : { kind: 'none' }
  return ok({
    kind: 'run',
    chain,
    input,
    noPause,
    output: json ? 'json' : quiet ? 'quiet' : 'lines',
    ...(base !== undefined && { base }),
  })
}

/** `--flag=value` → [`--flag`, `value`]; anything else → [arg, undefined]. */
function splitFlag(arg: string): [string, string | undefined] {
  const eq = arg.indexOf('=')
  return eq === -1 ? [arg, undefined] : [arg.slice(0, eq), arg.slice(eq + 1)]
}

function ok(command: Command): ParsedArgs {
  return { ok: true, command }
}

function fail(message: string): ParsedArgs {
  return { ok: false, message }
}

function extra(rest: readonly string[]): ParsedArgs {
  const [arg] = rest
  return fail(arg?.startsWith('-') ? `unknown flag ${arg}` : `unexpected argument ${arg}`)
}
