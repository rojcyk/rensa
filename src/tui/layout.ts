// Row and column budgets for the header / body / footer layout. Pure: the
// same function serves the current terminal width (bounds, clipping) and
// the settled one (wrapping), so the two only ever differ by their input.

/** Below this many columns the left column is dropped (`narrow`). */
export const NARROW_COLUMNS = 60
/** Below this many rows the header and footer collapse to one row each (`short`). */
export const SHORT_ROWS = 10
/** In `short` mode a body with fewer rows than this shows only the status line. */
export const MIN_BODY_ROWS = 3
/** Columns the left column adds to the longest step id (markers and padding). */
const LEFT_ID_PADDING = 6
/** Share of the terminal width the left column may take at most. */
const LEFT_MAX_SHARE = 0.35
/**
 * Columns `Layout` draws before the transcript in two columns: the `│`
 * separator (the right column's left border) and two columns of left
 * padding (one space, one space of indent). No right margin.
 */
export const SPLIT_GUTTER = 3
/**
 * Columns `Layout` draws before the transcript in `narrow` mode: a left
 * indent of two, where the separator's column and the space after it
 * would be. No right margin.
 */
export const SINGLE_GUTTER = 2

/** `both` is `narrow` and `short` at once. */
export type Compact = 'none' | 'narrow' | 'short' | 'both'

export interface LayoutWant {
  headerRows: number
  footerRows: number
  /** The longest step id; given only for a two-column body. */
  leftIdWidth?: number
}

export interface Budget {
  headerRows: number
  bodyRows: number
  footerRows: number
  /** 0 when there is no left column. */
  leftCols: number
  /** The right column, separator included; the whole width when there is no left column. */
  rightCols: number
  /**
   * The width text in the right column wraps and is clipped to: the only
   * definition of the transcript's width. Never below 1.
   */
  transcriptCols: number
  compact: Compact
}

export function isNarrow(columns: number): boolean {
  return columns < NARROW_COLUMNS
}

export function isShort(rows: number): boolean {
  return rows < SHORT_ROWS
}

/**
 * `short` compact mode with a body still under `MIN_BODY_ROWS`: the body
 * shows only the status line. The one place this rule is decided.
 */
export function bodyIsStatusOnly(budget: Budget): boolean {
  const short = budget.compact === 'short' || budget.compact === 'both'
  return short && budget.bodyRows < MIN_BODY_ROWS
}

export function layoutBudget(size: { columns: number; rows: number }, want: LayoutWant): Budget {
  const columns = whole(size.columns)
  const rows = whole(size.rows)
  const narrow = isNarrow(columns)
  const short = isShort(rows)

  const wantHeader = whole(want.headerRows)
  const wantFooter = whole(want.footerRows)
  const headerRows = Math.min(short ? Math.min(wantHeader, 1) : wantHeader, rows)
  const footerRows = Math.min(short ? Math.min(wantFooter, 1) : wantFooter, rows - headerRows)
  const bodyRows = Math.max(0, rows - headerRows - footerRows)

  const split = want.leftIdWidth !== undefined && !narrow
  const leftCols = split
    ? Math.min(whole(want.leftIdWidth ?? 0) + LEFT_ID_PADDING, Math.floor(columns * LEFT_MAX_SHARE))
    : 0
  const rightCols = columns - leftCols
  const transcriptCols = Math.max(1, rightCols - (split ? SPLIT_GUTTER : SINGLE_GUTTER))

  return {
    headerRows,
    bodyRows,
    footerRows,
    leftCols,
    rightCols,
    transcriptCols,
    compact: narrow && short ? 'both' : narrow ? 'narrow' : short ? 'short' : 'none',
  }
}

/** A non-negative integer; anything else reads as 0. */
function whole(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0
}
