import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { fixtureTest } from '../fake/fixture.js'
import type { AgentEvent, DoneEvent } from '../types.js'
import { claudeAdapter } from './index.js'
import { parseClaude } from './parse.js'

const FIXTURES = path.resolve(import.meta.dirname, '../../../../test/fixtures/claude')

// Synthetic stream lines only; no fixture uses this id.
const SESSION = '00000000-0000-4000-8000-000000000010'

async function parseAll(lines: readonly string[]): Promise<AgentEvent[]> {
  async function* source() {
    yield* lines
  }
  const events: AgentEvent[] = []
  for await (const event of parseClaude(source())) events.push(event)
  return events
}

function line(value: unknown): string {
  return JSON.stringify(value)
}

function init(): string {
  return line({
    type: 'system',
    subtype: 'init',
    session_id: SESSION,
    model: 'claude-opus-4-1',
    cwd: '/Users/alice/code/shop',
    tools: ['Read', 'Glob', 'Grep'],
  })
}

function textDelta(text: string): string {
  return line({
    type: 'stream_event',
    session_id: SESSION,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  })
}

interface ClaudeUsageLine {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

function assistant(content: unknown[], usage?: ClaudeUsageLine): string {
  return line({
    type: 'assistant',
    session_id: SESSION,
    message: {
      id: 'msg_01Hq3vK8',
      role: 'assistant',
      model: 'claude-opus-4-1',
      content,
      ...(usage && { usage }),
    },
  })
}

function toolResult(toolUseId: string, content: unknown, isError?: boolean): string {
  return line({
    type: 'user',
    session_id: SESSION,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content,
          ...(isError !== undefined && { is_error: isError }),
        },
      ],
    },
  })
}

interface ResultFields {
  subtype?: string
  is_error?: boolean
  result?: string
  usage?: ClaudeUsageLine
}

function result(fields: ResultFields = {}): string {
  return line({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 4211,
    num_turns: 2,
    result: 'Done.',
    session_id: SESSION,
    total_cost_usd: 0.0412,
    ...fields,
  })
}

function nonRaw(events: AgentEvent[]): AgentEvent[] {
  return events.filter((e) => e.kind !== 'raw')
}

function doneOf(events: AgentEvent[]): DoneEvent {
  const last = events.at(-1)
  if (last?.kind !== 'done') throw new Error(`last event is ${last?.kind}, not done`)
  return last
}

describe('parsing captured claude output', () => {
  it('reproduces the read-only-hello fixture when its raw.jsonl is parsed', async () => {
    await expect(
      fixtureTest(claudeAdapter, path.join(FIXTURES, 'read-only-hello')),
    ).resolves.toBeUndefined()
  })

  it('reproduces the tool-calls fixture when its raw.jsonl is parsed', async () => {
    await expect(
      fixtureTest(claudeAdapter, path.join(FIXTURES, 'tool-calls')),
    ).resolves.toBeUndefined()
  })
})

describe('raw lines', () => {
  it('emits raw for each line before any event derived from it when lines carry text', async () => {
    const lines = [init(), textDelta('Hello'), assistant([{ type: 'text', text: 'Hello' }])]

    const events = await parseAll(lines)

    expect(events.map((e) => e.kind)).toEqual(['raw', 'raw', 'delta', 'raw', 'text', 'done'])
    expect(events.filter((e) => e.kind === 'raw')).toEqual(
      lines.map((l) => ({ kind: 'raw', line: l })),
    )
  })

  it('emits only raw when a line is not JSON', async () => {
    const warning = 'Warning: settings.json has an unknown key "theme"'

    const events = await parseAll([warning, result()])

    expect(events.slice(0, 2)).toEqual([
      { kind: 'raw', line: warning },
      { kind: 'raw', line: result() },
    ])
    expect(events).toHaveLength(3)
  })

  it('emits only raw when a line is a JSON value that is not an object', async () => {
    const events = await parseAll(['42', '["assistant"]', 'null'])

    expect(events.slice(0, 3).map((e) => e.kind)).toEqual(['raw', 'raw', 'raw'])
    expect(events).toHaveLength(4)
  })

  it('emits only raw when the line type is one rensa does not read', async () => {
    const rateLimit = line({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } })

    const events = await parseAll([init(), rateLimit, result()])

    expect(nonRaw(events).map((e) => e.kind)).toEqual(['done'])
  })

  it('emits only raw when an assistant line has no content array', async () => {
    const broken = line({ type: 'assistant', message: { role: 'assistant' } })

    const events = await parseAll([broken, result()])

    expect(nonRaw(events).map((e) => e.kind)).toEqual(['done'])
  })
})

