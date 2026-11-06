import { randomInt } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { killProcessesWithArgs } from '../../../testing/processes.js'
import { type TmpDir, tmpDir } from '../../../testing/tmpRepo.js'
import type { SpawnResult } from '../../process/spawn.js'
import type { AgentEvent, DoneEvent, SpawnRequest } from '../types.js'
import { stdinMessage } from './argv.js'
import { claudeAdapter, type ProcessOutcome, reconcileDone, stagePersona } from './index.js'

const SESSION_ID = '5b1e7c42-9d3a-4f6e-8a21-c07d9e4b3f18'
const PERSONA = '# Reviewer\n\nYou review diffs for regressions. Be terse and cite file:line.\n'

let tmp: TmpDir

beforeEach(async () => {
  tmp = await tmpDir('rensa-claude-adapter-')
})

afterEach(async () => {
  await tmp.cleanup()
})

function request(overrides: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    cwd: tmp.dir,
    env: { PATH: '/usr/bin:/bin' },
    message: 'Review the diff against main and list any regressions.',
    tools: 'read',
    session: { id: SESSION_ID, resume: false },
    stagingDir: path.join(tmp.dir, 'runs', 'r_8c1d2e', 'agents', 'review', 'claude'),
    timeoutMs: 60_000,
    ...overrides,
  }
}

async function listing(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

describe('staging the persona', () => {
  it('writes the persona to persona.md and returns its path when the session is new', async () => {
    const req = request({ persona: PERSONA })

    const file = await stagePersona(req)

    expect(file).toBe(path.join(req.stagingDir, 'persona.md'))
    expect(await readFile(path.join(req.stagingDir, 'persona.md'), 'utf8')).toBe(PERSONA)
  })

  it('writes nothing in the staging directory but persona.md when the session is new', async () => {
    const req = request({ persona: PERSONA })

    await stagePersona(req)

    expect(await listing(req.stagingDir)).toEqual(['persona.md'])
    expect(await listing(tmp.dir)).toEqual(['runs'])
  })

  it('writes nothing and returns undefined when the session is resumed', async () => {
    const req = request({ persona: PERSONA, session: { id: SESSION_ID, resume: true } })

    const file = await stagePersona(req)

    expect(file).toBe(undefined)
    expect(await listing(tmp.dir)).toEqual([])
  })

  it('writes nothing and returns undefined when the request has no persona', async () => {
    const file = await stagePersona(request())

    expect(file).toBe(undefined)
    expect(await listing(tmp.dir)).toEqual([])
  })
})

function spawnResult(overrides: Partial<SpawnResult> = {}): SpawnResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    killed: false,
    durationMs: 4211,
    ...overrides,
  }
}

function ran(overrides: Partial<SpawnResult> = {}): ProcessOutcome {
  return { started: true, result: spawnResult(overrides) }
}

const PARSED_OK: DoneEvent = {
  kind: 'done',
  reply: 'No regressions found in the diff.',
  exitCode: null,
  usage: { input: 5, output: 70, cache_read: 21_000, context: 12_215 },
}

const PARSED_NO_OUTPUT: DoneEvent = {
  kind: 'done',
  reply: '',
  exitCode: null,
  error: { kind: 'no_output', message: 'no result event in the stream' },
}

