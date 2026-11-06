import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, assert, describe, expect, it, vi } from 'vitest'
import {
  dataOf,
  type EngineRepo,
  engineRepo,
  eventMatching,
  finished,
  ofType,
} from '../testing/engine.js'
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

/**
 * Writes `.rensa/<name>.yaml` before `open()`, so the chain is discovered
 * and committed with the rest. Prompts come from the installed fixtures.
 */
async function addChain(projectDir: string, name: string, yaml: string): Promise<void> {
  await writeFile(path.join(projectDir, `${name}.yaml`), yaml)
}

/** A shell step, then a write agent that pauses before it runs. */
const WRITE_PAUSE_BEFORE = `description: A shell step, then a write agent that pauses first.
steps:
  - id: baseline
    run: echo baseline-ok
  - id: implement
    prompt: steps/review.md
    agents: [{ provider: fake, tools: write }]
    pause: before
`

/** A write agent from the registry, narrowed to read by its step. */
const NARROWED_TO_READ = `description: A write agent narrowed to read for its only step.
agents:
  impl:
    provider: fake
    tools: write
steps:
  - id: review
    prompt: steps/review.md
    agents: [{ from: impl }]
    tools: read
`

/** The same write agent from the registry, used as is. */
const REGISTRY_WRITE = `description: A write agent from the registry, not narrowed.
agents:
  impl:
    provider: fake
    tools: write
steps:
  - id: implement
    prompt: steps/review.md
    agents: [{ from: impl }]
`

async function scribble(repoDir: string): Promise<void> {
  await writeFile(path.join(repoDir, 'scratch.txt'), 'work in progress\n')
}

describe('the working tree and the repository lock', () => {
  it('refuses with DIRTY_TREE and writes no run when a chain with a write agent starts on an uncommitted change', async () => {
    const { open, repo, projectDir, lockFile } = await setup(['agent-write'])
    const engine = await open()
    await scribble(repo.dir)

    const err = await rejection(engine.start('agent-write', { kind: 'none' }))

    expect([err.code, err.message, err.hint]).toEqual([
      'DIRTY_TREE',
      'chain `agent-write` has an agent with write tools, and the checkout has uncommitted changes',
      'commit or stash your changes first',
    ])
    expect(existsSync(path.join(projectDir, 'runs'))).toBe(false)
    expect(existsSync(lockFile)).toBe(false)
  })

  it('refuses with DIRTY_TREE when a chain with shell steps and a write agent starts on an uncommitted change', async () => {
    const { open, repo, projectDir } = await setup(['read-only'])
    await addChain(projectDir, 'write-pause', WRITE_PAUSE_BEFORE)
    const engine = await open()
    await scribble(repo.dir)

    const err = await rejection(engine.start('write-pause', { kind: 'none' }))

    expect(err.code).toBe('DIRTY_TREE')
    expect(existsSync(path.join(projectDir, 'runs'))).toBe(false)
  })

  it('runs a chain of shell steps and a read-only agent to completion on an uncommitted change', async () => {
    const { open, start, repo } = await setup(['three-step'])
    const engine = await open()
    await scribble(repo.dir)

    const handle = await start(engine, 'three-step')
    const { result, events } = await finished(handle)

    expect(result.status).toBe('complete')
    expect(ofType(events, 'step.finished').map((e) => [e.step, dataOf(e).status])).toEqual([
      ['baseline', 'ok'],
      ['review', 'ok'],
      ['wrap-up', 'ok'],
    ])
    expect(await readFile(path.join(repo.dir, 'scratch.txt'), 'utf8')).toBe('work in progress\n')
  })

  it('still takes the lock for a shell chain on an uncommitted change, refusing a second start with LOCKED', async () => {
    const { open, start, repo, lockFile } = await setup(['pause-before'])
    const engine = await open()
    await scribble(repo.dir)
    const first = await start(engine, 'pause-before')
    await eventMatching(first, (e) => e.type === 'run.paused')
    const held = JSON.parse(await readFile(lockFile, 'utf8')) as { run_id: string }

    const err = await rejection(engine.start('pause-before', { kind: 'none' }))

    expect(held.run_id).toBe(first.id)
    expect(err.code).toBe('LOCKED')
    expect(err.message).toContain(first.id)
    first.abort()
    await finished(first)
  })

  it('judges a write agent narrowed to read by its step as read-only and runs it on an uncommitted change', async () => {
    const { open, start, repo, projectDir } = await setup(['read-only'])
    await addChain(projectDir, 'narrowed', NARROWED_TO_READ)
    const engine = await open()
    await scribble(repo.dir)

    const handle = await start(engine, 'narrowed')
    const { result } = await finished(handle)

    expect(result.status).toBe('complete')
  })

  it('refuses with DIRTY_TREE when the same registry write agent is used without narrowing', async () => {
    const { open, repo, projectDir } = await setup(['read-only'])
    await addChain(projectDir, 'registry-write', REGISTRY_WRITE)
    const engine = await open()
    await scribble(repo.dir)

    const err = await rejection(engine.start('registry-write', { kind: 'none' }))

    expect(err.code).toBe('DIRTY_TREE')
  })

  it('refuses a second start with LOCKED, not DIRTY_TREE, while the untracked lock file of a live write-agent run exists', async () => {
    const { open, start, repo, projectDir } = await setup(['read-only'])
    await addChain(projectDir, 'write-pause', WRITE_PAUSE_BEFORE)
    const engine = await open()
    const first = await start(engine, 'write-pause')
    await eventMatching(first, (e) => e.type === 'run.paused')
    const status = await git(repo.dir, ['status', '--porcelain', '--untracked-files=all'])

    const err = await rejection(engine.start('write-pause', { kind: 'none' }))

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

  it('does not count leftover lock temporary files as uncommitted changes when a write-agent chain starts', async () => {
    const { open, start, projectDir } = await setup(['agent-write'])
    const engine = await open()
    await writeFile(path.join(projectDir, 'lock.5f3a9c2e.tmp'), '{"pid":1}\n')
    await writeFile(path.join(projectDir, 'lock.recover.0b1c2d3e.tmp'), '{"pid":1}\n')

    const handle = await start(engine, 'agent-write')
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
