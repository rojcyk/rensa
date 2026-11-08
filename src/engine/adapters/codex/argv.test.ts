import { afterEach, describe, expect, it } from 'vitest'
import { EFFORT } from '../../config/effort.js'
import type { Effort } from '../../config/types.js'
import { RensaError } from '../../errors.js'
import type { SpawnRequest } from '../types.js'
import { ARGV_TEXT_LIMIT_BYTES, buildArgv, fitsArgv, promptText, tomlString } from './argv.js'

// A Codex thread id as `thread.started` reports it on codex-cli 0.166.0.
const THREAD_ID = '019a6c3e-7f21-7d40-9b8e-4c2a1f0d5e63'
const CWD = '/Users/alice/code/shop'
const STAGING_DIR = '/Users/alice/code/shop/.rensa/runs/r_8c1d2e/agents/review/codex'
const MESSAGE = 'Review the diff against main and list any regressions.'
const PERSONA = '# Reviewer\n\nYou review diffs for regressions. Be terse and cite file:line.\n'

function request(overrides: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    cwd: CWD,
    env: {},
    message: MESSAGE,
    tools: 'read',
    session: { id: THREAD_ID, resume: false },
    stagingDir: STAGING_DIR,
    timeoutMs: 600_000,
    ...overrides,
  }
}

/** The values that follow `flag` in `argv`, one per occurrence. */
function valuesOf(argv: readonly string[], flag: string): string[] {
  return argv.flatMap((arg, i) => (arg === flag ? [argv[i + 1] ?? '(missing)'] : []))
}

/** The `-c key=value` overrides in `argv` for `key`, values only. */
function configValues(argv: readonly string[], key: string): string[] {
  const prefix = `${key}=`
  return valuesOf(argv, '-c').flatMap((v) => (v.startsWith(prefix) ? [v.slice(prefix.length)] : []))
}

/** Text of exactly `bytes` UTF-8 bytes. */
function textOfBytes(bytes: number): string {
  return 'r'.repeat(bytes)
}

const RESUMED = { session: { id: THREAD_ID, resume: true } }

const originalCodexEffort = { ...EFFORT.codex }

afterEach(() => {
  // Tests that remove a level from the table put it back here.
  for (const key of Object.keys(EFFORT.codex) as Effort[]) delete EFFORT.codex[key]
  Object.assign(EFFORT.codex, originalCodexEffort)
})

