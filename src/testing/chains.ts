import { cp, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { git } from './tmpRepo.js'

// Chain fixtures for tests that need a repository with chains in it.
// Imports nothing from the engine, so end-to-end tests can use it too.

/** Chains, step prompts, personas and skills shared by the engine and e2e tests. */
export const CHAIN_FIXTURES = path.resolve(import.meta.dirname, '../../test/fixtures/chains')

const SHARED_DIRS = ['steps', 'agents', 'skills']

/** Copies the named chains and the shared prompt, persona and skill directories into `.rensa/`. */
export async function installChains(repoDir: string, names: readonly string[]): Promise<void> {
  const projectDir = path.join(repoDir, '.rensa')
  await mkdir(projectDir, { recursive: true })
  for (const dir of SHARED_DIRS) {
    await cp(path.join(CHAIN_FIXTURES, dir), path.join(projectDir, dir), { recursive: true })
  }
  for (const name of names) {
    await cp(path.join(CHAIN_FIXTURES, `${name}.yaml`), path.join(projectDir, `${name}.yaml`))
  }
}

/** Stages and commits everything, so a chain that writes finds a clean tree. */
export async function commitAll(dir: string, message = 'Add rensa chains'): Promise<void> {
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '--quiet', '--no-verify', '-m', message])
}
