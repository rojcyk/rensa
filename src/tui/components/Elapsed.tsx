import { Text } from 'ink'
import { memo, useContext, useEffect, useState } from 'react'
import { formatElapsed } from '../format.js'
import { SessionContext } from '../terminalSession.js'
import { theme } from '../theme.js'

const TICK_MS = 1000

/**
 * Time since `since`: `m:ss`, `h:mm:ss` past an hour. Ticks on its own
 * 1 s interval, cleared on unmount and on quit. With `until` it shows the
 * fixed difference and runs no interval. A memoized leaf: nothing above
 * it re-renders on a tick.
 */
export const Elapsed = memo(function Elapsed(props: {
  since: string
  until?: string
  color?: string
}) {
  const { since, until, color = theme.text } = props
  const { onTeardown } = useContext(SessionContext)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (until !== undefined) return
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    const drop = onTeardown(() => clearInterval(timer))
    return () => {
      clearInterval(timer)
      drop()
    }
  }, [until, onTeardown])

  const end = until !== undefined ? Date.parse(until) : now
  return <Text color={color}>{formatElapsed(end - Date.parse(since))}</Text>
})
