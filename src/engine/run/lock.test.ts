import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, afterEach, assert, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { deadPid } from '../../testing/processes.js'
import { type TmpDir, tmpDir } from '../../testing/tmpRepo.js'
import { RensaError } from '../errors.js'
import { acquireLock, type Lock, lockPath, recoveryPath } from './lock.js'

const execFileAsync = promisify(execFile)
const ROOT = path.resolve(import.meta.dirname, '../../..')

let dir: TmpDir
/** Locks taken by a test, released afterwards so the module's held set stays clean. */
let taken: Lock[] = []

beforeEach(async () => {
  dir = await tmpDir('rensa-lock-')
})

afterEach(async () => {
  for (const lock of taken) {
    try {
      lock.release()
    } catch {
      // The test may have removed or replaced the file.
    }
  }
  taken = []
  await dir.cleanup()
})

async function acquire(runId: string): Promise<Lock> {
  const lock = await acquireLock(dir.dir, runId)
  taken.push(lock)
  return lock
}

async function writeOwner(file: string, owner: object): Promise<void> {
  await writeFile(file, `${JSON.stringify(owner)}\n`)
}

async function lockedError(promise: Promise<unknown>): Promise<RensaError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  assert(err instanceof RensaError, `expected a RensaError, got ${String(err)}`)
  return err
}

function staleOwner(): object {
  return {
    pid: deadPid(),
    token: '9c4e7a1b-stale',
    run_id: 'review-20261101-0800-5e2f',
    started_at: '2026-11-01T08:00:00.000Z',
  }
}

describe('taking the lock', () => {
  it('writes an owner record with this pid, a token and the run id when no lock exists', async () => {
    const lock = await acquire('review-20261102-1430-a1b2')

    const content = JSON.parse(await readFile(lock.path, 'utf8')) as Record<string, unknown>

    expect(lock.path).toBe(lockPath(dir.dir))
    expect(content).toEqual({
      pid: process.pid,
      token: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-/),
      run_id: 'review-20261102-1430-a1b2',
      started_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    })
  })

  it('refuses with LOCKED naming the run id and pid when a live process holds the lock', async () => {
    const holder = {
      pid: process.pid,
      token: 'live-token-3d1f',
      run_id: 'fix-20261102-1415-77aa',
      started_at: '2026-11-02T14:15:00.000Z',
    }
    await writeOwner(lockPath(dir.dir), holder)

    const err = await lockedError(acquireLock(dir.dir, 'review-20261102-1430-a1b2'))

    expect(err.code).toBe('LOCKED')
    expect(err.message).toContain('fix-20261102-1415-77aa')
    expect(err.message).toContain(`pid ${process.pid}`)
    expect(JSON.parse(await readFile(lockPath(dir.dir), 'utf8'))).toEqual(holder)
  })

  it('replaces the lock and leaves no recovery mutex when the holder pid is dead', async () => {
    await writeOwner(lockPath(dir.dir), staleOwner())

    const lock = await acquire('review-20261102-1430-a1b2')

    const content = JSON.parse(await readFile(lock.path, 'utf8')) as { pid: number; run_id: string }
    expect([content.pid, content.run_id]).toEqual([process.pid, 'review-20261102-1430-a1b2'])
    expect(existsSync(recoveryPath(dir.dir))).toBe(false)
  })

  it('replaces the lock when the file is not an owner record', async () => {
    await writeFile(lockPath(dir.dir), 'not json at all\n')

    const lock = await acquire('review-20261102-1430-a1b2')

    const content = JSON.parse(await readFile(lock.path, 'utf8')) as { run_id: string }
    expect(content.run_id).toBe('review-20261102-1430-a1b2')
  })
})

describe('releasing the lock', () => {
  it('removes the file and does nothing on a second call when release() is called twice', async () => {
    const lock = await acquire('review-20261102-1430-a1b2')

    lock.release()
    lock.release()

    expect(existsSync(lock.path)).toBe(false)
  })

  it('leaves the file in place without throwing when it carries another token', async () => {
    const lock = await acquire('review-20261102-1430-a1b2')
    const other = {
      pid: process.pid,
      token: 'someone-else-8b2c',
      run_id: 'fix-20261102-1431-c3d4',
      started_at: '2026-11-02T14:31:00.000Z',
    }
    await writeOwner(lock.path, other)

    lock.release()

    expect(JSON.parse(await readFile(lock.path, 'utf8'))).toEqual(other)
  })
})

