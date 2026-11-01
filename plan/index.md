# rensa MVP implementation plan

Sequential. Each step is one reviewable change, specified in its own file
so a model can implement it without reading the others. Later steps
assume earlier ones are merged exactly as specified. Tick a step when it
has been implemented, reviewed, and merged.

Read `CLAUDE.md` first. The architecture rule there (engine and UI
separate) is enforced by a lint rule from step 01 onward.

## Steps

- [x] [01 Scaffold](01-scaffold.md) — package, tooling, directory layout, import boundary lint, `rensa --version`.
- [x] [02 Config discovery](02-config-discovery.md) — locate `.rensa/`, user config dir, chain files, project files; write `.gitignore`.
- [x] [03 Chain loading](03-chain-loading.md) — parse YAML, resolve agents across levels, expand `from:`, derive labels, validate, structured errors.
- [x] [04 Templates and variables](04-templates-and-vars.md) — `{{name}}` rendering, namespace, `vars` evaluation, output-map rendering, user notes.
- [x] [05 Run storage](05-run-storage.md) — run id, run directory, `run.json`, `events.jsonl` single writer and reader, transcript writer.
- [ ] [06 Processes and shell steps](06-processes-and-shell-steps.md) — spawn in a process group, kill, timeout, line readers, env stripping, shell step executor, ordered synchronous shutdown hook.
- [ ] [07 Adapter interface and fake provider](07-adapter-interface-and-fake.md) — adapter contract, normalized agent events, fixture format, fake adapter that replays fixtures.
- [ ] [08 Engine](08-engine.md) — orchestrator: locks, availability check, sequential steps, pauses, user commands, event emission.
- [ ] [09 Headless CLI](09-headless-cli.md) — `rensa run`, `rensa doctor`, line output, exit codes.
- [ ] [10 Claude adapter](10-claude-adapter.md) — Claude Code headless integration, stream parsing, session resume, persona staging, auth check, first fixture capture.
- [ ] [11 TUI foundation](11-tui-foundation.md) — Ink 8 terminal session (inline and fullscreen), sizing and layout, theme, header, key routing, store, engine bridge, engine-owned ring buffers, input box.
- [ ] [11b Fullscreen measurement](11b-fullscreen-measurement.md) — human-executed after step 14: measure fullscreen with incremental rendering on three terminals, decide the default mode. Ticked after 14, not before.
- [ ] [12 Chains screen](12-chains-screen.md) — provider line, chain list, annotations, recheck.
- [ ] [13 Chain detail screen](13-chain-detail-screen.md) — info box, timeline with agents, ratchet, launch checks, input box, start.
- [ ] [14 Run screen](14-run-screen.md) — two columns, agent rows, indexed transcript viewport, painting rule, navigation, pause and notes, kill and abort, end states.
- [ ] [15 Grok adapter](15-grok-adapter.md) — Grok Build headless integration, fixture-driven parser, auth file check.
- [ ] [16 Codex adapter](16-codex-adapter.md) — Codex `exec --json` integration, resume, sandbox mapping, login status.
- [ ] [17 Release](17-release.md) — packaging, README, publish checklist, clean-machine smoke test.

Dogfooding milestones: after 10, a one-step chain runs headless on Claude
Code against this repository. After 14, the same through the TUI, and
step 11b's measurement runs on it. After 15, a review step on Grok.
After 16, all three providers.

## Pinned versions

Exact pins in `package.json`, no `^`. Verified 2026-10-31:

- `ink@8.0.0`, requires `react@19.3.x`. `render()` options used:
  `alternateScreen`, `incrementalRendering` (repaints changed lines
  only, skips unchanged prefixes), `maxFps`, `exitOnCtrlC`,
  `patchConsole`. Hooks used: `useWindowSize`, `useAnimation`,
  `useCursor`, `usePaste`, `useInput`, `useStdout`, `useBoxMetrics`.
  `Box` props used: `backgroundColor` (fills the interior, excluding
  borders), `overflow`/`overflowX`/`overflowY`,
  `contentOffsetX`/`contentOffsetY`, border background colors. Ink
  installs its own process-exit cleanup and, in alternate-screen mode,
  discards all output produced during teardown.
- `ink-spinner@5.0.0` and `ink-text-input@6.0.0` (May 2024) predate
  Ink 8 and are **not used** (step 01 note); step 11 provides `Spinner`
  and `InputBox`.
- `ink-testing-library@4.0.0` (dev) must pass step 01's smoke test
  under Ink 8; otherwise tests use the `Writable` frame collector
  recorded in step 01.
