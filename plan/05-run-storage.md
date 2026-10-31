# 05 Run storage

## Goal

Everything a run writes to disk and the reader that turns it back into
state: run id, run directory, `run.json`, the single-writer
`events.jsonl`, and per-agent transcript files. After this step a run
can be reconstructed from its directory alone.

## Context

Steps 01–04 merged.

## Files to create

```
src/engine/run/id.ts
src/engine/run/dir.ts
src/engine/run/runjson.ts
src/engine/run/events.ts
src/engine/run/transcript.ts
src/engine/run/types.ts
src/engine/run/*.test.ts         one per module, next to it
```

## Run id (id.ts)

`YYYY-MM-DD_HHMM_<chain>_<4 hex>`, local time, random suffix from
`crypto.randomBytes`. Example `2026-10-28_0912_tdd-review_7f3a`. Chain
names are file stems and may contain `-` and `_` only (validate in step
03 if not already; add a test).

## Directory (dir.ts)

```ts
interface RunDir {
  root: string                                   // <repo>/.rensa/runs/<id>
  runJson: string; events: string
  stepOutput(stepId: string): string             // steps/<id>/output.txt
  agentDir(stepId: string, label: string): string
  agentFile(stepId: string, label: string, name: 'prompt.md' | 'transcript.jsonl' | 'raw.jsonl' | 'reply.md'): string
}
export async function createRunDir(runsDir: string, id: string): Promise<RunDir>
export function openRunDir(runsDir: string, id: string): RunDir
```

`createRunDir` creates `root`, `steps/`, `agents/`. Agent directories are
created lazily by the transcript writer.

## Event types (types.ts)

```ts
type RunStatus = 'complete' | 'failed' | 'aborted'
type StepStatus = 'ok' | 'failed' | 'killed' | 'timeout'

interface EventBase { seq: number; t: string; step?: string; agent?: string }
type RunEvent = EventBase & (
  | { type: 'run.started'; data: { chain: string; input_kind: 'none'|'text'|'file'; input_path?: string; base: string; base_sha: string; rensa_version: string } }
  | { type: 'run.paused'; data: { before?: string; after?: string; reason: 'declared' | 'user' } }
  | { type: 'run.finished'; data: { status: RunStatus; failed_step?: string } }
  | { type: 'step.started'; step: string; data: { kind: 'agent' | 'shell'; command?: string } }
  | { type: 'step.finished'; step: string; data: { status: StepStatus; exit_code?: number } }
  | { type: 'agent.spawned'; step: string; agent: string; data: { provider: string; model?: string; effort?: string; tools: 'read'|'write'; session_id: string; resumed: boolean } }
  | { type: 'agent.finished'; step: string; agent: string; data: { status: StepStatus; exit_code?: number; usage?: Usage; error?: { kind: 'usage_limit'|'auth'|'exit'|'no_output'; message: string } } }
  | { type: 'user.note'; data: { text: string; applies_from: string } }
  | { type: 'user.action'; data: { action: 'pause' | 'kill' | 'abort'; step?: string } }
)
interface Usage { input: number; output: number; cache_read?: number; context?: number }

type TranscriptRecord =
  | { t: string; kind: 'text'; text: string }
  | { t: string; kind: 'tool'; name: string; input: unknown; ok: boolean; output: string }
  | { t: string; kind: 'note'; text: string }
```

## Event writer (events.ts)

```ts
class EventLog extends EventEmitter {
  static async create(path: string): Promise<EventLog>
  append(e: Omit<RunEvent, 'seq' | 't'>): RunEvent    // assigns seq and t, queues the write, emits 'event'
  flush(): Promise<void>                               // resolves when the queue is empty
  close(): Promise<void>
}
export async function readEvents(path: string): Promise<RunEvent[]>
```

- One in-memory queue, one writer loop, `fs.promises.appendFile` per
  line, never concurrent. `append` is synchronous from the caller's
  view and returns the completed event so the caller can emit it.
