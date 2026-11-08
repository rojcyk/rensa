import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Usage } from '../../run/types.js'
import { fixtureTest } from '../fake/fixture.js'
import type { AgentEvent, DoneEvent } from '../types.js'
import { grokAdapter } from './index.js'
import { classifyText, parseGrok } from './parse.js'

const FIXTURES = path.resolve(import.meta.dirname, '../../../../test/fixtures/grok')

// Synthetic stream lines in the shapes Grok Build 1.0.70 prints; no
// fixture uses these ids.
const SESSION = '00000000-0000-4000-8000-000000000020'
const CALL_README = 'call-3e9b51d0-7c2a-4f18-9b6e-2d4c8a1f0e57-0'
const CALL_MISSING = 'call-3e9b51d0-7c2a-4f18-9b6e-2d4c8a1f0e57-1'

// The observed 1.0.70 message without a login (an empty GROK_HOME).
const NOT_SIGNED_IN =
  'Not signed in. To authenticate without a browser, run:\n  grok login --device-code ...'

async function parseAll(lines: readonly string[]): Promise<AgentEvent[]> {
  async function* source() {
    yield* lines
  }
  const events: AgentEvent[] = []
  for await (const event of parseGrok(source())) events.push(event)
  return events
}

function line(value: unknown): string {
  return JSON.stringify(value)
}

function text(data: string): string {
  return line({ type: 'text', data })
}

function thought(data: string): string {
  return line({ type: 'thought', data })
}

function availableCommands(): string {
  return line({
    type: 'available_commands',
    tools: ['read_file', 'list_dir', 'grep', 'search_tool', 'use_tool'],
    commands: ['compact', 'context', 'session-info'],
  })
}

function toolCall(id: string, name: string, input: unknown, status = 'pending'): string {
  return line({
    type: 'tool_call',
    toolCallId: id,
    title: name,
    kind: 'read',
    status,
    toolName: name,
    rawInput: input,
    content: [],
    locations: [],
  })
}

function toolUpdate(
  id: string,
  status: string | null,
  content: unknown[] = [],
  rawOutput: unknown = null,
): string {
  return line({
    type: 'tool_call_update',
    toolCallId: id,
    status,
    content,
    rawOutput,
    locations: [],
  })
}

function contentText(textValue: string): unknown {
  return { type: 'content', content: { type: 'text', text: textValue } }
}

interface GrokUsageLine {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  reasoning_tokens?: number
}

function usage(value: GrokUsageLine): string {
  return line({ type: 'usage', usage: value, signature: 'G5rjsXsTA2lbg4PAqvt+taQV3e84Nu4E' })
}

function end(stopReason: string | null = 'end_turn', value?: GrokUsageLine): string {
  return line({
    type: 'end',
    stopReason,
    sessionId: SESSION,
    requestId: '00000000-0000-4000-9000-000000000020',
    cwd: '/Users/alice/code/shop',
    ...(value && { usage: value }),
    num_turns: 2,
    total_cost_usd: 0.0123,
  })
}

function errorLine(message: string, value?: GrokUsageLine): string {
  return line({ type: 'error', message, ...(value && { usage: value }) })
}

const FIRST_RESPONSE: GrokUsageLine = {
  input_tokens: 5259,
  output_tokens: 132,
  cache_read_input_tokens: 3840,
  cache_creation_input_tokens: 0,
  reasoning_tokens: 56,
}

const SECOND_RESPONSE: GrokUsageLine = {
  input_tokens: 915,
  output_tokens: 294,
  cache_read_input_tokens: 9088,
  cache_creation_input_tokens: 120,
  reasoning_tokens: 229,
}

function nonRaw(events: AgentEvent[]): AgentEvent[] {
  return events.filter((e) => e.kind !== 'raw')
}

function doneOf(events: AgentEvent[]): DoneEvent {
  const last = events.at(-1)
  if (last?.kind !== 'done') throw new Error(`last event is ${last?.kind}, not done`)
  return last
}

