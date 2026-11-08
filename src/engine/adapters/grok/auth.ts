import { access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { diag } from '../../diag.js'
import { spawnProcess } from '../../process/spawn.js'
import { findOnPath } from '../path.js'
import type { Availability } from '../types.js'

const SCOPE = 'grok.auth'
// `checkProviders` counts its 3 s from before `available()` is called and
// `findOnPath` runs first, so the version command gets well under that;
// past this deadline it is answered as unknown and killed in the background.
const COMMAND_TIMEOUT_MS = 2000
const COMMAND_KILL_GRACE_MS = 500
const UNKNOWN_VERSION = 'unknown'

/**
 * Whether Grok Build is installed and logged in. The version check and
 * the credentials check run at once. Being logged in means a credentials
 * file exists, which cannot show an expired login: that surfaces at run
 * time as an `auth` error.
 */
export async function grokAvailability(env: NodeJS.ProcessEnv): Promise<Availability> {
  const bin = await findOnPath('grok', env)
  if (bin === undefined) return { status: 'not_installed' }
  const [version, loggedIn] = await Promise.all([readVersion(bin, env), hasCredentials(env)])
  if (!loggedIn) return { status: 'not_logged_in', version, hint: 'run: grok login' }
  return { status: 'ready', version }
}

/**
 * Where Grok keeps its credentials: `auth.json` in `$GROK_HOME`, which
 * defaults to `~/.grok`. `HOME` is read from `env` so a check can be
 * pointed at another home directory.
 */
export function authFile(env: NodeJS.ProcessEnv): string {
  const grokHome =
    env.GROK_HOME !== undefined && env.GROK_HOME !== ''
      ? env.GROK_HOME
      : path.join(env.HOME ?? os.homedir(), '.grok')
  return path.join(grokHome, 'auth.json')
}

async function hasCredentials(env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    await access(authFile(env))
    return true
  } catch {
    return false
  }
}

/** The first line of `grok --version`, trimmed, e.g. `grok 1.0.70 (f50904eaee6c) [stable]`. */
export function parseVersion(stdout: string): string | undefined {
  const first = stdout.split('\n', 1)[0]?.trim()
  return first === undefined || first === '' ? undefined : first
}

/** `grok --version`, or `unknown` when it cannot run to completion; the reason goes to `diag`. */
async function readVersion(bin: string, env: NodeJS.ProcessEnv): Promise<string> {
  const lines: string[] = []
  let timer: NodeJS.Timeout | undefined
  try {
    const child = spawnProcess({
      argv: [bin, '--version'],
      cwd: process.cwd(),
      env,
      timeoutMs: COMMAND_TIMEOUT_MS,
      escalateMs: COMMAND_KILL_GRACE_MS,
      onStdout: (line) => lines.push(line),
    })
    const deadline = new Promise<'deadline'>((resolve) => {
      timer = setTimeout(() => {
        // Idempotent with spawnProcess's own timeout kill; only the wait is skipped.
        child.kill()
        resolve('deadline')
      }, COMMAND_TIMEOUT_MS)
    })
    const result = await Promise.race([child.result, deadline])
    if (result === 'deadline' || result.timedOut) {
      diag(SCOPE, `grok --version timed out after ${COMMAND_TIMEOUT_MS} ms`)
      return UNKNOWN_VERSION
    }
    if (result.signal !== null) {
      diag(SCOPE, `grok --version was killed by ${result.signal}`)
      return UNKNOWN_VERSION
    }
    return parseVersion(lines.join('\n')) ?? UNKNOWN_VERSION
  } catch (err) {
    diag(SCOPE, `grok --version failed: ${err instanceof Error ? err.message : String(err)}`)
    return UNKNOWN_VERSION
  } finally {
    clearTimeout(timer)
  }
}
