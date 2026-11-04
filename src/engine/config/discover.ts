import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { RensaError } from '../errors.js'
import { type Paths, resolvePaths } from './paths.js'

export interface ChainFile {
  name: string
  path: string
}

export interface Discovered {
  paths: Paths
  /** Sorted by name. */
  chains: ChainFile[]
  /** Present only if the file exists. */
  projectConfig?: string
  userConfig?: string
  /** True if `.rensa/` was created by this call. */
  created: boolean
}

const GITIGNORE_LINE = 'runs/'
const CHAIN_EXT = /\.ya?ml$/i

export async function discover(cwd: string): Promise<Discovered> {
  const paths = await resolvePaths(cwd)
  const created = await ensureProjectDir(paths)
  const [chains, projectConfig, userConfig] = await Promise.all([
    listChains(paths.projectDir),
    isFile(paths.projectConfig),
    isFile(paths.userConfig),
  ])
  return {
    paths,
    chains,
    ...(projectConfig && { projectConfig: paths.projectConfig }),
    ...(userConfig && { userConfig: paths.userConfig }),
    created,
  }
}

/**
 * Creates `.rensa/` with a `.gitignore` listing `runs/`. If the directory
 * already exists, makes sure its `.gitignore` has that line. Returns true
 * only when the directory was created.
 */
export async function ensureProjectDir(paths: Paths): Promise<boolean> {
  const gitignore = path.join(paths.projectDir, '.gitignore')
  try {
    await mkdir(paths.projectDir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    const current = await readFile(gitignore, 'utf8').catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return undefined
      throw e
    })
    const next = withRunsLine(current)
    if (next !== current) await writeFile(gitignore, next)
    return false
  }
  await writeFile(gitignore, withRunsLine(undefined))
  return true
}

/**
 * The `.rensa/.gitignore` content `ensureProjectDir` leaves given the
 * current content (undefined when the file is missing): unchanged when it
 * already lists `runs/`, else with that line appended. The dirty-tree
 * check uses it to recognise this write as rensa's own.
 */
export function withRunsLine(current: string | undefined): string {
  if (current === undefined) return `${GITIGNORE_LINE}\n`
  // Git ignores trailing spaces in a pattern but not leading ones.
  const listed = current.split(/\r?\n/).some((line) => line.trimEnd() === GITIGNORE_LINE)
  if (listed) return current
  const sep = current === '' || current.endsWith('\n') ? '' : '\n'
  return `${current}${sep}${GITIGNORE_LINE}\n`
}

async function listChains(projectDir: string): Promise<ChainFile[]> {
  const entries = await readdir(projectDir, { withFileTypes: true })
  const chains: ChainFile[] = []
  for (const entry of entries) {
    const file = entry.name
    if (file.startsWith('.') || !CHAIN_EXT.test(file)) continue
    if (file.toLowerCase() === 'project.yaml') continue
    const full = path.join(projectDir, file)
    if (!entry.isFile() && !(entry.isSymbolicLink() && (await isFile(full)))) continue
    chains.push({ name: file.replace(CHAIN_EXT, ''), path: full })
  }
  return chains.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/**
 * False when the file is absent. Any other failure, such as EACCES, is
 * raised: treating an unreadable config as missing would silently drop it.
 */
async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile()
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw new RensaError('CONFIG_PARSE', `cannot read ${file}: ${code ?? String(err)}`, file)
  }
}
