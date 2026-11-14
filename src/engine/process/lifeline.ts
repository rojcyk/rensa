// The lifeline: a small Node program that every child runs inside. It
// leads the child's process group, starts the real command in that same
// group with its own stdin, stdout and stderr, and holds fd 3, a pipe
// whose other end only rensa holds.
//
// It owns the stop of its group, so that a stop survives rensa's death:
// - fd 3 at end-of-file while the group lives means rensa died, even by
//   SIGKILL: the lifeline sends SIGTERM to the group, then stops it.
// - `stop` from rensa (its kill or timeout), a SIGTERM to the group, or
//   the line above starts the stop: the lifeline outlives the command until the rest of
//   the group is gone, or SIGKILLs the group once the grace has passed.
//   The grace is unconditional, as in kill(): a command that exits on
//   SIGTERM may leave a grandchild that ignores it.
//
// It is a string run with `node -e`, not a file: the CLI bundle, the
// engine bundle and the sources under test would each find a file at a
// different relative path. Being a string, it is not type-checked; its
// tests run it for real.
//
// Protocol on fd 3, from rensa: `stop`, written just before rensa's
// SIGTERM to the group, so the lifeline knows the command's exit is part
// of a stop. From the lifeline, one JSON line at most:
// - `{"spawnError":{"code":…,"message":…}}`: the command never started.
// - `{"exit":{"code":…,"signal":…}}`: how the command ended. The lifeline
//   may end differently (SIGKILLed with its group), so this is the result.

import { constants } from 'node:os'
import { z } from 'zod'

/** Carries the caller's NODE_OPTIONS past the lifeline to the command. */
const NODE_OPTIONS_CARRIER = 'RENSA_LIFELINE_NODE_OPTIONS'

/** Exit code of the lifeline when the command could not be started. */
export const SPAWN_FAILED_EXIT = 127

