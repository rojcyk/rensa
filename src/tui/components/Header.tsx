import { Box, Text } from 'ink'
import type { ReactNode } from 'react'
import { EDGE_INSET, isShort } from '../layout.js'
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
  /** The rensa version, shown on the right as `rensa <version>`. */
  version: string
  /** The open chain, shown after the version as `/ <chain>`. */
  chain?: string
}

/**
 * `⎇ branch (mode)  path` on the left, indented two columns like the
 * screen bodies, `rensa <version> / <chain>` on the right, inset two columns from the edge, a rule
 * below. Follows the current width at once; it wraps nothing. In `short`
 * compact mode the rule is omitted.
 */
export function Header(props: HeaderProps): ReactNode {
  const { branch, mode, path, version, chain } = props
  const { columns, rows } = useSize()
  return (
    <Box flexDirection="column" width={columns}>
      <Box width={columns} paddingX={EDGE_INSET}>
        <Box flexGrow={1} flexShrink={1} overflow="hidden">
          <Text wrap="truncate-end">
            <Text color={theme.text}>⎇ {branch}</Text>
            {mode !== undefined && <Text color={theme.muted}> ({mode})</Text>}
            <Text color={theme.muted}>{`  ${path}`}</Text>
          </Text>
        </Box>
        <Box flexShrink={0} marginLeft={2}>
          <Text wrap="truncate-end">
            <Text color={theme.muted}>{`rensa ${version}`}</Text>
            {chain !== undefined && (
              <>
                <Text color={theme.muted}>{' / '}</Text>
                <Text color={theme.text}>{chain}</Text>
              </>
            )}
          </Text>
        </Box>
      </Box>
      {!isShort(rows) && <Rule width={columns} />}
    </Box>
  )
}
