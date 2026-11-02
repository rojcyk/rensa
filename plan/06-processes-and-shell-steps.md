# 06 Processes and shell steps

## Goal

The one place in the codebase that spawns child processes, with the
behaviors every consumer needs: process-group kill, timeout, line-by-line
or raw stdout and stderr, stdin writing, environment stripping. On top
of it, the shell step executor, and the one process-wide shutdown hook
that every later step uses to clean up synchronously when the process
dies. This step also moves the one spawn of user-authored commands
that already exists, step 04's shell-variable evaluator, onto this
module. After this step the only other `child_process` import under
`src/engine/` is step 02's `execFile` of `git rev-parse` in
`config/paths.ts`, a fixed read-only command that stays as it is.

## Context

Steps 01–05 merged. Platforms: macOS and Linux. Windows is not a target;
do not add `cmd /c` branches.

## Files to create

```
src/engine/process/env.ts
src/engine/process/lines.ts
src/engine/process/shutdown.ts
src/engine/process/spawn.ts
src/engine/process/shell.ts
src/engine/process/*.test.ts     one per module, next to it
src/engine/template/vars.ts      modify: spawn through spawn.ts (see "Migrate vars.ts")
src/engine/template/vars.test.ts modify: two added cases; every existing case unchanged
```

## shutdown.ts

```ts
export function onShutdown(fn: () => void): () => void   // returns unregister
export function runShutdown(): void                      // idempotent; the handlers call it
export function onInterrupt(fn: () => void): () => void  // replaces the default SIGINT behaviour; returns unregister
export function resetShutdownForTests(): void            // clears callbacks, the once-only guard and the interrupt handler; tests only
```

One registry of synchronous callbacks, run once in LIFO order (last
registered runs first) when the process is about to die for any reason.
This is the only place in the codebase that listens for process death;
nothing else calls `process.on('exit')` or installs a signal handler
for cleanup. Why: Claude Code restores raw mode and the alternate
screen in a synchronous exit handler so a crash never leaves the
terminal unusable; if the TUI (step 11), the lock (step 08) and the
child kill (below) each registered their own `exit` handler, their
order would be accidental and a throw in one would skip the rest.

- Handlers, installed once at module load and kept for the life of
  the process:
  - `process.on('exit')` → `runShutdown()`. Covers every normal exit
    and every `process.exit()` call.
  - `SIGTERM` → `runShutdown()`, then `process.exit(143)`.
  - `SIGHUP` (the terminal closed) → `runShutdown()`, then
    `process.exit(129)`.
  - `SIGINT` → call the handler registered through `onInterrupt` if
    there is one; with none, `runShutdown()` then `process.exit(130)`.
    Step 09's headless CLI registers abort-on-first-press,
    exit-on-second. The TUI registers nothing: its stdin is in raw
    mode, so ctrl+c arrives as a key and never becomes a signal, and
    an external `SIGINT` falls through to the default, which restores
    the terminal through the registry.
  - `uncaughtException` → `runShutdown()`, write the error's stack to
    stderr, `process.exit(1)`. Restoring the terminal before printing
    is the point: the stack has to be readable.
- Every signal path ends in `process.exit()`, never in dying by the
  signal: a process killed by a signal does not emit `'exit'`, so the
  callbacks would not run. These listeners are unconditional. Nothing
  in the codebase counts or inspects signal listeners, here or in a
  consumer. Why: Ink registers its unmount through `signal-exit`, which
  installs its own listener on every one of these signals at
  `render()` and acts only when it is the sole listener. A listener of
  ours that also stood down "when another listener exists" would
  deadlock with it: both defer, nobody exits, and an external `SIGINT`
  to the TUI is swallowed. With our listener always present,
  `signal-exit` always stands down and our `process.exit()` reaches
  Ink's unmount through `'exit'`, after our callbacks (Node runs
  `'exit'` listeners in registration order and ours is registered at
  engine module load, before `render()`). Signals this module does not
  listen to are left to Node's default; do not add more to chase
  `signal-exit`'s list.
- `onInterrupt` holds at most one handler; a second registration
  replaces the first and the returned function restores the default
  only if its own handler is still current.
- `runShutdown()`: guarded by a module flag so the callbacks run at
  most once even when a signal handler and `'exit'` both fire. Each
  callback runs in a `try`; a throw is written to stderr and the next
  callback still runs. Everything in here is synchronous: no promises,
  no timers; the event loop is gone by the time `'exit'` fires.
- `onShutdown` returns an unregister function so a consumer that
  cleaned up on the normal path (a released lock, a child that exited)
  can drop its callback.

Registration order is what makes the exit sequence deterministic. The
intended sequence at exit is: restore the terminal, signal live
children (`SIGKILL` to their groups), release the lock. Callbacks run
LIFO, so they must be registered in the reverse of that: lock release
first, child kill second, terminal restore last.

