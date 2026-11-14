import { useContext, useEffect, useEffectEvent } from 'react'
import type { WheelDirection } from '../mouse.js'
import { SessionContext } from '../terminalSession.js'

/**
 * Calls `handler` for every mouse wheel turn while `active`. Like
 * `useKeys`, a screen gives `active: false` while an overlay holds the
 * input, so the wheel does not move what the overlay covers.
 */
export function useWheel(
  handler: (direction: WheelDirection) => void,
  opts: { active: boolean },
): void {
  const { onWheel } = useContext(SessionContext)
  const onTurn = useEffectEvent(handler)
  useEffect(() => {
    if (!opts.active) return
    return onWheel((direction) => onTurn(direction))
  }, [opts.active, onWheel])
}
