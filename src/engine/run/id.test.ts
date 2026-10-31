import { describe, expect, it } from 'vitest'
import { newRunId } from './id.js'

describe('run id', () => {
  it('formats as YYYY-MM-DD_HHMM_<chain>_<4 hex> in local time when given a start time', () => {
    // Local-time constructor: the id must show these fields whatever the TZ.
    const now = new Date(2026, 9, 28, 9, 12, 45)

    const id = newRunId('tdd-review', now)

    expect(id).toMatch(/^2026-10-28_0912_tdd-review_[0-9a-f]{4}$/)
  })

  it('zero-pads month, day, hour and minute when each is a single digit', () => {
    const now = new Date(2027, 0, 5, 3, 7)

    const id = newRunId('lint_fix', now)

    expect(id).toMatch(/^2027-01-05_0307_lint_fix_[0-9a-f]{4}$/)
  })

  it('gives distinct ids when called 100 times for one chain in the same minute', () => {
    const now = new Date(2026, 9, 28, 9, 12)

    const ids = Array.from({ length: 100 }, () => newRunId('tdd-review', now))

    // The suffix is 16 bits, so 100 draws collide with ~7% probability
    // (birthday bound). Requiring all 100 distinct would flake; requiring
    // at least 95 still fails for a constant or low-entropy suffix, while a
    // false failure needs six collisions (probability ~1e-10).
    expect(new Set(ids).size).toBeGreaterThanOrEqual(95)
  })
})