describe('streaming and finished text', () => {
  it('emits a delta with the new text when a stream event carries a text_delta', async () => {
    const events = await parseAll([textDelta('Hel'), textDelta('lo, Alice.')])

    expect(nonRaw(events).slice(0, 2)).toEqual([
      { kind: 'delta', text: 'Hel' },
      { kind: 'delta', text: 'lo, Alice.' },
    ])
  })

  it('emits no delta when a stream event carries a thinking or tool-input delta', async () => {
    const thinking = line({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Hmm' } },
    })
    const toolInput = line({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '{"file_path":' },
      },
    })
    const start = line({ type: 'stream_event', event: { type: 'message_start' } })

    const events = await parseAll([start, thinking, toolInput])

    expect(nonRaw(events).map((e) => e.kind)).toEqual(['done'])
  })

  it('emits a text record with the full block when an assistant message has a text block', async () => {
    const events = await parseAll([
      assistant([{ type: 'text', text: 'The README is a single heading.' }]),
    ])

    expect(nonRaw(events)[0]).toEqual({ kind: 'text', text: 'The README is a single heading.' })
  })

  it('emits no record for a thinking block when an assistant message has one', async () => {
    const events = await parseAll([
      assistant([
        { type: 'thinking', thinking: 'The user wants a listing.', signature: 'EqQBCkYI' },
        { type: 'text', text: 'Here are the files.' },
      ]),
    ])

    expect(nonRaw(events).slice(0, -1)).toEqual([{ kind: 'text', text: 'Here are the files.' }])
  })
})

describe('tool calls', () => {
  const readUse = {
    type: 'tool_use',
    id: 'toolu_01A9xQ7b',
    name: 'Read',
    input: { file_path: '/Users/alice/code/shop/README.md' },
  }

  it('emits one tool record with name, input and output when a tool_use is followed by its result', async () => {
    const events = await parseAll([
      assistant([readUse]),
      toolResult('toolu_01A9xQ7b', '1\t# shop\n'),
    ])

    expect(nonRaw(events).slice(0, -1)).toEqual([
      {
        kind: 'tool',
        name: 'Read',
        input: { file_path: '/Users/alice/code/shop/README.md' },
        ok: true,
        output: '1\t# shop\n',
      },
    ])
  })

  it('emits nothing for a tool_use when its result has not arrived', async () => {
    const events = await parseAll([assistant([readUse])])

    expect(nonRaw(events).map((e) => e.kind)).toEqual(['done'])
  })

  it('marks the tool record not ok when the tool result has is_error true', async () => {
    const events = await parseAll([
      assistant([readUse]),
      toolResult('toolu_01A9xQ7b', 'File does not exist.', true),
    ])

    expect(nonRaw(events)[0]).toMatchObject({
      kind: 'tool',
      ok: false,
      output: 'File does not exist.',
    })
  })

  it('pairs each result with its own tool_use when two calls are in flight', async () => {
    const globUse = {
      type: 'tool_use',
      id: 'toolu_01Zk4mP2',
      name: 'Glob',
      input: { pattern: '*.md' },
    }

    const events = await parseAll([
      assistant([readUse, globUse]),
      toolResult('toolu_01Zk4mP2', 'README.md\nCHANGELOG.md'),
      toolResult('toolu_01A9xQ7b', '1\t# shop\n'),
    ])

    expect(nonRaw(events).slice(0, -1)).toEqual([
      {
        kind: 'tool',
        name: 'Glob',
        input: { pattern: '*.md' },
        ok: true,
        output: 'README.md\nCHANGELOG.md',
      },
      {
        kind: 'tool',
        name: 'Read',
        input: { file_path: '/Users/alice/code/shop/README.md' },
        ok: true,
        output: '1\t# shop\n',
      },
    ])
  })

  it('gives the output as text when the tool result content is a list of text blocks', async () => {
    const events = await parseAll([
      assistant([readUse]),
      toolResult('toolu_01A9xQ7b', [
        { type: 'text', text: 'first block' },
        { type: 'text', text: 'second block' },
      ]),
    ])

    const tool = nonRaw(events)[0]
    expect(tool?.kind === 'tool' && tool.output).toBe('first block\nsecond block')
  })

  it('keeps the first 4096 bytes of the output when a tool result is larger than 4 KB', async () => {
    const big = 'abcdefghij'.repeat(1000)

    const events = await parseAll([assistant([readUse]), toolResult('toolu_01A9xQ7b', big)])

    const tool = nonRaw(events)[0]
    if (tool?.kind !== 'tool') throw new Error(`expected a tool record, got ${tool?.kind}`)
    expect(tool.output.startsWith(big.slice(0, 4096))).toBe(true)
    expect(tool.output).not.toContain(big.slice(0, 4097))
  })

  it('keeps an output of exactly 4096 bytes whole when a tool result is at the cap', async () => {
    const atCap = 'x'.repeat(4096)

    const events = await parseAll([assistant([readUse]), toolResult('toolu_01A9xQ7b', atCap)])

    expect(nonRaw(events)[0]).toMatchObject({ kind: 'tool', output: atCap })
  })

  it('does not split a multi-byte character when the 4 KB cut falls inside one', async () => {
    // 'é' is two bytes, so byte 4096 starts the 2049th character after a one-byte prefix.
    const text = `x${'é'.repeat(3000)}`

    const events = await parseAll([assistant([readUse]), toolResult('toolu_01A9xQ7b', text)])

    const tool = nonRaw(events)[0]
    if (tool?.kind !== 'tool') throw new Error(`expected a tool record, got ${tool?.kind}`)
    expect(tool.output).not.toContain('�')
    expect(tool.output.startsWith(`x${'é'.repeat(2047)}`)).toBe(true)
  })
})