describe('parsing captured grok output', () => {
  it('reproduces the read-only-hello fixture when its raw.jsonl is parsed', async () => {
    await expect(
      fixtureTest(grokAdapter, path.join(FIXTURES, 'read-only-hello')),
    ).resolves.toBeUndefined()
  })

  it('reproduces the tool-calls fixture when its raw.jsonl is parsed', async () => {
    await expect(
      fixtureTest(grokAdapter, path.join(FIXTURES, 'tool-calls')),
    ).resolves.toBeUndefined()
  })
})

describe('raw lines', () => {
  it('emits raw for each line before any event derived from it when lines carry text', async () => {
    const lines = [text('Hello'), usage(FIRST_RESPONSE), end()]

    const events = await parseAll(lines)

    expect(events.map((e) => e.kind)).toEqual([
      'raw',
      'delta',
      'raw',
      'text',
      'usage',
      'raw',
      'done',
    ])
    expect(events.filter((e) => e.kind === 'raw')).toEqual(
      lines.map((l) => ({ kind: 'raw', line: l })),
    )
  })

  it('emits only raw when a line is not JSON', async () => {
    const warning = 'warning: a newer version of grok is available (1.0.71)'

    const events = await parseAll([warning, end()])

    expect(events).toEqual([
      { kind: 'raw', line: warning },
      { kind: 'raw', line: end() },
      { kind: 'done', reply: '', exitCode: null },
    ])
  })

  it('emits only raw when a line is a JSON value that is not an object', async () => {
    const events = await parseAll(['42', '["text"]', 'null', end()])

    expect(nonRaw(events)).toEqual([{ kind: 'done', reply: '', exitCode: null }])
  })

  it.each([
    ['thought', thought('I will read README.md.')],
    ['available_commands', availableCommands()],
    ['plan', line({ type: 'plan', entries: [{ content: 'Read README.md', status: 'pending' }] })],
  ])('emits only raw when the line type is %s, which rensa does not read', async (_, unknown) => {
    const events = await parseAll([unknown, end()])

    expect(events).toEqual([
      { kind: 'raw', line: unknown },
      { kind: 'raw', line: end() },
      { kind: 'done', reply: '', exitCode: null },
    ])
  })
})

describe('streaming and finished text', () => {
  it('emits a delta per chunk and one text record when a usage line ends the block', async () => {
    const events = await parseAll([text('Hel'), text('lo, Alice.'), usage(FIRST_RESPONSE)])

    expect(nonRaw(events).slice(0, 3)).toEqual([
      { kind: 'delta', text: 'Hel' },
      { kind: 'delta', text: 'lo, Alice.' },
      { kind: 'text', text: 'Hello, Alice.' },
    ])
  })

  it('emits no delta and no text record when a text chunk is empty', async () => {
    const events = await parseAll([text(''), end()])

    expect(nonRaw(events)).toEqual([{ kind: 'done', reply: '', exitCode: null }])
  })

  it('ends the text block when a tool call starts', async () => {
    const events = await parseAll([
      text('Reading README.md.'),
      toolCall(CALL_README, 'read_file', { target_file: '/Users/alice/code/shop/README.md' }),
    ])

    expect(nonRaw(events).slice(0, 2)).toEqual([
      { kind: 'delta', text: 'Reading README.md.' },
      { kind: 'text', text: 'Reading README.md.' },
    ])
  })

  it('ends the text block when the input ends without an end line', async () => {
    const events = await parseAll([text('Partial answer')])

    expect(nonRaw(events).slice(0, 2)).toEqual([
      { kind: 'delta', text: 'Partial answer' },
      { kind: 'text', text: 'Partial answer' },
    ])
  })
})

