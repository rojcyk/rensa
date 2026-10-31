# 09 Headless CLI

## Goal

`rensa run <chain>` executes a chain with no UI and prints events as
lines, and `rensa doctor` prints provider availability. This is the
entry point for scripts and CI and the proof that the engine needs no
terminal.

## Context

Steps 01–08 merged. `src/cli/main.ts` currently only handles
`--version` and `--help`.

## Commands

```
rensa                                  (TUI; step 11 wires this; for now prints "TUI not implemented" and exits 2)
rensa run <chain> [input text]
rensa run <chain> --input-file <path>
rensa run <chain> --base <ref> --no-pause
rensa doctor
rensa --version | --help
```

Argument parsing: hand-written over `process.argv`, no dependency. Keep
it in `src/cli/args.ts` with a small test. Unknown flags: print usage to
stderr, exit 64.

## rensa run

1. `Engine.open(process.cwd())`. Nothing to wait for beyond that:
   `start()` awaits the provider check itself.
2. Determine input: positional text → `{kind:'text', text}`;
   `--input-file` → `{kind:'file', path}`; neither → `{kind:'none'}`.
   The engine validates against the chain's `input` kind.
3. `engine.start(chain, input, { headless: true, noPause, base })`.
   A `RensaError` before start prints `error: <message>` and, if
   present, `  hint: <hint>` to stderr, exit 1.
4. Subscribe to `'event'` and `'transcript'`, print as below, await
   `handle.done`.
5. Exit 0 on `complete`, 1 on `failed` or `aborted`.
6. `SIGINT` (ctrl+c): first press calls `handle.abort()`; second press
   within 2 s exits immediately with 130. Install this listener before
   `engine.start()`: step 06's shutdown module stands down on `SIGINT`
   whenever another listener is registered, and with none it would exit
   130 on the first press. The `process.exit(130)` on the second press
   runs the shutdown callbacks (kill children, release lock) through
   `'exit'`; do not duplicate that cleanup here.

## Output format (stdout)

One line per event, local time:

```
09:12:03  run       started    tdd-review  base feat/quote-limits @ a1b2c3d  run 2026-10-28_0912_tdd-review_7f3a
09:12:03  step      started    baseline   npm test
09:12:44  step      finished   baseline   ok  0:41
09:12:44  step      started    write-tests
09:12:44  agent     spawned    write-tests/tester   claude · opus · high   session 3f…  new
09:13:01  write-tests/tester | Reading the task...
09:13:02  write-tests/tester | ▸ Read src/api/quote.ts
09:14:36  agent     finished   write-tests/tester   ok  1:52  12.4k tok
09:14:36  step      finished   write-tests   ok  1:52
09:20:10  run       paused     before fix-tests   (declared; --no-pause to skip)
09:24:01  run       finished   complete  11:58
```

- Transcript text records print each line prefixed with
  `<step>/<label> | `. Partial deltas are not printed; only final
  `text` records, so output is line-oriented and greppable.
- Tool records print as `▸ <name> <one-line input summary>` where the
  summary is the first string-valued field of `input` truncated to 80
  chars.
- Durations are computed from event timestamps through step 08's
  `view.ts`: keep a `Map<string, StepView>` seeded with
  `initialSteps(chain.steps)` and fold every incoming event with
  `applyEvent`; a `step finished` line prints `finishedAt − startedAt`
  of that step, an `agent finished` line the same from its `AgentView`,
  and the `run finished` line `reduceRun(events)`'s span. The CLI never
  switches on event types to work out state; it only formats.
- `--quiet` prints only `run`, `step`, and `agent` lines.
- `--json` prints the raw event objects and transcript records as
  JSONL instead, for machines.

When stdout is not a TTY, no colors; when it is, use `step` and `agent`
line keywords in the theme's secondary color and errors in red, via
plain ANSI codes, no dependency.

## rensa doctor

```
claude   ready            2.1.3
codex    not logged in    0.48      run: codex login
grok     not installed
```

Exit 0 if every provider used by at least one chain in the repo is
ready, else 1. Outside a repo, lists providers and exits 0. `doctor`
is the one command that awaits `engine.providersChecked` directly,
then reads `providers()` and `chains()`.

## Files to create

```
src/cli/args.ts
src/cli/headless.ts
src/cli/doctor.ts
src/cli/format.ts          line formatting shared with doctor
src/cli/main.ts            dispatch; imports args, headless, doctor and the engine statically, nothing from src/tui/
src/cli/args.test.ts       colocated
test/e2e/run.test.ts       e2e: spawns the built CLI with RENSA_DEV=1 against a tmp repo and a fake-provider chain
test/e2e/doctor.test.ts    e2e: spawns `rensa doctor` the same way
vitest.e2e.config.ts       include `test/e2e/**/*.test.ts`, environment node
```

These are the first end-to-end tests (see "Where tests live" in
`index.md`), so this step also wires them up:

- `package.json`: add `"test:e2e": "vitest run --config vitest.e2e.config.ts"`
  and append `&& npm run test:e2e` to `check`, after `build`.
- `tsconfig.test.json`: add `test` to `include` so e2e tests typecheck.
- `vitest.config.ts` stays on `src/**` only, so `npm test` never needs a
  build.

The e2e tests import nothing from `src/` except `src/testing/`; they
locate the binary at `dist/cli/main.js` and fail with a clear message
if it is missing. Chains come from `test/fixtures/chains/`.

## Tests

- Args: every form above, unknown flag exit code.
- E2E (`test/e2e/run.test.ts`): `rensa run` on a two-step fake chain prints the expected
  line sequence (assert on the keyword columns, not timestamps) and
  exits 0; a chain with a `pause` exits 1 with the hint unless
  `--no-pause`; `--json` output parses line by line.
- E2E (`test/e2e/doctor.test.ts`): `doctor` exits as specified with the
  fake provider registered.

## Verification (human)

In a scratch repo with a fake chain, `RENSA_DEV=1 rensa run hello "do
nothing"` and read the output. Press ctrl+c mid-run and confirm the run
directory ends with a `run.finished aborted` event.

## Out of scope

The TUI. Any real provider.
