import { stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EFFORT } from './effort.js'
import { child, invalid, type Loc } from './loc.js'
import {
  type AgentConfig,
  type AgentStep,
  EFFORTS,
  type Effort,
  INPUTS,
  ON_FAIL,
  PAUSES,
  PROVIDERS,
  type Provider,
  type RawAgent,
  type RawAgentRef,
  type RawChain,
  type RawProject,
  type RawStep,
  type ResolvedAgent,
  type ShellStep,
  type Step,
  TOOLS,
  type Tools,
  type VarSpec,
} from './types.js'
import type { UnvalidatedChain } from './validate.js'

const CHAIN_NAME = /^[a-z0-9_-]+$/i

export interface ResolveInput {
  /** File stem of the chain file. */
  name: string
  chain: { raw: RawChain; file: string }
  project?: { raw: RawProject; file: string }
  user?: { raw: RawProject; file: string }
}

/**
 * Merges the chain with the repo and user project files into steps with
 * fully resolved agents. Throws on the first problem; `validateChain`
 * runs the cross-step rules afterwards.
 */
export async function resolveChain(input: ResolveInput): Promise<UnvalidatedChain> {
  const { raw, file } = input.chain
  const root: Loc = { file, at: '' }
  // The name ends up in run ids and directory names.
  if (!CHAIN_NAME.test(input.name)) {
    throw invalid(
      root,
      `chain name \`${input.name}\` may contain only letters, digits, \`_\` and \`-\`; rename the file`,
    )
  }
  if (raw.name !== undefined && raw.name !== input.name) {
    throw invalid(
      child(root, 'name'),
      `\`name: ${raw.name}\` does not match the file name \`${input.name}\``,
    )
  }
  const registry = buildRegistry(input)
  const steps: Step[] = []
  for (const [i, rawStep] of raw.steps.entries()) {
    steps.push(await resolveStep(rawStep, child(child(root, 'steps'), i), registry))
  }
  const base = raw.base ?? input.project?.raw.base ?? input.user?.raw.base
  const description = raw.description
  return {
    name: input.name,
    ...(description !== undefined && { description }),
    input: oneOf(raw.input ?? 'none', INPUTS, child(root, 'input')),
    ...(base !== undefined && { base }),
    allowApiKeys: input.project?.raw.allow_api_keys ?? input.user?.raw.allow_api_keys ?? false,
    steps,
    sources: {
      chain: file,
      ...(input.project && { project: input.project.file }),
      ...(input.user && { user: input.user.file }),
    },
  }
}

/**
 * Appends `-2`, `-3`, ... to repeated labels, in order:
 * `['claude', 'claude', 'codex']` → `['claude', 'claude-2', 'codex']`.
 */
export function deriveLabels(bases: readonly string[]): string[] {
  const taken = new Set<string>()
  return bases.map((base) => {
    let label = base
    for (let n = 2; taken.has(label); n++) label = `${base}-${n}`
    taken.add(label)
    return label
  })
}

const DURATION = /^(\d+)([smh])$/
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000 } as const

/** Parses `Ns`, `Nm`, or `Nh` into milliseconds; undefined if malformed. */
export function parseTimeout(value: string): number | undefined {
  const match = DURATION.exec(value)
  if (!match) return undefined
  const n = Number(match[1])
  const unit = match[2] as keyof typeof UNIT_MS
  return n > 0 ? n * UNIT_MS[unit] : undefined
}

const SHELL_VAR = /^\$\((.*)\)$/s
// Only `steps` has nested fields in the namespace; other dotted values,
// such as `package.json` or `v1.2.3`, are literals.
const REF_VAR = /^steps(\.[a-z0-9_-]+)+$/

/**
 * Surrounding whitespace is ignored when spotting `$(...)` and refs, since
 * YAML block scalars (`|`, `>`) add a trailing newline. Literals keep it.
 */