Engine modules register at module evaluation, not lazily: step 08's
`lock.ts` registers the lock release and `spawn.ts` registers the
child kill below, both at top level. ES modules evaluate in import
order, depth first, so `src/engine/index.ts` begins with two
side-effect imports in this order: `import './run/lock.js'` (added by
step 08), then `import './process/spawn.js'`. `lock.ts` must not
import `process/spawn.js`, directly or through any module it imports,
or the kill would register first. Until step 08 exists, `index.ts`
carries only the `spawn.js` import, with a comment saying the lock
import goes above it. `index.ts` re-exports `onShutdown` and
`onInterrupt` so consumers never import from `process/` directly. The
TUI registers its terminal restore in `startSession`
(`src/tui/terminalSession.ts`, step 11), which `main.ts` calls after
the engine has been imported and opened, so it is always the last
registration and runs first.

The guarantee is "children are signalled before the lock is
released", not "children have exited before the lock is released":
the hook is synchronous and runs inside `'exit'`, so it sends
`SIGKILL` and moves on without waiting for the children to die. A
second `rensa` that acquires the lock in that instant may briefly
overlap a dying child.

## env.ts

```ts
export const STRIPPED_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY'] as const
export function childEnv(base: NodeJS.ProcessEnv, opts: { allowApiKeys: boolean; extra?: Record<string, string> }): NodeJS.ProcessEnv
```

Copies `base`, deletes `STRIPPED_KEYS` unless `allowApiKeys`, merges
`extra`. Also always sets `NO_COLOR=1` and `TERM=dumb` for children so
CLIs do not emit ANSI into the transcripts; adapters that need a TTY-ish
flag override per spawn.

## lines.ts

```ts
export function lineReader(stream: NodeJS.ReadableStream, onLine: (line: string) => void): Promise<void>
```

Splits on `\n`, strips a trailing `\r`, buffers partial lines, emits the
final unterminated line at end, decodes UTF-8 across chunk boundaries
(use `StringDecoder`). Resolves when the stream ends.

## spawn.ts

```ts
interface SpawnOptions {
  argv: string[]; cwd: string; env: NodeJS.ProcessEnv
  stdin?: string                     // written then closed; absent → stdin closed immediately
  timeoutMs: number
  escalateMs?: number                // SIGTERM → SIGKILL grace, default 5000; tests pass 200
  onStdout?: (line: string) => void          // line mode: through lineReader
  onStderr?: (line: string) => void
  onStdoutChunk?: (chunk: Buffer) => void    // raw mode: every chunk as received, no splitting, no \r stripping
  onStderrChunk?: (chunk: Buffer) => void    // a stream takes one mode or the other, never both
}
interface SpawnResult { exitCode: number | null; signal: NodeJS.Signals | null; timedOut: boolean; killed: boolean; durationMs: number }
interface Child { pid: number; kill(): void; result: Promise<SpawnResult> }
export function spawnProcess(opts: SpawnOptions): Child
```

- `child_process.spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: ['pipe','pipe','pipe'] })`.
  `detached: true` puts the child in its own process group.
- Everything here is about the **process group**, never the direct
  child alone. The child is the group leader, but a group outlives its
  leader: `/bin/sh -c` exits on SIGTERM while a grandchild that traps
  or ignores SIGTERM keeps running, keeps the group alive, and keeps
  the inherited stdout/stderr pipe ends open. Whether the group still
  exists is answered by `process.kill(-pid, 0)`: it succeeds while any
  member lives and throws `ESRCH` once the group is gone. Call that
  `groupAlive(pid)`. A grandchild that leaves the group with its own
  `setsid` is out of reach by definition, as for every process-group
  tool; the README (step 17) says so.
- `kill()`: `process.kill(-pid, 'SIGTERM')`, ignoring `ESRCH`; after
  `escalateMs`, `process.kill(-pid, 'SIGKILL')` to the group
  unconditionally, ignoring `ESRCH`. The escalation does not consult
  whether the leader has exited: that is the case it exists for.
  Idempotent: a second `kill()` neither re-sends SIGTERM nor restarts
  the timer.
- Live-groups registry: a module-level `Set<number>` of pgids. Add on
  spawn. When `result` settles, by any path including the forced one
  below, apply one rule: if `groupAlive` is false, remove the pgid; if
  it is true (a member that closed its pipes and kept running, or one
  not yet reaped), keep it and recheck every second on an `unref`'d
  timer, removing it once the group is gone. A forced settle says only
  that something still held the pipes, possibly a process that left the
  group and that this pgid cannot reach; it says nothing about whether
  the group exists, and keeping a vanished pgid registered would let a
  reused pgid be killed at shutdown. At module load, register one
  callback through `onShutdown` that sends `SIGKILL` to every group
  still in the set (`process.kill(-pid, 'SIGKILL')`, ignoring `ESRCH`).
  No `SIGTERM`, no grace period: this path runs inside `'exit'`, where
  timers never fire, so the only choice is kill now or leak the child.
  Detached children survive their parent otherwise, which is exactly
  what a crashed `rensa` must not leave behind.
