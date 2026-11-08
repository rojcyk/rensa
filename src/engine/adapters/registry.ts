import { EFFORT } from '../config/effort.js'
import { EFFORTS, PROVIDERS, type Provider, TOOLS } from '../config/types.js'
import { RensaError } from '../errors.js'
import { claudeAdapter } from './claude/index.js'
import { fakeAdapter } from './fake/index.js'
import { grokAdapter } from './grok/index.js'
import type { Adapter } from './types.js'

type RealProvider = Exclude<Provider, 'fake'>

/**
 * Stands in for a provider whose adapter is not written yet: never
 * installed, cannot spawn. Step 16 replaces the last one.
 */
function stubAdapter(provider: RealProvider): Adapter {
  const notImplemented = () => new RensaError('INTERNAL', `${provider} adapter not implemented`)
  return {
    provider,
    capabilities: () => ({
      resume: true,
      model: true,
      effort: EFFORTS.filter((e) => typeof EFFORT[provider][e] === 'string'),
      tools: [...TOOLS],
    }),
    available: async () => ({ status: 'not_installed' }),
    spawn: () => {
      throw notImplemented()
    },
    // biome-ignore lint/correctness/useYield: a stub parser fails before reading anything
    parse: async function* () {
      throw notImplemented()
    },
  }
}

const REAL: Record<RealProvider, Adapter> = {
  claude: claudeAdapter,
  codex: stubAdapter('codex'),
  grok: grokAdapter,
}

function devMode(): boolean {
  return process.env.RENSA_DEV === '1'
}

/** Every registered adapter, in `PROVIDERS` order; `fake` only with RENSA_DEV=1. */
export function allAdapters(): Adapter[] {
  return PROVIDERS.flatMap((p) => {
    if (p === 'fake') return devMode() ? [fakeAdapter] : []
    return [REAL[p]]
  })
}

export function getAdapter(p: Provider): Adapter {
  if (p !== 'fake') return REAL[p]
  if (devMode()) return fakeAdapter
  throw new RensaError(
    'PROVIDER_UNAVAILABLE',
    'provider `fake` is for development only',
    undefined,
    'set RENSA_DEV=1',
  )
}
