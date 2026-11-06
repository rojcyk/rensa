import { EFFORT } from '../../config/effort.js'
import type { Tools } from '../../config/types.js'
import { RensaError } from '../../errors.js'
import type { SpawnRequest } from '../types.js'

// Flags verified against Claude Code 2.1.319 on 2026-11-06.
//
// Never `--no-session-persistence` (sessions must persist for resume) and
// never `--bare` (it drops the user's CLAUDE.md and project skills, which
// are part of the agent, and stops Claude being told which skills exist).

const BASE = [
  'claude',
  '-p',
  '--output-format',
  'stream-json',
  '--verbose',
  '--include-partial-messages',
  '--input-format',
  'stream-json',
] as const

const TOOL_FLAGS: Record<Tools, readonly string[]> = {
  read: [
    '--tools',
    'Read,Glob,Grep',
    '--allowedTools',
    'Read,Glob,Grep',
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
  ],
  write: [
    '--permission-mode',
    'acceptEdits',
    '--allowedTools',
    'Read,Edit,Write,Glob,Grep,Bash',
    '--permission-prompts',
    'none',
  ],
}

/**
 * The command line for one Claude Code turn. The message is not in it:
 * it goes to stdin (`stdinMessage`). `staged.personaFile` is the staged
 * persona, passed only on a session's first use.
 */
export function buildArgv(req: SpawnRequest, staged: { personaFile?: string }): string[] {
  const argv: string[] = [...BASE]
  if (req.session.resume) {
    argv.push('--resume', req.session.id)
  } else {
    argv.push('--session-id', req.session.id)
    if (staged.personaFile !== undefined) {
      argv.push('--append-system-prompt-file', staged.personaFile)
    }
  }
  if (req.model !== undefined) argv.push('--model', req.model)
  if (req.effort !== undefined) {
    const mapped = EFFORT.claude[req.effort]
    // Chain validation rejects an effort the provider has no value for.
    if (typeof mapped !== 'string') {
      throw new RensaError('INTERNAL', `claude has no effort level for \`${req.effort}\``)
    }
    argv.push('--effort', mapped)
  }
  argv.push(...TOOL_FLAGS[req.tools])
  return argv
}

/**
 * The one stdin line that carries the message under
 * `--input-format stream-json`; stdin is closed after it.
 *
 * Alternative, not used: `req.message` as the positional prompt directly
 * after `-p` (not at the end: variadic flags such as `--tools` would
 * swallow it) with the default text input format. Both work on 2.1.319;
 * stdin is kept because argv is bounded by ARG_MAX and a rendered prompt
 * with inlined skills and step outputs can exceed it.
 */
export function stdinMessage(message: string): string {
  const line = {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: message }] },
  }
  return `${JSON.stringify(line)}\n`
}
