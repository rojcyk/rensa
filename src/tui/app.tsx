import { homedir } from 'node:os'
import path from 'node:path'
import { Box, Text, useWindowSize } from 'ink'
import { type ReactNode, useCallback, useContext, useEffect, useState } from 'react'
import type { Engine, RunHandle } from '../engine/index.js'
import { HEADER_ROWS, Header } from './components/Header.js'
import { Layout } from './components/Layout.js'
import { type Action, useKeys } from './hooks/useKeys.js'
import { Chains } from './screens/Chains.js'
import { SizeProvider } from './size.js'
import {
  createTeardown,
  type Mode,
  type Session,
  SessionContext,
  type SessionControls,
  startSession,
} from './terminalSession.js'
import { theme } from './theme.js'

export type { Mode, Session } from './terminalSession.js'
export { resolveMode, UsageError } from './terminalSession.js'

export type Screen =
  | { name: 'chains' }
  | { name: 'detail'; chain: string }
  | { name: 'run'; chain: string; run: RunHandle }

export type Navigate = (screen: Screen) => void

/**
 * Starts the TUI: registers the terminal restore, then renders. The only
 * entry point into `src/tui/`, loaded by `main.ts` through a dynamic import.
 */
export function start(engine: Engine, screen: Screen, mode: Mode): Session {
  const teardown = createTeardown()
  let session: Session | undefined
  // Components only quit from key handlers, after `startSession` returned.
  const controls: SessionControls = {
    quit: () => session?.quit() ?? Promise.resolve(),
    onTeardown: teardown.add,
  }
  session = startSession(
    mode,
    <SessionContext value={controls}>
      <App engine={engine} initial={screen} mode={mode} />
    </SessionContext>,
    teardown,
  )
  return session
}

function App(props: { engine: Engine; initial: Screen; mode: Mode }): ReactNode {
  const { columns, rows } = useWindowSize()
  const content = (
    <SizeProvider columns={columns} rows={rows}>
      <Router {...props} />
      <CrashProbe />
    </SizeProvider>
  )
  if (props.mode !== 'fullscreen') return content
  return (
    <Box width={columns} height={rows} flexDirection="column" backgroundColor={theme.background}>
      {content}
    </Box>
  )
}

type Overlay = 'confirm' | 'aborting'

/** Rows the quit overlay takes as the footer. */
const QUIT_OVERLAY_ROWS = 1

/**
 * Screen state, the live run handles, and the quit confirmation. While
 * the overlay shows it holds the only active `useKeys`.
 */
function Router(props: { engine: Engine; initial: Screen; mode: Mode }): ReactNode {
  const { engine, initial, mode } = props
  const { quit } = useContext(SessionContext)
  const [screen, setScreen] = useState<Screen>(initial)
  // Every run started or opened this session; a run keeps going when its screen is left.
  const [runs, setRuns] = useState<ReadonlyArray<RunHandle>>(() =>
    initial.name === 'run' ? [initial.run] : [],
  )
  const [overlay, setOverlay] = useState<Overlay | undefined>()
  // The chain of the last detail or run screen; Chains selects it again when it mounts.
  const [lastChain, setLastChain] = useState<string | undefined>(() =>
    initial.name === 'chains' ? undefined : initial.chain,
  )
  const branch = useBranch(engine)

  const navigate: Navigate = useCallback((next) => {
    if (next.name !== 'chains') setLastChain(next.chain)
    if (next.name === 'run') {
      const handle = next.run
      setRuns((list) => (list.includes(handle) ? list : [...list, handle]))
    }
    setScreen(next)
  }, [])

  const requestQuit = () => {
    if (runs.some((run) => run.result() === undefined)) setOverlay('confirm')
    else void quit()
  }

  const confirmQuit = () => {
    const live = runs.filter((run) => run.result() === undefined)
    for (const run of live) run.abort()
    setOverlay('aborting')
    // The engine finalizes the record and releases the lock; quit after that.
    void Promise.all(live.map((run) => run.done)).then(() => quit())
  }

  return (
    <Layout
      mode={mode}
      header={
        <Header
          branch={branch}
          path={homeRelative(engine.root)}
          {...(screen.name !== 'chains' && { mode: 'in place' as const, right: screen.chain })}
        />
      }
      headerRows={HEADER_ROWS}
      body={
        screen.name === 'chains' ? (
          <Chains
            engine={engine}
            navigate={navigate}
            requestQuit={requestQuit}
            active={overlay === undefined}
            footerRows={overlay === undefined ? 0 : QUIT_OVERLAY_ROWS}
            {...(lastChain !== undefined && { initialChain: lastChain })}
          />
        ) : (
          <EmptyScreen
            screen={screen}
            navigate={navigate}
            requestQuit={requestQuit}
            active={overlay === undefined}
          />
        )
      }
      {...(overlay !== undefined && {
        footer: (
          <QuitOverlay
            state={overlay}
            onConfirm={confirmQuit}
            onCancel={() => setOverlay(undefined)}
          />
        ),
        footerRows: QUIT_OVERLAY_ROWS,
      })}
    />
  )
}