describe('the recovery mutex', () => {
  it('refuses with LOCKED naming lock.recover and leaves the lock as it was when the mutex holder is dead', async () => {
    const stale = staleOwner()
    await writeOwner(lockPath(dir.dir), stale)
    await writeOwner(recoveryPath(dir.dir), { pid: deadPid(), token: 'abandoned-1e9d' })

    const err = await lockedError(acquireLock(dir.dir, 'review-20261102-1430-a1b2'))

    expect(err.code).toBe('LOCKED')
    expect(err.hint).toBe(
      `remove ${recoveryPath(dir.dir)} if no rensa run is active in this repository`,
    )
    expect(JSON.parse(await readFile(lockPath(dir.dir), 'utf8'))).toEqual(stale)
  })

  it('waits for a live mutex holder and then takes the lock when the mutex goes away', async () => {
    await writeOwner(lockPath(dir.dir), staleOwner())
    await writeOwner(recoveryPath(dir.dir), { pid: process.pid, token: 'live-recovery-6a0b' })
    const removal = new Promise<void>((resolve) => {
      setTimeout(() => {
        void rm(recoveryPath(dir.dir), { force: true }).then(() => resolve())
      }, 200)
    })
    const startedAt = Date.now()

    const lock = await acquire('review-20261102-1430-a1b2')
    const waited = Date.now() - startedAt
    await removal

    const content = JSON.parse(await readFile(lock.path, 'utf8')) as { pid: number }
    expect(content.pid).toBe(process.pid)
    expect(waited).toBeGreaterThanOrEqual(150)
  })
})

