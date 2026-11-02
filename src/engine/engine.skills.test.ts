import { statSync } from 'node:fs'
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  truncate,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { afterAll, afterEach, assert, beforeAll, describe, expect, it } from 'vitest'
import { type EngineRepo, engineRepo, finished } from '../testing/engine.js'
import type { SpawnRequest } from './adapters/types.js'
import type { RunHandle } from './index.js'

let env: EngineRepo | undefined

afterEach(async () => {
  await env?.cleanup()
  env = undefined
})

const NOTE = 'Leave the changelog alone.'
const CONVENTIONS_BODY =
  'Use two-space indentation in {{language}} files.\nKeep functions under forty lines.\n'
const OUTSIDE_BODY = 'Run scripts/check.sh before replying.\nDetails are in references/notes.md.\n'
const NOTES_MD = '# Notes\n\nThe check script exits 0 when the tree is clean.\n'
const CHECK_SH = '#!/bin/sh\nexit 0\n'

/** A skill outside the repository, at `~/rensa-skills/outside`, with supporting files. */
async function writeOutsideSkill(home: string): Promise<string> {
  const dir = path.join(home, 'rensa-skills', 'outside')
  await mkdir(path.join(dir, 'references'), { recursive: true })
  await mkdir(path.join(dir, 'scripts'))
  await writeFile(path.join(dir, 'SKILL.md'), OUTSIDE_BODY)
  await writeFile(path.join(dir, 'references', 'notes.md'), NOTES_MD)
  await writeFile(path.join(dir, 'scripts', 'check.sh'), CHECK_SH)
  await chmod(path.join(dir, 'scripts', 'check.sh'), 0o755)
  return dir
}

/** Every file under `dir` by relative path, with content and mode. */
async function snapshot(dir: string): Promise<Record<string, { content: string; mode: number }>> {
  const out: Record<string, { content: string; mode: number }> = {}
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const file = path.join(entry.parentPath, entry.name)
    out[path.relative(dir, file)] = {
      content: await readFile(file, 'utf8'),
      mode: (await stat(file)).mode & 0o777,
    }
  }
  return out
}

function agentFile(handle: RunHandle, step: string, name: string): Promise<string> {
  return readFile(path.join(handle.dir, 'agents', step, 'skilled', name), 'utf8')
}

