import { randomInt } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { killProcessesWithArgs } from '../../../testing/processes.js'
import { type TmpDir, tmpDir } from '../../../testing/tmpRepo.js'
import type { AgentEvent, SpawnRequest } from '../types.js'
import { ARGV_TEXT_LIMIT_BYTES, buildArgv, stagedPromptFor } from './argv.js'
import { grokAdapter, stagePrompt } from './index.js'

const SESSION_ID = '5b1e7c42-9d3a-4f6e-8a21-c07d9e4b3f18'
const MESSAGE = 'Review the diff against main and list any regressions.'
const PERSONA = '# Reviewer\n\nYou review diffs for regressions. Be terse and cite file:line.\n'
const NOT_SIGNED_IN =
  'Not signed in. To authenticate without a browser, run:\n  grok login --device-code ...'

let tmp: TmpDir

beforeEach(async () => {
  tmp = await tmpDir('rensa-grok-adapter-')
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
    session: { id: SESSION_ID, resume: false },
    stagingDir: path.join(tmp.dir, 'runs', 'r_8c1d2e', 'agents', 'review', 'grok'),
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

const LONG_MESSAGE = `Review this diff:\n\n${'+ const total = sum(items)\n'.repeat(4000)}`
const LONG_PERSONA = `# Reviewer\n\n${'Cite file:line for every finding.\n'.repeat(3100)}`

describe('staging the prompt', () => {
  it('writes nothing and returns no file when the prompt fits argv', async () => {
    const req = request()

    const staged = await stagePrompt(req)

    expect(staged).toEqual({})
    expect(await listing(tmp.dir)).toEqual([])
  })

  it('writes the message to message.md and returns its path when the message is over the argv limit', async () => {
    const req = request({ message: LONG_MESSAGE })

    const staged = await stagePrompt(req)

    const file = path.join(req.stagingDir, 'message.md')
    expect(staged).toEqual({ messageFile: file })
    expect(await readFile(file, 'utf8')).toBe(LONG_MESSAGE)
    expect(await listing(req.stagingDir)).toEqual(['message.md'])
    expect(await listing(tmp.dir)).toEqual(['runs'])
  })

  it('writes the persona and message under # Role and # Task when the persona is over the argv limit', async () => {
    const req = request({ persona: LONG_PERSONA })

    await stagePrompt(req)

    expect(await readFile(path.join(req.stagingDir, 'message.md'), 'utf8')).toBe(
      `# Role\n\n${LONG_PERSONA}\n\n# Task\n\n${MESSAGE}`,
    )
  })

  it('writes nothing when the persona is over the argv limit but the session is resumed', async () => {
    const req = request({ persona: LONG_PERSONA, session: { id: SESSION_ID, resume: true } })

    expect(await stagePrompt(req)).toEqual({})
    expect(await listing(tmp.dir)).toEqual([])
  })
})

// A `grok` shell script on a PATH of its own. It records its argv
// (NUL-separated) and a copy of any `--prompt-file` under `record/`,
// then runs `body`.
async function installGrok(body: string): Promise<{ env: NodeJS.ProcessEnv; record: string }> {
  const bin = path.join(tmp.dir, 'bin')
  const record = path.join(tmp.dir, 'record')
  await mkdir(bin)
  await mkdir(record)
  const file = path.join(bin, 'grok')
  await writeFile(
    file,
    [
      '#!/bin/sh',
      `printf '%s\\0' "$@" > '${record}/argv'`,
      'for a in "$@"; do',
      '  case "$a" in',
      `    --prompt-file=*) cp "\${a#--prompt-file=}" '${record}/prompt' ;;`,
      '  esac',
      'done',
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
  JSON.stringify({ type: 'text', data: 'No regressions' }),
  JSON.stringify({ type: 'text', data: ' found in the diff.' }),
  JSON.stringify({
    type: 'usage',
    usage: { input_tokens: 3, output_tokens: 40, cache_read_input_tokens: 12_000 },
  }),
  JSON.stringify({ type: 'end', stopReason: 'end_turn', sessionId: SESSION_ID }),
]

describe('running a grok turn', () => {
  it('forwards parsed events and ends with one done holding the reply and exit code 0', async () => {
    const { env } = await installGrok(`${stdoutLines(STREAM)}\nexit 0`)

    const events = await collect(grokAdapter.spawn(request({ env })).events)

    const usage = { input: 3, output: 40, cache_read: 12_000, context: 12_003 }
    expect(events.filter((e) => e.kind !== 'raw')).toEqual([
      { kind: 'delta', text: 'No regressions' },
      { kind: 'delta', text: ' found in the diff.' },
      { kind: 'text', text: 'No regressions found in the diff.' },
      { kind: 'usage', usage },
      { kind: 'done', reply: 'No regressions found in the diff.', exitCode: 0, usage },
    ])
    expect(events.filter((e) => e.kind === 'raw').map((e) => e.line)).toEqual(STREAM)
  })

  it('runs the command line buildArgv gives and stages nothing when the prompt fits argv', async () => {
    const { env, record } = await installGrok(`${stdoutLines(STREAM)}\nexit 0`)
    const req = request({ env, persona: PERSONA, model: 'grok-4.1-fast', effort: 'max' })

    await collect(grokAdapter.spawn(req).events)

    expect(await recordedArgv(record)).toEqual(buildArgv(req, stagedPromptFor(req)).slice(1))
    expect(await listing(req.stagingDir)).toEqual([])
  })

  it('passes the message in a staged file with --prompt-file when it is over the argv limit', async () => {
    const { env, record } = await installGrok(`${stdoutLines(STREAM)}\nexit 0`)
    const req = request({ env, message: LONG_MESSAGE })

    await collect(grokAdapter.spawn(req).events)

    const argv = await recordedArgv(record)
    expect(argv).toEqual(buildArgv(req, stagedPromptFor(req)).slice(1))
    expect(argv).toContain(`--prompt-file=${path.join(req.stagingDir, 'message.md')}`)
    expect(Buffer.byteLength(LONG_MESSAGE)).toBeGreaterThan(ARGV_TEXT_LIMIT_BYTES)
    expect(await readFile(path.join(record, 'prompt'), 'utf8')).toBe(LONG_MESSAGE)
  })

  it('emits stderr lines as raw with a stderr prefix when grok writes to stderr', async () => {
    const { env } = await installGrok(
      `${stdoutLines(STREAM)}\necho 'warning: config.toml has an unknown key' >&2\nexit 0`,
    )

    const events = await collect(grokAdapter.spawn(request({ env })).events)

    expect(events).toContainEqual({
      kind: 'raw',
      line: 'stderr: warning: config.toml has an unknown key',
    })
    expect(events.at(-1)).toMatchObject({ kind: 'done', exitCode: 0 })
    expect(events.at(-1)).not.toHaveProperty('error')
  })

  it('ends with auth when grok prints the observed not-signed-in error and exits 1', async () => {
    const errorLine = JSON.stringify({ type: 'error', message: NOT_SIGNED_IN })
    const { env } = await installGrok(
      `${stdoutLines([errorLine])}\necho 'Error: Not signed in. To authenticate without a browser, run:' >&2\nexit 1`,
    )

    const events = await collect(grokAdapter.spawn(request({ env })).events)

    expect(events.filter((e) => e.kind === 'done')).toEqual([
      { kind: 'done', reply: '', exitCode: 1, error: { kind: 'auth', message: NOT_SIGNED_IN } },
    ])
    expect(events.at(-1)?.kind).toBe('done')
  })

  it('ends with auth from stderr when stdout is empty and stderr says not signed in', async () => {
    const { env } = await installGrok(`echo 'Error: Not signed in.' >&2\nexit 1`)

    const events = await collect(grokAdapter.spawn(request({ env })).events)

    expect(events.at(-1)).toEqual({
      kind: 'done',
      reply: '',
      exitCode: 1,
      error: { kind: 'auth', message: 'Error: Not signed in.' },
    })
  })

  it('ends with one done saying exit and a null exit code when grok is not on PATH', async () => {
    const events = await collect(
      grokAdapter.spawn(request({ env: { PATH: path.join(tmp.dir, 'empty') } })).events,
    )

    expect(events).toEqual([
      {
        kind: 'done',
        reply: '',
        exitCode: null,
        error: { kind: 'exit', message: expect.stringContaining('grok') },
      },
    ])
  })

  it('ends with one done saying exit and starts no process when the prompt cannot be staged', async () => {
    const { env, record } = await installGrok(`${stdoutLines(STREAM)}\nexit 0`)
    const blocker = path.join(tmp.dir, 'not-a-dir')
    await writeFile(blocker, '')
    const req = request({ env, message: LONG_MESSAGE, stagingDir: path.join(blocker, 'grok') })

    const events = await collect(grokAdapter.spawn(req).events)

    expect(events).toEqual([
      {
        kind: 'done',
        reply: '',
        exitCode: null,
        error: { kind: 'exit', message: expect.any(String) },
      },
    ])
    expect(await listing(record)).toEqual([])
  })

  it('ends with one done saying killed when kill() is called mid-turn', {
    timeout: 15_000,
  }, async () => {
    const sleep = `30.${randomInt(100_000, 999_999)}`
    const { env } = await installGrok(`${stdoutLines(STREAM.slice(0, 1))}\nexec sleep ${sleep}`)
    const proc = grokAdapter.spawn(request({ env }))
    const events: AgentEvent[] = []

    try {
      for await (const event of proc.events) {
        events.push(event)
        if (event.kind === 'delta') proc.kill()
      }
    } finally {
      await killProcessesWithArgs(`sleep ${sleep}`)
    }

    expect(events.filter((e) => e.kind === 'done')).toEqual([
      { kind: 'done', reply: '', exitCode: null, error: { kind: 'exit', message: 'killed' } },
    ])
    expect(events.at(-1)?.kind).toBe('done')
    expect(proc.pid).toEqual(expect.any(Number))
  })

  it('ends with one done saying timed out when the turn outlasts timeoutMs', {
    timeout: 15_000,
  }, async () => {
    const sleep = `30.${randomInt(100_000, 999_999)}`
    const { env } = await installGrok(`exec sleep ${sleep}`)

    try {
      const events = await collect(grokAdapter.spawn(request({ env, timeoutMs: 300 })).events)

      expect(events).toEqual([
        { kind: 'done', reply: '', exitCode: null, error: { kind: 'exit', message: 'timed out' } },
      ])
    } finally {
      await killProcessesWithArgs(`sleep ${sleep}`)
    }
  })
})
