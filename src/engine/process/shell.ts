import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AppendQueue } from '../run/jsonl.js'
import type { StepStatus } from '../run/types.js'
import { type KillSignal, type SpawnResult, spawnProcess } from './spawn.js'

export interface ShellStepResult {
  /** Null when the shell died from a signal; `signal` then names it. */
  exitCode: number | null
  signal: NodeJS.Signals | null
  status: StepStatus
  /** Every stdout and stderr line in arrival order, each newline-terminated. */
  output: string
  outputPath: string
  durationMs: number
}

/**
 * Runs a shell step's command under `/bin/sh -c`, writing its combined
 * stdout and stderr lines to `outputPath` as they arrive.
 */
export async function runShellStep(opts: {
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  /** `steps/<id>/output.txt`; created, or truncated, before the command starts. */
  outputPath: string
  /** Each line of the combined stream, for the live pane. */
  onLine?: (line: string) => void
  signal: Pick<KillSignal, 'kill' | 'onKill'>
}): Promise<ShellStepResult> {
  await mkdir(path.dirname(opts.outputPath), { recursive: true })
  await writeFile(opts.outputPath, '')
  const queue = new AppendQueue(opts.outputPath)
  const lines: string[] = []
  const onLine = (line: string) => {
    lines.push(line)
    queue.push(line)
    opts.onLine?.(line)
  }

  const child = spawnProcess({
    argv: ['/bin/sh', '-c', opts.command],
    cwd: opts.cwd,
    env: opts.env,
    timeoutMs: opts.timeoutMs,
    onStdout: onLine,
    onStderr: onLine,
  })
  const dropKill = opts.signal.onKill(() => child.kill())
  let result: SpawnResult
  try {
    result = await child.result
  } finally {
    dropKill()
    await queue.close()
  }
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    status: statusOf(result),
    output: lines.map((line) => `${line}\n`).join(''),
    outputPath: opts.outputPath,
    durationMs: result.durationMs,
  }
}

function statusOf(result: SpawnResult): StepStatus {
  // A shell that exited 0 while a background child held the pipes past
  // the deadline still timed out.
  if (result.timedOut) return 'timeout'
  // Only the signal calls kill() here, apart from the timeout.
  if (result.killed) return 'killed'
  return result.exitCode === 0 ? 'ok' : 'failed'
}
