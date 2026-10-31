# 08 Engine

## Goal

The orchestrator. It takes a resolved chain and an input, runs the
steps one after another, writes every event and transcript through step
05, spawns agents through step 07 and shell steps through step 06, and
exposes the command set (pause, resume, kill, abort, note). After this
step a chain runs end to end on the fake provider with no UI.

## Context

Steps 01–07 merged. Public surface is fixed in `plan/index.md`
("Engine surface"); implement exactly that.

### Notes from step 05

- Run ids can collide: two runs of the same chain started in the same
  minute share the id with probability 1 in 65,536. `createRunDir`
  then rejects with `EEXIST` rather than overwriting. Catch that,
  generate a new id, and retry a few times before failing.
- After a failed write, `EventLog.append` still emits `'event'` and
  returns the event, but the line is dropped; the error only surfaces
  from the next `flush()` or `close()`. `TranscriptWriter` behaves the
  same. Await `flush()` on the event log after every `step.finished`
  so the UI never runs more than one step ahead of the file. A
  rejection is fatal: stop the run and resolve `handle.done` with
  `failed`. The log cannot record `run.finished` at that point, so the
  error has to reach the caller some other way, not only the log.
- `TranscriptWriter.prompt()` and `reply()` do not check whether the
  writer is closed; write them before `close()`.
- `run.json` is plain JSON, so an agent whose status is `undefined` in
  `steps.<id>.agents` is dropped on write. Write `run.json` at the end
  with every agent's final status set, or omit the agent.
- `readRunJson` throws the raw `ENOENT` for a missing file; it raises
  `RensaError('INTERNAL')` only for invalid JSON or the wrong shape.
- A shell step's transcript goes through `TranscriptWriter` with label
  `shell`, so it lands in `agents/<step>/shell/`.

## Files to create

```
src/engine/engine.ts
src/engine/run/runner.ts          one run's state machine
src/engine/run/lock.ts
src/engine/run/git.ts             dirty-tree check, HEAD sha, current ref
src/engine/run/view.ts            pure reduction of the event log into step and run state
src/engine/run/view.test.ts
src/engine/index.ts               export the public surface
src/engine/engine.test.ts         integration tests; split into engine.<topic>.test.ts if it grows
test/fixtures/chains/             chains used by the integration tests
```

## Engine.open(cwd)

1. Start `checkProviders(process.env)` (step 07) as the very first
   statement, before any `await`, and keep the promise. Do not await it
   in `open`. The provider checks are subprocesses and the slowest part
   of startup; everything below, and in the TUI the Ink import, runs
   while they are in flight.
2. `discover(cwd)` (step 02), then `loadAllChains` (step 03). Store the
   chains.
3. `validateWithAdapters`: a named agent on a provider whose
   `capabilities().resume` is false becomes a `CONFIG_INVALID` error on
   that chain summary. Capabilities are static, so this needs no
   provider check.
4. Resolve. `open()` is done when the filesystem work is done, normally
   before any provider check has answered.

Provider state after `open`:

- `providers(): ProviderStatus[] | undefined` returns the statuses of
  the last completed check, `undefined` until the first one completes.
  Consumers render that as "checking".
- `providersChecked: Promise<ProviderStatus[]>` is the check in flight
  (or, once it completed, the resolved promise). It never rejects:
  step 07 turns timeouts and errors into `not_installed`.
- When a check completes, store the statuses and emit `'providers'`
  with them. The TUI re-renders on that event instead of awaiting.
- `recheckProviders()` starts a new check, replaces `providersChecked`,
  emits `'providers'` when it lands, and returns the new promise. The
  previous statuses stay visible from `providers()` until then.
- `chains()` computes `missingProviders: ProviderStatus[]` per summary
  at call time against `providers()`: providers used by any step whose
  availability is not `ready`. While `providers()` is `undefined` the
  list is `[]`; a consumer that shows the list must also show the
  checking state, so an empty list is never read as "all present".

  ```ts
  interface ChainSummary { name: string; description?: string; chain?: ResolvedChain; error?: RensaError; missingProviders: ProviderStatus[] }
  ```

## Engine.start(name, input, opts)

Preconditions, each a `RensaError` thrown before anything is written:

