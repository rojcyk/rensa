# 11 TUI foundation

## Goal

The Ink application shell every screen builds on: theme, header, key
routing, screen navigation, and the bridge that turns engine events
into throttled React updates without holding transcripts in state.
After this step `rensa` opens, shows the header and an empty screen,
and quits cleanly, and no way of dying (crash, `SIGTERM`, `kill -9` of
a child, `process.exit` from anywhere) leaves the terminal in raw mode
or with a hidden cursor.

## Context

Steps 01–10 merged. Screens are specified in steps 12–14; this step
builds only what they share. The architecture rule applies: this
directory imports the engine only through `src/engine/index.ts`.

### Notes from steps 05 and 08

`readEvents` passes events with an unknown `type` through untouched
(forward compatibility with newer runs). Step 08's `reduceSteps` and
`applyEvent` already skip those; this step must not reinterpret events
itself. Nothing under `src/tui/` switches on an event `type`: state
comes from `applyEvent` and `reduceRun`, transcripts from the
`'transcript'` stream.

## Files to create

```
src/tui/app.tsx
src/tui/theme.ts
src/tui/terminal.ts                  synchronous terminal restore, registered with the engine's shutdown hook
src/tui/store.ts                     the external store: getState, setState(updater), subscribe; useStore
src/tui/batch.ts                     coalesces engine events into one setState per 50 ms
src/tui/engineBridge.ts              RunView: engine events → store (via step 08's applyEvent) + ring buffers
src/tui/ringBuffer.ts                plain bounded buffer; no versions, no subscribers
src/tui/components/Header.tsx
src/tui/components/Rule.tsx
src/tui/components/Frame.tsx         the rounded box used on the detail screen
src/tui/hooks/useKeys.ts
src/tui/hooks/useTerminalSize.ts     columns and rows, resize debounced 50 ms
src/tui/components/Spinner.tsx       self-timing leaf, 80 ms
src/tui/components/Elapsed.tsx       self-timing leaf, 1 s
src/cli/main.ts                      wire `rensa` and `rensa <chain>` to the TUI
src/tui/store.test.ts
src/tui/batch.test.ts
src/tui/ringBuffer.test.ts
src/tui/engineBridge.test.ts
src/tui/components/Elapsed.test.tsx
src/tui/hooks/useTerminalSize.test.tsx
```

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
} as const
```

One file, hex only, consumed through `<Text color={theme.x}>`. No
background painting; the terminal's background stays.

## Header.tsx

```
⎇ feat/quote-limits (in place)  ~/Repos/trezor-suite              tdd-review
──────────────────────────────────────────────────────────────────────────
```

Props: `branch`, `mode?: 'in place'`, `path` (home-relative), `right?`.
Left part in `text`, mode in `muted`, path in `muted`, right in `text`,
rule in `dim`. Width from `useTerminalSize().columns`, so a resize
re-renders it once the debounce settles (below), not per `SIGWINCH`.

## Screen router (app.tsx)

```ts
type Screen = { name: 'chains' } | { name: 'detail'; chain: string } | { name: 'run'; chain: string; run: RunHandle }
```

State lives in `app.tsx`; screens receive `navigate(screen)`. `esc` on
detail returns to chains; `esc` on run returns to chains while the run
continues (the handle stays in app state). `ctrl+c`: if a run is
active, show a one-line confirmation `abort the run? y/n`; `y` aborts
and exits; otherwise exit. `rensa <chain>` starts on the detail screen.

Engine is opened once in `main.ts` before rendering; open errors
(`NOT_A_REPO`) print to stderr and exit 1 without Ink. See "main.ts
wiring" for the order, which is deliberate.

## Rendering mode: inline, by decision

Ink renders inline: the app's frame sits at the bottom of the normal
screen, and on every change Ink clears the frame's lines and rewrites
all of them. Claude Code's Ink fork instead keeps a cell buffer, diffs
it, and emits only changed cells. That difference does not matter at
rensa's screen sizes while the frame is inline, and it is the one
place where the plan takes the stock behaviour knowingly:

- **Decision: inline, no alternate screen.** The app does not write
  `\x1b[?1049h`, does not size its layout to the full terminal
  height, and leaves the terminal's own scrollback alone. The run
  screen's body takes the rows it needs up to the terminal height; a
  smaller terminal shortens the transcript pane. This is the status
  quo of steps 12–14 and needs no work.
- **When it would stop being fine.** A full-height, alternate-screen
  layout is where Ink's clear-and-rewrite visibly flickers on some
  terminals, because every frame repaints every row. Do not adopt the
  alternate screen without also changing the renderer.
- **Fallback, recorded here and not pre-built.** If flicker is
  observed during dogfooding (after step 14), in this order: first, the
  incremental renderer behind Ink's undocumented experimental flag, if
  the installed Ink version has it (check `node_modules/ink` for the
  option in `render`'s options type before relying on it, and pin the
  version when you do); else OpenTUI, which has a diffing renderer
  natively and would move the runtime to Bun. Either is a step 11
  change behind the engine boundary and touches nothing under
  `src/engine/`. Revisit only on observed flicker; do not add hooks
  for it now.

## terminal.ts

```ts
export function restoreTerminal(): void          // idempotent, synchronous
export function installTerminalRestore(): () => void   // onShutdown(restoreTerminal)
```

`restoreTerminal` undoes everything Ink and the app change about the
terminal, with plain synchronous writes and no Ink call: if
`process.stdin.isTTY`, `setRawMode(false)`; always write `\x1b[?25h`
(show cursor), `\x1b[0m`, and `\x1b[?1049l` (leave the alternate
screen). The app is inline and never enters the alternate screen (see
"Rendering mode"), so the last sequence is a no-op today; it stays so
the restore is still complete if the fallback renderer is ever
adopted. Ink's own cleanup runs on unmount and is not
reached from a crash or a signal, which is why this exists. It is safe
to run after Ink has already cleaned up: every sequence is a no-op on a
terminal that is already in that state.

`installTerminalRestore` registers it through `onShutdown` from
`src/engine/index.ts` (the engine re-exports step 06's `onShutdown`;
this module is still the only one that touches the terminal). `main.ts`
calls it immediately before `render()`, after `Engine.open`, so it is
the last registration and therefore the first callback to run: the
terminal is sane before the children are killed and the lock is
released, and before an uncaught exception's stack is printed. Ink runs
with `exitOnCtrlC: false`, so ctrl+c reaches the app as a key and the
app's own `process.exit` path ends in the same callback through
`'exit'`.

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
inputs. Ink must run with `exitOnCtrlC: false` so the app owns ctrl+c.

### Input priority over streams

Keystrokes must land during token bursts. Stock Ink cannot set React
lane priority, but the same effect falls out of how the two inputs
reach the store: engine events are coalesced through the 50 ms batcher
(`batch.ts`), key handling is not. Rules, for this step and every
screen after it:

- A key handler runs synchronously inside `useInput` and applies its
  state change before it returns: selection, scroll offset, follow
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
- Handlers never touch the ring buffers or `RunView.events`; they read
  them if needed, nothing more.

### Event classification: discrete, continuous, stream

Claude Code sorts terminal events into discrete, continuous and
default classes before React sees them and schedules each class
differently. Stock Ink gives no hook for lane priority, so what is
left of that idea here is a documented rule per class, each already
specified elsewhere in this step:

| class | events | handling | where |
|---|---|---|---|
| discrete | keystrokes | synchronous, never coalesced, never behind a throttle | "Input priority" above |
| continuous | terminal resize | coalesced: debounce 50 ms, then one re-layout | `useTerminalSize` below |
| stream | engine `'event'` and `'transcript'` | batched into one `setState` per 50 ms window | `batch.ts` |

The classes never share a queue: a resize does not flush the stream
batcher, a keystroke does not wait for a pending resize, and a burst
of events delays neither.

## useTerminalSize.ts

```ts
export function useTerminalSize(): { columns: number; rows: number }
```

One hook owns the terminal size. It reads `process.stdout.columns` and
`rows` (defaults 80 × 24 when not a TTY), listens to the `'resize'`
event on `process.stdout` once, and updates its state only after the
stream has been quiet for 50 ms: a drag-resize emits a `SIGWINCH` per
pixel step, and re-laying out on each one means dozens of full
re-wraps of the transcript pane per second for nothing. Dropping the
intermediate sizes is the whole point; the final size is always
applied. The value is provided through a context from `app.tsx` so
every consumer sees the same debounced size, and nothing else in
`src/tui/` reads `stdout.columns` or `useStdout()` for layout. Step
14's pane takes its `width` and `height` from here, which is what makes
its wrap-cache invalidation happen once per resize rather than once
per event.

## ringBuffer.ts

```ts
class RingBuffer<T> { constructor(capacity: number); push(item: T): void; get(index: number): T | undefined; slice(from: number, to: number): T[]; readonly start: number; readonly length: number }
```

A bounded append-only buffer and nothing more: no version counter, no
listeners. Indices are absolute, counted from the first push: `length`
is the total ever pushed, `start` the oldest index still retained, and
`get`/`slice` return nothing for evicted indices. Step 14's transcript
pane keys its wrap cache and its memoized rows on these indices, so
eviction never shifts a key. Transcript content lives here, outside React and outside
the store; what tells a component to re-read it is the per-transcript
version counter in the store (below). Capacity 5000 records per
transcript is enough for a pane.

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
- No Ink, React-DOM or engine import; React only, for the hook.

## batch.ts

```ts
export function createBatcher<T>(flush: (items: T[]) => void, ms = 50): { push(item: T): void; flushNow(): void; dispose(): void }
```

The 50 ms throttle lives on the input side, on the `setState` calls
driven by engine events, not on the store or on `subscribe`. The
bridge pushes every engine event into a batcher; the first item in a
quiet period flushes at once, items arriving within the next `ms`
collect and flush together at the window's end as one `setState`.
React therefore sees at most ~20 state changes per second however
fast events stream, and the store stays a plain synchronous store
whose notifications are never delayed or dropped. `flushNow` is for
`dispose` and tests. No run or step knowledge here.

## engineBridge.ts

Translates the engine's streams into the store and the ring buffers;
it holds no interpretation logic of its own:

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
  transcript(step: string, label: string): RingBuffer<TranscriptRecord>
  partial(step: string, label: string): string | undefined      // the current streaming line, if any
  dispose(): void
}
```

- `store` starts as `{ progress: { status: 'running' }, steps: initialSteps(chainSteps), transcriptVersions: new Map() }`.
- Engine `'event'` and `'transcript'` arrivals are pushed into one
  batcher as a tagged union. Transcript records are written to their
  ring buffer (or the partial-line slot) immediately on arrival, since
  the buffers are outside React and writing them renders nothing; what
  the batcher defers is only the store update.
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
- Partial text (`partial: true`) is kept as a single mutable "current
  line" per transcript, replaced by the final record when it arrives;
  it is never pushed as history. A delta still bumps the key's version
  so the pane redraws the line.
- `events` is kept outside the store because appending to it changes
  every time; nothing renders the raw list.
- `step.finished` and `run.finished` arrive through `'event'` like
  everything else; the bridge never awaits `handle.done` to learn
  state.
- Step 14's finished-run-from-disk case builds the same `RunState` with
  `reduceSteps(events, chainSteps)` and `reduceRun(events)` over
  `readEvents`, fills the buffers from `readTranscript`, and sets every
  key's version to 1; the screens cannot tell the two apart.

## Spinner.tsx and Elapsed.tsx

Animation is split from state. There is no `useTick` hook that
re-renders its caller; the only things that tick are two leaf
components that own their own interval and re-render alone:

```ts
export const Spinner: React.FC<{ color?: string }>                       // braille frames, 80 ms
export const Elapsed: React.FC<{ since: string; until?: string; color?: string }>  // `m:ss`, `h:mm:ss` past an hour, 1 s
```

- Each is wrapped in `React.memo`. `Spinner` has no changing props;
  `Elapsed` re-renders from its parent only when `since` or `until`
  changes, which is a status change.
- Each sets up its own `setInterval` in an effect and clears it on
  unmount. `Elapsed` with `until` set renders the fixed difference and
  runs no interval; the parent passes `finishedAt` once the step or
  run is done and the cell freezes with no further timer.
- Nothing above a leaf ticks. Agent rows (step 14) and the status line
  compose these cells; a row re-renders only when the `StepView` or
  `AgentView` it selects changes, not once per second. This is the
  same split Claude Code uses, where moving the spinner into its own
  component took the parent from hundreds of re-renders per turn to a
  few dozen.
- Both read the elapsed formatter from `src/tui/format.ts` (step 14
  specifies it; this step creates the file with only that helper).
  Nothing else in the UI polls.

## main.ts wiring

`rensa` with no args and `rensa <chain>` render the app; everything
else unchanged from step 09. The order inside the TUI branch matters:

```ts
const opening = Engine.open(process.cwd())            // first: provider subprocesses start now
const [engine, tui] = await Promise.all([opening, import('./tui/app.js')])
installTerminalRestore()
tui.render(engine, initialScreen)                      // Ink render(<App/>, { exitOnCtrlC: false, patchConsole: false })
```

Ink's `render` options are fixed: `exitOnCtrlC: false` so the app
owns ctrl+c (above), and `patchConsole: false`. With the default,
Ink intercepts `console.*` and re-renders the whole frame to splice
the output above it; one stray `console.log` from a dependency during
a token burst then stalls a frame and can tear the layout. With it off,
such output goes straight to stdout and lands above the inline frame
on the next repaint, ugly but harmless, and nothing in `src/tui/` or
`src/engine/` calls `console.*` anyway: enable biome's `noConsole` rule for those
two directories in this step (step 01 did not), with `src/cli/` exempt
since the headless CLI writes to stdout on purpose.

- `Engine.open` is the very first statement after argument parsing.
  Its provider check spawns three subprocesses, and `open` starts them
  before its first `await` (step 08), so they are running from here on.
- Ink and React are loaded through a dynamic `import('./tui/app.js')`
  created right after, never through a static import in `main.ts`.
  Node resolves and evaluates that module graph while the subprocesses
  run; with a static import the two would be serial. It also keeps Ink
  out of `rensa run` and `rensa doctor` entirely. `src/tui/app.tsx`
  exports `render(engine, screen)`; `main.ts` is the only place that
  imports it. tsdown emits the dynamic import as its own chunk next to
  `dist/cli/main.js`; the step 09 e2e tests already run the built CLI
  and catch a broken chunk path.
- `open` rejecting (`NOT_A_REPO`) prints the error and exits 1 before
  `render`, even if the Ink import already finished.
- `open` resolves before the provider check completes. The app renders
  its first frame at once with `engine.providers()` undefined, and
  re-renders when the engine emits `'providers'`. Nothing in the TUI
  awaits `providersChecked`; step 12 specifies the checking state.

## Tests

- `RingBuffer` push, get, slice, length, and eviction past capacity:
  after pushing `capacity + 3` items, `start` is 3, `length` is
  `capacity + 3`, `get(2)` is undefined and `get(3)` is the fourth
  item.
- `store`: `setState` with an updater returning `prev` notifies no
  listener; with a new object it notifies each listener once;
  `unsubscribe` stops notifications; `useStore` with a selector
  re-renders a test component only when the selected value changes
  (`ink-testing-library` from step 12 is not yet available, so use
  React's test renderer).
- `batch`: 1000 pushes in a loop produce one immediate flush and one
  trailing flush carrying the other 999 items in order; over a
  fake-timer second of continuous pushes at most ~20 flushes;
  `flushNow` delivers pending items synchronously.
- Bridge: feeding a recorded fake-provider event sequence then
  `flushNow` yields `steps` equal to `reduceSteps(events, chainSteps)`
  and `progress` equal to `reduceRun(events)` (the reducer itself is
  tested in step 08); a batch of only `user.note` events leaves
  `store.getState()` the same reference and notifies nobody; a
  transcript record for `a/tester` bumps only that key's version and
  leaves `steps` the same reference; partial text replaces the current
  line, bumps the version, and is not in the buffer's history.
- `render` is called with `exitOnCtrlC: false` and
  `patchConsole: false`: assert on the options object passed to a
  mocked `ink.render`.
- `main.ts` has no static import of `src/tui/` or of `ink`: assert
  it with a small test that reads the file and greps for
  `from './tui` and `from 'ink'`, or extend step 01's import boundary
  lint with that rule, whichever is less code.
- `Elapsed`: with fake timers, `since` 90 s ago renders `1:30` and
  advances to `1:31` after one tick; with `until` set it renders the
  fixed value and schedules no interval; a parent that re-renders with
  the same props does not re-render the memoized leaf (count renders
  with a probe). `Spinner` advances a frame per 80 ms and clears its
  interval on unmount.
- `useTerminalSize`: with fake timers, five `'resize'` events 10 ms
  apart on a fake stdout produce one state update, 50 ms after the
  last, carrying the last size; an event after the debounce settles
  produces another; the listener is removed on unmount.
- `restoreTerminal` with a fake `stdout.write` and a fake `stdin`:
  writes the show-cursor, reset and leave-alternate-screen sequences, calls
  `setRawMode(false)` only when `isTTY`, and does not throw when stdin
  is not a TTY. Do not test the shutdown wiring by killing the test
  process; step 06 covers `runShutdown`.

## Verification (human)

`npm run build && node dist/cli/main.js` in this repo shows the header
with the branch and path and an empty body; `ctrl+c` exits; resizing the
terminal redraws the rule to the new width, settling once after the
drag stops rather than redrawing during it. The first frame must appear
before the provider line fills in; if the two arrive together, the
provider check is being awaited somewhere before `render`. Then, with the app open,
`kill -TERM <pid>` from another terminal, and separately run it with
`RENSA_CRASH=1` (a dev-only throw in `app.tsx` behind that variable,
removed before step 17): both times the shell prompt comes back with
echo and a visible cursor, and the crash prints a readable stack.
Note any flicker seen while a transcript streams, here and in the
step 14 dogfooding; that observation is what triggers the renderer
fallback under "Rendering mode", nothing else does.

## Out of scope

Any screen content.
