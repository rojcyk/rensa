import { z } from 'zod'
import type { Effort, Provider, Tools } from '../config/types.js'
import {
  AgentErrorSchema,
  type NewTranscriptRecord,
  type Usage,
  UsageSchema,
} from '../run/types.js'

// The contract every provider adapter implements. Three real adapters
// (claude, grok, codex) and the fake are written against this file.

/** What a provider's CLI supports; the engine validates chains against it. */
export interface Capabilities {
  /** Can continue a session by id, so a named agent may span steps. */
  resume: boolean
  /** Accepts a model name. */
  model: boolean
  /** rensa effort levels the provider maps to a value of its own. */
  effort: Effort[]
  tools: Tools[]
  /**
   * What the usage an agent reports counts. `per_turn` (the default when
   * absent): this turn only. `session_total`: every turn of the session so
   * far (Codex), so the engine keeps the last totals of each named
   * session in run.json and reports a resumed turn's usage as the
   * difference. Adapters report what their CLI prints either way; parsers
   * stay pure and know nothing of earlier turns.
   */
  usage?: 'per_turn' | 'session_total'
}

export type Availability =
  | { status: 'not_installed' }
  | { status: 'not_logged_in'; version: string; hint: string }
  | { status: 'ready'; version: string }

export interface SpawnRequest {
  cwd: string
  /** Already stripped of API keys by the engine (`childEnv`). */
  env: NodeJS.ProcessEnv
  /** The rendered step prompt, with skills and user notes appended. */
  message: string
  /** Agent prompt file contents; only on a session's first use. */
  persona?: string
  model?: string
  effort?: Effort
  tools: Tools
  session: { id: string; resume: boolean }
  /** `runs/<id>/agents/<step>/<label>/`; the only place an adapter may write. */
  stagingDir: string
  timeoutMs: number
}

/** The final event of every agent process. A schema because fixtures store it (`done.json`). */
export const DoneEventSchema = z.object({
  kind: z.literal('done'),
  /** The agent's final reply text. */
  reply: z.string(),
  /** Null when the process was killed or never started. */
  exitCode: z.number().nullable(),
  usage: UsageSchema.optional(),
  error: AgentErrorSchema.optional(),
  /**
   * Set only by adapters whose CLI assigns its own session id (Codex);
   * the engine records it in run.json in place of the id it generated.
   */
  sessionId: z.string().optional(),
})
export type DoneEvent = z.infer<typeof DoneEventSchema>

/**
 * What an adapter emits while an agent runs. Records (`text`, `tool`,
 * `note`) are appended to `transcript.jsonl` unchanged once the engine
 * stamps `t`. `delta` is streaming text for display only and never
 * reaches disk; the record that follows for the same block supersedes
 * it. `raw` is every stdout line, emitted before any event derived from
 * it.
 */
export type AgentEvent =
  | NewTranscriptRecord
  | { kind: 'delta'; text: string }
  | { kind: 'raw'; line: string }
  | { kind: 'usage'; usage: Usage }
  | DoneEvent

/**
 * A running agent. `events` yields exactly one `done`, always last, even
 * after `kill()` or a failed spawn (then `exitCode: null` and
 * `error.kind: 'exit'`). It can be iterated once.
 */
export interface AgentProcess {
  pid?: number
  /** Asks the agent to stop; `events` still ends with its `done`. */
  kill(): void
  events: AsyncIterable<AgentEvent>
}

/**
 * Turns a provider's stdout lines into agent events. Pure: no process,
 * no clock, no files, so fixtures can pin it. One `raw` per line before
 * anything derived from it, and exactly one `done`, last, whatever the
 * input looks like.
 *
 * The parser's `done` is provisional: it states only what stdout shows.
 * `reply`, `usage` and `sessionId` come from the stream. `exitCode` is
 * what the stream reports, or null when it carries none (the usual
 * case: a CLI's exit status is not in its stdout). `error` is classified
 * from stdout alone. The engine never sees this event; `Adapter.spawn`
 * replaces it.
 *
 * When `done` is produced is each parser's choice: on a final event
 * (Claude's `result`) or at end of input (Codex). End of input is not an
 * error in itself. `no_output` means the provider's own completion
 * evidence is missing, and each adapter names that evidence: Claude's
 * `result` event, the fake's `done` line, Codex's `turn.completed`.
 */
export type Parser = (lines: AsyncIterable<string>) => AsyncIterable<AgentEvent>

/**
 * One per provider. Adapters never print and never write outside
 * `stagingDir`; anything worth telling the user goes through `diag()`.
 * They know nothing about skills: the engine inlines those into
 * `message` before calling `spawn`.
 */
export interface Adapter {
  readonly provider: Provider
  capabilities(): Capabilities
  available(env: NodeJS.ProcessEnv): Promise<Availability>
  /**
   * Starts the agent and owns its final `done`. Stdout lines go through
   * `parse`; every parser event is forwarded except the parser's `done`,
   * which is held. Stderr lines are kept for classification and may be
   * emitted as `raw` prefixed `stderr: `. Once both the parser has ended
   * and the process result is in, exactly one `done` is emitted:
   *
   * - `reply`, `usage`, `sessionId`: from the parser's `done`.
   * - `exitCode`: the process's; null when it died from a signal or
   *   never started.
   * - `error`, first rule that applies:
   *   1. the process never started → `exit`, the spawn error's message;
   *   2. it was killed, by `kill()` or by `timeoutMs` → `exit`, `killed`
   *      or `timed out`;
   *   3. the parser reported an error → that error, refined from stderr:
   *      a parser `no_output` or `exit` becomes `auth` or `usage_limit`
   *      when stderr shows one, with the matching stderr line as the
   *      message; a parser `auth` or `usage_limit` stands. Example:
   *      empty stdout and `Error: not logged in` on stderr → the parser
   *      says `no_output`, the final `done` says `auth`;
   *   4. a non-zero exit → classified from stderr, else `exit` with the
   *      last stderr line as the message;
   *   5. otherwise none.
   */
  spawn(req: SpawnRequest): AgentProcess
  parse: Parser
}
