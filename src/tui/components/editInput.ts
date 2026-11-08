import type { Key } from 'ink'

// The pure editing reducer behind InputBox. The caret counts code points,
// so a character outside the BMP is one step, never half of one.

export interface InputState {
  value: string
  /** Code-point index, 0..length. */
  caret: number
}

export const EMPTY_INPUT: InputState = { value: '', caret: 0 }

/**
 * Applies one key: printable characters insert at the caret; backspace,
 * delete, left/right, home/end edit and move. Returns the same object when
 * the key changes nothing.
 */
export function editInput(state: InputState, raw: { input: string; key: Key }): InputState {
  const { input, key } = raw
  const chars = Array.from(state.value)
  const caret = clamp(state.caret, chars.length)

  if (key.backspace) {
    if (caret === 0) return state
    chars.splice(caret - 1, 1)
    return { value: chars.join(''), caret: caret - 1 }
  }
  if (key.delete) {
    if (caret === chars.length) return state
    chars.splice(caret, 1)
    return { value: chars.join(''), caret }
  }
  if (key.leftArrow) return moveTo(state, caret - 1, chars.length)
  if (key.rightArrow) return moveTo(state, caret + 1, chars.length)
  if (key.home) return moveTo(state, 0, chars.length)
  if (key.end) return moveTo(state, chars.length, chars.length)
  if (isTypedText(raw)) return insertText(state, input)
  return state
}

/**
 * Inserts `text` at the caret, newlines collapsed to spaces and other
 * control characters dropped; the caret ends after it. Returns the same
 * object when nothing is left to insert. Used for typing and for pastes.
 */
export function insertText(state: InputState, text: string): InputState {
  const inserted = Array.from(text.replace(/\r\n|\r|\n/g, ' ')).filter((c) => !isControl(c))
  if (inserted.length === 0) return state
  const chars = Array.from(state.value)
  const caret = clamp(state.caret, chars.length)
  chars.splice(caret, 0, ...inserted)
  return { value: chars.join(''), caret: caret + inserted.length }
}

/**
 * A key that types text: printable input with no ctrl or meta. Shift is
 * allowed, since Ink reports it for capitals.
 */
export function isTypedText(raw: { input: string; key: Key }): boolean {
  const { input, key } = raw
  if (input === '' || key.ctrl || key.meta || key.escape || key.return || key.tab) return false
  return Array.from(input).every((c) => !isControl(c))
}

/** One printable character with no modifier: what moves focus into an input box. */
export function isTypedCharacter(raw: { input: string; key: Key }): boolean {
  return isTypedText(raw) && Array.from(raw.input).length === 1
}

function moveTo(state: InputState, caret: number, length: number): InputState {
  const next = clamp(caret, length)
  return next === state.caret ? state : { value: state.value, caret: next }
}

function clamp(caret: number, length: number): number {
  return Math.min(Math.max(0, Math.trunc(caret)), length)
}

/** C0 controls and DEL. */
function isControl(c: string): boolean {
  const code = c.codePointAt(0) ?? 0
  return code < 0x20 || code === 0x7f
}
