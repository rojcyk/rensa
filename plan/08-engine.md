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
  rejection is fatal: it takes the "storage failure" path below, which
  ends the run with an in-memory `RunResult` carrying the error. The
  log cannot record `run.finished` at that point, which is why the
  result exists apart from the log: every consumer learns the end of a
  run from the result, and from the event only when there is one.
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
src/engine/template/skills.ts     appendSkills: inlines SKILL.md bodies into the first prompt of a session
src/engine/template/skills.test.ts
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
   provider check. The same pass applies the skill size limits from
   "Skills" below.
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
   `handle.done` resolves with the `RunResult` (below) and never
   rejects: chain-level errors become `run.finished { failed }` plus a
   result, and storage errors become a result alone.

   `run.started` has already been emitted when the handle is returned,
   and nothing stops the runner from emitting more before the caller's
   continuation runs. No consumer can therefore subscribe "in time".
   The handle solves this, not the caller: every run stream lives on
   the handle, with a history, and `attach` (below) hands over the
   history and subscribes in one synchronous step.

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
`running(step)`, `paused(before|after step)`, `aborting`,
`finished(status)`. `aborting` is entered only by `abort()` and left
only by the finish below; while in it the loop advances no further and
the current step, if any, is allowed to end through its normal path.

The loop checks for `aborting` at every boundary: before the pause
check, before building the namespace, before `adapter.spawn`, before
`runShellStep`, and after every `await` in between. Those gaps are
real: `git status`, `vars` evaluation and writing `prompt.md` are all
asynchronous, and an `abort()` that lands inside one must not be
followed by a spawn. On seeing `aborting`, the loop breaks to the
finish instead of taking the next action.

For each step in order:

1. If `step.pause === 'before'` or a user pause is pending for this
   boundary: emit `run.paused`, wait for `resume()`.
