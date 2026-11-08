import { StringDecoder } from 'node:string_decoder'
import { z } from 'zod'
import { diag } from '../../diag.js'
import { isRecord } from '../../run/jsonl.js'
import type { AgentError, Usage } from '../../run/types.js'
import type { AgentEvent, DoneEvent } from '../types.js'

// `codex exec --json` stdout, one JSON object per line, turned into agent
// events. Shapes as observed on codex-cli 0.166.0 (see test/fixtures/codex/).
// Only the fields rensa reads are declared; unknown keys are dropped, and
// unknown line and item types (`reasoning`, `todo_list`, `error` items,
// `turn.started`, ...) are kept as `raw` only. 0.166.0 streams no text:
// an `agent_message` arrives once, completed, so there are no deltas.

const SCOPE = 'codex'
const TOOL_OUTPUT_CAP_BYTES = 4096

/** Carries the session id Codex assigned; on resume, the resumed one. */
const ThreadStartedLineSchema = z.object({
  type: z.literal('thread.started'),
  thread_id: z.string(),
})

const ItemSchema = z.object({ id: z.string(), type: z.string() })

const ItemLineSchema = z.object({
  type: z.enum(['item.started', 'item.updated', 'item.completed']),
  item: ItemSchema.loose(),
})

const AgentMessageSchema = z.object({ type: z.literal('agent_message'), text: z.string() })

const CommandExecutionSchema = z.object({
  type: z.literal('command_execution'),
  command: z.string(),
  aggregated_output: z.string().nullish(),
  exit_code: z.number().nullish(),
  /** `in_progress`, then `completed`, `failed` or `declined`. */
  status: z.string(),
})

const FileChangeSchema = z.object({
  type: z.literal('file_change'),
  changes: z.array(z.object({ path: z.string(), kind: z.string() })),
  status: z.string(),
})

/**
 * The session's running totals, not this turn's: a resumed session
 * reports what every turn so far has used. They are reported as they
 * are; the adapter declares `usage: 'session_total'` and the engine
 * subtracts the previous turn's totals. `input_tokens` includes the
 * cached part.
 */
const CodexUsageSchema = z.object({
  input_tokens: z.number(),
  cached_input_tokens: z.number().nullish(),
  output_tokens: z.number(),
})

/** The turn's completion, with usage: Codex's completion evidence. */
const TurnCompletedLineSchema = z.object({
  type: z.literal('turn.completed'),
  usage: CodexUsageSchema,
})

/** A turn that failed, printed in place of `turn.completed`. */
const TurnFailedLineSchema = z.object({
  type: z.literal('turn.failed'),
  error: z.object({ message: z.string() }),
})

/** A problem reported mid-turn, often a retry (`Reconnecting... 2/5 (...)`). */
const ErrorLineSchema = z.object({ type: z.literal('error'), message: z.string() })

// Observed on 0.166.0 without a login (an empty CODEX_HOME): `turn.failed`
// with "unexpected status 401 Unauthorized: Missing bearer or basic
// authentication in header, ...", exit 1. No usage-limit message has been
// observed; the pattern follows the other providers' and Codex's
// "You've hit your usage limit ... try again at ..." wording.
const USAGE_LIMIT =
  /usage limit|rate limit|hit your .* limit|limit reached|too many requests|resets/i
const AUTH =
  /not logged in|unauthori[sz]ed|authenticat|codex login|sign in again|log ?in again|token (has )?expired/i

/** `usage_limit` or `auth` when `text` reads like one, checked in that order. */
export function classifyText(text: string): 'usage_limit' | 'auth' | undefined {
  if (USAGE_LIMIT.test(text)) return 'usage_limit'
  if (AUTH.test(text)) return 'auth'
  return undefined
}

/**
 * Parses `codex exec --json` stdout. Every line yields `raw` first. A
 * completed `agent_message` becomes a `text` record; a completed
 * `command_execution` a `Bash` and a completed `file_change` an `Edit`
 * `tool` record. `turn.completed` yields `usage`.
 *
 * The `done` comes at the end of input: `reply` is the last agent
 * message, `sessionId` the `thread.started` id. `turn.completed` is
 * Codex's completion evidence and `turn.failed` replaces it in a turn
 * that failed; without either the `done` says `no_output`, or what the
 * last `error` line said when it reads as `auth` or `usage_limit`.
 */
