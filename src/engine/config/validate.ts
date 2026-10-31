import { readFile } from 'node:fs/promises'
import { RensaError } from '../errors.js'
import { findPlaceholders } from '../template/render.js'
import { describe, isMapping } from './load.js'
import type {
  AgentStep,
  Provider,
  RawAgent,
  RawAgentRef,
  RawChain,
  RawProject,
  RawStep,
  ResolvedChain,
  Step,
} from './types.js'

/** Where in which file a config value sits. `at` is a dotted path. */
export interface Loc {
  file: string
  at: string
}

/** A `CONFIG_INVALID` error whose `path` is the dotted config path. */
export function invalid(loc: Loc, message: string): RensaError {
  return new RensaError('CONFIG_INVALID', `${loc.file}: ${message}`, loc.at)
}

export function child(loc: Loc, key: string | number): Loc {
  if (typeof key === 'number') return { file: loc.file, at: `${loc.at}[${key}]` }
  return { file: loc.file, at: loc.at ? `${loc.at}.${key}` : key }
}

// ---------------------------------------------------------------------------
// Raw shape: run on the parsed YAML before resolution. Throws on the first
// problem, since nothing after it can be trusted.
// ---------------------------------------------------------------------------

const CHAIN_KEYS = ['name', 'description', 'input', 'base', 'agents', 'steps'] as const
const PROJECT_KEYS = ['base', 'allow_api_keys', 'agents'] as const
const STEP_KEYS = [
  'id',
  'prompt',
  'agents',
  'vars',
  'run',
  'on_fail',
  'timeout',
  'pause',
  'tools',
] as const
const AGENT_KEYS = ['provider', 'model', 'effort', 'tools', 'prompt', 'skills'] as const
const AGENT_REF_KEYS = ['from', ...AGENT_KEYS] as const

export function checkRawChain(doc: Record<string, unknown>, file: string): RawChain {
  const root: Loc = { file, at: '' }
  checkKeys(doc, CHAIN_KEYS, root)
  for (const key of ['name', 'description', 'input', 'base'] as const) {
    optString(doc, key, root)
  }
  if (doc.agents !== undefined) checkRegistry(doc.agents, child(root, 'agents'))
  if (doc.steps === undefined) throw invalid(child(root, 'steps'), 'a chain needs `steps`')
  const steps = expectList(doc.steps, child(root, 'steps'))
  if (steps.length === 0) throw invalid(child(root, 'steps'), '`steps` is empty')
  steps.forEach((step, i) => {
    checkStep(step, child(child(root, 'steps'), i))
  })
  // Boundary cast: every key was checked above.
  return doc as RawChain
}

export function checkRawProject(doc: Record<string, unknown>, file: string): RawProject {
  const root: Loc = { file, at: '' }
  checkKeys(doc, PROJECT_KEYS, root)
  optString(doc, 'base', root)
  if (doc.allow_api_keys !== undefined && typeof doc.allow_api_keys !== 'boolean') {
    throw invalid(child(root, 'allow_api_keys'), '`allow_api_keys` must be true or false')
  }
  if (doc.agents !== undefined) checkRegistry(doc.agents, child(root, 'agents'))
  // Boundary cast: every key was checked above.
  return doc as RawProject
}

// A registry name becomes the agent's label, which is a directory name
// under the run and a key in `steps.<id>.output.<label>`.
const AGENT_NAME = /^[a-z0-9_-]+$/i

function checkRegistry(value: unknown, loc: Loc): asserts value is Record<string, RawAgent> {
  const agents = expectMapping(value, loc)
  for (const [name, entry] of Object.entries(agents)) {
    if (!AGENT_NAME.test(name)) {
      throw invalid(
        child(loc, name),
        `agent name \`${name}\` may contain only letters, digits, \`_\` and \`-\``,
      )
    }
    checkAgent(entry, child(loc, name), AGENT_KEYS)
  }
}

function checkAgent(
  value: unknown,
  loc: Loc,
  keys: readonly string[],
): asserts value is RawAgent & { from?: string } {
  const agent = expectMapping(value, loc)
  checkKeys(agent, keys, loc)
  for (const key of ['from', 'provider', 'model', 'effort', 'tools', 'prompt'] as const) {
    optString(agent, key, loc)
  }
  if (agent.skills !== undefined) {
    const skills = expectList(agent.skills, child(loc, 'skills'))
    skills.forEach((skill, i) => {
      if (typeof skill !== 'string') {
        throw invalid(child(child(loc, 'skills'), i), `expected a path, got ${describe(skill)}`)
      }
    })
  }
}

