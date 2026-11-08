import { Box } from 'ink'
import type { ReactNode } from 'react'
import { bodyIsStatusOnly, isNarrow, SINGLE_GUTTER, SPLIT_GUTTER } from '../layout.js'
import { useBudget, useSize } from '../size.js'
import type { Mode } from '../terminalSession.js'
import { theme } from '../theme.js'

export interface LayoutProps {
  mode: Mode
  header: ReactNode
  /** Rows the header asks for; `short` compact mode collapses it to one. */
  headerRows: number
  /** The body, or the right column when `split` is given. */
  body?: ReactNode
  footer?: ReactNode
  /** Rows the footer asks for; `short` compact mode collapses it to one. */
  footerRows?: number
  /**
   * A two-column body: `left` beside `body`. The left column's width is a
   * budget from `leftIdWidth` (the longest step id); content wider than it
   * is clipped, so ids should render `wrap="truncate"`. Below the `narrow`
   * width the left column is dropped and `strip` shows above the body.
   * Either way Layout draws the whole gutter: the body's box is exactly
   * the budget's `transcriptCols` wide and needs no indent of its own.
   */
  split?: { left: ReactNode; leftIdWidth: number; strip?: ReactNode }
  /**
   * The screen's status line. In `short` compact mode, when the body would
   * be under `MIN_BODY_ROWS`, the body region shows only this (or nothing
   * when it is absent) instead of `body` and `split`.
   */
  status?: ReactNode
}

/**
 * Header, body and footer with row budgets from `layoutBudget`, applied
 * on the same frame as a resize. Fullscreen takes exactly the window's
 * rows; inline takes what it needs up to the window's rows. Every region
 * clips its content.
 */
export function Layout(props: LayoutProps): ReactNode {
  const { mode, header, headerRows, body, footer, footerRows = 0, split, status } = props
  const { columns, rows } = useSize()
  const budget = useBudget({
    headerRows,
    footerRows: footer === undefined ? 0 : footerRows,
    ...(split && { leftIdWidth: split.leftIdWidth }),
  }).current
  const rowsOf = (n: number) => (mode === 'fullscreen' ? { height: n } : { maxHeight: n })

  return (
    <Box flexDirection="column" width={columns} overflow="hidden" {...rowsOf(rows)}>
      {budget.headerRows > 0 && (
        <Box
          flexDirection="column"
          flexShrink={0}
          height={budget.headerRows}
          width={columns}
          overflow="hidden"
        >
          <Natural>{header}</Natural>
        </Box>
      )}
      <Box flexShrink={0} width={columns} overflow="hidden" {...rowsOf(budget.bodyRows)}>
        {bodyIsStatusOnly(budget) ? (
          <Box flexDirection="column" width={columns} overflow="hidden">
            <Natural>{status}</Natural>
          </Box>
        ) : split === undefined ? (
          <Box flexDirection="column" width={columns} overflow="hidden">
            <Natural>{body}</Natural>
          </Box>
        ) : isNarrow(columns) ? (
          <Box flexDirection="column" width={columns} overflow="hidden">
            {split.strip !== undefined && (
              <Box flexShrink={0} height={1} overflow="hidden">
                <Natural>{split.strip}</Natural>
              </Box>
            )}
            {/* Content width: columns − SINGLE_GUTTER, the budget's transcriptCols. */}
            <Box
              flexDirection="column"
              width={columns}
              paddingLeft={SINGLE_GUTTER}
              overflow="hidden"
            >
              <Natural>{body}</Natural>
            </Box>
          </Box>
        ) : (
          <>
            <Box flexDirection="column" flexShrink={0} width={budget.leftCols} overflow="hidden">
              <Natural>{split.left}</Natural>
            </Box>
            <Box
              flexDirection="column"
              flexShrink={0}
              width={budget.rightCols}
              overflow="hidden"
              borderStyle="single"
              borderTop={false}
              borderRight={false}
              borderBottom={false}
              borderColor={theme.dim}
              // `backgroundColor` excludes border cells: in fullscreen the separator takes the root fill (rule D).
              {...(mode === 'fullscreen' && { borderBackgroundColor: theme.background })}
              // The border is the gutter's first column; content width is
              // rightCols − SPLIT_GUTTER, the budget's transcriptCols.
              paddingLeft={SPLIT_GUTTER - 1}
            >
              <Natural>{body}</Natural>
            </Box>
          </>
        )}
      </Box>
      {budget.footerRows > 0 && footer !== undefined && (
        <Box
          flexDirection="column"
          flexShrink={0}
          height={budget.footerRows}
          width={columns}
          overflow="hidden"
        >
          <Natural>{footer}</Natural>
        </Box>
      )}
    </Box>
  )
}

/**
 * Slot content at its natural height. Ink gives every Box and Text
 * `flexShrink: 1`, so content taller than a fixed-height slot would be
 * squeezed and drawn over itself; inside this non-shrinking column it
 * keeps its rows, and the slot's `overflow="hidden"` cuts it off at the
 * budget, top-aligned.
 */
function Natural(props: { children?: ReactNode }): ReactNode {
  return (
    <Box flexDirection="column" flexShrink={0}>
      {props.children}
    </Box>
  )
}
