import { existsSync } from 'node:fs'
import path from 'node:path'
import { Box, Text } from 'ink'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import {
  type Engine,
  type LaunchCheck,
  RensaError,
  type ResolvedChain,
  type RunInput,
} from '../../engine/index.js'
import type { Navigate } from '../app.js'
import { EMPTY_INPUT, editInput, type InputState } from '../components/editInput.js'
import { Frame } from '../components/Frame.js'
import { HEADER_ROWS } from '../components/Header.js'
import { InputBox } from '../components/InputBox.js'
import { Layout } from '../components/Layout.js'
import { Ratchet } from '../components/Ratchet.js'
import { Timeline } from '../components/Timeline.js'
import { type Focus, useKeys } from '../hooks/useKeys.js'
import { isShort } from '../layout.js'
import { useBudget, useSize } from '../size.js'
import type { Mode } from '../terminalSession.js'
import { theme } from '../theme.js'

/** The part of the engine this screen uses; a stub needs only these. */
export type DetailEngine = Pick<
  Engine,
  'root' | 'version' | 'chain' | 'preflight' | 'start' | 'recheckProviders'
>

export interface DetailProps {
  engine: DetailEngine
  /** The chain's name. */
  chain: string
  navigate: Navigate
  /** The app's quit path. */
  requestQuit(): void
  /** False while an app-level overlay holds the keys. */
  active: boolean
  mode: Mode
  /** The app's header; this screen lays out through `Layout` itself. */
  header: ReactNode
  /** The app's quit overlay; takes the footer in place of the input area while it shows. */
  overlay?: { footer: ReactNode; rows: number }
}

/** The input box: border, one row of text, border; one bare row in `short` compact mode. */
const INPUT_ROWS = { frame: 3, line: 1 } as const
/** `press enter to start`, or `esc back` for a chain that failed to load. */
const LINE_ROWS = 1
/** Body rows besides the frame and the timeline: blank, frame, blank, timeline, blank, status line, blank. */
const TIMELINE_CHROME_ROWS = 5
/** The frame's borders, `rensa <version>`, the blank line and the chain name. */
const FRAME_BASE_ROWS = 5

type Loaded = { chain: ResolvedChain } | { error: RensaError }

/** What the screen itself has to say on the status line; the launch check shows otherwise. */
type Notice = { kind: 'starting' } | { kind: 'error'; message: string }

interface StatusLine {
  text: string
  color: string
}

/**
 * The screen between choosing a chain and running it: the chain's
 * identity, its steps and agents, the launch check, and the input area.
 * `enter` starts the run once and hands off to the run screen; `esc`
 * goes back to chains. A chain that failed to load shows only its error.
 */
