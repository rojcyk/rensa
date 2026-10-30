# 06 Processes and shell steps

## Goal

The one place in the codebase that spawns child processes, with the
behaviors every consumer needs: process-group kill, timeout, line-by-line
stdout and stderr, stdin writing, environment stripping. On top of it,
the shell step executor.

## Context

Steps 01–05 merged. Platforms: macOS and Linux. Windows is not a target;
do not add `cmd /c` branches.

## Files to create

```
src/engine/process/env.ts
src/engine/process/lines.ts
src/engine/process/spawn.ts
src/engine/process/shell.ts
src/engine/process/*.test.ts     one per module, next to it
```

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
- `lineReader` with chunks split mid-line and mid-multibyte-character.
- `spawnProcess`: `printf 'a\nb'` yields two lines including the
  unterminated one; a `sleep 10` with 200 ms timeout reports
  `timedOut`; a shell script that spawns a background `sleep` is fully
  killed (check with `ps` that the grandchild is gone after `kill()`);
  missing binary rejects with `PROCESS`.
- `runShellStep`: exit code mapping, output file content equals combined
  lines, `onLine` called in order.

## Verification (human)

Run the process tests on macOS and on Linux (CI covers Linux). Confirm
the grandchild-kill test passes on macOS, where process-group semantics
differ subtly.

## Out of scope

Spawning any provider CLI.
