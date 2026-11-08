import { randomInt } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { killProcessesWithArgs } from '../../../testing/processes.js'
import { type TmpDir, tmpDir } from '../../../testing/tmpRepo.js'
import type { AgentEvent, SpawnRequest } from '../types.js'
import { ARGV_TEXT_LIMIT_BYTES, buildArgv, promptText } from './argv.js'
import { codexAdapter } from './index.js'

// What rensa generated for a new session; Codex ignores it and assigns its own.
const ENGINE_SESSION_ID = '5b1e7c42-9d3a-4f6e-8a21-c07d9e4b3f18'
// The id Codex reports in `thread.started` (codex-cli 0.166.0).
const THREAD_ID = '019a6c3e-7f21-7d40-9b8e-4c2a1f0d5e63'
const MESSAGE = 'Review the diff against main and list any regressions.'
const PERSONA = '# Reviewer\n\nYou review diffs for regressions. Be terse and cite file:line.\n'
// The observed 0.166.0 turn failure without a login (an empty CODEX_HOME).
const UNAUTHORIZED =
  'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://chatgpt.com/backend-api/codex/responses'

let tmp: TmpDir

beforeEach(async () => {
  tmp = await tmpDir('rensa-codex-adapter-')
})

afterEach(async () => {
  await tmp.cleanup()
})

function request(overrides: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    cwd: tmp.dir,
    env: { PATH: '/usr/bin:/bin' },
    message: MESSAGE,
    tools: 'read',
    session: { id: ENGINE_SESSION_ID, resume: false },
    stagingDir: path.join(tmp.dir, 'runs', 'r_8c1d2e', 'agents', 'review', 'codex'),
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

// A `codex` shell script on a PATH of its own. It records its argv
// (NUL-separated) and its stdin under `record/`, then runs `body`.
async function installCodex(body: string): Promise<{ env: NodeJS.ProcessEnv; record: string }> {
  const bin = path.join(tmp.dir, 'bin')
  const record = path.join(tmp.dir, 'record')
  await mkdir(bin)
  await mkdir(record)
  const file = path.join(bin, 'codex')
  await writeFile(
    file,
    [
      '#!/bin/sh',
      `printf '%s\\0' "$@" > '${record}/argv'`,
      `cat > '${record}/stdin'`,
      body,
      '',
    ].join('\n'),
  )
  await chmod(file, 0o755)
  return { env: { PATH: `${bin}:/usr/bin:/bin` }, record }
}

async function recordedArgv(record: string): Promise<string[]> {
  const text = await readFile(path.join(record, 'argv'), 'utf8')
  return text.split('\0').slice(0, -1)
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
  JSON.stringify({ type: 'thread.started', thread_id: THREAD_ID }),
  JSON.stringify({ type: 'turn.started' }),
  JSON.stringify({
    type: 'item.completed',
    item: { id: 'item_0', type: 'agent_message', text: 'No regressions found in the diff.' },
  }),
  JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 12_040, cached_input_tokens: 12_000, output_tokens: 40 },
  }),
]

const LONG_PERSONA = `# Reviewer\n\n${'Cite file:line for every finding.\n'.repeat(3100)}`

describe('the codex adapter capabilities', () => {
  it('offers resume, model, every effort level and both tool modes, with usage as session totals, when asked', () => {
    expect(codexAdapter.capabilities()).toEqual({
      resume: true,
      model: true,
      effort: ['low', 'medium', 'high', 'max'],
      tools: ['read', 'write'],
      usage: 'session_total',
    })
  })
})

