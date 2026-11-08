import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dataOf, type EngineRepo, engineRepo, finished, ofType } from '../testing/engine.js'
import { fakeAdapter } from './adapters/fake/index.js'
import type { AgentEvent, AgentProcess, SpawnRequest } from './adapters/types.js'
import { drainDiag } from './diag.js'
import { type RunHandle, readRunJson } from './index.js'
import type { AgentError, Usage } from './run/types.js'

// How the engine reports usage for a provider whose totals cover the
// whole session (`Capabilities.usage: 'session_total'`, as Codex): the
// fake adapter stands in for the provider, with its capabilities saying
// session_total and each step's turn scripted.

let env: EngineRepo | undefined

beforeEach(() => {
  drainDiag()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await env?.cleanup()
  env = undefined
})

/** One named agent used by three steps; the middle one may fail and the run goes on. */
const NAMED_THREE = `description: One named agent used by three steps.
agents:
  impl:
    provider: fake
    tools: read
    prompt: agents/implementer.md
steps:
  - id: draft
    prompt: steps/review.md
    agents: [impl]
  - id: refine
    prompt: steps/summarize.md
    agents: [impl]
    on_fail: continue
  - id: polish
    prompt: steps/review.md
    agents: [impl]
`

async function setup(chains: string[], extra: Record<string, string> = {}): Promise<EngineRepo> {
  env = await engineRepo(chains)
  for (const [name, yaml] of Object.entries(extra)) {
    await writeFile(path.join(env.projectDir, `${name}.yaml`), yaml)
  }
  return env
}

/** What a scripted turn ends with: its usage totals, if any, and how it ended. */
interface Turn {
  usage?: Usage
  exitCode?: number
  error?: AgentError
}

/**
 * Makes the fake adapter report session totals and play `turns[step]` for
 * each step instead of a fixture. Returns the session each step was spawned with.
 */
function sessionTotalsProvider(turns: Record<string, Turn>): Map<string, SpawnRequest['session']> {
  const real = fakeAdapter.capabilities()
  vi.spyOn(fakeAdapter, 'capabilities').mockReturnValue({ ...real, usage: 'session_total' })
  const sessions = new Map<string, SpawnRequest['session']>()
  vi.spyOn(fakeAdapter, 'spawn').mockImplementation((req): AgentProcess => {
    const step = req.env.RENSA_STEP ?? '(no step)'
    sessions.set(step, req.session)
    const turn = turns[step]
    if (turn === undefined) throw new Error(`no turn scripted for step ${step}`)
    const reply = `Finished ${step}.`
    async function* events(): AsyncGenerator<AgentEvent> {
      yield { kind: 'text', text: reply }
      if (turn?.usage) yield { kind: 'usage', usage: turn.usage }
      yield {
        kind: 'done',
        reply,
        exitCode: turn?.exitCode ?? 0,
        ...(turn?.usage && { usage: turn.usage }),
        ...(turn?.error && { error: turn.error }),
      }
    }
    return { kill: () => {}, events: events() }
  })
  return sessions
}

/** `usage` of each step's agent.finished, in step order; undefined where none was reported. */
function finishedUsage(handle: RunHandle): Array<[string | undefined, unknown]> {
  return ofType(handle.events(), 'agent.finished').map((e) => [e.step, dataOf(e).usage])
}

function clampDiags(): string[] {
  return drainDiag()
    .filter((e) => e.scope === 'engine' && e.message.includes('session usage totals'))
    .map((e) => e.message)
}

async function runJsonOf(handle: RunHandle) {
  return readRunJson(path.join(handle.dir, 'run.json'))
}

// Codex's running totals after each of three turns of one session.
const AFTER_DRAFT: Usage = { input: 4426, output: 166, cache_read: 29_824 }
const AFTER_REFINE: Usage = { input: 7958, output: 360, cache_read: 58_624 }
const AFTER_POLISH: Usage = { input: 9104, output: 512, cache_read: 91_136 }

