import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  applyEvent,
  applyResult,
  openRunDir,
  type ResolvedChain,
  RingBuffer,
  type RunDir,
  type RunEvent,
  type RunHandle,
  type RunProgress,
  type RunResult,
  readEvents,
  readRunJson,
  readTranscript,
  reduceRun,
  reduceSteps,
  type StepView,
  type TranscriptRecord,
} from '../engine/index.js'
import { type Batcher, createBatcher } from './batch.js'
import { createStore, type Store } from './store.js'

// Translates one run's streams into a store. Holds no interpretation
// logic (state comes from the engine's reducers) and no transcript
// content (the engine's ring buffers hold it); what the batcher defers is
// only the store update.

export interface RunState {
  /** Status, current step, pause point, failed step, timestamps. */
  progress: RunProgress
  steps: Map<string, StepView>
  /**
   * `${step}/${label}` → a counter bumped whenever the key gets a record, a
   * delta, or any run event carrying that step and agent.
   */
  transcriptVersions: Map<string, number>
}

export type ChainStepRef = { id: string; kind: 'agent' | 'shell' }

/** The `transcriptVersions` key for one agent (or `shell`) of one step. */
export function transcriptKey(step: string, label: string): string {
  return `${step}/${label}`
}

/**
 * What a `RunView` reads a run from: a live `RunHandle`, or a finished
 * run read back from its directory (`loadRunDir`). Both seed the view
 * through `attach`, so the two paths share the seeding code.
 */
export type RunSource = Pick<RunHandle, 'id' | 'dir' | 'attach' | 'transcript' | 'partial'>

/** Records per transcript kept for a run read from disk; the engine keeps as many for a live one. */
export const DISK_TRANSCRIPT_CAPACITY = 5000

type Arrival =
  | { kind: 'event'; event: RunEvent }
  | { kind: 'transcript'; key: string }
  | { kind: 'delta'; key: string }
  | { kind: 'finished'; result: RunResult }

/**
 * One run screen's view of one handle. Seeds its store from the handle's
 * history in the constructor, then follows the handle's streams through
 * a one-frame batcher. `dispose()` detaches; a new `RunView` on the same
 * handle rebuilds the same state from its history and buffers.
 */
export class RunView {
  readonly store: Store<RunState>
  /** Every event so far, in order; append-only and outside the store. */
  readonly events: RunEvent[]

  private readonly batcher: Batcher<Arrival>
  private readonly detach: () => void
  /** The run's terminal state once known; merged over every recomputed progress. */
  private result: RunResult | undefined

  constructor(
    private readonly handle: RunSource,
    chainSteps: ReadonlyArray<ChainStepRef>,
  ) {
    this.batcher = createBatcher<Arrival>((items) => this.flush(items))
    // Snapshot and subscription in one synchronous step: no event is
    // missed or seen twice.
    const snapshot = handle.attach({
      event: (event) => {
        this.events.push(event)
        this.batcher.push({ kind: 'event', event })
      },
      transcript: (m) =>
        this.batcher.push({ kind: 'transcript', key: transcriptKey(m.step, m.label) }),
      delta: (m) => this.batcher.push({ kind: 'delta', key: transcriptKey(m.step, m.label) }),
      finished: (result) => this.batcher.push({ kind: 'finished', result }),
    })
    this.detach = snapshot.detach
    this.events = [...snapshot.events]
    this.result = snapshot.result

    const steps = reduceSteps(this.events, chainSteps)
    this.store = createStore<RunState>({
      progress: this.progressNow(),
      steps,
      transcriptVersions: this.seedVersions(steps),
    })
  }

  /** The run id. */
  get id(): string {
    return this.handle.id
  }

  /** `agents/<step>/<label>` inside the run directory. */
  agentDir(step: string, label: string): string {
    const root = this.handle.dir
    return openRunDir(path.dirname(root), path.basename(root)).agentDir(step, label)
  }

  /** The engine-owned buffer for the key. */
  transcript(step: string, label: string): RingBuffer<TranscriptRecord> {
    return this.handle.transcript(step, label)
  }

  partial(step: string, label: string): string | undefined {
    return this.handle.partial(step, label)
  }

  /** Detaches from the handle and flushes what is pending; the handle keeps running. */
  dispose(): void {
    this.detach()
    this.batcher.dispose()
  }

