import { Box, Text } from 'ink'
import type { ReactNode } from 'react'
import type { ChainSummary, ProviderStatus } from '../../engine/index.js'
import { oneLine, wrapLines } from '../format.js'
import { theme } from '../theme.js'

/** Lines a description may wrap onto before it ends in `…`. */
export const DESCRIPTION_MAX_LINES = 3

/** Cells left of the description and error text. */
const INDENT = '  '

/**
 * One chain: its name (in `accent` behind a `›` marker when selected), then the description
 * in `muted`, word-wrapped to `width` on up to `DESCRIPTION_MAX_LINES` lines, or, for a
 * chain that failed to load, `! <error>` in `err`, then `! needs grok, codex not logged in`
 * in `warn` when providers it uses are not ready. Every line also truncates, so the row is
 * exactly `chainRowHeight(summary, width)` rows tall.
 */
export function ChainRow(props: {
  summary: ChainSummary
  selected: boolean
  /** Cells the row wraps its description to. */
  width: number
}): ReactNode {
  const { summary, selected, width } = props
  const { name, description, error, missingProviders } = summary
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text color={selected ? theme.accent : theme.text} wrap="truncate-end">
        {`${selected ? '›' : ' '} ${name}`}
      </Text>
      {error !== undefined ? (
        <Text color={theme.err} wrap="truncate-end">
          {`${INDENT}! ${oneLine(error.message)}`}
        </Text>
      ) : (
        description !== undefined &&
        descriptionLines(description, width).map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity beyond position
          <Text key={i} color={theme.muted} wrap="truncate-end">
            {`${INDENT}${line}`}
          </Text>
        ))
      )}
      {missingProviders.length > 0 && (
        <Text color={theme.warn} wrap="truncate-end">
          {`  ! ${missingProviders.map(missingLabel).join(', ')}`}
        </Text>
      )}
    </Box>
  )
}

/** Rows `ChainRow` renders for the summary at `width`. */
export function chainRowHeight(summary: ChainSummary, width: number): number {
  const { error, description } = summary
  const middle =
    error !== undefined
      ? 1
      : description !== undefined
        ? descriptionLines(description, width).length
        : 0
  const warning = summary.missingProviders.length > 0 ? 1 : 0
  return 1 + middle + warning
}

function descriptionLines(description: string, width: number): string[] {
  return wrapLines(description, width - INDENT.length, DESCRIPTION_MAX_LINES)
}

function missingLabel(status: ProviderStatus): string {
  const { provider, availability } = status
  switch (availability.status) {
    case 'not_logged_in':
      return `${provider} not logged in`
    // `missingProviders` never holds a ready provider; it reads as not installed.
    case 'ready':
    case 'not_installed':
      return `needs ${provider}`
    default:
      return exhaustive(availability)
  }
}

function exhaustive(value: never): never {
  throw new Error(`unhandled availability: ${JSON.stringify(value)}`)
}
