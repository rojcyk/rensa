import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type TmpDir, tmpDir } from '../../testing/tmpRepo.js'
import { captureFixture } from './capture.js'
import { ARGV_TEXT_LIMIT_BYTES } from './grok/argv.js'

// `rensa capture grok` against a stand-in `grok` script: the command line
// written to `meta.json` must be the one the adapter actually ran.

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
