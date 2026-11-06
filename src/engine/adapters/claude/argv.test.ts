import { describe, expect, it } from 'vitest'
import type { SpawnRequest } from '../types.js'
import { buildArgv, stdinMessage } from './argv.js'

const BASE = [
  'claude',
  '-p',
  '--output-format',
  'stream-json',
  '--verbose',
  '--include-partial-messages',
  '--input-format',
  'stream-json',
]

const READ_FLAGS = [
  '--tools',
  'Read,Glob,Grep',
  '--allowedTools',
  'Read,Glob,Grep',
  '--permission-mode',
  'dontAsk',
  '--permission-prompts',
  'none',
]

const WRITE_FLAGS = [
  '--permission-mode',
  'acceptEdits',
  '--allowedTools',
  'Read,Edit,Write,Glob,Grep,Bash',
  '--permission-prompts',
  'none',
]

const SESSION_ID = '5b1e7c42-9d3a-4f6e-8a21-c07d9e4b3f18'
const PERSONA_FILE = '/Users/alice/code/shop/.rensa/runs/r_8c1d2e/agents/review/claude/persona.md'

function request(overrides: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    cwd: '/Users/alice/code/shop',
    env: {},
    message: 'Review the diff against main and list any regressions.',
    tools: 'read',
    session: { id: SESSION_ID, resume: false },
    stagingDir: '/Users/alice/code/shop/.rensa/runs/r_8c1d2e/agents/review/claude',
    timeoutMs: 600_000,
    ...overrides,
  }
}

/** The values that follow `flag` in `argv`, one per occurrence. */
function valuesOf(argv: readonly string[], flag: string): string[] {
  return argv.flatMap((arg, i) => (arg === flag ? [argv[i + 1] ?? '(missing)'] : []))
}

describe('the command line for a claude turn', () => {
  it('starts with the headless stream-json flags when given a first-use read-only request', () => {
    const argv = buildArgv(request(), {})

    expect(argv).toEqual([...BASE, '--session-id', SESSION_ID, ...READ_FLAGS])
  })

  it('passes --session-id and no --resume when the session is used for the first time', () => {
    const argv = buildArgv(request(), {})

    expect(valuesOf(argv, '--session-id')).toEqual([SESSION_ID])
    expect(argv).not.toContain('--resume')
  })

  it('passes --resume and no --session-id when the session is resumed', () => {
    const argv = buildArgv(request({ session: { id: SESSION_ID, resume: true } }), {})

    expect(valuesOf(argv, '--resume')).toEqual([SESSION_ID])
    expect(argv).not.toContain('--session-id')
  })

  it('appends the staged persona file when the session is used for the first time', () => {
    const argv = buildArgv(request(), { personaFile: PERSONA_FILE })

    expect(valuesOf(argv, '--append-system-prompt-file')).toEqual([PERSONA_FILE])
  })

  it('omits the persona file when the session is resumed even if one is staged', () => {
    const argv = buildArgv(request({ session: { id: SESSION_ID, resume: true } }), {
      personaFile: PERSONA_FILE,
    })

    expect(argv).not.toContain('--append-system-prompt-file')
    expect(argv).not.toContain(PERSONA_FILE)
  })

  it('passes --model when the request names a model', () => {
    const argv = buildArgv(request({ model: 'opus' }), {})

    expect(valuesOf(argv, '--model')).toEqual(['opus'])
  })

  it('passes no --model when the request names none', () => {
    expect(buildArgv(request(), {})).not.toContain('--model')
  })

  it.each([
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['max', 'max'],
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

  it('restricts tools to Read, Glob and Grep with dontAsk when tools are read', () => {
    const argv = buildArgv(request({ tools: 'read' }), {})

    expect(argv.slice(-READ_FLAGS.length)).toEqual(READ_FLAGS)
  })

  it('allows edits and Bash with acceptEdits when tools are write', () => {
    const argv = buildArgv(request({ tools: 'write' }), {})

    expect(argv).toEqual([...BASE, '--session-id', SESSION_ID, ...WRITE_FLAGS])
  })

  it.each([
    ['a first-use', { session: { id: SESSION_ID, resume: false } }],
    ['a resumed', { session: { id: SESSION_ID, resume: true } }],
    ['a model and max effort', { model: 'opus', effort: 'max' }],
  ] satisfies [string, Partial<SpawnRequest>][])(
    'never mentions Bash when tools are read for %s request',
    (_, overrides) => {
      const argv = buildArgv(request({ tools: 'read', ...overrides }), {
        personaFile: PERSONA_FILE,
      })

      expect(argv.filter((arg) => arg.includes('Bash'))).toEqual([])
    },
  )

  it.each(['read', 'write'] as const)(
    'never passes --bare or --no-session-persistence when tools are %s',
    (tools) => {
      const argv = buildArgv(request({ tools, model: 'opus', effort: 'high' }), {
        personaFile: PERSONA_FILE,
      })

      expect(argv).not.toContain('--bare')
      expect(argv).not.toContain('--no-session-persistence')
    },
  )

  it('leaves the message out of argv when the request carries one', () => {
    const argv = buildArgv(request({ message: 'Summarize CHANGELOG.md in three bullets.' }), {})

    expect(argv.filter((arg) => arg.includes('CHANGELOG'))).toEqual([])
  })
})

describe('the stdin line that carries the message', () => {
  it('wraps the message as one stream-json user message ending in a newline', () => {
    const line = stdinMessage('Summarize CHANGELOG.md in three bullets.')

    expect(line).toBe(
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Summarize CHANGELOG.md in three bullets."}]}}\n',
    )
  })

  it('stays a single line and round-trips the text when the message has newlines and quotes', () => {
    const message = 'Review this:\n\n```diff\n- const name = "old"\n+ const name = "new"\n```\n'

    const line = stdinMessage(message)

    expect(line.slice(0, -1)).not.toContain('\n')
    expect(JSON.parse(line)).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: message }] },
    })
  })
})
