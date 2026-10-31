import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface TmpDir {
  /** Real path (symlinks resolved), as `git rev-parse --show-toplevel` prints it. */
  dir: string
  /** Removes the directory and everything in it, unless `KEEP_TMP=1`. */
  cleanup: () => Promise<void>
}

/**
 * With `KEEP_TMP=1` the directory is left in place and its path printed,
 * so a test's output can be inspected by eye.
 */
function remover(dir: string): () => Promise<void> {
  if (process.env.KEEP_TMP === '1') {
    return async () => {
      process.stderr.write(`KEEP_TMP: kept ${dir}\n`)
    }
  }
  return () => rm(dir, { recursive: true, force: true })
}

export type TmpRepo = TmpDir

/**
 * Environment for git children that ignores the user's global and system
 * config (so their hooks, signing, templates and aliases never apply) and
 * any GIT_* variables inherited from a surrounding git process.
 */
export function isolatedGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) {
    if (!key.startsWith('GIT_')) env[key] = value
  }
  env.GIT_CONFIG_GLOBAL = os.devNull
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_TERMINAL_PROMPT = '0'
  return env
}

export async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: dir, env: isolatedGitEnv() })
  return stdout
}

/**
 * Creates a fresh git repository in a temp directory with one commit on
 * `main` and a clean working tree.
 */
export async function tmpRepo(): Promise<TmpRepo> {
  // realpath: on macOS os.tmpdir() is under /var, a symlink to /private/var,
  // and git reports the resolved path.
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'rensa-repo-')))
  const cleanup = remover(dir)
  try {
    await git(dir, ['init', '--quiet', '--initial-branch=main'])
    await git(dir, ['config', 'user.name', 'Rensa Test'])
    await git(dir, ['config', 'user.email', 'rensa-test@example.com'])
    await git(dir, ['config', 'commit.gpgsign', 'false'])
    await writeFile(path.join(dir, 'README.md'), '# fixture\n')
    await git(dir, ['add', 'README.md'])
    await git(dir, ['commit', '--quiet', '--no-verify', '-m', 'Initial commit'])
  } catch (err) {
    await cleanup()
    throw err
  }
  return { dir, cleanup }
}

/** A temp directory that is not inside any git repository. */
export async function tmpDir(prefix = 'rensa-dir-'): Promise<TmpDir> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)))
  return { dir, cleanup: remover(dir) }
}