- Timeout: a timer that calls `kill()` and sets `timedOut`.
- `ENOENT` on spawn rejects `result` with `RensaError('PROCESS')`
  naming `argv[0]`.
- Each output stream goes through `lineReader` (line mode) or straight
  to the chunk callback (raw mode, for consumers that need bytes and
  exact trailing-newline semantics); `result` resolves only after both
  streams ended and the process exited, so no line or byte is lost. One bound on that: after the SIGKILL escalation, if either
  reader has not reached end of file within a further `escalateMs`,
  destroy both pipe streams and resolve `result` anyway with
  `killed: true` and the lines received so far. Only an escaped member
  of the group can hold the pipes past a group SIGKILL, and a step must
  never wait on a process this module cannot reach. `result` thus
  always settles within `2 × escalateMs` of `kill()`.
- Never `shell: true` here.

## Migrate vars.ts

Step 04's `evaluateVars` spawns `/bin/sh -c` itself with
`{ ...process.env, ...bindings }`, a private 60 s timer, a 10 MiB
stdout limit and a direct SIGKILL of the group, and carries a TODO for
this step. Left as is, `$(...)` variables would run with the user's API
keys in their environment, could not be killed by step 08's abort, and
would be invisible to the shutdown registry. Replace the private spawn
with `spawnProcess` in raw mode and change nothing the evaluator's
tests observe:

```ts
export async function evaluateVars(
  vars: Record<string, VarSpec>, ns: Namespace, cwd: string,
  env: NodeJS.ProcessEnv,              // from childEnv(); the caller decides allowApiKeys
  signal?: KillSignal,                 // step 08's abort reaches a running var command through it
): Promise<Record<string, unknown>>
```

