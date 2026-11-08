import { type Key, useInput, useStdin } from 'ink'

// The one useInput per screen. Ink's useInput has no exclusive capture:
// every active hook receives every key. So a screen mounts exactly one,
// through this hook, and routes by a focus value it owns; an app-level
// overlay mounts its own while the screen's is given `active: false`.

export const ACTIONS = [
  'up',
  'down',
  'left',
  'right',
  'pageUp',
  'pageDown',
  'top',
  'bottom',
  'enter',
  'esc',
  'follow',
  'pause',
  'kill',
  'quit',
  'recheck',
] as const
export type Action = (typeof ACTIONS)[number]

/** Who receives keys inside a screen: navigation, its input box, or a y/n line. */
export type Focus = 'main' | 'input' | 'confirm'

export interface RawKey {
  input: string
  key: Key
}

export type KeyHandler = (action: Action | 'text', raw: RawKey) => void

/** Control chords: `ctrl+<letter>` → action. */
const CHORDS: Readonly<Record<string, Action>> = {
  f: 'follow',
  p: 'pause',
  x: 'kill',
  c: 'quit',
  r: 'recheck',
}

/**
 * Maps every key to a named action, or `'text'` with the raw key for the
 * editing reducer. Key handlers run synchronously and never await (see
 * step 11, "Input priority over streams").
 */
export function useKeys(handler: KeyHandler, opts: { active: boolean }): void {
  // Without a TTY on stdin there is no raw mode, and Ink throws when a
  // hook asks for it; such a session renders but takes no keys.
  const { isRawModeSupported } = useStdin()
  useInput(
    (input, key) => {
      if (key.eventType === 'release') return
      handler(toAction(input, key), { input, key })
    },
    { isActive: opts.active && isRawModeSupported },
  )
}

/** The action a key maps to, or `'text'`. */
export function toAction(input: string, key: Key): Action | 'text' {
  if (key.shift) {
    if (key.upArrow) return 'pageUp'
    if (key.downArrow) return 'pageDown'
    if (key.leftArrow) return 'top'
    if (key.rightArrow) return 'bottom'
  }
  if (key.upArrow) return 'up'
  if (key.downArrow) return 'down'
  if (key.leftArrow) return 'left'
  if (key.rightArrow) return 'right'
  // `fn` + arrows arrive as page keys.
  if (key.pageUp) return 'pageUp'
  if (key.pageDown) return 'pageDown'
  if (key.return) return 'enter'
  if (key.escape) return 'esc'
  if (key.ctrl && !key.meta) {
    const chord = CHORDS[input.toLowerCase()]
    if (chord !== undefined) return chord
  }
  return 'text'
}
