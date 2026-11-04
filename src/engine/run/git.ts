import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { withRunsLine } from '../config/discover.js'
import { gitEnv } from '../config/paths.js'
import { RensaError } from '../errors.js'

const execFileAsync = promisify(execFile)

/**
 * Engine-owned files that `.rensa/.gitignore` does not list but that are
 * not the user's changes: the lock, its recovery mutex, and their
 * temporary files (`lock`, `lock.recover`, `lock.*.tmp`).
 */
const OWN_FILES = [':(exclude,top,glob).rensa/lock*']

/**
 * Written by discovery (`ensureProjectDir`) on every open, so a first run
 * in a repository whose `.rensa/` was committed without it would refuse
 * its own write. Checked on its own by `gitignoreIsOwnWrite`, never
 * excluded outright: a user's change to it still counts.
 */
const GITIGNORE = '.rensa/.gitignore'

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: root, env: gitEnv() })
  return stdout
}

/**
 * True when `git status --porcelain` lists anything besides rensa's own
 * lock files, which a live or stale run leaves behind, and besides a
 * `.rensa/.gitignore` whose only change is the `runs/` line discovery adds.
 */
export async function isDirty(root: string): Promise<boolean> {
  const [out, gitignoreOwn] = await Promise.all([
    git(root, [
      'status',
      '--porcelain',
      '--untracked-files=all',
      '--',
      ':/',
      ...OWN_FILES,
      `:(exclude,top)${GITIGNORE}`,
    ]),
    gitignoreIsOwnWrite(root),
  ])
  return out.trim() !== '' || !gitignoreOwn
}

/**
 * True when `.rensa/.gitignore` is clean, or when both its staged and its
 * working copy are either what `HEAD` has or what discovery makes of
 * that (`withRunsLine`). Anything else, a deletion included, is a user
 * change.
 *
 * Compared as Git object ids, never as raw bytes: the working file is
 * hashed through the repository's clean filters, so line-ending
 * conversion (`eol=crlf`, `core.autocrlf`) that leaves `git status`
 * clean does not count as an edit. `withRunsLine` of the stored blob is
 * already in normalized form and is hashed as is; discovery appending to
 * the CRLF checkout of that blob normalizes to the same content.
 */
async function gitignoreIsOwnWrite(root: string): Promise<boolean> {
  const status = await git(root, [
    'status',
    '--porcelain',
    '--untracked-files=all',
    '--',
    `:(top)${GITIGNORE}`,
  ])
  if (status.trim() === '') return true
  const [head, headId, stagedId, workingId] = await Promise.all([
    attempt(() => git(root, ['cat-file', 'blob', `HEAD:${GITIGNORE}`])),
    objectId(root, `HEAD:${GITIGNORE}`),
    objectId(root, `:${GITIGNORE}`),
    // With a path, hash-object applies the attributes and filters for it.
    attempt(async () => (await git(root, ['hash-object', '--', GITIGNORE])).trim()),
  ])
  if (workingId === undefined) return false
  const allowed = new Set([await hashContent(root, withRunsLine(head))])
  if (headId !== undefined) allowed.add(headId)
  if (!allowed.has(workingId)) return false
  // Not in the index: fine only while HEAD lacks it too (untracked, not a staged deletion).
  return stagedId === undefined ? headId === undefined : allowed.has(stagedId)
}

/** The object id a revision spec names, or undefined when it names none. */
function objectId(root: string, spec: string): Promise<string | undefined> {
  return attempt(async () => (await git(root, ['rev-parse', '--verify', '--quiet', spec])).trim())
}

/** The blob id of `content` taken as is (stdin without `--path` skips every filter). */
function hashContent(root: string, content: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['hash-object', '--stdin'],
      { cwd: root, env: gitEnv() },
      (err, stdout) => (err ? reject(err) : resolve(stdout.trim())),
    )
    child.stdin?.end(content)
  })
}

async function attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch {
    return undefined
  }
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