describe('the command line for a codex turn', () => {
  it('runs codex exec with JSON output, the cwd, a read-only sandbox and stdin when given a first-use read-only request', () => {
    const argv = buildArgv(request())

    expect(argv).toEqual(['codex', 'exec', '--json', '--cd', CWD, '--sandbox', 'read-only', '-'])
  })

  it('never puts the message in argv when the message is given', () => {
    const message = '- check src/cart/total.ts\n- check src/cart/tax.ts'

    const argv = buildArgv(request({ message, model: 'gpt-5.3-codex', effort: 'high' }))

    expect(argv.filter((arg) => arg.includes('check src/cart'))).toEqual([])
  })

  it('ends with - so the prompt is read from stdin when the session is new or resumed', () => {
    const first = buildArgv(request({ model: 'gpt-5.3-codex', effort: 'max', persona: PERSONA }))
    const resumed = buildArgv(request({ model: 'gpt-5.3-codex', effort: 'max', ...RESUMED }))

    expect([first.at(-1), resumed.at(-1)]).toEqual(['-', '-'])
  })

  it('passes no session id and no resume when the session is used for the first time', () => {
    const argv = buildArgv(request())

    expect(argv).not.toContain('resume')
    expect(argv).not.toContain(THREAD_ID)
  })

  it('passes resume with the recorded session id just before - when the session is resumed', () => {
    const argv = buildArgv(request(RESUMED))

    expect(argv.slice(-3)).toEqual(['resume', THREAD_ID, '-'])
  })

  it('puts every option before resume when the session is resumed with a model, effort and write tools', () => {
    const argv = buildArgv(
      request({ tools: 'write', model: 'gpt-5.3-codex', effort: 'medium', ...RESUMED }),
    )

    expect(argv).toEqual([
      'codex',
      'exec',
      '--json',
      '--cd',
      CWD,
      '--sandbox',
      'workspace-write',
      '-m',
      'gpt-5.3-codex',
      '-c',
      'model_reasoning_effort=medium',
      'resume',
      THREAD_ID,
      '-',
    ])
  })

  it('passes -m when the request names a model', () => {
    const argv = buildArgv(request({ model: 'gpt-5.3-codex' }))

    expect(valuesOf(argv, '-m')).toEqual(['gpt-5.3-codex'])
  })

  it('passes no -m when the request names none', () => {
    expect(buildArgv(request())).not.toContain('-m')
  })

  it.each([
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['max', 'xhigh'],
  ] as const)(
    'passes -c model_reasoning_effort=%s mapped to %s when the request sets that effort',
    (effort, mapped) => {
      const argv = buildArgv(request({ effort }))

      expect(configValues(argv, 'model_reasoning_effort')).toEqual([mapped])
    },
  )

  it('passes no model_reasoning_effort when the request sets no effort', () => {
    expect(configValues(buildArgv(request()), 'model_reasoning_effort')).toEqual([])
  })

  it('throws an INTERNAL RensaError naming the level when the effort table has no codex value for it', () => {
    EFFORT.codex.max = null

    const build = () => buildArgv(request({ effort: 'max' }))

    expect(build).toThrow(RensaError)
    expect(build).toThrow(
      expect.objectContaining({ code: 'INTERNAL', message: 'codex has no effort level for `max`' }),
    )
  })

  it('uses the read-only sandbox and nothing that widens it when tools are read', () => {
    const argv = buildArgv(request({ tools: 'read', model: 'gpt-5.3-codex', effort: 'high' }))

    expect(valuesOf(argv, '--sandbox')).toEqual(['read-only'])
    expect(
      argv.filter((arg) =>
        ['--full-auto', '--dangerously-bypass-approvals-and-sandbox', '--yolo'].includes(arg),
      ),
    ).toEqual([])
  })

  it('uses the workspace-write sandbox without --full-auto when tools are write', () => {
    const argv = buildArgv(request({ tools: 'write' }))

    expect(valuesOf(argv, '--sandbox')).toEqual(['workspace-write'])
    expect(argv).not.toContain('--full-auto')
  })

  it.each([
    ['read', 'first use', {}],
    ['write', 'resume', RESUMED],
  ] as const)(
    'passes neither --skip-git-repo-check nor --ephemeral when tools are %s on %s',
    (tools, _, extra) => {
      const argv = buildArgv(request({ tools, ...extra }))

      expect(
        argv.filter((arg) => arg === '--skip-git-repo-check' || arg === '--ephemeral'),
      ).toEqual([])
    },
  )
})