function checkStep(value: unknown, loc: Loc): asserts value is RawStep {
  const step = expectMapping(value, loc)
  checkKeys(step, STEP_KEYS, loc)
  for (const key of ['id', 'prompt', 'run', 'on_fail', 'timeout', 'pause', 'tools'] as const) {
    optString(step, key, loc)
  }
  if (step.agents !== undefined) {
    const refs = expectList(step.agents, child(loc, 'agents'))
    refs.forEach((ref, i) => {
      checkAgentRef(ref, child(child(loc, 'agents'), i))
    })
  }
  if (step.vars !== undefined) {
    const vars = expectMapping(step.vars, child(loc, 'vars'))
    for (const [name, spec] of Object.entries(vars)) {
      if (typeof spec !== 'string') {
        throw invalid(
          child(child(loc, 'vars'), name),
          `\`${name}\` must be a string, got ${describe(spec)}; quote the value`,
        )
      }
    }
  }
}

function checkAgentRef(value: unknown, loc: Loc): asserts value is RawAgentRef {
  if (typeof value === 'string') return
  checkAgent(value, loc, AGENT_REF_KEYS)
}

function checkKeys(obj: Record<string, unknown>, allowed: readonly string[], loc: Loc): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      const where = loc.at || 'the top level'
      throw invalid(
        child(loc, key),
        `unknown key \`${key}\` at ${where}; not supported in this version`,
      )
    }
  }
}

function optString(obj: Record<string, unknown>, key: string, loc: Loc): void {
  const value = obj[key]
  if (value !== undefined && typeof value !== 'string') {
    throw invalid(child(loc, key), `\`${key}\` must be a string, got ${describe(value)}`)
  }
}

function expectMapping(value: unknown, loc: Loc): Record<string, unknown> {
  if (!isMapping(value))
    throw invalid(loc, `\`${loc.at}\` must be a mapping, got ${describe(value)}`)
  return value
}

function expectList(value: unknown, loc: Loc): unknown[] {
  if (!Array.isArray(value))
    throw invalid(loc, `\`${loc.at}\` must be a list, got ${describe(value)}`)
  return value
}

// ---------------------------------------------------------------------------
// Resolved chain: collects every problem, throws the first with the rest
// attached as `details`.
// ---------------------------------------------------------------------------

export type UnvalidatedChain = Omit<ResolvedChain, 'writes' | 'warnings'>

const BUILTINS = new Set(['input', 'input_path', 'base', 'run_id'])
/** Namespace fields each step kind provides, per docs/chain.yaml. */
const STEP_FIELDS: Record<Step['kind'], readonly string[]> = {
  shell: ['output', 'passed', 'exit_code'],
  agent: ['output', 'text'],
}

export async function validateChain(chain: UnvalidatedChain): Promise<ResolvedChain> {
  const errors: RensaError[] = []
  const warnings: string[] = []
  const root: Loc = { file: chain.sources.chain, at: '' }
  /** Earlier step ids and their kinds. */
  const seen = new Map<string, Step['kind']>()
  /** Earlier step ids by their lower-case form. */
  const folded = new Map<string, string>()
  const read = cachedReader()

  for (const [i, step] of chain.steps.entries()) {
    const loc = child(child(root, 'steps'), i)
    const earlier = folded.get(step.id.toLowerCase())
    if (seen.has(step.id)) {
      errors.push(invalid(child(loc, 'id'), `duplicate step id \`${step.id}\``))
    } else if (earlier !== undefined) {
      errors.push(
        invalid(
          child(loc, 'id'),
          `step id \`${step.id}\` differs from \`${earlier}\` only in case; step ids name directories, which some filesystems treat as the same`,
        ),
      )
    }
    if (step.kind === 'agent') {
      const sources: Array<{ file: string; loc: Loc }> = [
        { file: step.prompt, loc: child(loc, 'prompt') },
      ]
      if (step.agent.prompt) {
        sources.push({
          file: step.agent.prompt,
          loc: child(child(child(loc, 'agents'), 0), 'prompt'),
        })
      }
      const used = new Set<string>()
      for (const source of sources) {
        const text = await read(source.file, source.loc)
        if (text instanceof RensaError) {
          errors.push(text)
          continue
        }
        for (const name of findPlaceholders(text)) {
          used.add(name)
          const problem = checkPlaceholder(name, step.vars, seen, chain)
          if (problem) errors.push(invalid(source.loc, `${problem} in ${source.file}`))
        }
      }
      // Var values render against the namespace only (step 04), never
      // against other vars, so they are checked without the step's vars.
      for (const [name, spec] of Object.entries(step.vars)) {
        const varLoc = child(child(loc, 'vars'), name)
        if (spec.kind === 'ref') {
          const problem = checkRef(spec.value, seen)
          if (problem) errors.push(invalid(varLoc, problem))
          continue
        }
        for (const inner of findPlaceholders(spec.value)) {
          const problem = checkPlaceholder(inner, undefined, seen, chain)
          if (problem) errors.push(invalid(varLoc, `${problem} in var \`${name}\``))
        }
      }
      for (const name of Object.keys(step.vars)) {
        if (!used.has(name)) {
          warnings.push(`steps[${i}] (${step.id}): var \`${name}\` is declared but never used`)
        }
      }
    }
    if (!seen.has(step.id)) seen.set(step.id, step.kind)
    if (earlier === undefined) folded.set(step.id.toLowerCase(), step.id)
  }

  const [first, ...rest] = errors
  if (first) {
    throw new RensaError(
      first.code,
      first.message,
      first.path,
      first.hint,
      rest.map((e) => e.message),
    )
  }
  const writes = chain.steps.some((s) => s.kind === 'shell' || s.agent.tools === 'write')
  return { ...chain, writes, warnings }
}

