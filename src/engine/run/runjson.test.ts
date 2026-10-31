import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, assert, beforeEach, describe, expect, it } from 'vitest'
import { type TmpDir, tmpDir } from '../../testing/tmpRepo.js'
import type { ResolvedChain } from '../config/types.js'
import { RensaError } from '../errors.js'
import { type RunJson, readRunJson, writeRunJson } from './runjson.js'

const CHAIN: ResolvedChain = {
  name: 'tdd-review',
  description: 'Tests, then review.',
  input: 'text',
  base: 'main',
  allowApiKeys: false,
  steps: [
    {
      id: 'baseline',
      kind: 'shell',
      command: 'npm test',
      onFail: 'continue',
      timeoutMs: 1_200_000,
    },
    {
      id: 'review',
      kind: 'agent',
      prompt: '/home/alice/shop/.rensa/steps/review.md',
      agent: {
        provider: 'codex',
        effort: 'high',
        tools: 'read',
        skills: [],
        label: 'codex',
        session: 'fresh',
      },
      vars: { diff: { kind: 'shell', value: 'git diff {{base}}' } },
      onFail: 'stop',
      timeoutMs: 3_600_000,
      pause: 'before',
    },
  ],
  writes: true,
  warnings: [],
  sources: { chain: '/home/alice/shop/.rensa/tdd-review.yaml' },
}

function runJson(overrides: Partial<RunJson> = {}): RunJson {
  return {
    id: '2026-10-28_0912_tdd-review_7f3a',
    chain: CHAIN,
    input: { kind: 'text', text: 'Add coupon support to the cart total.' },
    base: { ref: 'main', sha: '3f9c2a7e1b04d6c58e2f7a91b3d04e6c2a5f8b17' },
    started_at: '2026-10-28T09:12:03.418Z',
    sessions: {},
    steps: {},
    ...overrides,
  }
}

let tmp: TmpDir
let file: string

beforeEach(async () => {
  tmp = await tmpDir('rensa-runjson-')
  file = path.join(tmp.dir, 'run.json')
})

afterEach(async () => {
  await tmp.cleanup()
})

async function readError(): Promise<RensaError> {
  const err = await readRunJson(file).catch((e: unknown) => e)
  assert(err instanceof RensaError, `expected RensaError, got ${String(err)}`)
  return err
}

describe('writing and reading run.json', () => {
  it('reads back exactly what was written for a finished run', async () => {
    const finished = runJson({
      finished_at: '2026-10-28T09:41:57.002Z',
      status: 'failed',
      sessions: { reviewer: '019a2f4e-7c1d-7b3a-9e52-4d8f1c6a0b93' },
      steps: {
        baseline: { status: 'ok', agents: {} },
        review: { status: 'timeout', agents: { codex: 'timeout' } },
      },
    })

    await writeRunJson(file, finished)

    expect(await readRunJson(file)).toStrictEqual(finished)
  })

  it('leaves only run.json in the directory after a write', async () => {
    await writeRunJson(file, runJson())

    expect(await readdir(tmp.dir)).toEqual(['run.json'])
  })

  it('replaces the earlier content and leaves no temp file when written a second time', async () => {
    await writeRunJson(file, runJson())
    const finished = runJson({ finished_at: '2026-10-28T09:41:57.002Z', status: 'complete' })

    await writeRunJson(file, finished)

    expect(await readRunJson(file)).toStrictEqual(finished)
    expect(await readdir(tmp.dir)).toEqual(['run.json'])
  })

  it('rejects and removes its temp file when the rename onto the target fails', async () => {
    // A non-empty directory at the target path makes the rename fail.
    await mkdir(file)
    await writeFile(path.join(file, 'keep.txt'), 'occupied')

    await expect(writeRunJson(file, runJson())).rejects.toMatchObject({
      code: expect.stringMatching(/^E/),
    })
    expect(await readdir(tmp.dir)).toEqual(['run.json'])
    expect(await readFile(path.join(file, 'keep.txt'), 'utf8')).toBe('occupied')
  })
})

describe('reading a damaged run.json', () => {
  it('throws RensaError INTERNAL naming the file when the content is not valid JSON', async () => {
    await writeFile(file, '{"id":"2026-10-28_0912_tdd-review_7f3a","chain":')

    const err = await readError()

    expect(err.code).toBe('INTERNAL')
    expect(err.path).toBe(file)
    expect(err.message.startsWith(`${file} is not valid JSON: `)).toBe(true)
  })

  it.each<[string, unknown]>([
    ['the document is an array', [runJson()]],
    ['id is missing', { ...runJson(), id: undefined }],
    ['id is a number', { ...runJson(), id: 20261028 }],
    ['chain is a string', { ...runJson(), chain: 'tdd-review' }],
    ['chain is null', { ...runJson(), chain: null }],
  ])('throws RensaError INTERNAL when %s', async (_, doc) => {
    await writeFile(file, JSON.stringify(doc))

    const err = await readError()

    expect(err.code).toBe('INTERNAL')
    expect(err.message).toBe(`${file} is not a run.json`)
  })
})
