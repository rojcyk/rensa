import { Box, Text } from 'ink'
import type { ReactNode } from 'react'
import type { ChainSummary, ProviderStatus } from '../../engine/index.js'
import { theme } from '../theme.js'

/**
 * One chain: its name (in `accent` when selected), then the description
 * in `muted` or, for a chain that failed to load, `! <error>` in `err`,
 * then `! needs grok, codex not logged in` in `warn` when providers it
 * uses are not ready. Every line truncates, so the row is exactly
 * `chainRowHeight(summary)` rows tall.
 */
export function ChainRow(props: { summary: ChainSummary; selected: boolean }): ReactNode {
  const { summary, selected } = props
  const { name, description, error, missingProviders } = summary
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text color={selected ? theme.accent : theme.text} wrap="truncate-end">
        {`  ${name}`}
      </Text>
      {error !== undefined ? (
        <Text color={theme.err} wrap="truncate-end">
          {`    ! ${oneLine(error.message)}`}
        </Text>
      ) : (
        description !== undefined && (
          <Text color={theme.muted} wrap="truncate-end">
            {`    ${oneLine(description)}`}
          </Text>
        )
      )}
      {missingProviders.length > 0 && (
        <Text color={theme.warn} wrap="truncate-end">
          {`    ! ${missingProviders.map(missingLabel).join(', ')}`}
        </Text>
      )}
    </Box>
  )
}

/** Rows `ChainRow` renders for the summary. */
export function chainRowHeight(summary: ChainSummary): number {
  const second = summary.error !== undefined || summary.description !== undefined ? 1 : 0
  const third = summary.missingProviders.length > 0 ? 1 : 0
  return 1 + second + third
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

/** A multi-line description or message folded onto its row. */
function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim()
}

function exhaustive(value: never): never {
  throw new Error(`unhandled availability: ${JSON.stringify(value)}`)
}
