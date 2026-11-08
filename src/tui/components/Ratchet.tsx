import { Box, type DOMElement, measureElement, useBoxMetrics } from 'ink'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useSize } from '../size.js'

/** The tallest height seen at one terminal size. */
interface Floor {
  columns: number
  rows: number
  height: number
}

/**
 * A column whose `minHeight` only grows: the largest height its content
 * has rendered at since the terminal bounds last changed. Content that
 * shrinks for a frame (a line disappearing while a check re-runs) then
 * does not pull everything below it up and back down. A bounds change
 * starts over, since a different size legitimately needs a different
 * height. Paints no background of its own.
 */
export function Ratchet(props: { children: ReactNode }): ReactNode {
  const ref = useRef<DOMElement>(null)
  // Re-renders this box when its layout changes, even when the children
  // changed without re-rendering it (a memoized row updating itself).
  const metrics = useBoxMetrics(ref)
  const { columns, rows } = useSize()
  const [floor, setFloor] = useState<Floor>({ columns, rows, height: 0 })

  // Reset during render, so the frame at the new size is laid out without the old floor.
  const sameBounds = floor.columns === columns && floor.rows === rows
  const current = sameBounds ? floor : { columns, rows, height: 0 }
  if (!sameBounds) setFloor(current)

  useEffect(() => {
    const node = ref.current
    if (!metrics.hasMeasured || node === null) return
    // Read the committed layout directly: right after a reset `metrics`
    // still holds the height measured under the previous floor.
    const { height } = measureElement(node)
    setFloor((f) =>
      f.columns === columns && f.rows === rows && height > f.height ? { columns, rows, height } : f,
    )
  }, [metrics, columns, rows])

  return (
    <Box
      ref={ref}
      flexDirection="column"
      flexShrink={0}
      {...(current.height > 0 && { minHeight: current.height })}
    >
      {props.children}
    </Box>
  )
}