/**
 * Returns why `{{name}}` cannot be rendered, or undefined if it can.
 * `vars` is the step's vars for a prompt or persona, undefined inside a
 * var value, where only the namespace is available.
 */
function checkPlaceholder(
  name: string,
  vars: AgentStep['vars'] | undefined,
  earlier: ReadonlyMap<string, Step['kind']>,
  chain: UnvalidatedChain,
): string | undefined {
  if (vars && Object.hasOwn(vars, name)) return undefined
  if (name === 'input' && chain.input === 'none') {
    return '`{{input}}` is used but the chain has `input: none`'
  }
  if (name === 'input_path' && chain.input !== 'file') {
    return '`{{input_path}}` is used but the chain does not have `input: file`'
  }
  if (BUILTINS.has(name)) return undefined
  const parts = name.split('.')
  if (parts[0] === 'steps' && parts.length === 3) {
    const problem = checkStepPath(parts, earlier)
    return problem && `\`{{${name}}}\` ${problem}`
  }
  if (!vars) {
    return `unknown placeholder \`{{${name}}}\`; inside a var only built-ins and \`steps.<id>.<field>\` are available`
  }
  return `unknown placeholder \`{{${name}}}\`; declare it in this step's \`vars\``
}

/** Checks a ref var; `classifyVar` makes refs only of `steps.` paths. */
function checkRef(ref: string, earlier: ReadonlyMap<string, Step['kind']>): string | undefined {
  const parts = ref.split('.')
  if (parts[0] !== 'steps' || parts.length < 3) {
    return `ref \`${ref}\` must be \`steps.<id>.<field>\``
  }
  const problem = checkStepPath(parts, earlier)
  return problem && `ref \`${ref}\` ${problem}`
}

/**
 * `parts` is `['steps', id, field, ...rest]`. Only an agent step's
 * `output` goes deeper: it is a map by agent label, not known until run.
 */
function checkStepPath(
  parts: readonly string[],
  earlier: ReadonlyMap<string, Step['kind']>,
): string | undefined {
  const [, id = '', field = ''] = parts
  const kind = earlier.get(id)
  if (kind === undefined) return `refers to \`${id}\`, which is not an earlier step`
  const fields = STEP_FIELDS[kind]
  if (!fields.includes(field)) {
    return `uses unknown field \`${field}\`; ${kind} step \`${id}\` has ${fields.join(', ')}`
  }
  if (parts.length > 3 && !(kind === 'agent' && field === 'output')) {
    return `goes below \`${field}\`; only an agent step's \`output\` has keys (one per agent label)`
  }
  return undefined
}

function cachedReader(): (file: string, loc: Loc) => Promise<string | RensaError> {
  const cache = new Map<string, Promise<string | RensaError>>()
  return (file, loc) => {
    let text = cache.get(file)
    if (!text) {
      text = readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) =>
        invalid(loc, `cannot read ${file}: ${err.code ?? String(err)}`),
      )
      cache.set(file, text)
    }
    return text
  }
}

// ---------------------------------------------------------------------------
// Adapter-dependent rules, called by the engine once adapters are known.
// ---------------------------------------------------------------------------

/**
 * A named agent is resumed across steps, so its provider must support
 * session resume. Returns the error rather than throwing so the engine can
 * attach it to the chain's summary.
 */
export function validateWithAdapters(
  chain: ResolvedChain,
  caps: Partial<Record<Provider, { resume: boolean }>>,
): RensaError | undefined {
  const root: Loc = { file: chain.sources.chain, at: '' }
  for (const [i, step] of chain.steps.entries()) {
    if (step.kind !== 'agent' || step.agent.session !== 'named') continue
    if (caps[step.agent.provider]?.resume === false) {
      const loc = child(child(child(root, 'steps'), i), 'agents')
      return invalid(
        child(loc, 0),
        `agent \`${step.agent.name}\` is listed by name, but ${step.agent.provider} cannot resume sessions; use \`{ from: ${step.agent.name} }\``,
      )
    }
  }
  return undefined
}
