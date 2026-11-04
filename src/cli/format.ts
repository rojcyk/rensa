import type {
  Availability,
  DiagEntry,
  ProviderStatus,
  RunEvent,
  RunEventType,
  RunResult,
  StepView,
  TranscriptRecord,
  Usage,
} from '../engine/index.js'
import { onDiag, reduceRun } from '../engine/index.js'

// Line formatting for the headless commands. Every format function takes
// what it shows and returns text; nothing here decides state. Run state
// (durations, statuses) comes from the engine's view functions.

const KEYWORD_WIDTH = 10
const VERB_WIDTH = 11
const SUMMARY_MAX = 80
const SESSION_PREFIX = 8

export interface Paint {
  /** `step` and `agent` keywords. */
  secondary(text: string): string
  /** Failures and error messages. */
  error(text: string): string
}

const PLAIN: Paint = { secondary: (t) => t, error: (t) => t }
const ANSI: Paint = {
  secondary: (t) => `\x1b[90m${t}\x1b[39m`,
  error: (t) => `\x1b[31m${t}\x1b[39m`,
}

/** Plain ANSI colors when `stream` is a terminal and `NO_COLOR` is unset. */
export function paintFor(stream: NodeJS.WriteStream, env: NodeJS.ProcessEnv): Paint {
  return stream.isTTY && !env.NO_COLOR ? ANSI : PLAIN
}

/** Lines `--quiet` keeps. */
export type MajorKeyword = 'run' | 'step' | 'agent'
export type Keyword = MajorKeyword | 'user' | 'event'

export interface EventLine {
  keyword: Keyword
  text: string
}

export interface EventContext {
  runId: string
  /** Step views with this event already applied. */
  steps: ReadonlyMap<string, StepView>
  /** Every event so far, this one included. */
  events: ReadonlyArray<RunEvent>
  paint: Paint
}

type KnownEvent = Extract<RunEvent, { type: RunEventType }>

const KNOWN_TYPES: Record<RunEventType, true> = {
  'run.started': true,
  'run.paused': true,
  'run.finished': true,
  'step.started': true,
  'step.finished': true,
  'agent.spawned': true,
  'agent.finished': true,
  'user.note': true,
  'user.action': true,
}

/**
 * The run event schema only lets an event with a known type through as
 * that type's shape (an unknown-type event refuses known names), so the
 * type name decides the shape.
 */
function isKnown(event: RunEvent): event is KnownEvent {
  return Object.hasOwn(KNOWN_TYPES, event.type)
}

export function formatEvent(event: RunEvent, ctx: EventContext): EventLine {
  if (!isKnown(event)) {
    const text = line({ t: event.t, keyword: 'event', verb: event.type, rest: '' }, ctx.paint)
    return { keyword: 'event', text }
  }
  const { paint } = ctx
  const at = (keyword: Keyword, verb: string, rest: string): EventLine => ({
    keyword,
    text: line({ t: event.t, keyword, verb, rest }, paint),
  })
  switch (event.type) {
    case 'run.started': {
      const { chain, base, base_sha } = event.data
      return at(
        'run',
        'started',
        `${chain}  base ${base} @ ${base_sha.slice(0, 7)}  run ${ctx.runId}`,
      )
    }
    case 'run.paused': {
      const { before, after, reason } = event.data
      const where = before !== undefined ? `before ${before}` : `after ${after ?? '?'}`
      const why = reason === 'declared' ? 'declared; --no-pause to skip' : 'user'
      return at('run', 'paused', `${where}   (${why})`)
    }
    case 'run.finished': {
      const { status, failed_step } = event.data
      const progress = reduceRun(ctx.events)
      return at(
        'run',
        'finished',
        runFinishedText(status, failed_step, elapsed(progress.startedAt, event.t), paint),
      )
    }
    case 'step.started': {
      const { command } = event.data
      return at(
        'step',
        'started',
        command === undefined ? event.step : `${event.step}   ${commandLine(command)}`,
      )
    }
    case 'step.finished': {
      const { status, exit_code } = event.data
      const view = ctx.steps.get(event.step)
      const exit = status !== 'ok' && exit_code !== undefined ? ` (exit ${exit_code})` : ''
      const shown = status === 'ok' ? status : paint.error(`${status}${exit}`)
      return at(
        'step',
        'finished',
        `${event.step}   ${shown}  ${elapsed(view?.startedAt, view?.finishedAt)}`,
      )
    }
    case 'agent.spawned': {
      const { provider, model, effort, session_id, resumed } = event.data
      const who = [provider, model, effort].filter((s) => s !== undefined).join(' · ')
      const session = `${session_id.slice(0, SESSION_PREFIX)}…`
      return at(
        'agent',
        'spawned',
        `${event.step}/${event.agent}   ${who}   session ${session}  ${resumed ? 'resumed' : 'new'}`,
      )
    }
    case 'agent.finished': {
      const { status, usage, error } = event.data
      const view = ctx.steps.get(event.step)?.agent
      const parts = [
        status === 'ok' ? status : paint.error(status),
        elapsed(view?.startedAt, view?.finishedAt),
      ]
      if (usage !== undefined) parts.push(tokens(usage))
      if (error !== undefined) parts.push(paint.error(`${error.kind}: ${oneLine(error.message)}`))
      return at('agent', 'finished', `${event.step}/${event.agent}   ${parts.join('  ')}`)
    }
    case 'user.note': {
      const { text, applies_from } = event.data
      const from = applies_from === '' ? '' : `   (from ${applies_from})`
      return at('user', 'note', `${oneLine(text)}${from}`)
    }
    case 'user.action': {
      const { action, step } = event.data
      return at('user', action, step ?? '')
    }
    default:
      return exhaustive(event)
  }
}