- `env` is `childEnv(process.env, { allowApiKeys })` built by the
  caller (step 08 passes the chain's flag); the per-command placeholder
  bindings from `renderForShell` are merged on top, so they still reach
  the shell as environment data. `NO_COLOR=1` and `TERM=dumb` now apply
  to var commands too.
- `spawnProcess({ argv: ['/bin/sh', '-c', script], cwd, env, timeoutMs: 60_000, onStdoutChunk, onStderrChunk })`
  with stdin absent (closed). The byte counting stays in `vars.ts`:
  stdout chunks accumulate up to 10 MiB, past which the evaluator
  records the reason and calls `child.kill()` (SIGTERM, then the
  escalation, instead of today's immediate SIGKILL); stderr keeps its
  2000-byte cap and 500-character tail.
- `signal.onKill(() => child.kill())` when a signal is given, so an
  abort during evaluation ends the command within the escalation
  grace, not after 60 s.
- Outcome mapping from `SpawnResult`: `exitCode === 0 && !killed &&
  !timedOut` → the value is stdout decoded as UTF-8 with exactly one
  trailing newline stripped; otherwise `RensaError('TEMPLATE')` with
  the same messages as today (the recorded byte-limit reason, "timed
  out after 60 s", "was killed by <signal>", "exited with <code>"), the
  stderr tail appended. A shell that exited 0 while a background child
  held the pipes still fails as a timeout, since `result` then settles
  through the timeout path with `killed: true`.
- The private timer, the `process.kill(-pid, 'SIGKILL')` and the
  `child_process` import are deleted. The 60 s timeout, the 10 MiB
  limit and the stderr limits remain constants in `vars.ts`.

The existing `vars.test.ts` cases are the acceptance test for this
migration and must pass unchanged, including the fake-timer timeout
cases and the trailing-newline case. Two cases are added: with
`ANTHROPIC_API_KEY` set in the test process, `$(printf '%s'
"$ANTHROPIC_API_KEY")` evaluates to the empty string, and with
`allowApiKeys: true` it evaluates to the key; and while a var command
runs, its pgid is in the live-groups registry (expose the set
read-only for tests) and is gone once `evaluateVars` resolves.

## shell.ts

```ts
interface ShellStepResult { exitCode: number | null; status: StepStatus; output: string; outputPath: string; durationMs: number }
export async function runShellStep(opts: {
  command: string; cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number
  outputPath: string                            // steps/<id>/output.txt
  onLine?: (line: string) => void               // combined stream, for the live pane
  signal: { kill(): void } & { onKill(cb: () => void): void }   // see note
}): Promise<ShellStepResult>
```

- `argv = ['/bin/sh', '-c', command]`.
- Writes every stdout and stderr line, in arrival order, to
  `outputPath` through one append queue; calls `onLine` for each.
- `status`: `ok` on exit 0, `timeout` when timed out, `killed` when
  killed via the signal, else `failed`.
- `output` is the full combined text; the 16 KB tail is applied by the
  engine with `tail()` from step 04.
- The `signal` argument: a small object the engine owns; the step
  registers a callback so `kill()` from the UI reaches the child. Define
  it in `spawn.ts` as `class KillSignal { kill(); onKill(cb); killed: boolean }`.

## Tests

- `childEnv` strips keys, keeps them with `allowApiKeys`, sets
  `NO_COLOR`.
- `shutdown`: three callbacks run in LIFO order; a second
  `runShutdown()` runs nothing; an unregistered callback does not run;
  a callback that throws does not stop the ones after it. Test
  `runShutdown()` directly; do not kill the test process.
- `shutdown` signals: export the three listener functions
  (`handleInterrupt`, `handleTerminate`, `handleHangup`) and call them
  directly with `process.exit` replaced by `vi.spyOn(...).mockImplementation`;
  never send a real signal or emit one on `process`, where vitest's own
  listeners would also fire. The default interrupt runs the callbacks
  and exits 130; a handler registered through `onInterrupt` runs
  instead and the callbacks do not; after its unregister function the
  default is back; `handleTerminate` exits 143 and `handleHangup` 129,
  both after the callbacks. These share a file with the `runShutdown`
  tests; `resetShutdownForTests()` in `beforeEach` clears the once-only
  guard, the callbacks and the interrupt handler so each case starts
  clean. Production code never calls it.
- `lineReader` with chunks split mid-line and mid-multibyte-character.
- `spawnProcess`: `printf 'a\nb'` yields two lines including the
  unterminated one; a `sleep 10` with 200 ms timeout reports
  `timedOut`; a shell script that spawns a background `sleep` is fully
  killed (check with `ps` that the grandchild is gone after `kill()`);
  missing binary rejects with `PROCESS`.
- Leader exits first, grandchild ignores SIGTERM, `escalateMs: 200`:
  `sh -c '(trap "" TERM; exec sleep 30) & exec sleep 30'`. The leader
  becomes a plain `sleep` that dies on SIGTERM; the backgrounded
  subshell sets SIGTERM to ignored, a disposition that survives `exec`,
  so its `sleep` ignores the SIGTERM while holding the inherited pipes.
  After `kill()`: `result` resolves within 1 s with `killed: true`;
  `ps` shows no `sleep` from this test; the pgid is no longer in the
  registry. Also assert the registry still held the pgid 100 ms after
  `kill()`, when the leader was already gone but the grandchild was
  not.
- Escaped member holding the pipes, `escalateMs: 200`: a leader that
  starts `perl -MPOSIX -e 'POSIX::setsid(); exec "sleep", 30'` sharing
  stdout, then exits. (Bare `perl -e 'setsid; …'` without POSIX is a
  no-op bareword: the `sleep` stays in the group and dies with it, so
  the test would prove nothing. Assert with `ps -o pgid=` that the
  `sleep`'s pgid differs from the leader's.) After `kill()`, `result`
  resolves within about 400 ms with `killed: true` even though a writer
  still holds the pipe; the original pgid is no longer in the registry,
  because that group is gone; the test then kills the escaped `sleep`
  itself.
- Shutdown kill: spawn a `sleep 30`, call `runShutdown()`, check with
  `ps` that the child is gone. Because `runShutdown` is once-only per
  process, this test runs in its own file (`spawn.shutdown.test.ts`)
  so vitest gives it its own worker.
- Registration order, consumer before kill: in its own file
  (`shutdown.order.test.ts`), import `src/engine/index.js`, spawn a
  `sleep 30`, then register a probe through the re-exported
  `onShutdown` (standing in for the TUI's terminal restore) that
  reads the child leader's state with a synchronous `ps -o stat=`.
  Call `runShutdown()`: the probe saw a running or sleeping state
  (`/^[SRI]/`), not a zombie (`Z`), and afterwards `ps` shows no
  `sleep`. Do not probe with `process.kill(-pgid, 0)`: a child already
  SIGKILLed cannot be reaped while synchronous code runs, stays a
  zombie, and still answers the probe, so the check could not fail.
  Step 08 extends this file with the lock.
- `runShellStep`: exit code mapping, output file content equals combined
  lines, `onLine` called in order.

## Verification (human)

Run the process tests on macOS and on Linux (CI covers Linux). Confirm
the grandchild-kill tests pass on macOS, where process-group semantics
differ subtly, in particular the leader-exits-first case. Then, from a scratch script that imports `spawnProcess`,
start a `sleep 60` and send the script `SIGTERM`: `ps` must show no
leftover `sleep`.

## Out of scope

Spawning any provider CLI.
