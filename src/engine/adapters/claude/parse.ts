import { StringDecoder } from 'node:string_decoder'
import { z } from 'zod'
import { diag } from '../../diag.js'
import { isRecord } from '../../run/jsonl.js'
import type { AgentError, Usage } from '../../run/types.js'
import type { AgentEvent, DoneEvent } from '../types.js'

// Claude Code's `--output-format stream-json --verbose
// --include-partial-messages` stdout, one JSON object per line, turned
// into agent events. Only the fields rensa reads are declared; unknown
// keys are dropped, unknown line types ignored.

const SCOPE = 'claude'
const TOOL_OUTPUT_CAP_BYTES = 4096

const ClaudeUsageSchema = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_read_input_tokens: z.number().nullish(),
  cache_creation_input_tokens: z.number().nullish(),
})
type ClaudeUsage = z.infer<typeof ClaudeUsageSchema>

const TextDeltaLineSchema = z.object({
  type: z.literal('stream_event'),
  event: z.object({ delta: z.object({ type: z.literal('text_delta'), text: z.string() }) }),
})

const AssistantLineSchema = z.object({
  type: z.literal('assistant'),
  message: z.object({
    content: z.array(z.unknown()),
    usage: ClaudeUsageSchema.optional().catch(undefined),
  }),
})

const AssistantBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.unknown() }),
])

const UserLineSchema = z.object({
  type: z.literal('user'),
  message: z.object({ content: z.union([z.string(), z.array(z.unknown())]) }),
})

const ToolResultBlockSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.unknown(),
  is_error: z.boolean().nullish(),
})

const ResultLineSchema = z.object({
  type: z.literal('result'),
  subtype: z.string(),
  is_error: z.boolean().nullish(),
  result: z.string().nullish(),
  usage: ClaudeUsageSchema.optional().catch(undefined),
  errors: z.array(z.string()).nullish(),
})
type ResultLine = z.infer<typeof ResultLineSchema>

const USAGE_LIMIT = /usage limit|hit your .* limit|resets/i
const AUTH = /not logged in|auth|login/i

/** `usage_limit` or `auth` when `text` reads like one, checked in that order. */
export function classifyText(text: string): 'usage_limit' | 'auth' | undefined {
  if (USAGE_LIMIT.test(text)) return 'usage_limit'
  if (AUTH.test(text)) return 'auth'
  return undefined
}

/**
 * Parses Claude Code's stream-json stdout. Every line yields `raw`
 * first. Text deltas become `delta`; each finished assistant text block
 * becomes a `text` record; a `tool_use` block is held until its
 * `tool_result` arrives and then becomes one `tool` record. The `result`
 * event is Claude's completion evidence: it fixes the reply, usage and
 * error of the `done`, which is held until the input ends so that lines
 * after it still get their `raw` and `done` stays last. Without a
 * `result` the `done` says `no_output`.
 */