2. Emit `step.started`.
3. Shell step: `runShellStep` with `childEnv` (step 06). Every
   `onLine` becomes a completed record `{ kind: 'text', text: line }`
   under label `shell`, through the same record path as an agent's
   records below: written by the `TranscriptWriter` for
   `(step.id, 'shell')`, pushed to the ring buffer, emitted as
   `'transcript'`. One record per line, never a delta: the headless CLI
   prints records only, and the TUI's partial slot holds one string per
   key, so lines sent as deltas would never print and would overwrite
   each other. The lines are also in `output.txt` (step 06); the
   duplication is accepted so a reattached run screen reads shell
   output from the same place as agent output. On completion store
   the `StepResult` (`output` = `tail(full, 16384, outputPath)`), emit
   `step.finished`.

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
     prior `steps`), evaluate `vars` with
     `evaluateVars(step.vars, ns, cwd, childEnv(process.env, { allowApiKeys: chain.allowApiKeys }), stepSignal)`
     so `$(...)` commands run without API keys and the step's
     `KillSignal` reaches them (an abort during evaluation ends the
     command within step 06's escalation grace), render the step
     prompt, then, when this spawn is the first use of its session,
     `stageSkills` followed by `appendSkills` (below), then append
     user notes whose `applies_from` is at or before this step.
   - Session: named agent → look up `run.json.sessions[name]`; if
     present `resume: true`, else generate a UUID and store it. Fresh →
     new UUID, `resume: false`. Persona is passed, and skills are
     inlined, only when `resume: false`: a resumed session already has
     both in its context, and re-sending them would cost tokens on
     every step. If `done.sessionId` arrives, overwrite the stored id
     for that named agent with it.
   - Write `prompt.md`, emit `agent.spawned`, `adapter.spawn(req)` with
     `env = childEnv(process.env, { allowApiKeys: chain.allowApiKeys, extra: { RENSA_RUN_ID, RENSA_STEP, RENSA_BASE } })`.
   - Consume `events` (step 07's union, nothing else):
     - `raw` → `writer.raw`.
     - `delta` → append `text` to the partial slot for
       `(step, label)` (step 11's `RunHandle.partial`), then emit
       `'delta' { step, label, text }`. Never written to disk.
     - any record (`text`, `tool`, `note`) → clear that key's partial
       slot, `writer.record(record)`, push the stamped record to the
       key's ring buffer, then emit `'transcript' { step, label, record }`.
       The record supersedes every delta since the previous record; a
       `text` record's content wins over the concatenated deltas when
       they differ.
     - `usage` → remember.
     - `done` → clear the key's partial slot (a stream that ended
       mid-block leaves nothing dangling), write `reply.md`, emit
       `agent.finished` with usage and error, build `StepResult` with
       `output = { [label]: extractTrailingJson(reply) ?? reply }` and
       `text = reply`.
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

## Skills (template/skills.ts)

```ts
export async function stageSkills(runDir: RunDir, skills: ReadonlyArray<{ dir: string }>): Promise<ReadonlyArray<{ name: string; dir: string }>>
export function appendSkills(message: string, staged: ReadonlyArray<{ name: string; body: string; dir: string }>): string
```

The chain's `skills:` (absolute directories, each holding `SKILL.md`,
validated at load by step 03) reach the agent in two parts: the
`SKILL.md` body as text in its first prompt, and the whole skill
directory as files the agent can read during the session.

- **Copy first.** Before the first spawn of a session that lists
  skills, `stageSkills` copies each skill directory into
  `runs/<id>/skills/<name>/`, preserving the directory layout and file
  modes so `scripts/` stay executable; symlinks inside a skill are
  followed and copied as files. `<name>` is the `SKILL.md` front
  matter's `name` if present, else the directory's basename; two
  skills resolving to the same name is `CONFIG_INVALID` at load. Why a
  copy inside the run directory: skills usually live outside the
  checkout (`~/.config/rensa/skills/…`), and every CLI restricts file
  reads to its working directory or to folders granted by flags and
  trust that rensa does not control. A path under `.rensa/runs/` is
  inside the checkout, so an agent on any provider can open a skill's
  `references/` or run its `scripts/` with no flags, no trust changes
  and no permission prompt. A copy rather than a link, because the
  CLIs resolve links before checking permissions, and so an agent can
  never modify the user's source skill. `.rensa/runs/` is already
  gitignored (step 02) and already the engine's own write area; nothing
  new is written anywhere else. The copy goes under `runDir.root`
  (step 05's `RunDir`), which gains no new method for it: `stageSkills`
  joins `root` with `skills/<name>` and creates the directories itself.
- **Then inline.** `appendSkills` takes the staged list with each
  `SKILL.md` body (front matter stripped). If it is empty, return
  `message`; otherwise append two newlines, `## Skills`, and for each
  skill a `### <name>` heading, a line `Files: <copied dir>` naming
  the copy, a blank line, and the body verbatim. Placeholders inside a
  skill body are not rendered: a skill is data, like a note. Order
  follows the chain. Only `SKILL.md` is ever inlined; supporting files
  are reached through the `Files:` path, which is how skills are meant
  to disclose detail progressively.

Limits and errors: a `SKILL.md` body over 32 KB, all of a step's
bodies together over 96 KB, or a skill directory over 10 MB in total,
is `CONFIG_INVALID` from `Engine.open`'s validation pass (the same
place `validateWithAdapters` annotates a chain summary), naming the
skill and the size; a skill directory that disappeared between load
and run is `TEMPLATE` at run time with the path. The inlined text is
part of `prompt.md` and the copy is part of the run directory, so a
run shows exactly what the agent received and could read.

Trade-off, recorded for later: inlining puts the skill in context on
every turn of the session rather than letting the CLI load it on
demand, and it cannot express "model-invoked only". For the MVP that
is accepted. Claude Code's `--add-dir` could replace inlining for that
one provider later; nothing else in the plan depends on how skills
arrive.

## Commands

- `pause()`: emit `user.action {pause, step}`; set a pending pause for
  the end of the current step (or the next boundary when paused
  already does nothing).
- `resume()`: only valid in `paused`; continues.
- `kill()`: emit `user.action {kill, step}`; kill the current step's
  process; the step finishes `killed`, which is non-`ok`, so a `stop`
  step ends the run as `failed`; a `continue` step continues.
- `abort()`: emit `user.action {abort}`, enter `aborting`, and return;
  it finishes nothing itself. If the runner is in `paused`, resolve the
  wait it is blocked on so the loop wakes and sees `aborting`. If a
  child is running, call its `kill()` (step 06: SIGTERM to the group,
  SIGKILL after 5 s) and let the step complete through its ordinary
  path: the adapter's `events` run to the `done` step 07 guarantees
  even after a kill, so `agent.finished { killed }` and
  `step.finished { killed }` are written like any other step's events;
  a shell step returns its `ShellStepResult` with `killed`. If no child
  is running (between steps, or paused), the loop simply breaks at its
  next check. Only when the step has ended does the finish run, with
  `run.finished { aborted }`. The lock is therefore held until the
  child has exited and every writer has been flushed and closed, and
  nothing is ever written to a closed writer. Why: `kill()` returns
  before the process is gone, and the final `done` always arrives
  after it; releasing the lock or closing the writers at `abort()`
  time would let another `writes: true` run start while this agent is
  still modifying files, and would drop the aborted step's own finish
  events.
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
  status: 'running' | 'paused' | 'aborting' | 'complete' | 'failed' | 'aborted'
  currentStep?: string                       // running or paused step
  pausedAt?: { before?: string; after?: string }
  failedStep?: string
  startedAt?: string; finishedAt?: string
  error?: { code: string; message: string; hint?: string }   // from the RunResult, never from an event
}
export function applyResult(progress: RunProgress, result: RunResult): RunProgress

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
- `applyResult(progress, result)` merges the in-memory terminal state
  over what the events gave: if `progress.status` is already terminal
  (a `run.finished` was seen) it only adds `error` when the result has
  one and returns the same reference otherwise; if not, it returns a
  new `RunProgress` with the result's `status`, `finishedAt`,
  `failedStep` and `error`. This is the one place a run can end
  without a `run.finished` event, and it lives here so neither
  frontend interprets the result itself.
