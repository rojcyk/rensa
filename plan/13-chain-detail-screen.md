# 13 Chain detail screen

## Goal

The screen between selecting a chain and running it: the chain's
identity, its steps and agents, the launch checks, and the input box.
Enter starts a run and hands off to the run screen.

## Context

Steps 01–12 merged. The run screen (step 14) does not exist yet; for
this step, starting a run navigates to a placeholder run screen that
shows the run id and `complete`/`failed` when `handle.done` resolves.
Step 14 replaces that placeholder.

## Layout

```
⎇ feat/quote-limits (in place)  ~/Repos/trezor-suite              tdd-review
──────────────────────────────────────────────────────────────────────────

┌──────────────────────────────────────────────────────────────────────┐
│  rensa 0.1.0                                                         │
│                                                                      │
│  tdd-review                                                          │
│  Tests first, implementation, three reviewers, routed fixes, re-test.│
└──────────────────────────────────────────────────────────────────────┘

  ○ baseline     npm test
  ○ write-tests
    tester       claude · opus · high
  ○ implement
    impl         claude · opus · high
  ○ test         npm test
  ○ review-codex
    codex        codex · default · medium
  ○ retest       npm test

  working tree clean

┌──────────────────────────────────────────────────────────────────────┐
│ ›                                                                    │
└──────────────────────────────────────────────────────────────────────┘
```

- Header: mode suffix `(in place)` always in the MVP; chain name on the
  right.
- Frame: `rensa <version>` in `muted`, blank line, chain name in `text`,
  description in `muted`. A chain that failed to load shows the error
  in `err` instead of the description and nothing below the frame
  except `esc back`.
- Timeline: one row per step. Marker `○` in `dim`. Step id in `text`.
  Shell steps show the command on the same row in `muted`. Agent steps
  show one row beneath, indented to the id column: label in `muted`,
  then `provider · model · effort` in `muted` where `model` prints as
  `default` when unset and `effort` is omitted when unset. Column
  widths: marker 2, id = longest id + 2, detail the rest.
- Status line, one of:
  - `working tree clean` in `muted` (only when `chain.writes`; read-only
    chains show nothing here)
  - `! working tree has uncommitted changes; commit or stash to start`
    in `warn`
  - `! grok is not installed; this chain cannot start` or
    `! codex is not logged in (run: codex login); this chain cannot start`
    in `err`
  - `! another run is active: <run id>` in `err`
- Input area, by `chain.input`:
  - `text`: a framed `ink-text-input` with `›` prompt. Enter with text
    starts; Enter empty does nothing.
  - `file`: same box, placeholder `path to file`, value is a path
    relative to the repo root; Enter starts if the file exists, else the
    status line shows `! file not found: <path>` in `err`.
  - `none`: no box; the line `press enter to start` in `muted`.

## Launch checks

Computed on screen mount and after each key press that could change
them (cheap: `git status --porcelain` is the only call):

```ts
interface LaunchCheck { ok: boolean; message?: string; level?: 'warn' | 'err' }
```

The engine exposes `engine.preflight(chainName): Promise<LaunchCheck>`
(add it in this step, inside the engine, reusing the same checks
`start()` performs). The screen renders its message and disables Enter
when `ok` is false.

## Keys

`enter` start (when the checks pass and the input rule is satisfied);
`esc` back to chains; typing goes to the input box when present.

## Starting

`engine.start(chain, input)` → `navigate({ name: 'run', chain, run: handle })`.
A `RensaError` thrown by `start` (race with the preflight) is shown in
the status line.

## Files to create

```
src/tui/screens/Detail.tsx
src/tui/components/Timeline.tsx        shared with step 14: props { steps, mode: 'static' | 'live', selected? }
src/tui/components/InputBox.tsx
src/engine/engine.ts                   add preflight()
src/tui/screens/Detail.test.tsx
src/engine/engine.preflight.test.ts    integration, as in step 08
```

## Tests

- Snapshot of the mock above from a stubbed chain.
- `input: none` renders `press enter to start`; `text` renders the box.
- Preflight: clean tree ok; dirty tree message; missing provider
  message with hint; lock message.
- Enter with an empty text input does not call `start`.

## Verification (human)

Open the `hello` chain from step 10, type a prompt, press Enter: the
placeholder run screen appears and resolves to `complete`. Make the
tree dirty and confirm the refusal line.

## Out of scope

Rendering the run.
