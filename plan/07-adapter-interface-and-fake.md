# 07 Adapter interface and fake provider

## Goal

The contract every provider implements, the normalized events an
adapter emits, the registry that maps provider names to adapters, the
availability check, the fixture format, and a `fake` adapter that
replays fixtures. After this step the engine can be built and tested
without any real CLI.

## Context

Steps 01–06 merged.

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
  | { kind: 'text'; text: string; partial: boolean }          // partial=true for streaming deltas
  | { kind: 'tool'; name: string; input: unknown; ok: boolean; output: string }
  | { kind: 'raw'; line: string }                             // every raw stdout line, before parsing
  | { kind: 'usage'; usage: Usage }
  | { kind: 'done'; reply: string; exitCode: number | null; usage?: Usage; error?: AgentError; sessionId?: string }
// sessionId: set only by adapters whose CLI assigns its own session id (Codex);
// the engine records it in run.json in place of the id it generated.
interface AgentError { kind: 'usage_limit' | 'auth' | 'exit' | 'no_output'; message: string }

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
- `text` with `partial: true` carries only the new delta; a following
  `text` with `partial: false` carries the full block and supersedes
  the deltas for that block.
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

## Fake adapter (fake/index.ts)

- `capabilities()`: resume true, model true, effort all four, tools both.
- `available()`: `ready`, version `fake`.
- `spawn(req)`: chooses a fixture directory from, in order,
  `req.env.RENSA_FAKE_FIXTURE`, else `test/fixtures/fake/hello`.
  Replays `raw.jsonl` lines with a configurable delay
  (`RENSA_FAKE_DELAY_MS`, default 20) through its own `parse`, which
  understands a tiny JSONL dialect:

  ```
  {"type":"text","text":"...","partial":true}
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
- `findOnPath` finds `sh`, does not find `definitely-not-a-binary`.

## Verification (human)

Read `types.ts` end to end; this is the contract three real adapters
will be written against. Change requests here are cheap now and
expensive after step 10.

## Out of scope

Any real provider.
