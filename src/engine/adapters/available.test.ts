import { chmod, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type TmpDir, tmpDir } from '../../testing/tmpRepo.js'
import type { Provider } from '../config/types.js'
import { drainDiag, onDiag } from '../diag.js'
import { checkProviders, findOnPath, type ProviderStatus } from './available.js'
import { fakeAdapter } from './fake/index.js'
import type { Adapter, Availability } from './types.js'

beforeEach(() => {
  drainDiag()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

/** An adapter whose availability check is `check`; everything else is unused here. */
function stubAdapter(provider: Provider, check: () => Promise<Availability>): Adapter {
  return {
    provider,
    capabilities: () => ({ resume: false, model: false, effort: [], tools: ['read'] }),
    available: check,
    spawn: () => {
      throw new Error('not used by availability tests')
    },
    // biome-ignore lint/correctness/useYield: never called by availability tests
    parse: async function* () {
      throw new Error('not used by availability tests')
    },
  }
}

const READY: Availability = { status: 'ready', version: '2.1.4' }
const never = () => new Promise<Availability>(() => {})

describe('checking the registered providers', () => {
  it('returns one ready entry when only the fake adapter is checked', async () => {
    const statuses = await checkProviders({}, [fakeAdapter])

    const expected: ProviderStatus[] = [
      { provider: 'fake', availability: { status: 'ready', version: 'fake' } },
    ]
    expect(statuses).toEqual(expected)
  })

  it('reports the stubs as not installed and fake as ready when RENSA_DEV=1', async () => {
    vi.stubEnv('RENSA_DEV', '1')

    const statuses = await checkProviders({})

    const expected: ProviderStatus[] = [
      { provider: 'claude', availability: { status: 'not_installed' } },
      { provider: 'codex', availability: { status: 'not_installed' } },
      { provider: 'grok', availability: { status: 'not_installed' } },
      { provider: 'fake', availability: { status: 'ready', version: 'fake' } },
    ]
    expect(statuses).toEqual(expected)
  })

  it('leaves fake out when RENSA_DEV is unset', async () => {
    vi.stubEnv('RENSA_DEV', undefined)

    const statuses = await checkProviders({})

    expect(statuses.map((s) => s.provider)).toEqual(['claude', 'codex', 'grok'])
  })

  it('passes the given environment to every adapter check', async () => {
    const env = { PATH: '/opt/homebrew/bin:/usr/bin', RENSA_FAKE_AVAILABILITY: 'not_logged_in' }

    const statuses = await checkProviders(env, [fakeAdapter])

    expect(statuses[0]?.availability).toEqual({
      status: 'not_logged_in',
      version: 'fake',
      hint: 'fake login',
    })
  })

  it('returns entries in adapter order when later adapters answer first', async () => {
    const slow = stubAdapter('claude', async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
      return READY
    })
    const fast = stubAdapter('codex', async () => ({ status: 'not_installed' }))

    const statuses = await checkProviders({}, [slow, fast])

    expect(statuses).toEqual([
      { provider: 'claude', availability: READY },
      { provider: 'codex', availability: { status: 'not_installed' } },
    ])
  })
})

describe('starting the checks', () => {
  it('enters every adapter check before any of them resolves', async () => {
    const log: string[] = []
    const waitingAdapter = (provider: Provider) =>
      stubAdapter(provider, async () => {
        log.push(`enter ${provider}`)
        await new Promise((resolve) => setTimeout(resolve, 50))
        log.push(`resolve ${provider}`)
        return READY
      })

    const pending = checkProviders({}, [waitingAdapter('claude'), waitingAdapter('codex')])
    const enteredSynchronously = [...log]
    await pending

    // Both were entered in the calling tick, so before either 50 ms wait ended.
    expect(enteredSynchronously).toEqual(['enter claude', 'enter codex'])
    expect(log).toEqual(['enter claude', 'enter codex', 'resolve claude', 'resolve codex'])
  })
})

describe('checks that fail or hang', () => {
  it('counts a check as not installed and records a diagnostic when it exceeds 3 s', async () => {
    vi.useFakeTimers()
    const answersIn2900ms = stubAdapter(
      'claude',
      () => new Promise((resolve) => setTimeout(() => resolve(READY), 2900)),
    )
    const hangs = stubAdapter('grok', never)
    let result: ProviderStatus[] | undefined

    const pending = checkProviders({}, [answersIn2900ms, hangs]).then((statuses) => {
      result = statuses
    })
    await vi.advanceTimersByTimeAsync(2999)
    const beforeTimeout = result
    await vi.advanceTimersByTimeAsync(1)
    await pending

    expect(beforeTimeout).toBeUndefined()
    expect(result).toEqual([
      { provider: 'claude', availability: READY },
      { provider: 'grok', availability: { status: 'not_installed' } },
    ])
    expect(drainDiag().map((e) => [e.scope, e.message])).toEqual([
      ['grok', 'availability check timed out after 3000 ms'],
    ])
  })

  it('still resolves a timed-out check when a diagnostics listener throws', async () => {
    vi.useFakeTimers()
    const off = onDiag(() => {
      throw new Error('frontend listener broke')
    })
    let result: ProviderStatus[] | undefined

    try {
      const pending = checkProviders({}, [stubAdapter('grok', never)]).then((statuses) => {
        result = statuses
      })
      await vi.advanceTimersByTimeAsync(3000)
      await pending
    } finally {
      off()
    }

    expect(result).toEqual([{ provider: 'grok', availability: { status: 'not_installed' } }])
  })

  it('counts a check as not installed and records why when available() rejects', async () => {
    const rejects = stubAdapter('codex', async () => {
      throw new Error('codex --version: spawn EACCES')
    })

    const statuses = await checkProviders({}, [rejects])

    expect(statuses).toEqual([{ provider: 'codex', availability: { status: 'not_installed' } }])
    expect(drainDiag().map((e) => [e.scope, e.message])).toEqual([
      ['codex', 'availability check failed: codex --version: spawn EACCES'],
    ])
  })

  it('counts a check as not installed when available() throws before returning a promise', async () => {
    const throwsSynchronously = stubAdapter('grok', () => {
      throw new Error('grok: PATH is not a string')
    })
    const ready = stubAdapter('claude', async () => READY)

    const statuses = await checkProviders({}, [throwsSynchronously, ready])

    expect(statuses).toEqual([
      { provider: 'grok', availability: { status: 'not_installed' } },
      { provider: 'claude', availability: READY },
    ])
    expect(drainDiag().map((e) => e.message)).toEqual([
      'availability check failed: grok: PATH is not a string',
    ])
  })
})

describe('finding a binary on PATH', () => {
  let tmp: TmpDir

  beforeEach(async () => {
    tmp = await tmpDir('rensa-findonpath-')
  })

  afterEach(async () => {
    await tmp.cleanup()
  })

  async function executable(dir: string, name: string): Promise<string> {
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, name)
    await writeFile(file, '#!/bin/sh\nexit 0\n')
    await chmod(file, 0o755)
    return file
  }

  it('finds sh when /bin is on PATH', async () => {
    await expect(findOnPath('sh', { PATH: '/bin' })).resolves.toBe('/bin/sh')
  })

  it('returns undefined when no PATH directory holds the binary', async () => {
    await expect(findOnPath('definitely-not-a-binary', { PATH: '/usr/bin:/bin' })).resolves.toBe(
      undefined,
    )
  })

  it('returns undefined when PATH is unset', async () => {
    await expect(findOnPath('sh', {})).resolves.toBe(undefined)
  })

  it('returns the match from the earliest PATH directory when several hold the binary', async () => {
    const first = path.join(tmp.dir, 'first')
    const second = path.join(tmp.dir, 'second')
    await executable(second, 'claude')
    const expected = await executable(first, 'claude')

    const found = await findOnPath('claude', { PATH: `${first}:${second}` })

    expect(found).toBe(expected)
  })

  it('skips a file that is not executable and finds the executable one further along PATH', async () => {
    const plain = path.join(tmp.dir, 'plain')
    await mkdir(plain)
    await writeFile(path.join(plain, 'codex'), 'not a program\n')
    const expected = await executable(path.join(tmp.dir, 'bin'), 'codex')

    const found = await findOnPath('codex', { PATH: `${plain}:${path.dirname(expected)}` })

    expect(found).toBe(expected)
  })

  it('skips a directory that has the binary name', async () => {
    const shadow = path.join(tmp.dir, 'shadow')
    await mkdir(path.join(shadow, 'grok'), { recursive: true })

    await expect(findOnPath('grok', { PATH: shadow })).resolves.toBe(undefined)
  })

  it('checks a name containing a slash as given instead of searching PATH', async () => {
    const file = await executable(path.join(tmp.dir, 'tools'), 'claude')

    await expect(findOnPath(file, { PATH: '/usr/bin:/bin' })).resolves.toBe(file)
  })
})
