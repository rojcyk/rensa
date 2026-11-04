import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { git, type TmpDir, type TmpRepo, tmpDir, tmpRepo } from '../../testing/tmpRepo.js'
import { ensureProjectDir } from '../config/discover.js'
import { resolvePaths } from '../config/paths.js'
import { isDirty } from './git.js'

// isDirty against real repositories. `.rensa/.gitignore` is the one file
// discovery writes on every open, so a change to it that discovery made
// is rensa's own and must not refuse a run; any other change is the
// user's and must.

let repo: TmpRepo
let home: TmpDir
let projectDir: string
let gitignore: string

beforeEach(async () => {
  repo = await tmpRepo()
  home = await tmpDir('rensa-home-')
  // resolvePaths reads the user config dir; keep it away from the real one.
  vi.stubEnv('HOME', home.dir)
  vi.stubEnv('XDG_CONFIG_HOME', undefined)
  vi.stubEnv('GIT_DIR', undefined)
  vi.stubEnv('GIT_WORK_TREE', undefined)
  projectDir = path.join(repo.dir, '.rensa')
  gitignore = path.join(projectDir, '.gitignore')
  // isDirty runs git with the user's global config; pin what the tests
  // depend on so a global core.autocrlf cannot change the outcome.
  await git(repo.dir, ['config', 'core.autocrlf', 'false'])
  await mkdir(projectDir)
  await commitFiles({ '.rensa/agent-write.yaml': 'steps: []\n' }, 'Add a chain')
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all([repo.cleanup(), home.cleanup()])
})

/** Writes the files (paths relative to the repo root) and commits them. */
async function commitFiles(files: Record<string, string>, message: string): Promise<void> {
  for (const [file, content] of Object.entries(files)) {
    await writeFile(path.join(repo.dir, file), content)
  }
  await git(repo.dir, ['add', '--', ...Object.keys(files)])
  await git(repo.dir, ['commit', '--quiet', '--no-verify', '-m', message])
}

/** What `Engine.open` does to `.rensa/` before a run is started. */
async function discoveryWrite(): Promise<void> {
  await ensureProjectDir(await resolvePaths(repo.dir))
}

describe('a working tree without changes', () => {
  it('is clean when nothing has changed since the last commit', async () => {
    expect(await isDirty(repo.dir)).toBe(false)
  })
})

describe("rensa's own files", () => {
  it.each([['lock'], ['lock.recover'], ['lock.5f3a9c2e.tmp'], ['lock.recover.0b1c2d3e.tmp']])(
    'is clean when only the untracked .rensa/%s exists',
    async (file) => {
      await writeFile(
        path.join(projectDir, file),
        '{"pid":48213,"run_id":"2026-11-04_0812_agent-write_7f3a"}\n',
      )

      expect(await isDirty(repo.dir)).toBe(false)
    },
  )

  it('is dirty when an untracked file outside .rensa exists', async () => {
    await writeFile(path.join(repo.dir, 'notes.txt'), 'remember the quote limit\n')

    expect(await isDirty(repo.dir)).toBe(true)
  })

  it('is dirty when a tracked file is modified alongside a lock file', async () => {
    await writeFile(path.join(projectDir, 'lock'), '{"pid":48213}\n')
    await writeFile(path.join(repo.dir, 'README.md'), '# fixture\n\nedited\n')

    expect(await isDirty(repo.dir)).toBe(true)
  })

  it('is dirty when an untracked file named like a lock sits outside .rensa', async () => {
    await writeFile(path.join(repo.dir, 'lock'), 'not rensa\n')

    expect(await isDirty(repo.dir)).toBe(true)
  })
})

