import { Text } from 'ink'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import stringWidth from 'string-width'
import {
  type ResolvedChain,
  type RunDir,
  type RunHandle,
  type RunProgress,
  runBase,
  type Step,
} from '../../engine/index.js'
import type { Navigate } from '../app.js'
import { type AgentRowSpec, AgentRows, agentRowsHeight } from '../components/AgentRows.js'
import {
  EMPTY_INPUT,
  editInput,
  type InputState,
  isTypedCharacter,
} from '../components/editInput.js'
import { HEADER_ROWS, Header, type HeaderProps } from '../components/Header.js'
import { InputBox } from '../components/InputBox.js'
import { Layout } from '../components/Layout.js'
import { Ratchet } from '../components/Ratchet.js'
import { Row } from '../components/Row.js'
import { Rule } from '../components/Rule.js'
import { StatusLine } from '../components/StatusLine.js'
import { StepList } from '../components/StepList.js'
import { Transcript, type TranscriptControls } from '../components/Transcript.js'
import { loadRunDir, RunView, transcriptKey } from '../engineBridge.js'
import { type Action, type Focus, type RawKey, useKeys } from '../hooks/useKeys.js'
import { isShort, type LayoutWant } from '../layout.js'
import { useBudget, useSize } from '../size.js'
import { useStore } from '../store.js'
import type { Mode } from '../terminalSession.js'
import { theme } from '../theme.js'

/** A live run and its chain, or a run directory read back from disk (the history screen, deferred). */
export type RunScreenSource = { handle: RunHandle; chain: ResolvedChain } | { dir: RunDir }

export interface RunProps {
  source: RunScreenSource
  navigate: Navigate
  /** The app's quit path: the abort overlay while a run is live. */
  requestQuit(): void
  /** False while an app-level overlay holds the keys. */
  active: boolean
  mode: Mode
  /** The app's header; its branch is replaced by the run's base once known. */
  header: HeaderProps
  /** The app's quit overlay; takes the footer in place of the note box while it shows. */
  overlay?: { footer: ReactNode; rows: number }
}

/** The commands this screen sends; absent for a run read from disk. */
type RunCommands = Pick<RunHandle, 'pause' | 'resume' | 'kill' | 'note'>

/** Header slot: the app header, the status line, a blank row. */
const RUN_HEADER_ROWS = HEADER_ROWS + 2
/** Right-column header block besides the agent rows: step id, rule above and below them. */
const BLOCK_CHROME_ROWS = 3
/** The `step 3/6 implement` strip in `narrow` mode. */
const STRIP_ROWS = 1
/** The note box: border, one row of text, border; one bare row in `short` compact mode. */
const INPUT_ROWS = { frame: 3, line: 1 } as const
const NOTE_PLACEHOLDER = 'note for the next steps…'
const NO_EXPANDED: ReadonlySet<number> = new Set()

/**
 * The run screen: steps on the left, the selected step's agent row and
 * transcript on the right, the note box below. The same screen for a
 * live run and, with no commands, for a finished one read from disk.
 */
export function Run(props: RunProps): ReactNode {
  const { source, ...rest } = props
  if ('handle' in source) return <LiveRun handle={source.handle} chain={source.chain} {...rest} />
  return <DiskRun dir={source.dir} {...rest} />
}

type ScreenProps = Omit<RunProps, 'source'>

/** A live run: its `RunView` lives as long as the screen, then detaches; the run keeps going. */
function LiveRun(props: ScreenProps & { handle: RunHandle; chain: ResolvedChain }): ReactNode {
  const { handle, chain, ...rest } = props
  const [view] = useState(() => new RunView(handle, chain.steps))
  useEffect(() => () => view.dispose(), [view])
  return <RunScreen view={view} chain={chain} commands={handle} {...rest} />
}

type DiskState =
  | { kind: 'loading' }
  | { kind: 'loaded'; view: RunView; chain: ResolvedChain }
  | { kind: 'error'; message: string }

/** A run read back from its directory once; it takes no commands. */
function DiskRun(props: ScreenProps & { dir: RunDir }): ReactNode {
  const { dir, ...rest } = props
  const [state, setState] = useState<DiskState>({ kind: 'loading' })
  useEffect(() => {
    let live = true
    let view: RunView | undefined
    loadRunDir(dir).then(
      ({ source, chain }) => {
        if (!live) return
        view = new RunView(source, chain.steps)
        setState({ kind: 'loaded', view, chain })
      },
      (err: unknown) => {
        if (live)
          setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
      },
    )
    return () => {
      live = false
      view?.dispose()
    }
  }, [dir])
  if (state.kind === 'loaded') return <RunScreen view={state.view} chain={state.chain} {...rest} />
  return <DiskPlaceholder state={state} {...rest} />
}

