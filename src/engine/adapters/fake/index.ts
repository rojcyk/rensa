import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { EFFORTS, TOOLS } from '../../config/types.js'
import { diag } from '../../diag.js'
import { AgentErrorSchema, type Usage, UsageSchema } from '../../run/types.js'
import type {
  Adapter,
  AgentEvent,
  AgentProcess,
  Availability,
  DoneEvent,
  SpawnRequest,
} from '../types.js'
import { splitLines } from './fixture.js'

// A provider for development and tests: it replays a fixture's raw.jsonl
// through its own parser instead of running a CLI. Registered only with
// RENSA_DEV=1. Environment hooks, read from the env it is given:
//
//   RENSA_FAKE_FIXTURE              fixture directory, relative to the request's cwd
//   RENSA_FAKE_DELAY_MS             delay before each replayed line (default 20)
//   RENSA_FAKE_KILL_DELAY_MS        delay between kill() and the final done (default 0)
//   RENSA_FAKE_AVAILABILITY         not_installed | not_logged_in instead of ready
//   RENSA_FAKE_AVAILABLE_DELAY_MS   delay before available() answers (default 0)

const SCOPE = 'fake'
const VERSION = 'fake'
const DEFAULT_FIXTURE = path.join('test', 'fixtures', 'fake', 'hello')

/** One line of the fake dialect. */
const FakeLineSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('delta'), text: z.string() }),
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('tool'),
    name: z.string(),
    input: z.unknown(),
    ok: z.boolean(),
    output: z.string(),
  }),
  UsageSchema.extend({ type: z.literal('usage') }),
  z.object({ type: z.literal('done'), exit: z.number(), error: AgentErrorSchema.optional() }),
])

export const fakeAdapter: Adapter = {
  provider: 'fake',

  capabilities() {
    return { resume: true, model: true, effort: [...EFFORTS], tools: [...TOOLS] }
  },

  async available(env): Promise<Availability> {
    const delayMs = msFromEnv(env, 'RENSA_FAKE_AVAILABLE_DELAY_MS', 0)
    if (delayMs > 0) await sleep(delayMs)
    const wanted = env.RENSA_FAKE_AVAILABILITY
    if (wanted === 'not_installed') return { status: 'not_installed' }
    if (wanted === 'not_logged_in') {
      return { status: 'not_logged_in', version: VERSION, hint: 'fake login' }
    }
    if (wanted !== undefined && wanted !== '') {
      diag(
        SCOPE,
        `ignoring RENSA_FAKE_AVAILABILITY=${wanted}; expected not_installed or not_logged_in`,
      )
    }
    return { status: 'ready', version: VERSION }
  },

  spawn(req): AgentProcess {
    const abort = new AbortController()
    return {
      kill: () => abort.abort(),
      events: replay(req, abort.signal),
    }
  },

  parse: parseFake,
}

/**
 * Parses the fake dialect, one JSON object per line:
 *
 *   {"type":"delta","text":"..."}
 *   {"type":"text","text":"..."}
 *   {"type":"tool","name":"Read","input":{...},"ok":true,"output":"..."}
 *   {"type":"usage","input":10,"output":20}
 *   {"type":"done","exit":0}  or  {"type":"done","exit":1,"error":{"kind":"auth","message":"..."}}
 *
 * The reply is the last `text` record. A line that does not fit is
 * reported through `diag` and skipped. The `done` is held until the
 * input ends, so lines after it still get their `raw` and `done` stays
 * last. The `done` line is the fake's completion evidence: input without
 * one gets `no_output`.
 */
export async function* parseFake(lines: AsyncIterable<string>): AsyncGenerator<AgentEvent> {
  let reply = ''
  let usage: Usage | undefined
  let done: DoneEvent | undefined
  let n = 0
  for await (const line of lines) {
    n += 1
    yield { kind: 'raw', line }
    if (line.trim() === '') continue
    const parsed = parseLine(line)
    if (parsed === undefined) {
      diag(SCOPE, `line ${n}: not a fake event: ${line.slice(0, 200)}`)
      continue
    }
    if (done) {
      diag(SCOPE, `line ${n}: ignored after done`)
      continue
    }
    switch (parsed.type) {
      case 'delta':
        yield { kind: 'delta', text: parsed.text }
        break
      case 'text':
        reply = parsed.text
        yield { kind: 'text', text: parsed.text }
        break
      case 'tool': {
        const { type: _, ...tool } = parsed
        yield { kind: 'tool', ...tool }
        break
      }
      case 'usage': {
        const { type: _, ...counts } = parsed
        usage = counts
        yield { kind: 'usage', usage }
        break
      }
      case 'done':
        done = {
          kind: 'done',
          reply,
          exitCode: parsed.exit,
          ...(usage && { usage }),
          ...(parsed.error && { error: parsed.error }),
        }
        break
      default:
        return exhaustive(parsed)
    }
  }
  yield done ?? {
    kind: 'done',
    reply,
    exitCode: null,
    ...(usage && { usage }),
    error: { kind: 'no_output', message: 'no done line in the stream' },
  }
}

