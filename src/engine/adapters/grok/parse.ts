import { StringDecoder } from 'node:string_decoder'
import { z } from 'zod'
import { diag } from '../../diag.js'
import { isRecord } from '../../run/jsonl.js'
import type { AgentError, Usage } from '../../run/types.js'
import type { AgentEvent, DoneEvent } from '../types.js'

// Grok Build's `--output-format streaming-json` stdout, one JSON object
// per line, turned into agent events. Shapes as observed on 1.0.70 (see
// test/fixtures/grok/). Only the fields rensa reads are declared; unknown
// keys are dropped, unknown line types (`thought`, `available_commands`,
// `plan`, ...) are kept as `raw` only.

const SCOPE = 'grok'
const TOOL_OUTPUT_CAP_BYTES = 4096

const GrokUsageSchema = z.object({
  /** Uncached input only; the cached part is in the two cache fields. */
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_read_input_tokens: z.number().nullish(),
  cache_creation_input_tokens: z.number().nullish(),
})
type GrokUsage = z.infer<typeof GrokUsageSchema>

/** A chunk of streamed reply text. */
const TextLineSchema = z.object({ type: z.literal('text'), data: z.string() })

const ToolCallLineSchema = z.object({
  type: z.literal('tool_call'),
  toolCallId: z.string(),
  toolName: z.string().nullish(),
  title: z.string().nullish(),
  status: z.string().nullish(),
  rawInput: z.unknown().optional(),
  content: z.array(z.unknown()).nullish(),
  rawOutput: z.unknown().optional(),
})

/** Progress (`status: null`) or the result (`completed`, `failed`) of a tool call. */
const ToolCallUpdateLineSchema = z.object({
  type: z.literal('tool_call_update'),
  toolCallId: z.string(),
  status: z.string().nullish(),
  rawInput: z.unknown().optional(),
  content: z.array(z.unknown()).nullish(),
  rawOutput: z.unknown().optional(),
})

/** The end of one model response, with that response's usage. */
const UsageLineSchema = z.object({
  type: z.literal('usage'),
  usage: GrokUsageSchema,
})

/** The turn's completion: always the last line of a turn that ran. */
const EndLineSchema = z.object({
  type: z.literal('end'),
  stopReason: z.string().nullish(),
  usage: GrokUsageSchema.optional().catch(undefined),
})

/**
 * A failed turn: printed in place of `end`, e.g. when not signed in or a
 * flag is refused. Once the prompt reached the model it may carry the
 * same spend fields as `end`, whose `usage` also counts subagents.
 */
const ErrorLineSchema = z.object({
  type: z.literal('error'),
  message: z.string(),
  usage: GrokUsageSchema.optional().catch(undefined),
})

/** The text of one `content` entry of a tool call, as 1.0.70 sends it. */
const ContentTextSchema = z.object({
  type: z.literal('content'),
  content: z.object({ type: z.literal('text'), text: z.string() }),
})

const TOOL_DONE_STATUSES = new Set(['completed', 'failed'])

// Observed on 1.0.70 without a login: "Not signed in. To authenticate
// without a browser, run: grok login --device-code ...". No usage-limit
// message has been observed; the pattern follows the other providers'.
const USAGE_LIMIT = /usage limit|rate limit|hit your .* limit|limit reached|resets/i
const AUTH = /not signed in|not logged in|sign in again|authenticat|unauthori[sz]ed|grok login/i

/** `usage_limit` or `auth` when `text` reads like one, checked in that order. */
export function classifyText(text: string): 'usage_limit' | 'auth' | undefined {
  if (USAGE_LIMIT.test(text)) return 'usage_limit'
  if (AUTH.test(text)) return 'auth'
  return undefined
}

/** The fields of a `tool_call` or `tool_call_update` line that say whether and how it finished. */
type ToolStatus = Pick<z.infer<typeof ToolCallUpdateLineSchema>, 'status' | 'content' | 'rawOutput'>

interface PendingTool {
  name: string
  input: unknown
}

/**
 * Parses Grok Build's streaming-json stdout. Every line yields `raw`
 * first. Each `text` chunk becomes a `delta`; the chunks of one block
 * become one `text` record when the block ends, at the next `tool_call`,
 * `usage`, `end` or `error` line or at the end of input. A `tool_call` is
 * held until an update reports it `completed` or `failed`, then becomes
 * one `tool` record. Each `usage` line ends a model response and yields
 * the turn's usage so far. The reply is the text of the last response
 * that had any.
 *
 * `end` is Grok's completion evidence, and `error` replaces it in a turn
 * that failed. Either fixes the `done`, which is held until the input
 * ends so that lines after it still get their `raw` and `done` stays
 * last. Without either the `done` says `no_output`.
 */
