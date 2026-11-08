import { describe, expect, it } from 'vitest'
import { type Budget, bodyIsStatusOnly, type LayoutWant, layoutBudget } from './layout.js'

const RUN_SCREEN: LayoutWant = { headerRows: 2, footerRows: 2, leftIdWidth: 12 }

describe('budgeting rows and columns at normal size', () => {
  it('gives the body rows minus header and footer and no compact mode at 120x40', () => {
    const budget = layoutBudget({ columns: 120, rows: 40 }, RUN_SCREEN)

    expect(budget).toEqual({
      headerRows: 2,
      bodyRows: 36,
      footerRows: 2,
      leftCols: 18,
      rightCols: 102,
      transcriptCols: 99,
      compact: 'none',
    } satisfies Budget)
  })

  it('caps the left column at 35% of the width when the longest id asks for more at 120x40', () => {
    const budget = layoutBudget({ columns: 120, rows: 40 }, { ...RUN_SCREEN, leftIdWidth: 70 })

    expect({ leftCols: budget.leftCols, rightCols: budget.rightCols }).toEqual({
      leftCols: 42,
      rightCols: 78,
    })
  })

  it('gives a left column of 35 when leftIdWidth is 60 at 100 columns', () => {
    const budget = layoutBudget({ columns: 100, rows: 30 }, { ...RUN_SCREEN, leftIdWidth: 60 })

    expect(budget.leftCols).toBe(35)
  })

  it('gives the whole width less the indent to the transcript when there is no left column', () => {
    const budget = layoutBudget({ columns: 100, rows: 30 }, { headerRows: 2, footerRows: 0 })

    expect({ leftCols: budget.leftCols, transcriptCols: budget.transcriptCols }).toEqual({
      leftCols: 0,
      transcriptCols: 98,
    })
  })
})

describe('compact presentation', () => {
  it('drops the left column and widens the transcript to columns - 2 when narrow at 50x24', () => {
    const budget = layoutBudget({ columns: 50, rows: 24 }, RUN_SCREEN)

    expect(budget).toEqual({
      headerRows: 2,
      bodyRows: 20,
      footerRows: 2,
      leftCols: 0,
      rightCols: 50,
      transcriptCols: 48,
      compact: 'narrow',
    } satisfies Budget)
  })

  it('collapses header and footer to one row each when short at 80x8', () => {
    const budget = layoutBudget({ columns: 80, rows: 8 }, RUN_SCREEN)

    expect({
      compact: budget.compact,
      headerRows: budget.headerRows,
      footerRows: budget.footerRows,
      bodyRows: budget.bodyRows,
    }).toEqual({ compact: 'short', headerRows: 1, footerRows: 1, bodyRows: 6 })
  })

  it('is narrow and short at once at 40x6', () => {
    const budget = layoutBudget({ columns: 40, rows: 6 }, RUN_SCREEN)

    expect(budget).toEqual({
      headerRows: 1,
      bodyRows: 4,
      footerRows: 1,
      leftCols: 0,
      rightCols: 40,
      transcriptCols: 38,
      compact: 'both',
    } satisfies Budget)
  })

  it('switches to narrow at 59 columns and not at 60', () => {
    expect([
      layoutBudget({ columns: 60, rows: 30 }, RUN_SCREEN).compact,
      layoutBudget({ columns: 59, rows: 30 }, RUN_SCREEN).compact,
    ]).toEqual(['none', 'narrow'])
  })

  it('switches to short at 9 rows and not at 10', () => {
    expect([
      layoutBudget({ columns: 100, rows: 10 }, RUN_SCREEN).compact,
      layoutBudget({ columns: 100, rows: 9 }, RUN_SCREEN).compact,
    ]).toEqual(['none', 'short'])
  })
})

describe('degenerate sizes', () => {
  it('returns no negative number and a transcript of at least 1 at 1x1', () => {
    const budget = layoutBudget({ columns: 1, rows: 1 }, RUN_SCREEN)

    const numbers = [
      budget.headerRows,
      budget.bodyRows,
      budget.footerRows,
      budget.leftCols,
      budget.rightCols,
    ]
    expect(numbers.filter((n) => n < 0)).toEqual([])
    expect(budget.transcriptCols).toBe(1)
  })

  it.each([
    [1, 1],
    [40, 2],
    [80, 0],
    [120, 3],
  ])('never lets header, body and footer exceed %i columns x %i rows', (columns, rows) => {
    const budget = layoutBudget({ columns, rows }, { headerRows: 4, footerRows: 3 })

    expect(budget.headerRows + budget.bodyRows + budget.footerRows).toBeLessThanOrEqual(rows)
    expect(Math.min(budget.headerRows, budget.bodyRows, budget.footerRows)).toBeGreaterThanOrEqual(
      0,
    )
  })
})

describe('the status-only body in short mode', () => {
  it('shows only the status line when short and the body would be under 3 rows', () => {
    const budget = layoutBudget({ columns: 80, rows: 4 }, RUN_SCREEN)

    expect({ bodyRows: budget.bodyRows, statusOnly: bodyIsStatusOnly(budget) }).toEqual({
      bodyRows: 2,
      statusOnly: true,
    })
  })

  it('shows the body when short and the body has exactly 3 rows', () => {
    const budget = layoutBudget({ columns: 80, rows: 5 }, RUN_SCREEN)

    expect({ bodyRows: budget.bodyRows, statusOnly: bodyIsStatusOnly(budget) }).toEqual({
      bodyRows: 3,
      statusOnly: false,
    })
  })

  it('shows the status line only when both narrow and short leave the body under 3 rows', () => {
    const budget = layoutBudget({ columns: 40, rows: 3 }, RUN_SCREEN)

    expect(bodyIsStatusOnly(budget)).toBe(true)
  })

  it('shows the body when not short even if large header and footer leave it under 3 rows', () => {
    const budget = layoutBudget({ columns: 80, rows: 10 }, { headerRows: 5, footerRows: 4 })

    expect({ bodyRows: budget.bodyRows, statusOnly: bodyIsStatusOnly(budget) }).toEqual({
      bodyRows: 1,
      statusOnly: false,
    })
  })
})
