import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest'
import { type TmpDir, type TmpRepo, tmpDir, tmpRepo } from '../../testing/tmpRepo.js'
import { RensaError } from '../errors.js'
import { type ChainFile, discover } from './discover.js'

let repo: TmpRepo
let home: TmpDir
let projectDir: string
let gitignore: string

beforeEach(async () => {
  repo = await tmpRepo()
  home = await tmpDir('rensa-home-')
  projectDir = path.join(repo.dir, '.rensa')
  gitignore = path.join(projectDir, '.gitignore')
  // discover() reads the user config dir from process.env and os.homedir();
  // point both at a temp home so the real one is never read.
  vi.stubEnv('HOME', home.dir)
  vi.stubEnv('XDG_CONFIG_HOME', path.join(home.dir, 'xdg'))
  vi.stubEnv('GIT_DIR', undefined)
  vi.stubEnv('GIT_WORK_TREE', undefined)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all([repo.cleanup(), home.cleanup()])
})

describe('first discovery in a repository', () => {
  it('creates .rensa/.gitignore containing exactly "runs/\\n" and reports created with no chains', async () => {
    const result = await discover(repo.dir)

    expect(result.created).toBe(true)
    expect(result.chains).toEqual([])
    expect(await readFile(gitignore, 'utf8')).toBe('runs/\n')
  })

  it('creates .rensa at the repo root when called from a subdirectory', async () => {
    const cwd = path.join(repo.dir, 'src', 'billing')
    await mkdir(cwd, { recursive: true })

    const result = await discover(cwd)

    expect(result.paths.projectDir).toBe(projectDir)
    expect(await readFile(gitignore, 'utf8')).toBe('runs/\n')
    expect(existsSync(path.join(cwd, '.rensa'))).toBe(false)
  })

  it("leaves the repository's own .gitignore unchanged when creating .rensa", async () => {
    const rootIgnore = path.join(repo.dir, '.gitignore')
    await writeFile(rootIgnore, 'node_modules/\ndist/\n')

    await discover(repo.dir)

    expect(await readFile(rootIgnore, 'utf8')).toBe('node_modules/\ndist/\n')
  })

  it('omits projectConfig and userConfig when neither file exists', async () => {
    const result = await discover(repo.dir)

    expect(result).not.toHaveProperty('projectConfig')
    expect(result).not.toHaveProperty('userConfig')
  })
})

describe('discovery when .rensa already exists', () => {
  it('reports created: false and does not rewrite .gitignore on a second call', async () => {
    await discover(repo.dir)
    // Backdate the file so any rewrite would move its mtime forward.
    const backdated = new Date('2026-01-15T09:30:00Z')
    await utimes(gitignore, backdated, backdated)

    const second = await discover(repo.dir)

    expect(second.created).toBe(false)
    expect((await stat(gitignore)).mtime).toEqual(backdated)
    expect(await readFile(gitignore, 'utf8')).toBe('runs/\n')
  })

  it('writes .gitignore with "runs/\\n" when the directory exists without one', async () => {
    await mkdir(projectDir)

    const result = await discover(repo.dir)

    expect(result.created).toBe(false)
    expect(await readFile(gitignore, 'utf8')).toBe('runs/\n')
  })

  it('appends runs/ on its own line when .gitignore lacks it and has no trailing newline', async () => {
    await mkdir(projectDir)
    await writeFile(gitignore, '*.log\nscratch/')

    await discover(repo.dir)

    expect(await readFile(gitignore, 'utf8')).toBe('*.log\nscratch/\nruns/\n')
  })

  it('keeps .gitignore content unchanged when it already lists runs/ among other lines', async () => {
    await mkdir(projectDir)
    await writeFile(gitignore, '*.log\nruns/\nscratch/\n')

    await discover(repo.dir)

    expect(await readFile(gitignore, 'utf8')).toBe('*.log\nruns/\nscratch/\n')
  })

  it('appends runs/ when the only runs/ line is indented, since git treats leading spaces literally', async () => {
    await mkdir(projectDir)
    await writeFile(gitignore, '*.log\n  runs/\n')

    await discover(repo.dir)

    expect(await readFile(gitignore, 'utf8')).toBe('*.log\n  runs/\nruns/\n')
  })

  it('keeps .gitignore unchanged when runs/ has trailing spaces, since git ignores them', async () => {
    await mkdir(projectDir)
    await writeFile(gitignore, '*.log\nruns/   \n')

    await discover(repo.dir)

    expect(await readFile(gitignore, 'utf8')).toBe('*.log\nruns/   \n')
  })
})

