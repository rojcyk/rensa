import { Box, type Key, Text } from 'ink'
import { render } from 'ink-testing-library'
import { type ReactNode, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { key } from '../../testing/inkKeys.js'
import {
  EMPTY_INPUT,
  editInput,
  type InputState,
  isTypedCharacter,
} from '../components/editInput.js'
import { InputBox } from '../components/InputBox.js'
import { type Action, type Focus, toAction, useKeys } from './useKeys.js'

// Every mounted useInput, with whether it is active: Ink's useInput is
// wrapped, not replaced, so keys still flow through it.
const hooks = vi.hoisted(() => new Map<object, boolean>())
vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>()
  const React = await import('react')
  return {
    ...actual,
    useInput: (...args: Parameters<typeof actual.useInput>) => {
      const id = React.useRef({}).current
      hooks.set(id, args[1]?.isActive !== false)
      React.useEffect(
        () => () => {
          hooks.delete(id)
        },
        [id],
      )
      actual.useInput(...args)
    },
  }
})

const KEYS = {
  left: '\x1b[D',
  enter: '\r',
  esc: '\x1b',
  ctrlP: '\x10',
} as const

const CONTROL_CHORDS = new Set<Action | 'text'>(['follow', 'pause', 'kill', 'quit', 'recheck'])

interface ScreenProbe {
  actions: Array<Action | 'text'>
  submits: string[]
  overlayKeys: string[]
}

/**
 * A screen as the step specifies it: one useKeys routed by its own focus,
 * an InputBox that mounts no useInput, and an app-level overlay that,
 * while shown, holds the only active useKeys.
 */
function NoteScreen(props: { probe: ScreenProbe; overlay: boolean }): ReactNode {
  const { probe, overlay } = props
  const [focus, setFocus] = useState<Focus>('main')
  const [input, setInput] = useState<InputState>(EMPTY_INPUT)
  useKeys(
    (action, raw) => {
      if (focus === 'input') {
        if (action === 'esc') setFocus('main')
        else if (action === 'enter') probe.submits.push(input.value)
        else if (CONTROL_CHORDS.has(action)) probe.actions.push(action)
        else setInput((s) => editInput(s, raw))
        return
      }
      if (action === 'text' && isTypedCharacter(raw)) {
        setFocus('input')
        setInput((s) => editInput(s, raw))
        return
      }
      probe.actions.push(action)
    },
    { active: !overlay },
  )
  return (
    <Box flexDirection="column">
      <Text>{`focus ${focus} caret ${input.caret}`}</Text>
      <InputBox
        state={input}
        onPaste={setInput}
        focused={focus === 'input'}
        enabled={true}
        width={30}
      />
      {overlay && <QuitOverlay probe={probe} />}
    </Box>
  )
}

function QuitOverlay(props: { probe: ScreenProbe }): ReactNode {
  useKeys(
    (action, raw) => {
      if (action === 'text') props.probe.overlayKeys.push(raw.input)
    },
    { active: true },
  )
  return <Text>abort the run? y/n</Text>
}

let unmount: (() => void) | undefined

beforeEach(() => {
  hooks.clear()
})

afterEach(() => {
  unmount?.()
  unmount = undefined
})

const effects = () => new Promise<void>((resolve) => setImmediate(resolve))

function mountScreen(overlay = false) {
  const probe: ScreenProbe = { actions: [], submits: [], overlayKeys: [] }
  const view = render(<NoteScreen probe={probe} overlay={overlay} />)
  unmount = view.unmount
  const press = async (input: string) => {
    view.stdin.write(input)
    await effects()
  }
  const frame = () => view.lastFrame() ?? ''
  return { probe, view, press, frame }
}

describe('keys in main focus', () => {
  it('gives left to the screen as an action and leaves the input unchanged', async () => {
    const { probe, press, frame } = mountScreen()
    await effects()

    await press(KEYS.left)

    expect(probe.actions).toEqual(['left'])
    expect(frame()).toContain('focus main caret 0')
  })

  it('moves focus to input and inserts the character when a printable key arrives', async () => {
    const { probe, press, frame } = mountScreen()
    await effects()

    await press('k')

    expect(probe.actions).toEqual([])
    expect(frame()).toContain('focus input caret 1')
    expect(frame()).toContain('│ k')
  })
})

