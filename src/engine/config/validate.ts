import { readFile } from 'node:fs/promises'
import { RensaError } from '../errors.js'
import { findPlaceholders } from '../template/render.js'
import { child, invalid, type Loc } from './loc.js'
import type { AgentStep, Provider, ResolvedChain, Step } from './types.js'

// ---------------------------------------------------------------------------
// Resolved chain: collects every problem, throws the first with the rest
// attached as `details`. The raw shape was already checked by the schemas
// in types.ts; everything here needs context the document alone lacks.
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
