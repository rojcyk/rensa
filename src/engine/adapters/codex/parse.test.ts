import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Usage } from '../../run/types.js'
import { fixtureTest } from '../fake/fixture.js'
import type { AgentEvent, DoneEvent } from '../types.js'
import { codexAdapter } from './index.js'
import { classifyText, parseCodex } from './parse.js'

const FIXTURES = path.resolve(import.meta.dirname, '../../../../test/fixtures/codex')

// Synthetic stream lines in the shapes codex-cli 0.166.0 prints; no
// fixture uses this id.
const THREAD_ID = '019a6c3e-7f21-7d40-9b8e-4c2a1f0d5e63'

// The observed 0.166.0 turn failure without a login (an empty CODEX_HOME).
const UNAUTHORIZED =
  'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://chatgpt.com/backend-api/codex/responses'

async function parseAll(lines: readonly string[]): Promise<AgentEvent[]> {
  async function* source() {
    yield* lines
  }
  const events: AgentEvent[] = []
  for await (const event of parseCodex(source())) events.push(event)
  return events
}

function line(value: unknown): string {
  return JSON.stringify(value)
}

function threadStarted(id = THREAD_ID): string {
  return line({ type: 'thread.started', thread_id: id })
}

function turnStarted(): string {
  return line({ type: 'turn.started' })
}

interface CodexUsageLine {
  input_tokens: number
  cached_input_tokens?: number
  cache_write_input_tokens?: number
  output_tokens: number
  reasoning_output_tokens?: number
}

const TURN_USAGE: CodexUsageLine = {
  input_tokens: 34_250,
  cached_input_tokens: 29_824,
  cache_write_input_tokens: 0,
  output_tokens: 166,
  reasoning_output_tokens: 64,
}

function turnCompleted(usage: CodexUsageLine = TURN_USAGE): string {
  return line({ type: 'turn.completed', usage })
}

function turnFailed(message: string): string {
  return line({ type: 'turn.failed', error: { message } })
}

function errorLine(message: string): string {
  return line({ type: 'error', message })
}

function agentMessage(id: string, text: string, kind = 'item.completed'): string {
  return line({ type: kind, item: { id, type: 'agent_message', text } })
}

function command(
  id: string,
  cmd: string,
  status: string,
  output: string | null = '',
  exitCode: number | null = null,
  kind = status === 'in_progress' ? 'item.started' : 'item.completed',
): string {
  return line({
    type: kind,
    item: {
      id,
      type: 'command_execution',
      command: cmd,
      aggregated_output: output,
      exit_code: exitCode,
      status,
    },
  })
}

interface Change {
  path: string
  kind: string
}

function fileChange(
  id: string,
  changes: Change[],
  status: string,
  kind = 'item.completed',
): string {
  return line({ type: kind, item: { id, type: 'file_change', changes, status } })
}

function nonRaw(events: AgentEvent[]): AgentEvent[] {
  return events.filter((e) => e.kind !== 'raw')
}

function doneOf(events: AgentEvent[]): DoneEvent {
  const last = events.at(-1)
  if (last?.kind !== 'done') throw new Error(`last event is ${last?.kind}, not done`)
  return last
}

const LS = "/bin/zsh -lc 'ls -la'"
const CAT_README = "/bin/zsh -lc 'cat README.md'"

describe('parsing captured codex output', () => {
  it('reproduces the read-only-hello fixture when its raw.jsonl is parsed', async () => {
    await expect(
      fixtureTest(codexAdapter, path.join(FIXTURES, 'read-only-hello')),
    ).resolves.toBeUndefined()
  })

  it('reproduces the tool-calls fixture when its raw.jsonl is parsed', async () => {
    await expect(
      fixtureTest(codexAdapter, path.join(FIXTURES, 'tool-calls')),
    ).resolves.toBeUndefined()
  })
})

