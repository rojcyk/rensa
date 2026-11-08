import { stripVTControlCharacters } from 'node:util'
import { render } from 'ink-testing-library'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { InputState } from './editInput.js'
import { InputBox, inputWindow } from './InputBox.js'

// Colors are part of what `enabled: false` means; force truecolor before
// Ink (and its chalk) load.
const previousForceColor = vi.hoisted(() => {
  const previous = process.env.FORCE_COLOR
  process.env.FORCE_COLOR = '3'
  return previous
})

afterAll(() => {
  if (previousForceColor === undefined) delete process.env.FORCE_COLOR
  else process.env.FORCE_COLOR = previousForceColor
})

const DIM = '\x1b[38;2;92;92;92m' // theme.dim #5c5c5c
const TEXT = '\x1b[38;2;230;230;230m' // theme.text #e6e6e6

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

let unmount: (() => void) | undefined

afterEach(() => {
  unmount?.()
  unmount = undefined
})

const effects = () => new Promise<void>((resolve) => setImmediate(resolve))

function box(props: { state: InputState; focused: boolean; enabled?: boolean; width?: number }) {
  const onPaste = vi.fn<(next: InputState) => void>()
  const view = render(
    <InputBox
      state={props.state}
      onPaste={onPaste}
      focused={props.focused}
      enabled={props.enabled ?? true}
      width={props.width ?? 30}
      placeholder="add a note"
    />,
  )
  unmount = view.unmount
  return { view, onPaste }
}

describe('pasting into the input box', () => {
  it('delivers a multi-line paste as one onPaste with newlines collapsed when focused', async () => {
    const { view, onPaste } = box({ state: { value: '', caret: 0 }, focused: true })
    await effects()

    view.stdin.write(`${PASTE_START}a\nb${PASTE_END}`)
    await effects()

    expect(onPaste.mock.calls).toEqual([[{ value: 'a b', caret: 3 }]])
  })

  it('inserts the paste at the caret when the box already holds text', async () => {
    const { view, onPaste } = box({ state: { value: 'keep API', caret: 5 }, focused: true })
    await effects()

    view.stdin.write(`${PASTE_START}the\npublic ${PASTE_END}`)
    await effects()

    expect(onPaste.mock.calls).toEqual([[{ value: 'keep the public API', caret: 16 }]])
  })

  it('ignores a paste when not focused', async () => {
    const { view, onPaste } = box({ state: { value: '', caret: 0 }, focused: false })
    await effects()

    view.stdin.write(`${PASTE_START}a\nb${PASTE_END}`)
    await effects()

    expect(onPaste).not.toHaveBeenCalled()
  })
})

describe('scrolling a value longer than the box', () => {
  const ALPHABET = 'abcdefghijklmnopqrstuvwxyz'

  it('shows the end of the value with room for the caret when the caret is at the end', () => {
    const { view } = box({ state: { value: ALPHABET, caret: 26 }, focused: true, width: 14 })

    const text = stripVTControlCharacters(view.lastFrame() ?? '').split('\n')[1]

    expect(text).toBe('│ rstuvwxyz  │')
  })

  it('shows the start of the value when the caret is at the start', () => {
    const { view } = box({ state: { value: ALPHABET, caret: 0 }, focused: true, width: 14 })

    const text = stripVTControlCharacters(view.lastFrame() ?? '').split('\n')[1]

    expect(text).toBe('│ abcdefghij │')
  })
})

describe('a disabled input box', () => {
  it('renders the value dim when enabled is false', () => {
    const { view } = box({
      state: { value: 'draft note', caret: 10 },
      focused: false,
      enabled: false,
    })

    expect(view.lastFrame()).toContain(`${DIM}draft note`)
  })

  it('renders the value in the text color when enabled', () => {
    const { view } = box({ state: { value: 'draft note', caret: 10 }, focused: false })

    expect(view.lastFrame()).toContain(`${TEXT}draft note`)
  })
})

describe('the visible window of the value, in terminal cells', () => {
  it('keeps the caret cell inside the window when the caret is at the end of a long ASCII value', () => {
    expect(inputWindow({ value: 'abcdefghij', caret: 10 }, 5)).toEqual({
      text: 'ghij',
      caretCell: 4,
    })
  })

  it('shows the start and puts the caret in cell 0 when the caret is at 0', () => {
    expect(inputWindow({ value: 'abcdefghij', caret: 0 }, 5)).toEqual({
      text: 'abcde',
      caretCell: 0,
    })
  })

  it('shows the whole value when it fits', () => {
    expect(inputWindow({ value: 'note', caret: 2 }, 10)).toEqual({ text: 'note', caretCell: 2 })
  })

  it('counts a wide character as two cells when scrolling to a caret at the end', () => {
    expect(inputWindow({ value: '日本語テキスト', caret: 7 }, 6)).toEqual({
      text: 'スト',
      caretCell: 4,
    })
  })

  it('stops before a wide character that would cross the right edge', () => {
    expect(inputWindow({ value: '日本語テキスト', caret: 0 }, 5)).toEqual({
      text: '日本',
      caretCell: 0,
    })
  })

  it('places the caret after the cells of the wide characters before it', () => {
    expect(inputWindow({ value: '日本語', caret: 2 }, 10)).toEqual({ text: '日本語', caretCell: 4 })
  })

  it('gives a zero-width character no cell', () => {
    expect(inputWindow({ value: 'abc​', caret: 4 }, 4)).toEqual({
      text: 'abc​',
      caretCell: 3,
    })
  })

  it('treats a box narrower than one cell as one cell wide', () => {
    expect(inputWindow({ value: 'abc', caret: 3 }, 0)).toEqual({ text: '', caretCell: 0 })
  })
})

describe('the prompt and the one-row line variant', () => {
  function promptBox(props: {
    state: InputState
    variant?: 'frame' | 'line'
    width?: number
  }): string[] {
    const view = render(
      <InputBox
        state={props.state}
        onPaste={() => {}}
        prompt="›"
        focused
        enabled
        width={props.width ?? 30}
        {...(props.variant !== undefined && { variant: props.variant })}
      />,
    )
    unmount = view.unmount
    return stripVTControlCharacters(view.lastFrame() ?? '')
      .split('\n')
      .map((l) => l.trimEnd())
  }

  it('renders one borderless row with the prompt, a space and the text when variant is line', () => {
    const lines = promptBox({ state: { value: 'fix', caret: 3 }, variant: 'line' })

    expect(lines).toEqual([' › fix'])
  })

  it('renders three framed rows with the prompt before the text when the variant is the default frame', () => {
    const lines = promptBox({ state: { value: 'fix', caret: 3 }, width: 14 })

    expect(lines).toEqual(['╭────────────╮', '│ › fix      │', '╰────────────╯'])
  })

  it('scrolls the text in the cells after the prompt when the value is longer than the box', () => {
    const lines = promptBox({
      state: { value: 'abcdefghijklmnopqrstuvwxyz', caret: 26 },
      width: 14,
    })

    expect(lines[1]).toBe('│ › tuvwxyz  │')
  })
})
