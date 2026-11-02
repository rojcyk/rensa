import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type DiagEntry, diag, drainDiag, onDiag } from './diag.js'

// The buffer and listener set are module state shared by every test in
// this file; each test starts from an empty buffer.
beforeEach(() => {
  drainDiag()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('recording a diagnostic', () => {
  it('stamps the entry with the current time as ISO 8601 alongside its scope and message', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-02T09:14:07.250Z'))

    diag('claude', 'claude --version exited 127')

    const expected: DiagEntry[] = [
      { t: '2026-11-02T09:14:07.250Z', scope: 'claude', message: 'claude --version exited 127' },
    ]
    expect(drainDiag()).toEqual(expected)
  })

  it('writes nothing to stdout, stderr or the console when called', () => {
    const stdout = vi.spyOn(process.stdout, 'write')
    const stderr = vi.spyOn(process.stderr, 'write')
    const consoleMethods = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method),
    )

    diag('fake', 'ignoring RENSA_FAKE_DELAY_MS=soon')

    expect(stdout).not.toHaveBeenCalled()
    expect(stderr).not.toHaveBeenCalled()
    for (const spy of consoleMethods) expect(spy).not.toHaveBeenCalled()
  })
})

describe('listening for diagnostics', () => {
  it('hands every later entry to each listener as it is recorded', () => {
    const first: DiagEntry[] = []
    const second: DiagEntry[] = []
    const offFirst = onDiag((entry) => first.push(entry))
    const offSecond = onDiag((entry) => second.push(entry))

    diag('grok', 'grok not found on PATH')
    diag('codex', 'codex login status: not logged in')
    offFirst()
    offSecond()

    const messages = ['grok not found on PATH', 'codex login status: not logged in']
    expect(first.map((e) => e.message)).toEqual(messages)
    expect(second.map((e) => e.message)).toEqual(messages)
  })

  it('stops calling a listener once its unsubscribe function has run', () => {
    const received: string[] = []
    const off = onDiag((entry) => received.push(entry.message))

    diag('claude', 'before unsubscribe')
    off()
    diag('claude', 'after unsubscribe')

    expect(received).toEqual(['before unsubscribe'])
  })

  it('keeps notifying the other listeners and records the failure when a listener throws', () => {
    const received: string[] = []
    const offThrowing = onDiag(() => {
      throw new Error('stderr closed')
    })
    const offRecording = onDiag((entry) => received.push(entry.message))

    try {
      expect(() => diag('grok', 'grok not found on PATH')).not.toThrow()
    } finally {
      offThrowing()
      offRecording()
    }

    expect(received).toEqual(['grok not found on PATH'])
    expect(drainDiag().map((e) => [e.scope, e.message])).toEqual([
      ['grok', 'grok not found on PATH'],
      ['diag', 'listener threw on a grok entry: stderr closed'],
    ])
  })

  it('does not replay entries recorded before the listener subscribed', () => {
    diag('claude', 'recorded earlier')
    const received: string[] = []

    const off = onDiag((entry) => received.push(entry.message))
    off()

    expect(received).toEqual([])
  })
})

describe('draining the buffer', () => {
  it('returns entries oldest first and leaves the buffer empty when drained', () => {
    diag('claude', 'first')
    diag('fake', 'second')
    diag('grok', 'third')

    const drained = drainDiag()

    expect(drained.map((e) => [e.scope, e.message])).toEqual([
      ['claude', 'first'],
      ['fake', 'second'],
      ['grok', 'third'],
    ])
    expect(drainDiag()).toEqual([])
  })

  it('keeps only the newest 200 entries when more than 200 are recorded', () => {
    for (let i = 1; i <= 205; i++) diag('fake', `entry ${i}`)

    const messages = drainDiag().map((e) => e.message)

    expect(messages).toEqual(Array.from({ length: 200 }, (_, i) => `entry ${i + 6}`))
  })
})
