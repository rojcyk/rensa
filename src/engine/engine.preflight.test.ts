import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, assert, describe, expect, it, vi } from 'vitest'
import { type EngineRepo, engineRepo, eventMatching, finished, ofType } from '../testing/engine.js'
import { deadPid } from '../testing/processes.js'
import { git } from '../testing/tmpRepo.js'
import { Engine, type ProviderStatus, RensaError } from './index.js'

let env: EngineRepo | undefined

afterEach(async () => {
  await env?.cleanup()
  env = undefined
})

async function setup(chains: string[]): Promise<EngineRepo> {
  env = await engineRepo(chains)
  return env
}

async function rejection(promise: Promise<unknown>): Promise<RensaError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  assert(err instanceof RensaError, `expected a RensaError, got ${String(err)}`)
  return err
}

function fakeStatus(statuses: ProviderStatus[] | undefined): ProviderStatus | undefined {
  return statuses?.find((s) => s.provider === 'fake')
}

describe('the working tree and the repository lock', () => {
  it('refuses with DIRTY_TREE and writes no run when a writing chain starts on an uncommitted change', async () => {
    const { open, repo, projectDir } = await setup(['three-step'])
    const engine = await open()
    await writeFile(path.join(repo.dir, 'scratch.txt'), 'work in progress\n')

    const err = await rejection(engine.start('three-step', { kind: 'none' }))

    expect(err.code).toBe('DIRTY_TREE')
    expect(existsSync(path.join(projectDir, 'runs'))).toBe(false)
  })

  it('refuses a second start with LOCKED, not DIRTY_TREE, while the untracked lock file of a live run exists', async () => {
    const { open, start, repo } = await setup(['pause-before'])
    const engine = await open()
    const first = await start(engine, 'pause-before')
    await eventMatching(first, (e) => e.type === 'run.paused')
    const status = await git(repo.dir, ['status', '--porcelain', '--untracked-files=all'])

    const err = await rejection(engine.start('pause-before', { kind: 'none' }))

    expect(status).toBe('?? .rensa/lock\n')
    expect(err.code).toBe('LOCKED')
    expect(err.message).toContain(first.id)
    first.abort()
    await finished(first)
  })

  it('replaces a lock whose pid is dead and holds it for the new run until it finishes', async () => {
    const { open, start, lockFile } = await setup(['pause-before'])
    const engine = await open()
    const stale = {
      pid: deadPid(),
      token: 'stale-token-4f1a',
      run_id: 'old-run-2b7c',
      started_at: '2026-11-01T08:00:00.000Z',
    }
    await writeFile(lockFile, `${JSON.stringify(stale)}\n`)

    const handle = await start(engine, 'pause-before')
    await eventMatching(handle, (e) => e.type === 'run.paused')
    const held = JSON.parse(await readFile(lockFile, 'utf8')) as { pid: number; run_id: string }
    handle.resume()
    const { result } = await finished(handle)

    expect({ pid: held.pid, run_id: held.run_id }).toEqual({ pid: process.pid, run_id: handle.id })
    expect(result.status).toBe('complete')
    expect(existsSync(lockFile)).toBe(false)
  })

  it('does not count leftover lock temporary files as uncommitted changes when a writing chain starts', async () => {
    const { open, start, projectDir } = await setup(['three-step'])
    const engine = await open()
    await writeFile(path.join(projectDir, 'lock.5f3a9c2e.tmp'), '{"pid":1}\n')
    await writeFile(path.join(projectDir, 'lock.recover.0b1c2d3e.tmp'), '{"pid":1}\n')

    const handle = await start(engine, 'three-step')
    const { result } = await finished(handle)

    expect(result.status).toBe('complete')
  })
})