export async function* parseCodex(lines: AsyncIterable<string>): AsyncGenerator<AgentEvent> {
  const turn = new TurnState()
  let n = 0
  for await (const line of lines) {
    n += 1
    yield { kind: 'raw', line }
    const value = parseJson(line)
    // Non-JSON lines (warnings, progress) are kept as raw only.
    if (!isRecord(value)) continue
    switch (value.type) {
      case 'thread.started': {
        const parsed = ThreadStartedLineSchema.safeParse(value)
        if (!parsed.success) {
          diag(SCOPE, `line ${n}: unexpected thread.started shape`)
          break
        }
        turn.sessionId = parsed.data.thread_id
        break
      }
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const parsed = ItemLineSchema.safeParse(value)
        if (!parsed.success) {
          diag(SCOPE, `line ${n}: unexpected ${value.type} shape`)
          break
        }
        const record = turn.item(parsed.data.type, parsed.data.item, n)
        if (record) yield record
        break
      }
      case 'turn.completed': {
        const parsed = TurnCompletedLineSchema.safeParse(value)
        if (!parsed.success) {
          diag(SCOPE, `line ${n}: unexpected turn.completed shape`)
          break
        }
        if (turn.ended) diag(SCOPE, `line ${n}: another turn end; the last one wins`)
        const usage = toUsage(parsed.data.usage)
        turn.end({ usage })
        yield { kind: 'usage', usage }
        break
      }
      case 'turn.failed': {
        const parsed = TurnFailedLineSchema.safeParse(value)
        if (!parsed.success) {
          diag(SCOPE, `line ${n}: unexpected turn.failed shape`)
          break
        }
        if (turn.ended) diag(SCOPE, `line ${n}: another turn end; the last one wins`)
        const { message } = parsed.data.error
        turn.end({ error: { kind: classifyText(message) ?? 'exit', message } })
        break
      }
      case 'error': {
        const parsed = ErrorLineSchema.safeParse(value)
        if (!parsed.success) {
          diag(SCOPE, `line ${n}: unexpected error shape`)
          break
        }
        turn.lastError = parsed.data.message
        break
      }
      default:
        break
    }
  }
  if (turn.running.size > 0) {
    diag(SCOPE, `${turn.running.size} tool call(s) never completed`)
  }
  yield turn.done()
}

/** How a turn ended: `turn.completed` with usage, or `turn.failed` with an error. */
type TurnEnd = { usage: Usage } | { error: AgentError }

/** What the parser has seen of the turn so far. */
class TurnState {
  sessionId: string | undefined
  /** The message of the last `error` line, for a stream that ends without a turn end. */
  lastError: string | undefined
  /** Tool items started and not completed yet. */
  readonly running = new Set<string>()
  private reply = ''
  private ending: TurnEnd | undefined

  get ended(): boolean {
    return this.ending !== undefined
  }

  end(ending: TurnEnd): void {
    this.ending = ending
  }

  /** The record for an item line, if it is a completed item rensa shows. */
  item(
    type: z.infer<typeof ItemLineSchema>['type'],
    item: z.infer<typeof ItemSchema>,
    n: number,
  ): AgentEvent | undefined {
    if (type !== 'item.completed') {
      if (item.type === 'command_execution' || item.type === 'file_change')
        this.running.add(item.id)
      return undefined
    }
    this.running.delete(item.id)
    switch (item.type) {
      case 'agent_message': {
        const parsed = AgentMessageSchema.safeParse(item)
        if (!parsed.success) return shapeDiag(n, item.type)
        if (parsed.data.text === '') return undefined
        this.reply = parsed.data.text
        return { kind: 'text', text: parsed.data.text }
      }
      case 'command_execution': {
        const parsed = CommandExecutionSchema.safeParse(item)
        if (!parsed.success) return shapeDiag(n, item.type)
        const { command, aggregated_output, status } = parsed.data
        return {
          kind: 'tool',
          name: 'Bash',
          input: { command },
          ok: status === 'completed',
          output: capBytes(aggregated_output ?? '', TOOL_OUTPUT_CAP_BYTES),
        }
      }
      case 'file_change': {
        const parsed = FileChangeSchema.safeParse(item)
        if (!parsed.success) return shapeDiag(n, item.type)
        const { changes, status } = parsed.data
        return {
          kind: 'tool',
          name: 'Edit',
          input: { changes },
          ok: status === 'completed',
          // Codex reports no output for a patch; the files it touched stand in.
          output: capBytes(
            changes.map((c) => `${c.kind} ${c.path}`).join('\n'),
            TOOL_OUTPUT_CAP_BYTES,
          ),
        }
      }
      default:
        return undefined
    }
  }

  /** The parser's provisional `done`, from everything seen. */
  done(): DoneEvent {
    const base = {
      kind: 'done' as const,
      reply: this.reply,
      exitCode: null,
      ...(this.sessionId !== undefined && { sessionId: this.sessionId }),
    }
    if (this.ending === undefined) {
      const message = this.lastError ?? 'no turn.completed event in the stream'
      return { ...base, error: { kind: classifyText(message) ?? 'no_output', message } }
    }
    return { ...base, ...this.ending }
  }
}

function shapeDiag(n: number, itemType: string): undefined {
  diag(SCOPE, `line ${n}: unexpected ${itemType} item shape`)
  return undefined
}

/**
 * rensa's usage from Codex's totals. `input` is the uncached part, as for
 * the other providers, and `cache_read` the cached part. There is no
 * `context`: the totals sum every request of the session, and the stream
 * does not report the size of the last prompt.
 */
function toUsage(usage: z.infer<typeof CodexUsageSchema>): Usage {
  const cached = usage.cached_input_tokens ?? 0
  return {
    input: Math.max(0, usage.input_tokens - cached),
    output: usage.output_tokens,
    ...(typeof usage.cached_input_tokens === 'number' && { cache_read: cached }),
  }
}

/** At most `cap` bytes of UTF-8, cut on a character boundary, with a marker when cut. */
function capBytes(text: string, cap: number): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= cap) return text
  // The decoder holds back a character split by the cut instead of mangling it.
  const head = new StringDecoder('utf8').write(bytes.subarray(0, cap))
  return `${head}\n[truncated: ${bytes.length} bytes]`
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}
