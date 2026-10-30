import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Paths, resolvePaths, userConfigDir } from '../../../src/engine/config/paths.js'
import { RensaError } from '../../../src/engine/errors.js'
import { type TmpDir, type TmpRepo, tmpDir, tmpRepo } from '../../helpers/tmpRepo.js'

describe('choosing the user config dir', () => {
  let home: TmpDir

  beforeEach(async () => {
    home = await tmpDir('rensa-home-')
  })

  afterEach(async () => {
    await home.cleanup()
  })

  it.each(['linux', 'darwin'] as const)(
    'returns ~/.rensa on %s when it exists, even with XDG_CONFIG_HOME set',
    async (platform) => {
      await mkdir(path.join(home.dir, '.rensa'))
      const env = { XDG_CONFIG_HOME: path.join(home.dir, 'xdg') }

      expect(userConfigDir(env, platform, home.dir)).toBe(path.join(home.dir, '.rensa'))
    },
  )

  it('returns $XDG_CONFIG_HOME/rensa when ~/.rensa is absent and XDG_CONFIG_HOME is set', () => {
    const env = { XDG_CONFIG_HOME: '/home/alice/.local/config' }

    expect(userConfigDir(env, 'linux', home.dir)).toBe('/home/alice/.local/config/rensa')
  })

  it('returns ~/.config/rensa when ~/.rensa is absent and XDG_CONFIG_HOME is unset', () => {
    expect(userConfigDir({}, 'darwin', home.dir)).toBe(path.join(home.dir, '.config', 'rensa'))
  })

  it('returns ~/.config/rensa when XDG_CONFIG_HOME is an empty string', () => {
    const env = { XDG_CONFIG_HOME: '' }

    expect(userConfigDir(env, 'linux', home.dir)).toBe(path.join(home.dir, '.config', 'rensa'))
  })

  it('returns %APPDATA%\\rensa on win32 and ignores XDG_CONFIG_HOME', () => {
    const env = { APPDATA: 'D:\\Profiles\\alice\\Roaming', XDG_CONFIG_HOME: 'C:\\xdg' }

    expect(userConfigDir(env, 'win32', 'C:\\Users\\alice')).toBe(
      'D:\\Profiles\\alice\\Roaming\\rensa',
    )
  })

  it('falls back to <home>\\AppData\\Roaming\\rensa on win32 when APPDATA is unset', () => {
    expect(userConfigDir({}, 'win32', 'C:\\Users\\alice')).toBe(
      'C:\\Users\\alice\\AppData\\Roaming\\rensa',
    )
  })
})

describe('resolving paths from a working directory', () => {
  let home: TmpDir

  beforeEach(async () => {
    home = await tmpDir('rensa-home-')
    // os.homedir() reads HOME; keep the real home directory out of the result.
    vi.stubEnv('HOME', home.dir)
    vi.stubEnv('GIT_DIR', undefined)
    vi.stubEnv('GIT_WORK_TREE', undefined)
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await home.cleanup()
  })

  describe('inside a repository', () => {
    let repo: TmpRepo

    beforeEach(async () => {
      repo = await tmpRepo()
    })

    afterEach(async () => {
      await repo.cleanup()
    })

    it('anchors every project path at the repo root when cwd is a nested subdirectory', async () => {
      const cwd = path.join(repo.dir, 'packages', 'billing')
      await mkdir(cwd, { recursive: true })
      const env = { XDG_CONFIG_HOME: path.join(home.dir, 'xdg') }

      const paths = await resolvePaths(cwd, env)

      const expected: Paths = {
        cwd,
        root: repo.dir,
        projectDir: path.join(repo.dir, '.rensa'),
        projectConfig: path.join(repo.dir, '.rensa', 'project.yaml'),
        runsDir: path.join(repo.dir, '.rensa', 'runs'),
        userDir: path.join(home.dir, 'xdg', 'rensa'),
        userConfig: path.join(home.dir, 'xdg', 'rensa', 'project.yaml'),
      }
      expect(paths).toEqual(expected)
    })

    it('resolves the repo containing cwd when GIT_DIR and GIT_WORK_TREE point elsewhere', async () => {
      const other = await tmpRepo()
      try {
        vi.stubEnv('GIT_DIR', path.join(other.dir, '.git'))
        vi.stubEnv('GIT_WORK_TREE', other.dir)

        const paths = await resolvePaths(repo.dir)

        expect(paths.root).toBe(repo.dir)
      } finally {
        await other.cleanup()
      }
    })
  })

  describe('outside a repository', () => {
    let outside: TmpDir

    beforeEach(async () => {
      outside = await tmpDir()
      // Stop git from walking up into any repository that encloses the temp dir.
      vi.stubEnv('GIT_CEILING_DIRECTORIES', path.dirname(outside.dir))
    })

    afterEach(async () => {
      await outside.cleanup()
    })

    it('rejects with NOT_A_REPO naming the cwd when the directory is not in a git repo', async () => {
      const err = await resolvePaths(outside.dir).catch((e: unknown) => e)

      assert(err instanceof RensaError, `expected RensaError, got ${String(err)}`)
      expect(err.code).toBe('NOT_A_REPO')
      expect(err.message).toBe(`not a git repository: ${outside.dir}`)
    })

    it('rejects with NOT_A_REPO when the cwd does not exist', async () => {
      const missing = path.join(outside.dir, 'deleted-worktree')

      const err = await resolvePaths(missing).catch((e: unknown) => e)

      assert(err instanceof RensaError, `expected RensaError, got ${String(err)}`)
      expect(err.code).toBe('NOT_A_REPO')
      expect(err.message).toBe(`not a git repository: ${missing}`)
    })
  })
})
