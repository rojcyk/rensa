import { spawn } from 'node:child_process'
import type { VarSpec } from '../config/types.js'
import { RensaError } from '../errors.js'
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
 */
export async function evaluateVars(
  vars: Record<string, VarSpec>,
  ns: Namespace,
  cwd: string,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  for (const [name, spec] of Object.entries(vars)) {
    out[name] = await evaluate(name, spec, ns, cwd)
  }
  return out
}

async function evaluate(name: string, spec: VarSpec, ns: Namespace, cwd: string): Promise<unknown> {
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
      return runShell(name, renderForShell(spec.value, ns), cwd)
  }
}

// TODO(step 06): pass childEnv() instead of process.env.
function runShell(
  name: string,
  { script, env, display: command }: ShellBinding,
  cwd: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', script], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group, so a timeout also kills what the shell forked.
      detached: true,
    })
    // Set when rensa kills the group. Exit code 0 can still follow, from
    // a shell that exited while a background child held its pipes.
    let killedFor: string | undefined
    const killGroup = (why: string) => {
      killedFor = why
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
      } catch {
        // The group is already gone.
      }
    }
    const timer = setTimeout(
      () => killGroup(`timed out after ${SHELL_TIMEOUT_MS / 1000} s`),
      SHELL_TIMEOUT_MS,
    )
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    child.stdout.on('data', (chunk: Buffer) => {
      if (killedFor !== undefined) return
      stdoutBytes += chunk.length
      if (stdoutBytes > STDOUT_MAX_BYTES) {
        killGroup(`printed more than ${STDOUT_MAX_BYTES / 1024 / 1024} MiB`)
        return
      }
      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= STDERR_MAX_BYTES) return
      stderrBytes += chunk.length
      stderr.push(chunk)
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(
        new RensaError('TEMPLATE', `var \`${name}\`: cannot run \`${command}\`: ${err.message}`),
      )
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (code === 0 && killedFor === undefined) {
        resolve(Buffer.concat(stdout).toString('utf8').replace(/\n$/, ''))
        return
      }
      const why = killedFor ?? (signal ? `was killed by ${signal}` : `exited with ${code}`)
      const err = Buffer.concat(stderr).toString('utf8').slice(0, STDERR_CHARS)
      reject(
        new RensaError(
          'TEMPLATE',
          `var \`${name}\`: \`${command}\` ${why}${err ? `: ${err}` : ''}`,
        ),
      )
    })
  })
}
