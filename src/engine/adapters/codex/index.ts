import { type AgentDriver, spawnAgent } from '../agent-process.js'
import type { Adapter, AgentProcess } from '../types.js'
import { buildArgv, promptText } from './argv.js'
import { codexAvailability } from './auth.js'
import { classifyText, parseCodex } from './parse.js'

// The Codex CLI as a provider: one headless `codex exec` process per
// turn, on the user's own login. The prompt goes to stdin (`-`), so its
// size is not bounded by ARG_MAX. Codex assigns its own session id; the
// parser reports it as `done.sessionId` and the engine records it in
// place of the id it generated. Nothing is staged.

const driver: AgentDriver = {
  provider: 'codex',
  parse: parseCodex,
  classifyText,
  prepare: async (req) => ({ argv: buildArgv(req), stdin: promptText(req) }),
}

export const codexAdapter: Adapter = {
  provider: 'codex',

  capabilities() {
    return {
      resume: true,
      model: true,
      effort: ['low', 'medium', 'high', 'max'],
      tools: ['read', 'write'],
      // turn.completed carries the thread's running totals; the engine subtracts.
      usage: 'session_total',
    }
  },

  available: codexAvailability,

  spawn(req): AgentProcess {
    return spawnAgent(req, driver)
  },

  parse: parseCodex,
}