describe('reconciling the final done with the process', () => {
  it('keeps reply and usage, takes exit code 0 and sets no error when the process exits 0', () => {
    const done = reconcileDone(PARSED_OK, ran(), [])

    expect(done).toEqual({ ...PARSED_OK, exitCode: 0 })
  })

  it('reports exit with the spawn message and a null exit code when the process never started', () => {
    const done = reconcileDone(
      PARSED_NO_OUTPUT,
      { started: false, message: 'cannot run `claude`: not found' },
      [],
    )

    expect(done).toEqual({
      kind: 'done',
      reply: '',
      exitCode: null,
      error: { kind: 'exit', message: 'cannot run `claude`: not found' },
    })
  })

  it('reports exit killed with a null exit code when kill() stopped the process', () => {
    const done = reconcileDone(
      PARSED_NO_OUTPUT,
      ran({ exitCode: null, signal: 'SIGTERM', killed: true }),
      ['Error: not logged in'],
    )

    expect(done.exitCode).toBe(null)
    expect(done.error).toEqual({ kind: 'exit', message: 'killed' })
  })

  it('reports exit timed out when the timeout stopped the process', () => {
    const done = reconcileDone(
      PARSED_OK,
      ran({ exitCode: null, signal: 'SIGTERM', killed: true, timedOut: true }),
      [],
    )

    expect(done.error).toEqual({ kind: 'exit', message: 'timed out' })
  })

  it('turns a parser no_output into auth with the stderr line when stderr says not logged in', () => {
    const done = reconcileDone(PARSED_NO_OUTPUT, ran({ exitCode: 1 }), [
      'Warning: telemetry disabled',
      'Error: not logged in',
    ])

    expect(done).toEqual({
      kind: 'done',
      reply: '',
      exitCode: 1,
      error: { kind: 'auth', message: 'Error: not logged in' },
    })
  })

  it('turns a parser exit error into usage_limit with the stderr line when stderr reports the limit', () => {
    const parsed: DoneEvent = {
      kind: 'done',
      reply: 'Request failed',
      exitCode: null,
      error: { kind: 'exit', message: 'Request failed' },
    }

    const done = reconcileDone(parsed, ran({ exitCode: 1 }), [
      'Claude AI usage limit reached|1762430400',
    ])

    expect(done.error).toEqual({
      kind: 'usage_limit',
      message: 'Claude AI usage limit reached|1762430400',
    })
  })

  it('keeps a parser auth error when stderr shows a usage limit', () => {
    const parsed: DoneEvent = {
      kind: 'done',
      reply: 'Not logged in · Please run /login',
      exitCode: null,
      error: { kind: 'auth', message: 'Not logged in · Please run /login' },
    }

    const done = reconcileDone(parsed, ran({ exitCode: 1 }), ['Your limit resets at 3pm'])

    expect(done.error).toEqual({ kind: 'auth', message: 'Not logged in · Please run /login' })
  })

  it('keeps a parser no_output when stderr shows neither auth nor a usage limit', () => {
    const done = reconcileDone(PARSED_NO_OUTPUT, ran({ exitCode: 1 }), ['Segmentation fault'])

    expect(done.error).toEqual(PARSED_NO_OUTPUT.error)
  })

  it('reports auth from stderr when the exit is non-zero and the parser saw no error', () => {
    const done = reconcileDone(PARSED_OK, ran({ exitCode: 1 }), ['Error: please run claude login'])

    expect(done.error).toEqual({ kind: 'auth', message: 'Error: please run claude login' })
  })

  it('reports exit with the last stderr line when the exit is non-zero and stderr explains nothing', () => {
    const done = reconcileDone(PARSED_OK, ran({ exitCode: 3 }), [
      'node:internal/process/promises:394',
      'TypeError: Cannot read properties of undefined',
    ])

    expect(done).toEqual({
      ...PARSED_OK,
      exitCode: 3,
      error: { kind: 'exit', message: 'TypeError: Cannot read properties of undefined' },
    })
  })

  it('reports a null exit code and an exit error when a signal ended the process unasked', () => {
    const done = reconcileDone(PARSED_OK, ran({ exitCode: null, signal: 'SIGSEGV' }), [])

    expect(done.exitCode).toBe(null)
    expect(done.error?.kind).toBe('exit')
  })
})

// A `claude` shell script on a PATH of its own. It records its argv and
// stdin under `record/` and then runs `body`.
async function installClaude(body: string): Promise<{ env: NodeJS.ProcessEnv; record: string }> {
  const bin = path.join(tmp.dir, 'bin')
  const record = path.join(tmp.dir, 'record')
  await mkdir(bin)
  await mkdir(record)
  const file = path.join(bin, 'claude')
  await writeFile(
    file,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$@" > '${record}/argv'`,
      `cat > '${record}/stdin'`,
      body,
      '',
    ].join('\n'),
  )
  await chmod(file, 0o755)
  return { env: { PATH: `${bin}:/usr/bin:/bin` }, record }
}

function stdoutLines(lines: readonly string[]): string {
  return `cat <<'EOF'\n${lines.join('\n')}\nEOF`
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

const STREAM = [
  JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: SESSION_ID,
    model: 'claude-opus-4-1',
  }),
  JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'No regressions' } },
  }),
  JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: 'No regressions found in the diff.' }],
      usage: { input_tokens: 3, output_tokens: 40, cache_read_input_tokens: 12_000 },
    },
  }),
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'No regressions found in the diff.',
    usage: { input_tokens: 3, output_tokens: 40, cache_read_input_tokens: 12_000 },
  }),
]

