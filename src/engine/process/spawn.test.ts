import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  killProcessesWithArgs,
  processesWithArgs,
  processGroupOf,
} from '../../testing/processes.js'
import { type TmpDir, tmpDir } from '../../testing/tmpRepo.js'
import { RensaError } from '../errors.js'
import { childEnv } from './env.js'
import { KillSignal, liveProcessGroups, type SpawnOptions, spawnProcess } from './spawn.js'

// Every sleep below has its own unlikely duration, so `ps` and the cleanup
// match only this test's processes, never another file's running in parallel.
const TIMEOUT_SLEEP = 'sleep 10.6131'
const BACKGROUND_SLEEP = 'sleep 30.6137'
const TERM_IGNORING_SLEEP = 'sleep 30.6143'
const ESCAPED_SLEEP = 'sleep 30.6151'
const KILLED_SLEEP = 'sleep 30.6157'
const ALL_SLEEPS = [
  TIMEOUT_SLEEP,
  BACKGROUND_SLEEP,
  TERM_IGNORING_SLEEP,
  ESCAPED_SLEEP,
  KILLED_SLEEP,
]

let dir: TmpDir

beforeEach(async () => {
  dir = await tmpDir('rensa-spawn-')
})

afterEach(async () => {
  for (const args of ALL_SLEEPS) await killProcessesWithArgs(args)
  await dir.cleanup()
})

function options(overrides: Partial<SpawnOptions> & Pick<SpawnOptions, 'argv'>): SpawnOptions {
  return {
    cwd: dir.dir,
    env: childEnv(process.env, { allowApiKeys: false }),
    timeoutMs: 30_000,
    ...overrides,
  }
}

const sh = (script: string): string[] => ['/bin/sh', '-c', script]

/** Waits until exactly `count` processes run with the command line `args`. */
async function waitForProcesses(args: string, count: number) {
  return vi.waitFor(
    async () => {
      const found = await processesWithArgs(args)
      expect(found).toHaveLength(count)
      return found
    },
    { timeout: 5_000, interval: 25 },
  )
}