// The scenario is two rensa processes with separate pids and truly
// concurrent filesystem calls, so each contender is a child process
// running the bundled lock module. A race is a matter of timing, so each
// round starts six fresh processes on one wall-clock instant, staggered
// by a millisecond each so the contenders' steps interleave rather than
// run in lockstep, and many rounds run at once in separate directories.
// Measured against a lock without the recovery mutex (stale, unlink,
// link): about one round in five let in a second holder (112 of 600
// rounds), so 60 rounds miss it with a probability of a few in a million.
describe('contenders racing for a stale lock', () => {
  const LOCK_SOURCE = path.join(ROOT, 'src', 'engine', 'run', 'lock.ts')
  const CONTENDERS = 6
  const ROUNDS = 60
  /** Rounds running at the same time, each in its own project directory. */
  const CONCURRENT_ROUNDS = 10
  const HOLD_MS = 400
  /** Contender i starts this many milliseconds after contender 0. */
  const STAGGER_MS = 1
  /** From the moment every contender is loaded to the shared start. */
  const START_DELAY_MS = 50
  let build: TmpDir
  const live = new Set<ChildProcess>()

  // Loads the module first, reports READY, then reads the shared start
  // time from stdin, so a slow process start never delays a contender.
  const CHILD_SCRIPT = `
import { performance } from 'node:perf_hooks'
import { createInterface } from 'node:readline'
const [moduleUrl, projectDir, name, holdMs, offsetMs] = process.argv.slice(2)
const { acquireLock } = await import(moduleUrl)
const lines = createInterface({ input: process.stdin })
process.stdout.write('READY\\n')
const { value: startAt } = await lines[Symbol.asyncIterator]().next()
lines.close()
const target = Number(startAt) + Number(offsetMs)
const now = () => performance.timeOrigin + performance.now()
if (target - now() > 3) await new Promise((resolve) => setTimeout(resolve, target - now() - 2))
while (now() < target) {}
const late = Math.round(now() - target)
try {
  const lock = await acquireLock(projectDir, name)
  await new Promise((resolve) => setTimeout(resolve, Number(holdMs)))
  lock.release()
  process.stdout.write('ACQUIRED late=' + late + '\\n')
} catch (err) {
  process.stdout.write('REFUSED ' + (err && err.code ? err.code : String(err)) + ' late=' + late + '\\n')
}
`

  beforeAll(async () => {
    build = await tmpDir('rensa-lock-bundle-')
    await execFileAsync(
      path.join(ROOT, 'node_modules', '.bin', 'tsdown'),
      [LOCK_SOURCE, '--no-config', '--format', 'esm', '--platform', 'node', '-d', build.dir],
      { cwd: ROOT, timeout: 60_000 },
    )
    await writeFile(path.join(build.dir, 'contender.mjs'), CHILD_SCRIPT)
  }, 60_000)

  afterAll(async () => {
    for (const child of live) child.kill('SIGKILL')
    live.clear()
    await build.cleanup()
  })

  /** A contender process and a reader of its stdout lines. */
  function contender(projectDir: string, name: string, offsetMs: number) {
    const child = spawn(process.execPath, [
      path.join(build.dir, 'contender.mjs'),
      pathToFileURL(path.join(build.dir, 'lock.mjs')).href,
      projectDir,
      name,
      String(HOLD_MS),
      String(offsetMs),
    ])
    live.add(child)
    const lines: string[] = []
    let stderr = ''
    let wake = () => {}
    createInterface({ input: child.stdout }).on('line', (line) => {
      lines.push(line)
      wake()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    const exited = new Promise<void>((resolve) => {
      child.on('exit', () => {
        live.delete(child)
        wake()
        resolve()
      })
    })
    const next = async (): Promise<string> => {
      for (;;) {
        const line = lines.shift()
        if (line !== undefined) return line
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`contender ${name} exited without output: ${stderr}`)
        }
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
    }
    return { child, next, exited }
  }

  interface Round {
    acquired: number
    locked: number
    other: string[]
    leftovers: string[]
  }

  async function raceOnce(round: number): Promise<Round & { lateMs: number }> {
    const projectDir = path.join(dir.dir, `round-${round}`, '.rensa')
    await mkdir(projectDir, { recursive: true })
    await writeOwner(lockPath(projectDir), staleOwner())
    const contenders = Array.from({ length: CONTENDERS }, (_, i) =>
      contender(projectDir, `round-${round}-contender-${i}`, i * STAGGER_MS),
    )
    for (const c of contenders) expect(await c.next()).toBe('READY')
    const startAt = Date.now() + START_DELAY_MS
    for (const c of contenders) c.child.stdin.end(`${startAt}\n`)
    const outcomes = await Promise.all(contenders.map((c) => c.next()))
    await Promise.all(contenders.map((c) => c.exited))
    const results = outcomes.map((line) => /^(ACQUIRED|REFUSED (\S+)) late=(-?\d+)$/.exec(line))
    return {
      acquired: results.filter((m) => m?.[1] === 'ACQUIRED').length,
      locked: results.filter((m) => m?.[2] === 'LOCKED').length,
      other: outcomes.filter((_, i) => {
        const m = results[i]
        return m?.[1] !== 'ACQUIRED' && m?.[2] !== 'LOCKED'
      }),
      leftovers: [lockPath(projectDir), recoveryPath(projectDir)].filter((f) => existsSync(f)),
      lateMs: Math.max(...results.map((m) => Number(m?.[3] ?? Number.NaN))),
    }
  }

  it('lets exactly one contender in per round and leaves neither lock nor mutex behind when six processes race for a stale lock', async () => {
    const rounds: Array<Round & { lateMs: number }> = []
    for (let first = 0; first < ROUNDS; first += CONCURRENT_ROUNDS) {
      const batch = Array.from({ length: CONCURRENT_ROUNDS }, (_, k) => raceOnce(first + k))
      rounds.push(...(await Promise.all(batch)))
    }

    // A contender that started more than a hold late would find the lock
    // already released; the lateness shows that in a failure message.
    const lateness = `latest start per round, ms: ${rounds.map((r) => r.lateMs).join(' ')}`
    expect(
      rounds.map(({ lateMs: _, ...round }) => round),
      lateness,
    ).toEqual(
      Array.from({ length: ROUNDS }, () => ({
        acquired: 1,
        locked: CONTENDERS - 1,
        other: [],
        leftovers: [],
      })),
    )
  }, 60_000)
})