describe('raw lines', () => {
  it('emits raw for each line before any event derived from it when lines carry a message and usage', async () => {
    const lines = [threadStarted(), agentMessage('item_0', 'Hello.'), turnCompleted()]

    const events = await parseAll(lines)

    expect(events.map((e) => e.kind)).toEqual(['raw', 'raw', 'text', 'raw', 'usage', 'done'])
    expect(events.filter((e) => e.kind === 'raw')).toEqual(
      lines.map((l) => ({ kind: 'raw', line: l })),
    )
  })

  it('emits only raw when a line is not JSON', async () => {
    const warning = 'WARNING: proceeding, even though we could not update PATH'

    const events = await parseAll([warning, turnCompleted()])

    expect(events.slice(0, 2)).toEqual([
      { kind: 'raw', line: warning },
      { kind: 'raw', line: turnCompleted() },
    ])
    expect(doneOf(events)).not.toHaveProperty('error')
  })

  it('emits only raw when a line is a JSON value that is not an object', async () => {
    const events = await parseAll(['42', '["thread.started"]', 'null', turnCompleted()])

    expect(nonRaw(events).map((e) => e.kind)).toEqual(['usage', 'done'])
  })

  it.each([
    ['turn.started', turnStarted()],
    [
      'a reasoning item',
      line({
        type: 'item.completed',
        item: { id: 'item_0', type: 'reasoning', text: '**Listing files**' },
      }),
    ],
    [
      'a todo_list item',
      line({
        type: 'item.started',
        item: {
          id: 'item_1',
          type: 'todo_list',
          items: [{ text: 'Read README.md', completed: false }],
        },
      }),
    ],
    ['an unknown line type', line({ type: 'session.configured', model: 'gpt-5.3-codex' })],
  ])('emits only raw when the line is %s, which rensa does not show', async (_, unknown) => {
    const events = await parseAll([unknown, turnCompleted()])

    expect(events[0]).toEqual({ kind: 'raw', line: unknown })
    expect(nonRaw(events).map((e) => e.kind)).toEqual(['usage', 'done'])
  })
})

describe('agent messages', () => {
  it('emits one text record and no delta when an agent_message completes', async () => {
    const events = await parseAll([
      agentMessage('item_0', 'No regressions found.'),
      turnCompleted(),
    ])

    expect(nonRaw(events).slice(0, 1)).toEqual([{ kind: 'text', text: 'No regressions found.' }])
    expect(events.filter((e) => e.kind === 'delta')).toEqual([])
  })

  it('emits nothing for an agent_message when it has only started or updated', async () => {
    const events = await parseAll([
      agentMessage('item_0', 'No regr', 'item.started'),
      agentMessage('item_0', 'No regressions', 'item.updated'),
      turnCompleted(),
    ])

    expect(nonRaw(events).map((e) => e.kind)).toEqual(['usage', 'done'])
    expect(doneOf(events).reply).toBe('')
  })

  it('emits no text record when a completed agent_message is empty', async () => {
    const events = await parseAll([agentMessage('item_0', ''), turnCompleted()])

    expect(nonRaw(events).map((e) => e.kind)).toEqual(['usage', 'done'])
  })
})

