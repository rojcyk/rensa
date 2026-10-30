# 14 Run screen

## Goal

The live view of a run and, unchanged, the view of a finished one. Two
columns: steps on the left, the selected step's agent row and transcript
on the right. Navigation, follow mode, pause with notes, kill, abort,
end states. This completes the TUI MVP (dogfooding milestone 2).

## Context

Steps 01–13 merged. All data comes from `RunView` (step 11) and the
transcript ring buffers; the screen computes nothing beyond layout.

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
`aborted`. Elapsed stops at `run.finished`. Color: `muted`; the state
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
4. Rule in `faint`.
5. Transcript area: the rest of the body height.

### Transcript rendering

Source: `view.transcript(step, label)` records plus the current partial
line.

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
- Scrolling: the area shows a window of lines; `pageUp`/`pageDown` move
  by half the area height; `top`/`bottom` jump. While following, the
  window sticks to the bottom; any manual scroll detaches the window
  until `bottom`.
- Finished steps render through `<Static>`-like memoized blocks: once a
  step is finished, its transcript component is memoized on the record
  count and never re-wraps.

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

Header state word and color change; spinners stop; the last step stays
selected unless the user moved; the note box goes inert. Nothing else
changes.

### Finished run from disk

`Run.tsx` takes either a live `RunHandle` or a `RunDir`; in the second
case `RunView` is built by reading `events.jsonl` and transcripts once.
No entry point in the MVP opens it that way (history screen deferred),
but the component must support it so the deferred feature is a
navigation change, not a rewrite. Test it.

## Files to create

```
src/tui/screens/Run.tsx
src/tui/components/StepList.tsx
src/tui/components/AgentRows.tsx
src/tui/components/Transcript.tsx
src/tui/components/StatusLine.tsx
src/tui/format.ts                 elapsed, tokens, truncation helpers
test/unit/tui/run.test.tsx
test/unit/tui/format.test.ts
```

## Tests

- `format`: elapsed and token formatting edge cases.
- Snapshot of the running mock from a scripted `RunView` fed with
  events from a fake-provider run.
- Keys: `right` selects the next step and detaches; `ctrl+f`
  reattaches; `pageDown` moves the window; `enter` on a tool line
  toggles expansion.
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
