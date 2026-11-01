# 11 TUI foundation

## Goal

The Ink application shell every screen builds on: the terminal
session, sizing and layout, theme, header, key routing, screen
navigation, the store, and the bridge that turns engine events into
coalesced store updates without holding transcripts in React state.
After this step `rensa` opens in inline or fullscreen mode, shows the
header and an empty body, resizes without tearing, and quits cleanly,
and no way of dying short of `SIGKILL` (crash, `SIGTERM`, accepted
ctrl+c, startup failure, uncaught exception) leaves the terminal in
raw mode, with a hidden cursor, or on the alternate screen.

## Context

Steps 01–10 merged. Screens are specified in steps 12–14; this step
builds only what they share. The architecture rule applies: this
directory imports the engine only through `src/engine/index.ts`. Where
this step adds to the engine (the ring buffer, `RunHandle.transcript`),
it does so inside `src/engine/` with no Ink import, the way step 13
adds `preflight()`.

Ink is pinned at 8.0.0 with React 19.3.x (index.md, "Pinned
versions"). The facts this step relies on: `render()` accepts
`alternateScreen`, `incrementalRendering`, `maxFps`, `exitOnCtrlC` and
`patchConsole`; hooks `useWindowSize`, `useAnimation`, `useCursor`,
`usePaste`, `useInput`, `useBoxMetrics` exist; `Box` has
`backgroundColor` (fills the interior, excluding borders), `overflow`,
`contentOffsetX`/`contentOffsetY` and border background colors; Ink
installs its own process-exit cleanup and, in alternate-screen mode,
discards all output produced during teardown. `ink-spinner` and
`ink-text-input` are not used (step 01 note).

### Notes from steps 05 and 08

`readEvents` passes events with an unknown `type` through untouched
(forward compatibility with newer runs). Step 08's `reduceSteps` and
`applyEvent` already skip those; this step must not reinterpret events
itself. Nothing under `src/tui/` switches on an event `type`: state
comes from `applyEvent` and `reduceRun`, transcript content from the
engine-owned ring buffers.

## Files to create

```
src/tui/app.tsx                          root: SizeContext provider, Layout, screen router
src/tui/theme.ts
src/tui/terminalSession.ts               mode resolution, render options, normal quit, fatal restore
src/tui/layout.ts                        pure layoutBudget(); compact-mode thresholds
src/tui/components/Layout.tsx            header / body / footer slots with row budgets; clipping
src/tui/size.tsx                         SizeContext: bounds (immediate) and settledColumns (50 ms)
src/tui/store.ts                         createStore, useStore
src/tui/batch.ts                         coalesces engine events into one setState per 50 ms
src/tui/engineBridge.ts                  RunView: engine events → store via step 08's applyEvent
src/tui/components/Header.tsx
src/tui/components/Rule.tsx
src/tui/components/Frame.tsx             the rounded box used on the detail screen
src/tui/components/Spinner.tsx           leaf on useAnimation
src/tui/components/Elapsed.tsx           leaf on its own 1 s interval
src/tui/components/InputBox.tsx          useInput + usePaste + useCursor; shared by steps 13 and 14
src/tui/hooks/useKeys.ts
src/tui/format.ts                        elapsed formatter only; step 14 adds the rest
src/engine/run/ringBuffer.ts             engine-owned bounded buffer with absolute indices
src/cli/main.ts                          wire `rensa`, `rensa <chain>`, `--fullscreen`, `--inline`
src/cli/args.ts                          add the two mode flags
src/tui/store.test.ts
src/tui/batch.test.ts
src/tui/engineBridge.test.ts
src/tui/layout.test.ts
src/tui/components/Layout.test.tsx
src/tui/size.test.tsx
src/tui/components/Elapsed.test.tsx
src/tui/components/InputBox.test.tsx
src/engine/run/ringBuffer.test.ts
test/e2e/tui-session.test.ts             PTY tests (node-pty, dev dependency added here)
```

Tests that render components use `ink-testing-library` if step 01's
smoke test passed under Ink 8, else the `Writable` frame collector
recorded there; this file says "render" for either.

## theme.ts

```ts
export const theme = {
  text: '#e6e6e6',        // primary copy
  muted: '#9a9a9a',       // secondary copy: descriptions, agent rows
  dim: '#5c5c5c',         // borders, rules, inactive markers
  faint: '#3a3a3a',       // separators inside panes
  accent: '#d9b86a',      // running step, selection
  ok: '#7fb77e',
  err: '#d47a7a',
  warn: '#d9b86a',
  background: '#121212',  // fullscreen root only; see step 14 rule D
  selection: '#2a2a2a',   // background of the selected row or panel
} as const
```

One file, hex only, consumed through `<Text color={theme.x}>` and
`<Box backgroundColor={theme.x}>`. Painting rules are step 14's rule
D and apply from this step on: `background` goes on the fullscreen
root `Box` and nowhere else; inline mode paints no root background;
explicit backgrounds only on selected rows or panels.

## Terminal session (terminalSession.ts)

One startup function configures Ink. There is no hand-written
alternate-screen code and no `fullscreen-ink`.

```ts
export type Mode = 'inline' | 'fullscreen'
export function resolveMode(flags: { fullscreen?: boolean; inline?: boolean }, env: NodeJS.ProcessEnv): Mode
export function startSession(mode: Mode, app: React.ReactElement): Session
interface Session {
  quit(): Promise<void>        // normal quit; see below
  readonly done: Promise<void> // resolves when quit() has finished; never rejects
}
```

```ts
render(<App mode={mode} />, {
  alternateScreen: mode === 'fullscreen',
  incrementalRendering: true,     // both modes, from the first frame
  maxFps: 20,
  exitOnCtrlC: false,             // the app owns ctrl+c (useKeys)
  patchConsole: false,            // see main.ts wiring
})
```

- **Mode.** `--fullscreen` / `--inline` are resolved once at startup
  by `resolveMode`; both given is a usage error (exit 64). The default
  is inline until step 11b decides; `resolveMode` is the one place that
  default lives, so 11b changes one line (and may add a
  `TERM_PROGRAM` rule there). When stdout is not a TTY the mode is
  inline regardless of flags.
- **Incremental rendering** is on in both modes from the first
  measurement. Ink 8 repaints only changed lines and skips unchanged
  prefixes, which is what makes the fullscreen layout viable without a
  renderer swap; 11b measures whether it is enough.
- **Cleanup is registered before rendering**, including for the
  startup-failure path: `startSession` registers the fatal restore
  through step 06's `onShutdown` (re-exported by the engine index) as
  its first statement, then calls `render`. If `render` itself throws,
  the registered restore runs on exit and finds nothing acquired, so it
  emits nothing.
- **Ownership is explicit.** The session keeps a record of what this
  process acquired: `{ rendered: boolean; alternateScreen: boolean; rawMode: boolean }`.
  `alternateScreen` is set true only when `mode === 'fullscreen'` and
  stdout is a TTY and `render` returned; `rawMode` when stdin is a TTY
  and `render` returned (the root always mounts `useInput`, which puts
  stdin in raw mode). Restoration consults this record and nothing
  else: it never counts or inspects signal listeners, Ink's or anyone
  else's, and never emits the alternate-screen exit sequence in inline
  mode or when stdout is not a TTY.
- **Normal quit** (`esc`/`ctrl+c` accepted, or the app deciding to
  exit): `quit()` stops the engine subscriptions and the batcher,
  clears every interval owned by the UI, calls `instance.unmount()`,
  then `await instance.waitUntilExit()`, marks the record as released,
  resolves, and resolves `done`. `quit()` is idempotent: a second call
  returns the same promise. Components call `quit()`; `main.ts` never
  does. It awaits `session.done`, which is how it learns the app has
  exited without knowing why, and only then prints any final
  diagnostics to stderr, so they land on the primary screen after Ink
  has restored it, never inside the alternate screen where Ink would
  discard them. `done` is a promise created in `startSession` and
  settled only by `quit()`; a fatal exit never reaches it, since the
  process is gone.
- **Fatal exit** (uncaught exception, `SIGTERM`, `process.exit` from
  anywhere): the `onShutdown` callback runs synchronously. It calls
  `instance.unmount()` if an instance exists and `rendered` is set,
  which is Ink's own synchronous teardown and must run first so the
  primary screen is not restored while Ink may still flush a frame;
  in alternate-screen mode Ink discards output produced during this
  teardown. Then it restores, idempotently, only what the record still
  marks acquired and Ink may not have reached: `setRawMode(false)` if
  `rawMode`, `\x1b[?1049l` if `alternateScreen`, then `\x1b[?25h` and
  `\x1b[0m` if `rendered`. Each write clears its flag so a second run
  emits nothing. Because step 06's registry runs callbacks LIFO and
  this one is registered last (after the engine's), the terminal is
  sane before children are killed, the lock is released, and the
  uncaught exception's stack is printed by the registry's handler.
- **`SIGKILL`** has no guarantee; say so in the README (step 17).

## Sizing (size.tsx, layout.ts, Layout.tsx)

`useWindowSize()` is called exactly once, in `app.tsx`, and published
through `SizeContext` as two values:

```ts
interface Size {
  columns: number; rows: number      // current bounds: applied immediately to layout and clipping
  settledColumns: number             // last width unchanged for 50 ms: the only width used for wrapping
}
```

- **Bounds are immediate.** Every `Box` width and height, every clip,
  and the layout budget follow `columns`/`rows` on the same frame as
  the resize event. There is no blanket debounce on dimensions.
- **Wrap width settles.** `settledColumns` updates only after 50 ms
  without a further width change, and that update is what triggers
  step 14's rewrap. Height-only changes never touch it, so a vertical
  resize adjusts the visible window without invalidating any wrapping.
  This is the one place the word "debounce" applies in the TUI.
- **During the transition** (bounds moved, width not yet settled),
  previously wrapped rows are shown clipped to the new pane: each
  pre-wrapped line renders as `<Text wrap="truncate">` inside a `Box`
  with `overflow="hidden"`, so Ink neither re-wraps nor overflows them.
  When the width settles, step 14's viewport rewraps and the rows
  replace themselves.
- **`Layout`** has `header`, `body` and `footer` slots. Header and
  footer declare explicit row budgets (`headerRows`, `footerRows`);
  the body gets `max(0, rows − headerRows − footerRows)`. In
  fullscreen mode `Layout` is sized to `rows`; in inline mode it takes
  `min(rows, needed)` so the frame never exceeds the terminal. Both
  columns of a two-column body, and their contents, are clipped with
  `overflow="hidden"`. The left column's width is a budget, not a
  wish: `min(longestId + 6, floor(columns × 0.35))`, so long step names
  cannot consume the transcript's width; ids wider than the budget
  truncate with `…`.
- **`layoutBudget`** is a pure function in `layout.ts`:

  ```ts
  export function layoutBudget(size: { columns: number; rows: number }, want: { headerRows: number; footerRows: number; leftIdWidth?: number }): Budget
  interface Budget { headerRows: number; bodyRows: number; footerRows: number; leftCols: number; rightCols: number; compact: 'none' | 'narrow' | 'short' }
  ```

  Compact presentation is defined, not improvised: `columns < 60` →
  `narrow`: the left column is dropped and the body shows a one-line
  strip `step 3/6 implement` above the right column; `rows < 10` →
  `short`: the header collapses to its first line (no rule), the
  footer collapses to one row, and if the body would still be under 3
  rows the body shows only the status line. Both can hold at once; the
  budget never returns a negative number and never lets a slot
  overflow its rows.

## Header.tsx

```
⎇ feat/quote-limits (in place)  ~/Repos/trezor-suite              tdd-review
──────────────────────────────────────────────────────────────────────────
```

Props: `branch`, `mode?: 'in place'`, `path` (home-relative), `right?`.
Left part in `text`, mode in `muted`, path in `muted`, right in `text`,
rule in `dim`. Width from `SizeContext.columns`, so it follows a
resize immediately; it wraps nothing, so it never needs the settled
width. In `short` compact mode the rule is omitted.

## Screen router (app.tsx)

```ts
type Screen = { name: 'chains' } | { name: 'detail'; chain: string } | { name: 'run'; chain: string; run: RunHandle }
```

State lives in `app.tsx`; screens receive `navigate(screen)`. `esc` on
detail returns to chains; `esc` on run returns to chains while the run
continues (the handle stays in app state). `ctrl+c`: if a run is
active, show a one-line confirmation `abort the run? y/n`; `y` aborts
and quits; otherwise quit. Quitting means calling the session's
`quit()`, never `process.exit` from inside a component. `rensa <chain>`
starts on the detail screen.

The root renders `<SizeProvider><Layout mode={mode} …/></SizeProvider>`
and, in fullscreen mode only, a root `Box` with
`backgroundColor={theme.background}` sized to the window; Ink fills
interior gaps and empty body space from it (step 14 rule D).

Engine is opened once in `main.ts` before rendering; open errors
(`NOT_A_REPO`) print to stderr and exit 1 without Ink. See "main.ts
wiring" for the order, which is deliberate.

## useKeys.ts

A thin wrapper over Ink's `useInput` that maps raw input into named
actions so screens never test key codes:

```ts
type Action = 'up' | 'down' | 'left' | 'right' | 'pageUp' | 'pageDown' | 'top' | 'bottom'
  | 'enter' | 'esc' | 'follow' | 'pause' | 'kill' | 'quit' | 'recheck'
export function useKeys(handler: (a: Action, raw: { input: string; key: Key }) => void, opts?: { active?: boolean }): void
```

Mapping: arrows; `shift+↑/↓` → pageUp/pageDown; `shift+←/→` → top/bottom;
`fn` arrows arrive as pageUp/pageDown and are mapped the same; `enter`;
`escape`; `ctrl+f` follow; `ctrl+p` pause; `ctrl+x` kill; `ctrl+c`
quit; `ctrl+r` recheck. Anything else is passed through `raw` for text
inputs. Ink runs with `exitOnCtrlC: false` so the app owns ctrl+c.

### Input priority over streams

Keystrokes must land during token bursts. Stock Ink cannot set React
lane priority, but the same effect falls out of how the two inputs
reach the store: engine events are coalesced through the 50 ms batcher
(`batch.ts`), key handling is not. Rules, for this step and every
screen after it:

- A key handler runs synchronously inside `useInput` and applies its
  state change before it returns: selection, viewport anchor, follow
  flag, tool expansion, input-box text, the `pausing after <step>`
  and `kill <step>? y/n` interim states. Whether that state is a
  `useState` in the screen or a field in a store, the write happens in
  the handler itself, so React schedules the render for the next frame
  regardless of how many engine events are waiting in the batcher.
- Never `await` inside a key handler. Engine commands (`pause`,
  `resume`, `kill`, `abort`, `note`, `start`) are called synchronously
  and their results are not awaited there; the engine reports the
  outcome through `'event'`, which arrives via the batcher like any
  other event. A handler that needs a promise's result (step 13's
  `start`) sets an interim state synchronously and lets a `.then`
  update it later.
- Never route key-driven state through the batcher, and never write
  key-driven state into `RunState`, whose updates are batched. The
  batcher is for engine streams only.
- Handlers never write to the ring buffers or `RunView.events`; they
  read them if needed, nothing more.

### Event classification: discrete, continuous, stream

Claude Code sorts terminal events into discrete, continuous and
default classes before React sees them and schedules each class
differently. Stock Ink gives no hook for lane priority, so what is
left of that idea here is a documented rule per class, each already
specified elsewhere in this step:

| class | events | handling | where |
|---|---|---|---|
| discrete | keystrokes, paste | synchronous, never coalesced, never behind a throttle | "Input priority" above |
| continuous | terminal resize | bounds applied immediately; wrap width settles after 50 ms quiet | "Sizing" above |
| stream | engine `'event'` and `'transcript'` | batched into one `setState` per 50 ms window | `batch.ts` |

The classes never share a queue: a resize does not flush the stream
batcher, a keystroke does not wait for a width to settle, and a burst
of events delays neither.

## ringBuffer.ts (engine, `src/engine/run/ringBuffer.ts`)

```ts
export class RingBuffer<T> { constructor(capacity: number); push(item: T): void; get(index: number): T | undefined; slice(from: number, to: number): T[]; readonly start: number; readonly length: number }
```

A bounded append-only buffer and nothing more: no version counter, no
listeners. Indices are absolute, counted from the first push: `length`
is the total ever pushed, `start` the oldest index still retained, and
`get`/`slice` return nothing for evicted indices. Step 14's viewport
keys its wrap cache and its rows on these indices, so eviction never
shifts a key. Capacity 5000 records per transcript.

The buffers are **engine-owned**, as `CLAUDE.md` requires ("the UI
renders slices of engine-owned buffers on a throttle"). This step adds
to `RunHandle` in `src/engine/run/runner.ts`:

```ts
interface RunHandle {
  // … step 08 …
  transcript(step: string, label: string): RingBuffer<TranscriptRecord>   // created on first use
  partial(step: string, label: string): string | undefined               // current streaming line
}
```

The runner pushes every final record into the buffer and updates the
partial slot *before* emitting `'transcript'`, so a consumer woken by
the event reads a buffer that already holds it. The headless CLI keeps
ignoring the buffers and printing from the event. Export `RingBuffer`
and its type from `src/engine/index.ts`; the TUI never constructs one
for a live run, only for the from-disk case in step 14.

## store.ts

All live UI state outside React lives in one small external store,
the shape Claude Code uses for its whole app state. This is the whole
file, give or take types:

```ts
export interface Store<S> { getState(): S; setState(up: (s: S) => S): void; subscribe(f: () => void): () => void }

export function createStore<S>(initial: S): Store<S> {
  let state = initial
  const subs = new Set<() => void>()
  return {
    getState: () => state,
    setState: (up) => { const n = up(state); if (Object.is(n, state)) return; state = n; subs.forEach((f) => f()) },
    subscribe: (f) => { subs.add(f); return () => subs.delete(f) },
  }
}

export function useStore<S, T>(store: Store<S>, selector: (s: S) => T): T
```

- `setState` skips notification when the updater returns the same
  reference (`Object.is`). Everything that feeds the store must return
  the previous object untouched when nothing changed and a new object
  otherwise; step 08's `applyEvent` is built to that contract.
- `useStore` is `useSyncExternalStore(store.subscribe, () => selector(store.getState()))`
  with the selector held in a ref so an inline arrow does not
  resubscribe every render. React compares the selector's result with
  `Object.is` and re-renders only when it changed, so selectors return
  values held in state (the steps `Map`, one `StepView`, a status
  string, one version integer), never fresh objects or arrays.
- No Ink or engine import; React only, for the hook.

## batch.ts

```ts
export function createBatcher<T>(flush: (items: T[]) => void, ms = 50): { push(item: T): void; flushNow(): void; dispose(): void }
```

The 50 ms coalescing lives on the input side, on the `setState` calls
driven by engine events, not on the store or on `subscribe`. The
bridge pushes every engine event into a batcher; the first item in a
quiet period flushes at once, items arriving within the next `ms`
collect and flush together at the window's end as one `setState`.
React therefore sees at most ~20 state changes per second however
fast events stream, matching `maxFps: 20`, and the store stays a plain
synchronous store whose notifications are never delayed or dropped.
`flushNow` is for `dispose` and tests. No run or step knowledge here.

## engineBridge.ts

Translates the engine's streams into the store; it holds no
interpretation logic and no transcript content:

```ts
interface RunState {
  progress: RunProgress                        // status, currentStep, pausedAt, failedStep, timestamps (step 08)
  steps: Map<string, StepView>                 // step 08's applyEvent output
  transcriptVersions: Map<string, number>      // key `${step}/${label}` → bump count
}

class RunView {
  constructor(handle: RunHandle, engine: Engine, chainSteps: ReadonlyArray<{ id: string; kind: 'agent' | 'shell' }>)
  readonly store: Store<RunState>
  readonly events: RunEvent[]                                   // append-only, not in the store
  transcript(step: string, label: string): RingBuffer<TranscriptRecord>   // handle.transcript, or the from-disk buffer
  partial(step: string, label: string): string | undefined
  dispose(): void
}
```

- `store` starts as `{ progress: { status: 'running' }, steps: initialSteps(chainSteps), transcriptVersions: new Map() }`.
- Engine `'event'` and `'transcript'` arrivals are pushed into one
  batcher as a tagged union. The engine has already written the record
  or delta into its buffer before emitting, so the bridge stores
  nothing; what the batcher defers is only the store update.
- The batcher's `flush(items)` does one `setState(prev => …)` for the
  whole batch: fold the run events through `applyEvent` into `steps`,
  recompute `progress` with `reduceRun(this.events)`, and for every
  transcript key that received a record or a delta in the batch, copy
  `transcriptVersions` with that key's counter incremented. If no
  `Map` changed and `progress` is deep-equal to the previous one,
  return `prev`: a batch of only `user.note` events or unknown types
  renders nothing.
- Why versions in the store rather than on the buffer: a selector
  `s => s.transcriptVersions.get(key)` returns an integer, so a text
  delta bumps one integer and only the pane subscribed to that key
  re-renders; the step list, which selects `s.steps`, sees the same
  `Map` reference and stays put.
- `events` is kept outside the store because appending to it changes
  every time; nothing renders the raw list.
- `step.finished` and `run.finished` arrive through `'event'` like
  everything else; the bridge never awaits `handle.done` to learn
  state.
- Step 14's finished-run-from-disk case builds the same `RunState` with
  `reduceSteps(events, chainSteps)` and `reduceRun(events)` over
  `readEvents`, fills its own `RingBuffer`s from `readTranscript`, and
  sets every key's version to 1; the screens cannot tell the two apart.

## Spinner.tsx and Elapsed.tsx

Animation is split from state. There is no `useTick`; the only things
that tick are two memoized leaf components, and nothing above a leaf
re-renders on a tick:

```ts
export const Spinner: React.FC<{ color?: string }>                                 // braille frames via useAnimation
export const Elapsed: React.FC<{ since: string; until?: string; color?: string }>  // `m:ss`, `h:mm:ss` past an hour; own 1 s interval
```

- `Spinner` takes its frame from Ink 8's `useAnimation` at 80 ms per
  frame, so its ticks ride Ink's own animation scheduling inside the
  `maxFps` budget rather than a hand-rolled `setInterval`; it has no
  changing props.
- `Elapsed` owns a 1 s `setInterval` in an effect and clears it on
  unmount. With `until` set it renders the fixed difference and runs no
  interval; the parent passes `finishedAt` once the step or run is done
  and the cell freezes with no further timer.
- Both are `React.memo`. Agent rows (step 14) and the status line
  compose these cells; a row re-renders only when the `StepView` or
  `AgentView` it selects changes, not once per second. This is the
  same split Claude Code uses, where moving the spinner into its own
  component took the parent from hundreds of re-renders per turn to a
  few dozen.
- Both read the elapsed formatter from `src/tui/format.ts` (this step
  creates the file with only that helper; step 14 adds the rest).
  Nothing else in the UI polls.

## InputBox.tsx

```ts
export const InputBox: React.FC<{ value: string; onChange(v: string): void; onSubmit(v: string): void; placeholder?: string; active: boolean; width: number }>
```

A one-row framed text input built on Ink 8 primitives, used by step
13's input area and step 14's note box; `ink-text-input` is not a
dependency. `useInput` for printable characters, backspace, delete,
left/right, home/end (`active` false → the hook is inactive and the
box renders dim); `usePaste` so a multi-line paste arrives as one
change with newlines collapsed to spaces, instead of one `useInput`
call per character; `useCursor` to place the terminal cursor at the
caret so the terminal's own cursor is the caret (no painted caret
character). Text longer than `width − 4` scrolls horizontally to keep
the caret visible. `enter` calls `onSubmit` synchronously (the input
priority rules apply). `Frame` draws the border; the box paints no
background unless it is the focused panel (step 14 rule D).

## main.ts wiring

`rensa` with no args and `rensa <chain>` render the app; everything
else unchanged from step 09 except the two new flags. The order inside
the TUI branch matters:

```ts
const opening = Engine.open(process.cwd())            // first: provider subprocesses start now
const [engine, tui] = await Promise.all([opening, import('./tui/app.js')])
const session = tui.start(engine, initialScreen, resolveMode(flags, process.env))   // registers restore, then render()
await session.done                                     // resolves after quit(): unmount + waitUntilExit
// only now: final diagnostics to stderr, if any
```

- `Engine.open` is the very first statement after argument parsing.
  Its provider check spawns three subprocesses, and `open` starts them
  before its first `await` (step 08), so they are running from here on.
- Ink and React are loaded through a dynamic `import('./tui/app.js')`
  created right after, never through a static import in `main.ts`.
  Node resolves and evaluates that module graph while the subprocesses
  run; with a static import the two would be serial. It also keeps Ink
  out of `rensa run` and `rensa doctor` entirely. `src/tui/app.tsx`
  exports `start(engine, screen, mode)`; `main.ts` is the only place
  that imports it. tsdown emits the dynamic import as its own chunk
  next to `dist/cli/main.js`; the step 09 e2e tests already run the
  built CLI and catch a broken chunk path.
- `open` rejecting (`NOT_A_REPO`) prints the error and exits 1 before
  anything is rendered, even if the Ink import already finished; no
  alternate screen is entered, so nothing needs restoring.
- `open` resolves before the provider check completes. The app renders
  its first frame at once with `engine.providers()` undefined, and
  re-renders when the engine emits `'providers'`. Nothing in the TUI
  awaits `providersChecked`; step 12 specifies the checking state.
- `patchConsole: false`: with the default, Ink intercepts `console.*`
  and re-renders the frame to splice the output above it; one stray
  `console.log` from a dependency during a token burst then stalls a
  frame. With it off, such output goes straight to stdout (above the
  inline frame; inside the alternate screen in fullscreen mode, where
  it is overwritten on the next repaint), and nothing in `src/tui/` or
  `src/engine/` calls `console.*` anyway: enable biome's `noConsole`
  rule for those two directories in this step (step 01 did not), with
  `src/cli/` exempt since the headless CLI writes to stdout on purpose.

## Tests

- `RingBuffer` (engine): push, get, slice, length, and eviction past
  capacity: after pushing `capacity + 3` items, `start` is 3, `length`
  is `capacity + 3`, `get(2)` is undefined and `get(3)` is the fourth
  item. Runner: after a fake-provider run, `handle.transcript(step,
  label)` holds exactly the records `readTranscript` returns, in
  order, and the buffer held the record before the matching
  `'transcript'` event fired (assert inside the listener).
- `store`: `setState` with an updater returning `prev` notifies no
  listener; with a new object it notifies each listener once;
  `unsubscribe` stops notifications; `useStore` with a selector
  re-renders a test component only when the selected value changes.
- `batch`: 1000 pushes in a loop produce one immediate flush and one
  trailing flush carrying the other 999 items in order; over a
  fake-timer second of continuous pushes at most ~20 flushes;
  `flushNow` delivers pending items synchronously.
- Bridge: feeding a recorded fake-provider event sequence then
  `flushNow` yields `steps` equal to `reduceSteps(events, chainSteps)`
  and `progress` equal to `reduceRun(events)` (the reducer itself is
  tested in step 08); a batch of only `user.note` events leaves
  `store.getState()` the same reference and notifies nobody; a
  transcript event for `a/tester` bumps only that key's version and
  leaves `steps` the same reference.
- `layoutBudget`: 120×40 → no compact, body = rows − header − footer,
  left column capped at 35 %; 50×24 → `narrow`; 80×8 → `short`;
  40×6 → both; no output is negative at 1×1; `leftIdWidth` 60 at 100
  columns yields `leftCols` 35.
- `Layout` (render): at normal, narrow and very short sizes the frame
  has exactly `rows` lines in fullscreen and at most `rows` inline;
  header and footer occupy their budgets; a step id longer than the
  left budget is truncated with `…` and the right column keeps its
  width. Then a **live transition**, not two snapshots: start at
  120×40, emit a resize to 60×40, and assert on the very next frame
  that bounds changed (left column narrower, rows clipped) while the
  pre-wrapped rows passed to the body are unchanged and truncated, then
  advance 50 ms and assert `settledColumns` updated once. Grow back to
  120×40 the same way. A height-only resize (120×40 → 120×20) must
  never change `settledColumns`.
- `size`: five width changes 10 ms apart yield one `settledColumns`
  update 50 ms after the last; `columns`/`rows` update on each; a
  height-only change leaves `settledColumns` alone.
- `Spinner`/`Elapsed`: `Elapsed` with `since` 90 s ago renders `1:30`
  and `1:31` after one fake-timer second; with `until` set it renders
  the fixed value and schedules no interval; a parent re-render with
  the same props does not re-render the memoized leaf (render-count
  probe). `Spinner` changes frame across an `useAnimation` tick and
  unmounts cleanly.
- `InputBox`: typing, backspace, home/end, a pasted `"a\nb"` arriving
  as one `onChange('a b')`, `enter` calling `onSubmit` with the value,
  a value longer than the width scrolling to keep the caret visible,
  inactive box ignoring input.
- `terminalSession` (unit): `done` is pending until `quit()` is called
  and resolved after it; a second `quit()` returns the same promise and
  unmounts once. `resolveMode` for each flag combination,
  both flags → usage error, non-TTY → inline; the fatal restore with a
  fake stdout/stdin and a stub instance: in fullscreen it calls
  `unmount` first, then emits `?1049l`, `?25h`, `0m`, and a second
  invocation emits nothing; in inline mode it never emits `?1049l`;
  before `render` returned it emits nothing.
- `terminalSession` (PTY, `test/e2e/tui-session.test.ts`, `node-pty`
  as a dev dependency, needs `npm run build`): each scenario runs the
  built CLI inside `sh -c '<cli> …; stty -a; echo __DONE__'` in a
  pseudo-terminal of 100×30 so the shell reports the terminal state
  after exit. Scenarios, each in both modes unless noted: **normal
  quit** (send `esc`/`ctrl+c`), **accepted ctrl+c during a run**
  (fake chain, `ctrl+c` then `y`), **SIGTERM** (`process.kill(pid)`),
  **startup failure** (run in a non-repo directory), **uncaught
  exception** (`RENSA_CRASH=1`). Assertions: `stty -a` output contains
  `echo` and `icanon` (raw mode off); the byte stream contains
  `\x1b[?25h` after the last frame; in fullscreen the stream contains
  exactly one `\x1b[?1049h` and one `\x1b[?1049l`, and no header glyph
  `⎇` appears after `?1049l`; in inline mode `?1049h` never appears and
  no frame bytes follow the exit; the startup-failure case emits no
  `?1049h` at all and the error is on the primary screen; the crash
  case prints a readable stack after restoration. `SIGKILL` is not
  tested; it has no guarantee.
- `main.ts` has no static import of `src/tui/` or of `ink`: assert
  it with a small test that reads the file, or extend step 01's import
  boundary lint with that rule, whichever is less code.
- `render` is called with the five options above: assert on the
  options object passed to a mocked `ink.render`, in both modes.

## Verification (human)

`npm run build && node dist/cli/main.js` in this repo shows the header
with the branch and path and an empty body; `ctrl+c` exits; resizing
the terminal moves the frame on the same frame and re-wraps nothing
until the drag stops. Then `node dist/cli/main.js --fullscreen`: the
alternate screen is entered, the body fills the window with the theme
background, quitting returns the previous screen contents intact. The
first frame must appear before the provider line fills in; if the two
arrive together, the provider check is being awaited somewhere before
`render`. With the app open in each mode, `kill -TERM <pid>` from
another terminal, and separately run it with `RENSA_CRASH=1` (a
dev-only throw in `app.tsx` behind that variable, removed before step
17): every time the shell prompt comes back with echo and a visible
cursor on the primary screen, and the crash prints a readable stack
there. Note any flicker or tearing seen in fullscreen while a
transcript streams; step 11b is where that observation is recorded and
decided on.

## Out of scope

Any screen content; the fullscreen-versus-inline default (step 11b).
