import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest'
import { killProcessesWithArgs, processesWithArgs } from '../../testing/processes.js'
import { type TmpDir, tmpDir } from '../../testing/tmpRepo.js'
import { childEnv } from './env.js'
import { runShutdown } from './shutdown.js'
import { liveProcessGroups, spawnProcess } from './spawn.js'

// runShutdown() runs once per process, so this test has a file, and with
// it a vitest worker, of its own. The sleep's duration is unique to it.
const SLEEP = 'sleep 30.6211'

let dir: TmpDir

beforeEach(async () => {
  dir = await tmpDir('rensa-spawn-shutdown-')
})

afterEach(async () => {
  await killProcessesWithArgs(SLEEP)
  await dir.cleanup()
})

describe('shutdown kill', () => {
  it('SIGKILLs a live child group when runShutdown() runs', async () => {
    const child = spawnProcess({
      argv: SLEEP.split(' '),
      cwd: dir.dir,
      env: childEnv(process.env, { allowApiKeys: false }),
      timeoutMs: 60_000,
    })
    assert(child.pid !== undefined, 'spawn failed')
    await vi.waitFor(async () => expect(await processesWithArgs(SLEEP)).toHaveLength(1), {
      timeout: 5_000,
    })
    const registeredBefore = liveProcessGroups.has(child.pid)

    runShutdown()
    const result = await child.result

    expect([registeredBefore, result.signal]).toEqual([true, 'SIGKILL'])
    await vi.waitFor(async () => expect(await processesWithArgs(SLEEP)).toHaveLength(0), {
      timeout: 5_000,
    })
  })
})