  /** One `setState` for the whole batch; the same state when nothing changed. */
  private flush(items: Arrival[]): void {
    for (const item of items) if (item.kind === 'finished') this.result = item.result
    this.store.setState((prev) => {
      let steps = prev.steps
      const touched = new Set<string>()
      for (const item of items) {
        switch (item.kind) {
          case 'event':
            steps = applyEvent(steps, item.event)
            // The engine drops an agent's partial without a delta; the
            // agent's own events (its end among them) make the pane re-read it.
            if (item.event.step !== undefined && item.event.agent !== undefined) {
              touched.add(transcriptKey(item.event.step, item.event.agent))
            }
            break
          case 'transcript':
          case 'delta':
            touched.add(item.key)
            break
          case 'finished':
            // Taken above; it reaches `progress` through progressNow().
            break
          default:
            return exhaustive(item)
        }
      }

      const computed = this.progressNow()
      const progress = isDeepStrictEqual(computed, prev.progress) ? prev.progress : computed

      let transcriptVersions = prev.transcriptVersions
      if (touched.size > 0) {
        transcriptVersions = new Map(transcriptVersions)
        for (const key of touched) {
          transcriptVersions.set(key, (transcriptVersions.get(key) ?? 0) + 1)
        }
      }

      if (
        steps === prev.steps &&
        progress === prev.progress &&
        transcriptVersions === prev.transcriptVersions
      ) {
        return prev
      }
      return { progress, steps, transcriptVersions }
    })
  }

  private progressNow(): RunProgress {
    const progress = reduceRun(this.events)
    return this.result ? applyResult(progress, this.result) : progress
  }

  /**
   * `1 + buffer length` for every transcript the history mentions: the
   * agent each started step spawned, and `shell` for each started shell
   * step. Read from the step views, so nothing here looks at event types.
   */
  private seedVersions(steps: ReadonlyMap<string, StepView>): Map<string, number> {
    const versions = new Map<string, number>()
    for (const view of steps.values()) {
      const label =
        view.agent?.label ??
        (view.kind === 'shell' && view.startedAt !== undefined ? 'shell' : undefined)
      if (label === undefined) continue
      versions.set(transcriptKey(view.id, label), 1 + this.handle.transcript(view.id, label).length)
    }
    return versions
  }
}

/**
 * A finished run read back from its directory, as a `RunSource`: the
 * events from `events.jsonl`, and one `RingBuffer` per transcript the
 * events mention, filled from its `transcript.jsonl`. Lines that do not
 * parse are skipped (a crashed writer may leave a partial last line), and
 * a transcript file that cannot be read is an empty transcript, so a
 * damaged run still shows. `attach` returns no result: a run that ended
 * on a storage failure has no `run.finished` on disk and reads as running.
 */
export async function loadRunDir(
  dir: RunDir,
): Promise<{ source: RunSource; chain: ResolvedChain; warnings: string[] }> {
  const [runJson, { events, warnings }] = await Promise.all([
    readRunJson(dir.runJson),
    readEvents(dir.events),
  ])
  const chain = runJson.chain
  const buffers = new Map<string, RingBuffer<TranscriptRecord>>()
  const bufferFor = (step: string, label: string) => {
    const key = transcriptKey(step, label)
    let buffer = buffers.get(key)
    if (buffer === undefined) {
      buffer = new RingBuffer<TranscriptRecord>(DISK_TRANSCRIPT_CAPACITY)
      buffers.set(key, buffer)
    }
    return buffer
  }

  const keys: { step: string; label: string }[] = []
  for (const view of reduceSteps(events, chain.steps).values()) {
    const label =
      view.agent?.label ??
      (view.kind === 'shell' && view.startedAt !== undefined ? 'shell' : undefined)
    if (label !== undefined) keys.push({ step: view.id, label })
  }
  await Promise.all(
    keys.map(async ({ step, label }) => {
      const buffer = bufferFor(step, label)
      try {
        const { records } = await readTranscript(dir.agentFile(step, label, 'transcript.jsonl'))
        for (const record of records) buffer.push(record)
      } catch {
        // No transcript on disk (never written, or removed): an empty one.
      }
    }),
  )

  const source: RunSource = {
    id: runJson.id,
    dir: dir.root,
    attach: () => ({ events, detach: () => {} }),
    transcript: bufferFor,
    partial: () => undefined,
  }
  return { source, chain, warnings }
}

function exhaustive(value: never): never {
  throw new Error(`unhandled arrival: ${JSON.stringify(value)}`)
}