describe('the done event from the result line', () => {
  it('takes the reply from result and leaves exitCode null when the result succeeds', async () => {
    const events = await parseAll([init(), result({ result: 'Hello from the shop repo.' })])

    expect(doneOf(events)).toEqual({
      kind: 'done',
      reply: 'Hello from the shop repo.',
      exitCode: null,
    })
  })

  it('emits exactly one done, last, when lines follow the result', async () => {
    const summary = line({ type: 'system', subtype: 'post_turn_summary' })

    const events = await parseAll([result(), summary])

    expect(events.map((e) => e.kind)).toEqual(['raw', 'raw', 'done'])
  })

  it('maps result usage and takes context from the last assistant message usage', async () => {
    const events = await parseAll([
      assistant([{ type: 'text', text: 'Looking.' }], {
        input_tokens: 2,
        output_tokens: 30,
        cache_read_input_tokens: 9000,
        cache_creation_input_tokens: 100,
      }),
      assistant([{ type: 'text', text: 'Done.' }], {
        input_tokens: 3,
        output_tokens: 40,
        cache_read_input_tokens: 12_000,
        cache_creation_input_tokens: 215,
      }),
      result({
        usage: {
          input_tokens: 5,
          output_tokens: 70,
          cache_read_input_tokens: 21_000,
          cache_creation_input_tokens: 315,
        },
      }),
    ])

    expect(doneOf(events).usage).toEqual({
      input: 5,
      output: 70,
      cache_read: 21_000,
      context: 3 + 12_000 + 215,
    })
  })

  it('leaves context out of usage when no assistant message carried usage', async () => {
    const events = await parseAll([
      result({ usage: { input_tokens: 240, output_tokens: 42, cache_read_input_tokens: 100 } }),
    ])

    expect(doneOf(events).usage).toEqual({ input: 240, output: 42, cache_read: 100 })
  })

  it('leaves usage out when the result carries none', async () => {
    const events = await parseAll([result()])

    expect(doneOf(events)).not.toHaveProperty('usage')
  })

  it('sets no sessionId when the stream carries a session id', async () => {
    const events = await parseAll([init(), result()])

    expect(doneOf(events)).not.toHaveProperty('sessionId')
  })
})

describe('classifying errors from the result line', () => {
  it.each([
    ['Claude AI usage limit reached|1762430400', 'usage_limit'],
    ["You've hit your weekly limit · resets Nov 9, 5pm", 'usage_limit'],
    ['Your limit resets at 3pm (Europe/Prague)', 'usage_limit'],
    ['Not logged in · Please run /login', 'auth'],
    ['Authentication failed: OAuth token has expired', 'auth'],
    ['Reached maximum number of turns (25)', 'exit'],
  ] as const)('classifies "%s" as %s when the subtype is not success', async (reply, kind) => {
    const events = await parseAll([
      result({ subtype: 'error_during_execution', is_error: true, result: reply }),
    ])

    expect(doneOf(events)).toEqual({
      kind: 'done',
      reply,
      exitCode: null,
      error: { kind, message: reply },
    })
  })

  it('reports no error when the subtype is success', async () => {
    const events = await parseAll([
      result({ subtype: 'success', result: 'Login page looks fine.' }),
    ])

    expect(doneOf(events)).not.toHaveProperty('error')
  })

  it('reports no_output with an empty reply when the stream has no result line', async () => {
    const events = await parseAll([
      init(),
      textDelta('Hel'),
      assistant([{ type: 'text', text: 'Hello' }]),
    ])

    expect(doneOf(events)).toEqual({
      kind: 'done',
      reply: '',
      exitCode: null,
      error: { kind: 'no_output', message: expect.any(String) },
    })
  })

  it('reports no_output when the input is empty', async () => {
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