/** Until the directory is read, or when it cannot be: one line, `esc` back. */
function DiskPlaceholder(
  props: ScreenProps & { state: Exclude<DiskState, { kind: 'loaded' }> },
): ReactNode {
  const { state, navigate, requestQuit, active, mode, header } = props
  useKeys(
    (action) => {
      if (action === 'quit') requestQuit()
      else if (action === 'esc') navigate({ name: 'chains' })
    },
    { active },
  )
  return (
    <Layout
      mode={mode}
      header={<Header {...header} />}
      headerRows={HEADER_ROWS}
      body={
        state.kind === 'error' ? (
          <Text color={theme.err} wrap="truncate-end">{`  ! ${state.message}`}</Text>
        ) : undefined
      }
    />
  )
}

/** A value for rendering and a synchronous reader, so two keys before a render see each other. */
function useSyncState<T>(initial: T): [T, () => T, (next: T) => void] {
  const [state, setState] = useState(initial)
  const ref = useRef(state)
  const get = useCallback(() => ref.current, [])
  const set = useCallback((next: T) => {
    ref.current = next
    setState(next)
  }, [])
  return [state, get, set]
}

function RunScreen(
  props: ScreenProps & { view: RunView; chain: ResolvedChain; commands?: RunCommands },
): ReactNode {
  const { view, chain, commands, navigate, requestQuit, active, mode, header, overlay } = props
  const steps = chain.steps
  const progress = useStore(view.store, (s) => s.progress)
  const [base] = useState(() => runBase(view.events))

  // Key-driven state: written in the key handler, read back synchronously.
  const [following, getFollowing, setFollowing] = useSyncState(true)
  const [chosen, getChosen, setChosen] = useSyncState<string | undefined>(undefined)
  const [focus, getFocus, setFocus] = useSyncState<Focus>('main')
  const [input, getInput, setInput] = useSyncState<InputState>(EMPTY_INPUT)
  // The tool cursor belongs to one transcript; on any other it is ignored, whatever moved the selection.
  const [cursor, getCursor, setCursor] = useSyncState<ToolCursor | undefined>(undefined)
  const [expanded, getExpanded, setExpanded] = useSyncState<
    ReadonlyMap<string, ReadonlySet<number>>
  >(new Map())
  const [killing, getKilling, setKilling] = useSyncState<string | undefined>(undefined)
  const focusBeforeConfirm = useRef<Focus>('main')
  const transcript = useRef<TranscriptControls>(null)

  // `kill <step>? y/n` names one step: once that step is no longer the running one, the question is moot.
  useEffect(() => {
    const named = getKilling()
    if (named === undefined) return
    if (progress.status === 'running' && progress.currentStep === named) return
    setKilling(undefined)
    setFocus(focusBeforeConfirm.current)
  }, [progress.status, progress.currentStep, getKilling, setKilling, setFocus])

  const enabled = noteBoxEnabled(commands, progress)
  // A finished run's note box is inert and never focused.
  const shownFocus: Focus = focus === 'input' && !enabled ? 'main' : focus
  const selected = shownStep(steps, following, chosen, progress)
  const target = selected === undefined ? undefined : paneOf(selected)
  const selectedKey = target === undefined ? undefined : transcriptKey(target.step, target.label)
  const rows = useMemo(() => (selected === undefined ? [] : agentRowSpecs(selected)), [selected])
  // The transcript the pane last drew: what `toolsInView()` describes.
  const drawnKey = useRef(selectedKey)
  drawnKey.current = selectedKey

  /** The key of the transcript shown now, from state as of this moment rather than the last render. */
  const shownKey = (): string | undefined => {
    const now = shownStep(steps, getFollowing(), getChosen(), view.store.getState().progress)
    if (now === undefined) return undefined
    const pane = paneOf(now)
    return transcriptKey(pane.step, pane.label)
  }

  /** The tools in view, when the pane on screen is the transcript shown now; none while it is not drawn yet. */
  const toolsShown = (key: string | undefined): number[] =>
    key !== undefined && key === drawnKey.current ? (transcript.current?.toolsInView() ?? []) : []

  const moveSelection = (delta: number) => {
    const now = shownStep(steps, getFollowing(), getChosen(), view.store.getState().progress)
    const index = now === undefined ? 0 : steps.indexOf(now)
    const next = steps[Math.min(Math.max(0, index + delta), steps.length - 1)]
    if (next === undefined) return
    setChosen(next.id)
    setFollowing(false)
    if (next !== now) setCursor(undefined)
  }

  const followRunning = () => {
    setFollowing(true)
    setCursor(undefined)
    const running = shownStep(steps, true, undefined, view.store.getState().progress)
    if (running === undefined) return
    const pane = paneOf(running)
    transcript.current?.follow(pane.step, pane.label)
  }

  /**
   * The tool cursor: `up`/`down` move it among the tool records in view.
   * A pragmatic MVP overload: these keys select the agent row, and with
   * one agent row per step (always, in the MVP) there is nothing to
   * select, so they move this secondary selection instead.
   */
  const moveCursor = (delta: number) => {
    const key = shownKey()
    const tools = toolsShown(key)
    if (key === undefined || tools.length === 0) {
      setCursor(undefined)
      return
    }
    const at = tools.indexOf(cursorOn(getCursor(), key) ?? Number.NaN)
    let next: number
    if (at < 0) next = delta > 0 ? 0 : tools.length - 1
    else next = Math.min(Math.max(0, at + delta), tools.length - 1)
    const record = tools[next]
    setCursor(record === undefined ? undefined : { key, record })
  }

  const toggleTool = (): boolean => {
    const key = shownKey()
    if (key === undefined) return false
    const record = cursorOn(getCursor(), key)
    if (record === undefined || !toolsShown(key).includes(record)) return false
    const all = getExpanded()
    const set = new Set(all.get(key) ?? NO_EXPANDED)
    if (set.has(record)) set.delete(record)
    else set.add(record)
    setExpanded(new Map(all).set(key, set))
    return true
  }

  const keyInMain = (action: Action | 'text', raw: RawKey, live: boolean) => {
    const status = view.store.getState().progress.status
    switch (action) {
      case 'left':
        moveSelection(-1)
        return
      case 'right':
        moveSelection(1)
        return
      case 'up':
        moveCursor(-1)
        return
      case 'down':
        moveCursor(1)
        return
      case 'pageUp':
      case 'pageDown':
      case 'top':
      case 'bottom':
        transcript.current?.scroll(action)
        return
      case 'enter':
        if (status === 'paused' && commands !== undefined) commands.resume()
        else toggleTool()
        return
      case 'esc':
        navigate({ name: 'chains' })
        return
      case 'text':
        if (live && isTypedCharacter(raw)) {
          setFocus('input')
          setInput(editInput(getInput(), raw))
        }
        return
      default:
        return
    }
  }

  const keyInInput = (action: Action | 'text', raw: RawKey) => {
    if (action === 'esc') {
      setFocus('main')
      return
    }
    if (action === 'enter') {
      const text = getInput().value
      if (text.trim() === '') return
      commands?.note(text)
      setInput(EMPTY_INPUT)
      setFocus('main')
      return
    }
    setInput(editInput(getInput(), raw))
  }

  // Synchronous throughout: every state change lands before the handler returns.
  useKeys(
    (action, raw) => {
      const now = view.store.getState().progress
      const live = noteBoxEnabled(commands, now)
      const current = getFocus() === 'input' && !live ? 'main' : getFocus()

      if (current === 'confirm') {
        // `quit` acts from any focus: the abort overlay takes the keys, so the kill question is dropped.
        // `follow` and `pause` act only in `main` and `input`; here, like any other key, they are ignored.
        if (action === 'quit') {
          setKilling(undefined)
          setFocus(focusBeforeConfirm.current)
          requestQuit()
          return
        }
        const yes = action === 'text' && raw.input === 'y'
        const no = action === 'esc' || (action === 'text' && raw.input === 'n')
        // `kill()` ends whatever step is running when it is called: only the step the prompt names.
        if (yes && now.status === 'running' && now.currentStep === getKilling()) commands?.kill()
        if (yes || no) {
          setKilling(undefined)
          setFocus(focusBeforeConfirm.current)
        }
        return
      }

      switch (action) {
        case 'quit':
          requestQuit()
          return
        case 'follow':
          followRunning()
          return
        case 'pause':
          // `pausing after <step>` comes back from the engine as `progress.pausing`.
          if (commands !== undefined && now.status === 'running') commands.pause()
          return
        case 'kill':
          if (commands !== undefined && now.status === 'running' && now.currentStep !== undefined) {
            focusBeforeConfirm.current = current
            setKilling(now.currentStep)
            setFocus('confirm')
          }
          return
        case 'recheck':
          return
        default:
          break
      }
      if (current === 'input') keyInInput(action, raw)
      else keyInMain(action, raw, live)
    },
    { active },
  )

  // Layout.
  const { columns, rows: terminalRows } = useSize()
  const inputVariant = isShort(terminalRows) ? 'line' : 'frame'
  const footerRows = overlay?.rows ?? INPUT_ROWS[inputVariant]
  const want: LayoutWant = {
    headerRows: RUN_HEADER_ROWS,
    footerRows,
    leftIdWidth: Math.max(0, ...steps.map((s) => stringWidth(s.id))),
  }
  const { current } = useBudget(want)
  const narrow = current.compact === 'narrow' || current.compact === 'both'
  const blockRows = BLOCK_CHROME_ROWS + agentRowsHeight(rows)
  const transcriptRows = Math.max(0, current.bodyRows - blockRows - (narrow ? STRIP_ROWS : 0))
  const borderBackground = mode === 'fullscreen' ? { borderBackgroundColor: theme.background } : {}

  const statusRow =
    killing !== undefined && shownFocus === 'confirm' ? (
      <Row width={columns}>
        <Text color={theme.warn}>{`  kill ${killing}? y/n`}</Text>
      </Row>
    ) : (
      <StatusLine runId={view.id} progress={progress} width={columns} />
    )

  const footer = overlay?.footer ?? (
    <InputBox
      state={input}
      onPaste={setInput}
      placeholder={NOTE_PLACEHOLDER}
      prompt="›"
      focused={active && shownFocus === 'input'}
      enabled={enabled}
      width={columns}
      variant={inputVariant}
      {...borderBackground}
    />
  )

  const shownCursor = selectedKey === undefined ? undefined : cursorOn(cursor, selectedKey)
  const index = selected === undefined ? -1 : steps.indexOf(selected)
  const strip = selected !== undefined && (
    <Row>
      <Text color={theme.muted}>{`step ${index + 1}/${steps.length} `}</Text>
      <Text color={theme.text}>{selected.id}</Text>
    </Row>
  )

  return (
    <Layout
      mode={mode}
      header={
        <>
          <Header {...header} branch={base ?? header.branch} />
          {statusRow}
          <Text> </Text>
        </>
      }
      headerRows={RUN_HEADER_ROWS}
      split={{
        left: (
          <StepList
            store={view.store}
            steps={steps}
            selected={selected?.id}
            detached={!following}
            width={current.leftCols}
          />
        ),
        leftIdWidth: want.leftIdWidth ?? 0,
        ...(strip !== false && { strip }),
      }}
      body={
        selected !== undefined &&
        target !== undefined && (
          <>
            <Ratchet>
              <Text color={theme.text} wrap="truncate">
                {selected.id}
              </Text>
              <Rule width={current.transcriptCols} color={theme.faint} />
              <AgentRows store={view.store} rows={rows} />
              <Rule width={current.transcriptCols} color={theme.faint} />
            </Ratchet>
            <Transcript
              ref={transcript}
              view={view}
              step={target.step}
              label={target.label}
              height={transcriptRows}
              width={current.transcriptCols}
              expanded={
                (selectedKey === undefined ? undefined : expanded.get(selectedKey)) ?? NO_EXPANDED
              }
              want={want}
              {...(shownCursor !== undefined && { cursor: shownCursor })}
            />
          </>
        )
      }
      footer={footer}
      footerRows={footerRows}
      status={statusRow}
    />
  )
}

