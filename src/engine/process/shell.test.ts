import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { killProcessesWithArgs, processesWithArgs } from '../../testing/processes.js'
import { type TmpDir, tmpDir } from '../../testing/tmpRepo.js'
import { childEnv } from './env.js'
import { runShellStep } from './shell.js'
import { KillSignal } from './spawn.js'

// Unique durations, so ps and the cleanup match only this file's sleeps.
const TIMEOUT_SLEEP = 'sleep 30.6311'
const KILLED_SLEEP = 'sleep 30.6317'

let dir: TmpDir

beforeEach(async () => {
  dir = await tmpDir('rensa-shell-')
})

afterEach(async () => {
  await killProcessesWithArgs(TIMEOUT_SLEEP)
  await killProcessesWithArgs(KILLED_SLEEP)
  await dir.cleanup()
})

function outputPath(): string {
  return path.join(dir.dir, 'steps', 'test', 'output.txt')
}

function run(command: string, overrides: { timeoutMs?: number; signal?: KillSignal } = {}) {
  const lines: string[] = []
  const result = runShellStep({
    command,
    cwd: dir.dir,
    env: childEnv(process.env, { allowApiKeys: false, extra: { RENSA_STEP: 'test' } }),
    timeoutMs: overrides.timeoutMs ?? 30_000,
    outputPath: outputPath(),
    onLine: (line) => lines.push(line),
    signal: overrides.signal ?? new KillSignal(),
  })
  return { lines, result }
}

describe('status mapping', () => {
  it('reports ok with exit code 0 when the command succeeds', async () => {
    const result = await run("printf 'PASS src/cart.test.ts\\n'").result

    expect([result.status, result.exitCode, result.signal]).toEqual(['ok', 0, null])
  })

  it('reports failed with the exit code when the command exits non-zero', async () => {
    const result = await run("printf 'FAIL src/cart.test.ts\\n'; exit 3").result

    expect([result.status, result.exitCode]).toEqual(['failed', 3])
  })

  it('reports timeout when the command outlives timeoutMs', async () => {
    const result = await run(TIMEOUT_SLEEP, { timeoutMs: 200 }).result

    expect([result.status, result.exitCode, result.signal]).toEqual(['timeout', null, 'SIGTERM'])
  })

  it('reports killed when the signal is killed while the command runs', async () => {
    const signal = new KillSignal()
    const { result } = run(KILLED_SLEEP, { signal })
    await vi.waitFor(async () => expect(await processesWithArgs(KILLED_SLEEP)).toHaveLength(1), {
      timeout: 5_000,
    })

    signal.kill()

    expect((await result).status).toBe('killed')
  })

  it('reports killed when the signal was killed before the step started', async () => {
    const signal = new KillSignal()
    signal.kill()

    const result = await run(KILLED_SLEEP, { signal }).result

    expect(result.status).toBe('killed')
  })
})

describe('combined output', () => {
  // The pauses fix the arrival order across the two pipes.
  const COMMAND =
    "printf 'compiling\\n'; sleep 0.2; printf 'warning: unused import\\n' >&2; sleep 0.2; printf 'done'"
  const LINES = ['compiling', 'warning: unused import', 'done']

  it('calls onLine for stdout and stderr lines in arrival order', async () => {
    const { lines, result } = run(COMMAND)
    await result

    expect(lines).toEqual(LINES)
  })

  it('writes the same lines, newline-terminated, to the output file and to output', async () => {
    const result = await run(COMMAND).result

    const expected = 'compiling\nwarning: unused import\ndone\n'
    expect([await readFile(outputPath(), 'utf8'), result.output, result.outputPath]).toEqual([
      expected,
      expected,
      outputPath(),
    ])
  })

  it('replaces earlier content when the output file already exists', async () => {
    await run("printf 'first attempt\\n'").result

    await run("printf 'second attempt\\n'").result

    expect(await readFile(outputPath(), 'utf8')).toBe('second attempt\n')
  })

  it('leaves an empty output file when the command prints nothing', async () => {
    const result = await run('true').result

    expect([await readFile(outputPath(), 'utf8'), result.output, result.status]).toEqual([
      '',
      '',
      'ok',
    ])
  })
})

describe('environment', () => {
  it('runs the command with the given env when the env carries extra variables', async () => {
    const { lines, result } = run('printf \'%s %s\\n\' "$RENSA_STEP" "$NO_COLOR"')
    await result

    expect(lines).toEqual(['test 1'])
  })
})

describe('large output', () => {
  it('writes all 100,000 lines of a verbose command to the output file within 3 s', async () => {
    const expected = Array.from(
      { length: 100_000 },
      (_, i) => `line ${String(i + 1).padStart(6, '0')} of verbose build\n`,
    ).join('')
    const started = Date.now()

    const result = await run("seq -f 'line %06g of verbose build' 100000").result
    const elapsedMs = Date.now() - started

    expect(result.status).toBe('ok')
    expect(await readFile(outputPath(), 'utf8')).toBe(expected)
    // The command itself takes milliseconds. Writing the output file one
    // appendFile per line took 6.6 s; batched, it takes a fraction of a
    // second. The bound sits well above that so a loaded runner passes,
    // and below the per-line cost so that regression fails.
    expect(elapsedMs).toBeLessThan(3_000)
  })
})