/** The `run finished` line for a result whose `run.finished` event never arrived. */
export function formatRunFinished(
  result: RunResult,
  startedAt: string | undefined,
  paint: Paint,
): string {
  const { status, failedStep, finishedAt } = result
  const rest = runFinishedText(status, failedStep, elapsed(startedAt, finishedAt), paint)
  return line({ t: finishedAt, keyword: 'run', verb: 'finished', rest }, paint)
}

/** One output line per transcript line, prefixed `<step>/<label> | `. */
export function formatRecord(
  m: { step: string; label: string; record: TranscriptRecord },
  paint: Paint,
): string[] {
  const { record } = m
  const prefix = `${clock(record.t)}  ${m.step}/${m.label} | `
  switch (record.kind) {
    case 'text':
      return record.text
        .replace(/\r?\n$/, '')
        .split(/\r?\n/)
        .map((l) => `${prefix}${l}`)
    case 'tool': {
      const summary = toolSummary(record.input)
      const failed = record.ok ? '' : `  ${paint.error('(failed)')}`
      return [`${prefix}▸ ${record.name}${summary === '' ? '' : ` ${summary}`}${failed}`]
    }
    case 'note':
      return [`${prefix}note: ${oneLine(record.text)}`]
    default:
      return exhaustive(record)
  }
}

export function formatDiag(entry: DiagEntry): string {
  return `${clock(entry.t)}  ${'diag'.padEnd(KEYWORD_WIDTH)}${entry.scope}  ${entry.message}`
}

/**
 * With `RENSA_DEBUG=1`, writes every later diagnostic to stderr as it
 * happens. Returns the unsubscribe function (a no-op without it).
 */
export function streamDiag(env: NodeJS.ProcessEnv): () => void {
  if (env.RENSA_DEBUG !== '1') return () => {}
  return onDiag((entry) => writeLines(process.stderr, [formatDiag(entry)]))
}

/** Writes the lines; nothing once the stream's reader has gone (see `guardOutput`). */
export function writeLines(stream: NodeJS.WritableStream, lines: readonly string[]): void {
  if (lines.length > 0 && stream.writable) stream.write(`${lines.join('\n')}\n`)
}

const stdoutClosedListeners = new Set<() => void>()

/**
 * Turns a reader that goes away (`EPIPE`, as with `rensa run … | head`)
 * from a crash into an event: the stream is destroyed, so `writeLines`
 * skips it from then on, and for stdout every `onStdoutClosed` listener
 * runs once. Any other stream error still throws. Call once at startup.
 */
