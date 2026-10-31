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
src/engine/index.ts               export the public surface
src/engine/engine.test.ts         integration tests; split into engine.<topic>.test.ts if it grows
test/fixtures/chains/             chains used by the integration tests
```

## Engine.open(cwd)

1. `discover(cwd)` (step 02).
2. `checkProviders(process.env)` (step 07) in parallel with
   `loadAllChains` (step 03). Store both.
3. For each loaded chain, compute `missingProviders: ProviderStatus[]`:
   providers used by any step whose availability is not `ready`.
   Expose on `ChainSummary`:

   ```ts
   interface ChainSummary { name: string; description?: string; chain?: ResolvedChain; error?: RensaError; missingProviders: ProviderStatus[] }
   ```
4. `validateWithAdapters`: a named agent on a provider whose
   `capabilities().resume` is false becomes a `CONFIG_INVALID` error on
   that chain summary.

`providers()` returns the stored statuses; `recheckProviders()` reruns
the check and updates summaries.

## Engine.start(name, input, opts)

Preconditions, each a `RensaError` thrown before anything is written:

- chain loads (`CHAIN_NOT_FOUND` or its load error)
- `missingProviders` empty (`PROVIDER_UNAVAILABLE`, hint from the
  availability record)
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
message; if the pid is dead, replace it. Release on `run.finished` and
on process exit (`process.on('exit')`). Only taken for chains with
`writes: true`.

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
- Headless with pauses refuses without `noPause`, runs with it.
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
