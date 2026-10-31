# 14 Run screen

## Goal

The live view of a run and, unchanged, the view of a finished one. Two
columns: steps on the left, the selected step's agent row and transcript
on the right. Navigation, follow mode, pause with notes, kill, abort,
end states. This completes the TUI MVP (dogfooding milestone 2).

## Context

Steps 01–13 merged. All data comes from `RunView` (step 11) and the
transcript ring buffers; the screen computes nothing beyond layout.

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
`paused before <step>`, `paused after <step>`, `complete`, `failed`,
`aborted`. Elapsed is step 11's `<Elapsed since={progress.startedAt}
until={progress.finishedAt}/>`, so it stops at `run.finished` and the
status line itself never ticks. Color: `muted`; the state
word in `accent` while running or paused, `ok` for complete, `err` for
failed or aborted.

### Left column

Width = longest step id + 6. One row per step: marker, id, and a
follow indicator `⟳` after the id of the running step when the
selection is detached.

Markers: `○` pending (`dim`), `●` running (`accent`), `✓` ok (`ok`),
`✗` failed, killed, timeout (`err`), `‖` paused-before (`warn`). The
selected row's id is in `accent`; the running row's marker is always
`accent`.

A vertical `│` in `dim` separates the columns, full height of the body.

### Right column

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
5. Transcript area: the rest of the body height.

### Transcript rendering

Source: `view.transcript(step, label)` records plus the current partial
line. The pane is virtualized: it mounts only what intersects the
viewport, so frame cost stays flat however long the transcript gets.

```ts
interface TranscriptProps {
  buffer: RingBuffer<TranscriptRecord>      // step 11; absolute record indices
  partial?: string                          // the current streaming line, rendered after the last record
  version: number                           // s.transcriptVersions.get(key); re-measures only indices ≥ last measured
  scrollOffset: number                      // first visible wrapped line, counted from the top of the transcript
  height: number                            // rows available to the pane; from step 11's useTerminalSize
  width: number                             // column width; changes invalidate the wrap cache; debounced with it
  expanded: ReadonlySet<number>             // record indices shown expanded (tool records)
  cursor?: number                           // record index under the cursor
}
```

- Measure in wrapped lines, not records. A wrap cache maps absolute
  record index to that record's wrapped lines for the current `width`
  (and, for a tool record, its expanded state); the record's height is
  the array length. A prefix sum over heights maps `scrollOffset` to
  the first intersecting record and the line offset inside it, and the
  pane walks forward until `height` lines are filled. Records are
  immutable once in the buffer, so an entry is computed once; the whole
  cache is dropped when `width` changes, one entry when its record is
  expanded or collapsed. The partial line is wrapped on every version
  bump and never cached.
- Exactly the intersecting records are mounted, each as a
  `React.memo` row keyed by absolute index and given only the slice of
  its wrapped lines that falls inside the window. A row's props change
  only when it enters or leaves the window edge, is toggled, or becomes
  the cursor; a version bump on the key re-renders the pane, which
  measures the new records and re-renders the one or two rows at the
  bottom edge, nothing above them.
- `scrollOffset` is state of `Run.tsx`, per selected step; the total
  wrapped height is the last prefix sum plus the partial line's height.
  Following means `scrollOffset = max(0, total − height)` recomputed on
  each version bump; detaching freezes it.
- The pane never uses Ink's `<Static>`. `<Static>` appends to terminal
  scrollback and is for output that will never move again, which
  conflicts with a pane that scrolls in place; memoized virtual rows do
  the same work inside the inline frame, which is the rendering mode
  step 11 decided on.

- `text`: wrapped to the column width, `text` color. The partial line
  renders in `muted` until finalized.
- `tool`: one line `▸ <name> <summary>` in `muted`, where summary is
  the first string field of `input` truncated to fit. Expanded state
  (toggle with `enter` when the cursor is on it) shows `input` as
  pretty JSON and `output` beneath, indented, in `dim`.
- `note`: `» <text>` in `warn`.
- Shell steps: the same component; records arrive as text lines.
- Pending step: nothing below the rules except `not started` in `dim`.
- Failed agent with an error: the error message rendered last in `err`,
  followed by `(transcript: <agent dir>)` in `dim`.
- Scrolling: `pageUp`/`pageDown` move `scrollOffset` by half the pane
  height in wrapped lines; `top`/`bottom` jump to 0 and to
  `total − height`. While following, the window sticks to the bottom;
  any manual scroll detaches the window until `bottom`.
- Finished steps need nothing special: their records are already
  cached and their rows memoized, so a finished transcript costs one
  prefix-sum lookup per frame and no re-wrapping.

### Keys

| action | effect |
|---|---|
| `left`/`right` | select previous/next step; detaches follow |
| `up`/`down` | select agent row (no-op with one row) |
| `pageUp`/`pageDown`/`top`/`bottom` | transcript scroll |
| `follow` (ctrl+f) | reattach: selection tracks the running step |
| `enter` | while paused: continue (recording a note if the box has text); otherwise, with the cursor on a tool line: toggle expansion; otherwise with text in the box: `handle.note(text)`, clear the box |
| `pause` (ctrl+p) | `handle.pause()`; status shows `pausing after <step>` until the pause event arrives |
| `kill` (ctrl+x) | `handle.kill()` after a one-line confirmation `kill <step>? y/n` |
| `esc` | back to chains; run continues |
| `quit` (ctrl+c) | app-level: confirm, `handle.abort()`, exit |

Follow mode is on at start. The transcript cursor for tool expansion is
a secondary selection moved with `up`/`down` only when the step has one
agent row; document this in a comment, it is a pragmatic MVP overload.

### Note box

Always rendered. Active on a running or paused run; inert (dim) once
finished. Placeholder `note for the next steps…`. Notes are sent with
`enter`; the box clears; the note appears in the transcript of the
step it applies from once that step starts, via the `note` record the
engine writes.

### End states

Header state word and color change; spinners unmount and every
`Elapsed` gets its `until`, so no interval is left running; the last step stays
selected unless the user moved; the note box goes inert. Nothing else
changes.

### Finished run from disk

`Run.tsx` takes either a live `RunHandle` or a `RunDir`; in the second
case `RunView` is built once from `readEvents` through step 08's
`reduceSteps(events, chain.steps)` and `reduceRun(events)`, with the
ring buffers filled from `readTranscript`.
No entry point in the MVP opens it that way (history screen deferred),
but the component must support it so the deferred feature is a
navigation change, not a rewrite. Test it.

## Files to create

```
src/tui/screens/Run.tsx
src/tui/components/StepList.tsx
src/tui/components/AgentRows.tsx
src/tui/components/Transcript.tsx     virtualized pane: wrap cache, prefix sum, memoized rows
src/tui/components/StatusLine.tsx
src/tui/format.ts                 elapsed, tokens, truncation and `wrapLines(text, width)` helpers
src/tui/screens/Run.test.tsx
src/tui/components/Transcript.test.tsx
src/tui/format.test.ts
```

`wrapLines` word-wraps on display width (`string-width`, already a
dependency of Ink) and is the one wrapping routine the pane uses, so
the measured height and the rendered height can never disagree. Ink's
own `wrap` is not used inside the pane for the same reason.

## Tests

- `format`: elapsed and token formatting edge cases.
- Snapshot of the running mock from a scripted `RunView` fed with
  events from a fake-provider run.
- Agent row isolation: with a render-count probe on `AgentRows`,
  advancing fake timers by 5 s re-renders the leaves but not the row;
  a transcript record on the same step does not re-render the row
  either.
- Transcript virtualization: a buffer of 5000 single-line records at
  `height` 20 renders a frame of exactly 20 lines and mounts at most 20
  rows (count with a probe on the row component); a `pageDown`
  re-renders only the rows that entered the window; pushing one record
  while following re-renders the pane and the bottom-edge row, not the
  rows above; changing `width` re-wraps a long record to the new line
  count; toggling a tool record changes only that record's height in
  the prefix sum.
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
