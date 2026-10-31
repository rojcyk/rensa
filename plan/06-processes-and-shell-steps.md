# 06 Processes and shell steps

## Goal

The one place in the codebase that spawns child processes, with the
behaviors every consumer needs: process-group kill, timeout, line-by-line
stdout and stderr, stdin writing, environment stripping. On top of it,
the shell step executor, and the one process-wide shutdown hook that
every later step uses to clean up synchronously when the process dies.

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
```

## shutdown.ts

```ts
export function onShutdown(fn: () => void): () => void   // returns unregister
export function runShutdown(): void                      // idempotent; the handlers call it
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

- Handlers, installed once at module load:
  - `process.on('exit')` → `runShutdown()`. Covers every normal exit
    and every `process.exit()` call.
  - `SIGTERM` → `runShutdown()`, then `process.exit(143)`.
  - `SIGINT` → if this module is the only `SIGINT` listener,
    `runShutdown()` then `process.exit(130)`; otherwise do nothing and
    let the other listener decide (step 09's headless CLI aborts the
    run on the first ctrl+c; the TUI runs stdin in raw mode, so ctrl+c
    never becomes a signal there). Whatever that listener does, its
    eventual exit still runs the callbacks through `'exit'`.
  - `uncaughtException` → `runShutdown()`, write the error's stack to
    stderr, `process.exit(1)`. Restoring the terminal before printing
    is the point: the stack has to be readable.
- `runShutdown()`: guarded by a module flag so the callbacks run at
  most once even when a signal handler and `'exit'` both fire. Each
  callback runs in a `try`; a throw is written to stderr and the next
  callback still runs. Everything in here is synchronous: no promises,
  no timers; the event loop is gone by the time `'exit'` fires.
- `onShutdown` returns an unregister function so a consumer that
  cleaned up on the normal path (a released lock, a child that exited)
  can drop its callback.

Registration order is what makes the exit sequence deterministic.
Engine modules register at module evaluation, not lazily: `spawn.ts`
registers the child kill below and step 08's `lock.ts` registers the
lock release, both at top level. `src/engine/index.ts` imports
`process/spawn.js` before `run/lock.js` so the kill callback is
registered first. The TUI registers its terminal restore from
`main.ts`, after the engine has been imported, so it is always the
last registration. LIFO then yields: terminal restore, kill live
children, release lock.

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
  onStdout?: (line: string) => void
  onStderr?: (line: string) => void
}
interface SpawnResult { exitCode: number | null; signal: NodeJS.Signals | null; timedOut: boolean; killed: boolean; durationMs: number }
interface Child { pid: number; kill(): void; result: Promise<SpawnResult> }
export function spawnProcess(opts: SpawnOptions): Child
```

- `child_process.spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: ['pipe','pipe','pipe'] })`.
  `detached: true` puts the child in its own process group.
- `kill()`: `process.kill(-pid, 'SIGTERM')`; after 5 s, if still
  running, `SIGKILL` the group. Idempotent.
- Live-children registry: a module-level `Set<number>` of pgids. Add on
  spawn, delete when the process exits. At module load, register one
  callback through `onShutdown` that sends `SIGKILL` to every group
  still in the set (`process.kill(-pid, 'SIGKILL')`, ignoring `ESRCH`).
  No `SIGTERM`, no grace period: this path runs inside `'exit'`, where
  timers never fire, so the only choice is kill now or leak the child.
  Detached children survive their parent otherwise, which is exactly
  what a crashed `rensa` must not leave behind.
- Timeout: a timer that calls `kill()` and sets `timedOut`.
- `ENOENT` on spawn rejects `result` with `RensaError('PROCESS')`
  naming `argv[0]`.
- Both output streams go through `lineReader`; `result` resolves only
  after both readers finished and the process exited, so no line is
  lost.
- Never `shell: true` here.

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
  `runShutdown()` directly; do not kill the test process. Confirm the
  signal handlers exist with `process.listenerCount('SIGTERM')` and
  `process.listenerCount('SIGINT')` after import.
- `lineReader` with chunks split mid-line and mid-multibyte-character.
- `spawnProcess`: `printf 'a\nb'` yields two lines including the
  unterminated one; a `sleep 10` with 200 ms timeout reports
  `timedOut`; a shell script that spawns a background `sleep` is fully
  killed (check with `ps` that the grandchild is gone after `kill()`);
  missing binary rejects with `PROCESS`.
- Shutdown kill: spawn a `sleep 30`, call `runShutdown()`, check with
  `ps` that the child is gone. Because `runShutdown` is once-only per
  process, this test runs in its own file (`spawn.shutdown.test.ts`)
  so vitest gives it its own worker.
- `runShellStep`: exit code mapping, output file content equals combined
  lines, `onLine` called in order.

## Verification (human)

Run the process tests on macOS and on Linux (CI covers Linux). Confirm
the grandchild-kill test passes on macOS, where process-group semantics
differ subtly. Then, from a scratch script that imports `spawnProcess`,
start a `sleep 60` and send the script `SIGTERM`: `ps` must show no
leftover `sleep`.

## Out of scope

Spawning any provider CLI.