async function waitUntilGone(args: string): Promise<void> {
  await waitForProcesses(args, 0)
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('reading output', () => {
  it('yields every line including the unterminated last one when in line mode', async () => {
    const lines: string[] = []

    const child = spawnProcess(
      options({ argv: ['printf', 'a\\nb'], onStdout: (line) => lines.push(line) }),
    )
    const result = await child.result

    expect(lines).toEqual(['a', 'b'])
    expect(result).toMatchObject({ exitCode: 0, signal: null, timedOut: false, killed: false })
  })

  it('delivers stdout and stderr to their own callbacks when both are in line mode', async () => {
    const stdout: string[] = []
    const stderr: string[] = []

    await spawnProcess(
      options({
        argv: sh("printf 'PASS src/cart.test.ts\\n'; printf 'warning: slow test\\n' >&2"),
        onStdout: (line) => stdout.push(line),
        onStderr: (line) => stderr.push(line),
      }),
    ).result

    expect([stdout, stderr]).toEqual([['PASS src/cart.test.ts'], ['warning: slow test']])
  })

  it('delivers the exact bytes including \\r and the trailing newline when in raw mode', async () => {
    const chunks: Buffer[] = []

    await spawnProcess(
      options({ argv: ['printf', 'one\\r\\ntwo\\n\\n'], onStdoutChunk: (c) => chunks.push(c) }),
    ).result

    expect(Buffer.concat(chunks).toString('utf8')).toBe('one\r\ntwo\n\n')
  })

  it('reports the exit code when the process exits non-zero', async () => {
    const result = await spawnProcess(options({ argv: sh('exit 7') })).result

    expect([result.exitCode, result.signal]).toEqual([7, null])
  })

  it('throws INTERNAL when one stream is given both a line and a chunk callback', () => {
    const call = () =>
      spawnProcess(options({ argv: ['true'], onStdout: () => {}, onStdoutChunk: () => {} }))

    expect(call).toThrow(expect.objectContaining({ code: 'INTERNAL' }))
  })
})

describe('stdin', () => {
  it('writes the given text then closes stdin when stdin is set', async () => {
    const lines: string[] = []

    await spawnProcess(
      options({
        argv: ['cat'],
        stdin: 'Review the diff\nfor src/cart.ts\n',
        onStdout: (line) => lines.push(line),
      }),
    ).result

    expect(lines).toEqual(['Review the diff', 'for src/cart.ts'])
  })

  it('closes stdin at once when stdin is absent', async () => {
    const lines: string[] = []

    const result = await spawnProcess(
      options({ argv: sh("cat; printf 'after-eof'"), onStdout: (line) => lines.push(line) }),
    ).result

    expect([lines, result.timedOut]).toEqual([['after-eof'], false])
  })
})

describe('spawn failures', () => {
  it('rejects with PROCESS naming the binary when it does not exist', async () => {
    const child = spawnProcess(options({ argv: ['rensa-no-such-binary-4f1c', '--version'] }))

    const err = await child.result.catch((e: unknown) => e)

    assert(err instanceof RensaError, `expected RensaError, got ${String(err)}`)
    expect([err.code, err.message, child.pid]).toEqual([
      'PROCESS',
      expect.stringContaining('rensa-no-such-binary-4f1c'),
      undefined,
    ])
  })

  it('rejects with PROCESS naming the directory when cwd does not exist', async () => {
    const missing = `${dir.dir}/checkout-gone`

    const err = await spawnProcess(options({ argv: ['true'], cwd: missing })).result.catch(
      (e: unknown) => e,
    )

    assert(err instanceof RensaError, `expected RensaError, got ${String(err)}`)
    expect([err.code, err.message]).toEqual(['PROCESS', expect.stringContaining(missing)])
  })

  it('throws INTERNAL when argv is empty', () => {
    expect(() => spawnProcess(options({ argv: [] }))).toThrow(
      expect.objectContaining({ code: 'INTERNAL' }),
    )
  })
})

describe('timeout', () => {
  it('kills the process and reports timedOut when it outlives timeoutMs', async () => {
    const started = Date.now()

    const result = await spawnProcess(
      options({ argv: TIMEOUT_SLEEP.split(' '), timeoutMs: 200, escalateMs: 200 }),
    ).result

    expect(result).toMatchObject({ timedOut: true, killed: true, signal: 'SIGTERM' })
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})

describe('killing the process group', () => {
  it('kills a background grandchild of the shell when kill() is called', async () => {
    const child = spawnProcess(options({ argv: sh(`${BACKGROUND_SLEEP} & wait`) }))
    await waitForProcesses(BACKGROUND_SLEEP, 1)

    child.kill()
    const result = await child.result

    expect(result.killed).toBe(true)
    await waitUntilGone(BACKGROUND_SLEEP)
  })

  it('reports killed without timedOut when kill() is called before the timeout', async () => {
    const child = spawnProcess(options({ argv: KILLED_SLEEP.split(' ') }))
    await waitForProcesses(KILLED_SLEEP, 1)

    child.kill()
    const result = await child.result

    expect(result).toMatchObject({ killed: true, timedOut: false, signal: 'SIGTERM' })
  })

  it('escalates to SIGKILL for a TERM-ignoring grandchild when the leader exits first', async () => {
    // The leader execs into a plain sleep that dies on SIGTERM; the
    // background subshell ignores SIGTERM, which survives its exec.
    const script = `(trap "" TERM; exec ${TERM_IGNORING_SLEEP}) & exec ${TERM_IGNORING_SLEEP}`
    const child = spawnProcess(options({ argv: sh(script), escalateMs: 200 }))
    assert(child.pid !== undefined, 'spawn failed')
    const pgid = child.pid
    await waitForProcesses(TERM_IGNORING_SLEEP, 2)

    const killedAt = Date.now()
    child.kill()
    await delay(100)
    const registeredAfter100ms = liveProcessGroups.has(pgid)
    const result = await child.result
    const settledAfterMs = Date.now() - killedAt

    expect(registeredAfter100ms).toBe(true)
    expect(result.killed).toBe(true)
    expect(settledAfterMs).toBeLessThan(1_000)
    await waitUntilGone(TERM_IGNORING_SLEEP)
    await vi.waitFor(() => expect(liveProcessGroups.has(pgid)).toBe(false), { timeout: 3_000 })
  })

  it('settles with killed after the escalation when an escaped process still holds the pipe', async () => {
    // The perl child leaves the group with setsid(), then becomes a sleep
    // that keeps the inherited stdout open after the leader exits.
    const script = `perl -MPOSIX -e 'POSIX::setsid(); exec "sleep", "${ESCAPED_SLEEP.split(' ')[1]}"' & exit 0`
    const child = spawnProcess(options({ argv: sh(script), escalateMs: 200 }))
    assert(child.pid !== undefined, 'spawn failed')
    const pgid = child.pid
    let settled = false
    void child.result.finally(() => {
      settled = true
    })
    const [escaped] = await waitForProcesses(ESCAPED_SLEEP, 1)
    assert(escaped, 'escaped sleep not found')
    // The sleep's command line proves perl got past setsid() to exec, so a
    // group read from now on is the new one.
    const escapedGroup = await processGroupOf(escaped.pid)
    expect(escapedGroup).toBeDefined()
    expect(escapedGroup).not.toBe(pgid)

    const settledBeforeKill = settled
    const killedAt = Date.now()
    child.kill()
    const result = await child.result
    const settledAfterMs = Date.now() - killedAt

    expect(settledBeforeKill).toBe(false)
    expect(result).toMatchObject({ killed: true, timedOut: false })
    expect(settledAfterMs).toBeLessThan(1_500)
    expect(liveProcessGroups.has(pgid)).toBe(false)
    expect(await processesWithArgs(ESCAPED_SLEEP)).toHaveLength(1)
  })
})

describe('live-groups registry', () => {
  it('holds the pgid while the process runs and drops it once the process exits', async () => {
    const child = spawnProcess(options({ argv: ['cat'], stdin: 'hold' }))
    assert(child.pid !== undefined, 'spawn failed')

    const registeredWhileRunning = liveProcessGroups.has(child.pid)
    await child.result

    expect([registeredWhileRunning, liveProcessGroups.has(child.pid)]).toEqual([true, false])
  })
})

describe('kill signals', () => {
  it('runs every registered callback once when kill() is called twice', () => {
    const signal = new KillSignal()
    const calls: string[] = []
    signal.onKill(() => calls.push('shell step'))
    signal.onKill(() => calls.push('var command'))

    signal.kill()
    signal.kill()

    expect([calls, signal.killed]).toEqual([['shell step', 'var command'], true])
  })

  it('runs a callback at once when it is registered after kill()', () => {
    const signal = new KillSignal()
    const calls: string[] = []
    signal.kill()

    signal.onKill(() => calls.push('late step'))

    expect(calls).toEqual(['late step'])
  })

  it('does not run a callback when it was dropped before kill()', () => {
    const signal = new KillSignal()
    const calls: string[] = []
    const drop = signal.onKill(() => calls.push('finished step'))

    drop()
    signal.kill()

    expect(calls).toEqual([])
  })
})
