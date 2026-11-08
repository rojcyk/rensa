import { Box, type DOMElement } from 'ink'
import type { ReactNode, Ref } from 'react'
import { theme } from '../theme.js'

export interface FrameProps {
  ref?: Ref<DOMElement>
  children?: ReactNode
  width?: number
  height?: number
  borderColor?: string
  /** Only on a selected or focused panel (step 14, rule D). */
  backgroundColor?: string
}

/** The rounded box: one column of content, one space of padding on each side. */
export function Frame(props: FrameProps): ReactNode {
  const { ref, children, width, height, borderColor = theme.dim, backgroundColor } = props
  return (
    <Box
      ref={ref}
      borderStyle="round"
      borderColor={borderColor}
      flexDirection="column"
      paddingX={1}
      {...(width !== undefined && { width })}
      {...(height !== undefined && { height })}
      {...(backgroundColor !== undefined && { backgroundColor })}
    >
      {children}
    </Box>
  )
}
