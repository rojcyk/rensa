import { mkdir } from 'node:fs/promises'
import path from 'node:path'

export type AgentFileName = 'prompt.md' | 'transcript.jsonl' | 'raw.jsonl' | 'reply.md'

/** Paths inside one run's directory. Computing a path creates nothing. */
export interface RunDir {
  /** `<repo>/.rensa/runs/<id>` */
  root: string
  runJson: string
  events: string
  /** `steps/<id>/output.txt` */
  stepOutput(stepId: string): string
  /** `agents/<step>/<label>` */
  agentDir(stepId: string, label: string): string
  agentFile(stepId: string, label: string, name: AgentFileName): string
}

/**
 * Creates the run directory with empty `steps/` and `agents/`. Fails if
 * the run directory already exists, so two runs never share one.
 */
export async function createRunDir(runsDir: string, id: string): Promise<RunDir> {
  const dir = openRunDir(runsDir, id)
  await mkdir(runsDir, { recursive: true })
  await mkdir(dir.root)
  await Promise.all([mkdir(path.join(dir.root, 'steps')), mkdir(path.join(dir.root, 'agents'))])
  return dir
}

export function openRunDir(runsDir: string, id: string): RunDir {
  const root = path.join(runsDir, id)
  const agentDir = (stepId: string, label: string) => path.join(root, 'agents', stepId, label)
  return {
    root,
    runJson: path.join(root, 'run.json'),
    events: path.join(root, 'events.jsonl'),
    stepOutput: (stepId) => path.join(root, 'steps', stepId, 'output.txt'),
    agentDir,
    agentFile: (stepId, label, name) => path.join(agentDir(stepId, label), name),
  }
}