- `reduceRun` folds `run.started`, `run.paused`, `step.started`,
  `user.action { abort }` and `run.finished` into `RunProgress`.
  `user.action { abort }` sets `status: 'aborting'` until
  `run.finished` replaces it, so the UI shows "aborting…" while the
  child drains without interpreting events itself. Consumers compute
  durations from `startedAt`/`finishedAt` pairs; nothing here stores a
  duration (index.md conventions).

Export all of the above from `src/engine/index.ts`.

## Events out

Run streams are **per run, on the handle**. The `Engine` emitter
carries only `'providers'`. Two runs can be live in one process
(read-only chains take no lock, and the TUI lets a run continue while
the user starts another), and a `RunEvent` has no run id, so a shared
emitter would interleave them; scoping the streams to the handle makes
that impossible rather than something consumers filter.

```ts
interface RunResult {
  status: RunStatus                    // complete | failed | aborted
  failedStep?: string
  finishedAt: string
  error?: { code: string; message: string; hint?: string }   // set when the run ended on an engine or storage error
}
interface RunListeners {
  event?(event: RunEvent): void                                        // one per events.jsonl line
  transcript?(m: { step: string; label: string; record: TranscriptRecord }): void   // after disk and ring buffer
  delta?(m: { step: string; label: string; text: string }): void      // after the partial slot; never on disk
  finished?(result: RunResult): void                                   // exactly once, after the finish sequence
}
interface RunHandle {
  // … above …
  done: Promise<RunResult>
  result(): RunResult | undefined                                      // set at the same moment `finished` fires
  events(): ReadonlyArray<RunEvent>                                    // every event so far, in seq order
  attach(listeners: RunListeners): { events: ReadonlyArray<RunEvent>; result?: RunResult; detach(): void }
}
```