- `wrap-ansi` and `string-width`, direct runtime dependencies from
  step 14, pinned at the latest stable at implementation time.
- `node-pty` (dev), from step 11, for the PTY session tests.

## Architecture

### Directory layout

```
src/
  engine/
    config/      paths.ts, discover.ts, load.ts, resolve.ts, validate.ts, types.ts
    template/    render.ts, namespace.ts, vars.ts
    run/         id.ts, dir.ts, runjson.ts, events.ts, transcript.ts, view.ts, ringBuffer.ts
    process/     spawn.ts, lines.ts, env.ts, shell.ts, shutdown.ts
    adapters/    types.ts, registry.ts, available.ts, fake/, claude/, grok/, codex/
    engine.ts    Engine class
    errors.ts    RensaError and codes
    index.ts     public surface of the engine
  cli/
    main.ts      argument parsing and dispatch
    headless.ts  rensa run
    doctor.ts    rensa doctor
  tui/
    app.tsx              root: SizeContext, Layout, screen router
    terminalSession.ts   mode, render options, normal quit, fatal restore
    size.tsx             SizeContext: bounds (immediate) and settledColumns (50 ms)
    layout.ts            pure layoutBudget(), compact thresholds
    theme.ts
    store.ts             external store; setState skips notification on the same reference; useStore
    frameRate.ts         MAX_FPS and FRAME_MS, the one place the frame rate is written
    batch.ts             coalesces engine events into one setState per frame (FRAME_MS)
    engineBridge.ts
    viewport.ts          pure transcript viewport model (step 14)
    screens/             Chains.tsx, Detail.tsx, Run.tsx
    components/          Layout.tsx, Header.tsx, Spinner.tsx, Elapsed.tsx, InputBox.tsx, Ratchet.tsx, Row.tsx, Timeline.tsx, AgentRows.tsx, Transcript.tsx
    hooks/               useKeys.ts
  testing/       shared test helpers (tmpRepo.ts); never imported by production code
```

Import rule: nothing under `src/engine/` imports from `src/tui/` or
`src/cli/`. `src/tui/` and `src/cli/` import the engine only through
`src/engine/index.ts`.

### Where tests live

There are two kinds of test, and the kind decides the location.

**Colocated tests** (`src/**/*.test.ts`, `src/**/*.test.tsx`) sit next to
the file they test: `foo.ts` and `foo.test.ts` share a directory. They
import the code under test directly and run in-process. This covers unit
tests and in-process integration tests, such as `engine.test.ts`, which
drives a real run through `Engine` with the fake provider and a temp
repo. Rule of thumb: if the test calls a function or class, it is
colocated with the file that defines it. `npm test` runs these.

**End-to-end tests** (`test/e2e/**/*.test.ts`) exercise rensa the way a
user does: they spawn the built `dist/cli/main.js` as a child process
and assert only on stdout, stderr, exit code, and files on disk. They
import nothing from `src/` except helpers in `src/testing/`. They span
the whole program rather than one file, so they have no file to sit
next to. They need `npm run build` first, and `npm run test:e2e` runs
them (step 09 sets this up).

Fixtures are data, not code, and live in one place at the top level
(the Babel layout). Both kinds of test read from it:

```
test/
  e2e/                        end-to-end tests (step 09 onward)
  fixtures/
    config/                   small yaml inputs for the loader (step 03)
    chains/                   chains used by engine and e2e tests (steps 08, 09)
    <provider>/<name>/        raw.jsonl, transcript.jsonl, meta.json, ... (steps 07, 10, 15, 16)
```

Nothing else goes in `test/`: a test that imports a module belongs next
to that module.

### Core types (defined in step 03 and 07, used everywhere after)

```ts
type Provider = 'claude' | 'codex' | 'grok' | 'fake'
type Effort = 'low' | 'medium' | 'high' | 'max'
type Tools = 'read' | 'write'

interface AgentConfig {
  provider: Provider; model?: string; effort?: Effort; tools: Tools
  prompt?: string               // absolute path to persona file
  skills: string[]              // absolute paths to skill directories; inlined into the first prompt (step 08), never passed to adapters
}

interface ResolvedAgent extends AgentConfig {
  label: string                 // derived; unique within the step
  name?: string                 // registry name when listed by name
  session: 'named' | 'fresh'
}

interface AgentStep {
  id: string; kind: 'agent'
  prompt: string                // absolute path to step prompt file
  agent: ResolvedAgent          // exactly one in the MVP
  vars: Record<string, VarSpec>
  onFail: 'stop' | 'continue'; timeoutMs: number
  pause?: 'before' | 'after'
}
interface ShellStep {
  id: string; kind: 'shell'; command: string
  onFail: 'stop' | 'continue'; timeoutMs: number
  pause?: 'before' | 'after'
}
type Step = AgentStep | ShellStep

interface ResolvedChain {
  name: string; description?: string
  input: 'none' | 'text' | 'file'
  base?: string
  allowApiKeys: boolean
  steps: Step[]
  sources: { chain: string; project?: string; user?: string }   // file paths
}
```

