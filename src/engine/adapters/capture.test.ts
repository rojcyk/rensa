import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type TmpDir, tmpDir } from '../../testing/tmpRepo.js'
import { captureFixture } from './capture.js'
import { ARGV_TEXT_LIMIT_BYTES } from './grok/argv.js'

// `rensa capture` against stand-in `grok` and `codex` scripts: the
// command line written to `meta.json` must be the one the adapter
// actually ran.

const VERSION = 'grok 1.0.70 (f50904eaee6c) [stable]'

const STREAM = [
  JSON.stringify({ type: 'text', data: 'Hello from the shop repo.' }),
  JSON.stringify({
    type: 'usage',
    usage: { input_tokens: 7016, output_tokens: 67, cache_read_input_tokens: 2048 },
  }),
  JSON.stringify({ type: 'end', stopReason: 'end_turn' }),
]

let tmp: TmpDir

beforeEach(async () => {
  tmp = await tmpDir('rensa-capture-grok-')
})

afterEach(async () => {
  await tmp.cleanup()
})

/**
 * A logged-in home and a `grok` script on a PATH of its own: `--version`
 * prints the 1.0.70 line; any other call records its argv (NUL-separated)
 * under `record/` and prints `STREAM`.
 */
async function installGrok(): Promise<{ env: NodeJS.ProcessEnv; record: string }> {
  const bin = path.join(tmp.dir, 'bin')
  const record = path.join(tmp.dir, 'record')
  const home = path.join(tmp.dir, 'home')
  await Promise.all([
    mkdir(bin),
    mkdir(record),
    mkdir(path.join(home, '.grok'), { recursive: true }),
  ])
  await writeFile(path.join(home, '.grok', 'auth.json'), '{"refresh_token":"rt_7f3a9c2e"}\n')
  const file = path.join(bin, 'grok')
  await writeFile(
    file,
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then',
      `  echo '${VERSION}'`,
      '  exit 0',
      'fi',
      `printf '%s\\0' "$@" > '${record}/argv'`,
      `cat <<'EOF'\n${STREAM.join('\n')}\nEOF`,
      'exit 0',
      '',
    ].join('\n'),
  )
  await chmod(file, 0o755)
  return { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home }, record }
}

async function recordedArgv(record: string): Promise<string[]> {
  return (await readFile(path.join(record, 'argv'), 'utf8')).split('\0').slice(0, -1)
}

async function metaArgv(dir: string): Promise<string[]> {
  const meta: { argv?: string[] } = JSON.parse(await readFile(path.join(dir, 'meta.json'), 'utf8'))
  return meta.argv ?? []
}

describe('capturing a grok fixture', () => {
  it('records in meta.json the --single command line grok ran when the prompt fits argv', async () => {
    const { env, record } = await installGrok()
    const cwd = path.join(tmp.dir, 'repo')
    await mkdir(cwd)

    const { dir } = await captureFixture({
      provider: 'grok',
      name: 'read-only-hello',
      prompt: 'List the files in this directory and say hello.',
      cwd,
      env,
    })

    const ran = await recordedArgv(record)
    expect(await metaArgv(dir)).toEqual(['grok', ...ran])
    expect(ran).toContain('--single=List the files in this directory and say hello.')
  })

  it('records in meta.json the --prompt-file command line grok ran when the prompt is over the argv limit', async () => {
    const { env, record } = await installGrok()
    const cwd = path.join(tmp.dir, 'repo')
    await mkdir(cwd)
    const prompt = `Summarize this log:\n${'GET /cart 200 12ms\n'.repeat(6000)}`

    const { dir } = await captureFixture({
      provider: 'grok',
      name: 'long-prompt',
      prompt,
      cwd,
      env,
    })

    const ran = await recordedArgv(record)
    expect(Buffer.byteLength(prompt)).toBeGreaterThan(ARGV_TEXT_LIMIT_BYTES)
    expect(await metaArgv(dir)).toEqual(['grok', ...ran])
    expect(ran.filter((arg) => arg.startsWith('--prompt-file='))).toHaveLength(1)
    expect(ran.filter((arg) => arg.startsWith('--single='))).toEqual([])
  })
})

const CODEX_VERSION = 'codex-cli 0.166.0'
const CODEX_THREAD_ID = '019a6c3e-7f21-7d40-9b8e-4c2a1f0d5e63'

const CODEX_STREAM = [
  JSON.stringify({ type: 'thread.started', thread_id: CODEX_THREAD_ID }),
  JSON.stringify({ type: 'turn.started' }),
  JSON.stringify({
    type: 'item.completed',
    item: { id: 'item_0', type: 'agent_message', text: 'Hello from the shop repo.' },
  }),
  JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 9120, cached_input_tokens: 8064, output_tokens: 67 },
  }),
]

/**
 * A `codex` script on a PATH of its own: `--version` prints the 0.166.0
 * line, `login status` says logged in on stderr; any other call records
 * its argv (NUL-separated) and stdin under `record/` and prints `CODEX_STREAM`.
 */
async function installCodex(): Promise<{ env: NodeJS.ProcessEnv; record: string }> {
  const bin = path.join(tmp.dir, 'bin')
  const record = path.join(tmp.dir, 'record')
  await Promise.all([mkdir(bin), mkdir(record)])
  const file = path.join(bin, 'codex')
  await writeFile(
    file,
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then',
      `  echo '${CODEX_VERSION}'`,
      '  exit 0',
      'fi',
      'if [ "$1" = "login" ] && [ "$2" = "status" ]; then',
      "  echo 'Logged in using ChatGPT' >&2",
      '  exit 0',
      'fi',
      `printf '%s\\0' "$@" > '${record}/argv'`,
      `cat > '${record}/stdin'`,
      `cat <<'EOF'\n${CODEX_STREAM.join('\n')}\nEOF`,
      'exit 0',
      '',
    ].join('\n'),
  )
  await chmod(file, 0o755)
  return { env: { PATH: `${bin}:/usr/bin:/bin` }, record }
}

describe('capturing a codex fixture', () => {
  it('records in meta.json the codex exec command line codex ran and sends the prompt on stdin', async () => {
    const { env, record } = await installCodex()
    const cwd = path.join(tmp.dir, 'repo')
    await mkdir(cwd)
    const prompt = 'List the files in this directory and say hello.'

    const { dir } = await captureFixture({
      provider: 'codex',
      name: 'read-only-hello',
      prompt,
      cwd,
      env,
    })

    const ran = await recordedArgv(record)
    expect(await metaArgv(dir)).toEqual(['codex', ...ran])
    expect(ran).toEqual(['exec', '--json', '--cd', cwd, '--sandbox', 'read-only', '-'])
    expect(await readFile(path.join(record, 'stdin'), 'utf8')).toBe(prompt)
  })

  it('writes the session id Codex reported into done.json when the stream starts with thread.started', async () => {
    const { env } = await installCodex()
    const cwd = path.join(tmp.dir, 'repo')
    await mkdir(cwd)

    const { dir } = await captureFixture({
      provider: 'codex',
      name: 'read-only-hello',
      prompt: 'Say hello.',
      cwd,
      env,
    })

    expect(JSON.parse(await readFile(path.join(dir, 'done.json'), 'utf8'))).toEqual({
      exitCode: null,
      sessionId: CODEX_THREAD_ID,
      usage: { input: 9120 - 8064, output: 67, cache_read: 8064 },
    })
  })
})
