import {
  type DOMElement,
  measureElement,
  Text,
  useBoxMetrics,
  useCursor,
  usePaste,
  useStdin,
} from 'ink'
import { type ReactNode, useRef } from 'react'
import stringWidth from 'string-width'
import { theme } from '../theme.js'
import { type InputState, insertText } from './editInput.js'
import { Frame } from './Frame.js'

/** Border and padding on each side: the text gets `width − 4` cells. */
const CHROME_COLS = 4
/** Offset of the first text cell from the frame's top-left corner. */
const TEXT_OFFSET = { x: 2, y: 1 }

export interface InputBoxProps {
  state: InputState
  /** A paste, newlines collapsed to spaces, already applied at the caret. */
  onPaste(next: InputState): void
  placeholder?: string
  focused: boolean
  enabled: boolean
  width: number
}

/**
 * A one-row framed text input. Controlled and keyless: the screen owns
 * the state and feeds keys through `editInput` from its `useKeys`; this
 * mounts no useInput. While focused it takes pastes as one string and
 * places the terminal's own cursor at the caret.
 */
export function InputBox(props: InputBoxProps): ReactNode {
  const { state, onPaste, placeholder, focused, enabled, width } = props
  const { isRawModeSupported } = useStdin()
  const frameRef = useRef<DOMElement>(null)
  const metrics = useBoxMetrics(frameRef)
  const { setCursorPosition } = useCursor()

  usePaste((text) => onPaste(insertText(state, text)), {
    isActive: focused && isRawModeSupported,
  })

  const { text: visible, caretCell } = inputWindow(state, Math.max(1, width - CHROME_COLS))

  const frame = frameRef.current
  if (focused && metrics.hasMeasured && frame) {
    const origin = measureElement(frame)
    setCursorPosition({
      x: origin.x + TEXT_OFFSET.x + caretCell,
      y: origin.y + TEXT_OFFSET.y,
    })
  } else {
    setCursorPosition(undefined)
  }

  const showPlaceholder = state.value === '' && placeholder !== undefined
  const color = !enabled ? theme.dim : showPlaceholder ? theme.muted : theme.text
  return (
    <Frame
      ref={frameRef}
      width={width}
      height={3}
      {...(focused && { backgroundColor: theme.selection })}
    >
      <Text color={color} wrap="truncate-end">
        {showPlaceholder ? placeholder : visible}
      </Text>
    </Frame>
  )
}

/**
 * The part of the value shown in a box `cells` terminal cells wide, and
 * the caret's cell within it. Measured in cells, not code points: wide
 * characters take two, zero-width and combining ones none. Scrolls just
 * far enough that the caret's own cell fits after the characters before
 * it, and never splits a character at either edge.
 */
export function inputWindow(state: InputState, cells: number): { text: string; caretCell: number } {
  const chars = Array.from(state.value)
  const widths = chars.map((c) => stringWidth(c))
  const caret = Math.min(Math.max(0, Math.trunc(state.caret)), chars.length)
  const width = Math.max(1, Math.floor(cells))

  // Cells from `first` to the caret, plus one for the caret, must fit.
  let first = 0
  let beforeCaret = sum(widths, 0, caret)
  while (first < caret && beforeCaret + 1 > width) {
    beforeCaret -= widths[first] ?? 0
    first++
  }

  let used = 0
  let end = first
  while (end < chars.length && used + (widths[end] ?? 0) <= width) {
    used += widths[end] ?? 0
    end++
  }
  return { text: chars.slice(first, end).join(''), caretCell: beforeCaret }
}

function sum(values: readonly number[], from: number, to: number): number {
  let total = 0
  for (let i = from; i < to; i++) total += values[i] ?? 0
  return total
}
