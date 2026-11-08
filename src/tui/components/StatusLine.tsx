import { Box, Text } from 'ink'
import { memo } from 'react'
import type { RunProgress } from '../../engine/index.js'
import { oneLine } from '../format.js'
import { theme } from '../theme.js'
import { Elapsed } from './Elapsed.js'

/** Characters of the run id the status line shows. */
const ID_TAIL = 4

export interface StatusLineProps {
  runId: string
  progress: RunProgress
  width: number
}

/**
 * `run <id tail> · <elapsed> · <state>`, right-aligned, one row. In
 * `muted`, the state in its color. Re-renders only when `progress`
 * changes; the elapsed cell ticks itself and stops once the run has a
 * `finishedAt`. A long state (`failed · <message>`) truncates with `…`.
 */
export const StatusLine = memo(function StatusLine(props: StatusLineProps) {
  const { runId, progress, width } = props
  const { text, color } = runState(progress)
  return (
    <Box width={width} height={1} flexShrink={0} justifyContent="flex-end" overflow="hidden">
      <Text color={theme.muted} wrap="truncate-end">
        {`run ${runId.slice(-ID_TAIL)} · `}
        {progress.startedAt !== undefined && (
          <>
            <Elapsed
              since={progress.startedAt}
              color={theme.muted}
              {...(progress.finishedAt !== undefined && { until: progress.finishedAt })}
            />
            {' · '}
          </>
        )}
        <Text color={color}>{text}</Text>
      </Text>
    </Box>
  )
})

/** The state word and its color; `pausing after <step>` while a requested pause is pending. */
export function runState(progress: RunProgress): { text: string; color: string } {
  if (progress.error !== undefined) {
    return { text: `failed · ${oneLine(progress.error.message)}`, color: theme.err }
  }
  switch (progress.status) {
    case 'running':
      return {
        text: progress.pausing === undefined ? 'running' : `pausing after ${progress.pausing}`,
        color: theme.accent,
      }
    case 'paused': {
      const { before, after } = progress.pausedAt ?? {}
      let text = 'paused'
      if (before !== undefined) text = `paused before ${before}`
      else if (after !== undefined) text = `paused after ${after}`
      return { text, color: theme.accent }
    }
    case 'aborting':
      return { text: 'aborting…', color: theme.warn }
    case 'complete':
      return { text: 'complete', color: theme.ok }
    case 'failed':
      return { text: 'failed', color: theme.err }
    case 'aborted':
      return { text: 'aborted', color: theme.err }
    default:
      return exhaustive(progress.status)
  }
}

function exhaustive(value: never): never {
  throw new Error(`unhandled run status: ${JSON.stringify(value)}`)
}
