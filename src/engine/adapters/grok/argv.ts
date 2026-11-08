import path from 'node:path'
import { EFFORT } from '../../config/effort.js'
import type { Tools } from '../../config/types.js'
import { RensaError } from '../../errors.js'
import type { SpawnRequest } from '../types.js'

// Flags verified against Grok Build 1.0.70 (`grok --help`, its bundled
// headless guide, and real runs) on 2026-11-08.
//
// Text values are passed as `--flag=value`: clap rejects a separate value
// that starts with `-` (`grok -p "- item"` exits 2), and a rendered
// prompt or persona may well start with a Markdown list.

const BASE = ['--output-format', 'streaming-json', '--no-auto-update'] as const

/**
 * Bytes a message or persona may take as one argv string. Linux caps a
 * single argument at 128 KiB (MAX_ARG_STRLEN) and macOS caps argv plus
 * the environment at 1 MiB; 1.0.70 fails to start with E2BIG past them.
 */
export const ARGV_TEXT_LIMIT_BYTES = 100_000

/**
 * Read-only: only these built-in tools are offered. Tool ids as listed by
 * the `available_commands` event of Grok 1.0.70; with this list it offers
 * `read_file`, `list_dir`, `grep` and the MCP meta-tools `search_tool`
 * and `use_tool`, which `--tools` cannot remove.
 */
const READ_TOOLS = 'read_file,grep,list_dir'

/**
 * Read-only: permission rules that refuse anything that writes, whatever
 * the user's own allow rules say (deny wins over allow). `Bash`, `Edit`
 * and `Write` are Grok 1.0.70's rule prefixes for shell, edit and write;
 * `MCPTool` covers the MCP tools the meta-tools could call.
 */
const READ_DENY = 'Bash,Edit,Write,MCPTool'

const TOOL_FLAGS: Record<Tools, readonly string[]> = {
  read: [`--tools=${READ_TOOLS}`, `--deny=${READ_DENY}`],
  write: ['--always-approve'],
}

/** Where `stagePrompt` put the message, when it was too long for argv. */
export interface StagedPrompt {
  messageFile?: string
}

const MESSAGE_FILE = 'message.md'

/**
 * Where the prompt of this turn goes: `<stagingDir>/message.md` when it
 * is too long for argv, else nowhere (it is passed in argv). Pure: the
 * one decision `stagePrompt` acts on and `rensa capture` records.
 */
export function stagedPromptFor(req: SpawnRequest): StagedPrompt {
  if (fitsArgv(promptText(req))) return {}
  return { messageFile: path.join(req.stagingDir, MESSAGE_FILE) }
}

/**
 * The persona when it fits a `--rules` argument on a session's first use.
 * A resumed session already holds its persona; one too long for argv
 * travels in the message instead (`promptText`).
 */
function rulesPersona(req: SpawnRequest): string | undefined {
  if (req.persona === undefined || req.session.resume) return undefined
  return fitsArgv(req.persona) ? req.persona : undefined
}

/**
 * The prompt sent for this turn: the message, with the persona prepended
 * under a `# Role` heading when it is too long for `--rules` (1.0.70's
 * `--rules` takes text only; a file path is read as the rules themselves).
 */
export function promptText(req: SpawnRequest): string {
  if (req.persona === undefined || req.session.resume || fitsArgv(req.persona)) {
    return req.message
  }
  return `# Role\n\n${req.persona}\n\n# Task\n\n${req.message}`
}

/** Whether `text` is small enough to pass as one argv string. */
export function fitsArgv(text: string): boolean {
  return Buffer.byteLength(text, 'utf8') <= ARGV_TEXT_LIMIT_BYTES
}

/**
 * The command line for one Grok turn. The prompt is `--single` (`-p`)
 * unless `staged.messageFile` holds it, then `--prompt-file`: 1.0.70's
 * headless mode does not read the prompt from stdin.
 */
export function buildArgv(req: SpawnRequest, staged: StagedPrompt): string[] {
  const prompt =
    staged.messageFile === undefined
      ? `--single=${promptText(req)}`
      : `--prompt-file=${staged.messageFile}`
  const argv: string[] = ['grok', prompt, ...BASE, `--cwd=${req.cwd}`]
  if (req.session.resume) {
    argv.push('-r', req.session.id)
  } else {
    argv.push('-s', req.session.id)
    const persona = rulesPersona(req)
    if (persona !== undefined) argv.push(`--rules=${persona}`)
  }
  if (req.model !== undefined) argv.push('-m', req.model)
  if (req.effort !== undefined) {
    const mapped = EFFORT.grok[req.effort]
    // Chain validation rejects an effort the provider has no value for.
    if (typeof mapped !== 'string') {
      throw new RensaError('INTERNAL', `grok has no effort level for \`${req.effort}\``)
    }
    argv.push('--effort', mapped)
  }
  argv.push(...TOOL_FLAGS[req.tools])
  return argv
}
