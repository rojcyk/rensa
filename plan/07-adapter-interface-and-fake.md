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
test/fixtures/fake/hello/          hand-written fixture for tests
src/engine/adapters/available.test.ts
src/engine/adapters/fake/index.test.ts
src/engine/adapters/fake/fixture.test.ts
```

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
  skills: string[]                    // absolute skill directories
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
  never do.
- The adapter never writes to the run directory itself except inside
  `stagingDir`, and never prints.

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
  `error.kind: 'exit'`, `message: 'killed'`.
- Records `req` into `stagingDir/request.json` so engine tests can
  assert what was sent (message, persona presence, session flags).

## Tests

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
