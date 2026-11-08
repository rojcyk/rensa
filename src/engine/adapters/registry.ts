import { PROVIDERS, type Provider } from '../config/types.js'
import { RensaError } from '../errors.js'
import { claudeAdapter } from './claude/index.js'
import { codexAdapter } from './codex/index.js'
import { fakeAdapter } from './fake/index.js'
import { grokAdapter } from './grok/index.js'
import type { Adapter } from './types.js'

type RealProvider = Exclude<Provider, 'fake'>

const REAL: Record<RealProvider, Adapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
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
