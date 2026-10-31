import { mkdir, readFile, writeFile } from 'node:fs/promises'
import type { AgentFileName, RunDir } from './dir.js'
import { AppendQueue, isRecord, parseJsonLines } from './jsonl.js'
import type { NewTranscriptRecord, TranscriptRecord } from './types.js'

/**
 * Writes one agent's files under `agents/<step>/<label>/`: the provider's
 * raw lines, the normalized transcript, the prompt, and the reply. The
 * directory is created on the first write.
 */
export class TranscriptWriter {
  private readonly rawQueue: AppendQueue
  private readonly transcriptQueue: AppendQueue
  private made: Promise<unknown> | undefined

  constructor(
    private readonly dir: RunDir,
    private readonly stepId: string,
    private readonly label: string,
  ) {
    const ensure = () => this.ensureDir()
    this.rawQueue = new AppendQueue(this.file('raw.jsonl'), ensure)
    this.transcriptQueue = new AppendQueue(this.file('transcript.jsonl'), ensure)
  }

  /** Appends a provider output line to `raw.jsonl` as received. */
  raw(line: string): void {
    this.rawQueue.push(line)
  }

  /** Stamps the record, queues it for `transcript.jsonl`, and returns it. */
  record(r: NewTranscriptRecord): TranscriptRecord {
    const stamped: TranscriptRecord = { t: new Date().toISOString(), ...r }
    this.transcriptQueue.push(JSON.stringify(stamped))
    return stamped
  }

  async prompt(text: string): Promise<void> {
    await this.ensureDir()
    await writeFile(this.file('prompt.md'), text)
  }

  async reply(text: string): Promise<void> {
    await this.ensureDir()
    await writeFile(this.file('reply.md'), text)
  }

  /** Flushes both queues, then refuses further lines. */
  async close(): Promise<void> {
    await Promise.all([this.rawQueue.close(), this.transcriptQueue.close()])
  }

  private file(name: AgentFileName): string {
    return this.dir.agentFile(this.stepId, this.label, name)
  }

  private async ensureDir(): Promise<void> {
    this.made ??= mkdir(this.dir.agentDir(this.stepId, this.label), { recursive: true })
    await this.made
  }
}

/**
 * Reads `transcript.jsonl`, skipping lines that are not records, such as
 * a final line still being written.
 */
export async function readTranscript(file: string): Promise<TranscriptRecord[]> {
  const records: TranscriptRecord[] = []
  for (const { value } of parseJsonLines(await readFile(file, 'utf8')).values) {
    if (isRecord(value) && typeof value.t === 'string' && typeof value.kind === 'string') {
      // Common fields checked above; the rest is trusted as the writer's.
      records.push(value as TranscriptRecord)
    }
  }
  return records
}
