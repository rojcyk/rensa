import { Box, Text } from 'ink'
import type { ReactNode } from 'react'
import { isShort } from '../layout.js'
import { useSize } from '../size.js'
import { theme } from '../theme.js'
import { Rule } from './Rule.js'

/** Rows the header asks for: the line and its rule. */
export const HEADER_ROWS = 2

export interface HeaderProps {
  branch: string
  mode?: 'in place'
  /** Home-relative. */
  path: string
  right?: string
}

/**
 * `⎇ branch (mode)  path` on the left, `right` on the right, a rule
 * below. Follows the current width at once; it wraps nothing. In `short`
 * compact mode the rule is omitted.
 */
export function Header(props: HeaderProps): ReactNode {
  const { branch, mode, path, right } = props
  const { columns, rows } = useSize()
  return (
    <Box flexDirection="column" width={columns}>
      <Box width={columns}>
        <Box flexGrow={1} flexShrink={1} overflow="hidden">
          <Text wrap="truncate-end">
            <Text color={theme.text}>⎇ {branch}</Text>
            {mode !== undefined && <Text color={theme.muted}> ({mode})</Text>}
            <Text color={theme.muted}>{`  ${path}`}</Text>
          </Text>
        </Box>
        {right !== undefined && (
          <Box flexShrink={0} marginLeft={2}>
            <Text color={theme.text} wrap="truncate-end">
              {right}
            </Text>
          </Box>
        )}
      </Box>
      {!isShort(rows) && <Rule width={columns} />}
    </Box>
  )
}
