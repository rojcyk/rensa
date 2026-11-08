import { Text } from 'ink'
import { Fragment, type ReactNode } from 'react'
import type { ProviderStatus } from '../../engine/index.js'
import { theme } from '../theme.js'

const SEPARATOR = '   '

/**
 * One entry per provider in registry order: `name version` when ready,
 * `name version · not logged in` when logged out, `name not installed`
 * otherwise. `checking providers…` until the first check completes. The
 * `fake` provider shows only under `RENSA_DEV=1`. One row; it truncates.
 */
export function ProviderLine(props: {
  statuses: ReadonlyArray<ProviderStatus> | undefined
}): ReactNode {
  const { statuses } = props
  if (statuses === undefined) {
    return (
      <Text color={theme.muted} wrap="truncate-end">
        {'  checking providers…'}
      </Text>
    )
  }
  const shown = statuses.filter((s) => s.provider !== 'fake' || process.env.RENSA_DEV === '1')
  return (
    <Text wrap="truncate-end">
      {'  '}
      {shown.map((s, i) => (
        <Fragment key={s.provider}>
          {i > 0 && SEPARATOR}
          <ProviderEntry status={s} />
        </Fragment>
      ))}
    </Text>
  )
}

function ProviderEntry(props: { status: ProviderStatus }): ReactNode {
  const { provider, availability } = props.status
  switch (availability.status) {
    case 'ready':
      return <Text color={theme.text}>{`${provider} ${availability.version}`}</Text>
    case 'not_logged_in':
      return (
        <Text color={theme.muted}>{`${provider} ${availability.version} · not logged in`}</Text>
      )
    case 'not_installed':
      return <Text color={theme.dim}>{`${provider} not installed`}</Text>
    default:
      return exhaustive(availability)
  }
}

function exhaustive(value: never): never {
  throw new Error(`unhandled availability: ${JSON.stringify(value)}`)
}
