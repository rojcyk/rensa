import type { VarSpec } from '../config/types.js'
import { RensaError } from '../errors.js'
import { childEnv } from '../process/env.js'
import { type KillSignal, type SpawnResult, spawnProcess } from '../process/spawn.js'
import { lookup, type Namespace } from './namespace.js'
import { render, renderForShell, type ShellBinding } from './render.js'

const SHELL_TIMEOUT_MS = 60_000
// Far past anything usable in a prompt; only guards the engine's memory.
const STDOUT_MAX_BYTES = 10 * 1024 * 1024
const STDERR_CHARS = 500
// Enough bytes for STDERR_CHARS characters of any UTF-8 width.
const STDERR_MAX_BYTES = STDERR_CHARS * 4

/**
 * Evaluates a step's vars in declaration order. Placeholders inside
 * literals and shell commands render against the namespace only; in a
 * shell command they reach the shell as data, never as code.
 *
 * `env` is the base environment for shell commands, built with
 * `childEnv()` by the caller, who decides `allowApiKeys`; left out, the
 * API keys are stripped. `signal` lets an abort end a running command.
 */
export async function evaluateVars(
  vars: Record<string, VarSpec>,
  ns: Namespace,
  cwd: string,
  env: NodeJS.ProcessEnv = childEnv(process.env, { allowApiKeys: false }),
  signal?: KillSignal,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  for (const [name, spec] of Object.entries(vars)) {
    out[name] = await evaluate(name, spec, ns, cwd, env, signal)
  }
  return out
}

async function evaluate(
  name: string,
  spec: VarSpec,
  ns: Namespace,
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: KillSignal | undefined,
): Promise<unknown> {
  switch (spec.kind) {
    case 'literal':
      return render(spec.value, {}, ns)
    case 'ref': {
      const value = lookup(ns, spec.value)
      if (value === undefined) {
        throw new RensaError('TEMPLATE', `var \`${name}\`: \`${spec.value}\` has no value`)
      }
      return value
    }
    case 'shell':
      return runShell(name, renderForShell(spec.value, ns), cwd, env, signal)
  }
}

async function runShell(
  name: string,
  { script, env: bindings, display: command }: ShellBinding,
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: KillSignal | undefined,
): Promise<string> {
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let stdoutBytes = 0
  let stderrBytes = 0
  // Set when the evaluator kills the command for printing too much.
  let overflow: string | undefined
  const child = spawnProcess({
    argv: ['/bin/sh', '-c', script],
    cwd,
    // The bindings carry placeholder values to the shell as data.
    env: { ...env, ...bindings },
    timeoutMs: SHELL_TIMEOUT_MS,
    onStdoutChunk: (chunk) => {
      if (overflow !== undefined) return
      stdoutBytes += chunk.length
      if (stdoutBytes > STDOUT_MAX_BYTES) {
        overflow = `printed more than ${STDOUT_MAX_BYTES / 1024 / 1024} MiB`
        child.kill()
        return
      }
      stdout.push(chunk)
    },
    onStderrChunk: (chunk) => {
      if (stderrBytes >= STDERR_MAX_BYTES) return
      stderrBytes += chunk.length
      stderr.push(chunk)
    },
  })
  const dropKill = signal?.onKill(() => child.kill())
  let result: SpawnResult
  try {
    result = await child.result
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    throw new RensaError('TEMPLATE', `var \`${name}\`: cannot run \`${command}\`: ${why}`)
  } finally {
    dropKill?.()
  }
  // Exit code 0 can follow a kill, from a shell that exited while a
  // background child held its pipes.
  if (result.exitCode === 0 && !result.killed && !result.timedOut) {
    return Buffer.concat(stdout).toString('utf8').replace(/\n$/, '')
  }
  const why = overflow ?? failure(result)
  const err = Buffer.concat(stderr).toString('utf8').slice(0, STDERR_CHARS)
  throw new RensaError('TEMPLATE', `var \`${name}\`: \`${command}\` ${why}${err ? `: ${err}` : ''}`)
}

function failure({ timedOut, signal, killed, exitCode }: SpawnResult): string {
  if (timedOut) return `timed out after ${SHELL_TIMEOUT_MS / 1000} s`
  if (signal) return `was killed by ${signal}`
  if (killed) return 'was killed'
  return `exited with ${exitCode}`
}
