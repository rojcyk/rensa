import { execFileSync } from 'node:child_process'
import { accessSync, chmodSync, constants, existsSync } from 'node:fs'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { type IPty, spawn as spawnPty } from 'node-pty'
import { afterEach, assert, beforeAll, describe, expect, it, vi } from 'vitest'
import { commitAll, installChains } from '../../src/testing/chains.js'
import { builtCli, cliEnv } from '../../src/testing/cli.js'
import { processesWithArgs } from '../../src/testing/processes.js'
import { type TmpDir, tmpDir, tmpRepo } from '../../src/testing/tmpRepo.js'

// The terminal session as a user meets it: the built CLI in a
// pseudo-terminal, then `stty -a` from the same shell, so the terminal
// state rensa leaves behind is part of the byte stream.

const COLUMNS = 100
const ROWS = 30
const HEADER_GLYPH = '⎇'
/** The temporary repository's branch, which the header shows once git answers. */
const BRANCH = 'main'
const ENTER_ALT = '\x1b[?1049h'
const LEAVE_ALT = '\x1b[?1049l'
const SHOW_CURSOR = '\x1b[?25h'
const EXIT_MARK = '__EXIT__'
const DONE_MARK = '__DONE__'
/** The dev-only probes in src/tui/app.tsx (`RENSA_CRASH=warn`). */
const CRASH_WARNING = 'rensa-crash-probe warning'
const CRASH_CONSOLE = 'rensa-crash-probe console'
/** What a provider-check shim sleeps for; unlikely enough to find by its command line. */
const SLOW_CHECK_ARGS = 'sleep 30.6789'

type Mode = 'inline' | 'fullscreen'
const MODES: Mode[] = ['inline', 'fullscreen']
const modeArgs = (mode: Mode) => (mode === 'fullscreen' ? ['--fullscreen'] : [])

let dirs: TmpDir[] = []

/**
 * node-pty 1.1.0 ships its macOS spawn-helper without the executable bit,
 * and `npm ci` restores it that way; without it every spawn fails with
 * "posix_spawnp failed".
 */
function ensureSpawnHelperExecutable(): void {
  if (process.platform !== 'darwin') return
  const root = path.dirname(createRequire(import.meta.url).resolve('node-pty/package.json'))
  const helper = path.join(root, 'prebuilds', `darwin-${process.arch}`, 'spawn-helper')
  if (!existsSync(helper)) return
  try {
    accessSync(helper, constants.X_OK)
  } catch {
    chmodSync(helper, 0o755)
  }
}

beforeAll(() => {
  builtCli()
  ensureSpawnHelperExecutable()
})

afterEach(async () => {
  await Promise.all(dirs.map((d) => d.cleanup()))
  dirs = []
})

/**
 * A directory of `claude`, `codex` and `grok` shims first on PATH, so the
 * provider check never runs the real CLIs. `slow` makes each one sleep.
 */
async function providerShims(slow: boolean): Promise<string> {
  const bin = await tmpDir('rensa-bin-')
  dirs.push(bin)
  const body = slow ? `#!/bin/sh\nexec ${SLOW_CHECK_ARGS}\n` : '#!/bin/sh\nexit 1\n'
  for (const name of ['claude', 'codex', 'grok']) {
    const file = path.join(bin.dir, name)
    await writeFile(file, body)
    await chmod(file, 0o755)
  }
  return bin.dir
}

async function repoWithChains(): Promise<{ dir: string; home: string }> {
  const repo = await tmpRepo()
  const home = await tmpDir('rensa-home-')
  dirs.push(repo, home)
  await installChains(repo.dir, ['three-step'])
  await writeFile(path.join(repo.dir, '.rensa', '.gitignore'), 'runs/\n')
  await commitAll(repo.dir)
  return { dir: repo.dir, home: home.dir }
}

