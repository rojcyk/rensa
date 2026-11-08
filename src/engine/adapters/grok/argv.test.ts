import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EFFORT } from '../../config/effort.js'
import type { Effort } from '../../config/types.js'
import { RensaError } from '../../errors.js'
import type { SpawnRequest } from '../types.js'
import { ARGV_TEXT_LIMIT_BYTES, buildArgv, promptText, stagedPromptFor } from './argv.js'

const SESSION_ID = '5b1e7c42-9d3a-4f6e-8a21-c07d9e4b3f18'
const CWD = '/Users/alice/code/shop'
const STAGING_DIR = '/Users/alice/code/shop/.rensa/runs/r_8c1d2e/agents/review/grok'
const MESSAGE = 'Review the diff against main and list any regressions.'
const PERSONA = '# Reviewer\n\nYou review diffs for regressions. Be terse and cite file:line.\n'

const READ_FLAGS = ['--tools=read_file,grep,list_dir', '--deny=Bash,Edit,Write,MCPTool']
const WRITE_FLAGS = ['--always-approve']

function request(overrides: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    cwd: CWD,
    env: {},
    message: MESSAGE,
    tools: 'read',
    session: { id: SESSION_ID, resume: false },
    stagingDir: STAGING_DIR,
    timeoutMs: 600_000,
    ...overrides,
  }
}

/** The values that follow `flag` in `argv`, one per occurrence. */
function valuesOf(argv: readonly string[], flag: string): string[] {
  return argv.flatMap((arg, i) => (arg === flag ? [argv[i + 1] ?? '(missing)'] : []))
}

/** The values of `--flag=value` arguments, one per occurrence. */
function joinedValuesOf(argv: readonly string[], flag: string): string[] {
  const prefix = `${flag}=`
  return argv.flatMap((arg) => (arg.startsWith(prefix) ? [arg.slice(prefix.length)] : []))
}

/** Text of exactly `bytes` UTF-8 bytes. */
function textOfBytes(bytes: number): string {
  return 'r'.repeat(bytes)
}

const RESUMED = { session: { id: SESSION_ID, resume: true } }

const originalGrokEffort = { ...EFFORT.grok }

afterEach(() => {
  // Tests that remove a level from the table put it back here.
  for (const key of Object.keys(EFFORT.grok) as Effort[]) delete EFFORT.grok[key]
  Object.assign(EFFORT.grok, originalGrokEffort)
})

describe('the command line for a grok turn', () => {
  it('passes the message with --single and the headless flags when given a first-use read-only request', () => {
    const argv = buildArgv(request(), {})

    expect(argv).toEqual([
      'grok',
      `--single=${MESSAGE}`,
      '--output-format',
      'streaming-json',
      '--no-auto-update',
      `--cwd=${CWD}`,
      '-s',
      SESSION_ID,
      ...READ_FLAGS,
    ])
  })

  it('keeps the message one argument attached to --single when it starts with a dash', () => {
    const message = '- check src/cart/total.ts\n- check src/cart/tax.ts'

    const argv = buildArgv(request({ message }), {})

    expect(joinedValuesOf(argv, '--single')).toEqual([message])
    expect(argv).not.toContain(message)
  })

  it('passes -s and no -r when the session is used for the first time', () => {
    const argv = buildArgv(request(), {})

    expect(valuesOf(argv, '-s')).toEqual([SESSION_ID])
    expect(argv).not.toContain('-r')
  })

  it('passes -r and no -s when the session is resumed', () => {
    const argv = buildArgv(request(RESUMED), {})

    expect(valuesOf(argv, '-r')).toEqual([SESSION_ID])
    expect(argv).not.toContain('-s')
  })

  it('passes the persona as --rules when the session is used for the first time', () => {
    const argv = buildArgv(request({ persona: PERSONA }), {})

    expect(joinedValuesOf(argv, '--rules')).toEqual([PERSONA])
    expect(joinedValuesOf(argv, '--single')).toEqual([MESSAGE])
  })

  it('omits --rules and leaves the persona out of the message when the session is resumed', () => {
    const req = request({ persona: PERSONA, ...RESUMED })

    const argv = buildArgv(req, stagedPromptFor(req))

    expect(joinedValuesOf(argv, '--rules')).toEqual([])
    expect(joinedValuesOf(argv, '--single')).toEqual([MESSAGE])
  })

  it('passes no --rules when the request has no persona', () => {
    expect(joinedValuesOf(buildArgv(request(), {}), '--rules')).toEqual([])
  })

  it('passes -m when the request names a model', () => {
    const argv = buildArgv(request({ model: 'grok-4.1-fast' }), {})

    expect(valuesOf(argv, '-m')).toEqual(['grok-4.1-fast'])
  })

  it('passes no -m when the request names none', () => {
    expect(buildArgv(request(), {})).not.toContain('-m')
  })

  it.each([
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['max', 'xhigh'],
  ] as const)(
    'passes --effort %s mapped to %s when the request sets that effort',
    (effort, mapped) => {
      const argv = buildArgv(request({ effort }), {})

      expect(valuesOf(argv, '--effort')).toEqual([mapped])
    },
  )

  it('passes no --effort when the request sets none', () => {
    expect(buildArgv(request(), {})).not.toContain('--effort')
  })

  it('throws an INTERNAL RensaError naming the level when the effort table has no grok value for it', () => {
    EFFORT.grok.max = null

    const build = () => buildArgv(request({ effort: 'max' }), {})

    expect(build).toThrow(RensaError)
    expect(build).toThrow(
      expect.objectContaining({ code: 'INTERNAL', message: 'grok has no effort level for `max`' }),
    )
  })

  it('offers only the read-only built-in tools and denies writing ones when tools are read', () => {
    const argv = buildArgv(request({ tools: 'read', model: 'grok-4.1-fast', effort: 'high' }), {})

    expect(argv.slice(-READ_FLAGS.length)).toEqual(READ_FLAGS)
    expect(argv).not.toContain('--always-approve')
  })

  it('approves every tool and restricts none when tools are write', () => {
    const argv = buildArgv(request({ tools: 'write' }), {})

    expect(argv.slice(-WRITE_FLAGS.length)).toEqual(WRITE_FLAGS)
    expect(argv.filter((arg) => arg.startsWith('--tools') || arg.startsWith('--deny'))).toEqual([])
  })

  it('passes --prompt-file in place of --single when the prompt is staged in a file', () => {
    const messageFile = path.join(STAGING_DIR, 'message.md')
    const message = textOfBytes(ARGV_TEXT_LIMIT_BYTES + 1)

    const argv = buildArgv(request({ message }), { messageFile })

    expect(joinedValuesOf(argv, '--prompt-file')).toEqual([messageFile])
    expect(joinedValuesOf(argv, '--single')).toEqual([])
    expect(argv.filter((arg) => arg.includes(message))).toEqual([])
  })
})

