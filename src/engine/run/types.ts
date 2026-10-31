import type { InputKind, Tools } from '../config/types.js'

export type RunStatus = 'complete' | 'failed' | 'aborted'
export type StepStatus = 'ok' | 'failed' | 'killed' | 'timeout'

export interface Usage {
  input: number
  output: number
  cache_read?: number
  context?: number
}

export interface AgentError {
  kind: 'usage_limit' | 'auth' | 'exit' | 'no_output'
  message: string
}

export interface EventBase {
  /** 1-based, no gaps. */
  seq: number
  /** ISO 8601. */
  t: string
  step?: string
  agent?: string
}

/** One line of `events.jsonl`. */
export type RunEvent = EventBase &
  (
    | {
        type: 'run.started'
        data: {
          chain: string
          input_kind: InputKind
          input_path?: string
          base: string
          base_sha: string
          rensa_version: string
        }
      }
    | {
        type: 'run.paused'
        data: { before?: string; after?: string; reason: 'declared' | 'user' }
      }
    | { type: 'run.finished'; data: { status: RunStatus; failed_step?: string } }
    | { type: 'step.started'; step: string; data: { kind: 'agent' | 'shell'; command?: string } }
    | { type: 'step.finished'; step: string; data: { status: StepStatus; exit_code?: number } }
    | {
        type: 'agent.spawned'
        step: string
        agent: string
        data: {
          provider: string
          model?: string
          effort?: string
          tools: Tools
          session_id: string
          resumed: boolean
        }
      }
    | {
        type: 'agent.finished'
        step: string
        agent: string
        data: { status: StepStatus; exit_code?: number; usage?: Usage; error?: AgentError }
      }
    | { type: 'user.note'; data: { text: string; applies_from: string } }
    | { type: 'user.action'; data: { action: 'pause' | 'kill' | 'abort'; step?: string } }
  )

export type RunEventType = RunEvent['type']

/** One line of `transcript.jsonl`. */
export type TranscriptRecord =
  | { t: string; kind: 'text'; text: string }
  | { t: string; kind: 'tool'; name: string; input: unknown; ok: boolean; output: string }
  | { t: string; kind: 'note'; text: string }

/** `Omit` applied to each member of a union, keeping it discriminated. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** What a caller passes to `EventLog.append`; the log assigns `seq` and `t`. */
export type NewRunEvent = DistributiveOmit<RunEvent, 'seq' | 't'>

/** What a caller passes to `TranscriptWriter.record`; the writer assigns `t`. */
export type NewTranscriptRecord = DistributiveOmit<TranscriptRecord, 't'>
