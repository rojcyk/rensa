import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Provider } from '../config/types.js'
import { RensaError } from '../errors.js'
import { fakeAdapter } from './fake/index.js'
import { allAdapters, getAdapter } from './registry.js'
import type { SpawnRequest } from './types.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

const REAL: Provider[] = ['claude', 'codex', 'grok']

const request: SpawnRequest = {
  cwd: '/Users/alice/code/shop',
  env: {},
  message: 'Summarize README.md',
  tools: 'read',
  session: { id: 'ses_4f2a9c', resume: false },
  stagingDir: '/Users/alice/code/shop/.rensa/runs/r_8c1d/agents/review/claude',
  timeoutMs: 60_000,
}

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

describe('stub adapters for providers not yet implemented', () => {
  it.each(REAL)('reports %s as not installed when its availability is checked', async (p) => {
    await expect(getAdapter(p).available({ PATH: '/usr/bin:/bin' })).resolves.toEqual({
      status: 'not_installed',
    })
  })

  it.each(REAL)('throws an INTERNAL RensaError when %s is spawned', (provider) => {
    const spawn = () => getAdapter(provider).spawn(request)

    expect(spawn).toThrow(RensaError)
    expect(spawn).toThrow(
      expect.objectContaining({
        code: 'INTERNAL',
        message: `${provider} adapter not implemented`,
      }),
    )
  })

  it.each(REAL)('throws an INTERNAL RensaError when %s parses output', async (provider) => {
    async function* lines() {
      yield '{"type":"result"}'
    }

    const parsing = (async () => {
      for await (const _ of getAdapter(provider).parse(lines())) {
        // A stub yields nothing before failing.
      }
    })()

    await expect(parsing).rejects.toThrow(
      expect.objectContaining({ code: 'INTERNAL', message: `${provider} adapter not implemented` }),
    )
  })

  it('offers grok no max effort because the effort table maps none', () => {
    expect(getAdapter('grok').capabilities().effort).toEqual(['low', 'medium', 'high'])
  })

  it('offers codex every effort level because the effort table maps each one', () => {
    expect(getAdapter('codex').capabilities().effort).toEqual(['low', 'medium', 'high', 'max'])
  })
})
