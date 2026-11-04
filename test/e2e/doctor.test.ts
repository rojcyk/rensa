import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { commitAll, installChains } from '../../src/testing/chains.js'
import { builtCli, cliEnv, linesOf, runCli } from '../../src/testing/cli.js'
import { type TmpDir, tmpDir, tmpRepo } from '../../src/testing/tmpRepo.js'

// `rensa doctor` as a user runs it: the built CLI, judged by its provider
// rows, its errors and its exit code.

let dirs: TmpDir[] = []

beforeAll(() => {
  builtCli()
})

afterEach(async () => {
  await Promise.all(dirs.map((d) => d.cleanup()))
  dirs = []
})

/** A repository with the named chains committed, and a home of its own. */
async function repoWith(chains: string[]): Promise<{ dir: string; home: string }> {
  const repo = await tmpRepo()
  const home = await tmpDir('rensa-home-')
  dirs.push(repo, home)
  await installChains(repo.dir, chains)
  await commitAll(repo.dir)
  return { dir: repo.dir, home: home.dir }
}

function doctor(cwd: string, home: string, vars: Record<string, string | undefined> = {}) {
  return runCli(['doctor'], { cwd, env: cliEnv(home, vars) })
}

/** The fake provider's row, with runs of spaces collapsed. */
function fakeRow(stdout: string): string | undefined {
  return linesOf(stdout)
    .find((line) => line.startsWith('fake '))
    ?.replace(/ {2,}/g, ' ')
}

describe('rensa doctor with the fake provider registered', () => {
  it('exits 0 with the fake row ready when every chain loads and uses only ready providers', async () => {
    const { dir, home } = await repoWith(['read-only', 'three-step'])

    const { code, stdout, stderr } = await doctor(dir, home, { RENSA_DEV: '1' })

    expect({ code, stderr, fake: fakeRow(stdout) }).toEqual({
      code: 0,
      stderr: '',
      fake: 'fake ready fake',
    })
  })

  it.each([
    { availability: 'not_logged_in', row: 'fake not logged in fake fake login' },
    { availability: 'not_installed', row: 'fake not installed' },
  ])(
    'exits 1 when a chain uses the fake provider and it is $availability',
    async ({ availability, row }) => {
      const { dir, home } = await repoWith(['read-only'])

      const { code, stdout } = await doctor(dir, home, {
        RENSA_DEV: '1',
        RENSA_FAKE_AVAILABILITY: availability,
      })

      expect({ code, fake: fakeRow(stdout) }).toEqual({ code: 1, fake: row })
    },
  )

  it('exits 0 when the fake provider is not installed but no chain uses it', async () => {
    const { dir, home } = await repoWith([])

    const { code, stdout } = await doctor(dir, home, {
      RENSA_DEV: '1',
      RENSA_FAKE_AVAILABILITY: 'not_installed',
    })

    expect({ code, fake: fakeRow(stdout) }).toEqual({ code: 0, fake: 'fake not installed' })
  })

  it('exits 1 and names only the broken chain when one chain loads and another cannot be parsed', async () => {
    const { dir, home } = await repoWith(['read-only'])
    await writeFile(path.join(dir, '.rensa', 'broken.yaml'), 'steps: [\n')

    const { code, stdout, stderr } = await doctor(dir, home, { RENSA_DEV: '1' })

    expect({ code, fake: fakeRow(stdout) }).toEqual({ code: 1, fake: 'fake ready fake' })
    expect(stderr).toMatch(/^error: cannot check the providers of chain `broken`: /)
    expect(stderr).not.toContain('read-only')
  })
})

describe('rensa doctor without the fake provider registered', () => {
  it('exits 1 with the load error on stderr when a chain uses the fake provider', async () => {
    const { dir, home } = await repoWith(['read-only'])

    const { code, stderr } = await doctor(dir, home)

    expect(code).toBe(1)
    expect(linesOf(stderr)).toEqual([
      expect.stringMatching(
        /^error: cannot check the providers of chain `read-only`: .*unknown provider `fake`/,
      ),
    ])
  })
})

describe('rensa doctor outside a git repository', () => {
  it('lists the providers and exits 0', async () => {
    const outside = await tmpDir('rensa-outside-')
    const home = await tmpDir('rensa-home-')
    dirs.push(outside, home)

    const { code, stdout, stderr } = await doctor(outside.dir, home.dir, {
      // Never find a repository above the temp directory.
      GIT_CEILING_DIRECTORIES: path.dirname(outside.dir),
    })

    expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
    expect(linesOf(stdout).map((line) => line.split(' ')[0])).toEqual(['claude', 'codex', 'grok'])
  })
})