export function guardOutput(): void {
  for (const stream of [process.stdout, process.stderr]) {
    let gone = false
    stream.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EPIPE') throw err
      if (gone) return
      gone = true
      if (stream === process.stdout) for (const fn of [...stdoutClosedListeners]) fn()
    })
  }
}

/** Calls `fn` once stdout's reader has gone. Returns a function that removes it. */
export function onStdoutClosed(fn: () => void): () => void {
  stdoutClosedListeners.add(fn)
  return () => {
    stdoutClosedListeners.delete(fn)
  }
}

/** `error: <message>`, then `  hint: <hint>` when there is one. */
export function formatError(
  err: { message: string; hint?: string | undefined; details?: string[] | undefined },
  paint: Paint,
): string[] {
  const lines = [`${paint.error('error:')} ${err.message}`]
  for (const detail of err.details ?? []) lines.push(`  also: ${detail}`)
  if (err.hint !== undefined) lines.push(`  hint: ${err.hint}`)
  return lines
}

/** `claude   ready            2.1.3`, `codex    not logged in    0.48      run: codex login`. */
export function formatProvider({ provider, availability }: ProviderStatus, paint: Paint): string {
  const label = AVAILABILITY_LABELS[availability.status].padEnd(17)
  const shown = availability.status === 'ready' ? label : paint.error(label)
  const version = availability.status === 'not_installed' ? '' : availability.version
  const hint = availability.status === 'not_logged_in' ? availability.hint : ''
  return `${provider.padEnd(9)}${shown}${version.padEnd(10)}${hint}`.trimEnd()
}

const AVAILABILITY_LABELS: Record<Availability['status'], string> = {
  ready: 'ready',
  not_logged_in: 'not logged in',
  not_installed: 'not installed',
}

/** Local `HH:MM:SS`. */
export function clock(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '--:--:--'
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':')
}

/** `m:ss`, or `h:mm:ss` from an hour on; `–` when either end is unknown. */
export function elapsed(from: string | undefined, to: string | undefined): string {
  if (from === undefined || to === undefined) return '–'
  const ms = Date.parse(to) - Date.parse(from)
  if (!Number.isFinite(ms)) return '–'
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/** Input plus output tokens: `850 tok`, `12.4k tok`, `1.2M tok`. */
export function tokens(usage: Usage): string {
  const n = usage.input + usage.output
  if (n < 1000) return `${n} tok`
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k tok`
  return `${(n / 1_000_000).toFixed(1)}M tok`
}

/** The first string-valued field of a tool's input, on one line, at most 80 characters. */
export function toolSummary(input: unknown): string {
  let text: string | undefined
  if (typeof input === 'string') text = input
  else if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    text = Object.values(input).find((v): v is string => typeof v === 'string')
  }
  if (text === undefined) return ''
  const flat = oneLine(text)
  return flat.length > SUMMARY_MAX ? `${flat.slice(0, SUMMARY_MAX - 1)}…` : flat
}

function runFinishedText(
  status: string,
  failedStep: string | undefined,
  duration: string,
  paint: Paint,
): string {
  const at = failedStep === undefined ? '' : ` at ${failedStep}`
  const shown = status === 'complete' ? status : paint.error(`${status}${at}`)
  return `${shown}  ${duration}`
}

function line(
  { t, keyword, verb, rest }: { t: string; keyword: Keyword; verb: string; rest: string },
  paint: Paint,
): string {
  const kw = keyword.padEnd(KEYWORD_WIDTH)
  const shownKw = keyword === 'step' || keyword === 'agent' ? paint.secondary(kw) : kw
  return `${clock(t)}  ${shownKw}${verb.padEnd(VERB_WIDTH)}${rest}`.trimEnd()
}

/** Prose on one line: every line break, lone `\r` included, becomes a space. */
function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim()
}

/**
 * A shell command on one line for display: its non-blank lines joined
 * with ` ⏎ `, so `echo one` / `echo two` cannot read as `echo one echo
 * two`. The event keeps the command as written; `--json` prints that.
 */
export function commandLine(command: string): string {
  return command
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .join(' ⏎ ')
}

function exhaustive(value: never): never {
  throw new Error(`unhandled case: ${JSON.stringify(value)}`)
}
