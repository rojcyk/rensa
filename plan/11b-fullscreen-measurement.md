# 11b Fullscreen measurement

## Goal

Decide, from observation rather than assumption, whether rensa's
default rendering mode is fullscreen (alternate screen, Ink 8
incremental rendering) or inline. Step 11 built both behind
`--fullscreen` / `--inline` with inline as the provisional default and
left the decision to this step.

## Context

Human-executed. It runs **after step 14** is merged, because the
measurement needs the run screen with a streaming transcript, and it
is ticked in `index.md` only then. Nothing is implemented in this step
beyond three one-line changes in step 11's code, each only if the
decision calls for it: the default in `resolveMode`, a `TERM_PROGRAM`
rule next to it, and `MAX_FPS` in `frameRate.ts` (the batcher window
follows it automatically). No source changes land until the outcome
below is recorded here.

## Procedure

On a branch, with the step 10 dogfooding chain against this
repository:

1. Run `rensa --fullscreen <chain>` and let a transcript stream for at
   least two minutes. Scroll, detach and re-follow, resize the window
   twice by dragging, pause and resume.
2. Watch for: full-frame flicker, torn lines during a token burst,
   stale cells after a shorter status replaces a longer one, cursor
   artifacts, and lag between a keystroke and the selection moving.
3. If 20 fps is not acceptable on a terminal, repeat at 10 (edit
   `MAX_FPS` in `frameRate.ts` on the branch; the batcher follows).
   Do not try 5: at 5 fps streaming text visibly steps and a keystroke
   can wait 200 ms for its frame, so 5 is a failure, not a setting.
   Record the highest value that passed, or "fails" if 10 did not.
4. Do this on each of:
   - macOS Terminal.app
   - one of iTerm2, Ghostty, Kitty, WezTerm
   - VS Code's integrated terminal

Record every terminal's name and version, the highest `MAX_FPS` that
passed, and the outcome in the table below. "Passes" means no visible
flicker or tearing and keystrokes landing within a frame during a
burst, at 20 or at 10 fps. A terminal that passes only at 10 **passes**;
one that needs less than 10 **fails**.

## Record

| terminal | version | passes at (20 / 10 / fails) | notes |
|---|---|---|---|
| Terminal.app | | | |
| iTerm2 / Ghostty / Kitty / WezTerm (which) | | | |
| VS Code terminal | | | |

Date and tester: _(fill in)_

## Frame rate that ships

One `MAX_FPS` for every terminal, never a per-terminal value: the
highest frame rate at which **every passing terminal** passed. All
passing at 20 → `MAX_FPS` stays 20. Any passing terminal needing 10 →
`MAX_FPS` becomes 10 and, through `FRAME_MS`, the batcher window
becomes 100 ms; nothing else changes (the 50 ms resize-settle delay
stays). Terminals that fail do not lower the rate; they are handled by
the mode decision below. `MAX_FPS` applies to inline mode as well, so
if the decision is inline it is still recorded and, if it changed,
justified in the notes.

## Outcomes, exactly one

- **Acceptable everywhere** → fullscreen becomes the default in
  `resolveMode`; `--inline` is kept as the opt-out. Record it below
  and in the README (step 17).
- **Acceptable everywhere except Terminal.app** → fullscreen becomes
  the default, and `resolveMode` defaults to inline when
  `TERM_PROGRAM=Apple_Terminal`; `--fullscreen` still forces it there.
  README note explaining the exception.
- **Unacceptable** (fails on more than Terminal.app, where "fails"
  means not passing at 10 either) → inline stays the default, and a
  renderer-replacement step is opened: OpenTUI on Bun, or a Rust TUI
  consuming `events.jsonl` and the transcripts over stdio with the Node
  engine unchanged. That step is not planned further until this outcome
  occurs; do not pre-build hooks for it.

Decision: mode _(fill in)_, `MAX_FPS` _(20 or 10)_, `TERM_PROGRAM`
exception _(none or Apple_Terminal)_.

## Verification (human)

After the default is changed, `rensa <chain>` with no flag opens in the
decided mode on each tested terminal, and the step 11 PTY session tests
still pass in both modes. If `MAX_FPS` changed, step 11's batcher unit
test, which asserts the window equals `FRAME_MS`, still passes without
edits; a test that had to be edited means a second copy of the number
exists somewhere and must be removed.

## Out of scope

Any change to screens, the viewport model, or the engine.