/**
 * Replays the fixture chosen by `req.env` until its `done`, or until
 * `signal` aborts. There is no process to reconcile with, so the
 * parser's `done` is final; `kill()` replaces it (`Adapter.spawn` rule 2).
 */
async function* replay(req: SpawnRequest, signal: AbortSignal): AsyncGenerator<AgentEvent> {
  const delayMs = msFromEnv(req.env, 'RENSA_FAKE_DELAY_MS', 20)
  const killDelayMs = msFromEnv(req.env, 'RENSA_FAKE_KILL_DELAY_MS', 0)
  let lines: string[]
  try {
    await recordRequest(req)
    lines = splitLines(await readFile(path.join(fixtureDir(req), 'raw.jsonl'), 'utf8'))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    yield { kind: 'done', reply: '', exitCode: null, error: { kind: 'exit', message } }
    return
  }

  let reply = ''
  let usage: Usage | undefined
  for await (const event of parseFake(paced(lines, delayMs, signal))) {
    // Once killed, the parser's own end-of-input `done` is not the answer.
    if (signal.aborted) break
    if (event.kind === 'text') reply = event.text
    if (event.kind === 'usage') usage = event.usage
    yield event
    if (event.kind === 'done') return
  }
  await sleep(killDelayMs)
  yield {
    kind: 'done',
    reply,
    exitCode: null,
    ...(usage && { usage }),
    error: { kind: 'exit', message: 'killed' },
  }
}

async function* paced(
  lines: readonly string[],
  delayMs: number,
  signal: AbortSignal,
): AsyncGenerator<string> {
  for (const line of lines) {
    await sleep(delayMs, undefined, { signal }).catch(() => {})
    if (signal.aborted) return
    yield line
  }
}

/**
 * Writes the request to `stagingDir/request.json` so tests can assert
 * what was sent. Only the `RENSA_*` part of the environment is kept: the
 * rest is the user's, and may hold secrets.
 */
async function recordRequest(req: SpawnRequest): Promise<void> {
  const env = Object.fromEntries(
    Object.entries(req.env).filter(([key]) => key.startsWith('RENSA_')),
  )
  await mkdir(req.stagingDir, { recursive: true })
  await writeFile(
    path.join(req.stagingDir, 'request.json'),
    `${JSON.stringify({ ...req, env }, null, 2)}\n`,
  )
}

function fixtureDir(req: SpawnRequest): string {
  const chosen = req.env.RENSA_FAKE_FIXTURE
  if (chosen !== undefined && chosen !== '') return path.resolve(req.cwd, chosen)
  const found = findDefaultFixture()
  if (found === undefined) {
    throw new Error(`cannot find ${DEFAULT_FIXTURE} above this module; set RENSA_FAKE_FIXTURE`)
  }
  return found
}

let defaultFixture: string | undefined

/**
 * The hello fixture in the source checkout, found by walking up from
 * this module: the same search works from `src/` under vitest and from
 * the bundled `dist/`.
 */
function findDefaultFixture(): string | undefined {
  if (defaultFixture !== undefined) return defaultFixture
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const candidate = path.join(dir, DEFAULT_FIXTURE)
    if (existsSync(path.join(candidate, 'raw.jsonl'))) {
      defaultFixture = candidate
      return candidate
    }
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

function parseLine(line: string): z.infer<typeof FakeLineSchema> | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  const parsed = FakeLineSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

function msFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const text = env[key]
  if (text === undefined || text === '') return fallback
  const ms = Number(text)
  if (Number.isFinite(ms) && ms >= 0) return ms
  diag(SCOPE, `ignoring ${key}=${text}; expected a non-negative number of milliseconds`)
  return fallback
}

function exhaustive(value: never): never {
  throw new Error(`unhandled fake line: ${JSON.stringify(value)}`)
}