export async function* parseGrok(lines: AsyncIterable<string>): AsyncGenerator<AgentEvent> {
  const turn = new TurnState()
  let done: DoneEvent | undefined
  let n = 0
  for await (const line of lines) {
    n += 1
    yield { kind: 'raw', line }
    const value = parseJson(line)
    // Non-JSON lines (warnings, progress) are kept as raw only.
    if (!isRecord(value)) continue
    switch (value.type) {
      case 'text': {
        const parsed = TextLineSchema.safeParse(value)
        if (!parsed.success) {
          diag(SCOPE, `line ${n}: unexpected text shape`)
          break
        }
        turn.addText(parsed.data.data)
        if (parsed.data.data !== '') yield { kind: 'delta', text: parsed.data.data }
        break
      }
      case 'tool_call': {
        const parsed = ToolCallLineSchema.safeParse(value)
        if (!parsed.success) {
          diag(SCOPE, `line ${n}: unexpected tool_call shape`)
          break
        }
        yield* turn.endBlock()
        const { toolCallId, toolName, title } = parsed.data
        turn.tools.set(toolCallId, {
          name: toolName ?? title ?? 'unknown',
          input: parsed.data.rawInput ?? null,
        })
        // A call reported finished in its first line needs no update.
        const record = turn.finishTool(toolCallId, parsed.data)
        if (record) yield record
        break
      }
      case 'tool_call_update': {
        const parsed = ToolCallUpdateLineSchema.safeParse(value)
        if (!parsed.success) {
          diag(SCOPE, `line ${n}: unexpected tool_call_update shape`)
          break
        }
        const { toolCallId, rawInput } = parsed.data
        const pending = turn.tools.get(toolCallId)
        if (pending === undefined) {
          diag(SCOPE, `line ${n}: update for unknown tool call ${toolCallId}`)
          turn.tools.set(toolCallId, { name: 'unknown', input: rawInput ?? null })
        } else if (rawInput !== undefined && rawInput !== null) {
          pending.input = rawInput
        }
        const record = turn.finishTool(toolCallId, parsed.data)
        if (record) yield record
        break
      }
      case 'usage': {
        const parsed = UsageLineSchema.safeParse(value)
        if (!parsed.success) {
          diag(SCOPE, `line ${n}: unexpected usage shape`)
          break
        }
        yield* turn.endBlock()
        turn.endResponse()
        yield { kind: 'usage', usage: turn.addUsage(parsed.data.usage) }
        break
      }
      case 'end': {
        const parsed = EndLineSchema.safeParse(value)
        if (!parsed.success) {
          diag(SCOPE, `line ${n}: unexpected end shape`)
          break
        }
        yield* turn.endBlock()
        turn.endResponse()
        if (done) diag(SCOPE, `line ${n}: another final event; the last one wins`)
        done = doneFromEnd(parsed.data, turn)
        break
      }
      case 'error': {
        const parsed = ErrorLineSchema.safeParse(value)
        if (!parsed.success) {
          diag(SCOPE, `line ${n}: unexpected error shape`)
          break
        }
        yield* turn.endBlock()
        turn.endResponse()
        if (done) diag(SCOPE, `line ${n}: another final event; the last one wins`)
        done = doneFromError(parsed.data, turn)
        break
      }
      default:
        break
    }
  }
  yield* turn.endBlock()
  if (turn.tools.size > 0) {
    diag(SCOPE, `${turn.tools.size} tool call(s) never reported a result`)
  }
  yield done ?? {
    kind: 'done',
    reply: '',
    exitCode: null,
    error: { kind: 'no_output', message: 'no end event in the stream' },
  }
}

/** What the parser has seen of the turn so far. */
class TurnState {
  readonly tools = new Map<string, PendingTool>()
  /** Chunks of the text block being streamed. */
  private chunks: string[] = []
  /** Finished text blocks of the response being streamed. */
  private responseBlocks: string[] = []
  /** The text of the last response that had any. */
  private lastResponseText = ''
  private totals: Usage | undefined
  private lastContext: number | undefined

  addText(chunk: string): void {
    this.chunks.push(chunk)
  }

  /** The finished text block as a record, if one was streaming. */
  *endBlock(): Generator<AgentEvent> {
    const text = this.chunks.join('')
    this.chunks = []
    if (text === '') return
    this.responseBlocks.push(text)
    yield { kind: 'text', text }
  }

  /** Closes the current model response; its text becomes the reply candidate. */
  endResponse(): void {
    if (this.responseBlocks.length === 0) return
    this.lastResponseText = this.responseBlocks.join('\n\n')
    this.responseBlocks = []
  }

