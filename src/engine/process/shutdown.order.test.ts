import { existsSync } from 'node:fs'
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest'
import { killProcessesWithArgs, processesWithArgs, processState } from '../../testing/processes.js'
import { type TmpDir, tmpDir } from '../../testing/tmpRepo.js'
import { onShutdown } from '../index.js'
import { acquireLock } from '../run/lock.js'
import { childEnv } from './env.js'
import { runShutdown } from './shutdown.js'
import { spawnProcess } from './spawn.js'

// runShutdown() runs once per process, so this test has a file, and with
// it a vitest worker, of its own. Importing the engine index registers the
// lock release before the child kill, and this test checks the order
// that produces at exit: consumer callback, then the kill, then the lock.
const SLEEP = 'sleep 30.6223'

let dir: TmpDir

beforeEach(async () => {
  dir = await tmpDir('rensa-shutdown-order-')
})

afterEach(async () => {
  vi.restoreAllMocks()
  await killProcessesWithArgs(SLEEP)
  await dir.cleanup()
})

describe('shutdown registration order', () => {
  it('runs a consumer callback, then kills the child while the lock is held, then releases the lock', async () => {
    const lock = await acquireLock(dir.dir, 'review-20261102-1430-a1b2')
    const child = spawnProcess({
      argv: SLEEP.split(' '),
      cwd: dir.dir,
      env: childEnv(process.env, { allowApiKeys: false }),
      timeoutMs: 60_000,
    })
    const pgid = child.pid
    assert(pgid !== undefined, 'spawn failed')
    await vi.waitFor(async () => expect(await processesWithArgs(SLEEP)).toHaveLength(1), {
      timeout: 5_000,
    })
    const order: string[] = []
    let childInProbe: string | undefined
    // Stands in for the TUI's terminal restore, the last registration.
    // A child already SIGKILLed would show as a zombie (Z) here.
    onShutdown(() => {
      childInProbe = processState(pgid)
      order.push(`probe: lock ${existsSync(lock.path)}`)
    })
    const kill = process.kill.bind(process)
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === -pgid && signal === 'SIGKILL')
        order.push(`SIGKILL: lock ${existsSync(lock.path)}`)
      return kill(pid, signal)
    })

    runShutdown()

    expect(order).toEqual(['probe: lock true', 'SIGKILL: lock true'])
    expect(childInProbe).toMatch(/^[SRI]/)
    expect(existsSync(lock.path)).toBe(false)
    await vi.waitFor(async () => expect(await processesWithArgs(SLEEP)).toHaveLength(0), {
      timeout: 5_000,
    })
  })
})