- chain loads (`CHAIN_NOT_FOUND` or its load error)
- `missingProviders` empty (`PROVIDER_UNAVAILABLE`, hint from the
  availability record). `start` first awaits `providersChecked`, so
  the check is complete even when `start` follows `open` immediately,
  as the headless CLI does. Step 13's `preflight` does the same.
- input kind matches `chain.input` (`INPUT_REQUIRED`); for `file`, read
  the file now and keep both text and path
- chain has pauses and `opts.noPause` is false and the caller is
  headless: the CLI passes `opts.headless: true`; the engine throws
  `CONFIG_INVALID` with hint "pass --no-pause"
- if `chain.writes`: `git status --porcelain` must be empty
  (`DIRTY_TREE`), and the repo lock must be acquired (`LOCKED`)

Then:

1. Resolve `base`: `opts.base`, else chain, else current ref
   (`git symbolic-ref --short HEAD`, falling back to `git rev-parse
   HEAD`). Record `base_sha` with `git rev-parse <base>`.
2. Create the run id and directory, write `run.json`, create the
   `EventLog`, emit `run.started`.
3. Return a `RunHandle` immediately; execution continues asynchronously.
   `handle.done` resolves with the final status and never rejects
   (errors become `run.finished` with `failed`).

## lock.ts

