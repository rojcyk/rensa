import { Box, Text } from 'ink'
import type { ReactNode } from 'react'
import type { AgentStep, ResolvedAgent, Step } from '../../engine/index.js'
import { theme } from '../theme.js'

/** Columns before the marker. */
const INDENT = 2
/** The marker and the space after it. */
const MARKER_COLS = 2
/** Columns the id column adds to the longest id. */
const ID_PADDING = 2

export interface TimelineProps {
  steps: ReadonlyArray<Step>
  /**
   * `static`: the chain as configured, before a run (detail screen): a
   * shell step's command beside its id, an agent step's label and
   * configuration on a row beneath. `live`: one row per step, marker and
   * id only, for the run screen's left column.
   */
  mode: 'static' | 'live'
  /** Id of the selected step, drawn in `accent` (`live` only). */
  selected?: string
}

/**
 * One row per step: `○` in `dim`, then the id in `text`. Every row is
 * one line and truncates with `…`, so the block is exactly as tall as
 * its rows. Column widths: marker 2, id the longest id + 2, detail the
 * rest. In `static` mode agent labels share the id column, so it is the
 * longest id or label + 2, and a label never runs into its detail.
 */
export function Timeline(props: TimelineProps): ReactNode {
  const { steps, mode, selected } = props
  const idWidth = Math.max(0, ...steps.map((s) => columnText(s, mode).length)) + ID_PADDING
  return (
    <Box flexDirection="column" flexShrink={0} paddingLeft={INDENT}>
      {steps.map((step) => {
        if (mode === 'live') {
          const idColor = step.id === selected ? theme.accent : theme.text
          return (
            <Line key={step.id} marker idWidth={idWidth} first={step.id} firstColor={idColor} />
          )
        }
        if (step.kind === 'shell') {
          return (
            <Line
              key={step.id}
              marker
              idWidth={idWidth}
              first={step.id}
              firstColor={theme.text}
              detail={oneLine(step.command)}
            />
          )
        }
        return <AgentStepRows key={step.id} step={step} idWidth={idWidth} />
      })}
    </Box>
  )
}

function AgentStepRows(props: { step: AgentStep; idWidth: number }): ReactNode {
  const { step, idWidth } = props
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Line marker idWidth={idWidth} first={step.id} firstColor={theme.text} />
      <Line
        marker={false}
        idWidth={idWidth}
        first={step.agent.label}
        firstColor={theme.muted}
        detail={agentConfig(step.agent)}
      />
    </Box>
  )
}

/**
 * One row: the marker column (`○`, or blank for an agent row), the id
 * column, and the detail in `muted` taking the rest of the width.
 */
function Line(props: {
  marker: boolean
  idWidth: number
  first: string
  firstColor: string
  detail?: string
}): ReactNode {
  const { marker, idWidth, first, firstColor, detail } = props
  return (
    <Box height={1} flexShrink={0} overflow="hidden">
      <Box width={MARKER_COLS} flexShrink={0}>
        {marker && <Text color={theme.dim}>○</Text>}
      </Box>
      <Box width={idWidth} flexShrink={0} overflow="hidden">
        <Text color={firstColor} wrap="truncate-end">
          {first}
        </Text>
      </Box>
      {detail !== undefined && (
        <Box flexGrow={1} flexShrink={1} overflow="hidden">
          <Text color={theme.muted} wrap="truncate-end">
            {detail}
          </Text>
        </Box>
      )}
    </Box>
  )
}

/** The longest text a step puts in the id column: its id, or in `static` mode its agent's label too. */
function columnText(step: Step, mode: TimelineProps['mode']): string {
  if (mode === 'live' || step.kind === 'shell' || step.agent.label.length <= step.id.length) {
    return step.id
  }
  return step.agent.label
}

/** `provider · model · effort`; `default` for an unset model, no effort when unset. */
function agentConfig(agent: ResolvedAgent): string {
  const parts = [agent.provider, agent.model ?? 'default']
  if (agent.effort !== undefined) parts.push(agent.effort)
  return parts.join(' · ')
}

/** A multi-line command folded onto its row. */
function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim()
}