async function notARepo(): Promise<{ dir: string; home: string }> {
  const dir = await tmpDir('rensa-plain-')
  const home = await tmpDir('rensa-home-')
  dirs.push(dir, home)
  await mkdir(path.join(dir.dir, 'src'))
  return { dir: dir.dir, home: home.dir }
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

interface Pty {
  term: IPty
  output(): string
  /** Index of the first `needle` at or after `from`, waiting up to `ms`. */
  waitFor(needle: string, ms?: number, from?: number): Promise<number>
  /** The rensa process: the shell's child. */
  cliPid(): number
}

/** `sh -c '<cli> …; echo __EXIT__$?; stty -a; echo __DONE__'` in a 100x30 pseudo-terminal. */
function startInPty(args: string[], cwd: string, env: NodeJS.ProcessEnv): Pty {
  const cli = [process.execPath, builtCli(), ...args].map(quote).join(' ')
  const script = `${cli}; echo "${EXIT_MARK}$?${EXIT_MARK}"; stty -a; echo ${DONE_MARK}`
  const term = spawnPty('/bin/sh', ['-c', script], {
    name: 'xterm-256color',
    cols: COLUMNS,
    rows: ROWS,
    cwd,
    env: env as Record<string, string>,
  })
  let output = ''
  const waiters = new Set<() => void>()
  term.onData((data) => {
    output += data
    for (const w of [...waiters]) w()
  })
  return {
    term,
    output: () => output,
    waitFor(needle, ms = 15_000, from = 0) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const at = output.indexOf(needle, from)
          if (at === -1) return false
          clearTimeout(timer)
          waiters.delete(onData)
          resolve(at)
          return true
        }
        const onData = () => {
          check()
        }
        const timer = setTimeout(() => {
          waiters.delete(onData)
          term.kill('SIGKILL')
          reject(
            new Error(
              `no ${JSON.stringify(needle)} within ${ms} ms; output:\n${JSON.stringify(output)}`,
            ),
          )
        }, ms)
        if (!check()) waiters.add(onData)
      })
    },
    cliPid() {
      const pids = execFileSync('pgrep', ['-P', String(term.pid)], { encoding: 'utf8' })
        .trim()
        .split('\n')
        .map(Number)
      const [pid] = pids
      assert(
        pid !== undefined && pids.length === 1,
        `one child of the shell, got ${pids.join(',')}`,
      )
      return pid
    },
  }
}

interface Outcome {
  /** Everything rensa wrote, up to the exit mark. */
  stream: string
  exitCode: number
  stty: string
  /** Index in `stream` of the first frame's header glyph, or -1. */
  firstFrame: number
  cliPid: number | undefined
}

async function finish(pty: Pty, cliPid: number | undefined): Promise<Outcome> {
  await pty.waitFor(DONE_MARK)
  const output = pty.output()
  const exitAt = output.indexOf(EXIT_MARK)
  const code = new RegExp(`${EXIT_MARK}(\\d+)${EXIT_MARK}`).exec(output)
  assert(code?.[1] !== undefined, 'the shell reported the exit code')
  const stream = output.slice(0, exitAt)
  return {
    stream,
    exitCode: Number(code[1]),
    stty: output.slice(exitAt, output.indexOf(DONE_MARK, exitAt)),
    firstFrame: stream.indexOf(HEADER_GLYPH),
    cliPid,
  }
}