describe('tool calls', () => {
  const readmeInput = { target_file: '/Users/alice/code/shop/README.md' }

  it('emits one tool record ok true with the content text when an update reports completed', async () => {
    const events = await parseAll([
      toolCall(CALL_README, 'read_file', readmeInput),
      toolUpdate(CALL_README, null),
      toolUpdate(CALL_README, 'completed', [contentText('1→# shop\n')]),
      end(),
    ])

    expect(nonRaw(events).slice(0, -1)).toEqual([
      { kind: 'tool', name: 'read_file', input: readmeInput, ok: true, output: '1→# shop\n' },
    ])
  })

  it('emits one tool record ok false when an update reports failed', async () => {
    const message = 'Error: /Users/alice/code/shop/MISSING.md does not exist.'

    const events = await parseAll([
      toolCall(CALL_MISSING, 'read_file', { target_file: '/Users/alice/code/shop/MISSING.md' }),
      toolUpdate(CALL_MISSING, 'failed', [contentText(message)], {
        type: 'ReadFile',
        FileNotFound: message,
      }),
      end(),
    ])

    expect(nonRaw(events).slice(0, -1)).toEqual([
      {
        kind: 'tool',
        name: 'read_file',
        input: { target_file: '/Users/alice/code/shop/MISSING.md' },
        ok: false,
        output: message,
      },
    ])
  })

  it('emits nothing for a tool call when its only update has a null status', async () => {
    const events = await parseAll([
      toolCall(CALL_README, 'read_file', readmeInput),
      toolUpdate(CALL_README, null),
      end(),
    ])

    expect(nonRaw(events).map((e) => e.kind)).toEqual(['done'])
  })

  it('pairs each update with its own call when two calls finish out of order', async () => {
    const missingInput = { target_file: '/Users/alice/code/shop/MISSING.md' }

    const events = await parseAll([
      toolCall(CALL_README, 'read_file', readmeInput),
      toolCall(CALL_MISSING, 'read_file', missingInput),
      toolUpdate(CALL_MISSING, 'failed', [contentText('does not exist')]),
      toolUpdate(CALL_README, 'completed', [contentText('# shop')]),
    ])

    expect(nonRaw(events).slice(0, -1)).toEqual([
      { kind: 'tool', name: 'read_file', input: missingInput, ok: false, output: 'does not exist' },
      { kind: 'tool', name: 'read_file', input: readmeInput, ok: true, output: '# shop' },
    ])
  })

  it('takes the output from rawOutput when a completed update has empty content', async () => {
    const listing = '- /Users/alice/code/shop/\n  - README.md\n  - package.json\n'

    const events = await parseAll([
      toolCall(CALL_README, 'list_dir', { target_directory: '/Users/alice/code/shop' }),
      toolUpdate(CALL_README, 'completed', [], { type: 'ListDir', Content: { content: listing } }),
    ])

    expect(nonRaw(events)[0]).toMatchObject({
      kind: 'tool',
      name: 'list_dir',
      ok: true,
      output: listing,
    })
  })

  it('emits the tool record from the first line when a tool call arrives already completed', async () => {
    const events = await parseAll([
      line({
        type: 'tool_call',
        toolCallId: CALL_README,
        toolName: 'grep',
        status: 'completed',
        rawInput: { pattern: 'TODO' },
        content: [contentText('src/cart/total.ts:12: // TODO')],
      }),
    ])

    expect(nonRaw(events).slice(0, -1)).toEqual([
      {
        kind: 'tool',
        name: 'grep',
        input: { pattern: 'TODO' },
        ok: true,
        output: 'src/cart/total.ts:12: // TODO',
      },
    ])
  })

  it('keeps the first 4096 bytes of the output when a tool result is larger than 4 KB', async () => {
    const big = 'abcdefghij'.repeat(1000)

    const events = await parseAll([
      toolCall(CALL_README, 'read_file', readmeInput),
      toolUpdate(CALL_README, 'completed', [contentText(big)]),
    ])

    const tool = nonRaw(events)[0]
    if (tool?.kind !== 'tool') throw new Error(`expected a tool record, got ${tool?.kind}`)
    expect(tool.output.startsWith(big.slice(0, 4096))).toBe(true)
    expect(tool.output).not.toContain(big.slice(0, 4097))
  })

  it('keeps an output of exactly 4096 bytes whole when a tool result is at the cap', async () => {
    const atCap = 'x'.repeat(4096)

    const events = await parseAll([
      toolCall(CALL_README, 'read_file', readmeInput),
      toolUpdate(CALL_README, 'completed', [contentText(atCap)]),
    ])

    expect(nonRaw(events)[0]).toMatchObject({ kind: 'tool', output: atCap })
  })
})

