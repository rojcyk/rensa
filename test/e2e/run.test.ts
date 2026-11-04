import { existsSync } from 'node:fs'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, assert, beforeAll, describe, expect, it } from 'vitest'
import { commitAll, installChains } from '../../src/testing/chains.js'
import { builtCli, cliEnv, exited, linesOf, runCli, startCli } from '../../src/testing/cli.js'
import { git, type TmpDir, type TmpRepo, tmpDir, tmpRepo } from '../../src/testing/tmpRepo.js'

// `rensa run` as a user runs it: the built CLI in a temporary repository
// with fake-provider chains, judged by its output, exit code and the run
// files it leaves.

interface Scratch {
  repo: TmpRepo
  home: TmpDir
  projectDir: string
}

let scratch: Scratch[] = []

beforeAll(() => {
  builtCli()
})

afterEach(async () => {
  await Promise.all(scratch.flatMap((s) => [s.repo.cleanup(), s.home.cleanup()]))
  scratch = []
})

/**
 * A repository with the named chains committed. With `gitignore`, the
 * `.rensa/.gitignore` discovery writes is committed too, so a writing
 * chain starts on a clean tree whether or not discovery's own write is
 * recognised; without it, the repository is as a user first commits it.
 */
async function repoWith(chains: string[], { gitignore = true } = {}): Promise<Scratch> {
  const repo = await tmpRepo()
  const home = await tmpDir('rensa-home-')
  const s: Scratch = { repo, home, projectDir: path.join(repo.dir, '.rensa') }
  scratch.push(s)
  await installChains(repo.dir, chains)
  if (gitignore) await writeFile(path.join(s.projectDir, '.gitignore'), 'runs/\n')
  await commitAll(repo.dir)
  return s
}

function rensa(s: Scratch, args: string[], vars: Record<string, string> = {}) {
  return runCli(['run', ...args], {
    cwd: s.repo.dir,
    env: cliEnv(s.home.dir, { RENSA_DEV: '1', ...vars }),
  })
}

const TIME = /^\d\d:\d\d:\d\d {2}/
const MAJOR_LINE = /^\d\d:\d\d:\d\d {2}(run|step|agent) /

/**
 * A line without its time, with runs of spaces collapsed and the parts
 * that change on every run (durations, sha, session, run id) masked, so
 * the keyword columns and the content can be compared exactly.
 */
function shape(line: string): string {
  assert(TIME.test(line), `line does not start with a time: ${line}`)
  return line
    .replace(TIME, '')
    .replace(/ {2,}/g, ' ')
    .replace(/@ [0-9a-f]{7}/, '@ <sha>')
    .replace(/session [0-9a-f]{8}…/, 'session <id>')
    .replace(/ run \S+$/, ' run <run-id>')
    .replace(/\b\d+:\d\d\b/g, '<m:ss>')
}

async function runIds(s: Scratch): Promise<string[]> {
  const runsDir = path.join(s.projectDir, 'runs')
  return existsSync(runsDir) ? readdir(runsDir) : []
}

