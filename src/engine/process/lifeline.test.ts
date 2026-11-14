import { type ChildProcess, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { Duplex, Readable } from 'node:stream'
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest'
import { killProcessesWithArgs, processesWithArgs } from '../../testing/processes.js'
import { type TmpDir, tmpDir } from '../../testing/tmpRepo.js'
import { childEnv } from './env.js'
import {
  type LifelineReport,
  lifelineCommand,
  lifelineEnv,
  parseLifelineReport,
} from './lifeline.js'
import { type SpawnOptions, spawnProcess } from './spawn.js'

// Unlikely durations, so `ps` matches only this file's processes.
const COMMAND_SLEEP = 'sleep 30.6521'
const TERM_IGNORING_SLEEP = 'sleep 30.6527'
const ALL_SLEEPS = [COMMAND_SLEEP, TERM_IGNORING_SLEEP]

// A command that dies on SIGTERM, with a grandchild that ignores it.
const COMMAND_WITH_STUBBORN_GRANDCHILD = `(trap "" TERM; exec ${TERM_IGNORING_SLEEP}) & exec ${COMMAND_SLEEP}`

let dir: TmpDir

beforeEach(async () => {
  dir = await tmpDir('rensa-lifeline-')
})

afterEach(async () => {
  for (const args of ALL_SLEEPS) await killProcessesWithArgs(args)
  await dir.cleanup()
})

const env = childEnv(process.env, { allowApiKeys: false })

function options(overrides: Partial<SpawnOptions> & Pick<SpawnOptions, 'argv'>): SpawnOptions {
  return { cwd: dir.dir, env, timeoutMs: 10_000, ...overrides }
}

const sh = (script: string): string[] => ['/bin/sh', '-c', script]
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForCount(args: string, count: number, timeout = 5_000): Promise<void> {
  await vi.waitFor(async () => expect(await processesWithArgs(args)).toHaveLength(count), {
    timeout,
    interval: 25,
  })
}

describe('the environment the command runs in', () => {
  it('passes NODE_OPTIONS to the command but not the lifeline when the caller sets it', async () => {
    // A --require of a missing file would stop the lifeline at startup.
    const nodeOptions = '--require /rensa-no-such-dir-71c2/preload.js'
    let out = ''

    const result = await spawnProcess(
      options({
        // biome-ignore lint/suspicious/noTemplateCurlyInString: shell expansion
        argv: sh('printf "%s|%s" "$NODE_OPTIONS" "${RENSA_LIFELINE_NODE_OPTIONS-unset}"'),
        env: { ...env, NODE_OPTIONS: nodeOptions },
        onStdoutChunk: (chunk) => {
          out += chunk.toString('utf8')
        },
      }),
    ).result

    expect([out, result.exitCode]).toEqual([`${nodeOptions}|unset`, 0])
  })

  it('leaves fd 3 closed in the command when the command starts', async () => {
    const lines: string[] = []

    const result = await spawnProcess(
      options({
        argv: sh('if { true >&3; } 2>/dev/null; then echo open; else echo closed; fi'),
        onStdout: (line) => lines.push(line),
      }),
    ).result

    expect([lines, result.exitCode]).toEqual([['closed'], 0])
  })
})

describe('reporting how the command ended', () => {
  it('reports the signal when the command dies by SIGUSR1', async () => {
    const result = await spawnProcess(options({ argv: sh('kill -USR1 $$') })).result

    expect([result.exitCode, result.signal]).toEqual([null, 'SIGUSR1'])
  })

  it('reports SIGPIPE when the command dies by it, though Node ignores SIGPIPE', async () => {
    const result = await spawnProcess(options({ argv: sh('kill -PIPE $$') })).result

    expect([result.exitCode, result.signal]).toEqual([null, 'SIGPIPE'])
  })
})

describe('stopping the group when rensa dies', () => {
  const GRACE_MS = 500

  /** Starts the lifeline as spawnProcess does, without spawnProcess's own cleanup. */
  function startLifeline(argv: string[], escalateMs: number): ChildProcess {
    const { command, args } = lifelineCommand(argv, escalateMs)
    return spawn(command, args, {
      cwd: dir.dir,
      env: lifelineEnv(env),
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    })
  }

  /** What the kernel does to rensa's ends of the pipes when it is SIGKILLed. */
  function closeRensaEnds(proc: ChildProcess): void {
    for (const stream of proc.stdio) stream?.destroy()
  }

  /** Waits until the command and its grandchild are gone; returns the ms since `since`. */
  async function msUntilGroupGone(since: number, graceMs: number): Promise<number> {
    await waitForCount(COMMAND_SLEEP, 0, 3_000)
    await waitForCount(TERM_IGNORING_SLEEP, 0, graceMs + 3_000)
    return Date.now() - since
  }

  it('sends SIGTERM to the command when rensa closes its end of fd 3', async () => {
    const marker = path.join(dir.dir, 'got-term')
    // Once ready, its output goes nowhere: with rensa's ends closed, the
    // shell's report of the killed sleep would end it by SIGPIPE before
    // its trap runs.
    const proc = startLifeline(
      sh(
        `trap 'echo SIGTERM > ${marker}; exit 0' TERM; echo ready; exec >/dev/null 2>&1; while :; do sleep 0.05; done`,
      ),
      GRACE_MS,
    )
    const stdout = proc.stdout
    assert(stdout, 'stdout is not piped')
    await new Promise((resolve) => stdout.once('data', resolve))

    closeRensaEnds(proc)

    await vi.waitFor(async () => expect(await readFile(marker, 'utf8')).toBe('SIGTERM\n'), {
      timeout: 3_000,
    })
  })

  it('SIGKILLs a TERM-ignoring grandchild after the grace when rensa closes its end of fd 3', async () => {
    const proc = startLifeline(sh(COMMAND_WITH_STUBBORN_GRANDCHILD), GRACE_MS)
    const lifelineSignal = new Promise<NodeJS.Signals | null>((resolve) =>
      proc.once('exit', (_code, signal) => resolve(signal)),
    )
    await waitForCount(COMMAND_SLEEP, 1)
    await waitForCount(TERM_IGNORING_SLEEP, 1)

    const closedAt = Date.now()
    closeRensaEnds(proc)
    const elapsedMs = await msUntilGroupGone(closedAt, GRACE_MS)

    // Not sooner: the grandchild ignores SIGTERM, so only the SIGKILL ends it.
    expect(elapsedMs).toBeGreaterThanOrEqual(GRACE_MS)
    expect(await lifelineSignal).toBe('SIGKILL')
  })

  it('SIGKILLs a TERM-ignoring grandchild after the grace when rensa dies after its own SIGTERM', {
    timeout: 15_000,
  }, async () => {
    // Long, so the waits below fit inside it on a loaded machine too.
    const grace = 3_000
    const proc = startLifeline(sh(COMMAND_WITH_STUBBORN_GRANDCHILD), grace)
    await waitForCount(COMMAND_SLEEP, 1)
    await waitForCount(TERM_IGNORING_SLEEP, 1)
    assert(proc.pid !== undefined, 'spawn failed')

    // rensa's kill(): `stop` on fd 3, then SIGTERM to the group. The
    // command exits on it; the grandchild does not. rensa is then
    // SIGKILLed before its own escalation, after the command is gone.
    const fd3 = proc.stdio[3]
    assert(fd3 instanceof Duplex, 'fd 3 is not a duplex pipe')
    const killedAt = Date.now()
    fd3.write('stop\n')
    process.kill(-proc.pid, 'SIGTERM')
    await waitForCount(COMMAND_SLEEP, 0, 2_000)
    // Long enough for a lifeline that left with the command to be gone,
    // which is the regression this test is for; well inside the grace.
    await delay(150)
    assert(
      proc.exitCode === null && proc.signalCode === null,
      'the lifeline left before the stop it was sent had finished',
    )
    closeRensaEnds(proc)
    const elapsedMs = await msUntilGroupGone(killedAt, grace)

    expect(elapsedMs).toBeGreaterThanOrEqual(grace)
  })

  it('writes the exit code on fd 3 when the command exits on its own', async () => {
    const proc = startLifeline(sh('exit 3'), GRACE_MS)
    const fd3 = proc.stdio[3]
    assert(fd3 instanceof Readable, 'fd 3 is not readable')
    let report = ''
    fd3.on('data', (chunk: Buffer) => {
      report += chunk.toString('utf8')
    })

    const code = await new Promise<number | null>((resolve) => proc.once('close', resolve))

    const expected: LifelineReport = { kind: 'exit', code: 3, signal: null }
    expect([code, parseLifelineReport(report)]).toEqual([3, expected])
  })
})

describe('reading the report on fd 3', () => {
  it('returns the spawn error when the line is a spawnError report', () => {
    const text = `${JSON.stringify({ spawnError: { code: 'ENOENT', message: 'spawn claude ENOENT' } })}\n`

    const expected: LifelineReport = {
      kind: 'spawnError',
      code: 'ENOENT',
      message: 'spawn claude ENOENT',
    }
    expect(parseLifelineReport(text)).toEqual(expected)
  })

  it('returns the signal when the line is an exit report for a signalled command', () => {
    const text = `${JSON.stringify({ exit: { code: null, signal: 'SIGTERM' } })}\n`

    const expected: LifelineReport = { kind: 'exit', code: null, signal: 'SIGTERM' }
    expect(parseLifelineReport(text)).toEqual(expected)
  })

  it('returns undefined when the text is empty, not JSON, or not a report', () => {
    const texts = ['', 'not json\n', '{"exit":{"code":null,"signal":"SIGBOGUS"}}\n', '{"ok":1}\n']

    expect(texts.map((text) => parseLifelineReport(text))).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ])
  })
})
