import type { Effort, Provider } from './types.js'

/**
 * Maps rensa's effort levels to each provider's own value. `null` or a
 * missing key means the provider has no such level. Adapter steps correct
 * this table once a CLI's flags are verified.
 */
export const EFFORT: Record<Provider, Partial<Record<Effort, string | null>>> = {
  claude: { low: 'low', medium: 'medium', high: 'high', max: 'max' },
  codex: { low: 'low', medium: 'medium', high: 'high', max: 'xhigh' },
  grok: { low: 'low', medium: 'medium', high: 'high', max: null }, // adjust in step 15 once verified
  fake: { low: 'low', medium: 'medium', high: 'high', max: 'max' },
}
