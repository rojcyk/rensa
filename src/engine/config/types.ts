import { z } from 'zod'

// Raw schemas mirror the YAML exactly: every key the format accepts, its
// type, its enum, and `.strict()` to reject reserved keys. Anything that
// needs more than the document itself, such as file existence, registry
// lookups or the effort table, is checked in resolve.ts and validate.ts.
// Resolved types are what the rest of the engine consumes.

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

export function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function describe(value: unknown): string {
  if (value === null || value === undefined) return 'nothing'
  if (Array.isArray(value)) return 'a list'
  return `a ${typeof value === 'object' ? 'mapping' : typeof value}`
}

const Timeout = z.string().regex(/^\d+[smh]$/, 'expected a duration like 20m or 1h')

/**
 * `z.record` writes each parsed key onto a plain object, which silently
 * drops a key named `__proto__`. YAML delivers that key like any other, so
 * vars are checked in place and returned as parsed.
 */
const Vars = z
  .custom<Record<string, string>>(isMapping, {
    error: 'Invalid input: expected record',
    abort: true,
  })
  .superRefine((vars, ctx) => {
    const entries: Array<[string, unknown]> = Object.entries(vars)
    for (const [name, value] of entries) {
      if (typeof value !== 'string') {
        ctx.addIssue({
          code: 'custom',
          path: [name],
          message: `expected a string, got ${describe(value)}; quote the value`,
        })
      }
    }
  })

export const RawAgentSchema = z
  .object({
    provider: z.enum(PROVIDERS).optional(),
    model: z.string().optional(),
    effort: z.enum(EFFORTS).optional(),
    tools: z.enum(TOOLS).optional(),
    prompt: z.string().optional(),
    skills: z.array(z.string()).optional(),
  })
  .strict()

export const RawAgentRefSchema = z.union([
  z.string(),
  RawAgentSchema.extend({ from: z.string().optional() }).strict(),
])

// A registry name becomes the agent's label, which is a directory name
// under the run and a key in `steps.<id>.output.<label>`.
const AGENT_NAME = /^[a-z0-9_-]+$/i

const RegistrySchema = z.record(z.string(), RawAgentSchema).superRefine((agents, ctx) => {
  for (const name of Object.keys(agents)) {
    if (!AGENT_NAME.test(name)) {
      ctx.addIssue({
        code: 'custom',
        path: [name],
        message: `agent name \`${name}\` may contain only letters, digits, \`_\` and \`-\``,
      })
    }
  }
})

export const RawStepSchema = z
  .object({
    id: z.string().min(1),
    prompt: z.string().optional(),
    agents: z
      .array(RawAgentRefSchema)
      .length(1, 'exactly one agent per step in this version')
      .optional(),
    vars: Vars.optional(),
    run: z.string().optional(),
    on_fail: z.enum(ON_FAIL).optional(),
    timeout: Timeout.optional(),
    pause: z.enum(PAUSES).optional(),
    tools: z.enum(TOOLS).optional(),
  })
  .strict()

export const RawChainSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    input: z.enum(INPUTS).optional(),
    base: z.string().optional(),
    agents: RegistrySchema.optional(),
    steps: z.array(RawStepSchema).min(1),
  })
  .strict()

export const RawProjectSchema = z
  .object({
    base: z.string().optional(),
    allow_api_keys: z.boolean().optional(),
    agents: RegistrySchema.optional(),
  })
  .strict()

export type RawAgent = z.infer<typeof RawAgentSchema>
export type RawAgentRef = z.infer<typeof RawAgentRefSchema>
export type RawStep = z.infer<typeof RawStepSchema>
export type RawChain = z.infer<typeof RawChainSchema>
export type RawProject = z.infer<typeof RawProjectSchema>

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