describe('skills in a run', () => {
  let handle: RunHandle
  let outside: string
  let repoSkill: string
  let sourcesBefore: Record<string, unknown>
  /** Inode of the copied SKILL.md right after the first step, to show later steps did not copy again. */
  let copiedInodeAfterFirst: number | undefined

  let runEnv: EngineRepo | undefined

  // One run serves every test here; none of them changes it.
  beforeAll(async () => {
    runEnv = await engineRepo(['skills'])
    outside = await writeOutsideSkill(runEnv.home.dir)
    repoSkill = path.join(runEnv.projectDir, 'skills', 'conventions')
    sourcesBefore = { outside: await snapshot(outside), repo: await snapshot(repoSkill) }
    const engine = await runEnv.open()
    handle = await runEnv.start(engine, 'skills')
    handle.note(NOTE)
    handle.attach({
      event(e) {
        if (e.type === 'step.finished' && e.step === 'first') {
          copiedInodeAfterFirst = statSync(
            path.join(handle.dir, 'skills', 'outside', 'SKILL.md'),
          ).ino
        }
      },
    })
    const { result } = await finished(handle)
    assert(result.status === 'complete', `the skills run ended ${JSON.stringify(result)}`)
  })

  afterAll(async () => {
    await runEnv?.cleanup()
  })

  it('inlines both skills in chain order after the step prompt and before the user notes on the first use of a named agent', async () => {
    const prompt = await agentFile(handle, 'first', 'prompt.md')

    const staged = path.join(handle.dir, 'skills')
    expect(prompt).toBe(
      'Review the README and report what it contains.\n' +
        '\n\n## Skills\n\n' +
        `### house-rules\nFiles: ${path.join(staged, 'house-rules')}\n\n${CONVENTIONS_BODY}` +
        '\n\n' +
        `### outside\nFiles: ${path.join(staged, 'outside')}\n\n${OUTSIDE_BODY}` +
        `\n\n## User notes\n\n1. ${NOTE}`,
    )
  })

  it('copies each skill directory into the run, inside the checkout, with content and modes kept', async () => {
    const request = JSON.parse(await agentFile(handle, 'first', 'request.json')) as SpawnRequest
    const copy = path.join(handle.dir, 'skills', 'outside')

    const realCopy = await realpath(copy)
    const realCwd = await realpath(request.cwd)

    expect(realCopy.startsWith(`${realCwd}${path.sep}`)).toBe(true)
    expect(await readdir(path.join(handle.dir, 'skills'))).toEqual(['house-rules', 'outside'])
    expect(await readFile(path.join(copy, 'references', 'notes.md'), 'utf8')).toBe(NOTES_MD)
    expect((await stat(path.join(copy, 'scripts', 'check.sh'))).mode & 0o777).toBe(0o755)
  })

  it('sends no skills to the resumed named agent and inlines them again for every from: copy without copying twice', async () => {
    const second = await agentFile(handle, 'second', 'prompt.md')
    const third = await agentFile(handle, 'third', 'prompt.md')
    const fourth = await agentFile(handle, 'fourth', 'prompt.md')

    expect(second).toBe(
      `Summarize the repository layout in three sentences.\n\n\n## User notes\n\n1. ${NOTE}`,
    )
    const filesLines = (prompt: string) => prompt.split('\n').filter((l) => l.startsWith('Files: '))
    const staged = path.join(handle.dir, 'skills')
    const expectedFiles = [
      `Files: ${path.join(staged, 'house-rules')}`,
      `Files: ${path.join(staged, 'outside')}`,
    ]
    expect([filesLines(third), filesLines(fourth)]).toEqual([expectedFiles, expectedFiles])
    expect(fourth).toContain(
      `### house-rules\nFiles: ${path.join(staged, 'house-rules')}\n\n${CONVENTIONS_BODY}`,
    )
    expect(await readdir(staged)).toEqual(['house-rules', 'outside'])
    assert(copiedInodeAfterFirst !== undefined, 'the first step never finished')
    expect(statSync(path.join(staged, 'outside', 'SKILL.md')).ino).toBe(copiedInodeAfterFirst)
  })

  it('takes the name from front matter and inlines only the body when SKILL.md has front matter', async () => {
    const prompt = await agentFile(handle, 'first', 'prompt.md')

    expect(prompt).toContain('### house-rules\n')
    expect(prompt).not.toContain('description: Coding conventions')
    expect(prompt).not.toContain('### conventions')
  })

  it('leaves the source skill directories unchanged after the run', async () => {
    expect({ outside: await snapshot(outside), repo: await snapshot(repoSkill) }).toEqual(
      sourcesBefore,
    )
  })
})

describe('skill size limits', () => {
  it('reports CONFIG_INVALID naming the skill when a SKILL.md body is over 32 KB', async () => {
    env = await engineRepo(['skill-body-too-big', 'read-only'])
    const dir = path.join(env.home.dir, 'rensa-skills', 'big-body')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'SKILL.md'), `${'Explain every changed line. '.repeat(1200)}\n`)

    const engine = await env.open()
    const summary = engine.chains().find((c) => c.name === 'skill-body-too-big')

    expect(summary?.error?.code).toBe('CONFIG_INVALID')
    expect(summary?.error?.message).toContain(dir)
    expect(engine.chains().find((c) => c.name === 'read-only')?.error).toBeUndefined()
  })

  it('reports CONFIG_INVALID naming the skill when a skill directory is over 10 MB', async () => {
    env = await engineRepo(['skill-dir-too-big'])
    const dir = path.join(env.home.dir, 'rensa-skills', 'big-dir')
    await mkdir(path.join(dir, 'assets'), { recursive: true })
    await writeFile(path.join(dir, 'SKILL.md'), 'Use the bundled dataset in assets/.\n')
    const blob = path.join(dir, 'assets', 'dataset.bin')
    await writeFile(blob, '')
    // Sparse: the size counts, the disk space does not.
    await truncate(blob, 10 * 1024 * 1024 + 1)

    const engine = await env.open()
    const summary = engine.chains().find((c) => c.name === 'skill-dir-too-big')

    expect(summary?.error?.code).toBe('CONFIG_INVALID')
    expect(summary?.error?.message).toContain(dir)
  })
})
