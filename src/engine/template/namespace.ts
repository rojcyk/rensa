/** What a finished step contributes to the namespace, under `steps.<id>`. */
export interface StepResult {
  kind: 'shell' | 'agent'
  /** Shell: tail of stdout+stderr. Agent: map by agent label. */
  output: string | Record<string, unknown>
  /** Agent: concatenated final replies. */
  text?: string
  /** Shell: exit code was zero. */
  passed?: boolean
  /** Shell. Named as the namespace spells it, so `lookup` walks it directly. */
  exit_code?: number
}

export interface Namespace {
  input?: string
  input_path?: string
  base: string
  run_id: string
  steps: Record<string, StepResult>
}

/**
 * Walks a dotted path such as `steps.test.output`. Any missing segment
 * yields undefined; the caller decides whether that is an error.
 */
export function lookup(ns: Namespace, path: string): unknown {
  let current: unknown = ns
  for (const key of path.split('.')) {
    if (typeof current !== 'object' || current === null || !Object.hasOwn(current, key)) {
      return undefined
    }
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/** True if `value` is the output map of an agent step in `ns`, by identity. */
export function isOutputMap(value: unknown, ns: Namespace): value is Record<string, unknown> {
  return Object.values(ns.steps).some((s) => s.kind === 'agent' && s.output === value)
}