describe('.rensa/.gitignore with LF line endings', () => {
  it('is clean when .gitignore was never committed and discovery wrote it', async () => {
    await discoveryWrite()

    expect(await readFile(gitignore, 'utf8')).toBe('runs/\n')
    expect(await isDirty(repo.dir)).toBe(false)
  })

  it('stays clean when discovery runs a second time over its own uncommitted write', async () => {
    await discoveryWrite()
    await discoveryWrite()

    expect(await isDirty(repo.dir)).toBe(false)
  })

  it('is clean when discovery appended runs/ to a committed .gitignore', async () => {
    await commitFiles({ '.rensa/.gitignore': '*.log\n' }, 'Ignore logs')

    await discoveryWrite()

    expect(await readFile(gitignore, 'utf8')).toBe('*.log\nruns/\n')
    expect(await isDirty(repo.dir)).toBe(false)
  })

  it('is clean when discovery appended runs/ to a committed .gitignore without a final newline', async () => {
    await commitFiles({ '.rensa/.gitignore': '*.log' }, 'Ignore logs')

    await discoveryWrite()

    expect(await isDirty(repo.dir)).toBe(false)
  })

  it('is clean when discovery appended runs/ and the result was staged', async () => {
    await commitFiles({ '.rensa/.gitignore': '*.log\n' }, 'Ignore logs')
    await discoveryWrite()

    await git(repo.dir, ['add', '.rensa/.gitignore'])

    expect(await isDirty(repo.dir)).toBe(false)
  })

  it('is dirty when the user added a line on top of the appended runs/', async () => {
    await commitFiles({ '.rensa/.gitignore': '*.log\n' }, 'Ignore logs')
    await discoveryWrite()

    await writeFile(gitignore, '*.log\nruns/\nscratch/\n')

    expect(await isDirty(repo.dir)).toBe(true)
  })

  it('is dirty when the user edited a committed .gitignore that already lists runs/', async () => {
    await commitFiles({ '.rensa/.gitignore': 'runs/\n' }, 'Ignore runs')

    await writeFile(gitignore, 'runs/\nscratch/\n')

    expect(await isDirty(repo.dir)).toBe(true)
  })

  it('is dirty when an untracked .gitignore has a line besides runs/', async () => {
    await writeFile(gitignore, 'runs/\nscratch/\n')

    expect(await isDirty(repo.dir)).toBe(true)
  })

  it('is dirty when the committed .gitignore has a staged deletion, even after discovery recreates it', async () => {
    await commitFiles({ '.rensa/.gitignore': 'runs/\n' }, 'Ignore runs')
    await git(repo.dir, ['rm', '--quiet', '--', '.rensa/.gitignore'])

    await discoveryWrite()

    expect(await readFile(gitignore, 'utf8')).toBe('runs/\n')
    expect(await isDirty(repo.dir)).toBe(true)
  })

  it('is dirty when the committed .gitignore is removed from the index but kept on disk', async () => {
    await commitFiles({ '.rensa/.gitignore': 'runs/\n' }, 'Ignore runs')

    await git(repo.dir, ['rm', '--quiet', '--cached', '--', '.rensa/.gitignore'])

    expect(await isDirty(repo.dir)).toBe(true)
  })

  it('is dirty when the committed .gitignore was deleted from the working tree', async () => {
    await commitFiles({ '.rensa/.gitignore': 'runs/\n' }, 'Ignore runs')

    await rm(gitignore)

    expect(await isDirty(repo.dir)).toBe(true)
  })

  it("is clean when discovery recreates a deleted .gitignore with HEAD's content", async () => {
    await commitFiles({ '.rensa/.gitignore': 'runs/\n' }, 'Ignore runs')
    await rm(gitignore)

    await discoveryWrite()

    expect(await isDirty(repo.dir)).toBe(false)
  })

  it('is dirty when discovery recreates a deleted .gitignore whose HEAD content had other lines', async () => {
    await commitFiles({ '.rensa/.gitignore': '*.log\nruns/\n' }, 'Ignore logs and runs')
    await rm(gitignore)

    await discoveryWrite()

    // Discovery writes only `runs/`; losing `*.log` is the user's change.
    expect(await isDirty(repo.dir)).toBe(true)
  })
})

/**
 * Commits `.rensa/.gitignore` as `*.log\n` (LF in the object store), then
 * deletes and checks it out again so the working copy is converted to
 * CRLF the way a fresh clone would be. Returns the checked-out bytes.
 */
async function commitAndCheckOutCrlf(): Promise<string> {
  await commitFiles({ '.rensa/.gitignore': '*.log\n' }, 'Ignore logs')
  await rm(gitignore)
  await git(repo.dir, ['checkout', '--', '.rensa/.gitignore'])
  return readFile(gitignore, 'utf8')
}

describe.each([
  {
    setup: '.gitattributes with .rensa/.gitignore text eol=crlf',
    configure: () =>
      commitFiles({ '.gitattributes': '.rensa/.gitignore text eol=crlf\n' }, 'Check out CRLF'),
  },
  {
    setup: 'core.autocrlf=true',
    configure: () => git(repo.dir, ['config', 'core.autocrlf', 'true']).then(() => {}),
  },
])('.rensa/.gitignore checked out as CRLF under $setup', ({ configure }) => {
  beforeEach(async () => {
    await configure()
  })

  it('is clean when the CRLF checkout is unchanged', async () => {
    const checkedOut = await commitAndCheckOutCrlf()

    expect(checkedOut).toBe('*.log\r\n')
    expect(await isDirty(repo.dir)).toBe(false)
  })

  it('is clean when discovery appended runs/ to the CRLF checkout', async () => {
    await commitAndCheckOutCrlf()

    await discoveryWrite()

    expect(await readFile(gitignore, 'utf8')).toBe('*.log\r\nruns/\n')
    expect(await isDirty(repo.dir)).toBe(false)
  })

  it('is dirty when the user added a line after discovery appended runs/', async () => {
    await commitAndCheckOutCrlf()
    await discoveryWrite()

    await writeFile(gitignore, '*.log\r\nruns/\r\nscratch/\r\n')

    expect(await isDirty(repo.dir)).toBe(true)
  })
})
