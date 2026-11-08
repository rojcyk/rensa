import stringWidth from 'string-width'
import { describe, expect, it } from 'vitest'
import { ELLIPSIS, formatElapsed, formatTokens, oneLine, truncateEnd } from './format.js'

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

describe('elapsed time in the agent row and the status line', () => {
  it.each([
    [0, '0:00'],
    [999, '0:00'],
    [SECOND, '0:01'],
    [59 * SECOND + 999, '0:59'],
    [MINUTE, '1:00'],
    [MINUTE + 52 * SECOND, '1:52'],
    [10 * MINUTE + 5 * SECOND, '10:05'],
    [59 * MINUTE + 59 * SECOND, '59:59'],
  ])('reads as m:ss when %i ms is under an hour (%s)', (ms, expected) => {
    expect(formatElapsed(ms)).toBe(expected)
  })

  it.each([
    [HOUR, '1:00:00'],
    [HOUR + 5 * MINUTE + 7 * SECOND, '1:05:07'],
    [10 * HOUR + 10 * MINUTE + 10 * SECOND, '10:10:10'],
  ])('reads as h:mm:ss when %i ms is an hour or more (%s)', (ms, expected) => {
    expect(formatElapsed(ms)).toBe(expected)
  })

  it.each([[-5 * SECOND], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    'reads as 0:00 when the duration is negative or not finite (%s)',
    (ms) => {
      expect(formatElapsed(ms)).toBe('0:00')
    },
  )
})

describe('token counts in the agent row', () => {
  it.each([
    [0, '0'],
    [42, '42'],
    [999, '999'],
  ])('shows %i as is when it is below 1000', (n, expected) => {
    expect(formatTokens(n)).toBe(expected)
  })

  it.each([
    [1000, '1.0k'],
    [1049, '1.0k'],
    [12_400, '12.4k'],
    [99_900, '99.9k'],
    [1_250_000, '1250.0k'],
  ])('shows %i in thousands with one decimal and k when it is 1000 or more', (n, expected) => {
    expect(formatTokens(n)).toBe(expected)
  })

  it.each([[-12], [Number.NaN]])('shows 0 when the count is negative or not a number (%s)', (n) => {
    expect(formatTokens(n)).toBe('0')
  })
})

describe('truncating text to a number of terminal cells', () => {
  it('returns the text unchanged when it fits exactly', () => {
    expect(truncateEnd('implement', 9)).toBe('implement')
  })

  it('cuts with an ellipsis and fills the width when the text is one cell too long', () => {
    expect(truncateEnd('review-codex', 11)).toBe(`review-cod${ELLIPSIS}`)
  })

  it('never splits a wide character and stays within the width when cutting CJK', () => {
    const cut = truncateEnd('日本語のテキスト', 6)

    expect(cut).toBe(`日本${ELLIPSIS}`)
    expect(stringWidth(cut)).toBeLessThanOrEqual(6)
  })

  it('keeps an emoji ZWJ sequence whole when the cut falls after it', () => {
    const family = '👨‍👩‍👧'

    expect(truncateEnd(`${family}${family} done`, 5)).toBe(`${family}${family}${ELLIPSIS}`)
  })

  it('returns only the ellipsis when the width is 1 and the text is longer', () => {
    expect(truncateEnd('baseline', 1)).toBe(ELLIPSIS)
  })

  it('returns the empty string when the width is 0', () => {
    expect(truncateEnd('baseline', 0)).toBe('')
  })
})

describe('folding a multi-line string onto one line', () => {
  it('joins lines with one space and trims the ends when the command spans lines', () => {
    expect(oneLine('  echo one\n\n   echo two\n')).toBe('echo one echo two')
  })
})