### Engine surface (step 08)

```ts
class Engine extends EventEmitter {
  static async open(cwd: string): Promise<Engine>     // starts the provider check first, unawaited; discovers config, loads chains
  providers(): ProviderStatus[] | undefined           // last completed check; undefined until the first completes
  readonly providersChecked: Promise<ProviderStatus[]> // the check in flight; never rejects
  recheckProviders(): Promise<ProviderStatus[]>       // new check; replaces providersChecked
  chains(): ChainSummary[]                            // loaded or errored
  chain(name: string): ResolvedChain                  // throws RensaError
  preflight(name: string): Promise<LaunchCheck>       // same checks start() performs, without side effects
  start(name: string, input: RunInput, opts?: { noPause?: boolean; headless?: boolean; base?: string }): Promise<RunHandle>
}
interface RunHandle {
  id: string; dir: string
  pause(): void; resume(): void; kill(): void; abort(): void; note(text: string): void
  done: Promise<RunResult>                                               // in-memory terminal state; never rejects
  result(): RunResult | undefined                                        // set when the run ended, from the log or not
  transcript(step: string, label: string): RingBuffer<TranscriptRecord>   // step 11: engine-owned buffers
  partial(step: string, label: string): string | undefined               // step 11: deltas since the key's last record
  events(): ReadonlyArray<RunEvent>                                      // history so far, seq order
  attach(l: RunListeners): { events: ReadonlyArray<RunEvent>; result?: RunResult; detach(): void }   // snapshot + subscribe, atomic
}
interface RunResult { status: RunStatus; failedStep?: string; finishedAt: string; error?: { code: string; message: string; hint?: string } }
interface RunListeners {              // all per run, on the handle; the Engine emitter carries none of these
  event?(e: RunEvent): void                                              // one per events.jsonl line
  transcript?(m: { step; label; record: TranscriptRecord }): void        // after disk and ring buffer
  delta?(m: { step; label; text: string }): void                        // after the partial slot; never on disk
  finished?(r: RunResult): void                                          // once, even when run.finished could not be written
}
// Engine events: 'providers' (ProviderStatus[], after every completed check). Nothing else.

// Process death (step 06, re-exported here):
function onShutdown(fn: () => void): () => void    // synchronous callbacks, LIFO, run once on any exit
function onInterrupt(fn: () => void): () => void   // replaces the default SIGINT behaviour (shutdown + exit 130)

// Diagnostics (step 07): engine code never writes to stdout/stderr/console; frontends decide
function diag(scope: string, message: string): void
function onDiag(fn: (e: { t: string; scope: string; message: string }) => void): () => void
function drainDiag(): ReadonlyArray<{ t: string; scope: string; message: string }>
```

The shutdown module is the only place in the codebase that listens
for `'exit'`, `SIGINT`, `SIGTERM`, `SIGHUP` or `uncaughtException`.
Its listeners are unconditional; nothing counts or inspects signal
listeners (step 06 explains the `signal-exit` interaction that rules
this out).

### Event and transcript formats (step 05)

`events.jsonl` line: `{seq, t, type, step?, agent?, data?}`. Types:
`run.started`, `run.paused`, `run.finished`, `step.started`,
`step.finished`, `agent.spawned`, `agent.finished`, `user.note`,
`user.action`.

`transcript.jsonl` record: `{t, kind: 'text' | 'tool' | 'note', ...}`.

### Conventions

- Errors thrown by the engine are `RensaError` with a `code`, a human
  `message`, and optional `path` and `hint`. The UI and CLI format them;
  the engine never formats for a terminal.
- Durations in events are never stored; consumers compute from `t`.
- Interpreting the event log (which step is running, finished, paused;
  agent rows; run status) is engine logic in `src/engine/run/view.ts`
  (`reduceSteps`, `applyEvent`, `reduceRun`, step 08). The CLI and the
  TUI call it; neither switches on event types itself.
