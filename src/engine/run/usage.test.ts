import { describe, expect, it } from 'vitest'
import type { Usage } from './types.js'
import { turnUsage } from './usage.js'

// Totals as Codex reports them after its first and second turns of one
// session (rensa's mapping: `input` uncached, `cache_read` the cached part).
const AFTER_FIRST: Usage = { input: 4426, output: 166, cache_read: 29_824 }
const AFTER_SECOND: Usage = { input: 7958, output: 360, cache_read: 58_624 }

describe('one turn of usage from session totals', () => {
  it('subtracts input, output and cache_read field by field when every total grew', () => {
    expect(turnUsage(AFTER_SECOND, AFTER_FIRST)).toEqual({
      usage: { input: 7958 - 4426, output: 360 - 166, cache_read: 58_624 - 29_824 },
      clamped: false,
    })
  })

  it('reports zero for every field and no clamp when the totals did not change', () => {
    expect(turnUsage(AFTER_FIRST, AFTER_FIRST)).toEqual({
      usage: { input: 0, output: 0, cache_read: 0 },
      clamped: false,
    })
  })

  it.each([
    ['input', { ...AFTER_SECOND, input: 4000 }, { input: 0, output: 194, cache_read: 28_800 }],
    ['output', { ...AFTER_SECOND, output: 100 }, { input: 3532, output: 0, cache_read: 28_800 }],
    [
      'cache_read',
      { ...AFTER_SECOND, cache_read: 10_000 },
      { input: 3532, output: 194, cache_read: 0 },
    ],
  ] as const)(
    'clamps %s at 0 and flags the clamp when that total fell below its baseline',
    (_, total, expected) => {
      expect(turnUsage(total, AFTER_FIRST)).toEqual({ usage: expected, clamped: true })
    },
  )

  it('keeps context as reported rather than subtracting it when the total carries one', () => {
    const total: Usage = { ...AFTER_SECOND, context: 34_250 }
    const baseline: Usage = { ...AFTER_FIRST, context: 30_000 }

    expect(turnUsage(total, baseline).usage.context).toBe(34_250)
  })

  it('leaves context out when the total carries none even if the baseline did', () => {
    const baseline: Usage = { ...AFTER_FIRST, context: 30_000 }

    expect(turnUsage(AFTER_SECOND, baseline).usage).not.toHaveProperty('context')
  })

  it('omits cache_read when the total has none even if the baseline had one', () => {
    const total: Usage = { input: 7958, output: 360 }

    expect(turnUsage(total, AFTER_FIRST)).toEqual({
      usage: { input: 7958 - 4426, output: 360 - 166 },
      clamped: false,
    })
  })

  it('reports the whole cache_read when the baseline had none', () => {
    const baseline: Usage = { input: 4426, output: 166 }

    expect(turnUsage(AFTER_SECOND, baseline).usage.cache_read).toBe(58_624)
  })
})
