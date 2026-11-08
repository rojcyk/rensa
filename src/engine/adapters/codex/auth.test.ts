import { randomInt } from 'node:crypto'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { killProcessesWithArgs } from '../../../testing/processes.js'
import { type TmpDir, tmpDir } from '../../../testing/tmpRepo.js'
import { drainDiag } from '../../diag.js'
import { checkProviders } from '../available.js'
import type { Availability } from '../types.js'
import { codexAvailability, parseLoginStatus, parseVersion } from './auth.js'
import { codexAdapter } from './index.js'

// `codex --version` and `codex login status` as observed on codex-cli
// 0.166.0: the version on stdout; the login state on stderr, exit 0 when
// logged in and 1 when not.
const VERSION = 'codex-cli 0.166.0'
const LOGGED_IN = 'Logged in using ChatGPT'
const NOT_LOGGED_IN = 'Not logged in'

let tmp: TmpDir

beforeEach(async () => {
  tmp = await tmpDir('rensa-codex-auth-')
  drainDiag()
})

afterEach(async () => {
  await tmp.cleanup()
})

/**
 * Puts a `codex` shell script on a PATH of its own: `--version` runs
 * `version` (by default it prints the 0.166.0 line), `login status` runs
 * `loginStatus`.
 */
async function installCodex(
  loginStatus: string,
  version = `echo '${VERSION}'\nexit 0`,
): Promise<NodeJS.ProcessEnv> {
  const bin = path.join(tmp.dir, 'bin')
  await mkdir(bin, { recursive: true })
  const file = path.join(bin, 'codex')
  await writeFile(
    file,
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then',
      version,
      'fi',
      'if [ "$1" = "login" ] && [ "$2" = "status" ]; then',
      loginStatus,
      'fi',
      'exit 2',
      '',
    ].join('\n'),
  )
  await chmod(file, 0o755)
  return { PATH: `${bin}:/usr/bin:/bin` }
}

/** An argument no other test's process carries, so `ps` finds only this one. */
function uniqueSleep(): string {
  return `30.${randomInt(100_000, 999_999)}`
}

const NOT_LOGGED_IN_AVAILABILITY: Availability = {
  status: 'not_logged_in',
  version: VERSION,
  hint: 'run: codex login',
}

describe('availability when codex is not installed', () => {
  it('reports not_installed when no PATH directory holds codex', async () => {
    const availability = await codexAvailability({ PATH: tmp.dir })

    expect(availability).toEqual({ status: 'not_installed' })
  })
})

describe('availability from the observed codex login status output', () => {
  it('reports ready with the version and no note when login status says logged in on stderr and exits 0', async () => {
    const env = await installCodex(`echo '${LOGGED_IN}' >&2\nexit 0`)

    const availability = await codexAvailability(env)

    const expected: Availability = { status: 'ready', version: VERSION }
    expect(availability).toEqual(expected)
  })

  it('reports not_logged_in with the login hint when login status says not logged in on stderr and exits 1', async () => {
    const env = await installCodex(`echo '${NOT_LOGGED_IN}' >&2\nexit 1`)

    const availability = await codexAvailability(env)

    expect(availability).toEqual(NOT_LOGGED_IN_AVAILABILITY)
  })

  it('reports not_logged_in when login status prints Not logged in on stdout even though it exits 0', async () => {
    const env = await installCodex(`echo '${NOT_LOGGED_IN}'\nexit 0`)

    await expect(codexAvailability(env)).resolves.toEqual(NOT_LOGGED_IN_AVAILABILITY)
  })

  it('reports not_logged_in when login status exits 1 and prints nothing', async () => {
    const env = await installCodex('exit 1')

    await expect(codexAvailability(env)).resolves.toEqual(NOT_LOGGED_IN_AVAILABILITY)
  })
})

describe('availability when codex login status cannot run', () => {
  it('reports ready and records why in diag when login status dies from a signal', async () => {
    const env = await installCodex('kill -KILL $$')

    const availability = await codexAvailability(env)

    expect(availability).toEqual({ status: 'ready', version: VERSION })
    expect(drainDiag().map((e) => e.scope)).toEqual(['codex.auth'])
  })

  it('counts codex as ready inside the 3 s provider check when login status hangs', {
    timeout: 15_000,
  }, async () => {
    const sleep = uniqueSleep()
    const env = await installCodex(`exec sleep ${sleep}`)

    try {
      const statuses = await checkProviders(env, [codexAdapter])

      expect(statuses).toEqual([
        { provider: 'codex', availability: { status: 'ready', version: VERSION } },
      ])
      const diags = drainDiag()
      expect(diags.map((e) => e.scope)).toEqual(['codex.auth'])
      expect(diags[0]?.message).toContain('timed out')
    } finally {
      await killProcessesWithArgs(`sleep ${sleep}`)
    }
  })
})

describe('availability when codex --version cannot run to completion', () => {
  it('reports the version as unknown and records why in diag when --version dies from a signal', async () => {
    const env = await installCodex(`echo '${LOGGED_IN}' >&2\nexit 0`, 'kill -KILL $$')

    const availability = await codexAvailability(env)

    expect(availability).toEqual({ status: 'ready', version: 'unknown' })
    expect(drainDiag().map((e) => e.scope)).toEqual(['codex.auth'])
  })

  it('keeps the login hint with an unknown version when --version fails and login status says not logged in', async () => {
    const env = await installCodex(`echo '${NOT_LOGGED_IN}' >&2\nexit 1`, 'kill -KILL $$')

    await expect(codexAvailability(env)).resolves.toEqual({
      status: 'not_logged_in',
      version: 'unknown',
      hint: 'run: codex login',
    })
  })
})

describe('reading codex login status output', () => {
  it('returns true when given the observed logged-in output and exit 0', () => {
    expect(parseLoginStatus(LOGGED_IN, 0)).toBe(true)
  })

  it('returns false when given the observed not-logged-in output and exit 1', () => {
    expect(parseLoginStatus(NOT_LOGGED_IN, 1)).toBe(false)
  })

  it('returns false when the output says not logged in even if the exit code is 0', () => {
    expect(parseLoginStatus(`\n${NOT_LOGGED_IN}`, 0)).toBe(false)
  })

  it('returns false when the exit code is 1 and the output is empty', () => {
    expect(parseLoginStatus('', 1)).toBe(false)
  })
})

describe('reading codex --version output', () => {
  it('returns the first line trimmed when the output has surrounding space and more lines', () => {
    expect(parseVersion(`  ${VERSION}  \nA new version of Codex is available: 0.167.0\n`)).toBe(
      VERSION,
    )
  })

  it('returns the observed version line when given it alone', () => {
    expect(parseVersion(`${VERSION}\n`)).toBe(VERSION)
  })

  it('returns undefined when the output is empty', () => {
    expect(parseVersion('')).toBe(undefined)
  })
})