describe('the persona on the command line', () => {
  it('passes the persona as -c developer_instructions in TOML string form when the session is new', () => {
    const argv = buildArgv(request({ persona: PERSONA }))

    expect(configValues(argv, 'developer_instructions')).toEqual([tomlString(PERSONA)])
    expect(configValues(argv, 'instructions')).toEqual([])
  })

  it('sends the message alone on stdin when the persona fits argv', () => {
    expect(promptText(request({ persona: PERSONA }))).toBe(MESSAGE)
  })

  it('passes no developer_instructions and sends the message alone when the session is resumed', () => {
    const req = request({ persona: PERSONA, ...RESUMED })

    expect(configValues(buildArgv(req), 'developer_instructions')).toEqual([])
    expect(promptText(req)).toBe(MESSAGE)
  })

  it('passes no developer_instructions when the request has no persona', () => {
    expect(configValues(buildArgv(request()), 'developer_instructions')).toEqual([])
  })

  it('keeps a persona exactly at the argv limit in developer_instructions when the session is new', () => {
    const persona = textOfBytes(ARGV_TEXT_LIMIT_BYTES)
    const req = request({ persona })

    expect(configValues(buildArgv(req), 'developer_instructions')).toEqual([`"${persona}"`])
    expect(promptText(req)).toBe(MESSAGE)
  })

  it('moves the persona into the prompt under # Role and # Task when it is one byte over the argv limit', () => {
    const persona = textOfBytes(ARGV_TEXT_LIMIT_BYTES + 1)
    const req = request({ persona })

    expect(configValues(buildArgv(req), 'developer_instructions')).toEqual([])
    expect(promptText(req)).toBe(`# Role\n\n${persona}\n\n# Task\n\n${MESSAGE}`)
  })

  it('counts UTF-8 bytes rather than characters when the persona has multi-byte characters', () => {
    // 'é' is two bytes: 50,001 of them are 100,002 bytes in 50,001 characters.
    const persona = 'é'.repeat(ARGV_TEXT_LIMIT_BYTES / 2 + 1)
    const req = request({ persona })

    expect(fitsArgv(persona)).toBe(false)
    expect(configValues(buildArgv(req), 'developer_instructions')).toEqual([])
  })

  it('sends the message alone when the persona is over the limit but the session is resumed', () => {
    const req = request({ persona: textOfBytes(ARGV_TEXT_LIMIT_BYTES + 1), ...RESUMED })

    expect(promptText(req)).toBe(MESSAGE)
    expect(configValues(buildArgv(req), 'developer_instructions')).toEqual([])
  })

  it('sends the message unchanged on stdin when the request has no persona', () => {
    const message = 'Review this diff:\n\n+ const total = sum(items)\n'

    expect(promptText(request({ message }))).toBe(message)
  })
})

describe('writing a persona as a TOML basic string', () => {
  it('quotes plain text in double quotes when it needs no escapes', () => {
    expect(tomlString('You review diffs for regressions.')).toBe(
      '"You review diffs for regressions."',
    )
  })

  it('escapes quotes, backslashes, newlines and tabs when the text contains them', () => {
    const text = 'Cite "file:line".\n\tUse C:\\path style only on Windows.'

    expect(tomlString(text)).toBe(
      '"Cite \\"file:line\\".\\n\\tUse C:\\\\path style only on Windows."',
    )
  })

  it('escapes control characters and DEL as \\u escapes when the text contains them', () => {
    expect(tomlString('bell\u0007 del\u007f nul\u0000')).toBe('"bell\\u0007 del\\u007f nul\\u0000"')
  })

  it('keeps non-ASCII text and a valid surrogate pair as literal characters', () => {
    expect(tomlString('Résumé review 🔍')).toBe('"Résumé review 🔍"')
  })

  it('replaces a lone surrogate with U+FFFD when the text is not well-formed UTF-16', () => {
    expect(tomlString('broken \uD83D here and \uDC0D there')).toBe(
      '"broken \uFFFD here and \uFFFD there"',
    )
  })

  it('leaves no raw control character and no surrogate escape when given every C0 control, DEL and a lone surrogate', () => {
    let controls = ''
    for (let c = 0; c < 0x20; c += 1) controls += String.fromCharCode(c)
    const out = tomlString(`${controls}\u007f\uD800`)

    // TOML refuses raw U+0000–U+001F and U+007F in a basic string, and any \uD800–\uDFFF escape.
    const rawControls = [...out].filter((ch) => {
      const code = ch.codePointAt(0) ?? 0
      return code < 0x20 || code === 0x7f
    })
    expect(rawControls).toEqual([])
    expect(out.match(/\\u[dD][89a-fA-F][0-9a-fA-F]{2}/g)).toEqual(null)
  })
})
