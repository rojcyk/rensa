import { describe, expect, it } from 'vitest'
import { appendNotes, extractTrailingJson, renderOutputMap, tail } from './output.js'

describe('rendering an agent output map as sections', () => {
  it('renders a heading and the text verbatim when the map has one string entry', () => {
    const map = { claude: 'Looks good overall.\n\n- rename `x` to `total`\n' }

    expect(renderOutputMap(map)).toBe(
      '### claude\n\nLooks good overall.\n\n- rename `x` to `total`\n',
    )
  })

  it('renders the value as 2-space pretty JSON when the map has one object entry', () => {
    const map = { codex: { verdict: 'fail', issues: ['cart total ignores coupon'] } }

    expect(renderOutputMap(map)).toBe(
      [
        '### codex',
        '',
        '{',
        '  "verdict": "fail",',
        '  "issues": [',
        '    "cart total ignores coupon"',
        '  ]',
        '}',
      ].join('\n'),
    )
  })

  it('separates sections by one blank line in insertion order when the map has two entries', () => {
    const map = {
      'review-logic': 'No logic errors.',
      grok: { verdict: 'pass' },
    }

    expect(renderOutputMap(map)).toBe(
      '### review-logic\n\nNo logic errors.\n\n### grok\n\n{\n  "verdict": "pass"\n}',
    )
  })
})

describe('tailing long output', () => {
  const FULL = '/home/alice/shop/.rensa/runs/20261031-142233-review/steps/test/output.log'

  it('returns the text unchanged when it is under the byte limit', () => {
    const text = 'PASS src/cart.test.ts\n'

    expect(tail(text, 16384, FULL)).toBe(text)
  })

  it('returns the text unchanged when it is exactly at the byte limit', () => {
    const text = 'line one\nline two\n'

    expect(tail(text, 18, FULL)).toBe(text)
  })

  it('cuts forward to the next line boundary behind a marker line when over the limit', () => {
    // 'line one\n' (9) + 'line two\n' (9) + 'line three\n' (11) = 29 bytes.
    // The last 15 bytes start inside 'line two', so the cut moves forward
    // past its newline and keeps only 'line three\n'.
    const text = 'line one\nline two\nline three\n'

    expect(tail(text, 15, FULL)).toBe(`[… 18 bytes cut; full output: ${FULL}]\nline three\n`)
  })

  it('keeps the line the cut lands on when the cut falls exactly on a line start', () => {
    // 22 + 22 + 12 bytes; the last 34 start exactly at the second line, and
    // a third line follows it, so skipping ahead would lose the FAIL line.
    const text = 'PASS src/user.test.ts\nFAIL src/cart.test.ts\n  1 failing\n'

    expect(tail(text, 34, FULL)).toBe(
      `[… 22 bytes cut; full output: ${FULL}]\nFAIL src/cart.test.ts\n  1 failing\n`,
    )
  })

  it('keeps the end of the last line when it alone is longer than the limit', () => {
    // One 69-byte reporter line; its last 30 bytes are kept mid-line.
    const text = '{"numFailedTests":1,"failureMessage":"TypeError: cart is undefined"}\n'

    expect(tail(text, 30, FULL)).toBe(
      `[… 39 bytes cut; full output: ${FULL}]\nypeError: cart is undefined"}\n`,
    )
  })

  it('starts on a whole character when the end of an over-long line is kept', () => {
    // 'é' is two bytes, so 'éééé\n' is 9; its last 4 start mid-character.
    expect(tail('éééé\n', 4, FULL)).toBe(`[… 6 bytes cut; full output: ${FULL}]\né\n`)
  })

  it('counts UTF-8 bytes rather than characters when deciding to cut', () => {
    // 19 characters but 22 bytes: each accented letter is two bytes.
    const text = 'café crème\nsoufflé\n'

    expect(tail(text, 20, FULL)).toBe(`[… 13 bytes cut; full output: ${FULL}]\nsoufflé\n`)
  })
})

describe('extracting a trailing JSON object from a reply', () => {
  it('returns the object when the reply ends with bare JSON after prose', () => {
    const text = 'Reviewed the diff.\n\n{"verdict": "pass", "issues": []}\n'

    expect(extractTrailingJson(text)).toEqual({ verdict: 'pass', issues: [] })
  })

  it('returns the object when the reply ends with a fenced JSON block', () => {
    const text = 'Summary below.\n\n```json\n{"verdict": "fail", "count": 2}\n```\n'

    expect(extractTrailingJson(text)).toEqual({ verdict: 'fail', count: 2 })
  })

  it('returns undefined when the reply is prose only', () => {
    expect(extractTrailingJson('All tests pass and the diff looks clean.')).toBeUndefined()
  })

  it('returns undefined when a JSON object sits in the middle and prose follows it', () => {
    const text = 'Result: {"verdict": "pass"}\nLet me know if you want more detail.'

    expect(extractTrailingJson(text)).toBeUndefined()
  })

  it('matches the outer braces when strings inside the object contain braces', () => {
    const text =
      'Done.\n{"note": "wrap it in {braces}", "fix": "use } then {", "meta": {"depth": 2}}'

    expect(extractTrailingJson(text)).toEqual({
      note: 'wrap it in {braces}',
      fix: 'use } then {',
      meta: { depth: 2 },
    })
  })

  it('treats escaped quotes as string content when a string contains a brace after them', () => {
    const text = 'Done.\n{"quote": "she said \\"{\\" twice", "path": "C:\\\\"}'

    expect(extractTrailingJson(text)).toEqual({ quote: 'she said "{" twice', path: 'C:\\' })
  })

  it('returns only the last object when earlier prose also contains braces', () => {
    const text = 'Use {placeholders} in prompts.\n{"verdict": "pass"}'

    expect(extractTrailingJson(text)).toEqual({ verdict: 'pass' })
  })

  it('returns undefined when the reply ends with a JSON array', () => {
    expect(extractTrailingJson('Issues:\n[{"line": 12}, {"line": 40}]')).toBeUndefined()
  })

  it('returns undefined when the trailing braces do not hold valid JSON', () => {
    expect(extractTrailingJson('Done.\n{verdict: pass}')).toBeUndefined()
  })
})

describe('appending user notes to a message', () => {
  const MESSAGE = 'Review the diff against main.'

  it('returns the message unchanged when there are no notes', () => {
    expect(appendNotes(MESSAGE, [])).toBe(MESSAGE)
  })

  it('appends a heading and a numbered list in order when notes are given', () => {
    const notes = ['Ignore the generated files in dist/.', 'Focus on the coupon logic.']

    expect(appendNotes(MESSAGE, notes)).toBe(
      'Review the diff against main.\n\n## User notes\n\n' +
        '1. Ignore the generated files in dist/.\n2. Focus on the coupon logic.',
    )
  })

  it('keeps placeholders verbatim when a note contains one', () => {
    expect(appendNotes(MESSAGE, ['Compare with {{base}} only.'])).toBe(
      'Review the diff against main.\n\n## User notes\n\n1. Compare with {{base}} only.',
    )
  })
})