describe('keys in input focus', () => {
  it('moves the caret on left and does not call the screen left handler', async () => {
    const { probe, press, frame } = mountScreen()
    await effects()
    await press('k')
    await press('e')

    await press(KEYS.left)

    expect(probe.actions).toEqual([])
    expect(frame()).toContain('focus input caret 1')
  })

  it('calls the submit path exactly once on enter', async () => {
    const { probe, press } = mountScreen()
    await effects()
    await press('o')
    await press('k')

    await press(KEYS.enter)

    expect(probe.submits).toEqual(['ok'])
  })

  it('lets ctrl+p reach the screen as pause and leaves the text alone', async () => {
    const { probe, press, frame } = mountScreen()
    await effects()
    await press('o')

    await press(KEYS.ctrlP)

    expect(probe.actions).toEqual(['pause'])
    expect(frame()).toContain('focus input caret 1')
  })

  it('returns to main without the screen esc action and keeps the text on esc', async () => {
    const { probe, press, frame } = mountScreen()
    await effects()
    await press('o')
    await press('k')

    await press(KEYS.esc)
    await vi.waitFor(() => expect(frame()).toContain('focus main'), { timeout: 1_000 })

    expect(probe.actions).toEqual([])
    expect(frame()).toContain('│ ok')
  })
})

describe('an app-level overlay', () => {
  it('gives y only to the overlay and leaves the input text unchanged', async () => {
    const { probe, view, press, frame } = mountScreen()
    await effects()
    await press('o')
    await press('k')
    view.rerender(<NoteScreen probe={probe} overlay={true} />)
    await effects()

    await press('y')

    expect(probe.overlayKeys).toEqual(['y'])
    expect(probe.actions).toEqual([])
    expect(frame()).toContain('│ ok ')
    expect(frame()).toContain('focus input caret 2')
  })
})

describe('useInput hooks mounted', () => {
  it('mounts exactly one useInput for a screen with an InputBox', async () => {
    mountScreen()
    await effects()

    expect([...hooks.values()]).toEqual([true])
  })

  it('has exactly one active useInput when the overlay is mounted over the screen', async () => {
    mountScreen(true)
    await effects()

    expect([...hooks.values()].sort()).toEqual([false, true])
  })
})

describe('mapping raw keys to actions', () => {
  it.each([
    ['up', key({ upArrow: true }), 'up'],
    ['down', key({ downArrow: true }), 'down'],
    ['left', key({ leftArrow: true }), 'left'],
    ['right', key({ rightArrow: true }), 'right'],
    ['shift+up', key({ shift: true, upArrow: true }), 'pageUp'],
    ['shift+down', key({ shift: true, downArrow: true }), 'pageDown'],
    ['shift+left', key({ shift: true, leftArrow: true }), 'top'],
    ['shift+right', key({ shift: true, rightArrow: true }), 'bottom'],
    ['page up (fn+up)', key({ pageUp: true }), 'pageUp'],
    ['page down (fn+down)', key({ pageDown: true }), 'pageDown'],
    ['enter', key({ return: true }), 'enter'],
    ['escape', key({ escape: true }), 'esc'],
  ] satisfies Array<[string, Key, Action]>)('maps %s to its action', (_, k, action) => {
    expect(toAction('', k)).toBe(action)
  })

  it.each([
    ['f', 'follow'],
    ['p', 'pause'],
    ['x', 'kill'],
    ['c', 'quit'],
    ['r', 'recheck'],
  ] satisfies Array<[string, Action]>)('maps ctrl+%s to %s', (input, action) => {
    expect(toAction(input, key({ ctrl: true }))).toBe(action)
  })

  it.each([
    ['a printable character', 'k', key()],
    ['a ctrl chord with no action', 'a', key({ ctrl: true })],
    ['backspace', '', key({ backspace: true })],
    ['home', '', key({ home: true })],
  ])('maps %s to text', (_, input, k) => {
    expect(toAction(input, k)).toBe('text')
  })
})
