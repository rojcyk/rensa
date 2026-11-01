# 07 Adapter interface and fake provider

## Goal

The contract every provider implements, the normalized events an
adapter emits, the registry that maps provider names to adapters, the
availability check, the fixture format, and a `fake` adapter that
replays fixtures. After this step the engine can be built and tested
without any real CLI.

## Context

Steps 01–06 merged. Step 05's `src/engine/run/types.ts` declares
`TranscriptRecordSchema`, `NewTranscriptRecordSchema`, `UsageSchema` and
`AgentErrorSchema` as zod schemas and derives the types from them. This
step reuses those; it declares no second version of a record, a usage
block or an agent error.

## Files to create

```
src/engine/adapters/types.ts
src/engine/adapters/registry.ts
src/engine/adapters/available.ts
src/engine/adapters/fake/index.ts
src/engine/adapters/fake/fixture.ts
src/engine/diag.ts                 diagnostics sink: the only place engine code sends a message "to the user"
test/fixtures/fake/hello/          hand-written fixture for tests
src/engine/adapters/available.test.ts
src/engine/adapters/fake/index.test.ts
src/engine/adapters/fake/fixture.test.ts
src/engine/diag.test.ts
```

## Diagnostics sink (diag.ts)

```ts
export function diag(scope: string, message: string): void
export function onDiag(fn: (entry: { t: string; scope: string; message: string }) => void): () => void
export function drainDiag(): ReadonlyArray<{ t: string; scope: string; message: string }>   // returns and clears the buffer
```

Nothing under `src/engine/` writes to `process.stdout`, `process.stderr`
or `console`. Why: the TUI (step 11) renders with Ink's incremental
writer, which moves the cursor relative to where it believes the last
frame ended and repaints only lines it considers changed; one foreign
`stderr` line during a session shifts the cursor and leaves the frame
misaligned until a full repaint. The engine therefore has no opinion
about where a diagnostic goes: `diag()` appends to a bounded in-memory
buffer (200 entries, oldest dropped) and notifies listeners, and the
frontend decides. The headless CLI streams entries to stderr (step
09); the TUI records them and prints after the terminal is restored
(step 11). First consumer: the Claude availability check (step 10)
under `RENSA_DEBUG`; the gate is the frontend's, not the caller's, so
engine code calls `diag()` unconditionally and cheaply.
All three functions are exported from `src/engine/index.ts`, since the
frontends import the engine only through it.

## Contract (types.ts)

```ts
interface Capabilities { resume: boolean; model: boolean; effort: Effort[]; tools: Tools[] }

type Availability =
  | { status: 'not_installed' }
  | { status: 'not_logged_in'; version: string; hint: string }
  | { status: 'ready'; version: string }

interface SpawnRequest {
  cwd: string; env: NodeJS.ProcessEnv
  message: string                     // the rendered step prompt
  persona?: string                    // agent prompt file contents, first use only
  model?: string; effort?: Effort; tools: Tools
  session: { id: string; resume: boolean }
  stagingDir: string                  // runs/<id>/agents/<step>/<label>/ for adapter scratch
  timeoutMs: number
}

type AgentEvent =
  | NewTranscriptRecord                                       // text | tool | note, from step 05's
                                                              // NewTranscriptRecordSchema; the engine
                                                              // stamps `t` and appends it unchanged
  | { kind: 'delta'; text: string }                           // streaming text, display only
  | { kind: 'raw'; line: string }                             // every raw stdout line, before parsing
  | { kind: 'usage'; usage: Usage }
  | { kind: 'done'; reply: string; exitCode: number | null; usage?: Usage; error?: AgentError; sessionId?: string }
// sessionId: set only by adapters whose CLI assigns its own session id (Codex);
// the engine records it in run.json in place of the id it generated.
// Usage and AgentError are step 05's types (UsageSchema, AgentErrorSchema).

interface AgentProcess { pid?: number; kill(): void; events: AsyncIterable<AgentEvent> }

interface Adapter {
  readonly provider: Provider
  capabilities(): Capabilities
  available(env: NodeJS.ProcessEnv): Promise<Availability>
  spawn(req: SpawnRequest): AgentProcess
}
```

Rules every adapter follows:

- Exactly one `done` event, always last, even after `kill()` or a
  spawn failure (then `exitCode: null`, `error.kind: 'exit'`).
- `raw` is emitted for every line before any other event derived from
  it, so `raw.jsonl` is complete.
- `delta` carries only new text, for display while a block streams; the
  `text` record that follows carries the full block and supersedes the
  deltas for that block. Only records reach `transcript.jsonl`; deltas
  never do. This union is the only streaming vocabulary in the
  codebase: no record type has a `partial` field, in step 05's schema,
  in any adapter (steps 10, 15, 16) or on the engine's events (step
  08). An adapter that can only observe a finished block emits the
  record and no deltas; one that streams emits deltas and then the
  record. The engine (step 08) treats any record for a key as the end
  of the deltas accumulated for that key.
- The adapter never writes to the run directory itself except inside
  `stagingDir`, and never prints: anything worth telling the user goes
  through `diag()`.
- Adapters know nothing about skills. A chain's `skills:` are inlined
  into the message by the engine (step 08) before `spawn` is called, so
  `SpawnRequest` carries no skill paths and no adapter stages, links or
  flags anything for them. Why: of the three CLIs only Claude Code has
  a per-process way to load a skills directory (`--add-dir`); Grok's
  single-turn mode and Codex have none, and their discovery roots are
  the checkout and the user's home, which an adapter must not write
  into. Inlining is the one mechanism that works on every provider,
  per agent, and writes nothing anywhere. Skills the user keeps in a
  CLI's own project or home folders (`.claude/skills/`,
  `.agents/skills/`, `~/.grok/skills/`, …) are still found by that
  CLI's native discovery; rensa neither adds to nor blocks that.

