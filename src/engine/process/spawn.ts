import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { Readable } from 'node:stream'
import { RensaError } from '../errors.js'
import { lineReader } from './lines.js'
import { onShutdown } from './shutdown.js'

// The one place that spawns child processes. Every child leads its own
// process group, and everything here acts on the group: a group outlives
// its leader, and a grandchild that survives the leader keeps the pipes
// open.

export interface SpawnOptions {
  argv: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  /** Written, then stdin is closed. Absent: stdin is closed immediately. */
  stdin?: string
  timeoutMs: number
  /** SIGTERM → SIGKILL grace, default 5000. */
  escalateMs?: number
  /** Line mode: each line without its newline or a trailing `\r`. */
  onStdout?: (line: string) => void
  onStderr?: (line: string) => void
  /** Raw mode: every chunk as received. A stream takes one mode or the other. */
  onStdoutChunk?: (chunk: Buffer) => void
  onStderrChunk?: (chunk: Buffer) => void
}

export interface SpawnResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  /** `kill()` was called, by the caller or by the timeout. */
  killed: boolean
  durationMs: number
}

export interface Child {
  /** Undefined when the spawn itself failed; `result` then rejects. */
  pid: number | undefined
  kill(): void
  result: Promise<SpawnResult>
}

const DEFAULT_ESCALATE_MS = 5000
// How often a group that outlived its result is checked for being gone.
const PRUNE_INTERVAL_MS = 1000

const liveGroups = new Set<number>()

/** Process groups this module may still have to kill. Read-only, for tests. */
export const liveProcessGroups: ReadonlySet<number> = liveGroups

// Runs inside 'exit', where timers never fire: kill now or leak the child.
onShutdown(() => {
  for (const pgid of liveGroups) signalGroup(pgid, 'SIGKILL')
})

/**
 * Carries a kill request from the engine to whatever step is running.
 * A callback registered after `kill()` runs at once.
 */
export class KillSignal {
  private callbacks: Array<() => void> = []
  private wasKilled = false

  get killed(): boolean {
    return this.wasKilled
  }

  kill(): void {
    if (this.wasKilled) return
    this.wasKilled = true
    for (const cb of this.callbacks.splice(0)) cb()
  }

  /** Returns a function that drops the callback. */
  onKill(cb: () => void): () => void {
    if (this.wasKilled) {
      cb()
      return () => {}
    }
    this.callbacks.push(cb)
    return () => {
      const i = this.callbacks.indexOf(cb)
      if (i !== -1) this.callbacks.splice(i, 1)
    }
  }
}

export function spawnProcess(opts: SpawnOptions): Child {
  const [command, ...args] = opts.argv
  if (command === undefined) throw new RensaError('INTERNAL', 'spawnProcess: empty argv')
  if ((opts.onStdout && opts.onStdoutChunk) || (opts.onStderr && opts.onStderrChunk)) {
    throw new RensaError('INTERNAL', 'spawnProcess: a stream takes lines or chunks, not both')
  }
  const escalateMs = opts.escalateMs ?? DEFAULT_ESCALATE_MS
  const started = Date.now()

  const proc = spawn(command, args, {
    cwd: opts.cwd,
    env: opts.env,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pid = proc.pid

  // A child that exits without reading stdin makes the write fail with
  // EPIPE; that is not an error of ours.
  proc.stdin.on('error', () => {})

  let settled = false
  let killed = false
  let timedOut = false
  let timeoutTimer: NodeJS.Timeout | undefined
  let escalateTimer: NodeJS.Timeout | undefined
  let drainTimer: NodeJS.Timeout | undefined
  let forceSettle: () => void = () => {}

  const kill = () => {
    if (killed || pid === undefined) return
    // After the group is gone its pgid may belong to someone else.
    if (settled && !liveGroups.has(pid)) return
    killed = true
    signalGroup(pid, 'SIGTERM')
    // Unconditional: a leader that already exited is exactly the case a
    // SIGTERM-ignoring grandchild hides behind.
    escalateTimer = setTimeout(() => {
      escalateTimer = undefined
      signalGroup(pid, 'SIGKILL')
      drainTimer = setTimeout(() => forceSettle(), escalateMs)
    }, escalateMs)
  }

  const result = new Promise<SpawnResult>((resolve, reject) => {
    if (pid === undefined) {
      proc.once('error', (err: NodeJS.ErrnoException) => {
        settled = true
        reject(spawnError(command, opts.cwd, err))
      })
      return
    }
    liveGroups.add(pid)

    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined
    let streamsEnded = false

    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      clearTimeout(drainTimer)
      // The same rule on every path. A forced settle only means something
      // still held the pipes; that may be a process that left the group,
      // which this pgid cannot reach, so it says nothing about the group.
      if (!groupAlive(pid)) {
        liveGroups.delete(pid)
        clearTimeout(escalateTimer)
      } else {
        pruneWhenGone(pid)
      }
      resolve({
        exitCode: exit?.code ?? null,
        signal: exit?.signal ?? null,
        timedOut,
        killed,
        durationMs: Date.now() - started,
      })
    }

    forceSettle = () => {
      if (settled) return
      proc.stdout.destroy()
      proc.stderr.destroy()
      proc.stdin.destroy()
      finish()
    }

    proc.once('exit', (code, signal) => {
      exit = { code, signal }
      if (streamsEnded) finish()
    })
    void Promise.all([
      readStream(proc.stdout, opts.onStdout, opts.onStdoutChunk),
      readStream(proc.stderr, opts.onStderr, opts.onStderrChunk),
    ]).then(() => {
      streamsEnded = true
      if (exit) finish()
    })

    timeoutTimer = setTimeout(() => {
      if (killed) return
      timedOut = true
      kill()
    }, opts.timeoutMs)

    proc.stdin.end(opts.stdin)
  })

  return { pid, kill, result }
}

/** Resolves when the stream has ended or was destroyed; never rejects. */
function readStream(
  stream: Readable,
  onLine: ((line: string) => void) | undefined,
  onChunk: ((chunk: Buffer) => void) | undefined,
): Promise<void> {
  if (onLine) return lineReader(stream, onLine).catch(() => {})
  if (onChunk) stream.on('data', onChunk)
  // Drained even with no callback, or a full pipe would block the child.
  else stream.resume()
  return new Promise((resolve) => {
    stream.once('end', resolve)
    stream.once('close', resolve)
    stream.once('error', () => resolve())
  })
}

function spawnError(command: string, cwd: string, err: NodeJS.ErrnoException): RensaError {
  if (err.code === 'ENOENT') {
    const why = existsSync(cwd) ? 'not found' : `working directory ${cwd} does not exist`
    return new RensaError('PROCESS', `cannot run \`${command}\`: ${why}`)
  }
  return new RensaError('PROCESS', `cannot run \`${command}\`: ${err.message}`)
}

/** True while any member of the process group lives. */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (err) {
    if (isErrno(err, 'ESRCH')) return false
    // EPERM: a member exists that we may not signal.
    return true
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal)
  } catch (err) {
    if (!isErrno(err, 'ESRCH')) throw err
  }
}

// A group still alive when its result settled: a member that closed its
// pipes and kept running, or one not yet reaped. It stays registered for
// the shutdown kill until it is gone.
function pruneWhenGone(pgid: number): void {
  const timer = setInterval(() => {
    if (groupAlive(pgid)) return
    liveGroups.delete(pgid)
    clearInterval(timer)
  }, PRUNE_INTERVAL_MS)
  timer.unref()
}

function isErrno(err: unknown, code: string): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === code
}
