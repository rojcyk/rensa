import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react'
import { type Budget, type LayoutWant, layoutBudget } from './layout.js'

/**
 * A width that has not changed for this long is the one wrapping derives
 * from. About layout stability during a drag, not paint rate: it does not
 * move with the frame rate.
 */
export const SETTLE_MS = 50

export interface Size {
  /** Current bounds: applied immediately to layout and clipping. */
  columns: number
  rows: number
  /** Last width unchanged for `SETTLE_MS`: the only width wrapping derives from. */
  settledColumns: number
}

const SizeContext = createContext<Size>({ columns: 80, rows: 24, settledColumns: 80 })

/**
 * Publishes the window size. `columns` and `rows` come from the one
 * `useWindowSize()` call in `app.tsx` and pass through on the same render;
 * `settledColumns` follows `columns` once it has been still for
 * `SETTLE_MS`. A height-only change never touches it.
 */
export function SizeProvider(props: {
  columns: number
  rows: number
  children: ReactNode
}): ReactNode {
  const { columns, rows, children } = props
  const [settledColumns, setSettledColumns] = useState(columns)

  useEffect(() => {
    if (columns === settledColumns) return
    const timer = setTimeout(() => setSettledColumns(columns), SETTLE_MS)
    return () => clearTimeout(timer)
  }, [columns, settledColumns])

  const size = useMemo(() => ({ columns, rows, settledColumns }), [columns, rows, settledColumns])
  return <SizeContext value={size}>{children}</SizeContext>
}

export function useSize(): Size {
  return useContext(SizeContext)
}

/**
 * The layout budget for the current and for the settled terminal width,
 * from the one `layoutBudget` function: clip at `current`, wrap at
 * `settled`. Memoized on the size and on the fields of `want`, so an
 * inline `want` object does not recompute.
 */
export function useBudget(want: LayoutWant): { current: Budget; settled: Budget } {
  const { columns, rows, settledColumns } = useSize()
  const { headerRows, footerRows, leftIdWidth } = want
  return useMemo(() => {
    const fields: LayoutWant = {
      headerRows,
      footerRows,
      ...(leftIdWidth !== undefined && { leftIdWidth }),
    }
    return {
      current: layoutBudget({ columns, rows }, fields),
      settled: layoutBudget({ columns: settledColumns, rows }, fields),
    }
  }, [columns, rows, settledColumns, headerRows, footerRows, leftIdWidth])
}
