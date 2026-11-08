import { Box, Text } from 'ink'
import { memo, type ReactNode, type Ref, useImperativeHandle, useReducer, useRef } from 'react'
import type { StepView } from '../../engine/index.js'
import { type RunView, transcriptKey } from '../engineBridge.js'
import type { LayoutWant } from '../layout.js'
import { useBudget } from '../size.js'
import { useStore } from '../store.js'
import { theme } from '../theme.js'
import { type TrailerLine, TranscriptViewport, type VisibleRow } from '../viewport.js'
import { Row } from './Row.js'

export type ScrollAction = 'pageUp' | 'pageDown' | 'top' | 'bottom'

/** What the run screen's key handler asks of the pane. Every call repaints synchronously. */
export interface TranscriptControls {
  /** `pageUp`/`pageDown` move half a pane; `top` detaches at the start; `bottom` reattaches. */
  scroll(action: ScrollAction): void
  /** Reattaches the viewport of `(step, label)`, creating it if the pane has not shown it yet. */
  follow(step: string, label: string): void
  /** The tool records with a line in the window, top to bottom. */
  toolsInView(): number[]
}

export interface TranscriptProps {
  view: RunView
  step: string
  label: string
  height: number
  /** `current.transcriptCols`: the width the pane is drawn and clipped at. */
  width: number
  /** Tool records shown expanded. */
  expanded: ReadonlySet<number>
  /** The record the tool cursor is on. */
  cursor?: number
  /**
   * The screen's layout want, for `useBudget`: the viewport wraps at
   * `settled.transcriptCols` of the same budget `width` comes from.
   */
  want: LayoutWant
  ref?: Ref<TranscriptControls>
}

/** One viewport per transcript, kept while the pane is mounted so returning to a step keeps its place. */
interface Pane {
  viewport: TranscriptViewport
  /** The `transcriptVersions` value last synced. */
  version: number | undefined
  expanded: ReadonlySet<number>
}

/**
 * The selected step's transcript: mounts exactly the rows
 * `TranscriptViewport.visible(height)` returns, one memoized row per
 * record. Syncs the model on each version bump of its key, and rewraps
 * only when the settled `transcriptCols` changes; until then rows are
 * clipped, not rewrapped.
 */
export function Transcript(props: TranscriptProps): ReactNode {
  const { view, step, label, height, width, expanded, cursor, want, ref } = props
  const key = transcriptKey(step, label)
  const version = useStore(view.store, (s) => s.transcriptVersions.get(key))
  const stepView = useStore(view.store, (s) => s.steps.get(step))
  const wrapWidth = useBudget(want).settled.transcriptCols
  const [, repaint] = useReducer((n: number) => n + 1, 0)

  const panes = useRef<{ view: RunView; byKey: Map<string, Pane> } | null>(null)
  if (panes.current?.view !== view) panes.current = { view, byKey: new Map() }
  const byKey = panes.current.byKey
  const paneFor = (paneStep: string, paneLabel: string): Pane => {
    const paneKey = transcriptKey(paneStep, paneLabel)
    let pane = byKey.get(paneKey)
    if (pane === undefined) {
      const buffer = view.transcript(paneStep, paneLabel)
      pane = {
        viewport: new TranscriptViewport(buffer, { width: wrapWidth, capacity: buffer.capacity }),
        version: undefined,
        expanded: new Set(),
      }
      byKey.set(paneKey, pane)
    }
    return pane
  }

  const pane = paneFor(step, label)
  const { viewport } = pane
  if (viewport.width !== wrapWidth) viewport.setWidth(wrapWidth)
  if (pane.version !== version) {
    pane.version = version
    viewport.sync()
    viewport.setPartial(view.partial(step, label))
  }
  if (pane.expanded !== expanded) {
    for (const record of pane.expanded)
      if (!expanded.has(record)) viewport.setExpanded(record, false)
    for (const record of expanded)
      if (!pane.expanded.has(record)) viewport.setExpanded(record, true)
    pane.expanded = expanded
  }
  viewport.setTrailer(
    trailerFor(stepView, label === 'shell' ? undefined : view.agentDir(step, label)),
  )

  const rows = viewport.visible(height)
  // The key handler reads the latest frame through this, never a stale closure.
  const latest = useRef({ rows, height, viewport, paneFor })
  latest.current = { rows, height, viewport, paneFor }

  useImperativeHandle(
    ref,
    () => ({
      scroll(action) {
        const { viewport: target, height: rowsTall } = latest.current
        const half = Math.floor(rowsTall / 2)
        if (action === 'pageUp') target.scrollBy(-half)
        else if (action === 'pageDown') target.scrollBy(half)
        else target.scrollTo(action)
        repaint()
      },
      follow(followStep, followLabel) {
        latest.current.paneFor(followStep, followLabel).viewport.follow()
        repaint()
      },
      toolsInView() {
        return latest.current.rows.filter((r) => r.kind === 'tool').map((r) => r.record)
      },
    }),
    [],
  )

  const notStarted =
    (stepView === undefined || stepView.status === 'pending' || stepView.status === 'paused') &&
    rows.length === 0

  return (
    <Box flexDirection="column" flexShrink={0} width={width} height={height} overflow="hidden">
      {notStarted ? (
        <Text color={theme.dim} wrap="truncate">
          not started
        </Text>
      ) : (
        rows.map((row) => (
          <TranscriptRow key={row.record} row={row} cursor={row.record === cursor} width={width} />
        ))
      )}
    </Box>
  )
}

