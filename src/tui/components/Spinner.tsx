import { Text, useAnimation } from 'ink'
import { memo } from 'react'
import { theme } from '../theme.js'

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const
export const SPINNER_FRAME_MS = 80

/**
 * A braille spinner. Its ticks ride Ink's shared animation timer within
 * the `maxFps` budget; as a memoized leaf it is the only thing a tick
 * re-renders.
 */
export const Spinner = memo(function Spinner(props: { color?: string }) {
  const { frame } = useAnimation({ interval: SPINNER_FRAME_MS })
  return <Text color={props.color ?? theme.accent}>{FRAMES[frame % FRAMES.length]}</Text>
})
