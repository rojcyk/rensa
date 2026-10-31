import { assert, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { zodToRensaError } from './issues.js'
import { RawChainSchema } from './types.js'

const FILE = '/home/alice/shop/.rensa/review.yaml'

function errorFor(schema: z.ZodType, doc: unknown): z.ZodError {
  const result = schema.safeParse(doc)
  assert(!result.success, 'expected the schema to reject the document')
  return result.error
}

describe('rendering schema issues as a config error', () => {
  it('joins the path with dots and [n] and prefixes the message when the issue is nested', () => {
    const error = errorFor(RawChainSchema, {
      steps: [{ id: 'review', prompt: 'steps/review.md', agents: ['impl'], vars: { retries: 3 } }],
    })

    const err = zodToRensaError(error, FILE)

    expect(err.code).toBe('CONFIG_INVALID')
    expect(err.path).toBe('steps[0].vars.retries')
    expect(err.message).toBe(
      `${FILE}: steps[0].vars.retries: expected a string, got a number; quote the value`,
    )
    expect(err.details).toEqual([])
  })

  it('reports the first issue as the error and the rest as details when a document has several', () => {
    const error = errorFor(RawChainSchema, {
      name: 42,
      steps: [
        { id: 'lint', run: 'npm run lint', when: 'x' },
        { id: 'test', run: 'npm test', timeout: 30 },
      ],
    })

    const err = zodToRensaError(error, FILE)

    expect(err.path).toBe('name')
    expect(err.message).toBe(`${FILE}: name: Invalid input: expected string, received number`)
    expect(err.details).toEqual([
      `${FILE}: unknown key \`when\` at steps[0]; not supported in this version`,
      `${FILE}: steps[1].timeout: Invalid input: expected string, received number`,
    ])
  })

  it('reports one reserved-key error per key when a mapping has two unknown keys', () => {
    const error = errorFor(RawChainSchema, {
      workspace: 'tmp',
      setup: 'npm ci',
      steps: [{ id: 'lint', run: 'npm run lint' }],
    })

    const err = zodToRensaError(error, FILE)

    expect(err.path).toBe('workspace')
    expect(err.message).toBe(
      `${FILE}: unknown key \`workspace\` at the top level; not supported in this version`,
    )
    expect(err.details).toEqual([
      `${FILE}: unknown key \`setup\` at the top level; not supported in this version`,
    ])
  })

  it('renders the issue without a path prefix when the document root itself is wrong', () => {
    const error = errorFor(z.object({ steps: z.array(z.unknown()) }).strict(), 'not a mapping')

    const err = zodToRensaError(error, FILE)

    expect(err.path).toBe('')
    expect(err.message).toBe(`${FILE}: Invalid input: expected object, received string`)
  })
})
