import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { RensaError } from '../errors.js'

const execFileAsync = promisify(execFile)

/**
 * Variables that make git pick a repository other than the one containing
 * `cwd`. Git hooks export some of them, so a rensa started from a hook
 * would otherwise resolve the hook's repository.
 */
const REPO_SELECTING_GIT_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
]

export interface Paths {
  cwd: string
  root: string
  projectDir: string
  projectConfig: string
  runsDir: string
  userDir: string
  userConfig: string
}

export async function resolvePaths(cwd: string, env = process.env): Promise<Paths> {
  const root = await gitToplevel(cwd)
  const projectDir = path.join(root, '.rensa')
  const userDir = userConfigDir(env)
  return {
    cwd,
    root,
    projectDir,
    projectConfig: path.join(projectDir, 'project.yaml'),
    runsDir: path.join(projectDir, 'runs'),
    userDir,
    userConfig: path.join(userDir, 'project.yaml'),
  }
}

/**
 * `~/.rensa` if it exists, else `%APPDATA%\rensa` on win32, else
 * `$XDG_CONFIG_HOME/rensa` if set, else `~/.config/rensa`. Never created.
 */
export function userConfigDir(
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
): string {
  const p = platform === 'win32' ? path.win32 : path.posix
  const dotDir = p.join(home, '.rensa')
  if (existsSync(dotDir)) return dotDir
  if (platform === 'win32') {
    return p.join(env.APPDATA || p.join(home, 'AppData', 'Roaming'), 'rensa')
  }
  if (env.XDG_CONFIG_HOME) return p.join(env.XDG_CONFIG_HOME, 'rensa')
  return p.join(home, '.config', 'rensa')
}

async function gitToplevel(cwd: string): Promise<string> {
  const gitEnv = { ...process.env }
  for (const name of REPO_SELECTING_GIT_VARS) delete gitEnv[name]
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      env: gitEnv,
    })
    const root = stdout.trim()
    if (!root) throw new Error('empty output')
    return path.resolve(root)
  } catch {
    throw new RensaError('NOT_A_REPO', `not a git repository: ${cwd}`, cwd)
  }
}
