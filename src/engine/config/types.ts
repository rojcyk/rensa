// Raw types mirror the YAML exactly; nothing is checked yet. Resolved
// types are what the rest of the engine consumes.

export interface RawAgent {
  provider?: string
  model?: string
  effort?: string
  tools?: string
  prompt?: string
  skills?: string[]
}

export type RawAgentRef = string | ({ from?: string } & RawAgent)

export interface RawStep {
  id?: string
  prompt?: string
  agents?: RawAgentRef[]
  vars?: Record<string, string>
  run?: string
  on_fail?: string
  timeout?: string
  pause?: string
  tools?: string
}

export interface RawChain {
  name?: string
  description?: string
  input?: string
  base?: string
  agents?: Record<string, RawAgent>
  steps?: RawStep[]
}

export interface RawProject {
  base?: string
  allow_api_keys?: boolean
  agents?: Record<string, RawAgent>
}

export const PROVIDERS = ['claude', 'codex', 'grok', 'fake'] as const
export type Provider = (typeof PROVIDERS)[number]

export const EFFORTS = ['low', 'medium', 'high', 'max'] as const
export type Effort = (typeof EFFORTS)[number]

export const TOOLS = ['read', 'write'] as const
export type Tools = (typeof TOOLS)[number]

export const INPUTS = ['none', 'text', 'file'] as const
export type InputKind = (typeof INPUTS)[number]

export const ON_FAIL = ['stop', 'continue'] as const
export type OnFail = (typeof ON_FAIL)[number]

export const PAUSES = ['before', 'after'] as const
export type Pause = (typeof PAUSES)[number]

export interface AgentConfig {
  provider: Provider
  model?: string
  /** Canonical level; adapters translate it through `EFFORT`. */
  effort?: Effort
  tools: Tools
  /** Absolute path to the persona file. */
  prompt?: string
  /** Absolute paths to skill directories. */
  skills: string[]
}

export interface ResolvedAgent extends AgentConfig {
  /** Derived; unique within the step. */
  label: string
  /** Registry name when listed by name. */
  name?: string
  session: 'named' | 'fresh'
}

export interface VarSpec {
  kind: 'literal' | 'shell' | 'ref'
  /** Literal text, the command inside `$(...)`, or the dotted path. */
  value: string
}

export interface AgentStep {
  id: string
  kind: 'agent'
  /** Absolute path to the step prompt file. */
  prompt: string
  /** Exactly one in the MVP. */
  agent: ResolvedAgent
  vars: Record<string, VarSpec>
  onFail: OnFail
  timeoutMs: number
  pause?: Pause
}

export interface ShellStep {
  id: string
  kind: 'shell'
  command: string
  onFail: OnFail
  timeoutMs: number
  pause?: Pause
}

export type Step = AgentStep | ShellStep

export interface ResolvedChain {
  name: string
  description?: string
  input: InputKind
  base?: string
  allowApiKeys: boolean
  steps: Step[]
  /** Any shell step, or any agent step with `write` tools. */
  writes: boolean
  /** Non-fatal findings, such as declared vars no prompt references. */
  warnings: string[]
  sources: { chain: string; project?: string; user?: string }
}
