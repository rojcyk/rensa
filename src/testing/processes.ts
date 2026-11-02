import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface ProcessEntry {
  pid: number
  pgid: number
  args: string
}

/**
 * Live processes whose full command line is exactly `args`. Tests give
 * each spawned command a distinct, unlikely argument (`sleep 30.6123`) so
 * this never matches another test's processes. Reaped-pending zombies
 * show as `(sleep)` or `[sleep] <defunct>` and do not match.
 */
export async function processesWithArgs(args: string): Promise<ProcessEntry[]> {
  const { stdout } = await execFileAsync('ps', ['-Ao', 'pid=,pgid=,args='])
  const found: ProcessEntry[] = []
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (match?.[3]?.trimEnd() === args) {
      found.push({ pid: Number(match[1]), pgid: Number(match[2]), args })
    }
  }
  return found
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
