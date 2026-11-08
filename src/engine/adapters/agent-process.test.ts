import { describe, expect, it } from 'vitest'
import type { SpawnResult } from '../process/spawn.js'
import { type AgentDriver, type ProcessOutcome, reconcileDone } from './agent-process.js'
import { classifyText } from './grok/parse.js'
import type { DoneEvent } from './types.js'

// The reconciliation rules on `Adapter.spawn`, exercised with Grok's
// classifier as the provider-specific part.

const DRIVER: Pick<AgentDriver, 'provider' | 'classifyText'> = { provider: 'grok', classifyText }

const NOT_SIGNED_IN = 'Not signed in. To authenticate without a browser, run:'

function spawnResult(overrides: Partial<SpawnResult> = {}): SpawnResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    killed: false,
    durationMs: 5320,
    ...overrides,
  }
}

function ran(overrides: Partial<SpawnResult> = {}): ProcessOutcome {
  return { started: true, result: spawnResult(overrides) }
}

const PARSED_OK: DoneEvent = {
  kind: 'done',
  reply: 'No regressions found in the diff.',
  exitCode: null,
  usage: { input: 6174, output: 426, cache_read: 12_928, context: 10_003 },
}

const PARSED_NO_OUTPUT: DoneEvent = {
  kind: 'done',
  reply: '',
  exitCode: null,
  error: { kind: 'no_output', message: 'no end event in the stream' },
}

const PARSED_AUTH: DoneEvent = {
  kind: 'done',
  reply: '',
  exitCode: null,
  error: { kind: 'auth', message: NOT_SIGNED_IN },
}

describe('reconciling the final done with the process', () => {
  it('keeps reply and usage, takes exit code 0 and sets no error when the process exits 0', () => {
    const done = reconcileDone(PARSED_OK, ran(), [], DRIVER)

    expect(done).toEqual({ ...PARSED_OK, exitCode: 0 })
  })

  it('keeps the parser sessionId when the parser reported one', () => {
    const parsed: DoneEvent = { ...PARSED_OK, sessionId: '019a5f3c-7b2e-7d41-9c8a-3e6f0b1d2a47' }

    const done = reconcileDone(parsed, ran(), [], DRIVER)

    expect(done.sessionId).toBe('019a5f3c-7b2e-7d41-9c8a-3e6f0b1d2a47')
  })

  it('reports exit with the spawn message and a null exit code when the process never started', () => {
    const done = reconcileDone(
      PARSED_NO_OUTPUT,
      { started: false, message: 'cannot run `grok`: not found' },
      [],
      DRIVER,
    )

    expect(done).toEqual({
      kind: 'done',
      reply: '',
      exitCode: null,
      error: { kind: 'exit', message: 'cannot run `grok`: not found' },
    })
  })

  it('reports exit killed with a null exit code when kill() stopped the process even if the parser saw auth', () => {
    const done = reconcileDone(
      PARSED_AUTH,
      ran({ exitCode: null, signal: 'SIGTERM', killed: true }),
      [`Error: ${NOT_SIGNED_IN}`],
      DRIVER,
    )

    expect(done.exitCode).toBe(null)
    expect(done.error).toEqual({ kind: 'exit', message: 'killed' })
  })

  it('reports exit timed out when the timeout stopped the process', () => {
    const done = reconcileDone(
      PARSED_OK,
      ran({ exitCode: null, signal: 'SIGTERM', killed: true, timedOut: true }),
      [],
      DRIVER,
    )

    expect(done.error).toEqual({ kind: 'exit', message: 'timed out' })
  })

  it('turns a parser no_output into auth with the stderr line when stderr says not signed in', () => {
    const done = reconcileDone(
      PARSED_NO_OUTPUT,
      ran({ exitCode: 1 }),
      ['warning: config.toml has an unknown key "theme"', `Error: ${NOT_SIGNED_IN}`],
      DRIVER,
    )

    expect(done).toEqual({
      kind: 'done',
      reply: '',
      exitCode: 1,
      error: { kind: 'auth', message: `Error: ${NOT_SIGNED_IN}` },
    })
  })

  it('turns a parser exit error into usage_limit with the stderr line when stderr reports the limit', () => {
    const parsed: DoneEvent = {
      kind: 'done',
      reply: '',
      exitCode: null,
      error: { kind: 'exit', message: 'request failed' },
    }

    const done = reconcileDone(parsed, ran({ exitCode: 1 }), ['Error: usage limit reached'], DRIVER)

    expect(done.error).toEqual({ kind: 'usage_limit', message: 'Error: usage limit reached' })
  })

  it('keeps a parser auth error when stderr shows a usage limit', () => {
    const done = reconcileDone(PARSED_AUTH, ran({ exitCode: 1 }), ['Rate limit exceeded'], DRIVER)

    expect(done.error).toEqual({ kind: 'auth', message: NOT_SIGNED_IN })
  })

  it('keeps a parser no_output when stderr shows neither auth nor a usage limit', () => {
    const done = reconcileDone(
      PARSED_NO_OUTPUT,
      ran({ exitCode: 1 }),
      ['Segmentation fault'],
      DRIVER,
    )

    expect(done.error).toEqual(PARSED_NO_OUTPUT.error)
  })

  it('reports auth from stderr when the exit is non-zero and the parser saw no error', () => {
    const done = reconcileDone(PARSED_OK, ran({ exitCode: 1 }), ['Error: run grok login'], DRIVER)

    expect(done.error).toEqual({ kind: 'auth', message: 'Error: run grok login' })
  })

  it('reports exit with the last non-blank stderr line when the exit is non-zero and stderr explains nothing', () => {
    const done = reconcileDone(
      PARSED_OK,
      ran({ exitCode: 3 }),
      [
        "thread 'main' panicked at src/session.rs:88:14:",
        'called `Option::unwrap()` on a `None` value',
        '',
      ],
      DRIVER,
    )

    expect(done).toEqual({
      ...PARSED_OK,
      exitCode: 3,
      error: { kind: 'exit', message: 'called `Option::unwrap()` on a `None` value' },
    })
  })

  it('reports exit naming the provider and code when the exit is non-zero and stderr is empty', () => {
    const done = reconcileDone(PARSED_OK, ran({ exitCode: 3 }), [], DRIVER)

    expect(done.error).toEqual({ kind: 'exit', message: 'grok exited with code 3' })
  })

  it('reports a null exit code and an exit error when a signal ended the process unasked', () => {
    const done = reconcileDone(PARSED_OK, ran({ exitCode: null, signal: 'SIGSEGV' }), [], DRIVER)

    expect(done.exitCode).toBe(null)
    expect(done.error?.kind).toBe('exit')
  })
})
