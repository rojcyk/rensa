import {
  Box,
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

/**
 * Per presentation: the columns taken besides the text (border and
 * padding on each side for `frame`, padding only for `line`) and the
 * offset of the first text cell from the box's top-left corner.
 */
const CHROME = {
  frame: { cols: 4, offset: { x: 2, y: 1 } },
  line: { cols: 2, offset: { x: 1, y: 0 } },
} as const

export type InputBoxVariant = keyof typeof CHROME

export interface InputBoxProps {
  state: InputState
  /** A paste, newlines collapsed to spaces, already applied at the caret. */
  onPaste(next: InputState): void
  placeholder?: string
  /** Drawn in `muted` before the text, followed by one space; the text scrolls after it. */
  prompt?: string
  focused: boolean
  enabled: boolean
  width: number
  /** Behind the border; `theme.background` in fullscreen (see `Frame`). */
  borderBackgroundColor?: string
  /**
   * `frame` (default): three rows, the text inside a rounded border.
   * `line`: one borderless row, for a footer that `short` compact mode
   * collapses to one row, where a frame would show only its top border.
   */
  variant?: InputBoxVariant
}

/**
 * A one-row text input, framed or as a bare line. Controlled and keyless: the screen owns
 * the state and feeds keys through `editInput` from its `useKeys`; this
 * mounts no useInput. While focused it takes pastes as one string and
 * places the terminal's own cursor at the caret.
 */
export function InputBox(props: InputBoxProps): ReactNode {
  const {
    state,
    onPaste,
    placeholder,
    prompt,
    focused,
    enabled,
    width,
    borderBackgroundColor,
    variant = 'frame',
  } = props
  const chrome = CHROME[variant]
  const { isRawModeSupported } = useStdin()
  const frameRef = useRef<DOMElement>(null)
  const metrics = useBoxMetrics(frameRef)
  const { setCursorPosition } = useCursor()

  usePaste((text) => onPaste(insertText(state, text)), {
    isActive: focused && isRawModeSupported,
  })

  const promptCols = prompt === undefined ? 0 : stringWidth(prompt) + 1
  const { text: visible, caretCell } = inputWindow(
    state,
    Math.max(1, width - chrome.cols - promptCols),
  )

  const frame = frameRef.current
  if (focused && metrics.hasMeasured && frame) {
    const origin = measureElement(frame)
    setCursorPosition({
      x: origin.x + chrome.offset.x + promptCols + caretCell,
      y: origin.y + chrome.offset.y,
    })
  } else {
    setCursorPosition(undefined)
  }

  const showPlaceholder = state.value === '' && placeholder !== undefined
  const color = !enabled ? theme.dim : showPlaceholder ? theme.muted : theme.text
  const content =
    prompt === undefined ? (
      <Text color={color} wrap="truncate-end">
        {showPlaceholder ? placeholder : visible}
      </Text>
    ) : (
      <Text wrap="truncate-end">
        <Text color={enabled ? theme.muted : theme.dim}>{`${prompt} `}</Text>
        <Text color={color}>{showPlaceholder ? placeholder : visible}</Text>
      </Text>
    )
  const background = focused ? { backgroundColor: theme.selection } : {}

  if (variant === 'line') {
    return (
      <Box
        ref={frameRef}
        width={width}
        height={1}
        flexShrink={0}
        paddingX={1}
        overflow="hidden"
        {...background}
      >
        {content}
      </Box>
    )
  }
  return (
    <Frame
      ref={frameRef}
      width={width}
      height={3}
      borderColor={focused ? theme.accent : theme.dim}
      {...background}
      {...(borderBackgroundColor !== undefined && { borderBackgroundColor })}
    >
      {content}
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