describe('tool calls', () => {
  it('emits a Bash tool record ok true with the command output when a command_execution completes', async () => {
    const events = await parseAll([
      command('item_1', LS, 'in_progress'),
      command('item_1', LS, 'completed', 'README.md\npackage.json\n', 0),
      turnCompleted(),
    ])

    expect(nonRaw(events)[0]).toEqual({
      kind: 'tool',
      name: 'Bash',
      input: { command: LS },
      ok: true,
      output: 'README.md\npackage.json\n',
    })
  })

  it('emits nothing for a command_execution when it has only started', async () => {
    const events = await parseAll([command('item_1', LS, 'in_progress'), turnCompleted()])

    expect(nonRaw(events).map((e) => e.kind)).toEqual(['usage', 'done'])
  })

  it.each([
    ['failed', 'cat: MISSING.md: No such file or directory\n', 1],
    ['declined', '', null],
  ] as const)(
    'emits a Bash tool record ok false when the command_execution status is %s',
    async (status, output, exitCode) => {
      const cmd = "/bin/zsh -lc 'cat MISSING.md'"

      const events = await parseAll([
        command('item_1', cmd, status, output, exitCode),
        turnCompleted(),
      ])

      expect(nonRaw(events)[0]).toEqual({
        kind: 'tool',
        name: 'Bash',
        input: { command: cmd },
        ok: false,
        output,
      })
    },
  )

  it('reports an empty output when a completed command_execution has a null aggregated_output', async () => {
    const events = await parseAll([
      command('item_1', 'true', 'completed', null, 0),
      turnCompleted(),
    ])

    expect(nonRaw(events)[0]).toMatchObject({ kind: 'tool', name: 'Bash', ok: true, output: '' })
  })

  it('pairs each completion with its own command when two commands finish out of order', async () => {
    const events = await parseAll([
      command('item_1', CAT_README, 'in_progress'),
      command('item_2', LS, 'in_progress'),
      command('item_2', LS, 'completed', 'README.md\n', 0),
      command('item_1', CAT_README, 'completed', '# shop\n', 0),
      turnCompleted(),
    ])

    expect(nonRaw(events).slice(0, 2)).toEqual([
      { kind: 'tool', name: 'Bash', input: { command: LS }, ok: true, output: 'README.md\n' },
      { kind: 'tool', name: 'Bash', input: { command: CAT_README }, ok: true, output: '# shop\n' },
    ])
  })

  it('emits an Edit tool record ok true with the changes as input when a file_change completes', async () => {
    const changes: Change[] = [
      { path: '/Users/alice/code/shop/src/cart/total.ts', kind: 'update' },
      { path: '/Users/alice/code/shop/src/cart/tax.ts', kind: 'add' },
    ]

    const events = await parseAll([
      fileChange('item_3', changes, 'in_progress', 'item.started'),
      fileChange('item_3', changes, 'completed'),
      turnCompleted(),
    ])

    const tools = nonRaw(events).filter((e) => e.kind === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ kind: 'tool', name: 'Edit', input: { changes }, ok: true })
  })

  it('emits an Edit tool record ok false when the file_change status is failed', async () => {
    const changes: Change[] = [{ path: '/Users/alice/code/shop/src/cart/total.ts', kind: 'update' }]

    const events = await parseAll([fileChange('item_3', changes, 'failed'), turnCompleted()])

    expect(nonRaw(events)[0]).toMatchObject({ kind: 'tool', name: 'Edit', ok: false })
  })

  it('keeps the first 4096 bytes of the output when a command prints more than 4 KB', async () => {
    const big = 'abcdefghij'.repeat(1000)

    const events = await parseAll([command('item_1', CAT_README, 'completed', big, 0)])

    const tool = nonRaw(events)[0]
    if (tool?.kind !== 'tool') throw new Error(`expected a tool record, got ${tool?.kind}`)
    expect(tool.output.startsWith(big.slice(0, 4096))).toBe(true)
    expect(tool.output).not.toContain(big.slice(0, 4097))
  })

  it('keeps an output of exactly 4096 bytes whole when a command prints exactly the cap', async () => {
    const atCap = 'x'.repeat(4096)

    const events = await parseAll([command('item_1', CAT_README, 'completed', atCap, 0)])

    expect(nonRaw(events)[0]).toMatchObject({ kind: 'tool', output: atCap })
  })

  it('cuts on a character boundary when the 4 KB cap falls inside a multi-byte character', async () => {
    // 4095 one-byte characters, then 'é' (two bytes) straddling byte 4096.
    const output = `${'x'.repeat(4095)}é${'q'.repeat(100)}`

    const events = await parseAll([command('item_1', CAT_README, 'completed', output, 0)])

    const tool = nonRaw(events)[0]
    if (tool?.kind !== 'tool') throw new Error(`expected a tool record, got ${tool?.kind}`)
    expect(tool.output.startsWith('x'.repeat(4095))).toBe(true)
    // Neither a mangled half of 'é' nor the whole of it, which would take 4097 bytes.
    expect(tool.output).not.toContain('\uFFFD')
    expect(tool.output).not.toContain('é')
    expect(tool.output).not.toContain('q')
  })
})

describe('usage from turn.completed', () => {
  it('emits usage with the uncached input and the cached part as cache_read when turn.completed arrives', async () => {
    const events = await parseAll([turnCompleted()])

    const expected: Usage = { input: 34_250 - 29_824, output: 166, cache_read: 29_824 }
    expect(nonRaw(events)[0]).toEqual({ kind: 'usage', usage: expected })
  })

  it('reports the input tokens whole and no cache_read when turn.completed has no cached count', async () => {
    const events = await parseAll([turnCompleted({ input_tokens: 5120, output_tokens: 88 })])

    const expected: Usage = { input: 5120, output: 88 }
    expect(doneOf(events).usage).toEqual(expected)
  })
})

