import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import path from 'node:path'

// PATH lookup for adapters' availability checks. Imports nothing from
// the registry: adapters use it, and the registry imports the adapters.

/**
 * The absolute path `bin` resolves to on `env.PATH`, or undefined. Every
 * directory is checked at once, starting synchronously; the first match
 * in PATH order wins. A `bin` containing a slash is checked as given.
 */
export async function findOnPath(bin: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const candidates = bin.includes('/')
    ? [path.resolve(bin)]
    : (env.PATH ?? '')
        .split(path.delimiter)
        // An empty entry means the current directory; never look there.
        .filter((dir) => dir !== '')
        .map((dir) => path.join(dir, bin))
  const checks = candidates.map(isExecutableFile)
  for (const [i, check] of checks.entries()) {
    if (await check) return candidates[i]
  }
  return undefined
}

async function isExecutableFile(file: string): Promise<boolean> {
  try {
    const [info] = await Promise.all([stat(file), access(file, constants.X_OK)])
    return info.isFile()
  } catch {
    return false
  }
}
