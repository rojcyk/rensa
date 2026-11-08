import type { Key } from 'ink'
import { describe, expect, it } from 'vitest'
import { key } from '../../testing/inkKeys.js'
import { EMPTY_INPUT, editInput, type InputState, insertText } from './editInput.js'

const typed = (input: string) => ({ input, key: key() })
const pressed = (overrides: Partial<Key>) => ({ input: '', key: key(overrides) })

const NOTE: InputState = { value: 'keep the API', caret: 4 }

describe('typing into the input', () => {
  it('inserts a character at the caret and moves the caret after it', () => {
    expect(editInput(NOTE, typed('X'))).toEqual({ value: 'keepX the API', caret: 5 })
  })

  it('inserts at the start when the caret is at 0', () => {
    expect(editInput({ value: 'API', caret: 0 }, typed('the '))).toEqual({
      value: 'the API',
      caret: 4,
    })
  })

  it('appends to an empty input', () => {
    expect(editInput(EMPTY_INPUT, typed('k'))).toEqual({ value: 'k', caret: 1 })
  })

  it('inserts a capital letter that arrives with shift', () => {
    expect(editInput(EMPTY_INPUT, { input: 'K', key: key({ shift: true }) })).toEqual({
      value: 'K',
      caret: 1,
    })
  })

  it('counts a character outside the BMP as one caret step', () => {
    const state = editInput({ value: 'ok', caret: 2 }, typed('🚀'))

    expect(state).toEqual({ value: 'ok🚀', caret: 3 })
    expect(editInput(state, pressed({ backspace: true }))).toEqual({ value: 'ok', caret: 2 })
  })

  it('returns the same object when a ctrl chord arrives', () => {
    expect(editInput(NOTE, { input: 'p', key: key({ ctrl: true }) })).toBe(NOTE)
  })
})

describe('deleting', () => {
  it('removes the character before the caret on backspace', () => {
    expect(editInput(NOTE, pressed({ backspace: true }))).toEqual({
      value: 'kee the API',
      caret: 3,
    })
  })

  it('returns the same object on backspace at the start', () => {
    const start: InputState = { value: 'keep', caret: 0 }

    expect(editInput(start, pressed({ backspace: true }))).toBe(start)
  })

  it('removes the character after the caret on delete and keeps the caret', () => {
    expect(editInput(NOTE, pressed({ delete: true }))).toEqual({ value: 'keepthe API', caret: 4 })
  })

  it('returns the same object on delete at the end', () => {
    const end: InputState = { value: 'keep', caret: 4 }

    expect(editInput(end, pressed({ delete: true }))).toBe(end)
  })
})

describe('moving the caret', () => {
  it('moves one left and one right', () => {
    expect([
      editInput(NOTE, pressed({ leftArrow: true })),
      editInput(NOTE, pressed({ rightArrow: true })),
    ]).toEqual([
      { value: 'keep the API', caret: 3 },
      { value: 'keep the API', caret: 5 },
    ])
  })

  it('returns the same object on left at the start', () => {
    const start: InputState = { value: 'keep', caret: 0 }

    expect(editInput(start, pressed({ leftArrow: true }))).toBe(start)
  })

  it('returns the same object on right at the end', () => {
    const end: InputState = { value: 'keep', caret: 4 }

    expect(editInput(end, pressed({ rightArrow: true }))).toBe(end)
  })

  it('moves to the start on home and to the end on end', () => {
    expect([
      editInput(NOTE, pressed({ home: true })),
      editInput(NOTE, pressed({ end: true })),
    ]).toEqual([
      { value: 'keep the API', caret: 0 },
      { value: 'keep the API', caret: 12 },
    ])
  })

  it('returns the same object on home at the start', () => {
    const start: InputState = { value: 'keep', caret: 0 }

    expect(editInput(start, pressed({ home: true }))).toBe(start)
  })
})

describe('keys that change nothing', () => {
  it.each([
    ['up', { upArrow: true }],
    ['enter', { return: true }],
    ['escape', { escape: true }],
    ['tab', { tab: true }],
  ] satisfies Array<[string, Partial<Key>]>)('returns the same object on %s', (_, overrides) => {
    expect(editInput(NOTE, pressed(overrides))).toBe(NOTE)
  })
})

describe('inserting a paste', () => {
  it('collapses newlines to spaces and moves the caret past the text', () => {
    expect(insertText({ value: 'ab', caret: 1 }, 'x\ny\r\nz')).toEqual({
      value: 'ax y zb',
      caret: 6,
    })
  })

  it('returns the same object when the paste holds only control characters', () => {
    expect(insertText(NOTE, '\x07\x1b')).toBe(NOTE)
  })
})