describe('the done event at the end of the stream', () => {
  it('takes the reply from the last agent message, usage from turn.completed and the session id from thread.started', async () => {
    const events = await parseAll([
      threadStarted(),
      turnStarted(),
      agentMessage('item_0', "I'll read README.md."),
      command('item_1', CAT_README, 'in_progress'),
      command('item_1', CAT_README, 'completed', '# shop\n', 0),
      agentMessage('item_2', 'The README is a single heading.'),
      turnCompleted(),
    ])

    expect(doneOf(events)).toEqual({
      kind: 'done',
      reply: 'The README is a single heading.',
      exitCode: null,
      sessionId: THREAD_ID,
      usage: { input: 34_250 - 29_824, output: 166, cache_read: 29_824 },
    })
  })

  it('keeps the earlier reply when a later agent message is empty', async () => {
    const events = await parseAll([
      agentMessage('item_0', 'The README is a single heading.'),
      agentMessage('item_1', ''),
      turnCompleted(),
    ])

    expect(doneOf(events).reply).toBe('The README is a single heading.')
  })

  it('sets no sessionId when the stream has no thread.started line', async () => {
    const events = await parseAll([agentMessage('item_0', 'Hi.'), turnCompleted()])

    expect(doneOf(events)).not.toHaveProperty('sessionId')
  })

  it('takes the session id from thread.started when a resumed session reports it', async () => {
    const resumed = '019a5b10-2c44-7e81-a3d9-60f1b7e2c845'

    const events = await parseAll([threadStarted(resumed), turnCompleted()])

    expect(doneOf(events).sessionId).toBe(resumed)
  })

  it('emits exactly one done, last, when lines follow turn.completed', async () => {
    const events = await parseAll([turnCompleted(), turnStarted()])

    expect(events.map((e) => e.kind)).toEqual(['raw', 'usage', 'raw', 'done'])
  })
})

describe('the done event when the turn failed', () => {
  it('reports auth with the message when turn.failed carries the observed 401 message', async () => {
    const events = await parseAll([
      threadStarted(),
      turnStarted(),
      errorLine(UNAUTHORIZED),
      turnFailed(UNAUTHORIZED),
    ])

    expect(doneOf(events)).toEqual({
      kind: 'done',
      reply: '',
      exitCode: null,
      sessionId: THREAD_ID,
      error: { kind: 'auth', message: UNAUTHORIZED },
    })
  })

  it('reports usage_limit with the message when turn.failed says the usage limit was hit', async () => {
    const message =
      "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), or try again at Nov 9th, 2026 5:00 PM."

    const events = await parseAll([turnFailed(message)])

    expect(doneOf(events).error).toEqual({ kind: 'usage_limit', message })
  })

  it('reports exit with the message when turn.failed reads as neither auth nor a usage limit', async () => {
    const message =
      "The 'gpt-9-preview' model is not supported when using Codex with a ChatGPT account."

    const events = await parseAll([turnFailed(message)])

    expect(doneOf(events).error).toEqual({ kind: 'exit', message })
  })

  it('keeps the reply so far when the turn fails after an agent message', async () => {
    const events = await parseAll([
      agentMessage('item_0', 'Looking at the diff.'),
      turnFailed('stream disconnected before completion'),
    ])

    expect(doneOf(events)).toMatchObject({
      reply: 'Looking at the diff.',
      error: { kind: 'exit', message: 'stream disconnected before completion' },
    })
  })
})

describe('a stream with no completion evidence', () => {
  it('reports no_output when the stream has a message but neither turn.completed nor turn.failed', async () => {
    const events = await parseAll([threadStarted(), turnStarted(), agentMessage('item_0', 'Hel')])

    expect(doneOf(events).error).toEqual({ kind: 'no_output', message: expect.any(String) })
  })

  it('reports no_output when the only error lines are reconnect retries', async () => {
    const events = await parseAll([
      threadStarted(),
      turnStarted(),
      errorLine('Reconnecting... 2/5 (stream disconnected before completion: Transport error)'),
    ])

    expect(doneOf(events).error?.kind).toBe('no_output')
  })

  it('reports no_output and nothing else when the input is empty', async () => {
    const events = await parseAll([])

    expect(events).toEqual([
      {
        kind: 'done',
        reply: '',
        exitCode: null,
        error: { kind: 'no_output', message: expect.any(String) },
      },
    ])
  })
})

describe('classifying codex error messages', () => {
  it.each([
    [UNAUTHORIZED, 'auth'],
    ['Not logged in', 'auth'],
    ['Your access token could not be refreshed. Please log in again.', 'auth'],
    ["You've hit your usage limit. Try again at Nov 9th, 2026 5:00 PM.", 'usage_limit'],
    ['exceeded retry limit, last status: 429 Too Many Requests', 'usage_limit'],
    [
      "The 'gpt-9-preview' model is not supported when using Codex with a ChatGPT account.",
      undefined,
    ],
    ['stream disconnected before completion', undefined],
  ] as const)('classifies "%s" as %s', (message, kind) => {
    expect(classifyText(message)).toBe(kind)
  })

  it('reports usage_limit when a message reads as both a usage limit and a login problem', () => {
    expect(classifyText("You've hit your usage limit. Run codex login to switch accounts.")).toBe(
      'usage_limit',
    )
  })
})