## Registry (registry.ts)

```ts
export function getAdapter(p: Provider): Adapter
export function allAdapters(): Adapter[]
```

`fake` is registered only when `RENSA_DEV=1`. Claude, grok, codex are
registered as stubs here whose `available()` returns `not_installed`
and whose `spawn()` throws `RensaError('INTERNAL', 'adapter not implemented')`;
steps 10, 15, 16 replace them.

## Availability (available.ts)

```ts
interface ProviderStatus { provider: Provider; availability: Availability }
export async function checkProviders(env: NodeJS.ProcessEnv): Promise<ProviderStatus[]>
```

Runs every registered adapter's `available()` in parallel with a 3 s
timeout each; a timeout counts as `not_installed`. A helper
`findOnPath(bin: string, env): Promise<string | undefined>` lives here
for adapters to use.

Every `available()` call, and the subprocess each real adapter spawns
inside it, starts in the same tick as the `checkProviders` call: call
all adapters first, then `Promise.all` the results, with no `await`
before the calls. Step 08 calls this as the first statement of
`Engine.open` and deliberately does not await it, so that the three
provider subprocesses, the slowest part of startup, run while config
discovery, chain loading and (in the TUI) the Ink module graph load.
The eager start is what makes that overlap real; an adapter that awaits
`findOnPath` before spawning its version check is still fine, as long
as `findOnPath` itself starts its work synchronously.

## Fixture format (fixture.ts)

A fixture is a directory:

```
test/fixtures/<provider>/<name>/
  meta.json          { "provider": "claude", "captured": "2026-11-02", "argv": [...], "note": "..." }
  raw.jsonl          the provider's stdout, one line per line, as captured
  transcript.jsonl   the expected normalized records (step 05 format)
  reply.md           the expected final reply
  done.json          the expected `done` event minus `reply`
```

Fixtures for real providers are captured from real runs (steps 10, 15,
16 describe how); the `fake` fixture under `test/fixtures/fake/hello/`
is written by hand in this step. Provide `loadFixture(dir)` and a
`fixtureTest(adapter, dir)` helper that feeds `raw.jsonl` through an
adapter's parser and asserts the transcript, reply, and done output
match. Parsers are therefore exposed as a pure function on each adapter:
`parse(lines: AsyncIterable<string>): AsyncIterable<AgentEvent>`.

`loadFixture` parses each `transcript.jsonl` line with
`TranscriptRecordSchema` and fails loudly on the first line that does
not fit, so a mistyped fixture is reported as such and not as a diff
against the adapter's output. `fixtureTest` compares the records the
parser emitted, stamped with the fixture's `t` values, against those
lines.

## Fake adapter (fake/index.ts)

- `capabilities()`: resume true, model true, effort all four, tools both.
- `available()`: `ready`, version `fake`. Two env hooks for tests:
  `RENSA_FAKE_AVAILABILITY=not_installed|not_logged_in` returns that
  status instead (with hint `fake login`), and
  `RENSA_FAKE_AVAILABLE_DELAY_MS` delays the answer, so step 08 can
  observe `Engine.open` resolving before the check and a missing
  provider refusing a start.
- `spawn(req)`: chooses a fixture directory from, in order,
  `req.env.RENSA_FAKE_FIXTURE`, else `test/fixtures/fake/hello`.
  Replays `raw.jsonl` lines with a configurable delay
  (`RENSA_FAKE_DELAY_MS`, default 20) through its own `parse`, which
  understands a tiny JSONL dialect:

  ```
  {"type":"delta","text":"..."}
  {"type":"text","text":"..."}
  {"type":"tool","name":"Read","input":{"path":"x"},"ok":true,"output":"..."}
  {"type":"usage","input":10,"output":20}
  {"type":"done","exit":0}            // or {"type":"done","exit":1,"error":{"kind":"auth","message":"..."}}
  ```

  `kill()` stops replay and emits `done` with `exitCode: null`,
  `error.kind: 'exit'`, `message: 'killed'`, after
  `RENSA_FAKE_KILL_DELAY_MS` (default 0) so step 08 can test that the
  run is finished only once that late `done` has arrived.
- Records `req` into `stagingDir/request.json` so engine tests can
  assert what was sent (message, persona presence, session flags).

## Tests

- `diag`: entries carry `t`, `scope`, `message`; a listener receives
  each; the buffer keeps the last 200; `drainDiag()` returns them in
  order and empties the buffer; with `process.stdout.write` and
  `process.stderr.write` spied, a `diag()` call writes nothing.
- Fixture helper round-trips the hand-written fixture through the fake
  adapter's `parse`.
- `kill()` mid-replay yields exactly one `done` with `killed` message.
- `checkProviders` with only `fake` registered returns one `ready`
  entry; stubs return `not_installed`.
- `checkProviders` starts every adapter before awaiting any: with two
  stub adapters whose `available()` records the time it was entered and
  then waits 50 ms, both entry times precede the first resolution.
- `findOnPath` finds `sh`, does not find `definitely-not-a-binary`.

## Verification (human)

Read `types.ts` end to end; this is the contract three real adapters
will be written against. Change requests here are cheap now and
expensive after step 10.

## Out of scope

Any real provider.
