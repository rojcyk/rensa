import { diag } from '../../diag.js'
import { spawnProcess } from '../../process/spawn.js'
import { isRecord } from '../../run/jsonl.js'
import { findOnPath } from '../path.js'
import type { Availability, AvailabilityOptions } from '../types.js'

const SCOPE = 'claude.auth'
// `checkProviders` counts its 3 s from before `available()` is called,
// and `findOnPath` runs first, so each command gets well under that: a
// command past this deadline is answered as "could not run" at once, in
// time for the logged-in fallback to count, while it is killed with a
// short SIGTERM → SIGKILL grace in the background.
const COMMAND_TIMEOUT_MS = 2000
const COMMAND_KILL_GRACE_MS = 500
const UNKNOWN_VERSION = 'unknown'

type CommandOutput =
  | { ran: true; exitCode: number | null; stdout: string }
  | { ran: false; reason: string }

/**
 * Whether Claude Code is installed and logged in. The version and auth
 * checks run at once. An auth check that cannot run counts as logged in:
 * the run then surfaces an `auth` error of its own, and the reason goes
 * to `diag`.
 */
export async function claudeAvailability(
  env: NodeJS.ProcessEnv,
  { commandTimeoutMs = COMMAND_TIMEOUT_MS }: AvailabilityOptions = {},
): Promise<Availability> {
  const bin = await findOnPath('claude', env)
  if (bin === undefined) return { status: 'not_installed' }
  const [version, loggedIn] = await Promise.all([
    readVersion(bin, env, commandTimeoutMs),
    readLoggedIn(bin, env, commandTimeoutMs),
  ])
  if (!loggedIn) return { status: 'not_logged_in', version, hint: 'run: claude auth login' }
  return { status: 'ready', version }
}

async function readVersion(
  bin: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<string> {
  const out = await runCommand([bin, '--version'], env, timeoutMs)
  if (!out.ran) {
    diag(SCOPE, `claude --version failed: ${out.reason}`)
    return UNKNOWN_VERSION
  }
  return parseVersion(out.stdout) ?? UNKNOWN_VERSION
}

async function readLoggedIn(
  bin: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<boolean> {
  const out = await runCommand([bin, 'auth', 'status'], env, timeoutMs)
  if (!out.ran) {
    diag(SCOPE, `claude auth status failed, assuming logged in: ${out.reason}`)
    return true
  }
  return parseAuthStatus(out.stdout, out.exitCode)
}

/** The first line of `claude --version`, trimmed, e.g. `2.1.319 (Claude Code)`. */
export function parseVersion(stdout: string): string | undefined {
  const first = stdout.split('\n', 1)[0]?.trim()
  return first === undefined || first === '' ? undefined : first
}

/**
 * Reads `claude auth status`. On 2.1.319 it prints a JSON object with a
 * boolean `loggedIn` and exits 0 when logged in, 1 when not. Output that
 * is not such an object falls back to the exit code.
 */
export function parseAuthStatus(stdout: string, exitCode: number | null): boolean {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    value = undefined
  }
  if (isRecord(value) && typeof value.loggedIn === 'boolean') return value.loggedIn
  return exitCode === 0
}

/**
 * The command's exit code and stdout, or why it could not run to
 * completion. Answers by `timeoutMs` at the latest; a command
 * still running then is killed, and its exit is not waited for.
 */
async function runCommand(
  argv: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<CommandOutput> {
  const lines: string[] = []
  const timedOut: CommandOutput = {
    ran: false,
    reason: `timed out after ${timeoutMs} ms`,
  }
  let timer: NodeJS.Timeout | undefined
  try {
    const child = spawnProcess({
      argv,
      cwd: process.cwd(),
      env,
      timeoutMs,
      escalateMs: COMMAND_KILL_GRACE_MS,
      onStdout: (line) => lines.push(line),
    })
    const deadline = new Promise<'deadline'>((resolve) => {
      timer = setTimeout(() => {
        // Idempotent with spawnProcess's own timeout kill; the group is
        // still terminated, only the wait for its exit is skipped.
        child.kill()
        resolve('deadline')
      }, timeoutMs)
    })
    const result = await Promise.race([child.result, deadline])
    if (result === 'deadline' || result.timedOut) return timedOut
    if (result.signal !== null) return { ran: false, reason: `killed by ${result.signal}` }
    return { ran: true, exitCode: result.exitCode, stdout: lines.join('\n') }
  } catch (err) {
    return { ran: false, reason: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timer)
  }
}