The `RunResult` is the run's **in-memory terminal state**, held by the
handle and independent of whether anything reached disk. It is what
`done` resolves with, what `finished` delivers, and what `attach`
returns to a late consumer. `run.finished` on disk is the durable
record of the same fact and is written whenever the log still works;
consumers that only read the log (a future history screen) see a run
without `run.finished` as unfinished, which is the honest reading of
the file.

- `events()` is the handle's own append-only history, the same
  objects the `EventLog` returned from `append`, held for the life of
  the handle. A run's history is at most a few hundred events, so it
  is kept whole; the transcripts, which are not, live in the ring
  buffers (step 11) with the same "state before emit" rule.
- `attach` returns the history and registers the listeners in one
  synchronous call; because emission is synchronous on the event loop,
  no event can land between the snapshot and the subscription, and
  `events.at(-1).seq + 1` is the `seq` of the first live event. A
  consumer attaching after `done` resolved gets the complete history
  and no live events. `detach` is idempotent. Several consumers may be
  attached at once (the TUI's run screen and, later, a history view).
- The ordering rule from step 11 applies to all three: the history
  array, the ring buffer or the partial slot is updated **before** the
  matching listener fires, so a listener that reads handle state sees
  what it was told about.
- `finished` fires once, after the finish sequence has run to the
  point of releasing the lock and immediately before `done` resolves.
  A consumer attaching after that gets `result` in the return value
  and no `finished` call. The handle's `result()` is set before either.
- The headless CLI uses `event`, `transcript` and `finished`; the TUI
  uses all four.

## Finish

On any terminal state, once no child is running and no adapter
`events` iterator is still open: emit `run.finished`, then `flush()`
and `close()` the event log and all transcript writers, update
`run.json` (`finished_at`, `status`, `steps`), release the lock, set
the `RunResult`, fire `finished`, and resolve `handle.done`, in that
order. The finish runs exactly once; `abort()` and a step's natural
end both route through it and never perform any of these actions
themselves.

**Storage failure.** Any rejection from the event log, a transcript
writer, `prompt.md`/`reply.md`, `createRunDir` for an agent directory
or `run.json` is fatal and takes this path: remember the first error,
stop advancing (the same boundary checks as `aborting`), kill and
drain the current child if any, then run the finish steps above
best-effort, each in its own `try` with its error ignored, since the
storage that failed is the storage they write to. The lock release
and the `RunResult` are not best-effort: the lock is released, and
`done` resolves with `status: 'failed'`, the current step as
`failedStep`, and `error` built from the first rejection
(`code: 'STORAGE'`, the `errno` message, hint "check free space and
permissions under .rensa/runs"). The run therefore always reaches a
terminal state in memory, whatever the disk did.

## Tests (integration, fake provider, tmp repo)

- Three-step chain (shell, agent, shell) runs to `complete`; events in
  the file match the expected sequence of types; `run.json` steps map
  matches.
- Named agent in two steps: second spawn has `resume: true`, same
  session id, no persona (assert via `request.json`).
- `from:` agent twice: two different session ids, persona both times.
- Skills: a chain whose agent lists two skill directories, one of them
  outside the tmp repo and holding `references/notes.md` and an
  executable `scripts/check.sh`: the first `prompt.md` ends with
  `## Skills`, two `### <name>` sections in chain order, each with a
  `Files:` line pointing under `runs/<id>/skills/` and its body, after
  the step prompt and before `## User notes`; the copied tree contains
  `references/notes.md` with identical content and `scripts/check.sh`
  still executable, and running the fake agent's `request.json` cwd
  through `fs.realpath` shows the copy is inside the repo; the same
  named agent in a later step (resumed) gets no `## Skills` section and
  no second copy; a `from:` agent gets the section every time and the
  copy once per run; a `SKILL.md` with front matter contributes its
  `name` and only its body; a body over 32 KB, or a directory over 10
  MB, makes `chains()` report `CONFIG_INVALID` for that chain with the
  skill's path in the message; the source skill directory is unchanged
  after the run.
- `appendSkills` (unit, `skills.test.ts`): empty list returns the
  message unchanged; front matter stripped; no front matter →
  basename as name; `{{placeholders}}` in a body are left as written.
  `stageSkills` (unit): copies layout and modes, follows a symlinked
  file inside the skill, rejects duplicate names.
- `on_fail: stop` on a failing shell step ends with `failed` and
  `failed_step`; `continue` proceeds and `steps.x.passed` is false in
  the next prompt (assert the rendered `prompt.md`).
- `pause: before` halts; `resume()` continues; a `note()` while paused
  appears in the next `prompt.md` under `## User notes`.
- `kill()` during an agent step marks it `killed`.
- `abort()` during an agent step, with `RENSA_FAKE_KILL_DELAY_MS=300`
  so the fake's `done` arrives late: the lock file still exists and
  `done` is still pending 100 ms after `abort()`; `events.jsonl` ends
  with `agent.finished { killed }`, `step.finished { killed }`,
  `run.finished { aborted }` in that order; `handle.done` resolves
  `aborted` after the lock file is gone; no write-after-close error is
  reported by `close()`.
- `abort()` while paused (`pause: before` on the second step): the
  wait ends, no further `step.started`, `run.finished { aborted }`,
  lock released.
- `abort()` during var evaluation: a step with `vars: { slow: $(sleep 30) }`
  and the fake adapter; abort 100 ms after `step.started`: `done`
  resolves `aborted` within 1 s (not 60 s), no `agent.spawned`, and
  `ps` shows no `sleep`.
- `abort()` called synchronously after `start()` resolves, before any
  step has done work: no `agent.spawned` and no `agent/` directory is
  created, the events are exactly `run.started`, `user.action { abort }`,
  `run.finished { aborted }`, the lock is released and `ps` shows no
  child.
- Storage failure: start a fake run with `RENSA_FAKE_DELAY_MS=100`,
  then `chmod 0444` its `events.jsonl` before the first
  `step.finished` (the queue uses `appendFile`, so the next line fails
  with `EACCES`): `done` resolves `{ status: 'failed', error: { code:
  'STORAGE' } }` with the `EACCES` text in `message`; the `finished`
  listener fired exactly once with the same object; `handle.result()`
  equals it; the lock file is gone; `attach` afterwards returns that
  `result`; the file holds no `run.finished`. `applyResult` on the
  `reduceRun` of that handle's events reports `failed` with the error;
  on a complete run's progress it returns the same reference.
- Dirty tree refuses; a second `start` while locked refuses with
  `LOCKED`; a stale lock with a dead pid is replaced.
- Lock on shutdown: acquire a lock, call step 06's `runShutdown()`, the
  lock file is gone. In its own test file (`lock.shutdown.test.ts`),
  for the same reason as step 06's shutdown test.
- Headless with pauses refuses without `noPause`, runs with it.
- Late attach: start a fake run, await `done`, then `attach`: the
  returned history equals `readEvents` on the file, `run.started`
  first, and no listener fires afterwards. Early attach: `attach`
  immediately after `start` resolves, history is `[run.started]`, and
  the live `event` listener receives every remaining event exactly
  once with consecutive `seq`.
- Two read-only fake runs started back to back in one engine, each
  attached: every event delivered to a handle's listener is in that
  handle's `events()` and no other's; both reach `complete`; the
  engine emitter received no `'event'`.
- `view.ts`, in `view.test.ts`, driven by the event sequences the tests
  above record: `reduceSteps` on the three-step run yields `ok` for all
  three with timestamps equal to the events'; with the chain's steps
  passed in, a step that never started is `pending`; `run.paused
  { before }` marks that step `paused` and the following
  `step.started` clears it; `on_fail: stop` leaves the later steps
  `pending` and `reduceRun` reports `failed` with `failedStep`;
  `applyEvent` returns the same reference for `user.note`,
  `user.action` and an event with an unknown type, and a new reference
  for `step.started`; `reduceRun` on the aborted run reports `aborted`,
  and on its prefix ending at `user.action { abort }` reports
  `aborting`.
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
