import { PROVIDERS, type Provider, type RunInput } from '../engine/index.js'

export const USAGE = `usage:
  rensa [<chain>]                           open the TUI, on the chain if given
        [--fullscreen | --inline]           use the alternate screen, or not
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

/** `rensa [<chain>] [--fullscreen | --inline]`; a flag is present only when given. */
export interface TuiArgs {
  /** Opens on this chain's detail screen. */
  chain?: string
  fullscreen?: true
  inline?: true
}

export type Command =
  | ({ kind: 'tui' } & TuiArgs)
  | { kind: 'version' }
  | { kind: 'help' }
  | { kind: 'doctor' }
  | ({ kind: 'run' } & RunArgs)
  | ({ kind: 'capture' } & CaptureArgs)

/** `rensa capture <provider> <name> <prompt>`: a development command, not in `USAGE`. */
export interface CaptureArgs {
  provider: Provider
  /** Fixture directory name under `test/fixtures/<provider>/`. */
  name: string
  prompt: string
}

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
    case 'capture':
      return parseCapture(rest)
    default:
      return parseTui(argv)
  }
}

/** Anything that is not a command: an optional chain name and the mode flags. */
function parseTui(argv: readonly string[]): ParsedArgs {
  let chain: string | undefined
  let fullscreen = false
  let inline = false
  for (const arg of argv) {
    if (!arg.startsWith('-') || arg === '-') {
      if (chain !== undefined) return fail(`unexpected argument ${arg}`)
      chain = arg
      continue
    }
    switch (arg) {
      case '--help':
      case '-h':
        return ok({ kind: 'help' })
      case '--fullscreen':
        fullscreen = true
        break
      case '--inline':
        inline = true
        break
      default:
        return fail(`unknown flag ${splitFlag(arg)[0]}`)
    }
  }
  if (fullscreen && inline) return fail('--fullscreen and --inline cannot be combined')
  return ok({
    kind: 'tui',
    ...(chain !== undefined && { chain }),
    ...(fullscreen && { fullscreen: true as const }),
    ...(inline && { inline: true as const }),
  })
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

const FIXTURE_NAME = /^[a-z0-9_-]+$/i

function parseCapture(argv: readonly string[]): ParsedArgs {
  const [provider, name, ...words] = argv
  const usage = 'usage: rensa capture <provider> <name> "<prompt>"'
  if (provider === undefined || name === undefined || words.length === 0) return fail(usage)
  if (!isProvider(provider))
    return fail(`unknown provider ${provider}; expected one of ${PROVIDERS.join(', ')}`)
  if (!FIXTURE_NAME.test(name)) {
    return fail(`fixture name \`${name}\` may contain only letters, digits, \`_\` and \`-\``)
  }
  const prompt = words.join(' ')
  if (prompt.trim() === '') return fail('rensa capture needs a prompt')
  return ok({ kind: 'capture', provider, name, prompt })
}

function isProvider(value: string): value is Provider {
  return PROVIDERS.some((p) => p === value)
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
