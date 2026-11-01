# 14 Run screen

## Goal

The live view of a run and, unchanged, the view of a finished one. Two
columns: steps on the left, the selected step's agent row and transcript
on the right. Navigation, follow mode, pause with notes, kill, abort,
end states. This completes the TUI MVP (dogfooding milestone 2).

## Context

Steps 01–13 merged. All data comes from `RunView` (step 11) and the
engine-owned transcript ring buffers (`handle.transcript`, step 11);
the screen computes nothing beyond layout. The screen is laid out
through step 11's `Layout` (header slot: `Header` and the status line;
body: the two columns; footer: the note box) and sized from
`SizeContext`: bounds immediately, wrap width when it settles.

### Notes from step 05

For a finished run read from disk, the engine index already exports
`openRunDir`, `readEvents` (returns `{ events, warnings }`),
`readTranscript`, and `readRunJson`. `readEvents` skips bad lines and
reports each as a warning; `readTranscript` skips them silently,
including a final line still being written. A run directory written
by a crashed process may end mid-line; show the run, not an error.

## Layout

```
⎇ feat/quote-limits (in place)  ~/Repos/trezor-suite              tdd-review
──────────────────────────────────────────────────────────────────────────
                                                   run 7f3a · 04:12 · running

  ✓ baseline     │  implement
  ✓ write-tests  │  ────────────────────────────────────────────────────────
  ● implement    │  › impl       claude · opus · high        ⠹ 1:39   12.4k
  ○ test         │  ────────────────────────────────────────────────────────
  ○ review-codex │  Reading the four new tests in quote.ratelimit.test.ts
  ○ retest       │  to understand the expected window semantics.
                 │
                 │  ▸ Read src/api/quote.ts
                 │  ▸ Edit src/middleware/ratelimit.ts
                 │
                 │  Token bucket keyed on the API key header ...
                 │
┌──────────────────────────────────────────────────────────────────────┐
│ › note for the next steps…                                           │
└──────────────────────────────────────────────────────────────────────┘
```

### Status line (right-aligned, below the rule)

`run <last 4 of id> · <elapsed> · <state>` where state is `running`,
`paused before <step>`, `paused after <step>`, `aborting…` (from
`progress.status`, between the user's abort and `run.finished`, while
the child drains), `complete`, `failed`, `aborted`. When
`progress.error` is set the state reads `failed · <error.message>`,
truncated to the width with `…`; this is how a storage failure, which
has no `run.finished` event, ends the screen. Elapsed is step 11's
`<Elapsed since={progress.startedAt} until={progress.finishedAt}/>`,
so it stops when `progress` turns terminal, from the event or from the
result, and the status line itself never ticks. Color: `muted`; the state
word in `accent` while running or paused, `warn` while aborting, `ok`
for complete, `err` for failed or aborted.

### Left column

Width is the `leftCols` budget from step 11's `layoutBudget`
(`min(longest id + 6, 35 % of columns)`), clipped; an id wider than
that truncates with `…`. One row per step: marker, id, and a follow
indicator `⟳` after the id of the running step when the selection is
detached. In `narrow` compact mode the column is absent and a one-line
strip `step 3/6 implement` sits above the right column instead.

Markers: `○` pending (`dim`), `●` running (`accent`), `✓` ok (`ok`),
`✗` failed, killed, timeout (`err`), `‖` paused-before (`warn`). The
selected row's id is in `accent`; the running row's marker is always
`accent`.

A vertical `│` in `dim` separates the columns, full height of the body.

### Right column

Items 1–4 form the header block and are wrapped in `Ratchet` (step
13): a grow-only `minHeight` measured with `useBoxMetrics` and reset on
a bounds change, so an agent row's error line appearing or the config
cell wrapping on a narrow terminal never makes the transcript below
jump up and down between frames.

1. Step id in `text`.
2. Rule in `faint`.
3. One agent row (always exactly one in the MVP; render through a
   generic `AgentRows` component that takes a list). Columns, fixed:

   | col | width | content |
   |---|---|---|
   | marker | 2 | `›` in `accent` |
   | name | 11 | label, or the shell command truncated with `…` |
   | config | 27 | `provider · model · effort`; empty for shell |
   | status | 8 | spinner + elapsed while running; `✓ 1:52`, `✗ 0:38`, `– ` pending |
   | tokens | 7 | `12.4k`, right-aligned; empty for shell or unknown |

   Token formatting: `< 1000` as is, else one decimal `k`. Elapsed as
   `m:ss`, `h:mm:ss` past an hour.

   The spinner and elapsed cells are step 11's self-timing leaf
   components (`<Spinner/>`, `<Elapsed since until/>`); the row itself
   re-renders only on a status change. A row selects its own
   `AgentView` from the store, so a tick in one cell, a token update on
   another step, or a transcript delta never redraws it.
