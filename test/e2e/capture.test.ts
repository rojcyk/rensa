import { existsSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { builtCli, cliEnv, runCli } from '../../src/testing/cli.js'
import { type TmpDir, tmpDir } from '../../src/testing/tmpRepo.js'

// `rensa capture` is a development command: without RENSA_DEV=1 it must
// refuse before running any provider or writing a fixture.

let dirs: TmpDir[] = []

beforeAll(() => {
  builtCli()
})

afterEach(async () => {
  await Promise.all(dirs.map((d) => d.cleanup()))
  dirs = []
})

describe('rensa capture outside development mode', () => {
  it('exits 64 with a RENSA_DEV hint and writes no fixture when RENSA_DEV is unset', async () => {
    const cwd = await tmpDir('rensa-capture-')
    const home = await tmpDir('rensa-home-')
    dirs.push(cwd, home)

    const { code, stdout, stderr } = await runCli(
      ['capture', 'claude', 'read-only-hello', 'List the files in this directory and say hello.'],
      { cwd: cwd.dir, env: cliEnv(home.dir) },
    )

    expect({ code, stdout }).toEqual({ code: 64, stdout: '' })
    expect(stderr).toContain('RENSA_DEV=1')
    expect(existsSync(path.join(cwd.dir, 'test'))).toBe(false)
  })
})