describe('running a codex turn', () => {
  it('forwards parsed events and ends with one done holding the reply, usage, exit code 0 and the Codex session id', async () => {
    const { env } = await installCodex(`${stdoutLines(STREAM)}\nexit 0`)

    const events = await collect(codexAdapter.spawn(request({ env })).events)

    const usage = { input: 40, output: 40, cache_read: 12_000 }
    expect(events.filter((e) => e.kind !== 'raw')).toEqual([
      { kind: 'text', text: 'No regressions found in the diff.' },
      { kind: 'usage', usage },
      {
        kind: 'done',
        reply: 'No regressions found in the diff.',
        exitCode: 0,
        usage,
        sessionId: THREAD_ID,
      },
    ])
    expect(events.filter((e) => e.kind === 'raw').map((e) => e.line)).toEqual(STREAM)
  })

  it('runs the command line buildArgv gives and stages nothing when given a persona, model and effort', async () => {
    const { env, record } = await installCodex(`${stdoutLines(STREAM)}\nexit 0`)
    const req = request({ env, persona: PERSONA, model: 'gpt-5.3-codex', effort: 'max' })

    await collect(codexAdapter.spawn(req).events)

    expect(await recordedArgv(record)).toEqual(buildArgv(req).slice(1))
    expect(await listing(req.stagingDir)).toEqual([])
  })

  it('writes the message to stdin and closes it when the session is new', async () => {
    const { env, record } = await installCodex(`${stdoutLines(STREAM)}\nexit 0`)
    const message = 'Review the diff against main.\n\nFocus on src/cart/total.ts.'

    await collect(codexAdapter.spawn(request({ env, message, persona: PERSONA })).events)

    // `cat` returned, so stdin was closed after the message.
    expect(await readFile(path.join(record, 'stdin'), 'utf8')).toBe(message)
  })

  it('sends the persona on stdin under # Role and keeps it out of argv when it is over the argv limit', async () => {
    const { env, record } = await installCodex(`${stdoutLines(STREAM)}\nexit 0`)
    const req = request({ env, persona: LONG_PERSONA })

    await collect(codexAdapter.spawn(req).events)

    expect(Buffer.byteLength(LONG_PERSONA)).toBeGreaterThan(ARGV_TEXT_LIMIT_BYTES)
    expect(await readFile(path.join(record, 'stdin'), 'utf8')).toBe(
      `# Role\n\n${LONG_PERSONA}\n\n# Task\n\n${MESSAGE}`,
    )
    expect((await recordedArgv(record)).filter((arg) => arg.includes('Cite file:line'))).toEqual([])
  })

  it('passes resume with the recorded session id and sends the message alone when the session is resumed', async () => {
    const { env, record } = await installCodex(`${stdoutLines(STREAM)}\nexit 0`)
    const req = request({ env, persona: PERSONA, session: { id: THREAD_ID, resume: true } })

    const events = await collect(codexAdapter.spawn(req).events)

    expect((await recordedArgv(record)).slice(-3)).toEqual(['resume', THREAD_ID, '-'])
    expect(await readFile(path.join(record, 'stdin'), 'utf8')).toBe(promptText(req))
    expect(promptText(req)).toBe(MESSAGE)
    expect(events.at(-1)).toMatchObject({ kind: 'done', sessionId: THREAD_ID })
  })

  it('emits stderr lines as raw with a stderr prefix when codex writes to stderr', async () => {
    const { env } = await installCodex(
      `${stdoutLines(STREAM)}\necho 'Reading prompt from stdin...' >&2\nexit 0`,
    )

    const events = await collect(codexAdapter.spawn(request({ env })).events)

    expect(events).toContainEqual({ kind: 'raw', line: 'stderr: Reading prompt from stdin...' })
    expect(events.at(-1)).toMatchObject({ kind: 'done', exitCode: 0 })
    expect(events.at(-1)).not.toHaveProperty('error')
  })

  it('ends with auth when codex prints the observed 401 turn failure and exits 1', async () => {
    const lines = [
      JSON.stringify({ type: 'thread.started', thread_id: THREAD_ID }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'error', message: UNAUTHORIZED }),
      JSON.stringify({ type: 'turn.failed', error: { message: UNAUTHORIZED } }),
    ]
    const { env } = await installCodex(`${stdoutLines(lines)}\nexit 1`)

    const events = await collect(codexAdapter.spawn(request({ env })).events)

    expect(events.filter((e) => e.kind === 'done')).toEqual([
      {
        kind: 'done',
        reply: '',
        exitCode: 1,
        sessionId: THREAD_ID,
        error: { kind: 'auth', message: UNAUTHORIZED },
      },
    ])
    expect(events.at(-1)?.kind).toBe('done')
  })

  it('ends with auth from stderr when stdout is empty and stderr says not logged in', async () => {
    const { env } = await installCodex(`echo 'Error: Not logged in' >&2\nexit 1`)

    const events = await collect(codexAdapter.spawn(request({ env })).events)

    expect(events.at(-1)).toEqual({
      kind: 'done',
      reply: '',
      exitCode: 1,
      error: { kind: 'auth', message: 'Error: Not logged in' },
    })
  })

  it('ends with no_output when codex exits 0 without turn.completed or turn.failed', async () => {
    const { env } = await installCodex(`${stdoutLines(STREAM.slice(0, 3))}\nexit 0`)

    const events = await collect(codexAdapter.spawn(request({ env })).events)

    expect(events.at(-1)).toMatchObject({
      kind: 'done',
      exitCode: 0,
      error: { kind: 'no_output' },
    })
  })

  it('ends with no_output, exit code 2 and the stderr lines as raw when codex rejects an argument before any output', async () => {
    const { env } = await installCodex(
      `echo "error: unexpected argument '--full-auto' found" >&2\necho 'For more information, try --help.' >&2\nexit 2`,
    )

    const events = await collect(codexAdapter.spawn(request({ env })).events)

    // Rule 3 of Adapter.spawn: the parser's no_output stands unless stderr reads as auth or a usage limit.
    expect(events).toEqual([
      { kind: 'raw', line: "stderr: error: unexpected argument '--full-auto' found" },
      { kind: 'raw', line: 'stderr: For more information, try --help.' },
      {
        kind: 'done',
        reply: '',
        exitCode: 2,
        error: { kind: 'no_output', message: expect.any(String) },
      },
    ])
  })

  it('ends with one done saying exit and a null exit code when codex is not on PATH', async () => {
    const events = await collect(
      codexAdapter.spawn(request({ env: { PATH: path.join(tmp.dir, 'empty') } })).events,
    )

    expect(events).toEqual([
      {
        kind: 'done',
        reply: '',
        exitCode: null,
        error: { kind: 'exit', message: expect.stringContaining('codex') },
      },
    ])
  })

  it('ends with one done saying killed when kill() is called mid-turn', {
    timeout: 15_000,
  }, async () => {
    const sleep = `30.${randomInt(100_000, 999_999)}`
    const { env } = await installCodex(`${stdoutLines(STREAM.slice(0, 3))}\nexec sleep ${sleep}`)
    const proc = codexAdapter.spawn(request({ env }))
    const events: AgentEvent[] = []

    try {
      for await (const event of proc.events) {
        events.push(event)
        if (event.kind === 'text') proc.kill()
      }
    } finally {
      await killProcessesWithArgs(`sleep ${sleep}`)
    }

    expect(events.filter((e) => e.kind === 'done')).toEqual([
      {
        kind: 'done',
        reply: 'No regressions found in the diff.',
        exitCode: null,
        sessionId: THREAD_ID,
        error: { kind: 'exit', message: 'killed' },
      },
    ])
    expect(events.at(-1)?.kind).toBe('done')
  })

  it('ends with one done saying timed out when the turn outlasts timeoutMs', {
    timeout: 15_000,
  }, async () => {
    const sleep = `30.${randomInt(100_000, 999_999)}`
    const { env } = await installCodex(`exec sleep ${sleep}`)

    try {
      const events = await collect(codexAdapter.spawn(request({ env, timeoutMs: 300 })).events)

      expect(events).toEqual([
        { kind: 'done', reply: '', exitCode: null, error: { kind: 'exit', message: 'timed out' } },
      ])
    } finally {
      await killProcessesWithArgs(`sleep ${sleep}`)
    }
  })
})