describe('usage events', () => {
  it('emits the running totals with the latest response context when each usage line arrives', async () => {
    const events = await parseAll([usage(FIRST_RESPONSE), usage(SECOND_RESPONSE)])

    const usages = events.flatMap((e) => (e.kind === 'usage' ? [e.usage] : []))
    const expected: Usage[] = [
      { input: 5259, output: 132, cache_read: 3840, context: 5259 + 3840 },
      { input: 5259 + 915, output: 132 + 294, cache_read: 3840 + 9088, context: 915 + 9088 + 120 },
    ]
    expect(usages).toEqual(expected)
  })
})

describe('the done event from the end line', () => {
  it('takes the reply from the last response that had text when a later response has none', async () => {
    const events = await parseAll([
      text("I'll read README.md."),
      usage(FIRST_RESPONSE),
      toolCall(CALL_README, 'read_file', { target_file: '/Users/alice/code/shop/README.md' }),
      toolUpdate(CALL_README, 'completed', [contentText('# shop')]),
      text('The README is a single heading.'),
      usage(SECOND_RESPONSE),
      end(),
    ])

    expect(doneOf(events).reply).toBe('The README is a single heading.')
  })

  it('keeps the earlier reply when the final response streamed no text', async () => {
    const events = await parseAll([
      text('The README is a single heading.'),
      usage(FIRST_RESPONSE),
      usage(SECOND_RESPONSE),
      end(),
    ])

    expect(doneOf(events).reply).toBe('The README is a single heading.')
  })

  it('takes usage from the end line with the context of the last response when end carries usage', async () => {
    const turn: GrokUsageLine = {
      input_tokens: 6174,
      output_tokens: 426,
      cache_read_input_tokens: 12_928,
      cache_creation_input_tokens: 0,
    }

    const events = await parseAll([
      usage(FIRST_RESPONSE),
      usage(SECOND_RESPONSE),
      end('end_turn', turn),
    ])

    expect(doneOf(events)).toEqual({
      kind: 'done',
      reply: '',
      exitCode: null,
      usage: { input: 6174, output: 426, cache_read: 12_928, context: 915 + 9088 + 120 },
    })
  })

  it('falls back to the accumulated usage when the end line carries none', async () => {
    const events = await parseAll([usage(FIRST_RESPONSE), usage(SECOND_RESPONSE), end()])

    expect(doneOf(events).usage).toEqual({
      input: 5259 + 915,
      output: 132 + 294,
      cache_read: 3840 + 9088,
      context: 915 + 9088 + 120,
    })
  })

  it('leaves usage out when neither the end line nor any usage line carried any', async () => {
    const events = await parseAll([text('Hi.'), end()])

    expect(doneOf(events)).toEqual({ kind: 'done', reply: 'Hi.', exitCode: null })
  })

  it('reports no error when the stop reason is end_turn', async () => {
    const events = await parseAll([text('Done.'), end('end_turn')])

    expect(doneOf(events)).not.toHaveProperty('error')
  })

  it.each(['max_tokens', 'max_turn_requests', 'refusal', 'cancelled'])(
    'reports an exit error naming the reason when the stop reason is %s',
    async (stopReason) => {
      const events = await parseAll([text('Partial review'), end(stopReason)])

      expect(doneOf(events)).toEqual({
        kind: 'done',
        reply: 'Partial review',
        exitCode: null,
        error: { kind: 'exit', message: `grok stopped the turn: ${stopReason}` },
      })
    },
  )

  it('emits exactly one done, last, when lines follow the end line', async () => {
    const events = await parseAll([end(), availableCommands()])

    expect(events.map((e) => e.kind)).toEqual(['raw', 'raw', 'done'])
  })

  it('sets no sessionId when the end line carries a session id', async () => {
    const events = await parseAll([end()])

    expect(doneOf(events)).not.toHaveProperty('sessionId')
  })
})