export function classifyVar(value: string): VarSpec {
  const trimmed = value.trim()
  const shell = SHELL_VAR.exec(trimmed)
  if (shell) return { kind: 'shell', value: shell[1] ?? '' }
  if (REF_VAR.test(trimmed)) return { kind: 'ref', value: trimmed }
  return { kind: 'literal', value }
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

type AgentField = keyof RawAgent

/**
 * An agent entry as written, with no checks yet. `at` remembers where each
 * field was declared, so after an overlay each path still resolves against
 * its own file and each error points at the right place.
 */
interface AgentDraft {
  fields: RawAgent
  at: Partial<Record<AgentField, Loc>>
  loc: Loc
}

/**
 * Registry entries are only collected here; an entry is checked when a
 * step uses it. Otherwise one stale entry in the user's project.yaml would
 * break every chain, and a `from` override could not route around it.
 */
type Registry = Map<string, AgentDraft>

function buildRegistry(input: ResolveInput): Registry {
  // Nearest level wins and replaces the whole entry.
  const registry: Registry = new Map()
  for (const level of [input.user, input.project, input.chain]) {
    if (!level?.raw.agents) continue
    for (const [name, raw] of Object.entries(level.raw.agents)) {
      registry.set(name, draftAgent(raw, { file: level.file, at: `agents.${name}` }))
    }
  }
  return registry
}

function draftAgent(raw: RawAgent, loc: Loc): AgentDraft {
  const fields: RawAgent = {}
  const at: AgentDraft['at'] = {}
  for (const key of ['provider', 'model', 'effort', 'tools', 'prompt', 'skills'] as const) {
    if (raw[key] === undefined) continue
    Object.assign(fields, { [key]: raw[key] })
    at[key] = child(loc, key)
  }
  return { fields, at, loc }
}

function overlay(base: AgentDraft, over: AgentDraft): AgentDraft {
  return {
    fields: { ...base.fields, ...over.fields },
    at: { ...base.at, ...over.at },
    loc: over.loc,
  }
}

/** `who` names the agent in messages: registry name, `from` name, or provider. */
async function finalizeAgent(draft: AgentDraft, who: string): Promise<AgentConfig> {
  const { fields, at, loc } = draft
  if (fields.provider === undefined) throw invalid(loc, `agent \`${who}\` needs \`provider\``)
  const provider = parseProvider(fields.provider, at.provider ?? loc)
  if (fields.tools === undefined) {
    throw invalid(loc, `agent \`${who}\` needs \`tools\`: read or write`)
  }
  const tools = oneOf(fields.tools, TOOLS, at.tools ?? loc)
  const skills: string[] = []
  for (const [i, skill] of (fields.skills ?? []).entries()) {
    skills.push(await skillDir(skill, child(at.skills ?? loc, i)))
  }
  const config: AgentConfig = { provider, tools, skills }
  if (fields.model !== undefined) config.model = fields.model
  if (fields.effort !== undefined) {
    config.effort = supportedEffort(fields.effort, provider, who, at.effort ?? loc)
  }
  if (fields.prompt !== undefined) {
    config.prompt = await existingFile(fields.prompt, at.prompt ?? loc)
  }
  return config
}

function parseProvider(value: string, loc: Loc): Provider {
  const allowed = PROVIDERS.filter((p) => p !== 'fake' || process.env.RENSA_DEV === '1')
  const match = allowed.find((p) => p === value)
  if (match === undefined) {
    throw invalid(
      loc,
      `unknown provider \`${value}\` at ${loc.at}; expected ${allowed.filter((p) => p !== 'fake').join(', ')}`,
    )
  }
  return match
}

/** Checks the level against `EFFORT`; the canonical level is kept. */
function supportedEffort(value: string, provider: Provider, who: string, loc: Loc): Effort {
  const effort = oneOf(value, EFFORTS, loc)
  const mapped = EFFORT[provider][effort]
  if (mapped === undefined || mapped === null) {
    throw invalid(loc, `${provider} does not support effort: ${effort} (agent \`${who}\`)`)
  }
  return effort
}

async function resolveAgentRef(
  ref: RawAgentRef,
  loc: Loc,
  registry: Registry,
): Promise<{ config: AgentConfig; base: string; name?: string; session: 'named' | 'fresh' }> {
  if (typeof ref === 'string') {
    const config = await finalizeAgent(lookup(registry, ref, loc), ref)
    return { config, base: ref, name: ref, session: 'named' }
  }
  const { from, ...fields } = ref
  const own = draftAgent(fields, loc)
  if (from === undefined) {
    const who = fields.provider ?? `at ${loc.at}`
    const config = await finalizeAgent(own, who)
    return { config, base: config.provider, session: 'fresh' }
  }
  const base = lookup(registry, from, child(loc, 'from'))
  const config = await finalizeAgent(overlay(base, own), from)
  return { config, base: from, session: 'fresh' }
}

function lookup(registry: Registry, name: string, loc: Loc): AgentDraft {
  const entry = registry.get(name)
  if (!entry) {
    const known = [...registry.keys()].sort().join(', ') || 'none defined'
    throw invalid(loc, `unknown agent \`${name}\` at ${loc.at}; known agents: ${known}`)
  }
  return entry
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

const STEP_ID = /^[a-z0-9_-]+$/i
const VAR_NAME = /^[a-z_][\w-]*$/i

async function resolveStep(raw: RawStep, loc: Loc, registry: Registry): Promise<Step> {
  if (!STEP_ID.test(raw.id)) {
    throw invalid(
      child(loc, 'id'),
      `step id \`${raw.id}\` may contain only letters, digits, \`_\` and \`-\``,
    )
  }
  const common = {
    id: raw.id,
    onFail: oneOf(raw.on_fail ?? 'stop', ON_FAIL, child(loc, 'on_fail')),
    timeoutMs: timeoutMs(raw.timeout, child(loc, 'timeout')),
    ...(raw.pause !== undefined && { pause: oneOf(raw.pause, PAUSES, child(loc, 'pause')) }),
  }
  const hasRun = raw.run !== undefined
  const hasPrompt = raw.prompt !== undefined
  const hasAgents = raw.agents !== undefined

  if (hasRun && !hasPrompt && !hasAgents) {
    for (const key of ['tools', 'vars'] as const) {
      if (raw[key] !== undefined) {
        throw invalid(child(loc, key), `\`${key}\` applies only to agent steps, not \`run\` steps`)
      }
    }
    const step: ShellStep = { ...common, kind: 'shell', command: raw.run ?? '' }
    return step
  }
  if (hasRun || !hasPrompt || !hasAgents) {
    const why = hasRun
      ? 'a step with `run` cannot also have `prompt` or `agents`'
      : 'an agent step needs both `prompt` and `agents`'
    throw invalid(loc, `step \`${raw.id}\`: ${why}`)
  }

  const agentsLoc = child(loc, 'agents')
  const refs = raw.agents ?? []
  const ref = refs[0]
  if (ref === undefined || refs.length !== 1) {
    throw invalid(agentsLoc, `step \`${raw.id}\` must list exactly one agent, found ${refs.length}`)
  }
  const agentLoc = child(agentsLoc, 0)
  const resolved = await resolveAgentRef(ref, agentLoc, registry)
  const tools = narrowTools(resolved.config.tools, raw.tools, child(loc, 'tools'), agentLoc)
  const [label = resolved.base] = deriveLabels([resolved.base])
  const agent: ResolvedAgent = {
    ...resolved.config,
    tools,
    label,
    ...(resolved.name !== undefined && { name: resolved.name }),
    session: resolved.session,
  }
  const step: AgentStep = {
    ...common,
    kind: 'agent',
    prompt: await existingFile(raw.prompt ?? '', child(loc, 'prompt')),
    agent,
    vars: resolveVars(raw.vars, child(loc, 'vars')),
  }
  return step
}

function narrowTools(
  agentTools: Tools,
  stepTools: string | undefined,
  loc: Loc,
  agentLoc: Loc,
): Tools {
  if (stepTools === undefined) return agentTools
  const narrowed = oneOf(stepTools, TOOLS, loc)
  if (narrowed === 'write' && agentTools === 'read') {
    throw invalid(
      agentLoc,
      `the agent at ${agentLoc.at} has \`tools: read\`; a step can narrow tools, never raise them`,
    )
  }
  return narrowed
}

// Names the namespace already provides; a var may not shadow them.
const RESERVED_VARS = new Set(['input', 'input_path', 'base', 'run_id', 'steps'])

function resolveVars(raw: Record<string, string> | undefined, loc: Loc): Record<string, VarSpec> {
  const entries = Object.entries(raw ?? {}).map(([name, value]) => {
    if (!VAR_NAME.test(name)) {
      throw invalid(
        child(loc, name),
        `var name \`${name}\` must start with a letter or \`_\` and contain only letters, digits, \`_\` and \`-\``,
      )
    }
    if (RESERVED_VARS.has(name)) {
      throw invalid(child(loc, name), `var name \`${name}\` is reserved by the namespace`)
    }
    return [name, classifyVar(value)] as const
  })
  // fromEntries defines own properties, so a var named __proto__ survives.
  return Object.fromEntries(entries)
}

function timeoutMs(value: string | undefined, loc: Loc): number {
  if (value === undefined) return UNIT_MS.h
  const ms = parseTimeout(value)
  if (ms === undefined) {
    throw invalid(loc, `invalid timeout \`${value}\`; use a whole number with s, m, or h, like 20m`)
  }
  return ms
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function oneOf<const T extends string>(value: string, allowed: readonly T[], loc: Loc): T {
  const match = allowed.find((a) => a === value)
  if (match === undefined) {
    throw invalid(loc, `invalid value \`${value}\` at ${loc.at}; expected ${allowed.join(' | ')}`)
  }
  return match
}

/** Resolves against the declaring file's directory; `~` is the home directory. */
function absolute(p: string, declaredIn: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return path.resolve(path.dirname(declaredIn), p)
}

async function existingFile(p: string, loc: Loc): Promise<string> {
  const abs = absolute(p, loc.file)
  if (!(await isKind(abs, 'file'))) throw invalid(loc, `file not found: ${abs}`)
  return abs
}

async function skillDir(p: string, loc: Loc): Promise<string> {
  const abs = absolute(p, loc.file)
  if (!(await isKind(abs, 'dir'))) throw invalid(loc, `skill directory not found: ${abs}`)
  if (!(await isKind(path.join(abs, 'SKILL.md'), 'file'))) {
    throw invalid(loc, `skill directory has no SKILL.md: ${abs}`)
  }
  return abs
}

async function isKind(p: string, kind: 'file' | 'dir'): Promise<boolean> {
  try {
    const s = await stat(p)
    return kind === 'file' ? s.isFile() : s.isDirectory()
  } catch {
    return false
  }
}