describe('listing chain files', () => {
  it('returns .yaml and .yml chains sorted by stem, skipping project.yaml, dotfiles and other extensions', async () => {
    await mkdir(projectDir)
    for (const file of [
      'review.yaml',
      'deploy.yml',
      'Audit.YAML',
      'project.yaml',
      '.hidden.yaml',
      'notes.txt',
    ]) {
      await writeFile(path.join(projectDir, file), 'steps: []\n')
    }
    await mkdir(path.join(projectDir, 'runs'))

    const result = await discover(repo.dir)

    const expected: ChainFile[] = [
      { name: 'Audit', path: path.join(projectDir, 'Audit.YAML') },
      { name: 'deploy', path: path.join(projectDir, 'deploy.yml') },
      { name: 'review', path: path.join(projectDir, 'review.yaml') },
    ]
    expect(result.chains).toEqual(expected)
  })
})

describe('optional config files', () => {
  it('reports both config paths when project.yaml exists in .rensa and the user config dir', async () => {
    const userDir = path.join(home.dir, 'xdg', 'rensa')
    await mkdir(projectDir)
    await mkdir(userDir, { recursive: true })
    await writeFile(path.join(projectDir, 'project.yaml'), 'base: main\n')
    await writeFile(path.join(userDir, 'project.yaml'), 'base: main\n')

    const result = await discover(repo.dir)

    expect(result.projectConfig).toBe(path.join(projectDir, 'project.yaml'))
    expect(result.userConfig).toBe(path.join(userDir, 'project.yaml'))
  })

  it('omits userConfig when a component of the user config dir is a regular file', async () => {
    // XDG_CONFIG_HOME points at <home>/xdg; making it a file turns the
    // lookup of <home>/xdg/rensa/project.yaml into ENOTDIR.
    await writeFile(path.join(home.dir, 'xdg'), 'not a directory\n')

    const result = await discover(repo.dir)

    expect(result).not.toHaveProperty('userConfig')
  })

  // Root bypasses permission checks, and win32 ignores POSIX modes.
  it.skipIf(process.getuid?.() === 0 || process.platform === 'win32')(
    'rejects with CONFIG_PARSE naming the file when the user config dir is not accessible',
    async () => {
      const userDir = path.join(home.dir, 'xdg', 'rensa')
      const userConfig = path.join(userDir, 'project.yaml')
      await mkdir(userDir, { recursive: true })
      await writeFile(userConfig, 'base: main\n')
      await chmod(userDir, 0o000)
      try {
        const err = await discover(repo.dir).catch((e: unknown) => e)

        assert(err instanceof RensaError, `expected RensaError, got ${String(err)}`)
        expect(err.code).toBe('CONFIG_PARSE')
        expect(err.path).toBe(userConfig)
        expect(err.message).toBe(`cannot read ${userConfig}: EACCES`)
      } finally {
        await chmod(userDir, 0o755)
      }
    },
  )
})

describe('discovery outside a repository', () => {
  it('rejects with NOT_A_REPO and creates no .rensa directory', async () => {
    const outside = await tmpDir()
    vi.stubEnv('GIT_CEILING_DIRECTORIES', path.dirname(outside.dir))
    try {
      const err = await discover(outside.dir).catch((e: unknown) => e)

      assert(err instanceof RensaError, `expected RensaError, got ${String(err)}`)
      expect(err.code).toBe('NOT_A_REPO')
      expect(existsSync(path.join(outside.dir, '.rensa'))).toBe(false)
    } finally {
      await outside.cleanup()
    }
  })
})
