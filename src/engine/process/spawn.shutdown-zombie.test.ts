import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest'
import { blockUntilZombie } from '../../testing/processes.js'
import { type TmpDir, tmpDir } from '../../testing/tmpRepo.js'
import { childEnv } from './env.js'
import { runShutdown } from './shutdown.js'
import { liveProcessGroups, spawnProcess } from './spawn.js'

// runShutdown() runs once per process, so this test has a file, and with
// it a vitest worker, of its own.

// shutdown.ts reports a failed callback through a synchronous write to
// fd 2; capture it so the absence of a report can be asserted.
const stderrWrites = vi.hoisted((): string[] => [])
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return {
    ...fs,
    writeSync: (fd: number, text: string): number => {
      if (fd !== 2) return fs.writeSync(fd, text)
      stderrWrites.push(text)
      return text.length
    },
  }
})

let dir: TmpDir

beforeEach(async () => {
  dir = await tmpDir('rensa-spawn-zombie-')
})

afterEach(async () => {
  await dir.cleanup()
})

describe('shutdown kill of a zombie-only group', () => {
  it('reports no failed callback when runShutdown() meets a child that exited unreaped', async () => {
    const child = spawnProcess({
      argv: ['true'],
      cwd: dir.dir,
      env: childEnv(process.env, { allowApiKeys: false }),
      timeoutMs: 60_000,
    })
    assert(child.pid !== undefined, 'spawn failed')
    blockUntilZombie(child.pid)
    // Precondition: the shutdown kill will signal this group.
    const registered = liveProcessGroups.has(child.pid)

    // Same tick as the block: the zombie is still unreaped here, as it is
    // when a crash or a second ctrl+c exits right after a child ended.
    runShutdown()
    const result = await child.result

    expect(registered).toBe(true)
    expect(stderrWrites).toEqual([])
    expect(result.exitCode).toBe(0)
  })
})
