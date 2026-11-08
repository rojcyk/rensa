import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  type AgentDriver,
  type ProcessOutcome,
  reconcileDone as reconcileAgentDone,
  spawnAgent,
} from '../agent-process.js'
import type { Adapter, AgentProcess, DoneEvent, SpawnRequest } from '../types.js'
import { buildArgv, stdinMessage } from './argv.js'
import { claudeAvailability } from './auth.js'
import { classifyText, parseClaude } from './parse.js'

// Claude Code as a provider: one headless `claude -p` process per turn,
// on the user's own login. The message goes to stdin as one stream-json
// line (see `stdinMessage`), so its size is not bounded by ARG_MAX.

export type { ProcessOutcome } from '../agent-process.js'

const PERSONA_FILE = 'persona.md'

const driver: AgentDriver = {
  provider: 'claude',
  parse: parseClaude,
  classifyText,
  prepare: async (req) => {
    const personaFile = await stagePersona(req)
    return {
      argv: buildArgv(req, personaFile === undefined ? {} : { personaFile }),
      stdin: stdinMessage(req.message),
    }
  },
}

export const claudeAdapter: Adapter = {
  provider: 'claude',

  capabilities() {
    return {
      resume: true,
      model: true,
      effort: ['low', 'medium', 'high', 'max'],
      tools: ['read', 'write'],
    }
  },

  available: claudeAvailability,

  spawn(req): AgentProcess {
    return spawnAgent(req, driver)
  },

  parse: parseClaude,
}

/**
 * Writes the persona to `<stagingDir>/persona.md` on a session's first
 * use and returns its path; a resumed session already holds its persona.
 * Nothing else is written.
 */
export async function stagePersona(req: SpawnRequest): Promise<string | undefined> {
  if (req.persona === undefined || req.session.resume) return undefined
  await mkdir(req.stagingDir, { recursive: true })
  const file = path.join(req.stagingDir, PERSONA_FILE)
  await writeFile(file, req.persona)
  return file
}

/**
 * The one final `done` of a Claude turn, by the shared rules on
 * `Adapter.spawn` with Claude's error classification (`reconcileDone` in
 * agent-process.ts).
 */
export function reconcileDone(
  parsed: DoneEvent,
  outcome: ProcessOutcome,
  stderr: readonly string[],
): DoneEvent {
  return reconcileAgentDone(parsed, outcome, stderr, driver)
}