- All file paths in resolved structures are absolute.
- Tests: vitest. Colocated or end-to-end as described under "Where
  tests live"; each step lists the test files it must add. A colocated
  test is named after the module it exercises and may be split as
  `<module>.<topic>.test.ts` (`engine.preflight.test.ts`). An e2e test is
  named after the command it runs (`run.test.ts`, `doctor.test.ts`).
  Integration and e2e tests use the fake provider and a temporary git
  repository from `src/testing/tmpRepo.ts`.
- `tsconfig.json` excludes `*.test.*` and `src/testing/`
  so production typechecking never sees test code; `tsconfig.test.json`
  includes everything. tsdown bundles only from entry points, so none of
  it reaches `dist/`.

## Revision notes

- 2026-11-01, shutdown signals. Step 06's `SIGINT` listener no longer
  stands down when another listener exists; it is unconditional, with
  `onInterrupt` as the explicit override step 09 uses, and `SIGHUP` is
  handled. Reason recorded in step 06: Ink's `signal-exit` also counts
  listeners, so two deferring heuristics swallow the signal. Step 06
  now names `startSession` as where the TUI registers its restore.
- 2026-11-01, React crash path (review P1). Step 11's `Session.done`
  is derived from `waitUntilExit()` observed right after `render`, not
  from `quit()`: Ink's error boundary turns a render-phase throw into
  a rejected exit promise that never reaches `uncaughtException`, so
  `done` rejects, `main.ts` prints the stack and exits 1 through step
  06's registry. PTY tests split the crash scenario into render and
  timer variants.
- 2026-11-01, terminal ownership (review P1, second item). Step 11's
  record sets `alternateScreen` and `cursorHidden` before `render`,
  since Ink enters both in its constructor, and the fatal callback
  clears every flag once Ink's synchronous `unmount()` returns, so no
  duplicate leave sequence is written. Unit tests cover a throw after
  entry and a successful Ink teardown.
- 2026-11-01, streaming events (review P1, third item). Step 07's
  `AgentEvent` union (`delta` plus plain records) is the only
  streaming vocabulary; the `partial` flag is gone from steps 08, 10,
  15, 16 and the engine events. The engine emits `'transcript'` for
  records and `'delta'` for fragments; a record clears its key's
  partial slot. Shell output lines are completed `text` records under
  label `shell`, so the headless CLI prints them.
- 2026-11-01, run-scoped streams (review P1, fourth item). `start()`
  emits `run.started` before returning, so no consumer could subscribe
  in time, and a shared emitter with no run id would interleave two
  live read-only runs. Run streams now live on `RunHandle`:
  `events()` and an atomic `attach()` that returns the history and
  subscribes in one synchronous call; the `Engine` emitter keeps only
  `'providers'`. The headless CLI replays the history; `RunView` seeds
  its store from it and is rebuilt from the handle on re-entry.
- 2026-11-01, abort ordering (review P1, fifth item). Step 08's
  runner gains an `aborting` state: `abort()` kills and returns, the
  loop stops at its next boundary check, the current step drains to
  its own finish events, and only then do `run.finished`, writer
  close, `run.json`, lock release and `done` happen, in that order.
  `RunProgress.status` gains `aborting`; the fake adapter gains
  `RENSA_FAKE_KILL_DELAY_MS`; tests cover abort mid-step, while paused
  and before the first spawn.
- 2026-11-01, terminal result (review P1, sixth item). A run's end is
  an in-memory `RunResult` on the handle, independent of persistence:
  `done` resolves with it, `attach` returns it to late consumers and
  delivers it through a `finished` listener, and step 08's
  `applyResult` merges it into `RunProgress`. Storage failures take a
  defined fatal path that always releases the lock and produces a
  result with a `STORAGE` error; the headless CLI prints it and the run
  screen shows `failed · <message>` instead of running forever.
- 2026-11-01, process groups (review P1, seventh item). Step 06's
  `kill()` escalates to SIGKILL on the group unconditionally after
  `escalateMs`, the live-groups registry drops a pgid only once
  `result` settled and `kill(-pgid, 0)` reports the group gone, and
  `result` is bounded: pipes still held after the escalation are
  destroyed so a step can never wait on a process the module cannot
  reach. Tests cover a leader that exits first with a grandchild
  ignoring SIGTERM, and an escaped member holding the pipes.