/** A tool record under the cursor, in the transcript with this key. */
interface ToolCursor {
  key: string
  record: number
}

/** The cursor's record when it is on the transcript `key`; undefined on any other. */
function cursorOn(cursor: ToolCursor | undefined, key: string): number | undefined {
  return cursor?.key === key ? cursor.record : undefined
}

/** The note box takes text while the run is running or paused, and only on a live run. */
function noteBoxEnabled(commands: RunCommands | undefined, progress: RunProgress): boolean {
  return commands !== undefined && (progress.status === 'running' || progress.status === 'paused')
}

/**
 * The step on the right: while following, the running or paused step
 * (the first before any started); otherwise the one the user chose. A
 * finished run keeps its last step.
 */
function shownStep(
  steps: ReadonlyArray<Step>,
  following: boolean,
  chosen: string | undefined,
  progress: RunProgress,
): Step | undefined {
  const id = following ? progress.currentStep : (chosen ?? progress.currentStep)
  return steps.find((s) => s.id === id) ?? steps[0]
}

/** The transcript a step's pane shows: its agent's, or `shell`. */
function paneOf(step: Step): { step: string; label: string } {
  return { step: step.id, label: step.kind === 'agent' ? step.agent.label : 'shell' }
}

function agentRowSpecs(step: Step): AgentRowSpec[] {
  return step.kind === 'agent'
    ? [{ kind: 'agent', step: step.id, agent: step.agent }]
    : [{ kind: 'shell', step: step.id, command: step.command }]
}
