import { assert, describe, expect, it } from 'vitest'
import { RensaError } from '../errors.js'
import type { Namespace, StepResult } from './namespace.js'
import { findPlaceholders, render } from './render.js'

function catchRensa(fn: () => unknown): RensaError {
  try {
    fn()
  } catch (err) {
    assert(err instanceof RensaError, `expected RensaError, got ${String(err)}`)
    return err
  }
  throw new Error('expected a RensaError, but nothing was thrown')
}

function namespace(steps: Record<string, StepResult> = {}): Namespace {
  return { base: 'main', run_id: '20261031-142233-review', steps }
}

const REVIEW: StepResult = {
  kind: 'agent',
  output: {
    claude: 'The coupon is applied twice when the cart is empty.',
    codex: { verdict: 'fail', issues: ['double discount'] },
  },
  text: 'The coupon is applied twice when the cart is empty.',
}

const REVIEW_SECTIONS =
  '### claude\n\nThe coupon is applied twice when the cart is empty.\n\n' +
  '### codex\n\n{\n  "verdict": "fail",\n  "issues": [\n    "double discount"\n  ]\n}'

const TEST: StepResult = {
  kind: 'shell',
  output: 'FAIL src/cart.test.ts\n',
  passed: false,
  exit_code: 1,
}

describe('placeholder syntax', () => {
  it('leaves single braces untouched when they surround text', () => {
    const template = 'Return `{ base }` or `{base}` as JSON like {"ref": "{{base}}"}.'

    expect(render(template, {}, namespace())).toBe(
      'Return `{ base }` or `{base}` as JSON like {"ref": "main"}.',
    )
  })

  it('resolves the name when whitespace surrounds it inside the braces', () => {
    expect(render('Diff against {{  base  }} in run {{\trun_id }}.', {}, namespace())).toBe(
      'Diff against main in run 20261031-142233-review.',
    )
  })

  it('leaves the text untouched when the name starts with a digit', () => {
    expect(render('Keep {{1st}} as is.', {}, namespace())).toBe('Keep {{1st}} as is.')
  })
})

describe('resolving placeholder values', () => {
  it('uses the evaluated var when a var and a namespace field share a name', () => {
    expect(render('Base: {{base}}', { base: 'release/2.4' }, namespace())).toBe('Base: release/2.4')
  })

  it('falls back to the namespace when no var has the name', () => {
    const ns = namespace({ test: TEST })

    expect(render('Exit code {{steps.test.exit_code}}', { diff: '' }, ns)).toBe('Exit code 1')
  })

  it('resolves a step id that contains a hyphen when the path names it', () => {
    const ns = namespace({ 'review-codex': REVIEW })

    expect(render('{{steps.review-codex.text}}', {}, ns)).toBe(
      'The coupon is applied twice when the cart is empty.',
    )
  })

  it('throws a TEMPLATE error naming the placeholder when it resolves to nothing', () => {
    const err = catchRensa(() => render('Ticket: {{ticket_id}}', {}, namespace()))

    expect([err.code, err.message]).toEqual(['TEMPLATE', expect.stringContaining('{{ticket_id}}')])
  })

  it('throws a TEMPLATE error when a var is present but its value is undefined', () => {
    const err = catchRensa(() => render('{{diff}}', { diff: undefined }, namespace()))

    expect([err.code, err.message]).toEqual(['TEMPLATE', expect.stringContaining('{{diff}}')])
  })
})

describe('converting values to text', () => {
  it('inserts a string as is when the value is text', () => {
    const ns = namespace({ test: TEST })

    expect(render('Output:\n{{steps.test.output}}', {}, ns)).toBe(
      'Output:\nFAIL src/cart.test.ts\n',
    )
  })

  it('uses String() when the value is a number or a boolean', () => {
    expect(render('{{retries}} {{passed}}', { retries: 3, passed: false }, namespace())).toBe(
      '3 false',
    )
  })

  it('renders labelled sections when the value is an agent step output map', () => {
    const ns = namespace({ review: REVIEW })

    expect(render('{{steps.review.output}}', {}, ns)).toBe(REVIEW_SECTIONS)
  })

  it('renders labelled sections when a var holds the same output map object', () => {
    const ns = namespace({ review: REVIEW })

    expect(render('{{review}}', { review: REVIEW.output }, ns)).toBe(REVIEW_SECTIONS)
  })

  it('renders pretty JSON when the value is a parsed object inside an output map', () => {
    const ns = namespace({ review: REVIEW })

    expect(render('{{steps.review.output.codex}}', {}, ns)).toBe(
      '{\n  "verdict": "fail",\n  "issues": [\n    "double discount"\n  ]\n}',
    )
  })

  it('renders pretty JSON when the value is an object that is not an output map', () => {
    const value = { owner: 'alice', labels: ['billing'] }

    expect(render('{{ticket}}', { ticket: value }, namespace())).toBe(
      '{\n  "owner": "alice",\n  "labels": [\n    "billing"\n  ]\n}',
    )
  })
})

describe('finding placeholders in a template', () => {
  it('returns each name once in order of first use when names repeat', () => {
    const template = 'Diff {{diff}} vs {{ base }}; again {{diff}}; tests {{steps.test.output}}'

    expect(findPlaceholders(template)).toEqual(['diff', 'base', 'steps.test.output'])
  })

  it('returns an empty list when the template has only single braces', () => {
    expect(findPlaceholders('function f() { return { ok: true } }')).toEqual([])
  })
})