- 2026-11-01, vars migration (review P1, eighth item). Step 06 now
  owns moving step 04's shell-variable evaluator onto `spawnProcess`
  (new raw chunk mode) and `childEnv`, with the byte limit and
  trailing-newline semantics unchanged and the existing tests as the
  acceptance criterion; `evaluateVars` gains `env` and a kill signal,
  and step 08 passes both so `$(...)` commands run without API keys and
  stop on abort. Step 04 carries an as-built note.
- 2026-11-01, key focus (review P2). Ink's `useInput` has no
  exclusive capture, so step 11 now mounts exactly one `useInput` per
  screen (inside `useKeys`) and routes by a `focus` of `main`, `input`
  or `confirm`; `InputBox` is a controlled component over a pure
  `editInput` reducer and mounts no hook; an app-level overlay is the
  only active hook while it shows. Step 13 starts in `input` focus and
  calls `start` from one path; step 14's key table is per focus, and
  "enter continues and records the note" is split into two keys.
- 2026-11-01, transcript width (review P2). Step 11's `layoutBudget`
  gains `transcriptCols`, the right column's content width (`rightCols
  − 3`, or `columns − 2` in `narrow` mode), and `useBudget(want)`
  returns the budget for the current and the settled terminal width
  from that one function. Step 14 wraps at the settled `transcriptCols`
  and clips at the current one, never at `settledColumns`; expanded
  tool bodies wrap at `width − 2`; a reachability test checks every
  grapheme is visible by scrolling at widths across the `narrow`
  threshold.
- 2026-11-01, foreign output (review P2). Ink's incremental writer
  cannot repair a frame after a foreign stderr write, so step 07 adds
  `diag.ts`, the only way engine code reports anything, step 10's debug
  log goes through it, step 09 streams it under `RENSA_DEBUG`, and
  step 11's session captures `diag`, `console.*` and Node `'warning'`
  during rendering and prints them after the terminal is restored. A
  test forbids `process.stdout`/`stderr` under `src/engine/` and
  `src/tui/` outside `terminalSession.ts`.
- 2026-11-01, skills (review P2, decided after checking the three
  CLIs). A chain's `skills:` are inlined into the agent's first prompt
  by the engine (`appendSkills`, step 08, with size limits enforced at
  load); `SpawnRequest` no longer carries skill paths and no adapter
  stages, links or flags anything. Claude's `--add-dir` staging
  (step 10) and Grok's global-directory symlink option (step 15) are
  removed; Codex's `.codex/skills` assumption is corrected. Reason:
  only Claude Code has a per-process skills mechanism, and the other
  two would require writing into the user's home or checkout.
  Multi-file skills: the engine copies each skill directory into
  `runs/<id>/skills/<name>/` before the first spawn and the inlined
  `Files:` line names the copy, because every CLI restricts reads to
  the checkout and the run directory is inside it.
- 2026-11-01, frame rate (review P2). Step 11 writes the frame rate
  once, `MAX_FPS` in `frameRate.ts`, and derives the batcher window
  from it. Step 11b now defines passing at 20 or 10 fps, forbids 5,
  ships one `MAX_FPS` (the highest every passing terminal met) and
  records mode, frame rate and the Terminal.app exception as its
  decision.
- 2026-10-31, Ink 8 pass. TUI steps rewritten for `ink@8.0.0` with
  React 19.3: step 11 gains the terminal session (inline and
  fullscreen via `alternateScreen`, `incrementalRendering: true`,
  `maxFps: 20`, ownership-tracked fatal restore through step 06's
  shutdown registry, PTY tests), sizing with immediate bounds and a
  50 ms settled wrap width, `Layout` with row budgets and compact
  modes, engine-owned ring buffers reachable from `RunHandle`,
  `Spinner` on `useAnimation`, `InputBox` on `usePaste` + `useCursor`
  (keys via `useKeys`, see the key-focus note below); `useTick`, `ink-spinner` and `ink-text-input` are gone.
  Step 13 lays out through `Layout` and adds `Ratchet`. Step 14's
  transcript becomes a pure indexed viewport model (`viewport.ts`:
  Fenwick heights, logical anchor, explicit follow, streaming tail,
  one normalization and width policy on `wrap-ansi` + `string-width`)
  and gains the painting rule D with color-aware tests; the `<Static>`
  idea is dropped. New step 11b measures fullscreen on three terminals
  after step 14 and decides the default mode; until then inline is the
  default. Step 01 carries a dated dependency note. Steps 02–10 and
  15–17 untouched.