/** Starts rensa in a repository, waits for its first frame, then runs `drive`. */
async function scenario(
  mode: Mode,
  drive: (pty: Pty) => Promise<void>,
  opts: { vars?: Record<string, string | undefined>; slowChecks?: boolean } = {},
): Promise<Outcome> {
  const { dir, home } = await repoWithChains()
  const bin = await providerShims(opts.slowChecks ?? false)
  const env = cliEnv(home, {
    RENSA_DEV: '1',
    TERM: 'xterm-256color',
    CI: undefined,
    CONTINUOUS_INTEGRATION: undefined,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    ...opts.vars,
  })
  const pty = startInPty(modeArgs(mode), dir, env)
  const firstFrame = await pty.waitFor(HEADER_GLYPH)
  // The branch fills in from an effect of the first commit, the same pass
  // in which Ink's useInput turns on raw mode: keys sent before it would
  // reach the terminal driver as signals, not as input.
  await pty.waitFor(BRANCH, 15_000, firstFrame)
  const cliPid = pty.cliPid()
  await drive(pty)
  return finish(pty, cliPid)
}

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** `stty -a` shows a flag as `name` when set and `-name` when cleared. */
function sttyFlag(stty: string, flag: string): boolean {
  return new RegExp(`(^|\\s)${flag}(\\s|$)`).test(stty)
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The terminal state every ending must leave, whatever the mode. */
function expectSaneTerminal(outcome: Outcome, mode: Mode): void {
  const { stream, stty } = outcome
  expect({ echo: sttyFlag(stty, 'echo'), icanon: sttyFlag(stty, 'icanon') }).toEqual({
    echo: true,
    icanon: true,
  })
  expect(stream.lastIndexOf(SHOW_CURSOR)).toBeGreaterThan(stream.lastIndexOf(HEADER_GLYPH))
  if (mode === 'fullscreen') {
    expect({ enter: count(stream, ENTER_ALT), leave: count(stream, LEAVE_ALT) }).toEqual({
      enter: 1,
      leave: 1,
    })
    expect(stream.slice(stream.indexOf(LEAVE_ALT))).not.toContain(HEADER_GLYPH)
  } else {
    expect(stream).not.toContain(ENTER_ALT)
    expect(stream.slice(stream.lastIndexOf(SHOW_CURSOR))).not.toContain(HEADER_GLYPH)
  }
  if (outcome.cliPid !== undefined) expect(isAlive(outcome.cliPid)).toBe(false)
}

describe.each(MODES)('a normal quit in %s mode', (mode) => {
  it('exits 0 and restores the terminal when esc is pressed on the chains screen', async () => {
    const outcome = await scenario(mode, async (pty) => {
      pty.term.write('\x1b')
    })

    expect(outcome.exitCode).toBe(0)
    expectSaneTerminal(outcome, mode)
  })

  it('exits 0 and restores the terminal when ctrl+c is pressed with no run active', async () => {
    const outcome = await scenario(mode, async (pty) => {
      pty.term.write('\x03')
    })

    expect(outcome.exitCode).toBe(0)
    expectSaneTerminal(outcome, mode)
  })

  it('exits promptly and leaves no provider-check process when quit while the check is still running', async () => {
    let quitAt = 0
    const outcome = await scenario(
      mode,
      async (pty) => {
        await vi.waitFor(
          async () => expect(await processesWithArgs(SLOW_CHECK_ARGS)).not.toEqual([]),
          { timeout: 1_500, interval: 50 },
        )
        quitAt = Date.now()
        pty.term.write('\x1b')
        await pty.waitFor(EXIT_MARK)
      },
      { slowChecks: true },
    )
    const quitTookMs = Date.now() - quitAt

    expect(outcome.exitCode).toBe(0)
    expect(quitTookMs).toBeLessThan(1_000)
    expect(await processesWithArgs(SLOW_CHECK_ARGS)).toEqual([])
    expectSaneTerminal(outcome, mode)
  })
})

describe.each(MODES)('SIGTERM in %s mode', (mode) => {
  it('exits 143 and restores the terminal when rensa receives SIGTERM', async () => {
    const outcome = await scenario(mode, async (pty) => {
      process.kill(pty.cliPid(), 'SIGTERM')
    })

    expect(outcome.exitCode).toBe(143)
    expectSaneTerminal(outcome, mode)
  })
})

describe.each(MODES)('startup failure in %s mode', (mode) => {
  it('prints the error on the primary screen, exits 1 and never enters the alternate screen when run outside a repository', async () => {
    const { dir, home } = await notARepo()
    const bin = await providerShims(false)
    const env = cliEnv(home, {
      RENSA_DEV: '1',
      TERM: 'xterm-256color',
      CI: undefined,
      CONTINUOUS_INTEGRATION: undefined,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    })
    const pty = startInPty(modeArgs(mode), dir, env)

    const outcome = await finish(pty, undefined)

    expect(outcome.exitCode).toBe(1)
    expect(outcome.stream).not.toContain(ENTER_ALT)
    expect(outcome.stream).not.toContain(HEADER_GLYPH)
    expect(outcome.stream).toMatch(/not (inside )?a git repository|NOT_A_REPO/i)
    expect({
      echo: sttyFlag(outcome.stty, 'echo'),
      icanon: sttyFlag(outcome.stty, 'icanon'),
    }).toEqual({ echo: true, icanon: true })
  })
})

describe.each(MODES)('foreign output in %s mode', (mode) => {
  it('keeps a Node warning and a console line out of the frames and prints both on stderr after exit with RENSA_DEBUG=1', async () => {
    const outcome = await scenario(
      mode,
      async (pty) => {
        await sleep(900)
        pty.term.write('\x1b')
      },
      { vars: { RENSA_CRASH: 'warn', RENSA_DEBUG: '1' } },
    )
    const { stream } = outcome
    // Where Ink gave the terminal back: it left the alternate screen, or
    // showed the cursor again after its last inline frame.
    const restoredAt =
      mode === 'fullscreen'
        ? stream.indexOf(LEAVE_ALT)
        : stream.indexOf(SHOW_CURSOR, stream.lastIndexOf(HEADER_GLYPH))

    expect(outcome.exitCode).toBe(0)
    expect(stream.slice(outcome.firstFrame, restoredAt)).not.toContain(CRASH_WARNING)
    expect(stream.slice(outcome.firstFrame, restoredAt)).not.toContain(CRASH_CONSOLE)
    expect(stream.slice(restoredAt)).toContain(CRASH_WARNING)
    expect(stream.slice(restoredAt)).toContain(CRASH_CONSOLE)
    expectSaneTerminal(outcome, mode)
  })

  it('never shows the warning or the console line when RENSA_DEBUG is not set', async () => {
    const outcome = await scenario(
      mode,
      async (pty) => {
        await sleep(900)
        pty.term.write('\x1b')
      },
      { vars: { RENSA_CRASH: 'warn' } },
    )

    expect(outcome.exitCode).toBe(0)
    expect(outcome.stream).not.toContain(CRASH_WARNING)
    expect(outcome.stream).not.toContain(CRASH_CONSOLE)
  })
})

describe.each(MODES)('crashes in %s mode', (mode) => {
  it.each([
    ['render', 'a throw inside render', 'RENSA_CRASH=render: dev-only throw during render'],
    ['timer', 'an uncaught throw from a timer', 'RENSA_CRASH=timer: dev-only throw from a timer'],
  ])(
    'prints a readable stack after restoring the terminal, exits 1 and leaves no rensa process when RENSA_CRASH=%s (%s)',
    async (crash, _, message) => {
      const outcome = await scenario(mode, (pty) => pty.waitFor(EXIT_MARK).then(() => {}), {
        vars: { RENSA_CRASH: crash },
      })
      const { stream } = outcome
      const stackAt = stream.lastIndexOf(message)
      const restoredAt =
        mode === 'fullscreen' ? stream.lastIndexOf(LEAVE_ALT) : stream.lastIndexOf(HEADER_GLYPH)

      expect(outcome.exitCode).toBe(1)
      expect(stackAt).toBeGreaterThan(restoredAt)
      expect(stream.slice(stackAt)).toMatch(/\n\s+at /)
      expectSaneTerminal(outcome, mode)
    },
  )
})
