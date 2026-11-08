import { Box, Text } from 'ink'
import type { ReactNode } from 'react'

export interface RowProps {
  children?: ReactNode
  /** Cells; the parent's width when absent. */
  width?: number
  /** Only on a selected row (rule D): fills every cell of the row. */
  backgroundColor?: string
}

/**
 * Exactly one terminal row: content truncates at the row's edge and never
 * wraps into a second. Used only where one-row sizing, truncation or a
 * selection background is needed (step rows, agent-row cells, the strip
 * in `narrow` mode); plain `Box` and `Text` everywhere else.
 */
export function Row(props: RowProps): ReactNode {
  const { children, width, backgroundColor } = props
  return (
    <Box
      height={1}
      flexShrink={0}
      overflow="hidden"
      {...(width !== undefined && { width })}
      {...(backgroundColor !== undefined && { backgroundColor })}
    >
      <Text wrap="truncate">{children}</Text>
    </Box>
  )
}
