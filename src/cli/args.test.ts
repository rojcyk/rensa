import { describe, expect, it } from 'vitest'
import { type Command, type ParsedArgs, parseArgs, type RunArgs } from './args.js'

function parsed(command: Command): ParsedArgs {
  return { ok: true, command }
}

function run(overrides: Partial<RunArgs> = {}): ParsedArgs {
  return parsed({
    kind: 'run',
    chain: 'tdd-review',
    input: { kind: 'none' },
    noPause: false,
    output: 'lines',
    ...overrides,
  })
}

function usageError(message: string): ParsedArgs {
  return { ok: false, message }
}

describe('commands without a run', () => {
  it('opens the TUI when no arguments are given', () => {
    expect(parseArgs([])).toEqual(parsed({ kind: 'tui' }))
  })

  it.each([['--version'], ['-v']])('prints the version when given %s alone', (flag) => {
    expect(parseArgs([flag])).toEqual(parsed({ kind: 'version' }))
  })

  it.each([['--help'], ['-h']])('prints usage when given %s', (flag) => {
    expect(parseArgs([flag])).toEqual(parsed({ kind: 'help' }))
  })

  it('checks providers when given doctor alone', () => {
    expect(parseArgs(['doctor'])).toEqual(parsed({ kind: 'doctor' }))
  })

  it('prints usage when doctor is given --help', () => {
    expect(parseArgs(['doctor', '--help'])).toEqual(parsed({ kind: 'help' }))
  })

  it('prints usage when run is given --help before the chain', () => {
    expect(parseArgs(['run', '--help', 'tdd-review'])).toEqual(parsed({ kind: 'help' }))
  })
})

describe('rensa run input', () => {
  it('runs with no input when only the chain is given', () => {
    expect(parseArgs(['run', 'tdd-review'])).toEqual(run())
  })

  it('takes one positional after the chain as the input text', () => {
    expect(parseArgs(['run', 'tdd-review', 'add a quote limit'])).toEqual(
      run({ input: { kind: 'text', text: 'add a quote limit' } }),
    )
  })

  it('joins several positionals after the chain with single spaces when the text is unquoted', () => {
    expect(parseArgs(['run', 'tdd-review', 'add', 'a', 'quote', 'limit'])).toEqual(
      run({ input: { kind: 'text', text: 'add a quote limit' } }),
    )
  })

  it('reads the input from a file when --input-file is followed by a path', () => {
    expect(parseArgs(['run', 'tdd-review', '--input-file', 'tasks/quote-limit.md'])).toEqual(
      run({ input: { kind: 'file', path: 'tasks/quote-limit.md' } }),
    )
  })

  it('reads the input from a file when the path is given as --input-file=<path>', () => {
    expect(parseArgs(['run', 'tdd-review', '--input-file=tasks/quote-limit.md'])).toEqual(
      run({ input: { kind: 'file', path: 'tasks/quote-limit.md' } }),
    )
  })

  it('keeps everything after the first = as the value when the value contains =', () => {
    expect(parseArgs(['run', 'tdd-review', '--input-file=tasks/a=b.md'])).toEqual(
      run({ input: { kind: 'file', path: 'tasks/a=b.md' } }),
    )
  })

  it('treats arguments after -- as input text when they look like flags', () => {
    expect(parseArgs(['run', 'tdd-review', '--', '--force', 'the', 'push'])).toEqual(
      run({ input: { kind: 'text', text: '--force the push' } }),
    )
  })

  it('treats the chain name after -- as positional when every argument follows --', () => {
    expect(parseArgs(['run', '--', 'tdd-review'])).toEqual(run())
  })

  it('treats a lone - as input text rather than a flag', () => {
    expect(parseArgs(['run', 'tdd-review', '-'])).toEqual(
      run({ input: { kind: 'text', text: '-' } }),
    )
  })

  it('accepts flags before the chain name when they come first', () => {
    expect(parseArgs(['run', '--no-pause', 'tdd-review', 'fix it'])).toEqual(
      run({ noPause: true, input: { kind: 'text', text: 'fix it' } }),
    )
  })
})

describe('rensa run options', () => {
  it('sets base and noPause when given --base <ref> --no-pause', () => {
    expect(parseArgs(['run', 'tdd-review', '--base', 'feat/quote-limits', '--no-pause'])).toEqual(
      run({ base: 'feat/quote-limits', noPause: true }),
    )
  })

  it('sets base when given --base=<ref>', () => {
    expect(parseArgs(['run', 'tdd-review', '--base=a1b2c3d'])).toEqual(run({ base: 'a1b2c3d' }))
  })

  it('takes the next argument as the base when it starts with a dash', () => {
    // The engine refuses a base starting with `-` before git sees it.
    expect(parseArgs(['run', 'tdd-review', '--base', '-x'])).toEqual(run({ base: '-x' }))
  })

  it('prints only run, step and agent lines when given --quiet', () => {
    expect(parseArgs(['run', 'tdd-review', '--quiet'])).toEqual(run({ output: 'quiet' }))
  })

  it('prints JSONL when given --json', () => {
    expect(parseArgs(['run', 'tdd-review', '--json'])).toEqual(run({ output: 'json' }))
  })
})

