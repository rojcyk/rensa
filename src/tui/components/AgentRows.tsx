import { Box, Text } from 'ink'
import { memo, type ReactNode } from 'react'
import type { AgentView, ResolvedAgent, RunProgress, StepView } from '../../engine/index.js'
import type { RunState } from '../engineBridge.js'
import { formatTokens, oneLine, truncateEnd } from '../format.js'
import { type Store, useStore } from '../store.js'
import { theme } from '../theme.js'
import { Elapsed } from './Elapsed.js'
import { Row } from './Row.js'
import { Spinner } from './Spinner.js'

/**
 * Fixed column widths: marker, name, config, status, tokens; 57 in all.
 * Status holds `✓ h:mm:ss` (9 cells) and one column of padding.
 */
const COLS = { marker: 2, name: 11, config: 27, status: 10, tokens: 7 } as const

/** One row: an agent of a step, or a shell step's command. */
export type AgentRowSpec =
  | { kind: 'agent'; step: string; agent: ResolvedAgent }
  | { kind: 'shell'; step: string; command: string }

export interface AgentRowsProps {
  store: Store<RunState>
  /** Exactly one in the MVP; the component takes a list so parallel agents need no new one. */
  rows: ReadonlyArray<AgentRowSpec>
}

/** Rows `AgentRows` renders for `rows`: one each. */
export function agentRowsHeight(rows: ReadonlyArray<AgentRowSpec>): number {
  return rows.length
}

/**
 * The agent rows of the selected step. Subscribes to nothing itself:
 * each row selects its own view from the store, so a tick, a token
 * update on another step or a transcript delta never redraws a row.
 */
export const AgentRows = memo(function AgentRows(props: AgentRowsProps) {
  const { store, rows } = props
  return (
    <Box flexDirection="column" flexShrink={0}>
      {rows.map((row) =>
        row.kind === 'agent' ? (
          <AgentRow key={`${row.step}/${row.agent.label}`} store={store} spec={row} />
        ) : (
          <ShellRow key={`${row.step}/shell`} store={store} spec={row} />
        ),
      )}
    </Box>
  )
})

const AgentRow = memo(function AgentRow(props: {
  store: Store<RunState>
  spec: Extract<AgentRowSpec, { kind: 'agent' }>
}) {
  const { store, spec } = props
  const view = useStore(store, (s) => s.steps.get(spec.step)?.agent)
  const runEnd = useStore(store, (s) => endedAt(s.progress))
  const usage = view?.usage
  return (
    <Cells
      name={spec.agent.label}
      config={agentConfig(view ?? spec.agent)}
      status={<StatusCell timing={view} runEnd={runEnd} />}
      tokens={usage === undefined ? '' : formatTokens(usage.input + usage.output)}
    />
  )
})

const ShellRow = memo(function ShellRow(props: {
  store: Store<RunState>
  spec: Extract<AgentRowSpec, { kind: 'shell' }>
}) {
  const { store, spec } = props
  const view = useStore(store, (s) => s.steps.get(spec.step))
  const runEnd = useStore(store, (s) => endedAt(s.progress))
  return (
    <Cells
      name={oneLine(spec.command)}
      config=""
      status={<StatusCell timing={view} runEnd={runEnd} />}
      tokens=""
    />
  )
})

function Cells(props: {
  name: string
  config: string
  status: ReactNode
  tokens: string
}): ReactNode {
  const { name, config, status, tokens } = props
  return (
    <Box height={1} flexShrink={0} overflow="hidden">
      <Row width={COLS.marker}>
        <Text color={theme.accent}>›</Text>
      </Row>
      <Row width={COLS.name}>
        <Text color={theme.text}>{truncateEnd(name, COLS.name - 1)}</Text>
      </Row>
      <Row width={COLS.config}>
        <Text color={theme.muted}>{truncateEnd(config, COLS.config - 1)}</Text>
      </Row>
      <Row width={COLS.status}>{status}</Row>
      <Row width={COLS.tokens}>
        <Text color={theme.muted}>{tokens.padStart(COLS.tokens)}</Text>
      </Row>
    </Box>
  )
}

type Timing = Pick<AgentView | StepView, 'status' | 'startedAt' | 'finishedAt'>

/** When the run ended; undefined while it has not. */
function endedAt(progress: RunProgress): string | undefined {
  switch (progress.status) {
    case 'complete':
    case 'failed':
    case 'aborted':
      return progress.finishedAt
    case 'running':
    case 'paused':
    case 'aborting':
      return undefined
    default:
      return exhaustive(progress.status)
  }
}

/**
 * Spinner and elapsed while running; `✓ 1:52` or `✗ 0:38` once
 * finished, the elapsed frozen; `– ` before it starts. A row still
 * running when the run has ended (a storage failure left its end
 * unrecorded) shows `✗`, frozen at the run's end, so nothing ticks.
 */
function StatusCell(props: { timing: Timing | undefined; runEnd: string | undefined }): ReactNode {
  const { timing, runEnd } = props
  const status = timing?.status ?? 'pending'
  const since = timing?.startedAt
  switch (status) {
    case 'pending':
    case 'paused':
      return <Text color={theme.dim}>– </Text>
    case 'running':
      if (runEnd !== undefined) {
        return (
          <>
            <Text color={theme.err}>✗</Text>{' '}
            {since !== undefined && <Elapsed since={since} until={runEnd} color={theme.muted} />}
          </>
        )
      }
      return (
        <>
          <Spinner /> {since !== undefined && <Elapsed since={since} color={theme.muted} />}
        </>
      )
    case 'ok':
    case 'failed':
    case 'killed':
    case 'timeout': {
      const ok = status === 'ok'
      const until = timing?.finishedAt
      return (
        <>
          <Text color={ok ? theme.ok : theme.err}>{ok ? '✓' : '✗'}</Text>{' '}
          {since !== undefined && (
            <Elapsed since={since} color={theme.muted} {...(until !== undefined && { until })} />
          )}
        </>
      )
    }
    default:
      return exhaustive(status)
  }
}

/** `provider · model · effort`; `default` for an unset model, no effort when unset. */
function agentConfig(agent: { provider: string; model?: string; effort?: string }): string {
  const parts = [agent.provider, agent.model ?? 'default']
  if (agent.effort !== undefined) parts.push(agent.effort)
  return parts.join(' · ')
}

function exhaustive(value: never): never {
  throw new Error(`unhandled agent status: ${JSON.stringify(value)}`)
}