describe('running a claude turn', () => {
  it('forwards parsed events and ends with one done holding the reply and exit code 0', async () => {
    const { env } = await installClaude(`${stdoutLines(STREAM)}\nexit 0`)

    const events = await collect(claudeAdapter.spawn(request({ env })).events)

    expect(events.filter((e) => e.kind !== 'raw')).toEqual([
      { kind: 'delta', text: 'No regressions' },
      { kind: 'text', text: 'No regressions found in the diff.' },
      {
        kind: 'done',
        reply: 'No regressions found in the diff.',
        exitCode: 0,
        usage: { input: 3, output: 40, cache_read: 12_000, context: 12_003 },
      },
    ])
    expect(events.filter((e) => e.kind === 'raw').map((e) => e.line)).toEqual(STREAM)
  })

  it('writes the message to stdin as one stream-json line and closes stdin', async () => {
    const { env, record } = await installClaude(`${stdoutLines(STREAM)}\nexit 0`)
    const message = 'Review the diff against main.\n\nFocus on src/cart/total.ts.'

    await collect(claudeAdapter.spawn(request({ env, message })).events)

    // `cat` returned, so stdin was closed after the line.
    expect(await readFile(path.join(record, 'stdin'), 'utf8')).toBe(stdinMessage(message))
  })

  it('passes the session id and the staged persona file when the session is new', async () => {
    const { env, record } = await installClaude(`${stdoutLines(STREAM)}\nexit 0`)
    const req = request({ env, persona: PERSONA })

    await collect(claudeAdapter.spawn(req).events)

    const argv = (await readFile(path.join(record, 'argv'), 'utf8')).split('\n')
    const personaFile = path.join(req.stagingDir, 'persona.md')
    expect(argv[argv.indexOf('--session-id') + 1]).toBe(SESSION_ID)
    expect(argv[argv.indexOf('--append-system-prompt-file') + 1]).toBe(personaFile)
    expect(await readFile(personaFile, 'utf8')).toBe(PERSONA)
    expect(await listing(req.stagingDir)).toEqual(['persona.md'])
  })

  it('emits stderr lines as raw with a stderr prefix when claude writes to stderr', async () => {
    const { env } = await installClaude(
      `${stdoutLines(STREAM)}\necho 'Warning: settings.json has an unknown key' >&2\nexit 0`,
    )

    const events = await collect(claudeAdapter.spawn(request({ env })).events)

    expect(events).toContainEqual({
      kind: 'raw',
      line: 'stderr: Warning: settings.json has an unknown key',
    })
    expect(events.at(-1)).toMatchObject({ kind: 'done', exitCode: 0 })
    expect(events.at(-1)).not.toHaveProperty('error')
  })

  it('ends with auth from stderr when stdout is empty and stderr says not logged in', async () => {
    const { env } = await installClaude(`echo 'Error: not logged in' >&2\nexit 1`)

    const events = await collect(claudeAdapter.spawn(request({ env })).events)

    expect(events.filter((e) => e.kind === 'done')).toEqual([
      {
        kind: 'done',
        reply: '',
        exitCode: 1,
        error: { kind: 'auth', message: 'Error: not logged in' },
      },
    ])
    expect(events.at(-1)?.kind).toBe('done')
  })

  it('ends with one done saying exit and a null exit code when claude is not on PATH', async () => {
    const events = await collect(
      claudeAdapter.spawn(request({ env: { PATH: path.join(tmp.dir, 'empty') } })).events,
    )

    expect(events).toEqual([
      {
        kind: 'done',
        reply: '',
        exitCode: null,
        error: { kind: 'exit', message: expect.stringContaining('claude') },
      },
    ])
  })

  it('ends with one done saying killed when kill() is called mid-turn', {
    timeout: 15_000,
  }, async () => {
    const sleep = `30.${randomInt(100_000, 999_999)}`
    const { env } = await installClaude(`${stdoutLines(STREAM.slice(0, 2))}\nexec sleep ${sleep}`)
    const proc = claudeAdapter.spawn(request({ env }))
    const events: AgentEvent[] = []

    try {
      for await (const event of proc.events) {
        events.push(event)
        if (event.kind === 'delta') proc.kill()
      }
    } finally {
      await killProcessesWithArgs(`sleep ${sleep}`)
    }

    const dones = events.filter((e) => e.kind === 'done')
    expect(dones).toEqual([
      { kind: 'done', reply: '', exitCode: null, error: { kind: 'exit', message: 'killed' } },
    ])
    expect(events.at(-1)?.kind).toBe('done')
  })

  it('ends with one done saying timed out when the turn outlasts timeoutMs', {
    timeout: 15_000,
  }, async () => {
    const sleep = `30.${randomInt(100_000, 999_999)}`
    const { env } = await installClaude(`exec sleep ${sleep}`)

    try {
      const events = await collect(claudeAdapter.spawn(request({ env, timeoutMs: 300 })).events)

      expect(events).toEqual([
        { kind: 'done', reply: '', exitCode: null, error: { kind: 'exit', message: 'timed out' } },
      ])
    } finally {
      await killProcessesWithArgs(`sleep ${sleep}`)
    }
  })
})