describe('the done event from an error line', () => {
  it('reports auth with the message when the error line is the observed not-signed-in message', async () => {
    const events = await parseAll([errorLine(NOT_SIGNED_IN)])

    expect(events).toEqual([
      { kind: 'raw', line: errorLine(NOT_SIGNED_IN) },
      { kind: 'done', reply: '', exitCode: null, error: { kind: 'auth', message: NOT_SIGNED_IN } },
    ])
  })

  it('reports exit with the message when the error line reads as neither auth nor a usage limit', async () => {
    const message = 'Unknown model: grok-9-preview'

    const events = await parseAll([errorLine(message)])

    expect(doneOf(events).error).toEqual({ kind: 'exit', message })
  })

  it('prefers the error line usage over the accumulated totals when the error line carries usage', async () => {
    const spend: GrokUsageLine = {
      input_tokens: 9000,
      output_tokens: 700,
      cache_read_input_tokens: 4000,
    }

    const events = await parseAll([
      text('Looking at the diff.'),
      usage(FIRST_RESPONSE),
      errorLine('stream closed unexpectedly', spend),
    ])

    expect(doneOf(events)).toEqual({
      kind: 'done',
      reply: 'Looking at the diff.',
      exitCode: null,
      usage: { input: 9000, output: 700, cache_read: 4000, context: 5259 + 3840 },
      error: { kind: 'exit', message: 'stream closed unexpectedly' },
    })
  })

  it('reports the accumulated usage when the error line carries none', async () => {
    const events = await parseAll([usage(FIRST_RESPONSE), errorLine('stream closed unexpectedly')])

    expect(doneOf(events).usage).toEqual({
      input: 5259,
      output: 132,
      cache_read: 3840,
      context: 5259 + 3840,
    })
  })

  it('ends a streaming text block as a record when an error line arrives', async () => {
    const events = await parseAll([text('Half an answ'), errorLine('stream closed unexpectedly')])

    expect(nonRaw(events).slice(0, 2)).toEqual([
      { kind: 'delta', text: 'Half an answ' },
      { kind: 'text', text: 'Half an answ' },
    ])
  })
})

describe('a stream with no completion evidence', () => {
  it('reports no_output with an empty reply when the stream has text but no end or error line', async () => {
    const events = await parseAll([availableCommands(), text('Hel'), usage(FIRST_RESPONSE)])

    expect(doneOf(events)).toEqual({
      kind: 'done',
      reply: '',
      exitCode: null,
      error: { kind: 'no_output', message: expect.any(String) },
    })
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

describe('classifying grok error messages', () => {
  it.each([
    ['Usage limit reached for your SuperGrok plan', 'usage_limit'],
    ['Rate limit exceeded, try again in 30 seconds', 'usage_limit'],
    ["You've hit your weekly limit · resets Nov 9, 5pm", 'usage_limit'],
    ['Your limit resets at 3pm (Europe/Prague)', 'usage_limit'],
    [NOT_SIGNED_IN, 'auth'],
    ['Error: Not signed in.', 'auth'],
    ['Your session has expired, please sign in again', 'auth'],
    ['401 Unauthorized', 'auth'],
    ['Unknown model: grok-9-preview', undefined],
    ['effort `max` is not supported by this model', undefined],
  ] as const)('classifies "%s" as %s', (message, kind) => {
    expect(classifyText(message)).toBe(kind)
  })

  it('reports usage_limit when a message reads as both a usage limit and a login problem', () => {
    expect(classifyText('Usage limit reached. Run grok login to switch accounts.')).toBe(
      'usage_limit',
    )
  })
})
