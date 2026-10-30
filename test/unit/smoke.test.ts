import { describe, expect, it } from 'vitest'
import { RensaError } from '../../src/engine/errors.js'

describe('RensaError', () => {
  it('carries code and message', () => {
    const err = new RensaError('CHAIN_NOT_FOUND', 'no chain named review')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('RensaError')
    expect(err.code).toBe('CHAIN_NOT_FOUND')
    expect(err.message).toBe('no chain named review')
    expect(err.path).toBeUndefined()
    expect(err.hint).toBeUndefined()
  })
})