async function eventsOnDisk(s: Scratch, runId: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(path.join(s.projectDir, 'runs', runId, 'events.jsonl'), 'utf8')
  return linesOf(text).map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('rensa run on a fake chain', () => {
  it('prints one line per event and transcript line, then exits 0 when the chain completes', async () => {
    const s = await repoWith(['three-step'])

    const { code, stdout, stderr } = await rensa(s, ['three-step'])

    const [runId] = await runIds(s)
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
    expect(linesOf(stdout).map(shape)).toEqual([
      'run started three-step base main @ <sha> run <run-id>',
      'step started baseline echo baseline-ok',
      'baseline/shell | baseline-ok',
      'step finished baseline ok <m:ss>',
      'step started review',
      'agent spawned review/fake fake session <id> new',
      'review/fake | Hello, I will look at the README.',
      'review/fake | ▸ Read README.md',
      'review/fake | The README is a single heading.',
      'agent finished review/fake ok <m:ss> 282 tok',
      'step finished review ok <m:ss>',
      'step started wrap-up echo wrap-up-ok',
      'wrap-up/shell | wrap-up-ok',
      'step finished wrap-up ok <m:ss>',
      'run finished complete <m:ss>',
    ])
    expect(linesOf(stdout)[0]).toMatch(new RegExp(` run ${runId}$`))
  })

  it('prints only run, step and agent lines when given --quiet', async () => {
    const s = await repoWith(['three-step'])

    const { code, stdout } = await rensa(s, ['three-step', '--quiet'])

    expect(code).toBe(0)
    expect(linesOf(stdout).map(shape)).toEqual([
      'run started three-step base main @ <sha> run <run-id>',
      'step started baseline echo baseline-ok',
      'step finished baseline ok <m:ss>',
      'step started review',
      'agent spawned review/fake fake session <id> new',
      'agent finished review/fake ok <m:ss> 282 tok',
      'step finished review ok <m:ss>',
      'step started wrap-up echo wrap-up-ok',
      'step finished wrap-up ok <m:ss>',
      'run finished complete <m:ss>',
    ])
  })

  it('prints JSONL whose event lines are the events on disk when given --json', async () => {
    const s = await repoWith(['three-step'])

    const { code, stdout } = await rensa(s, ['three-step', '--json'])

    const objects = linesOf(stdout).map((line) => JSON.parse(line) as Record<string, unknown>)
    const [runId] = await runIds(s)
    assert(runId !== undefined, 'no run directory')
    const events = objects.filter((o) => 'type' in o)
    const records = objects.filter((o) => 'record' in o)
    expect(code).toBe(0)
    expect(events).toEqual(await eventsOnDisk(s, runId))
    expect(records.map((r) => `${r.step}/${r.label}`)).toEqual([
      'baseline/shell',
      'review/fake',
      'review/fake',
      'review/fake',
      'wrap-up/shell',
    ])
    expect(objects).toHaveLength(events.length + records.length)
  })
})

describe('usage errors', () => {
  it('exits 64 with usage on stderr and nothing on stdout when run is given an unknown flag', async () => {
    const s = await repoWith(['three-step'])

    const { code, stdout, stderr } = await rensa(s, ['three-step', '--verbose'])

    expect({ code, stdout }).toEqual({ code: 64, stdout: '' })
    expect(stderr).toMatch(/^rensa: unknown flag --verbose\nusage:\n/)
    expect(await runIds(s)).toEqual([])
  })
})

describe('declared pauses', () => {
  it('exits 1 with the --no-pause hint and starts no run when the chain pauses', async () => {
    const s = await repoWith(['pause-before'])

    const { code, stdout, stderr } = await rensa(s, ['pause-before'])

    expect({ code, stdout }).toEqual({ code: 1, stdout: '' })
    expect(linesOf(stderr)).toEqual([
      'error: chain `pause-before` pauses, and nothing can resume it without a UI',
      '  hint: pass --no-pause',
    ])
    expect(await runIds(s)).toEqual([])
  })

  it('runs through the pause and exits 0 when given --no-pause', async () => {
    const s = await repoWith(['pause-before'])

    const { code, stdout } = await rensa(s, ['pause-before', '--no-pause', '--quiet'])

    expect(code).toBe(0)
    expect(linesOf(stdout).map(shape)).toEqual([
      'run started pause-before base main @ <sha> run <run-id>',
      'step started one echo one',
      'step finished one ok <m:ss>',
      'step started two',
      'agent spawned two/fake fake session <id> new',
      'agent finished two/fake ok <m:ss> 282 tok',
      'step finished two ok <m:ss>',
      'run finished complete <m:ss>',
    ])
  })
})

describe('a multi-line shell command', () => {
  const STARTED = 'step started greet echo one ⏎ echo two'

  it('prints the command as one step started line joined with ⏎ in default output', async () => {
    const s = await repoWith(['multi-line'])

    const { code, stdout } = await rensa(s, ['multi-line'])

    expect(code).toBe(0)
    expect(linesOf(stdout).map(shape)).toEqual([
      'run started multi-line base main @ <sha> run <run-id>',
      STARTED,
      'greet/shell | one',
      'greet/shell | two',
      'step finished greet ok <m:ss>',
      'run finished complete <m:ss>',
    ])
  })

  it('prints the command as one line and only time-stamped run/step/agent lines in --quiet output', async () => {
    const s = await repoWith(['multi-line'])

    const { code, stdout } = await rensa(s, ['multi-line', '--quiet'])

    const lines = linesOf(stdout)
    expect(code).toBe(0)
    expect(lines.filter((line) => !MAJOR_LINE.test(line))).toEqual([])
    expect(lines.map(shape).filter((line) => line.startsWith('step started'))).toEqual([STARTED])
  })

  it('keeps the newlines of the command in the step.started event when given --json', async () => {
    const s = await repoWith(['multi-line'])

    const { code, stdout } = await rensa(s, ['multi-line', '--json'])

    const started = linesOf(stdout)
      .map((line) => JSON.parse(line) as { type?: string; data?: { command?: string } })
      .filter((o) => o.type === 'step.started')
    expect(code).toBe(0)
    expect(started.map((o) => o.data?.command)).toEqual(['echo one\n\necho two\n'])
  })
})

describe('a first run in a repository that never committed .rensa/.gitignore', () => {
  it('runs a writing chain on the first and the second try instead of refusing DIRTY_TREE', async () => {
    const s = await repoWith(['agent-write'], { gitignore: false })

    const first = await rensa(s, ['agent-write', '--quiet'])
    const second = await rensa(s, ['agent-write', '--quiet'])

    const status = await git(s.repo.dir, ['status', '--porcelain', '--untracked-files=all'])
    expect([first.code, first.stderr, second.code, second.stderr]).toEqual([0, '', 0, ''])
    expect(linesOf(second.stdout).map(shape).at(-1)).toBe('run finished complete <m:ss>')
    // Discovery's write is the only change either run left behind.
    expect(status).toBe('?? .rensa/.gitignore\n')
  })
})

describe('a reader that closes stdout mid-run', () => {
  it('aborts the run, exits 1 without a stack trace and releases the lock', async () => {
    const s = await repoWith(['agent-write'])
    // Slow enough that the run is still going when the reader leaves.
    const child = startCli(['run', 'agent-write'], {
      cwd: s.repo.dir,
      env: cliEnv(s.home.dir, { RENSA_DEV: '1', RENSA_FAKE_DELAY_MS: '400' }),
    })
    const done = exited(child)
    assert(child.stdout, 'stdout is not piped')
    const read: string[] = []

    // Like `rensa run … | head -n 3`.
    for await (const line of createInterface({ input: child.stdout })) {
      read.push(line)
      if (read.length === 3) break
    }
    child.stdout.destroy()
    const { code, stderr } = await done

    const [runId] = await runIds(s)
    assert(runId !== undefined, 'no run directory')
    const events = await eventsOnDisk(s, runId)
    expect(read.map(shape)).toEqual([
      'run started agent-write base main @ <sha> run <run-id>',
      'step started implement',
      'agent spawned implement/fake fake session <id> new',
    ])
    expect({ code, stderr }).toEqual({ code: 1, stderr: 'aborting: stdout was closed\n' })
    expect(events.at(-1)).toMatchObject({ type: 'run.finished', data: { status: 'aborted' } })
    expect(existsSync(path.join(s.projectDir, 'lock'))).toBe(false)
  })
})
