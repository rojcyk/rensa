import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type TmpDir, tmpDir } from '../../testing/tmpRepo.js'
import { runShutdown } from '../process/shutdown.js'
import { acquireLock, lockPath } from './lock.js'

// runShutdown() runs once per process, so this test has a file, and with
// it a vitest worker, of its own.

let dir: TmpDir

beforeEach(async () => {
  dir = await tmpDir('rensa-lock-shutdown-')
})

afterEach(async () => {
  await dir.cleanup()
})

describe('lock release on shutdown', () => {
  it('removes a held lock and leaves a lock that carries another token when runShutdown() runs', async () => {
    const heldDir = path.join(dir.dir, 'held', '.rensa')
    const replacedDir = path.join(dir.dir, 'replaced', '.rensa')
    await mkdir(heldDir, { recursive: true })
    await mkdir(replacedDir, { recursive: true })
    const held = await acquireLock(heldDir, 'review-20261102-1430-a1b2')
    const replaced = await acquireLock(replacedDir, 'fix-20261102-1431-c3d4')
    const foreign = `${JSON.stringify({ pid: process.pid, token: 'other-acquisition-5e6f', run_id: 'fix-20261102-1432-e5f6', started_at: '2026-11-02T14:32:00.000Z' })}\n`
    await writeFile(replaced.path, foreign)

    runShutdown()

    expect(existsSync(held.path)).toBe(false)
    expect(await readFile(lockPath(replacedDir), 'utf8')).toBe(foreign)
  })
})
