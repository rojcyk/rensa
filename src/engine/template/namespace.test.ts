import { describe, expect, it } from 'vitest'
import { isOutputMap, lookup, type Namespace, type StepResult } from './namespace.js'

function shellResult(overrides: Partial<StepResult> = {}): StepResult {
  return {
    kind: 'shell',
    output: 'FAIL src/cart.test.ts\n  1 failing\n',
    passed: false,
    exit_code: 1,
    ...overrides,
  }
}

function agentResult(overrides: Partial<StepResult> = {}): StepResult {
  return {
    kind: 'agent',
    output: {
      claude: { verdict: 'changes requested', issues: ['missing null check in cart.ts'] },
    },
    text: 'Two issues found.\n{"verdict": "changes requested"}',
    ...overrides,
  }
}

function namespace(overrides: Partial<Namespace> = {}): Namespace {
  return {
    input: 'Add a coupon field to checkout',
    base: 'main',
    run_id: '20261031-142233-review',
    steps: {
      test: shellResult(),
      'review-codex': agentResult(),
    },
    ...overrides,
  }
}

describe('looking up dotted paths in the namespace', () => {
  it('returns a top-level field when the path has one segment', () => {
    expect(lookup(namespace(), 'base')).toBe('main')
  })

  it('returns the shell output text when the path is steps.<id>.output', () => {
    expect(lookup(namespace(), 'steps.test.output')).toBe('FAIL src/cart.test.ts\n  1 failing\n')
  })

  it('walks into an agent output map when the path goes below output', () => {
    const ns = namespace()

    expect(lookup(ns, 'steps.review-codex.output.claude.verdict')).toBe('changes requested')
  })

  it('returns the very object stored in the namespace when the path ends at an object', () => {
    const ns = namespace()

    expect(lookup(ns, 'steps.review-codex.output')).toBe(ns.steps['review-codex']?.output)
  })

  it('returns falsy values unchanged when exit_code is 0 and passed is false', () => {
    const ns = namespace({ steps: { lint: shellResult({ exit_code: 0, passed: false }) } })

    expect([lookup(ns, 'steps.lint.exit_code'), lookup(ns, 'steps.lint.passed')]).toEqual([
      0,
      false,
    ])
  })

  it('returns undefined when the first segment does not exist', () => {
    expect(lookup(namespace(), 'ticket')).toBeUndefined()
  })

  it('returns undefined when an optional top-level field is absent', () => {
    expect(lookup(namespace(), 'input_path')).toBeUndefined()
  })

  it('returns undefined when the step id is unknown', () => {
    expect(lookup(namespace(), 'steps.deploy.output')).toBeUndefined()
  })

  it('returns undefined when the field is missing on an existing step', () => {
    expect(lookup(namespace(), 'steps.test.text')).toBeUndefined()
  })

  it('returns undefined when the path continues past a string value', () => {
    expect(lookup(namespace(), 'steps.test.output.length')).toBeUndefined()
  })

  it('returns undefined when a segment names an inherited object property', () => {
    expect(lookup(namespace(), 'steps.constructor')).toBeUndefined()
  })
})

describe('recognizing agent step output maps', () => {
  it('returns true when the value is the output object of an agent step', () => {
    const ns = namespace()

    expect(isOutputMap(ns.steps['review-codex']?.output, ns)).toBe(true)
  })

  it('returns false when the value is an equal copy rather than the stored object', () => {
    const ns = namespace()
    const copy = structuredClone(ns.steps['review-codex']?.output)

    expect(isOutputMap(copy, ns)).toBe(false)
  })

  it('returns false when the value is a parsed object nested inside an output map', () => {
    const ns = namespace()

    expect(isOutputMap(lookup(ns, 'steps.review-codex.output.claude'), ns)).toBe(false)
  })

  it('returns false when an object is the output of a shell step rather than an agent step', () => {
    const shellOutput = { summary: '3 passed' }
    const ns = namespace({ steps: { test: shellResult({ output: shellOutput }) } })

    expect(isOutputMap(shellOutput, ns)).toBe(false)
  })
})