// Plain CommonJS. No template substitutions inside but the two constants:
// this is a template literal only so it can span lines.
const SOURCE = `'use strict'
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')
const { constants } = require('node:os')

const [graceArg, command, ...args] = process.argv.slice(1)
const grace = Number(graceArg)
const POLL_MS = 50

const env = { ...process.env }
delete env.NODE_OPTIONS
if (env.${NODE_OPTIONS_CARRIER} !== undefined) {
  env.NODE_OPTIONS = env.${NODE_OPTIONS_CARRIER}
  delete env.${NODE_OPTIONS_CARRIER}
}

let outcome = null // { code, signal } once the command exited
let stopping = false
let exiting = false

function signalGroup(signal) {
  try {
    process.kill(-process.pid, signal)
  } catch {}
}

// Written, then the callback: process.exit() would drop a pending write.
// A rensa that is gone answers with an error, which ends the wait too.
function report(message, then) {
  let called = false
  const once = () => {
    if (called) return
    called = true
    then()
  }
  lifeline.once('error', once)
  try {
    lifeline.write(JSON.stringify(message) + '\\n', once)
  } catch {
    once()
  }
}

// Ends the lifeline the way the command ended.
function mirror() {
  if (exiting) return
  exiting = true
  const { code, signal } = outcome
  if (signal === null) process.exit(code ?? 1)
  for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.removeAllListeners(s)
  // Node starts with SIGPIPE ignored; a listener's removal restores the
  // default action, for that signal as for the held ones.
  try {
    process.on(signal, () => {})
    process.removeAllListeners(signal)
  } catch {}
  try {
    process.kill(process.pid, signal)
  } catch {}
  // A signal that still did not end the lifeline: the shell's code.
  setTimeout(() => process.exit(128 + (constants.signals[signal] ?? 0)), 100)
}

// Calls back with whether the group has a member other than the lifeline.
// The ps runs in a group of its own, out of reach of the group's signals;
// a ps that fails answers yes, so the stop waits out its grace instead.
function othersInGroup(then) {
  const ps = spawn('ps', ['-A', '-o', 'pid=,pgid='], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  let out = ''
  ps.stdout.setEncoding('utf8')
  ps.stdout.on('data', (chunk) => {
    out += chunk
  })
  ps.once('error', () => then(true))
  ps.once('close', (code, sig) => {
    if (code !== 0) return then(true)
    const others = out.split('\\n').some((line) => {
      const [pid, pgid] = line.trim().split(/\\s+/).map(Number)
      return pgid === process.pid && pid !== process.pid
    })
    then(others)
  })
}

// While stopping, after the command exited: done once nothing else is left.
function pollGroup() {
  othersInGroup((others) => {
    if (exiting) return
    if (!others) mirror()
    else setTimeout(pollGroup, POLL_MS)
  })
}

function stop() {
  if (stopping) return
  stopping = true
  setTimeout(() => {
    exiting = true
    signalGroup('SIGKILL')
    process.exit(137)
  }, grace)
  if (outcome) pollGroup()
}

// SIGTERM for the group reaches the command directly; for the lifeline it
// starts the stop. SIGINT and SIGHUP are only held, so that the lifeline
// outlives the command to report how it went.
process.on('SIGTERM', stop)
process.on('SIGINT', () => {})
process.on('SIGHUP', () => {})

function orphaned() {
  if (exiting) return
  // The command ended on its own and the lifeline is on its way out.
  if (outcome && !stopping) return
  signalGroup('SIGTERM')
  stop()
}

const lifeline = new net.Socket({ fd: 3, readable: true, writable: true })
lifeline.on('error', () => {})
lifeline.on('end', orphaned)
lifeline.on('close', orphaned)
lifeline.on('data', (chunk) => {
  if (String(chunk).includes('stop')) stop()
})

// Whether rensa asked for a stop, reading what fd 3 holds right now. A
// SIGTERM to the group can end the command before the lifeline's own
// SIGTERM handler has run, but rensa writes \`stop\` before it signals, so
// by the time the command can have died of that SIGTERM the message is
// either read already or waiting here. End-of-file means rensa is gone.
function stopRequested() {
  if (stopping) return true
  try {
    const buf = Buffer.alloc(256)
    const n = fs.readSync(3, buf, 0, buf.length, null)
    if (n === 0) orphaned()
    else if (buf.toString('utf8', 0, n).includes('stop')) stop()
  } catch {}
  return stopping
}

const child = spawn(command, args, { stdio: 'inherit', env })

child.once('error', (err) => {
  if (outcome || exiting) return
  exiting = true
  report({ spawnError: { code: err.code, message: err.message } }, () =>
    process.exit(${SPAWN_FAILED_EXIT}),
  )
})

child.once('exit', (code, signal) => {
  if (outcome || exiting) return
  stopRequested()
  outcome = { code, signal }
  report({ exit: outcome }, () => {
    if (!stopping) mirror()
    else pollGroup()
  })
})
`

export interface LifelineCommand {
  command: string
  args: string[]
}

/** The command that runs `argv` inside the lifeline. */
export function lifelineCommand(argv: readonly string[], escalateMs: number): LifelineCommand {
  return {
    command: process.execPath,
    args: ['--input-type=commonjs', '-e', SOURCE, '--', String(escalateMs), ...argv],
  }
}

/**
 * The lifeline's environment. NODE_OPTIONS is meant for the command, and
 * in the lifeline something like `--require` would run code it never
 * asked for, so it rides past under another name.
 */
export function lifelineEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { NODE_OPTIONS, ...rest } = env
  if (NODE_OPTIONS === undefined) return rest
  return { ...rest, [NODE_OPTIONS_CARRIER]: NODE_OPTIONS }
}

const SignalSchema = z.custom<NodeJS.Signals>(
  (value) => typeof value === 'string' && value in constants.signals,
)

const ReportLineSchema = z.union([
  z.object({
    spawnError: z.object({ code: z.string().optional(), message: z.string() }),
  }),
  z.object({
    exit: z.object({ code: z.number().int().nullable(), signal: SignalSchema.nullable() }),
  }),
])

export type LifelineReport =
  | { kind: 'spawnError'; code: string | undefined; message: string }
  | { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null }

/** What the lifeline wrote on fd 3, if it wrote a report. */
export function parseLifelineReport(text: string): LifelineReport | undefined {
  const line = text.split('\n')[0]?.trim()
  if (!line) return undefined
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  const parsed = ReportLineSchema.safeParse(value)
  if (!parsed.success) return undefined
  const report = parsed.data
  if ('spawnError' in report) {
    return { kind: 'spawnError', code: report.spawnError.code, message: report.spawnError.message }
  }
  return { kind: 'exit', code: report.exit.code, signal: report.exit.signal }
}
