import { Text } from 'ink'
import type { ReactNode } from 'react'
import { useSize } from '../size.js'
import { theme } from '../theme.js'

/** A horizontal rule, the terminal's width unless `width` is given. */
export function Rule(props: { width?: number; color?: string }): ReactNode {
  const { columns } = useSize()
  const width = Math.max(0, props.width ?? columns)
  return (
    <Text color={props.color ?? theme.dim} wrap="truncate">
      {'─'.repeat(width)}
    </Text>
  )
}
