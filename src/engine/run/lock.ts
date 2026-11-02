import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, unlinkSync } from 'node:fs'
import { link, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { RensaError } from '../errors.js'
import { onShutdown } from '../process/shutdown.js'

// `<repo>/.rensa/lock`, held by a run of a chain that writes. Released on
// the run's finish, or on process death through the shutdown registry.
//
// Rules that keep two runs from both holding the lock:
// - A lock file is created whole and atomically (written under a temporary
//   name, then hard-linked into place; link() fails if the path exists).
// - Every acquisition carries a unique token, and a holder removes the
//   file only while it still carries that token.
// - The only other way a lock file is removed is stale recovery, which runs
//   under a second exclusive file, `lock.recover`, and re-inspects the lock
//   inside it. So between that inspection and the removal nobody else can
//   recover, and the lock's owner is dead, so it cannot release either.
//
// This module must not import process/spawn.js, directly or transitively:
// it registers its shutdown callback at load, before spawn.ts registers
// the child kill, so that the kill (LIFO) runs before the lock goes.

interface Owner {
  pid: number
  token: string
}

interface LockContent extends Owner {
  run_id: string
  started_at: string
}

type Inspection =
  | { state: 'missing' }
  /** Not an owner record. Files are created whole, so this is never a write in progress. */
  | { state: 'unreadable' }
  | { state: 'present'; owner: Partial<LockContent> & { pid: number } }

export interface Lock {
  path: string
  /**
   * Removes the lock file if it still carries this acquisition's token.
   * Idempotent. If removal fails it throws, and the shutdown callback tries
   * again at exit.
   */
  release(): void
}

/** How long to wait for another process's stale-lock recovery to finish. */
const RECOVERY_WAIT_MS = 5000
const RECOVERY_POLL_MS = 25
const ACQUIRE_ATTEMPTS = 3

/** Files this process owns, lock or recovery mutex, by path → token. */
const held = new Map<string, string>()

onShutdown(() => {
  const entries = [...held]
  held.clear()
  // One failure must not keep the other files in place; the registry
  // reports the first error after every file has been tried.
  let failure: unknown
  for (const [file, token] of entries) {
    try {
      removeIfOwnedSync(file, token)
    } catch (err) {
      failure ??= err
    }
  }
  if (failure !== undefined) throw failure
})

export function lockPath(projectDir: string): string {
  return path.join(projectDir, 'lock')
}

export function recoveryPath(projectDir: string): string {
  return path.join(projectDir, 'lock.recover')
}

/**
 * Takes the repository lock. An existing lock whose pid is alive is
 * `LOCKED`; one whose pid is dead, or that is not an owner record, is
 * stale and replaced under the recovery mutex.
 */
export async function acquireLock(projectDir: string, runId: string): Promise<Lock> {
  const file = lockPath(projectDir)
  const token = randomUUID()
  const content: LockContent = {
    pid: process.pid,
    token,
    run_id: runId,
    started_at: new Date().toISOString(),
  }
  for (let attempt = 1; attempt <= ACQUIRE_ATTEMPTS; attempt++) {
    if (await createExclusive(file, content)) {
      held.set(file, token)
      return {
        path: file,
        release() {
          if (held.get(file) !== token) return
          removeIfOwnedSync(file, token)
          held.delete(file)
        },
      }
    }
    const seen = await inspect(file)
    if (seen.state === 'present' && isAlive(seen.owner.pid)) throw locked(file, seen.owner)
    await withRecoveryMutex(projectDir, async () => {
      // Decide again inside the mutex: another contender may have
      // replaced the stale lock with a live one since we looked.
      const now = await inspect(file)
      if (now.state === 'missing') return
      if (now.state === 'present' && isAlive(now.owner.pid)) return
      await unlink(file).catch(ignoreMissing)
    })
  }
  // Every attempt lost a race to another contender that is now the holder.
  const last = await inspect(file)
  if (last.state === 'present') throw locked(file, last.owner)
  throw new RensaError('LOCKED', `could not take the lock ${file}`, file, 'try again')
}

/**
 * Runs `fn` while holding `lock.recover`. Waits while a live process holds
 * it. One left by a dead process is not broken automatically: breaking it
 * safely would need the same mutual exclusion one level up.
 */
async function withRecoveryMutex(projectDir: string, fn: () => Promise<void>): Promise<void> {
  const mutex = recoveryPath(projectDir)
  const owner: Owner = { pid: process.pid, token: randomUUID() }
  const deadline = Date.now() + RECOVERY_WAIT_MS
  while (!(await createExclusive(mutex, owner))) {
    const seen = await inspect(mutex)
    if (seen.state === 'missing') continue
    if (seen.state === 'unreadable' || !isAlive(seen.owner.pid)) {
      throw new RensaError(
        'LOCKED',
        `${mutex} was left by a rensa process that died while replacing a stale lock`,
        mutex,
        `remove ${mutex} if no rensa run is active in this repository`,
      )
    }
    if (Date.now() > deadline) {
      throw new RensaError(
        'LOCKED',
        `pid ${seen.owner.pid} has been replacing a stale lock for over ${RECOVERY_WAIT_MS / 1000} s`,
        mutex,
        'try again',
      )
    }
    await sleep(RECOVERY_POLL_MS)
  }
  // Registered so that dying inside `fn` through any exit path frees it.
  held.set(mutex, owner.token)
  try {
    await fn()
  } finally {
    removeIfOwnedSync(mutex, owner.token)
    held.delete(mutex)
  }
}

/**
 * Creates `file` with `content`, whole, unless it exists. Returns false
 * when it exists.
 */
async function createExclusive(file: string, content: object): Promise<boolean> {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, `${JSON.stringify(content)}\n`)
  try {
    await link(tmp, file)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  } finally {
    await rm(tmp, { force: true })
  }
}

async function inspect(file: string): Promise<Inspection> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' }
    throw err
  }
  return parseOwner(text)
}

function parseOwner(text: string): Inspection {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { state: 'unreadable' }
  }
  if (typeof parsed !== 'object' || parsed === null) return { state: 'unreadable' }
  const { pid } = parsed as { pid?: unknown }
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return { state: 'unreadable' }
  return { state: 'present', owner: parsed as Partial<LockContent> & { pid: number } }
}

/**
 * Unlinks `file` only if it carries `token`. Synchronous, for the
 * shutdown path. Safe without the mutex: nobody else removes a file
 * whose owner, this process, is alive.
 */
function removeIfOwnedSync(file: string, token: string): void {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
  const seen = parseOwner(text)
  if (seen.state !== 'present' || seen.owner.token !== token) return
  try {
    unlinkSync(file)
  } catch (err) {
    ignoreMissing(err as NodeJS.ErrnoException)
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function locked(file: string, owner: Partial<LockContent> & { pid: number }): RensaError {
  return new RensaError(
    'LOCKED',
    `run ${owner.run_id ?? '(unknown)'} (pid ${owner.pid}) holds the lock on this repository`,
    file,
    'wait for it to finish, or abort it',
  )
}

function ignoreMissing(err: NodeJS.ErrnoException): void {
  if (err.code !== 'ENOENT') throw err
}
