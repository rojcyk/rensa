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
beyond the one-line default change in `resolveMode` (step 11) and, in
one outcome, a `TERM_PROGRAM` rule next to it. No source changes land
until the outcome below is recorded here.

## Procedure

On a branch, with the step 10 dogfooding chain against this
repository:

1. Run `rensa --fullscreen <chain>` and let a transcript stream for at
   least two minutes. Scroll, detach and re-follow, resize the window
   twice by dragging, pause and resume.
2. Watch for: full-frame flicker, torn lines during a token burst,
   stale cells after a shorter status replaces a longer one, cursor
   artifacts, and lag between a keystroke and the selection moving.
3. Repeat at `maxFps` 10 and then 5 only if 20 is unacceptable (temporary
   edit of the option in `terminalSession.ts`; note the value that
   passed).
4. Do this on each of:
   - macOS Terminal.app
   - one of iTerm2, Ghostty, Kitty, WezTerm
   - VS Code's integrated terminal

Record every terminal's name and version, the `maxFps` that was
acceptable, and the outcome in the table below. "Acceptable" means no
visible flicker or tearing at 20 fps and keystrokes landing within a
frame during a burst.

## Record

| terminal | version | maxFps tried | outcome | notes |
|---|---|---|---|---|
| Terminal.app | | | | |
| iTerm2 / Ghostty / Kitty / WezTerm (which) | | | | |
| VS Code terminal | | | | |

Date and tester: _(fill in)_

## Outcomes, exactly one

- **Acceptable everywhere** → fullscreen becomes the default in
  `resolveMode`; `--inline` is kept as the opt-out. Record it below
  and in the README (step 17).
- **Acceptable everywhere except Terminal.app** → fullscreen becomes
  the default, and `resolveMode` defaults to inline when
  `TERM_PROGRAM=Apple_Terminal`; `--fullscreen` still forces it there.
  README note explaining the exception.
- **Unacceptable** (fails on more than Terminal.app, or fails at 20 fps
  everywhere and only passes at 5) → inline stays the default, and a
  renderer-replacement step is opened: OpenTUI on Bun, or a Rust TUI
  consuming `events.jsonl` and the transcripts over stdio with the Node
  engine unchanged. That step is not planned further until this outcome
  occurs; do not pre-build hooks for it.

Decision: _(fill in)_

## Verification (human)

After the default is changed, `rensa <chain>` with no flag opens in the
decided mode on each tested terminal, and the step 11 PTY session tests
still pass in both modes.

## Out of scope

Any change to screens, the viewport model, or the engine.