describe('deciding whether the prompt fits argv', () => {
  it('stages nothing when the message is exactly at the argv limit', () => {
    const req = request({ message: textOfBytes(ARGV_TEXT_LIMIT_BYTES) })

    expect(stagedPromptFor(req)).toEqual({})
  })

  it('stages the message in message.md under the staging directory when it is one byte over the limit', () => {
    const req = request({ message: textOfBytes(ARGV_TEXT_LIMIT_BYTES + 1) })

    expect(stagedPromptFor(req)).toEqual({ messageFile: path.join(STAGING_DIR, 'message.md') })
  })

  it('counts UTF-8 bytes rather than characters when the message has multi-byte characters', () => {
    // 'é' is two bytes: 50,001 of them are 100,002 bytes in 50,001 characters.
    const req = request({ message: 'é'.repeat(ARGV_TEXT_LIMIT_BYTES / 2 + 1) })

    expect(stagedPromptFor(req)).toEqual({ messageFile: path.join(STAGING_DIR, 'message.md') })
  })

  it('returns the same decision on every call when given the same request', () => {
    const req = request({ message: textOfBytes(ARGV_TEXT_LIMIT_BYTES + 1) })

    expect(stagedPromptFor(req)).toEqual(stagedPromptFor(req))
  })
})

describe('a persona too long for --rules', () => {
  const longPersona = `# Reviewer\n\n${textOfBytes(ARGV_TEXT_LIMIT_BYTES)}`

  it('keeps a persona exactly at the limit in --rules when the session is new', () => {
    const persona = textOfBytes(ARGV_TEXT_LIMIT_BYTES)

    const argv = buildArgv(request({ persona }), {})

    expect(joinedValuesOf(argv, '--rules')).toEqual([persona])
  })

  it('folds the persona into the prompt under # Role and # Task when it is over the limit', () => {
    const req = request({ persona: longPersona })

    expect(promptText(req)).toBe(`# Role\n\n${longPersona}\n\n# Task\n\n${MESSAGE}`)
  })

  it('stages the folded prompt and passes no --rules when the persona is over the limit', () => {
    const req = request({ persona: longPersona })

    const staged = stagedPromptFor(req)
    const argv = buildArgv(req, staged)

    expect(staged).toEqual({ messageFile: path.join(STAGING_DIR, 'message.md') })
    expect(joinedValuesOf(argv, '--rules')).toEqual([])
    expect(joinedValuesOf(argv, '--prompt-file')).toEqual([path.join(STAGING_DIR, 'message.md')])
  })

  it('sends the message alone when the persona is over the limit but the session is resumed', () => {
    const req = request({ persona: longPersona, ...RESUMED })

    expect(promptText(req)).toBe(MESSAGE)
    expect(stagedPromptFor(req)).toEqual({})
  })
})