`<repo>/.rensa/lock` containing `{ pid, run_id, started_at }`. Acquire
with `O_EXCL`; if the file exists and its pid is alive
(`process.kill(pid, 0)`), throw `LOCKED` with the run id in the
message; if the pid is dead, replace it. Release on `run.finished`,
and on process death through step 06's `onShutdown`, never through a
`process.on('exit')` of its own: the shutdown module is the single
ordered place for that, so the TUI's terminal restore runs before this
callback and the child kill runs between them. Register once at module
load (so the registration precedes the TUI's, see step 06), with a
module-level set of held lock paths; the callback `unlinkSync`s each
one, ignoring `ENOENT`. `acquire` adds to the set, `release` removes
from it, so a lock released on the normal path is not touched again at
exit. Only taken for chains with `writes: true`.

## Runner (runner.ts)

State machine over the chain's steps with these states: `idle`,
`running(step)`, `paused(before|after step)`, `finished(status)`.

For each step in order:

1. If `step.pause === 'before'` or a user pause is pending for this
   boundary: emit `run.paused`, wait for `resume()`.
2. Emit `step.started`.
3. Shell step: `runShellStep` with `childEnv` (step 06), `onLine`
   forwarded as transcript records `{kind:'text', partial:true}` for the
   live pane under label `shell`, into a `TranscriptWriter` for
   `(step.id, 'shell')`. On completion store the `StepResult`
   (`output` = `tail(full, 16384, outputPath)`), emit `step.finished`.

   Always set `passed` and `exit_code` on a shell `StepResult`, for
   every status. They are optional on the type, but load-time
   validation (step 03) accepts `steps.<id>.passed` and
   `steps.<id>.exit_code` for any earlier shell step. If one is unset,
   a later prompt or var that references it fails at runtime with
   `TEMPLATE`. The trap: step 06's `exitCode` is `null` when the
   process died from a signal (`killed`, `timeout`), so copying it
   across leaves `exit_code` unset. Set `passed = status === 'ok'`.
   For a `null` exit code, store 128 + the signal number (the shell
   convention: SIGTERM → 143, SIGKILL → 137), which means passing the
   signal through from `SpawnResult` into `ShellStepResult`.
4. Agent step:
   - Build the namespace (`input`, `input_path`, `base`, `run_id`,
     prior `steps`), evaluate `vars`, render the step prompt, append
     user notes whose `applies_from` is at or before this step.
   - Session: named agent → look up `run.json.sessions[name]`; if
     present `resume: true`, else generate a UUID and store it. Fresh →
     new UUID, `resume: false`. Persona is passed only when
     `resume: false`. If `done.sessionId` arrives, overwrite the stored
     id for that named agent with it.
   - Write `prompt.md`, emit `agent.spawned`, `adapter.spawn(req)` with
     `env = childEnv(process.env, { allowApiKeys: chain.allowApiKeys, extra: { RENSA_RUN_ID, RENSA_STEP, RENSA_BASE } })`.
   - Consume `events`: `raw` → `writer.raw`; `text` partial → emit
     `transcript` with `partial: true` only (not written); `text` final
     → `writer.record`; `tool` → `writer.record`; `usage` → remember;
     `done` → write `reply.md`, emit `agent.finished` with usage and
     error, build `StepResult` with `output = { [label]: extractTrailingJson(reply) ?? reply }`
     and `text = reply`.
   - Step status mirrors the agent: `done.exitCode === 0 && !error` →
     `ok`; killed → `killed`; timeout → `timeout`; else `failed`.
   - Emit `step.finished`.
5. If status is not `ok` and `step.onFail === 'stop'`: emit
   `run.finished { status: 'failed', failed_step }` and stop.
6. If `step.pause === 'after'` or a user pause was requested during the
   step: emit `run.paused`, wait for `resume()`.

After the last step: `run.finished { status: 'complete' }`.

Timeout: the step's `timeoutMs` wraps the adapter call; on expiry call
`kill()` and record `timeout`.

## Commands

- `pause()`: emit `user.action {pause, step}`; set a pending pause for
  the end of the current step (or the next boundary when paused
  already does nothing).
- `resume()`: only valid in `paused`; continues.
- `kill()`: emit `user.action {kill, step}`; kill the current step's
  process; the step finishes `killed`, which is non-`ok`, so a `stop`
  step ends the run as `failed`; a `continue` step continues.
- `abort()`: emit `user.action {abort}`; kill the current step if any;
  emit `run.finished { aborted }`; release the lock.
- `note(text)`: emit `user.note { text, applies_from }` where
  `applies_from` is the next step that has not started; store the note
  for prompt rendering.

Commands after `finished` are ignored.

## view.ts

Interpreting the event log is engine logic (`CLAUDE.md`: status,
token counts and errors are computed in the engine and rendered by the
UI). Every consumer that needs "what state is step X in" derives it
here, never by switching on event types itself. Both the headless CLI
(step 09, durations) and the TUI (step 11, the run store) use it, and
step 14 rebuilds a finished run from `events.jsonl` with it.

```ts
interface StepView {
  id: string; kind: 'agent' | 'shell'
  status: 'pending' | 'running' | 'ok' | 'failed' | 'killed' | 'timeout' | 'paused'
  startedAt?: string; finishedAt?: string; exitCode?: number
  agent?: AgentView
}
interface AgentView {
  label: string; provider: string; model?: string; effort?: string
  status: 'pending' | 'running' | 'ok' | 'failed' | 'killed' | 'timeout'
  startedAt?: string; finishedAt?: string; usage?: Usage; error?: AgentError
}
interface RunProgress {
  status: 'running' | 'paused' | 'complete' | 'failed' | 'aborted'
  currentStep?: string                       // running or paused step
  pausedAt?: { before?: string; after?: string }
  failedStep?: string
  startedAt?: string; finishedAt?: string
}

export function initialSteps(steps: ReadonlyArray<{ id: string; kind: 'agent' | 'shell' }>): Map<string, StepView>
export function applyEvent(steps: Map<string, StepView>, event: RunEvent): Map<string, StepView>
export function reduceSteps(events: RunEvent[], steps?: ReadonlyArray<{ id: string; kind: 'agent' | 'shell' }>): Map<string, StepView>
export function reduceRun(events: RunEvent[]): RunProgress
```

- `initialSteps` seeds every chain step as `pending` in chain order, so
  a consumer that knows the chain sees not-yet-started steps too. The
  events alone do not list the steps (`run.started` carries only the
  chain name), so without the seed the map holds only steps that have
  started.
- `applyEvent` is the incremental form and the one rule that matters
  for the UI: it returns the **same `Map` reference** when the event
  changes nothing (`user.note`, `user.action`, an unknown type, or an
  event for a step already in that state) and a **new `Map`** otherwise.
  Step 11's store skips notifying React when it gets the same reference
  back, so a burst of notes or unknown events costs no render. Copy the
  map on change; steps are few.
- `reduceSteps(events, steps?)` is `events.reduce(applyEvent, initialSteps(steps ?? []))`.
- Mapping: `step.started` → `running` with `startedAt`; `step.finished`
  → its `status`, `finishedAt`, `exitCode`; `agent.spawned` → the
  `agent` row `running`; `agent.finished` → its status, usage, error;
  `run.paused { before: x }` → step `x` becomes `paused` (`after: x`
  leaves `x` finished and does not touch the next step); the `resume`
  is implied by the next `step.started`. `run.finished { aborted }`
  leaves the running step as it is; the UI reads the run status.
- Unknown event types (step 05's open member) and known types for
  steps the map does not hold are skipped, never thrown on. Give the
  `switch` a default branch that returns the input map.
- `reduceRun` folds `run.started`, `run.paused`, `step.started` and
  `run.finished` into `RunProgress`. Consumers compute durations from
  `startedAt`/`finishedAt` pairs; nothing here stores a duration
  (index.md conventions).

Export all of the above from `src/engine/index.ts`.

## Events out

The engine re-emits every `RunEvent` as `'event'` and every transcript
record as `'transcript'` with `{ step, label, record, partial }`. The
headless CLI and the TUI subscribe to these two.

## Finish

On any terminal state: `flush()` and `close()` the event log and all
transcript writers, update `run.json` (`finished_at`, `status`,
`steps`), release the lock.

## Tests (integration, fake provider, tmp repo)

- Three-step chain (shell, agent, shell) runs to `complete`; events in
  the file match the expected sequence of types; `run.json` steps map
  matches.
- Named agent in two steps: second spawn has `resume: true`, same
  session id, no persona (assert via `request.json`).
- `from:` agent twice: two different session ids, persona both times.
- `on_fail: stop` on a failing shell step ends with `failed` and
  `failed_step`; `continue` proceeds and `steps.x.passed` is false in
  the next prompt (assert the rendered `prompt.md`).
- `pause: before` halts; `resume()` continues; a `note()` while paused
  appears in the next `prompt.md` under `## User notes`.
- `kill()` during an agent step marks it `killed`.
- `abort()` ends `aborted` and releases the lock.
- Dirty tree refuses; a second `start` while locked refuses with
  `LOCKED`; a stale lock with a dead pid is replaced.
- Lock on shutdown: acquire a lock, call step 06's `runShutdown()`, the
  lock file is gone. In its own test file (`lock.shutdown.test.ts`),
  for the same reason as step 06's shutdown test.
- Headless with pauses refuses without `noPause`, runs with it.
- `view.ts`, in `view.test.ts`, driven by the event sequences the tests
  above record: `reduceSteps` on the three-step run yields `ok` for all
  three with timestamps equal to the events'; with the chain's steps
  passed in, a step that never started is `pending`; `run.paused
  { before }` marks that step `paused` and the following
  `step.started` clears it; `on_fail: stop` leaves the later steps
  `pending` and `reduceRun` reports `failed` with `failedStep`;
  `applyEvent` returns the same reference for `user.note`,
  `user.action` and an event with an unknown type, and a new reference
  for `step.started`; `reduceRun` on the aborted run reports `aborted`.
- Prefetch: with `RENSA_FAKE_AVAILABLE_DELAY_MS=300`, `open()` resolves
  in well under 300 ms with `providers()` undefined and
  `chains()[0].missingProviders` empty; `'providers'` fires exactly
  once; `providersChecked` then resolves with the fake `ready`. With
  `RENSA_FAKE_AVAILABILITY=not_installed` and the same delay, `start()`
  called right after `open()` rejects with `PROVIDER_UNAVAILABLE`,
  proving it awaited the check. `recheckProviders()` after the env
  changes fires `'providers'` again with the new status.
- Timeout on a shell step (`sleep 5`, 200 ms) yields `timeout`.
- A shell step that times out with `on_fail: continue`, followed by an
  agent step whose prompt uses `{{steps.x.exit_code}}` and
  `{{steps.x.passed}}`: the prompt renders `143` and `false` instead of
  failing with `TEMPLATE`.

## Verification (human)

With `RENSA_DEV=1`, run the integration suite, then open one kept run
directory and read `events.jsonl` top to bottom against the chain; it
should narrate the run without any other file.

## Out of scope

Any UI, any real provider, the `rensa` command line.
