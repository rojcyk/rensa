# 11 TUI foundation

## Goal

The Ink application shell every screen builds on: theme, header, key
routing, screen navigation, and the bridge that turns engine events
into throttled React updates without holding transcripts in state.
After this step `rensa` opens, shows the header and an empty screen,
and quits cleanly.

## Context

Steps 01–10 merged. Screens are specified in steps 12–14; this step
builds only what they share. The architecture rule applies: this
directory imports the engine only through `src/engine/index.ts`.

### Notes from step 05

`readEvents` passes events with an unknown `type` through untouched
(forward compatibility with newer runs). `reduceSteps` must ignore an
event it does not recognise, never throw on it, so give its `switch` a
default branch that skips the event.

## Files to create

```
src/tui/app.tsx
src/tui/theme.ts
src/tui/engineBridge.ts
src/tui/ringBuffer.ts
src/tui/components/Header.tsx
src/tui/components/Rule.tsx
src/tui/components/Frame.tsx         the rounded box used on the detail screen
src/tui/hooks/useKeys.ts
src/tui/hooks/useTick.ts             1 s tick for elapsed timers
src/cli/main.ts                      wire `rensa` and `rensa <chain>` to the TUI
src/tui/ringBuffer.test.ts
src/tui/engineBridge.test.ts
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
rule in `dim`. Width from `useStdout().stdout.columns`, re-rendered on
resize.

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
(`NOT_A_REPO`) print to stderr and exit 1 without Ink.

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

## ringBuffer.ts

```ts
class RingBuffer<T> { constructor(capacity: number); push(item: T): void; slice(from: number, to: number): T[]; readonly length: number; version: number }
```

`version` increments on push; components subscribe to it for throttled
re-render. Capacity 5000 records per transcript is enough for a pane.

## engineBridge.ts

Owns the live run state outside React:

```ts
class RunView extends EventEmitter {
  constructor(handle: RunHandle, engine: Engine)
  readonly events: RunEvent[]                           // all so far
  readonly steps: Map<string, StepView>                 // derived: status, times, agent rows
  transcript(step: string, label: string): RingBuffer<TranscriptRecord | PartialText>
  readonly status: 'running' | 'paused' | 'complete' | 'failed' | 'aborted'
  readonly currentStep?: string
}
export function useRunView(view: RunView): number      // returns a version that bumps at most every 50 ms
```

- Subscribes to the engine's `'event'` and `'transcript'`.
- Partial text (`partial: true`) is kept as a single mutable "current
  line" per transcript, replaced by the final record when it arrives;
  it is never pushed as history.
- `useRunView` uses `useSyncExternalStore` with a throttle so React
  renders at most 20 times per second regardless of event rate.
- `StepView` is a pure reduction over events; write it as
  `reduceSteps(events: RunEvent[]): Map<string, StepView>` and test it
  with the event sequences from step 08's integration tests. The
  derived shape:

  ```ts
  interface StepView { id: string; kind: 'agent'|'shell'; status: 'pending'|'running'|'ok'|'failed'|'killed'|'timeout'|'paused'; startedAt?: string; finishedAt?: string; agent?: AgentView }
  interface AgentView { label: string; provider: string; model?: string; effort?: string; status: 'pending'|'running'|'ok'|'failed'|'killed'|'timeout'; startedAt?: string; finishedAt?: string; usage?: Usage; error?: AgentError }
  ```

## useTick.ts

`useTick(active: boolean)`: re-renders once per second while `active`,
for elapsed timers. Nothing else in the UI polls.

## main.ts wiring

`rensa` with no args and `rensa <chain>` render the app; everything
else unchanged from step 09.

## Tests

- `RingBuffer` push, slice, version.
- `reduceSteps` on a recorded event sequence yields the expected
  statuses and timestamps; a `run.paused` sets the next step `paused`.
- Bridge throttling: 1000 events in a loop produce at most ~20 version
  bumps per second (assert on count over a fake timer).

## Verification (human)

`npm run build && node dist/cli/main.js` in this repo shows the header
with the branch and path and an empty body; `ctrl+c` exits; resizing the
terminal redraws the rule to the new width.

## Out of scope

Any screen content.
