import { Box, Text } from 'ink'
import { memo, type ReactNode } from 'react'
import type { Step, StepView } from '../../engine/index.js'
import type { RunState } from '../engineBridge.js'
import { truncateEnd } from '../format.js'
import { type Store, useStore } from '../store.js'
import { theme } from '../theme.js'
import { Row } from './Row.js'

/** Columns before the marker. */
const INDENT = '  '
/** The follow indicator after the running step's id, with its leading space. */
const FOLLOW = ' ⟳'
/** Indent, marker and the space after it. */
const LEAD_COLS = 4

export interface StepListProps {
  store: Store<RunState>
  steps: ReadonlyArray<Step>
  /** The selected step's id: its id in `accent` and the row on `theme.selection`. */
  selected: string | undefined
  /** The selection no longer tracks the running step: mark the running step with `⟳`. */
  detached: boolean
  /** The left column's width, `leftCols` of the layout budget. */
  width: number
}

/** The left column: one row per step, marker and id, each exactly one row. */
export function StepList(props: StepListProps): ReactNode {
  const { store, steps, selected, detached, width } = props
  const views = useStore(store, (s) => s.steps)
  return (
    <Box flexDirection="column" flexShrink={0} width={width}>
      {steps.map((step) => (
        <StepRow
          key={step.id}
          id={step.id}
          view={views.get(step.id)}
          selected={step.id === selected}
          detached={detached}
          width={width}
        />
      ))}
    </Box>
  )
}

const StepRow = memo(function StepRow(props: {
  id: string
  view: StepView | undefined
  selected: boolean
  detached: boolean
  width: number
}) {
  const { id, view, selected, detached, width } = props
  const status = view?.status ?? 'pending'
  const { glyph, color } = marker(status)
  const follow = detached && status === 'running' ? FOLLOW : ''
  const idCols = Math.max(0, width - LEAD_COLS - follow.length)
  return (
    <Row width={width} {...(selected && { backgroundColor: theme.selection })}>
      {INDENT}
      <Text color={color}>{glyph}</Text>{' '}
      <Text color={selected ? theme.accent : theme.text}>{truncateEnd(id, idCols)}</Text>
      {follow !== '' && <Text color={theme.accent}>{follow}</Text>}
    </Row>
  )
})

/**
 * `○` pending, `●` running, `✓` ok, `✗` failed, killed or timed out,
 * `‖` paused before it.
 */
function marker(status: StepView['status']): { glyph: string; color: string } {
  switch (status) {
    case 'pending':
      return { glyph: '○', color: theme.dim }
    case 'running':
      return { glyph: '●', color: theme.accent }
    case 'ok':
      return { glyph: '✓', color: theme.ok }
    case 'failed':
    case 'killed':
    case 'timeout':
      return { glyph: '✗', color: theme.err }
    case 'paused':
      return { glyph: '‖', color: theme.warn }
    default:
      return exhaustive(status)
  }
}

function exhaustive(value: never): never {
  throw new Error(`unhandled step status: ${JSON.stringify(value)}`)
}