describe('usage of a named agent on a session_total provider', () => {
  it('reports the first turn unchanged and each resumed turn as the difference from the previous totals', async () => {
    const sessions = sessionTotalsProvider({
      draft: { usage: AFTER_DRAFT },
      refine: { usage: AFTER_REFINE },
      polish: { usage: AFTER_POLISH },
    })
    const { open, start } = await setup([], { 'named-three': NAMED_THREE })
    const engine = await open()

    const handle = await start(engine, 'named-three')
    await finished(handle)

    expect([...sessions.values()].map((s) => s.resume)).toEqual([false, true, true])
    expect(finishedUsage(handle)).toEqual([
      ['draft', AFTER_DRAFT],
      ['refine', { input: 7958 - 4426, output: 360 - 166, cache_read: 58_624 - 29_824 }],
      ['polish', { input: 9104 - 7958, output: 512 - 360, cache_read: 91_136 - 58_624 }],
    ])
    expect((await runJsonOf(handle)).session_usage).toEqual({ impl: AFTER_POLISH })
    expect(clampDiags()).toEqual([])
  })

  it('writes the first turn totals to run.json as the baseline when the resumed turn reports no usage', async () => {
    sessionTotalsProvider({ draft: { usage: AFTER_DRAFT }, refine: {} })
    const { open, start } = await setup(['named-resume'])
    const engine = await open()

    const handle = await start(engine, 'named-resume')
    await finished(handle)

    expect(finishedUsage(handle)).toEqual([
      ['draft', AFTER_DRAFT],
      ['refine', undefined],
    ])
    expect((await runJsonOf(handle)).session_usage).toEqual({ impl: AFTER_DRAFT })
  })

  it('keeps the baseline when a resumed turn fails without usage, so the next turn subtracts the last reported totals', async () => {
    sessionTotalsProvider({
      draft: { usage: AFTER_DRAFT },
      refine: {
        exitCode: 1,
        error: { kind: 'exit', message: 'stream disconnected before completion' },
      },
      polish: { usage: AFTER_POLISH },
    })
    const { open, start } = await setup([], { 'named-three': NAMED_THREE })
    const engine = await open()

    const handle = await start(engine, 'named-three')
    await finished(handle)

    expect(finishedUsage(handle)).toEqual([
      ['draft', AFTER_DRAFT],
      ['refine', undefined],
      ['polish', { input: 9104 - 4426, output: 512 - 166, cache_read: 91_136 - 29_824 }],
    ])
    expect((await runJsonOf(handle)).session_usage).toEqual({ impl: AFTER_POLISH })
  })

  it('clamps a field at 0 and records a diag naming the step and agent when the totals fell below the previous turn', async () => {
    const lower: Usage = { input: 7958, output: 100, cache_read: 58_624 }
    sessionTotalsProvider({ draft: { usage: AFTER_DRAFT }, refine: { usage: lower } })
    const { open, start } = await setup(['named-resume'])
    const engine = await open()

    const handle = await start(engine, 'named-resume')
    await finished(handle)

    expect(finishedUsage(handle)[1]).toEqual([
      'refine',
      { input: 7958 - 4426, output: 0, cache_read: 58_624 - 29_824 },
    ])
    expect(clampDiags()).toEqual([
      "refine/impl: session usage totals fell below the previous turn's; clamped at 0",
    ])
    expect((await runJsonOf(handle)).session_usage).toEqual({ impl: lower })
  })
})

describe('usage left as reported', () => {
  it('reports each fresh agent turn unchanged and writes no session_usage when the provider is session_total', async () => {
    sessionTotalsProvider({
      'first-pass': { usage: AFTER_DRAFT },
      'second-pass': { usage: AFTER_REFINE },
    })
    const { open, start } = await setup(['fresh-twice'])
    const engine = await open()

    const handle = await start(engine, 'fresh-twice')
    await finished(handle)

    expect(finishedUsage(handle)).toEqual([
      ['first-pass', AFTER_DRAFT],
      ['second-pass', AFTER_REFINE],
    ])
    expect(await runJsonOf(handle)).not.toHaveProperty('session_usage')
  })

  it('reports a per_turn named agent turn unchanged on resume and writes no session_usage', async () => {
    // The real fake adapter: per_turn by default, replaying the hello fixture.
    const { open, start } = await setup(['named-resume'])
    // After setup, which clears inherited RENSA_FAKE_* hooks.
    vi.stubEnv('RENSA_FAKE_DELAY_MS', '0')
    const engine = await open()

    const handle = await start(engine, 'named-resume')
    await finished(handle)

    const hello: Usage = { input: 240, output: 42, cache_read: 100 }
    expect(finishedUsage(handle)).toEqual([
      ['draft', hello],
      ['refine', hello],
    ])
    expect(await runJsonOf(handle)).not.toHaveProperty('session_usage')
  })
})