- `seq` starts at 1 with no gaps. `t` is `new Date().toISOString()`.
- `readEvents` tolerates a truncated final line (drops it) and skips
  lines that fail to parse, counting them in a `warnings` array
  attached to the result (return `{ events, warnings }`; adjust the
  signature).
- Unknown `type` values are passed through untouched.

## run.json (runjson.ts)

```ts
interface RunJson {
  id: string; chain: ResolvedChain; input: { kind: string; text?: string; path?: string }
  base: { ref: string; sha: string }; started_at: string; finished_at?: string
  status?: RunStatus; sessions: Record<string, string>      // named agent → session id
  steps: Record<string, { status?: StepStatus; agents: Record<string, StepStatus | undefined> }>
}
export async function writeRunJson(path: string, r: RunJson): Promise<void>   // atomic: write temp, rename
export async function readRunJson(path: string): Promise<RunJson>
```

Written once at start and once at the end; the `steps` map is a cache
and the event log wins on disagreement.

## Transcript writer (transcript.ts)

```ts
class TranscriptWriter {
  constructor(dir: RunDir, stepId: string, label: string)
  raw(line: string): void                      // appends to raw.jsonl verbatim
  record(r: Omit<TranscriptRecord, 't'>): TranscriptRecord
  prompt(text: string): Promise<void>          // writes prompt.md
  reply(text: string): Promise<void>           // writes reply.md
  close(): Promise<void>
}
export async function readTranscript(path: string): Promise<TranscriptRecord[]>
```

Same queue discipline as `EventLog`, one queue per file. The agent
directory is created on first write.

## Tests

- `EventLog`: 1000 appends from a tight loop produce 1000 lines with
  `seq` 1…1000 in order; `readEvents` round-trips; a file with a
  truncated last line and a garbage middle line reads with two
  warnings.
- `run.json` round trip and atomic write (temp file not left behind).
- `TranscriptWriter` creates the directory lazily; `readTranscript`
  round trips the three record kinds.
- Run id format and uniqueness over 100 calls.

## Verification (human)

Inspect a generated run directory from the tests (keep one via a
`KEEP_TMP=1` switch in `src/testing/tmpRepo.ts`) and read the files by eye.

## Out of scope

Producing any real event; that is the engine's job.

## As built

Differences from the spec above, for anyone reading this step later:

- `src/engine/run/jsonl.ts` was added: `AppendQueue` (the shared
  one-writer queue) and `parseJsonLines` (the shared tolerant reader),
  used by both `events.ts` and `transcript.ts`.
- `readEvents` returns `{ events, warnings }`. Warnings are strings like
  `line 3: not valid JSON`, `line 9: truncated final line`,
  `line 4: not an event`.
- `EventLog.create` and `createRunDir` fail with `EEXIST` if the file or
  directory already exists.
- Step 03 validation was tightened alongside this step, because names
  become directory names under the run: chain names, agent registry
  names, and step ids may contain only letters, digits, `_` and `-`,
  and two step ids may not differ only in case (`review` and `Review`
  share a directory on macOS and Windows).
- The "uniqueness over 100 calls" test asserts at least 95 distinct ids:
  the 16-bit suffix makes a collision among 100 ids in one minute about
  7% likely, so "all 100" would be a flaky test.
- The engine index exports the read side only (`openRunDir`,
  `readEvents`, `readTranscript`, `readRunJson`, and the event and
  transcript types). Writers stay engine-internal.
- Revision R2: `types.ts` declares the event union, the transcript
  records, `Usage` and `AgentError` as zod schemas and derives the types
  from them. `readEvents` and `readTranscript` check every line with
  `safeParse`; a known `type` whose payload does not fit is a warning,
  not an event. `RunEventSchema` ends in a passthrough member for types
  this version does not know, so `RunEvent` has an open member and
  consumers need a default branch; `KnownRunEvent` is the closed union
  the writer produces. `readTranscript` returns `{ records, warnings }`
  like `readEvents`, and both readers order warnings by line.
  `NewTranscriptRecordSchema` (records minus `t`) is what step 07's
  parsers emit.
