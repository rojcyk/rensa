import { diag } from '../../diag.js'
import { spawnProcess } from '../../process/spawn.js'
import { findOnPath } from '../path.js'
import type { Availability } from '../types.js'

const SCOPE = 'codex.auth'
// `checkProviders` counts its 3 s from before `available()` is called and
// `findOnPath` runs first, so each command gets well under that: past
// this deadline it is answered as "could not run" and killed in the
// background with a short SIGTERM → SIGKILL grace.
const COMMAND_TIMEOUT_MS = 2000
const COMMAND_KILL_GRACE_MS = 500
const UNKNOWN_VERSION = 'unknown'
const NOT_LOGGED_IN = /not logged in/i

type CommandOutput =
  | { ran: true; exitCode: number | null; stdout: string; stderr: string }
  | { ran: false; reason: string }

/**
 * Whether the Codex CLI is installed and logged in. The version and login
 * checks run at once. A login check that cannot run, or ends in a way
 * `parseLoginStatus` cannot read, counts as logged in: the run then
 * surfaces an `auth` error of its own, and the reason goes to `diag`.
 *
 * On a ChatGPT login 0.166.0 honors `-m` (an unsupported model is refused
 * with "not supported when using Codex with a ChatGPT account"), so the
 * model is not advisory and availability carries no note about it.
 */
export async function codexAvailability(env: NodeJS.ProcessEnv): Promise<Availability> {
  const bin = await findOnPath('codex', env)
  if (bin === undefined) return { status: 'not_installed' }
  const [version, loggedIn] = await Promise.all([readVersion(bin, env), readLoggedIn(bin, env)])
  if (!loggedIn) return { status: 'not_logged_in', version, hint: 'run: codex login' }
  return { status: 'ready', version }
}

async function readVersion(bin: string, env: NodeJS.ProcessEnv): Promise<string> {
  const out = await runCommand([bin, '--version'], env)
  if (!out.ran) {
    diag(SCOPE, `codex --version failed: ${out.reason}`)
    return UNKNOWN_VERSION
  }
  return parseVersion(out.stdout) ?? UNKNOWN_VERSION
}

async function readLoggedIn(bin: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const out = await runCommand([bin, 'login', 'status'], env)
  if (!out.ran) {
    diag(SCOPE, `codex login status failed, assuming logged in: ${out.reason}`)
    return true
  }
  const loggedIn = parseLoginStatus(`${out.stdout}\n${out.stderr}`, out.exitCode)
  if (loggedIn === undefined) {
    diag(SCOPE, `codex login status exited with ${out.exitCode}, assuming logged in`)
    return true
  }
  return loggedIn
}

/** The first line of `codex --version`, trimmed, e.g. `codex-cli 0.166.0`. */
export function parseVersion(stdout: string): string | undefined {
  const first = stdout.split('\n', 1)[0]?.trim()
  return first === undefined || first === '' ? undefined : first
}

/**
 * Reads `codex login status`. On 0.166.0 it prints `Logged in using
 * ChatGPT` and exits 0 when logged in, `Not logged in` and exits 1 when
 * not, both on stderr, so `output` is stdout and stderr together.
 * Undefined: any other exit, which says nothing about the login.
 */
export function parseLoginStatus(output: string, exitCode: number | null): boolean | undefined {
  if (exitCode === 1 || NOT_LOGGED_IN.test(output)) return false
  if (exitCode === 0) return true
  return undefined
}

/**
 * The command's exit code and output, or why it could not run to
 * completion. Answers by `COMMAND_TIMEOUT_MS` at the latest; a command
 * still running then is killed, and its exit is not waited for.
 */
async function runCommand(argv: string[], env: NodeJS.ProcessEnv): Promise<CommandOutput> {
  const stdout: string[] = []
  const stderr: string[] = []
  const timedOut: CommandOutput = {
    ran: false,
    reason: `timed out after ${COMMAND_TIMEOUT_MS} ms`,
  }
  let timer: NodeJS.Timeout | undefined
  try {
    const child = spawnProcess({
      argv,
      cwd: process.cwd(),
      env,
      timeoutMs: COMMAND_TIMEOUT_MS,
      escalateMs: COMMAND_KILL_GRACE_MS,
      onStdout: (line) => stdout.push(line),
      onStderr: (line) => stderr.push(line),
    })
    const deadline = new Promise<'deadline'>((resolve) => {
      timer = setTimeout(() => {
        // Idempotent with spawnProcess's own timeout kill; only the wait is skipped.
        child.kill()
        resolve('deadline')
      }, COMMAND_TIMEOUT_MS)
    })
    const result = await Promise.race([child.result, deadline])
    if (result === 'deadline' || result.timedOut) return timedOut
    if (result.signal !== null) return { ran: false, reason: `killed by ${result.signal}` }
    return {
      ran: true,
      exitCode: result.exitCode,
      stdout: stdout.join('\n'),
      stderr: stderr.join('\n'),
    }
  } catch (err) {
    return { ran: false, reason: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timer)
  }
}
