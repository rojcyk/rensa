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
- [ ] [10 Claude adapter](10-claude-adapter.md) — Claude Code headless integration, stream parsing, session resume, skills staging, auth check, first fixture capture.
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
    batch.ts             coalesces engine events into one setState per 50 ms
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
  skills: string[]              // absolute paths to skill directories
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
  done: Promise<RunStatus>
  transcript(step: string, label: string): RingBuffer<TranscriptRecord>   // step 11: engine-owned buffers
  partial(step: string, label: string): string | undefined               // step 11
}
// Events: 'event' (RunEvent, one per events.jsonl line),
//         'transcript' (step, label, TranscriptRecord, partial?: boolean),
//         'providers' (ProviderStatus[], after every completed check)

// Process death (step 06, re-exported here):
function onShutdown(fn: () => void): () => void    // synchronous callbacks, LIFO, run once on any exit
function onInterrupt(fn: () => void): () => void   // replaces the default SIGINT behaviour (shutdown + exit 130)
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
- 2026-10-31, Ink 8 pass. TUI steps rewritten for `ink@8.0.0` with
  React 19.3: step 11 gains the terminal session (inline and
  fullscreen via `alternateScreen`, `incrementalRendering: true`,
  `maxFps: 20`, ownership-tracked fatal restore through step 06's
  shutdown registry, PTY tests), sizing with immediate bounds and a
  50 ms settled wrap width, `Layout` with row budgets and compact
  modes, engine-owned ring buffers reachable from `RunHandle`,
  `Spinner` on `useAnimation`, `InputBox` on `useInput` + `usePaste` +
  `useCursor`; `useTick`, `ink-spinner` and `ink-text-input` are gone.
  Step 13 lays out through `Layout` and adds `Ratchet`. Step 14's
  transcript becomes a pure indexed viewport model (`viewport.ts`:
  Fenwick heights, logical anchor, explicit follow, streaming tail,
  one normalization and width policy on `wrap-ansi` + `string-width`)
  and gains the painting rule D with color-aware tests; the `<Static>`
  idea is dropped. New step 11b measures fullscreen on three terminals
  after step 14 and decides the default mode; until then inline is the
  default. Step 01 carries a dated dependency note. Steps 02–10 and
  15–17 untouched.
