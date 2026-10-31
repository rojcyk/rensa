import { EventEmitter } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import { AppendQueue, isRecord, parseJsonLines } from './jsonl.js'
import type { EventBase, NewRunEvent, RunEvent } from './types.js'

/**
 * The single writer of a run's `events.jsonl`. `append` stamps the event,
 * queues its line, and emits it as `'event'` before returning it.
 */
export class EventLog extends EventEmitter<{ event: [RunEvent] }> {
  private seq = 0

  private constructor(private readonly queue: AppendQueue) {
    super()
  }

  /** Creates the file; fails if it exists, since a run has one writer. */
  static async create(file: string): Promise<EventLog> {
    await writeFile(file, '', { flag: 'wx' })
    return new EventLog(new AppendQueue(file))
  }

  append(e: NewRunEvent): RunEvent {
    this.seq += 1
    const event: RunEvent = { seq: this.seq, t: new Date().toISOString(), ...e }
    this.queue.push(JSON.stringify(event))
    this.emit('event', event)
    return event
  }

  /** Resolves when every appended line is on disk; rejects on a failed write. */
  flush(): Promise<void> {
    return this.queue.flush()
  }

  /** Flushes, then refuses further appends. */
  close(): Promise<void> {
    return this.queue.close()
  }
}

export interface ReadEvents {
  events: RunEvent[]
  /** One per skipped line. */
  warnings: string[]
}

/**
 * Reads `events.jsonl`, skipping lines that are not events. Only the
 * common fields are checked: an event whose `type` this version does not
 * know is passed through untouched, so consumers need a default branch.
 */
export async function readEvents(file: string): Promise<ReadEvents> {
  const { values, warnings } = parseJsonLines(await readFile(file, 'utf8'))
  const events: RunEvent[] = []
  for (const { line, value } of values) {
    if (isRecord(value) && hasEventBase(value)) {
      // Base fields checked above; `data` is unchecked: unknown types pass through.
      events.push(value as unknown as RunEvent)
    } else {
      warnings.push(`line ${line}: not an event`)
    }
  }
  return { events, warnings }
}

function hasEventBase(
  value: Record<string, unknown>,
): value is Record<string, unknown> & EventBase & { type: string } {
  return (
    typeof value.seq === 'number' &&
    typeof value.t === 'string' &&
    typeof value.type === 'string' &&
    (value.step === undefined || typeof value.step === 'string') &&
    (value.agent === undefined || typeof value.agent === 'string')
  )
}
