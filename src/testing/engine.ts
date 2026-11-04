import path from 'node:path'
import { vi } from 'vitest'
import {
  Engine,
  type RunEvent,
  type RunHandle,
  type RunInput,
  type RunResult,
  type StartOptions,
} from '../engine/index.js'
import { commitAll, installChains } from './chains.js'
import { type TmpDir, type TmpRepo, tmpDir, tmpRepo } from './tmpRepo.js'

/**
 * Environment every engine test needs: the fake provider registered, a
 * home directory of the test's own (so no user config or `~` skill leaks
 * in), and no `RENSA_FAKE_*` hook inherited from the shell. Undone by
 * `vi.unstubAllEnvs()`.
 */
export function stubEngineEnv(home: string): void {
  vi.stubEnv('RENSA_DEV', '1')
  vi.stubEnv('HOME', home)
  vi.stubEnv('XDG_CONFIG_HOME', undefined)
  vi.stubEnv('GIT_DIR', undefined)
  vi.stubEnv('GIT_WORK_TREE', undefined)
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('RENSA_FAKE_')) vi.stubEnv(key, undefined)
  }
}

export interface EngineRepo {
  repo: TmpRepo
  home: TmpDir
  /** `<repo>/.rensa` */
  projectDir: string
  lockFile: string
  /** Opens the engine, then commits what `open` created (`.rensa/.gitignore`). */
  open(): Promise<Engine>
  /** Starts a run and remembers it, so `cleanup` can end it if a test failed midway. */
  start(engine: Engine, chain: string, input?: RunInput, opts?: StartOptions): Promise<RunHandle>
  cleanup(): Promise<void>
}

/**
 * A temp repository with the named chains installed and committed, and
 * the engine environment stubbed. Call `cleanup` in `afterEach`.
 */
export async function engineRepo(chains: readonly string[]): Promise<EngineRepo> {
  const repo = await tmpRepo()
  const home = await tmpDir('rensa-home-')
  stubEngineEnv(home.dir)
  const projectDir = path.join(repo.dir, '.rensa')
  await installChains(repo.dir, chains)
  const handles: RunHandle[] = []
  return {
    repo,
    home,
    projectDir,
    lockFile: path.join(projectDir, 'lock'),
    async open() {
      const engine = await Engine.open(repo.dir)
      await commitAll(repo.dir)
      return engine
    },
    async start(engine, chain, input = { kind: 'none' }, opts = {}) {
      const handle = await engine.start(chain, input, opts)
      handles.push(handle)
      return handle
    },
    async cleanup() {
      for (const handle of handles) handle.abort()
      await Promise.allSettled(handles.map((h) => within(h.done, 10_000, `run ${h.id} to end`)))
      vi.unstubAllEnvs()
      await Promise.all([repo.cleanup(), home.cleanup()])
    },
  }
}

/** Rejects when `promise` has not settled within `ms`, so a hang fails the test instead of timing it out. */
export async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: not within ${ms} ms`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** The first event, in history or live, that `match` accepts. */
export function eventMatching(
  handle: RunHandle,
  match: (event: RunEvent) => boolean,
  ms = 5_000,
): Promise<RunEvent> {
  let detach = () => {}
  const found = new Promise<RunEvent>((resolve, reject) => {
    const sub = handle.attach({
      event(event) {
        if (match(event)) resolve(event)
      },
      finished() {
        reject(new Error('the run finished without a matching event'))
      },
    })
    detach = sub.detach
    const seen = sub.events.find(match)
    if (seen) resolve(seen)
  })
  return within(found, ms, 'matching event').finally(() => detach())
}

export function ofType(events: ReadonlyArray<RunEvent>, type: string): RunEvent[] {
  return events.filter((e) => e.type === type)
}

/** `data` of an event, for fields the narrowed union does not expose. */
export function dataOf(event: RunEvent | undefined): Record<string, unknown> {
  const data = event && 'data' in event ? event.data : undefined
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}
}

/** Everything a test usually reads after a run: the result and the history. */
export async function finished(
  handle: RunHandle,
  ms = 10_000,
): Promise<{ result: RunResult; events: ReadonlyArray<RunEvent> }> {
  const result = await within(handle.done, ms, `run ${handle.id} to finish`)
  return { result, events: handle.events() }
}
