import { mkdir, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type TmpDir, tmpDir } from '../../testing/tmpRepo.js'
import { createRunDir, openRunDir } from './dir.js'

const RUN_ID = '2026-10-28_0912_tdd-review_7f3a'

let tmp: TmpDir
let runsDir: string

beforeEach(async () => {
  tmp = await tmpDir('rensa-rundir-')
  runsDir = path.join(tmp.dir, '.rensa', 'runs')
})

afterEach(async () => {
  await tmp.cleanup()
})

describe('creating a run directory', () => {
  it('creates the runs dir, the run root and empty steps/ and agents/ when nothing exists yet', async () => {
    const dir = await createRunDir(runsDir, RUN_ID)

    expect(dir.root).toBe(path.join(runsDir, RUN_ID))
    expect((await readdir(dir.root)).sort()).toEqual(['agents', 'steps'])
    expect(await readdir(path.join(dir.root, 'steps'))).toEqual([])
    expect(await readdir(path.join(dir.root, 'agents'))).toEqual([])
  })

  it('creates a second run beside the first when the runs dir already exists', async () => {
    await createRunDir(runsDir, RUN_ID)

    await createRunDir(runsDir, '2026-10-28_0912_tdd-review_b41c')

    expect((await readdir(runsDir)).sort()).toEqual([
      '2026-10-28_0912_tdd-review_7f3a',
      '2026-10-28_0912_tdd-review_b41c',
    ])
  })

  it('rejects with EEXIST when the run directory already exists', async () => {
    await mkdir(path.join(runsDir, RUN_ID), { recursive: true })

    await expect(createRunDir(runsDir, RUN_ID)).rejects.toMatchObject({ code: 'EEXIST' })
  })
})

describe('run directory paths', () => {
  it('lays out run.json, events.jsonl, step output and agent files under the run root', () => {
    const root = path.join(runsDir, RUN_ID)

    const dir = openRunDir(runsDir, RUN_ID)

    expect(dir.root).toBe(root)
    expect(dir.runJson).toBe(path.join(root, 'run.json'))
    expect(dir.events).toBe(path.join(root, 'events.jsonl'))
    expect(dir.stepOutput('baseline')).toBe(path.join(root, 'steps', 'baseline', 'output.txt'))
    expect(dir.agentDir('review', 'codex')).toBe(path.join(root, 'agents', 'review', 'codex'))
    expect(dir.agentFile('review', 'codex', 'transcript.jsonl')).toBe(
      path.join(root, 'agents', 'review', 'codex', 'transcript.jsonl'),
    )
  })

  it('creates nothing on disk when only computing paths', async () => {
    openRunDir(runsDir, RUN_ID)

    await expect(stat(runsDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