export async function* parseClaude(lines: AsyncIterable<string>): AsyncGenerator<AgentEvent> {
  const pendingTools = new Map<string, { name: string; input: unknown }>()
  let lastAssistantUsage: ClaudeUsage | undefined
  let done: DoneEvent | undefined
  let n = 0
  for await (const line of lines) {
    n += 1
    yield { kind: 'raw', line }
    const value = parseJson(line)
    // Non-JSON lines (warnings, progress) are kept as raw only.
    if (!isRecord(value)) continue
    switch (value.type) {
      case 'stream_event': {
        const delta = TextDeltaLineSchema.safeParse(value)
        if (delta.success) yield { kind: 'delta', text: delta.data.event.delta.text }
        break
      }
      case 'assistant': {
        const parsed = AssistantLineSchema.safeParse(value)
        if (!parsed.success) {
          diag(SCOPE, `line ${n}: unexpected assistant message shape`)
          break
        }
        const { content, usage } = parsed.data.message
        if (usage) lastAssistantUsage = usage
        for (const raw of content) {
          const block = AssistantBlockSchema.safeParse(raw)
          // Thinking and other block types are not part of the transcript.
          if (!block.success) continue
          if (block.data.type === 'text') {
            yield { kind: 'text', text: block.data.text }
          } else {
            pendingTools.set(block.data.id, { name: block.data.name, input: block.data.input })
          }
        }
        break
      }
      case 'user': {
        const parsed = UserLineSchema.safeParse(value)
        if (!parsed.success) {
          diag(SCOPE, `line ${n}: unexpected user message shape`)
          break
        }
        const { content } = parsed.data.message
        if (typeof content === 'string') break
        for (const raw of content) {
          const block = ToolResultBlockSchema.safeParse(raw)
          if (!block.success) continue
          const { tool_use_id: id, is_error: isError, content: output } = block.data
          const use = pendingTools.get(id)
          if (use === undefined) diag(SCOPE, `line ${n}: tool result for unknown tool use ${id}`)
          pendingTools.delete(id)
          yield {
            kind: 'tool',
            name: use?.name ?? 'unknown',
            input: use?.input ?? null,
            ok: isError !== true,
            output: capBytes(contentText(output), TOOL_OUTPUT_CAP_BYTES),
          }
        }
        break
      }
      case 'result': {
        const parsed = ResultLineSchema.safeParse(value)
        if (!parsed.success) {
          diag(SCOPE, `line ${n}: unexpected result shape`)
          break
        }
        // A later result (a turn that followed a background task) replaces an earlier one.
        if (done) diag(SCOPE, `line ${n}: another result event; the last one wins`)
        done = doneFromResult(parsed.data, lastAssistantUsage)
        break
      }
      default:
        break
    }
  }
  yield done ?? {
    kind: 'done',
    reply: '',
    exitCode: null,
    error: { kind: 'no_output', message: 'no result event in the stream' },
  }
}

function doneFromResult(
  result: ResultLine,
  lastAssistantUsage: ClaudeUsage | undefined,
): DoneEvent {
  const reply = result.result ?? ''
  const usage = result.usage && toUsage(result.usage, lastAssistantUsage)
  const error = resultError(result, reply)
  return {
    kind: 'done',
    reply,
    exitCode: null,
    ...(usage && { usage }),
    ...(error && { error }),
  }
}

/**
 * A result is an error when its subtype is not `success`, or when it says
 * `is_error`: Claude Code 2.1.319 reports "Not logged in" and an unknown
 * model as `subtype: success, is_error: true`.
 */
function resultError(result: ResultLine, reply: string): AgentError | undefined {
  if (result.subtype === 'success' && result.is_error !== true) return undefined
  // An error before the first turn has no reply, only `errors`.
  const message = reply || result.errors?.join('\n') || `claude reported ${result.subtype}`
  return { kind: classifyText(message) ?? 'exit', message }
}

function toUsage(usage: ClaudeUsage, lastAssistant: ClaudeUsage | undefined): Usage {
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    ...(typeof usage.cache_read_input_tokens === 'number' && {
      cache_read: usage.cache_read_input_tokens,
    }),
    ...(lastAssistant && { context: contextTokens(lastAssistant) }),
  }
}

/**
 * The prompt size of the last request: with prompt caching its input is
 * split across uncached, cache-read and cache-creation tokens, and only
 * their sum is what the context window holds.
 */
function contextTokens(usage: ClaudeUsage): number {
  return (
    usage.input_tokens +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  )
}

/** A tool result's content as text: a string as is, text blocks joined, other blocks named. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (!isRecord(block)) return ''
        if (block.type === 'text' && typeof block.text === 'string') return block.text
        return `[${typeof block.type === 'string' ? block.type : 'content'}]`
      })
      .join('\n')
  }
  if (content === undefined || content === null) return ''
  return JSON.stringify(content)
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