/** A failed agent's error, then where its transcript is; nothing otherwise. */
function trailerFor(step: StepView | undefined, agentDir: string | undefined): TrailerLine[] {
  const agent = step?.agent
  if (agent === undefined || agentDir === undefined) return NO_TRAILER
  switch (agent.status) {
    case 'failed':
    case 'killed':
    case 'timeout':
      return [
        { kind: 'error', text: agent.error?.message ?? agent.status },
        { kind: 'info', text: `(transcript: ${agentDir})` },
      ]
    case 'pending':
    case 'running':
    case 'ok':
      return NO_TRAILER
    default:
      return exhaustive(agent.status)
  }
}

const NO_TRAILER: TrailerLine[] = []

/** One record's visible lines. Re-renders only when its slice, expansion or cursor changes. */
const TranscriptRow = memo(function TranscriptRow(props: {
  row: VisibleRow
  cursor: boolean
  width: number
}) {
  const { row, cursor, width } = props
  return (
    <Box flexDirection="column" flexShrink={0}>
      {row.lines.map((line, i) => {
        const index = row.firstLine + i
        const color = lineColor(row.kind, index)
        // An empty Text takes no row; a space keeps the blank line.
        const shown = line === '' ? ' ' : line
        if (cursor && row.kind === 'tool' && index === 0) {
          return (
            <Row key={index} width={width} backgroundColor={theme.selection}>
              <Text color={color}>{shown}</Text>
            </Row>
          )
        }
        return (
          <Text key={index} color={color} wrap="truncate">
            {shown}
          </Text>
        )
      })}
    </Box>
  )
}, sameRow)

function sameRow(
  a: { row: VisibleRow; cursor: boolean; width: number },
  b: { row: VisibleRow; cursor: boolean; width: number },
): boolean {
  if (a.cursor !== b.cursor || a.width !== b.width) return false
  const x = a.row
  const y = b.row
  if (
    x.record !== y.record ||
    x.kind !== y.kind ||
    x.firstLine !== y.firstLine ||
    x.expanded !== y.expanded ||
    x.lines.length !== y.lines.length
  ) {
    return false
  }
  return x.lines.every((line, i) => line === y.lines[i])
}

function lineColor(kind: VisibleRow['kind'], index: number): string {
  switch (kind) {
    case 'text':
      return theme.text
    case 'partial':
      return theme.muted
    case 'tool':
      return index === 0 ? theme.muted : theme.dim
    case 'note':
      return theme.warn
    case 'error':
      return theme.err
    case 'info':
      return theme.dim
    default:
      return exhaustive(kind)
  }
}

function exhaustive(value: never): never {
  throw new Error(`unhandled transcript row: ${JSON.stringify(value)}`)
}
