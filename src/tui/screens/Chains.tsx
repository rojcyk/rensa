import { Box, Text } from 'ink'
import { type ReactNode, useEffect, useState } from 'react'
import type { ChainSummary, Engine, ProviderStatus } from '../../engine/index.js'
import type { Navigate } from '../app.js'
import { ChainRow, chainRowHeight } from '../components/ChainRow.js'
import { HEADER_ROWS } from '../components/Header.js'
import { ProviderLine } from '../components/ProviderLine.js'
import { useKeys } from '../hooks/useKeys.js'
import { useBudget } from '../size.js'
import { theme } from '../theme.js'

/** The part of the engine this screen reads; a stub needs only these. */
export type ChainsEngine = Pick<Engine, 'providers' | 'chains' | 'recheckProviders' | 'on' | 'off'>

export interface ChainsProps {
  engine: ChainsEngine
  navigate: Navigate
  /** The app's quit path: `quit`, and `esc` on this screen. */
  requestQuit(): void
  /** False while an app-level overlay holds the keys. */
  active: boolean
  /** Rows the app's footer takes from the body; 0 without one. */
  footerRows: number
  /** The chain selected on mount, by name; the first chain when absent or not listed. */
  initialChain?: string
}

/** Rows above the chain list: the provider line. */
const PROVIDER_ROWS = 1

interface Snapshot {
  providers: ProviderStatus[] | undefined
  chains: ChainSummary[]
}

interface Selection {
  selected: number
  /** The first chain shown. */
  top: number
}

/**
 * The first screen: provider availability and the chain list. Reads both
 * from the engine and re-reads them on every `'providers'` event; never
 * awaits a check. `up`/`down` select, `enter` opens the detail screen,
 * `recheck` starts a new provider check.
 */
export function Chains(props: ChainsProps): ReactNode {
  const { engine, navigate, requestQuit, active, footerRows, initialChain } = props
  const snapshot = useEngineSnapshot(engine)
  const { chains } = snapshot
  const { bodyRows } = useBudget({ headerRows: HEADER_ROWS, footerRows }).current
  const listRows = Math.max(0, bodyRows - PROVIDER_ROWS)
  const heights = chains.map(chainRowHeight)
  // `top` starts at 0; `windowTop` below brings the initial selection into view.
  const [selection, setSelection] = useState<Selection>(() => ({
    selected: Math.max(
      0,
      chains.findIndex((c) => c.name === initialChain),
    ),
    top: 0,
  }))

  const last = chains.length - 1
  const selected = clamp(selection.selected, 0, Math.max(0, last))
  // Recomputed every render so a resize keeps the selection in view too.
  const top = windowTop(selection.top, selected, heights, listRows)

  const move = (delta: number) =>
    setSelection((s) => {
      const next = clamp(s.selected + delta, 0, Math.max(0, last))
      return { selected: next, top: windowTop(s.top, next, heights, listRows) }
    })

  useKeys(
    (action) => {
      switch (action) {
        case 'up':
          move(-1)
          break
        case 'down':
          move(1)
          break
        case 'enter': {
          const chain = chains[selected]
          if (chain !== undefined) navigate({ name: 'detail', chain: chain.name })
          break
        }
        case 'recheck':
          void engine.recheckProviders()
          break
        case 'quit':
        case 'esc':
          requestQuit()
          break
        default:
          break
      }
    },
    { active },
  )

  return (
    <Box flexDirection="column" flexShrink={0}>
      <ProviderLine statuses={snapshot.providers} />
      {chains.length === 0 ? (
        <Box marginTop={1} flexShrink={0}>
          <Text color={theme.muted} wrap="truncate-end">
            {'  no chains in .rensa/'}
          </Text>
        </Box>
      ) : (
        chains.slice(top).map((summary, i) => (
          <Box key={summary.name} marginTop={1} flexShrink={0}>
            <ChainRow summary={summary} selected={top + i === selected} />
          </Box>
        ))
      )}
    </Box>
  )
}

/**
 * Providers and chains as the engine reports them, replaced on every
 * `'providers'` event. A check that completed between the first render
 * and the subscription is caught up in the effect.
 */
function useEngineSnapshot(engine: ChainsEngine): Snapshot {
  const [snapshot, setSnapshot] = useState(() => read(engine))
  useEffect(() => {
    const onProviders = () => setSnapshot(read(engine))
    engine.on('providers', onProviders)
    setSnapshot((prev) => (prev.providers === engine.providers() ? prev : read(engine)))
    return () => {
      engine.off('providers', onProviders)
    }
  }, [engine])
  return snapshot
}

function read(engine: ChainsEngine): Snapshot {
  return { providers: engine.providers(), chains: engine.chains() }
}

/**
 * The first chain to show so the selected one fits in `rows`, moving the
 * window as little as possible from `top`. Each chain takes its height
 * plus the blank row above it. Scrolls back up when rows below the last
 * chain would otherwise stay empty.
 */
function windowTop(
  top: number,
  selected: number,
  heights: ReadonlyArray<number>,
  rows: number,
): number {
  if (heights.length === 0) return 0
  const block = (i: number) => (heights[i] ?? 0) + 1
  let first = clamp(top, 0, selected)
  let span = 0
  for (let i = first; i <= selected; i++) span += block(i)
  while (first < selected && span > rows) {
    span -= block(first)
    first++
  }
  let tail = 0
  for (let i = first; i < heights.length; i++) tail += block(i)
  while (first > 0 && tail + block(first - 1) <= rows) {
    first--
    tail += block(first)
  }
  return first
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max)
}