  get reply(): string {
    return this.lastResponseText
  }

  /** Adds one response's usage to the turn's and returns the turn's so far. */
  addUsage(usage: GrokUsage): Usage {
    this.lastContext = contextTokens(usage)
    const previous = this.totals
    this.totals = {
      input: (previous?.input ?? 0) + usage.input_tokens,
      output: (previous?.output ?? 0) + usage.output_tokens,
      cache_read: (previous?.cache_read ?? 0) + (usage.cache_read_input_tokens ?? 0),
      context: this.lastContext,
    }
    return this.totals
  }

  get usage(): Usage | undefined {
    return this.totals
  }

  get context(): number | undefined {
    return this.lastContext
  }

  /** The `tool` record for a call whose status says it finished; it is then forgotten. */
  finishTool(id: string, update: ToolStatus): AgentEvent | undefined {
    const status = update.status
    if (typeof status !== 'string' || !TOOL_DONE_STATUSES.has(status)) return undefined
    const pending = this.tools.get(id)
    this.tools.delete(id)
    return {
      kind: 'tool',
      name: pending?.name ?? 'unknown',
      input: pending?.input ?? null,
      ok: status === 'completed',
      output: capBytes(toolOutputText(update.content, update.rawOutput), TOOL_OUTPUT_CAP_BYTES),
    }
  }
}

function doneFromEnd(end: z.infer<typeof EndLineSchema>, turn: TurnState): DoneEvent {
  const usage = end.usage ? toUsage(end.usage, turn.context) : turn.usage
  const error = stopError(end.stopReason)
  return {
    kind: 'done',
    reply: turn.reply,
    exitCode: null,
    ...(usage && { usage }),
    ...(error && { error }),
  }
}

/**
 * A turn that ended for any reason but `end_turn` (`max_tokens`,
 * `max_turn_requests`, `refusal`, `cancelled`) did not finish its work.
 */
function stopError(stopReason: string | null | undefined): AgentError | undefined {
  if (stopReason === undefined || stopReason === null || stopReason === 'end_turn') return undefined
  return { kind: 'exit', message: `grok stopped the turn: ${stopReason}` }
}

function doneFromError(line: z.infer<typeof ErrorLineSchema>, turn: TurnState): DoneEvent {
  const { message } = line
  // The error's own totals when it has them; the responses seen so far otherwise.
  const usage = line.usage ? toUsage(line.usage, turn.context) : turn.usage
  return {
    kind: 'done',
    reply: turn.reply,
    exitCode: null,
    ...(usage && { usage }),
    error: { kind: classifyText(message) ?? 'exit', message },
  }
}

/** The turn's totals from `end`, with the context size of its last response. */
function toUsage(usage: GrokUsage, context: number | undefined): Usage {
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    ...(typeof usage.cache_read_input_tokens === 'number' && {
      cache_read: usage.cache_read_input_tokens,
    }),
    ...(context !== undefined && { context }),
  }
}

/** A response's prompt size: uncached, cache-read and cache-creation tokens together. */
function contextTokens(usage: GrokUsage): number {
  return (
    usage.input_tokens +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  )
}

/**
 * A tool result as text: its `content` text entries joined, other
 * entries (diffs, terminals) named; with no content, `rawOutputText`.
 */
function toolOutputText(content: unknown[] | null | undefined, rawOutput: unknown): string {
  if (content && content.length > 0) {
    return content
      .map((entry) => {
        const text = ContentTextSchema.safeParse(entry)
        if (text.success) return text.data.content.text
        return `[${isRecord(entry) && typeof entry.type === 'string' ? entry.type : 'content'}]`
      })
      .join('\n')
  }
  return rawOutputText(rawOutput)
}

/**
 * A `rawOutput` as text. On 1.0.70 it is a tagged object whose one other
 * key holds the result as a string or as `{ content: string }`, e.g.
 * `list_dir`'s `{"type":"ListDir","Content":{"content":"- /repo/\n..."}}`,
 * which comes with an empty `content`. Any other shape is shown as JSON.
 */
function rawOutputText(rawOutput: unknown): string {
  if (rawOutput === undefined || rawOutput === null) return ''
  if (typeof rawOutput === 'string') return rawOutput
  if (isRecord(rawOutput)) {
    for (const [key, value] of Object.entries(rawOutput)) {
      if (key === 'type') continue
      if (typeof value === 'string') return value
      if (isRecord(value) && typeof value.content === 'string') return value.content
    }
  }
  return JSON.stringify(rawOutput)
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
