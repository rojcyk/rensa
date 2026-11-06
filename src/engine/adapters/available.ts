import type { Provider } from '../config/types.js'
import { diag } from '../diag.js'
import { allAdapters } from './registry.js'
import type { Adapter, Availability } from './types.js'

// Lives in path.ts so adapters can use it without importing the registry.
export { findOnPath } from './path.js'

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