export function Detail(props: DetailProps): ReactNode {
  const { engine, chain: name, navigate, requestQuit, active, mode, header, overlay } = props
  const [loaded] = useState(() => load(engine, name))
  const chain = 'chain' in loaded ? loaded.chain : undefined
  const { check, refresh, checkNow } = useLaunchCheck(engine, name, chain !== undefined)
  const [input, setInput] = useState<InputState>(EMPTY_INPUT)
  // Key handlers read and write these synchronously, so two keys that
  // arrive before a render see each other's effect.
  const inputRef = useRef(input)
  const startingRef = useRef(false)
  const [notice, setNotice] = useState<Notice | undefined>()

  const hasBox = chain !== undefined && chain.input !== 'none'
  // Nothing else on this screen takes keys, so a box has focus from mount.
  const focus: Focus = hasBox ? 'input' : 'main'

  const updateInput = (next: InputState) => {
    if (next === inputRef.current) return
    inputRef.current = next
    setInput(next)
    setNotice((n) => (n?.kind === 'error' ? undefined : n))
  }

  /**
   * The one path that calls `start`: once the input rule passes, a fresh
   * launch check, then `start` only if that check is ok. The check is
   * never re-run after `start`, which would report this run's own lock.
   */
  const submit = () => {
    if (chain === undefined || startingRef.current) return
    const request = runInputFor(chain, inputRef.current.value, engine.root)
    if (request === undefined) return
    if ('missing' in request) {
      setNotice({ kind: 'error', message: `file not found: ${request.missing}` })
      return
    }
    // Set before the check, so an enter while it runs is ignored.
    startingRef.current = true
    setNotice(undefined)
    void checkNow().then((fresh) => {
      // Not ok, or the screen is gone: the status line shows the fresh check.
      if (fresh?.ok !== true) {
        startingRef.current = false
        return
      }
      setNotice({ kind: 'starting' })
      return engine.start(name, request).then(
        (run) => navigate({ name: 'run', chain: name, run }),
        (err: unknown) => {
          startingRef.current = false
          setNotice({ kind: 'error', message: messageOf(err) })
          refresh()
        },
      )
    })
  }

  useKeys(
    (action, raw) => {
      switch (action) {
        case 'quit':
          requestQuit()
          return
        case 'esc':
          // No `main` to return to from the box: `esc` leaves the screen.
          navigate({ name: 'chains' })
          return
        case 'enter':
          submit()
          return
        case 'recheck':
          if (chain !== undefined) void engine.recheckProviders()
          break
        case 'follow':
        case 'pause':
        case 'kill':
          break
        default:
          if (focus === 'input') updateInput(editInput(inputRef.current, raw))
          break
      }
      // Any other key: the tree or another run may have changed since the last check.
      refresh()
    },
    { active },
  )

  const { columns, rows } = useSize()
  // A short terminal collapses the footer to one row, where a frame would show only its top border.
  const inputVariant = isShort(rows) ? 'line' : 'frame'
  const borderBackground = mode === 'fullscreen' ? { borderBackgroundColor: theme.background } : {}
  let footer: ReactNode
  let footerRows: number
  if (overlay !== undefined) {
    footer = overlay.footer
    footerRows = overlay.rows
  } else if (chain === undefined) {
    footer = <MutedLine text="esc back" />
    footerRows = LINE_ROWS
  } else if (hasBox) {
    footer = (
      <InputBox
        state={input}
        onPaste={updateInput}
        prompt="›"
        {...(chain.input === 'file' && { placeholder: 'path to file' })}
        focused={active}
        enabled
        width={columns}
        variant={inputVariant}
        {...borderBackground}
      />
    )
    footerRows = INPUT_ROWS[inputVariant]
  } else {
    footer = <MutedLine text="press enter to start" />
    footerRows = LINE_ROWS
  }

  const { bodyRows } = useBudget({ headerRows: HEADER_ROWS, footerRows }).current
  const status = chain === undefined ? undefined : statusLine(notice, check)
  const statusNode = <StatusRow line={status} />
  const hasThirdLine = chain === undefined || chain.description !== undefined
  const frameRows = FRAME_BASE_ROWS + (hasThirdLine ? 1 : 0)
  const timelineRows = Math.max(0, bodyRows - frameRows - TIMELINE_CHROME_ROWS)

  return (
    <Layout
      mode={mode}
      header={header}
      headerRows={HEADER_ROWS}
      body={
        <Box flexDirection="column" flexShrink={0} paddingTop={1}>
          <InfoFrame
            version={engine.version}
            name={name}
            loaded={loaded}
            width={columns}
            {...borderBackground}
          />
          {chain !== undefined && (
            <>
              <Box
                flexDirection="column"
                flexShrink={0}
                marginTop={1}
                maxHeight={timelineRows}
                overflow="hidden"
              >
                <Ratchet>
                  <Timeline steps={chain.steps} mode="static" />
                </Ratchet>
              </Box>
              <Box flexShrink={0} marginY={1}>
                {statusNode}
              </Box>
            </>
          )}
        </Box>
      }
      footer={footer}
      footerRows={footerRows}
      status={statusNode}
    />
  )
}

/** `rensa <version>`, the chain name, and its description or load error. */
function InfoFrame(props: {
  version: string
  name: string
  loaded: Loaded
  width: number
  borderBackgroundColor?: string
}): ReactNode {
  const { version, name, loaded, width, borderBackgroundColor } = props
  const description = 'chain' in loaded ? loaded.chain.description : undefined
  return (
    <Frame width={width} {...(borderBackgroundColor !== undefined && { borderBackgroundColor })}>
      <Text color={theme.muted} wrap="truncate-end">
        {`rensa ${version}`}
      </Text>
      <Text> </Text>
      <Text color={theme.text} wrap="truncate-end">
        {name}
      </Text>
      {'error' in loaded ? (
        <Text color={theme.err} wrap="truncate-end">
          {oneLine(loaded.error.message)}
        </Text>
      ) : (
        description !== undefined && (
          <Text color={theme.muted} wrap="truncate-end">
            {oneLine(description)}
          </Text>
        )
      )}
    </Frame>
  )
}