describe('the base ref', () => {
  it('refuses with CONFIG_INVALID when the base names no commit', async () => {
    const { open } = await setup(['read-only'])
    const engine = await open()

    const err = await rejection(
      engine.start('read-only', { kind: 'none' }, { base: 'no-such-branch' }),
    )

    expect([err.code, err.hint]).toEqual([
      'CONFIG_INVALID',
      'pass an existing branch, tag or sha as the base',
    ])
  })

  it('refuses with CONFIG_INVALID when the base starts with a dash', async () => {
    const { open } = await setup(['read-only'])
    const engine = await open()

    const err = await rejection(
      engine.start('read-only', { kind: 'none' }, { base: '--output=/tmp/x' }),
    )

    expect(err.code).toBe('CONFIG_INVALID')
  })
})

describe('headless runs of a chain with pauses', () => {
  it('refuses with CONFIG_INVALID and the --no-pause hint when started headless without noPause', async () => {
    const { open } = await setup(['pause-before'])
    const engine = await open()

    const err = await rejection(engine.start('pause-before', { kind: 'none' }, { headless: true }))

    expect([err.code, err.hint]).toEqual(['CONFIG_INVALID', 'pass --no-pause'])
  })

  it('runs to completion without pausing when started headless with noPause', async () => {
    const { open, start } = await setup(['pause-before'])
    const engine = await open()

    const handle = await start(
      engine,
      'pause-before',
      { kind: 'none' },
      { headless: true, noPause: true },
    )
    const { result, events } = await finished(handle)

    expect(result.status).toBe('complete')
    expect(ofType(events, 'run.paused')).toEqual([])
  })
})

describe('provider checks started by open', () => {
  it('resolves open before the check answers and emits providers once when the check lands', async () => {
    const { repo } = await setup(['read-only'])
    vi.stubEnv('RENSA_FAKE_AVAILABLE_DELAY_MS', '300')
    const openedAt = Date.now()

    const engine = await Engine.open(repo.dir)
    const elapsed = Date.now() - openedAt
    const before = { providers: engine.providers(), missing: engine.chains()[0]?.missingProviders }
    const emitted: ProviderStatus[][] = []
    engine.on('providers', (statuses) => emitted.push(statuses))
    const statuses = await engine.providersChecked

    expect(elapsed).toBeLessThan(300)
    expect(before).toEqual({ providers: undefined, missing: [] })
    expect(emitted).toEqual([statuses])
    expect(fakeStatus(statuses)).toEqual({
      provider: 'fake',
      availability: { status: 'ready', version: 'fake' },
    })
    expect(engine.providers()).toBe(statuses)
  })

  it('rejects start with PROVIDER_UNAVAILABLE after awaiting the check when start follows open at once', async () => {
    const { repo } = await setup(['read-only'])
    vi.stubEnv('RENSA_FAKE_AVAILABLE_DELAY_MS', '300')
    vi.stubEnv('RENSA_FAKE_AVAILABILITY', 'not_installed')

    const engine = await Engine.open(repo.dir)
    const err = await rejection(engine.start('read-only', { kind: 'none' }))

    expect(err.code).toBe('PROVIDER_UNAVAILABLE')
    expect(fakeStatus(engine.providers())?.availability).toEqual({ status: 'not_installed' })
  })

  it('emits providers again with the new status when recheckProviders() runs after the environment changed', async () => {
    const { repo } = await setup(['read-only'])
    const engine = await Engine.open(repo.dir)
    await engine.providersChecked
    const emitted: ProviderStatus[][] = []
    engine.on('providers', (statuses) => emitted.push(statuses))
    vi.stubEnv('RENSA_FAKE_AVAILABILITY', 'not_installed')

    const rechecked = engine.recheckProviders()
    const statuses = await rechecked

    expect(engine.providersChecked).toBe(rechecked)
    expect(emitted).toEqual([statuses])
    expect(fakeStatus(statuses)?.availability).toEqual({ status: 'not_installed' })
    expect(engine.chains()[0]?.missingProviders).toEqual([
      { provider: 'fake', availability: { status: 'not_installed' } },
    ])
  })
})
