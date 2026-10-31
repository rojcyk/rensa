import { EventEmitter } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import { AppendQueue, inLineOrder, parseJsonLines } from './jsonl.js'
import { type KnownRunEvent, type NewRunEvent, type RunEvent, RunEventSchema } from './types.js'

/**
 * The single writer of a run's `events.jsonl`. `append` stamps the event,
 * queues its line, and emits it as `'event'` before returning it.
 */
export class EventLog extends EventEmitter<{ event: [KnownRunEvent] }> {
  private seq = 0

  private constructor(private readonly queue: AppendQueue) {
    super()
  }

  /** Creates the file; fails if it exists, since a run has one writer. */
  static async create(file: string): Promise<EventLog> {
    await writeFile(file, '', { flag: 'wx' })
    return new EventLog(new AppendQueue(file))
  }

  append(e: NewRunEvent): KnownRunEvent {
    this.seq += 1
    const event: KnownRunEvent = { seq: this.seq, t: new Date().toISOString(), ...e }
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
 * Reads `events.jsonl`, skipping lines that are not events, with a
 * warning each. A known `type` is checked in full; an event whose `type`
 * this version does not know is passed through untouched, so consumers
 * need a default branch.
 */
export async function readEvents(file: string): Promise<ReadEvents> {
  const { values, warnings } = parseJsonLines(await readFile(file, 'utf8'))
  const events: RunEvent[] = []
  for (const { line, value } of values) {
    const result = RunEventSchema.safeParse(value)
    if (result.success) events.push(result.data)
    else warnings.push(`line ${line}: not an event`)
  }
  return { events, warnings: inLineOrder(warnings) }
}
