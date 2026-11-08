import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Provider } from '../config/types.js'
import { claudeAdapter } from './claude/index.js'
import { codexAdapter } from './codex/index.js'
import { fakeAdapter } from './fake/index.js'
import { grokAdapter } from './grok/index.js'
import { allAdapters, getAdapter } from './registry.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

const REAL: Provider[] = ['claude', 'codex', 'grok']

describe('which adapters are registered', () => {
  it('lists claude, codex and grok but not fake when RENSA_DEV is unset', () => {
    vi.stubEnv('RENSA_DEV', undefined)

    expect(allAdapters().map((a) => a.provider)).toEqual(['claude', 'codex', 'grok'])
  })

  it('lists fake after the real providers when RENSA_DEV=1', () => {
    vi.stubEnv('RENSA_DEV', '1')

    expect(allAdapters().map((a) => a.provider)).toEqual(['claude', 'codex', 'grok', 'fake'])
  })

  it('does not register fake when RENSA_DEV has a value other than 1', () => {
    vi.stubEnv('RENSA_DEV', 'true')

    expect(allAdapters().map((a) => a.provider)).not.toContain('fake')
  })

  it('reads RENSA_DEV at call time when it changes after the module loaded', () => {
    vi.stubEnv('RENSA_DEV', undefined)
    const before = allAdapters().map((a) => a.provider)

    vi.stubEnv('RENSA_DEV', '1')
    const after = allAdapters().map((a) => a.provider)

    expect(before).not.toContain('fake')
    expect(after).toContain('fake')
  })
})

describe('looking up an adapter by provider', () => {
  it.each(REAL)('returns the %s adapter whatever RENSA_DEV says', (provider) => {
    vi.stubEnv('RENSA_DEV', undefined)

    expect(getAdapter(provider).provider).toBe(provider)
  })

  it('returns the real claude adapter rather than a stub when claude is looked up', () => {
    expect(getAdapter('claude')).toBe(claudeAdapter)
  })

  it('returns the real grok adapter rather than a stub when grok is looked up', () => {
    expect(getAdapter('grok')).toBe(grokAdapter)
  })

  it('returns the real codex adapter rather than a stub when codex is looked up', () => {
    expect(getAdapter('codex')).toBe(codexAdapter)
  })

  it('returns the fake adapter when RENSA_DEV=1', () => {
    vi.stubEnv('RENSA_DEV', '1')

    expect(getAdapter('fake')).toBe(fakeAdapter)
  })

  it('refuses fake with PROVIDER_UNAVAILABLE and a RENSA_DEV hint when RENSA_DEV is unset', () => {
    vi.stubEnv('RENSA_DEV', undefined)

    expect(() => getAdapter('fake')).toThrow(
      expect.objectContaining({
        name: 'RensaError',
        code: 'PROVIDER_UNAVAILABLE',
        hint: 'set RENSA_DEV=1',
      }),
    )
  })
})

describe('the grok adapter as registered', () => {
  it('offers every effort level including max when grok is looked up, since max maps to xhigh', () => {
    expect(getAdapter('grok').capabilities()).toEqual({
      resume: true,
      model: true,
      effort: ['low', 'medium', 'high', 'max'],
      tools: ['read', 'write'],
    })
  })

  it('reports grok as not installed when no PATH directory holds grok', async () => {
    await expect(getAdapter('grok').available({ PATH: '/nonexistent/rensa-bin' })).resolves.toEqual(
      {
        status: 'not_installed',
      },
    )
  })
})

describe('the codex adapter as registered', () => {
  it('offers every effort level including max and declares session_total usage when codex is looked up', () => {
    expect(getAdapter('codex').capabilities()).toEqual({
      resume: true,
      model: true,
      effort: ['low', 'medium', 'high', 'max'],
      tools: ['read', 'write'],
      usage: 'session_total',
    })
  })

  it('reports codex as not installed when no PATH directory holds codex', async () => {
    await expect(
      getAdapter('codex').available({ PATH: '/nonexistent/rensa-bin' }),
    ).resolves.toEqual({ status: 'not_installed' })
  })
})