/** The status line's one row; empty when there is nothing to say. */
function StatusRow(props: { line: StatusLine | undefined }): ReactNode {
  const { line } = props
  return (
    <Box height={1} flexShrink={0} overflow="hidden">
      <Text color={line?.color ?? theme.muted} wrap="truncate-end">
        {line === undefined ? '' : `  ${line.text}`}
      </Text>
    </Box>
  )
}

function MutedLine(props: { text: string }): ReactNode {
  return (
    <Text color={theme.muted} wrap="truncate-end">
      {`  ${props.text}`}
    </Text>
  )
}

/**
 * The screen's own notice when it has one, else the launch check: a
 * failing check as `! message` in its level's color, a passing one's
 * message (`working tree clean`) in `muted`, nothing while unknown.
 */
function statusLine(
  notice: Notice | undefined,
  check: LaunchCheck | undefined,
): StatusLine | undefined {
  if (notice?.kind === 'starting') return { text: 'starting…', color: theme.muted }
  if (notice?.kind === 'error') return { text: `! ${notice.message}`, color: theme.err }
  if (check?.message === undefined) return undefined
  if (check.ok) return { text: check.message, color: theme.muted }
  return { text: `! ${check.message}`, color: check.level === 'warn' ? theme.warn : theme.err }
}

/**
 * The launch check, run on mount and again on every `refresh()`. One
 * refresh is in flight at a time; a refresh during it runs once more
 * after it. `checkNow()` runs one at once and resolves with its result,
 * or undefined once the screen is gone. The previous result stays until
 * a newer one lands; a result older than the one shown is dropped.
 */
function useLaunchCheck(
  engine: DetailEngine,
  name: string,
  enabled: boolean,
): {
  check: LaunchCheck | undefined
  refresh(): void
  checkNow(): Promise<LaunchCheck | undefined>
} {
  const [check, setCheck] = useState<LaunchCheck | undefined>()
  const controls = useRef(INERT_CHECKS)

  useEffect(() => {
    if (!enabled) return
    let mounted = true
    let running = false
    let again = false
    let issued = 0
    let shown = 0
    const checkNow = (): Promise<LaunchCheck | undefined> => {
      const seq = ++issued
      return engine
        .preflight(name)
        .catch(
          (err: unknown): LaunchCheck => ({ ok: false, message: messageOf(err), level: 'err' }),
        )
        .then((next) => {
          if (!mounted) return undefined
          if (seq > shown) {
            shown = seq
            setCheck((prev) => (prev !== undefined && sameCheck(prev, next) ? prev : next))
          }
          return next
        })
    }
    const refresh = () => {
      if (running) {
        again = true
        return
      }
      running = true
      void checkNow().then(() => {
        running = false
        if (again && mounted) {
          again = false
          refresh()
        }
      })
    }
    controls.current = { refresh, checkNow }
    refresh()
    return () => {
      mounted = false
      controls.current = INERT_CHECKS
    }
  }, [engine, name, enabled])

  const refresh = useCallback(() => controls.current.refresh(), [])
  const checkNow = useCallback(() => controls.current.checkNow(), [])
  return { check, refresh, checkNow }
}

/** What `useLaunchCheck` does for a chain that failed to load, and after unmount. */
const INERT_CHECKS: { refresh(): void; checkNow(): Promise<LaunchCheck | undefined> } = {
  refresh: () => {},
  checkNow: () => Promise.resolve(undefined),
}

function load(engine: DetailEngine, name: string): Loaded {
  try {
    return { chain: engine.chain(name) }
  } catch (err) {
    if (err instanceof RensaError) return { error: err }
    throw err
  }
}

/**
 * The run input for what is in the box: `undefined` when there is
 * nothing to start with (an empty box), `missing` for a file path that
 * does not exist. A file path is relative to the repository root.
 */
function runInputFor(
  chain: ResolvedChain,
  value: string,
  root: string,
): RunInput | { missing: string } | undefined {
  switch (chain.input) {
    case 'none':
      return { kind: 'none' }
    case 'text':
      return value.trim() === '' ? undefined : { kind: 'text', text: value }
    case 'file': {
      const relative = value.trim()
      if (relative === '') return undefined
      const file = path.resolve(root, relative)
      return existsSync(file) ? { kind: 'file', path: file } : { missing: relative }
    }
  }
}

function sameCheck(a: LaunchCheck, b: LaunchCheck): boolean {
  return a.ok === b.ok && a.message === b.message && a.level === b.level
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** A multi-line description or message folded onto its row. */
function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim()
}
