import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { gitEnv } from '../config/paths.js'
import { RensaError } from '../errors.js'

const execFileAsync = promisify(execFile)

/**
 * Engine-owned files that `.rensa/.gitignore` does not list but that are
 * not the user's changes: the lock, its recovery mutex, and their
 * temporary files (`lock`, `lock.recover`, `lock.*.tmp`).
 */
const OWN_FILES = [':(exclude,top,glob).rensa/lock*']

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: root, env: gitEnv() })
  return stdout
}

/**
 * True when `git status --porcelain` lists anything besides rensa's own
 * lock files, which a live or stale run leaves behind.
 */
export async function isDirty(root: string): Promise<boolean> {
  const out = await git(root, [
    'status',
    '--porcelain',
    '--untracked-files=all',
    '--',
    ':/',
    ...OWN_FILES,
  ])
  return out.trim() !== ''
}

/** The checked-out branch, or the commit sha on a detached HEAD. */
export async function currentRef(root: string): Promise<string> {
  try {
    return (await git(root, ['symbolic-ref', '--short', 'HEAD'])).trim()
  } catch {
    return (await git(root, ['rev-parse', 'HEAD'])).trim()
  }
}

/** The commit `ref` names; `CONFIG_INVALID` when it names none. */
export async function commitOf(root: string, ref: string): Promise<string> {
  const invalid = () =>
    new RensaError(
      'CONFIG_INVALID',
      `base \`${ref}\` does not name a commit`,
      undefined,
      'pass an existing branch, tag or sha as the base',
    )
  if (ref === '' || ref.startsWith('-')) throw invalid()
  try {
    return (await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim()
  } catch {
    throw invalid()
  }
}
