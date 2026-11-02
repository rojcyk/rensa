import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest'
import { killProcessesWithArgs, processesWithArgs, processState } from '../../testing/processes.js'
import { type TmpDir, tmpDir } from '../../testing/tmpRepo.js'
import { onShutdown } from '../index.js'
import { childEnv } from './env.js'
import { runShutdown } from './shutdown.js'
import { spawnProcess } from './spawn.js'

// runShutdown() runs once per process, so this test has a file, and with
// it a vitest worker, of its own. Step 08 adds the lock release here.
const SLEEP = 'sleep 30.6223'

let dir: TmpDir

beforeEach(async () => {
  dir = await tmpDir('rensa-shutdown-order-')
})

afterEach(async () => {
  await killProcessesWithArgs(SLEEP)
  await dir.cleanup()
})

describe('shutdown registration order', () => {
  it('runs a consumer callback registered after engine load before the child is killed', async () => {
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
    // Stands in for the TUI's terminal restore, the last registration.
    // A child already SIGKILLed would show as a zombie (Z) here.
    let stateInProbe: string | undefined
    onShutdown(() => {
      stateInProbe = processState(pgid)
    })

    runShutdown()

    expect(stateInProbe).toMatch(/^[SRI]/)
    await vi.waitFor(async () => expect(await processesWithArgs(SLEEP)).toHaveLength(0), {
      timeout: 5_000,
    })
  })
})
