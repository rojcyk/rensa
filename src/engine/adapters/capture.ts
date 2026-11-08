import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Provider } from '../config/types.js'
import { RensaError } from '../errors.js'
import { childEnv } from '../process/env.js'
import type { TranscriptRecord } from '../run/types.js'
import { buildArgv as claudeArgv } from './claude/argv.js'
import { buildArgv as grokArgv, stagedPromptFor } from './grok/argv.js'
import { getAdapter } from './registry.js'
import type { AgentEvent, DoneEvent, Parser, SpawnRequest } from './types.js'

// `rensa capture`, a development command: runs one provider turn for
// real and writes what it printed as a fixture under
// `test/fixtures/<provider>/<name>/`, so the parser can be pinned to
// real output. See fake/fixture.ts for the format.

const CAPTURE_TIMEOUT_MS = 10 * 60 * 1000
const STDERR_PREFIX = 'stderr: '

/** The command line each provider's adapter runs, for `meta.json`; absent: not recorded. */
const ARGV: Partial<Record<Provider, (req: SpawnRequest) => string[]>> = {
  claude: (req) => claudeArgv(req, {}),
  // The staging decision the adapter acts on, so `--prompt-file` is recorded when it was used.
  grok: (req) => grokArgv(req, stagedPromptFor(req)),
}

export interface CaptureOptions {
  provider: Provider
  /** Fixture directory name; letters, digits, `_` and `-` (the CLI checks). */
  name: string
  prompt: string
  /** Where the agent runs and where `test/fixtures/` is written. */
  cwd: string
  env: NodeJS.ProcessEnv
}

export interface CaptureResult {
  /** The fixture directory written. */
  dir: string
  /** The final `done` of the run, reconciled with the process; not the one in `done.json`. */
  done: DoneEvent
}

/**
 * Runs `prompt` through the provider's adapter with read-only tools, then
 * feeds the captured stdout lines through the adapter's parser and
 * writes `raw.jsonl`, `transcript.jsonl`, `reply.md`, `done.json` (the
 * parser's provisional `done` minus `kind` and `reply`) and `meta.json`.
 * Nothing is redacted: review the files before committing them.
 */
export async function captureFixture(opts: CaptureOptions): Promise<CaptureResult> {
  const adapter = getAdapter(opts.provider)
  const availability = await adapter.available(opts.env)
  if (availability.status === 'not_installed') {
    throw new RensaError('PROVIDER_UNAVAILABLE', `${opts.provider} is not installed`)
  }
  if (availability.status === 'not_logged_in') {
    throw new RensaError(
      'PROVIDER_UNAVAILABLE',
      `${opts.provider} is not logged in`,
      undefined,
      availability.hint,
    )
  }

  const stagingDir = await mkdtemp(path.join(os.tmpdir(), 'rensa-capture-'))
  try {
    const req: SpawnRequest = {
      cwd: opts.cwd,
      env: childEnv(opts.env, { allowApiKeys: false }),
      message: opts.prompt,
      tools: 'read',
      session: { id: randomUUID(), resume: false },
      stagingDir,
      timeoutMs: CAPTURE_TIMEOUT_MS,
    }
    const { lines, times, done } = await runOnce(adapter.spawn(req).events)
    const parsed = await reparse(adapter.parse, lines, times)

    const dir = path.join(opts.cwd, 'test', 'fixtures', opts.provider, opts.name)
    await mkdir(dir, { recursive: true })
    const { kind: _kind, reply, ...doneFile } = parsed.done
    const argv = ARGV[opts.provider]?.(req)
    const meta = {
      provider: opts.provider,
      captured: new Date().toISOString().slice(0, 10),
      ...(argv && { argv }),
      note: `${opts.provider} ${availability.version}. Prompt: ${opts.prompt}`,
    }
    await Promise.all([
      writeFile(path.join(dir, 'raw.jsonl'), jsonl(lines)),
      writeFile(
        path.join(dir, 'transcript.jsonl'),
        jsonl(parsed.records.map((r) => JSON.stringify(r))),
      ),
      writeFile(path.join(dir, 'reply.md'), reply),
      writeFile(path.join(dir, 'done.json'), `${JSON.stringify(doneFile, null, 2)}\n`),
      writeFile(path.join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`),
    ])
    return { dir, done }
  } finally {
    await rm(stagingDir, { recursive: true, force: true })
  }
}

/**
 * The stdout lines of one run with their arrival times, and its final
 * `done`. Stderr lines, which the adapter emits as `raw` with a
 * `stderr: ` prefix, are not stdout and stay out of the fixture.
 */
async function runOnce(events: AsyncIterable<AgentEvent>) {
  const lines: string[] = []
  const times: string[] = []
  let done: DoneEvent | undefined
  for await (const event of events) {
    if (event.kind === 'raw' && !event.line.startsWith(STDERR_PREFIX)) {
      lines.push(event.line)
      times.push(new Date().toISOString())
    }
    if (event.kind === 'done') done = event
  }
  if (done === undefined) throw new RensaError('INTERNAL', 'the adapter ended without a done')
  return { lines, times, done }
}

/** The parser's records, each stamped with its line's arrival time, and the parser's `done`. */
async function reparse(
  parse: Parser,
  lines: readonly string[],
  times: readonly string[],
): Promise<{ records: TranscriptRecord[]; done: DoneEvent }> {
  const records: TranscriptRecord[] = []
  let done: DoneEvent | undefined
  let line = -1
  for await (const event of parse(fromArray(lines))) {
    switch (event.kind) {
      case 'raw':
        line += 1
        break
      case 'text':
      case 'tool':
      case 'note':
        records.push({ t: times[line] ?? new Date().toISOString(), ...event })
        break
      case 'done':
        done = event
        break
      default:
        break
    }
  }
  if (done === undefined) throw new RensaError('INTERNAL', 'the parser ended without a done')
  return { records, done }
}

function jsonl(lines: readonly string[]): string {
  return lines.map((line) => `${line}\n`).join('')
}

async function* fromArray(lines: readonly string[]): AsyncGenerator<string> {
  yield* lines
}
