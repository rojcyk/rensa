import type { Effort, Provider } from './types.js'

/**
 * Maps rensa's effort levels to each provider's own value. `null` or a
 * missing key means the provider has no such level. Adapter steps correct
 * this table once a CLI's flags are verified.
 */
export const EFFORT: Record<Provider, Partial<Record<Effort, string | null>>> = {
  claude: { low: 'low', medium: 'medium', high: 'high', max: 'max' },
  codex: { low: 'low', medium: 'medium', high: 'high', max: 'xhigh' },
  // Grok 1.0.70: the models' effort menus offer low, medium, high, xhigh; the
  // CLI's own `max` is refused by every installed model, so `max` is `xhigh`.
  grok: { low: 'low', medium: 'medium', high: 'high', max: 'xhigh' },
  fake: { low: 'low', medium: 'medium', high: 'high', max: 'max' },
}