describe('usage errors', () => {
  it('reports an unknown flag when run is given one', () => {
    expect(parseArgs(['run', 'tdd-review', '--verbose'])).toEqual(
      usageError('unknown flag --verbose'),
    )
  })

  it('reports the flag name without its value when an unknown flag has =value', () => {
    expect(parseArgs(['run', 'tdd-review', '--model=opus'])).toEqual(
      usageError('unknown flag --model'),
    )
  })

  it('reports an unknown flag when the first argument is a flag rensa does not know', () => {
    expect(parseArgs(['--verbose'])).toEqual(usageError('unknown flag --verbose'))
  })

  it('reports an unknown command when the first argument is not a command', () => {
    expect(parseArgs(['status'])).toEqual(usageError('unknown command status'))
  })

  it('reports a missing chain when run is given no positional', () => {
    expect(parseArgs(['run'])).toEqual(usageError('rensa run needs a chain name'))
  })

  it('reports a missing chain when run is given only flags', () => {
    expect(parseArgs(['run', '--no-pause', '--quiet'])).toEqual(
      usageError('rensa run needs a chain name'),
    )
  })

  it.each([
    [['--base'], '--base needs a value'],
    [['--base='], '--base needs a value'],
    [['--input-file'], '--input-file needs a value'],
    [['--input-file='], '--input-file needs a value'],
  ])('reports a missing value when given %j last', (flags, message) => {
    expect(parseArgs(['run', 'tdd-review', ...flags])).toEqual(usageError(message))
  })

  it.each([['--no-pause=yes'], ['--quiet=1'], ['--json=true']])(
    'reports that the switch takes no value when given %s',
    (flag) => {
      const name = flag.slice(0, flag.indexOf('='))
      expect(parseArgs(['run', 'tdd-review', flag])).toEqual(usageError(`${name} takes no value`))
    },
  )

  it('refuses input text together with --input-file', () => {
    expect(
      parseArgs(['run', 'tdd-review', 'add a limit', '--input-file', 'tasks/quote-limit.md']),
    ).toEqual(usageError('give the input as text or with --input-file, not both'))
  })

  it('refuses --quiet together with --json', () => {
    expect(parseArgs(['run', 'tdd-review', '--quiet', '--json'])).toEqual(
      usageError('--quiet and --json cannot be combined'),
    )
  })

  it('reports an unexpected argument when doctor is given a positional', () => {
    expect(parseArgs(['doctor', 'claude'])).toEqual(usageError('unexpected argument claude'))
  })

  it('reports an unknown flag when doctor is given a flag', () => {
    expect(parseArgs(['doctor', '--json'])).toEqual(usageError('unknown flag --json'))
  })

  it('reports an unexpected argument when --version is followed by anything', () => {
    expect(parseArgs(['--version', 'run'])).toEqual(usageError('unexpected argument run'))
  })
})

describe('rensa capture', () => {
  it('takes provider, fixture name and the prompt when given all three', () => {
    expect(
      parseArgs(['capture', 'claude', 'read-only-hello', 'List the files in this directory.']),
    ).toEqual(
      parsed({
        kind: 'capture',
        provider: 'claude',
        name: 'read-only-hello',
        prompt: 'List the files in this directory.',
      }),
    )
  })

  it('joins several prompt words with single spaces when the prompt is unquoted', () => {
    expect(parseArgs(['capture', 'claude', 'tool-calls', 'Read', 'LICENSE', 'twice'])).toEqual(
      parsed({
        kind: 'capture',
        provider: 'claude',
        name: 'tool-calls',
        prompt: 'Read LICENSE twice',
      }),
    )
  })

  it.each([[['capture']], [['capture', 'claude']], [['capture', 'claude', 'read-only-hello']]])(
    'reports the capture usage when given %j',
    (argv) => {
      expect(parseArgs(argv)).toEqual(
        usageError('usage: rensa capture <provider> <name> "<prompt>"'),
      )
    },
  )

  it('refuses a provider rensa does not know', () => {
    const result = parseArgs(['capture', 'gemini', 'hello', 'Say hello.'])

    expect(result).toEqual(
      usageError('unknown provider gemini; expected one of claude, codex, grok, fake'),
    )
  })

  it.each([['../escape'], ['nested/name'], ['with space']])(
    'refuses fixture name %s when it is not letters, digits, _ and -',
    (name) => {
      const result = parseArgs(['capture', 'claude', name, 'Say hello.'])

      expect(result.ok).toBe(false)
    },
  )

  it('refuses a prompt that is only whitespace', () => {
    expect(parseArgs(['capture', 'claude', 'hello', '  '])).toEqual(
      usageError('rensa capture needs a prompt'),
    )
  })
})
