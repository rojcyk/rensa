import { type Mock, vi } from 'vitest'
import {
  RingBuffer,
  type RunEvent,
  type RunHandle,
  type RunListeners,
  type RunResult,
  type TranscriptRecord,
} from '../engine/index.js'
import type { KnownRunEvent, NewTranscriptRecord } from '../engine/run/types.js'

// A `RunHandle` a UI test scripts by hand: events, transcript records,
// streaming deltas and the final result are delivered to attached
// listeners the way the runner delivers them (history or buffer first,
// then the listener). The commands are spies.

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** An event as a test writes it; the script assigns `seq`. */
export type ScriptEvent = DistributiveOmit<KnownRunEvent, 'seq'>

export interface ScriptedRun {
  handle: RunHandle & {
    pause: Mock<() => void>
    resume: Mock<() => void>
    kill: Mock<() => void>
    abort: Mock<() => void>
    note: Mock<(text: string) => void>
  }
  /** Appends to the history, then tells the listeners. */
  event(event: ScriptEvent): void
  /** Pushes to the buffer, clears the key's partial, then tells the listeners. */
  record(step: string, label: string, record: NewTranscriptRecord, t?: string): void
  /** Appends to the key's partial, then tells the listeners. */
  delta(step: string, label: string, text: string): void
  /** Records without telling anyone: what a buffer held before a view attached. */
  seed(step: string, label: string, records: ReadonlyArray<TranscriptRecord>): void
  finish(result: RunResult): void
  /** Listeners attached and not yet detached. */
  attached(): number
}

export function scriptedRun(opts: {
  id: string
  dir: string
  history?: ReadonlyArray<ScriptEvent | RunEvent>
  result?: RunResult
  capacity?: number
}): ScriptedRun {
  const events: RunEvent[] = []
  for (const e of opts.history ?? []) events.push({ ...e, seq: events.length + 1 } as RunEvent)
  let result = opts.result
  const listeners = new Set<RunListeners>()
  const buffers = new Map<string, RingBuffer<TranscriptRecord>>()
  const partials = new Map<string, string>()
  const keyOf = (step: string, label: string) => `${step}/${label}`
  const buffer = (step: string, label: string) => {
    const key = keyOf(step, label)
    let b = buffers.get(key)
    if (b === undefined) {
      b = new RingBuffer<TranscriptRecord>(opts.capacity ?? 5000)
      buffers.set(key, b)
    }
    return b
  }
  let done: (r: RunResult) => void = () => {}
  const handle: ScriptedRun['handle'] = {
    id: opts.id,
    dir: opts.dir,
    pause: vi.fn<() => void>(),
    resume: vi.fn<() => void>(),
    kill: vi.fn<() => void>(),
    abort: vi.fn<() => void>(),
    note: vi.fn<(text: string) => void>(),
    done: new Promise<RunResult>((resolve) => {
      done = resolve
      if (result !== undefined) resolve(result)
    }),
    result: () => result,
    transcript: buffer,
    partial: (step, label) => partials.get(keyOf(step, label)),
    events: () => events.slice(),
    attach(l) {
      listeners.add(l)
      return {
        events: events.slice(),
        ...(result !== undefined && { result }),
        detach: () => listeners.delete(l),
      }
    },
  }
  return {
    handle,
    event(e) {
      const event = { ...e, seq: events.length + 1 } as RunEvent
      events.push(event)
      for (const l of listeners) l.event?.(event)
    },
    record(step, label, r, t = new Date().toISOString()) {
      const record = { t, ...r } as TranscriptRecord
      buffer(step, label).push(record)
      partials.delete(keyOf(step, label))
      for (const l of listeners) l.transcript?.({ step, label, record })
    },
    delta(step, label, text) {
      const key = keyOf(step, label)
      partials.set(key, (partials.get(key) ?? '') + text)
      for (const l of listeners) l.delta?.({ step, label, text })
    },
    seed(step, label, records) {
      for (const r of records) buffer(step, label).push(r)
    },
    finish(r) {
      result = r
      for (const l of listeners) l.finished?.(r)
      done(r)
    },
    attached: () => listeners.size,
  }
}
