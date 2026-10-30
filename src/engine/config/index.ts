import { RensaError } from '../errors.js'
import type { Discovered } from './discover.js'
import { loadYaml } from './load.js'
import { resolveChain } from './resolve.js'
import type { RawProject, ResolvedChain } from './types.js'
import { checkRawChain, checkRawProject, validateChain } from './validate.js'

export async function loadChain(name: string, d: Discovered): Promise<ResolvedChain> {
  const chainFile = d.chains.find((c) => c.name === name)
  if (!chainFile) {
    throw new RensaError('CHAIN_NOT_FOUND', `no chain named \`${name}\` in ${d.paths.projectDir}`)
  }
  const [chain, project, user] = await Promise.all([
    loadYaml<Record<string, unknown>>(chainFile.path).then((doc) =>
      checkRawChain(doc, chainFile.path),
    ),
    loadProject(d.projectConfig),
    loadProject(d.userConfig),
  ])
  const resolved = await resolveChain({
    name,
    chain: { raw: chain, file: chainFile.path },
    ...(project && { project }),
    ...(user && { user }),
  })
  return validateChain(resolved)
}

/** Never throws for a broken chain; the error is returned in its entry. */
export async function loadAllChains(
  d: Discovered,
): Promise<Array<{ name: string; chain?: ResolvedChain; error?: RensaError }>> {
  return Promise.all(
    d.chains.map(async ({ name }) => {
      try {
        return { name, chain: await loadChain(name, d) }
      } catch (err) {
        const error =
          err instanceof RensaError
            ? err
            : new RensaError('INTERNAL', `loading chain \`${name}\`: ${String(err)}`)
        return { name, error }
      }
    }),
  )
}

async function loadProject(
  file: string | undefined,
): Promise<{ raw: RawProject; file: string } | undefined> {
  if (file === undefined) return undefined
  const doc = await loadYaml<Record<string, unknown>>(file)
  return { raw: checkRawProject(doc, file), file }
}
