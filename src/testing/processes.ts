import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface ProcessEntry {
  pid: number
  args: string
}

/**
 * Live processes whose full command line is exactly `args`. Tests give
 * each spawned command a distinct, unlikely argument (`sleep 30.6123`) so
 * this never matches another test's processes. Reaped-pending zombies
 * show as `(sleep)` or `[sleep] <defunct>` and do not match.
 */
export async function processesWithArgs(args: string): Promise<ProcessEntry[]> {
  const { stdout } = await execFileAsync('ps', ['-Ao', 'pid=,args='])
  const found: ProcessEntry[] = []
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (match?.[2]?.trimEnd() === args) found.push({ pid: Number(match[1]), args })
  }
  return found
}

/**
 * The process group of `pid` as of this call, or undefined when there is
 * no such process. Read it here rather than alongside the command line:
 * macOS `ps` snapshots every process's group first and reads each command
 * line later, so one listing can pair a command line set by `exec` with
 * the group from before a `setsid()` that preceded that `exec`.
 */
export async function processGroupOf(pid: number): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'pgid=', '-p', String(pid)])
    const pgid = Number(stdout.trim())
    return Number.isInteger(pgid) && pgid > 0 ? pgid : undefined
  } catch {
    return undefined
  }
}

/** SIGKILLs every live process whose command line is exactly `args`. */
export async function killProcessesWithArgs(args: string): Promise<void> {
  for (const { pid } of await processesWithArgs(args)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
}

/**
 * The `ps` state of `pid` (`S`, `R`, `Z`, ...), or undefined when there is
 * no such process. Synchronous, for use inside a shutdown callback. A
 * SIGKILLed child shows `Z` until its parent reaps it, which tells it
 * apart from a live one where `kill(pid, 0)` cannot.
 */
export function processState(pid: number): string | undefined {
  try {
    return execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim()
  } catch {
    return undefined
  }
}

/**
 * The pid of a process that has exited and been reaped, for a lock or
 * mutex whose owner must be dead. A pid is reused only after the kernel
 * wraps around, far beyond a test's lifetime.
 */
export function deadPid(): number {
  const { pid, error } = spawnSync('true')
  if (error || pid === undefined || pid <= 0) throw new Error(`cannot spawn true: ${error}`)
  return pid
}

/**
 * Blocks the event loop until `pid` is an unreaped zombie (`ps` state
 * `Z`), so Node cannot reap it before the caller's next synchronous
 * statement. A child that exited this way is the only member of its
 * process group, the state a crash or a second ctrl+c meets at exit.
 * Throws when the process is not a zombie within `timeoutMs`.
 */
export function blockUntilZombie(pid: number, timeoutMs = 5_000): void {
  const deadline = Date.now() + timeoutMs
  while (!processState(pid)?.startsWith('Z')) {
    if (Date.now() > deadline) {
      throw new Error(`process ${pid} was not a zombie within ${timeoutMs} ms`)
    }
  }
}