/**
 * Placeholder body for detail and run until steps 13-14 add those
 * screens: an empty body and the keys every screen shares. `esc` leaves
 * detail and run for chains (a run keeps going); ctrl+c quits.
 */
function EmptyScreen(props: {
  screen: Screen
  navigate: Navigate
  requestQuit(): void
  active: boolean
}): ReactNode {
  const { screen, navigate, requestQuit, active } = props
  useKeys(
    (action: Action | 'text') => {
      if (action === 'quit') requestQuit()
      else if (action === 'esc') {
        if (screen.name === 'chains') requestQuit()
        else navigate({ name: 'chains' })
      }
    },
    { active },
  )
  return null
}

/** `abort the run? y/n`, then `aborting…` while the runs drain. */
function QuitOverlay(props: { state: Overlay; onConfirm(): void; onCancel(): void }): ReactNode {
  const { state, onConfirm, onCancel } = props
  useKeys(
    (action, raw) => {
      if (state !== 'confirm') return
      if (action === 'text' && raw.input === 'y') onConfirm()
      else if (action === 'esc' || (action === 'text' && raw.input === 'n')) onCancel()
    },
    { active: true },
  )
  return (
    <Text color={theme.warn} wrap="truncate-end">
      {state === 'confirm' ? 'abort the run? y/n' : 'aborting…'}
    </Text>
  )
}

/** The checked-out branch; empty until git answers. */
function useBranch(engine: Engine): string {
  const [branch, setBranch] = useState('')
  useEffect(() => {
    let live = true
    engine.currentRef().then(
      (ref) => {
        if (live) setBranch(ref)
      },
      () => {},
    )
    return () => {
      live = false
    }
  }, [engine])
  return branch
}

function homeRelative(dir: string): string {
  const home = homedir()
  const rel = path.relative(home, dir)
  if (rel === '') return '~'
  if (rel.startsWith('..') || path.isAbsolute(rel)) return dir
  return `~${path.sep}${rel}`
}

/**
 * Dev-only failure injection for the terminal-session tests and manual
 * verification; removed before step 17. `RENSA_CRASH=render` throws
 * inside render, `timer` from a timer, `warn` emits a Node warning and a
 * console line; each 300 ms after the first frame.
 */
const CRASH_DELAY_MS = 300
export const CRASH_WARNING = 'rensa-crash-probe warning'
export const CRASH_CONSOLE = 'rensa-crash-probe console'

function CrashProbe(): ReactNode {
  const kind = process.env.RENSA_CRASH
  const [renderCrash, setRenderCrash] = useState(false)
  useEffect(() => {
    if (kind !== 'render' && kind !== 'timer' && kind !== 'warn') return
    const timer = setTimeout(() => {
      if (kind === 'render') setRenderCrash(true)
      else if (kind === 'timer') throw new Error('RENSA_CRASH=timer: dev-only throw from a timer')
      else {
        process.emitWarning(CRASH_WARNING)
        // biome-ignore lint/suspicious/noConsole: dev-only probe of the session's console capture
        console.log(CRASH_CONSOLE)
      }
    }, CRASH_DELAY_MS)
    return () => clearTimeout(timer)
  }, [kind])
  if (renderCrash) throw new Error('RENSA_CRASH=render: dev-only throw during render')
  return null
}
