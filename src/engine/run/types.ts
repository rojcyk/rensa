import { z } from 'zod'
import { INPUTS, TOOLS } from '../config/types.js'

// Everything read back from a run directory is checked against these
// schemas line by line; a line that does not fit becomes a warning, never
// an undefined field in the UI. The types the engine passes around are
// derived from the same declarations.

const RunStatus = z.enum(['complete', 'failed', 'aborted'])
export type RunStatus = z.infer<typeof RunStatus>

const StepStatus = z.enum(['ok', 'failed', 'killed', 'timeout'])
export type StepStatus = z.infer<typeof StepStatus>

export const UsageSchema = z.object({
  input: z.number(),
  output: z.number(),
  cache_read: z.number().optional(),
  context: z.number().optional(),
})
export type Usage = z.infer<typeof UsageSchema>

export const AgentErrorSchema = z.object({
  kind: z.enum(['usage_limit', 'auth', 'exit', 'no_output']),
  message: z.string(),
})
export type AgentError = z.infer<typeof AgentErrorSchema>

const EventBase = z.object({
  /** 1-based, no gaps. */
  seq: z.number().int().positive(),
  /** ISO 8601. */
  t: z.string(),
  step: z.string().optional(),
  agent: z.string().optional(),
})

const KnownEvent = z.discriminatedUnion('type', [
  EventBase.extend({
    type: z.literal('run.started'),
    data: z.object({
      chain: z.string(),
      input_kind: z.enum(INPUTS),
      input_path: z.string().optional(),
      base: z.string(),
      base_sha: z.string(),
      rensa_version: z.string(),
    }),
  }),
  EventBase.extend({
    type: z.literal('run.paused'),
    data: z.object({
      before: z.string().optional(),
      after: z.string().optional(),
      reason: z.enum(['declared', 'user']),
    }),
  }),
  EventBase.extend({
    type: z.literal('run.finished'),
    data: z.object({ status: RunStatus, failed_step: z.string().optional() }),
  }),
  EventBase.extend({
    type: z.literal('step.started'),
    step: z.string(),
    data: z.object({ kind: z.enum(['agent', 'shell']), command: z.string().optional() }),
  }),
  EventBase.extend({
    type: z.literal('step.finished'),
    step: z.string(),
    data: z.object({ status: StepStatus, exit_code: z.number().optional() }),
  }),
  EventBase.extend({
    type: z.literal('agent.spawned'),
    step: z.string(),
    agent: z.string(),
    data: z.object({
      provider: z.string(),
      model: z.string().optional(),
      effort: z.string().optional(),
      tools: z.enum(TOOLS),
      session_id: z.string(),
      resumed: z.boolean(),
    }),
  }),
  EventBase.extend({
    type: z.literal('agent.finished'),
    step: z.string(),
    agent: z.string(),
    data: z.object({
      status: StepStatus,
      exit_code: z.number().optional(),
      usage: UsageSchema.optional(),
      error: AgentErrorSchema.optional(),
    }),
  }),
  EventBase.extend({
    type: z.literal('user.note'),
    data: z.object({ text: z.string(), applies_from: z.string() }),
  }),
  EventBase.extend({
    type: z.literal('user.action'),
    data: z.object({ action: z.enum(['pause', 'kill', 'abort']), step: z.string().optional() }),
  }),
])

const KNOWN_EVENT_TYPES = new Set<string>(KnownEvent.options.map((o) => o.shape.type.value))

/**
 * An event this version does not know, kept whole so a newer run can be
 * shown by an older reader. A known type with the wrong shape is not one
 * of these: it fails the union and becomes a warning.
 */
const UnknownEvent = EventBase.extend({
  type: z.string().refine((type) => !KNOWN_EVENT_TYPES.has(type), 'a known event type'),
}).loose()

/** One line of `events.jsonl`. */
export const RunEventSchema = z.union([KnownEvent, UnknownEvent])
export type RunEvent = z.infer<typeof RunEventSchema>

/** The events this version writes; consumers of `RunEvent` need a default branch too. */
export type KnownRunEvent = z.infer<typeof KnownEvent>
export type RunEventType = KnownRunEvent['type']

const Stamp = { t: z.string() }
const TextRecord = z.object({ kind: z.literal('text'), text: z.string() })
const ToolRecord = z.object({
  kind: z.literal('tool'),
  name: z.string(),
  input: z.unknown(),
  ok: z.boolean(),
  output: z.string(),
})
const NoteRecord = z.object({ kind: z.literal('note'), text: z.string() })

/** What a parser emits and a caller passes to `TranscriptWriter.record`; the writer stamps `t`. */
export const NewTranscriptRecordSchema = z.discriminatedUnion('kind', [
  TextRecord,
  ToolRecord,
  NoteRecord,
])
export type NewTranscriptRecord = z.infer<typeof NewTranscriptRecordSchema>

/** One line of `transcript.jsonl`. */
export const TranscriptRecordSchema = z.discriminatedUnion('kind', [
  TextRecord.extend(Stamp),
  ToolRecord.extend(Stamp),
  NoteRecord.extend(Stamp),
])
export type TranscriptRecord = z.infer<typeof TranscriptRecordSchema>

/** `Omit` applied to each member of a union, keeping it discriminated. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** What a caller passes to `EventLog.append`; the log assigns `seq` and `t`. */
export type NewRunEvent = DistributiveOmit<KnownRunEvent, 'seq' | 't'>
