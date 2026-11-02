import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Provider } from '../config/types.js'
import { diag } from '../diag.js'
import { allAdapters } from './registry.js'
import type { Adapter, Availability } from './types.js'

export interface ProviderStatus {
  provider: Provider
  availability: Availability
}

const CHECK_TIMEOUT_MS = 3000

/**
 * Asks every adapter whether its CLI is installed and logged in. All
 * checks start in the same tick as this call, before anything is
 * awaited, so their subprocesses overlap whatever the caller does next.
 * A check that throws or takes longer than 3 s counts as `not_installed`.
 */
export function checkProviders(
  env: NodeJS.ProcessEnv,
  adapters: readonly Adapter[] = allAdapters(),
): Promise<ProviderStatus[]> {
  const checks = adapters.map((adapter) => withTimeout(adapter, env))
  return Promise.all(checks)
}

async function withTimeout(adapter: Adapter, env: NodeJS.ProcessEnv): Promise<ProviderStatus> {
  const { provider } = adapter
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<Availability>((resolve) => {
    timer = setTimeout(() => {
      diag(provider, `availability check timed out after ${CHECK_TIMEOUT_MS} ms`)
      resolve({ status: 'not_installed' })
    }, CHECK_TIMEOUT_MS)
    timer.unref()
  })
  let started: Promise<Availability>
  try {
    started = adapter.available(env)
  } catch (err) {
    started = Promise.reject(err)
  }
  const check = started.catch((err: unknown): Availability => {
    diag(provider, `availability check failed: ${err instanceof Error ? err.message : String(err)}`)
    return { status: 'not_installed' }
  })
  try {
    return { provider, availability: await Promise.race([check, timeout]) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The absolute path `bin` resolves to on `env.PATH`, or undefined. Every
 * directory is checked at once, starting synchronously; the first match
 * in PATH order wins. A `bin` containing a slash is checked as given.
 */
export async function findOnPath(bin: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const candidates = bin.includes('/')
    ? [path.resolve(bin)]
    : (env.PATH ?? '')
        .split(path.delimiter)
        // An empty entry means the current directory; never look there.
        .filter((dir) => dir !== '')
        .map((dir) => path.join(dir, bin))
  const checks = candidates.map(isExecutableFile)
  for (const [i, check] of checks.entries()) {
    if (await check) return candidates[i]
  }
  return undefined
}

async function isExecutableFile(file: string): Promise<boolean> {
  try {
    const [info] = await Promise.all([stat(file), access(file, constants.X_OK)])
    return info.isFile()
  } catch {
    return false
  }
}