4. Rule in `faint`.
5. Transcript area: the rest of the body height, `transcriptCols`
   wide (step 11's `layoutBudget`), which is `rightCols − 3` here and
   `columns − 2` in `narrow` mode. Nothing in this step computes a
   width of its own.

### Transcript viewport (rule C)

Source: `view.transcript(step, label)` (the engine-owned ring buffer)
plus `view.partial(step, label)`. The pane mounts only the visible rows
and does so through a pure model that owns all measurement.

#### The model: `src/tui/viewport.ts`, no React

```ts
export class TranscriptViewport {
  constructor(buffer: RingBuffer<TranscriptRecord>, opts: { width: number; capacity: number })
  // inputs
  sync(): void                                   // ingest records appended to / evicted from the buffer since last sync
  setPartial(text: string | undefined): void     // the mutable streaming tail
  setWidth(width: number): void                  // settled transcriptCols only (step 11 useBudget().settled), never a terminal width
  setExpanded(record: number, expanded: boolean): void
  // navigation
  scrollBy(lines: number): void; scrollTo(edge: 'top' | 'bottom'): void
  follow(): void; detach(): void; readonly following: boolean
  readonly anchor: { record: number; offset: number }   // logical: record id + grapheme offset into its text
  // output
  visible(height: number): VisibleRow[]          // rows intersecting the window, each with its visible line slice
  totalLines(): number
  readonly stats: { wraps: number; measured: number; lookups: number }   // operation counters for tests
}
interface VisibleRow { record: number; kind: TranscriptRecord['kind'] | 'partial'; lines: string[]; firstLine: number; expanded: boolean }
```

- **Cache key** is transcript identity (the buffer instance), absolute
  record index, width, and presentation state (tool expansion).
  Records are immutable once in the buffer, so an entry is computed
  once per (width, expansion) and reused until evicted.
- **Indexed heights, never a rebuilt prefix sum.** Wrapped heights
  live in an order-statistics structure (a Fenwick tree over the ring's
  `capacity` slots, slot = index mod capacity, with the live range
  `[start, length)` queried as at most two slot ranges). Append sets
  one slot, eviction clears one slot, expansion updates one slot;
  prefix-line counts and line→record lookups are `O(log capacity)`.
  No frame rebuilds an array over all records.
- **Eviction follows the buffer.** `sync()` compares `buffer.start`
  with the last seen start and drops cache entries and tree slots for
  evicted indices, so memory is bounded by `capacity` regardless of
  run length.
- **Logical anchor.** The viewport's position is `{ record, offset }`,
  the record the top visible line belongs to and the grapheme offset
  into that record's normalized text where the line begins, not a bare
  line number. A width change, an expansion above, or an eviction
  re-derives the top line from the anchor, so the user keeps reading
  what they were reading. If the anchor's record is evicted, clamp to
  the earliest retained record. `scrollBy` moves the anchor by wrapped
  lines through the tree.
- **Follow mode is explicit.** `following` starts true; `visible()`
  then anchors to the bottom on every call. Any manual scroll
  (`scrollBy`, `scrollTo('top')`) detaches; `follow()` (ctrl+f) and
  `scrollTo('bottom')` reattach.
- **Streaming tail.** `setPartial` splits the tail on `\n`: completed
  logical lines are wrapped once and retained in a tail cache; only the
  last, still-growing logical line is rewrapped, once per published UI
  update (one version bump), never per delta. Soft-wrapped lines inside
  that last logical line are never frozen, since later characters can
  change both word-wrap points and grapheme boundaries (a combining
  mark or a variation selector arriving after its base). A newline-free
  reply therefore rewraps one long logical line per update, which is
  linear in its length; that case is tested separately and must stay
  correct and bounded per update.
- **One normalization and width policy** for measuring and displaying:
  `normalize(text)` expands tabs to 8-column stops, drops `\r`, keeps
  blank lines and trailing newlines as empty rows, and strips nothing
  else; wrapping is `wrap-ansi` (hard-wrap long words, `trim: false`)
  and measurement is `string-width`, both declared as **direct
  dependencies** in this step, never reached through Ink's
  `node_modules`; grapheme offsets come from `Intl.Segmenter`. The
  `Transcript` component renders the lines the model produced with
  `<Text wrap="truncate">`, so what was measured is what is shown.

#### The component: `Transcript.tsx`

```ts
interface TranscriptProps { view: RunView; step: string; label: string; height: number; width: number; expanded: ReadonlySet<number>; cursor?: number }
```

- Holds one `TranscriptViewport` per `(step, label)` in a ref;
  subscribes to `s.transcriptVersions.get(key)` and calls `sync()` and
  `setPartial()` on each bump. Width comes from step 11's
  `useBudget(want)`: `setWidth(settled.transcriptCols)` whenever that
  value changes (a settled terminal width or a compact-mode flip), and
  the pane `Box` is `current.transcriptCols` wide for clipping. The
  component never reads `settledColumns` or `columns` directly, so it
  cannot wrap at a width other than the one it is drawn in. `width` in
  `TranscriptProps` is `current.transcriptCols`; the viewport's wrap
  width is set separately from the settled budget.
- **Expanded tool records** wrap their body (pretty JSON and output)
  at `width − EXPAND_INDENT` with `EXPAND_INDENT = 2` a constant the
  model owns, so indented lines are measured at the width they are
  drawn at. Every produced line, at every record kind, satisfies
  `stringWidth(line) ≤ width` by construction; the `truncate` on
  render is edge safety for the un-settled transition only and must
  never be what makes a line fit.
- Mounts exactly `visible(height)`: one `React.memo` row per
  `VisibleRow`, keyed by record index, given its line slice. A row's
  props change only when its slice, expansion or cursor state changes.
- The pane `Box` has `overflow="hidden"` as edge safety for a
  partially visible last row and for the un-settled width transition
  (step 11); it is not how scrolling works. Scrolling is the model's
  anchor, not Ink's `contentOffsetY`.
- Record kinds: `text` in `text` color, the partial tail in `muted`;
  `tool` as one line `▸ <name> <summary>` in `muted` (summary: first
  string field of `input`, truncated) and, expanded, `input` as pretty
  JSON and `output` beneath, indented, in `dim`; `note` as `» <text>`
  in `warn`. Shell steps use the same component with text records.
  Pending step: `not started` in `dim`. Failed agent: the error message
  last in `err`, then `(transcript: <agent dir>)` in `dim`; both are
  model rows too, so they scroll with the rest.
- Keys: `pageUp`/`pageDown` → `scrollBy(∓ floor(height / 2))`;
  `top`/`bottom` → `scrollTo`; `follow` → `follow()`.

#### Performance contract

Verified by the model's operation counters, with timings as supporting
evidence only (timings are not assertions):

- After the cache is warm, a scroll is an indexed lookup plus work
  proportional to the visible rows: `wraps` stays 0, `lookups` grows
  by `O(log capacity)`.
- An append processes the new content only: `wraps` grows by the
  number of new records (plus one tail rewrap per update).
- A width change may rewrap retained history (`wraps` up to the
  retained record count) and nothing else triggers that.
- The frame mounts at most `height` rows regardless of buffer length.

### Painting (rule D)

Applies to every screen from step 11 on; this step is where it is
exercised fully.

- `theme.background` is set on the fullscreen root `Box` (step 11
  `app.tsx`) and nowhere else. Ink fills interior gaps and empty body
  space from it: an empty transcript, the space under a short step
  list, the gap between columns. In inline mode there is no root
  background; the terminal's own shows through.
- Explicit backgrounds only on selected rows or panels: the selected
  step row and the focused note box use `theme.selection`; nothing else
  paints.
- Borders are styled deliberately, since `backgroundColor` fills the
  interior and excludes them: `Frame` and the note box set their border
  color (`dim`, `accent` when focused) and, in fullscreen, their border
  background to `theme.background` so the border cells match the fill.
- A small `Row` component exists only where one-row sizing,
  truncation, or selection styling is needed (step rows, agent rows,
  the strip in narrow mode): `height={1}`, `overflow="hidden"`,
  `<Text wrap="truncate">`, optional `backgroundColor`. Plain `Box` and
  `Text` everywhere else.
- Tests must be color-aware: assert on the ANSI sequences in the frame
  (background on every cell of a selected row, background present in
  empty pane cells in fullscreen, absent in inline), and cover empty
  panes, gaps, shorter replacement text (a long status replaced by a
  short one leaves no stale cells), selection changes, and resizing.
  Plain-text snapshots cannot prove background coverage and are not
  accepted for these cases.

### Keys

Routed by step 11's focus model: one `useKeys`, `focus` starts as
`main`. The chords `follow`, `pause`, `kill`, `quit` act in both `main`
and `input`.

| focus | action | effect |
|---|---|---|
| main | `left`/`right` | select previous/next step; detaches follow |
| main | `up`/`down` | select agent row (no-op with one row) |
| main | `pageUp`/`pageDown`/`top`/`bottom` | transcript scroll |
| main | `enter` | while paused: continue; otherwise with the cursor on a tool line: toggle expansion; otherwise nothing |
| main | printable key | focus → `input`, character inserted (box enabled only while running or paused) |
| main | `esc` | back to chains; run continues; the `RunView` is disposed and rebuilt from the handle's history on return (step 11) |
| input | text, arrows, home/end, backspace, delete | `editInput` |
| input | `enter` | `handle.note(text)` once, clear the box, focus → `main`; empty box: nothing |
| input | `esc` | focus → `main`, text kept |
| any | `follow` (ctrl+f) | reattach: selection tracks the running step |
| any | `pause` (ctrl+p) | `handle.pause()`; status shows `pausing after <step>` until the pause event arrives |
| any | `kill` (ctrl+x) | focus → `confirm` with `kill <step>? y/n`; `y` → `handle.kill()`; `n`/`esc` → back to the previous focus |
| any | `quit` (ctrl+c) | app-level overlay: `abort the run? y/n`, `handle.abort()`, status shows `aborting…`, quit when `handle.done` resolves (step 11) |

Continuing a paused run and sending a note are two actions on two
keys; the old "enter continues and records the note" combination is
gone because one key must do one thing.

Follow mode is on at start. The transcript cursor for tool expansion is
a secondary selection moved with `up`/`down` only when the step has one
agent row; document this in a comment, it is a pragmatic MVP overload.

### Note box

Always rendered; step 11's controlled `InputBox`, its `InputState` and
focus owned by the screen. Enabled on a running or paused run; inert
(dim) once finished, and never focused then. Placeholder `note for the
next steps…`. Typing any printable key in `main` focuses it; `enter`
in `input` focus sends the note once, clears the box and returns focus
to `main`; the note appears in the transcript of the step it applies
from once that step starts, via the `note` record the engine writes.

### End states

Header state word and color change; spinners unmount and every
`Elapsed` gets its `until`, so no interval is left running; the last
step stays selected unless the user moved; the note box goes inert.
Nothing else changes.

### Finished run from disk

`Run.tsx` takes either a live `RunHandle` or a `RunDir`; in the second
case `RunView` is built once from `readEvents` through step 08's
`reduceSteps(events, chain.steps)` and `reduceRun(events)`, with
`RingBuffer`s (the engine's class) filled from `readTranscript`. The
live case seeds itself the same way from `handle.attach()`'s history
and the handle's buffers (step 11), so the two paths share the seeding
code and differ only in where the events and records come from.
No entry point in the MVP opens it that way (history screen deferred),
but the component must support it so the deferred feature is a
navigation change, not a rewrite. Test it. A run that ended on a
storage failure has no `run.finished` on disk and no in-memory result
once its process is gone, so this path shows it as still running; that
is the correct reading of the file and the deferred history screen
decides what to do about it.

## Files to create

```
src/tui/screens/Run.tsx
src/tui/viewport.ts                   pure model: cache, Fenwick heights, anchor, follow, tail (rule C)
src/tui/components/StepList.tsx
src/tui/components/AgentRows.tsx
src/tui/components/Transcript.tsx     mounts visible(height) rows only
src/tui/components/StatusLine.tsx
src/tui/components/Row.tsx            one-row sizing, truncation, selection background (rule D)
src/tui/format.ts                     add tokens and truncation helpers (elapsed exists from step 11)
src/tui/viewport.test.ts
src/tui/screens/Run.test.tsx
src/tui/components/Transcript.test.tsx
src/tui/format.test.ts
```

Add `wrap-ansi` and `string-width` as direct runtime dependencies,
pinned exactly (index.md "Pinned versions").

## Tests

- `format`: elapsed and token formatting edge cases.
- Focus routing on the run screen: type `abc` then `left` twice: the
  caret is at 1, the selected step and the follow flag are unchanged;
  `enter` calls `handle.note('abc')` exactly once, never `resume()`,
  clears the box and returns focus to `main`; while paused, `enter` in
  `main` calls `resume()` once and `note()` never; `ctrl+x` then `y`
  while a note is half-typed calls `kill()` once and leaves the note
  text intact; `ctrl+p` while typing calls `pause()`; `esc` in `input`
  keeps the text and does not navigate; `esc` in `main` navigates.
- Snapshot of the running mock from a scripted `RunView` fed with
  events from a fake-provider run.
- A `RunView` whose progress carries a `STORAGE` error renders the
  status line as `failed · EACCES…` in `err`, spinners unmounted and
  every `Elapsed` stopped, with no `run.finished` in its events.
- Open the run screen on a fake run that already completed: the first
  frame shows the end state, the base from `run.started` in the header
  block and all transcripts, with no `running` flash. Leave with `esc`
  mid-run, start a second read-only fake chain, return to the first:
  its rows and transcripts are its own and the second run's steps do
  not appear.
- Agent row isolation: with a render-count probe on `AgentRows`,
  advancing fake timers by 5 s re-renders the leaves but not the row;
  a transcript record on the same step does not re-render the row
  either.
- `viewport` (pure, no React): normalization and width policy over
  CJK, combining marks, emoji sequences (ZWJ, flags, skin tones), tabs
  at 8-column stops, blank lines, trailing newlines, words longer than
  the width, and tool expansion, each asserting the wrapped lines and
  `totalLines()`; **reachability**: for a fixture of 300 records mixing
  long words, CJK, emoji, blank lines and one expanded tool record, at
  widths 20, 37, 57 and 80 (the last two straddle the `narrow`
  threshold's `transcriptCols`), scrolling from `top` to `bottom` one
  page at a time and concatenating each record's visible lines in
  order yields that record's normalized text exactly, for every
  record, and every visible line has `stringWidth ≤ width`; anchor
  preserved across a width change (the same
  grapheme stays on the top line), across expansion of a record above,
  and across eviction (clamps to `buffer.start`); follow detaches on
  `scrollBy` and reattaches on `follow()` and `scrollTo('bottom')`;
  streaming tail: 200 deltas building three logical lines rewrap only
  the last line per `setPartial`, counted via `stats.wraps`; a
  newline-free 100 KB tail stays correct across 50 updates (separate
  test); eviction drops cache entries and tree slots so the model's
  retained-entry count never exceeds `capacity`.
- Performance contract (operation counts): warm cache, `scrollBy`
  ×100 → `stats.wraps` unchanged and `lookups` ≤ 100 × (⌈log₂ capacity⌉
  + 2); append 50 records → `wraps` += 50 (+ tail); `setWidth` →
  `wraps` ≤ retained records; `visible(20)` on a 5000-record buffer
  returns ≤ 20 rows. Record wall-clock in the test output as evidence
  only; never assert on it.
- `Transcript` (render): a 5000-record buffer at `height` 20 mounts at
  most 20 rows (probe on the row component); a `pageDown` re-renders
  only rows that entered; one appended record while following
  re-renders the pane and the bottom-edge row, not the rows above; a
  `settled.transcriptCols` change rewraps, a bounds-only change does
  not (rows are truncated, not re-wrapped, until it settles); with the
  terminal at 100 columns and a chain whose `leftCols` is 15, the
  viewport's width is 82, not 100 (assert the `setWidth` argument on a
  spy), and crossing to 59 columns sets it to 57.
- Painting, color-aware: in fullscreen the selected step row carries
  the selection background on every cell to the column's edge; empty
  transcript cells carry the root background; the gap column between
  the step list and the transcript carries it; replacing
  `paused before implement` by `running` leaves no stale cells; moving
  the selection moves the background; after a resize the new empty
  area is filled. In inline mode no background sequence appears except
  on the selected row.
- Keys: `right` selects the next step and detaches; `ctrl+f`
  reattaches; `pageDown` moves the window; `enter` on a tool line
  toggles expansion.
- Input priority: with fake timers and the batcher holding several
  hundred pending transcript events, writing `right` to stdin updates
  the selected step in the next frame, before the batch flushes; no
  key handler in `Run.tsx` is `async` (assert by reading the handler
  functions' constructor name, or by lint).
- Paused state renders `‖` and the status word; `enter` with text calls
  `note` then `resume`.
- Finished run loaded from a run directory renders without a handle.

## Verification (human)

Run the `review` dogfooding chain through the TUI on this repository.
Navigate while it runs, pause it, add a note, resume, kill a step, and
finally abort a fresh run. Read `events.jsonl` afterwards and confirm
every action is there.

## Out of scope

Runs history screen, parallel agent rows (the component supports a list;
the engine never sends more than one).
