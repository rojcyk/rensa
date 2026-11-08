import { mkdir, writeFile } from 'node:fs/promises'
import { type AgentDriver, spawnAgent } from '../agent-process.js'
import type { Adapter, AgentProcess, SpawnRequest } from '../types.js'
import { buildArgv, promptText, type StagedPrompt, stagedPromptFor } from './argv.js'
import { grokAvailability } from './auth.js'
import { classifyText, parseGrok } from './parse.js'

// Grok Build as a provider: one headless `grok --single` process per
// turn, on the user's own login. Grok 1.0.70 does not read the prompt
// from stdin, so it goes in argv, or in a staged file when it is too long
// for argv (see `stagePrompt`).

const driver: AgentDriver = {
  provider: 'grok',
  parse: parseGrok,
  classifyText,
  prepare: async (req) => ({ argv: buildArgv(req, await stagePrompt(req)) }),
}

export const grokAdapter: Adapter = {
  provider: 'grok',

  capabilities() {
    return {
      resume: true,
      model: true,
      effort: ['low', 'medium', 'high', 'max'],
      tools: ['read', 'write'],
    }
  },

  available: grokAvailability,

  spawn(req): AgentProcess {
    return spawnAgent(req, driver)
  },

  parse: parseGrok,
}

/**
 * Writes the prompt to `<stagingDir>/message.md` when it is too long for
 * argv (`stagedPromptFor`) and returns its path, for `--prompt-file`. A
 * prompt that fits is passed in argv and nothing is written.
 */
export async function stagePrompt(req: SpawnRequest): Promise<StagedPrompt> {
  const staged = stagedPromptFor(req)
  if (staged.messageFile === undefined) return staged
  await mkdir(req.stagingDir, { recursive: true })
  await writeFile(staged.messageFile, promptText(req))
  return staged
}
