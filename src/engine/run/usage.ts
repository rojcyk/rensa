import type { Usage } from './types.js'

/**
 * One turn's usage from a session's running totals and the totals the
 * session reported after its previous turn. Every reported field is
 * subtracted; a field that came back lower than its baseline is clamped
 * at 0 and `clamped` says so. `context` is not a running total and is
 * kept as reported.
 */
export function turnUsage(total: Usage, baseline: Usage): { usage: Usage; clamped: boolean } {
  let clamped = false
  const minus = (now: number, before: number | undefined): number => {
    const diff = now - (before ?? 0)
    if (diff >= 0) return diff
    clamped = true
    return 0
  }
  const usage: Usage = {
    input: minus(total.input, baseline.input),
    output: minus(total.output, baseline.output),
    ...(total.cache_read !== undefined && {
      cache_read: minus(total.cache_read, baseline.cache_read),
    }),
    ...(total.context !== undefined && { context: total.context }),
  }
  return { usage, clamped }
}
