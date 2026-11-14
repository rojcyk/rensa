import { describe, expect, it } from 'vitest'
import { parseVersion } from './version.js'

describe('reading --version output', () => {
  it.each([
    ['2.1.319 (Claude Code)', '2.1.319'],
    ['codex-cli 0.166.0', '0.166.0'],
    ['grok 1.0.70 (f50904eaee6c) [stable]', '1.0.70'],
  ])('returns only the version number when given the observed line `%s`', (output, expected) => {
    expect(parseVersion(`${output}\n`)).toBe(expected)
  })

  it('reads the first line only, ignoring update notices that carry another version', () => {
    expect(
      parseVersion('  codex-cli 0.166.0  \nA new version of Codex is available: 0.167.0\n'),
    ).toBe('0.166.0')
  })

  it('drops the prerelease suffix when given a beta version line', () => {
    expect(parseVersion('2.2.0-beta.1 (Claude Code)\n')).toBe('2.2.0')
  })

  it('returns the trimmed first line when it holds no dotted number', () => {
    expect(parseVersion('  nightly build  \n')).toBe('nightly build')
  })

  it('returns undefined when the output is empty', () => {
    expect(parseVersion('')).toBe(undefined)
  })
})
