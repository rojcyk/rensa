import { chmod, lstat, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, assert, beforeEach, describe, expect, it } from 'vitest'
import { type TmpDir, tmpDir } from '../../testing/tmpRepo.js'
import { RensaError } from '../errors.js'
import { openRunDir, type RunDir } from '../run/dir.js'
import { appendSkills, parseSkill, stageSkills } from './skills.js'

const MESSAGE = 'Review the diff against main.\n'

describe('appending skills to the first prompt', () => {
  it('returns the message unchanged when there are no skills', () => {
    expect(appendSkills(MESSAGE, [])).toBe(MESSAGE)
  })

  it('appends a Skills section with a heading, a Files line and the body per skill in the given order', () => {
    const staged = [
      {
        name: 'house-rules',
        dir: '/repo/.rensa/runs/r1/skills/house-rules',
        body: 'Two spaces.\n',
      },
      {
        name: 'code-review',
        dir: '/repo/.rensa/runs/r1/skills/code-review',
        body: 'Check errors.\n',
      },
    ]

    expect(appendSkills(MESSAGE, staged)).toBe(
      `${MESSAGE}\n\n## Skills\n\n` +
        '### house-rules\nFiles: /repo/.rensa/runs/r1/skills/house-rules\n\nTwo spaces.\n' +
        '\n\n### code-review\nFiles: /repo/.rensa/runs/r1/skills/code-review\n\nCheck errors.\n',
    )
  })

  it('leaves placeholders in a skill body as written', () => {
    const staged = [
      { name: 'naming', dir: '/skills/naming', body: 'Prefix {{module}} names; see {{base}}.' },
    ]

    expect(appendSkills(MESSAGE, staged)).toContain('Prefix {{module}} names; see {{base}}.')
  })
})

describe('parsing SKILL.md', () => {
  it('takes the front matter name and strips the front matter from the body when SKILL.md has front matter', () => {
    const text = '---\nname: house-rules\ndescription: Conventions.\n---\nUse two spaces.\n'

    expect(parseSkill(text, '/skills/conventions')).toEqual({
      name: 'house-rules',
      body: 'Use two spaces.\n',
      dir: '/skills/conventions',
    })
  })

  it('names the skill after its directory and keeps the whole text when SKILL.md has no front matter', () => {
    const text = '# Code review\n\nCheck error paths first.\n'

    expect(parseSkill(text, '/skills/code-review')).toEqual({
      name: 'code-review',
      body: text,
      dir: '/skills/code-review',
    })
  })

  it('names the skill after its directory when the front matter has no name', () => {
    expect(
      parseSkill('---\ndescription: Conventions.\n---\nBody.\n', '/skills/conventions').name,
    ).toBe('conventions')
  })

  it('rejects with CONFIG_INVALID when the front matter name is not a usable directory name', () => {
    const err = (() => {
      try {
        parseSkill('---\nname: ../escape\n---\nBody.\n', '/skills/conventions')
      } catch (e) {
        return e
      }
    })()

    assert(err instanceof RensaError, `expected a RensaError, got ${String(err)}`)
    expect(err.code).toBe('CONFIG_INVALID')
  })
})

describe('staging skill directories into the run', () => {
  let tmp: TmpDir
  let runDir: RunDir

  beforeEach(async () => {
    tmp = await tmpDir('rensa-skills-')
    runDir = openRunDir(path.join(tmp.dir, 'runs'), 'review-20261102-1430-a1b2')
    await mkdir(runDir.root, { recursive: true })
  })

  afterEach(async () => {
    await tmp.cleanup()
  })

  async function skill(dirName: string, skillMd: string): Promise<string> {
    const dir = path.join(tmp.dir, 'sources', dirName)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'SKILL.md'), skillMd)
    return dir
  }

  it('copies the layout and file modes under skills/<name> and returns the copies in order', async () => {
    const review = await skill('code-review', 'Check error paths first.\n')
    await mkdir(path.join(review, 'scripts'))
    await mkdir(path.join(review, 'references'))
    await writeFile(path.join(review, 'scripts', 'lint.sh'), '#!/bin/sh\nexit 0\n')
    await chmod(path.join(review, 'scripts', 'lint.sh'), 0o755)
    await writeFile(path.join(review, 'references', 'checklist.md'), '- errors\n')
    const rules = await skill('conventions', '---\nname: house-rules\n---\nTwo spaces.\n')

    const staged = await stageSkills(runDir, [{ dir: review }, { dir: rules }])

    const root = path.join(runDir.root, 'skills')
    expect(staged).toEqual([
      { name: 'code-review', dir: path.join(root, 'code-review') },
      { name: 'house-rules', dir: path.join(root, 'house-rules') },
    ])
    expect((await stat(path.join(root, 'code-review', 'scripts', 'lint.sh'))).mode & 0o777).toBe(
      0o755,
    )
    expect(
      await readFile(path.join(root, 'code-review', 'references', 'checklist.md'), 'utf8'),
    ).toBe('- errors\n')
    expect(await readFile(path.join(root, 'house-rules', 'SKILL.md'), 'utf8')).toBe(
      '---\nname: house-rules\n---\nTwo spaces.\n',
    )
  })

  it('copies the target as a regular file when the skill holds a symlink to a file', async () => {
    const review = await skill('code-review', 'Check error paths first.\n')
    const shared = path.join(tmp.dir, 'shared-checklist.md')
    await writeFile(shared, '- error paths\n- boundaries\n')
    await symlink(shared, path.join(review, 'checklist.md'))

    await stageSkills(runDir, [{ dir: review }])

    const copied = path.join(runDir.root, 'skills', 'code-review', 'checklist.md')
    expect((await lstat(copied)).isSymbolicLink()).toBe(false)
    expect(await readFile(copied, 'utf8')).toBe('- error paths\n- boundaries\n')
  })

  it('rejects with CONFIG_INVALID when two skill directories resolve to the same name', async () => {
    const first = await skill('conventions', '---\nname: house-rules\n---\nTwo spaces.\n')
    const second = await skill('house-rules', 'Tabs.\n')

    const err = await stageSkills(runDir, [{ dir: first }, { dir: second }]).then(
      () => undefined,
      (e: unknown) => e,
    )

    assert(err instanceof RensaError, `expected a RensaError, got ${String(err)}`)
    expect(err.code).toBe('CONFIG_INVALID')
    expect(err.message).toContain('house-rules')
  })

  it('keeps the first copy and returns its path when the same skill is staged again in the run', async () => {
    const review = await skill('code-review', 'Check error paths first.\n')
    const [first] = await stageSkills(runDir, [{ dir: review }])
    await writeFile(path.join(review, 'SKILL.md'), 'Edited after the first stage.\n')

    const [again] = await stageSkills(runDir, [{ dir: review }])

    expect(again).toEqual(first)
    assert(first !== undefined, 'nothing staged')
    expect(await readFile(path.join(first.dir, 'SKILL.md'), 'utf8')).toBe(
      'Check error paths first.\n',
    )
  })

  it('rejects with TEMPLATE naming the directory when a skill directory is gone', async () => {
    const gone = path.join(tmp.dir, 'sources', 'removed-skill')

    const err = await stageSkills(runDir, [{ dir: gone }]).then(
      () => undefined,
      (e: unknown) => e,
    )

    assert(err instanceof RensaError, `expected a RensaError, got ${String(err)}`)
    expect([err.code, err.path]).toEqual(['TEMPLATE', gone])
  })
})
