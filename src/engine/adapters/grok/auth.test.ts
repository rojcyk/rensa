import { randomInt } from 'node:crypto'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { killProcessesWithArgs } from '../../../testing/processes.js'
import { type TmpDir, tmpDir } from '../../../testing/tmpRepo.js'
import { drainDiag } from '../../diag.js'
import { checkProviders } from '../available.js'
import type { Availability, AvailabilityOptions } from '../types.js'
import { authFile, grokAvailability, parseVersion } from './auth.js'
import { grokAdapter } from './index.js'

// `grok --version` as observed on Grok Build 1.0.70.
const VERSION = 'grok 1.0.70 (f50904eaee6c) [stable]'

// Tests that check how probe output is read get a deadline no loaded
// machine misses: under a full parallel suite the fake CLIs below have
// taken up to 2 s to run. Only the tests of the deadline itself use the
// 2 s default. The test timeout is raised to match.
const READ_OUTPUT: AvailabilityOptions = { commandTimeoutMs: 10_000 }
const SLOW_PROBE = { timeout: 15_000 }

let tmp: TmpDir

beforeEach(async () => {
  tmp = await tmpDir('rensa-grok-auth-')
  drainDiag()
})

afterEach(async () => {
  await tmp.cleanup()
})

/**
 * Puts a `grok` shell script on a PATH of its own; `--version` runs
 * `version` (by default it prints the 1.0.70 version line).
 */
async function installGrok(version = `echo '${VERSION}'\nexit 0`): Promise<string> {
  const bin = path.join(tmp.dir, 'bin')
  await mkdir(bin, { recursive: true })
  const file = path.join(bin, 'grok')
  await writeFile(
    file,
    ['#!/bin/sh', 'if [ "$1" = "--version" ]; then', version, 'fi', 'exit 2', ''].join('\n'),
  )
  await chmod(file, 0o755)
  return `${bin}:/usr/bin:/bin`
}

/** A home directory under the temp dir; with `loggedIn`, it holds `.grok/auth.json`. */
async function home(name: string, loggedIn: boolean): Promise<string> {
  const dir = path.join(tmp.dir, name)
  await mkdir(path.join(dir, '.grok'), { recursive: true })
  if (loggedIn) {
    await writeFile(path.join(dir, '.grok', 'auth.json'), '{"refresh_token":"rt_7f3a9c2e"}\n')
  }
  return dir
}

/** A GROK_HOME directory; with `loggedIn`, it holds `auth.json`. */
async function grokHome(name: string, loggedIn: boolean): Promise<string> {
  const dir = path.join(tmp.dir, name)
  await mkdir(dir, { recursive: true })
  if (loggedIn) await writeFile(path.join(dir, 'auth.json'), '{"refresh_token":"rt_7f3a9c2e"}\n')
  return dir
}

/** An argument no other test's process carries, so `ps` finds only this one. */
function uniqueSleep(): string {
  return `30.${randomInt(100_000, 999_999)}`
}

const NOT_LOGGED_IN: Availability = {
  status: 'not_logged_in',
  version: VERSION,
  hint: 'run: grok login',
}

describe('availability when grok is not installed', () => {
  it('reports not_installed when no PATH directory holds grok', async () => {
    const HOME = await home('alice', true)

    const availability = await grokAvailability({ PATH: tmp.dir, HOME })

    expect(availability).toEqual({ status: 'not_installed' })
  })
})

describe('availability from the credentials file', SLOW_PROBE, () => {
  it('reports ready with the version when HOME holds .grok/auth.json', async () => {
    const env = { PATH: await installGrok(), HOME: await home('alice', true) }

    const availability = await grokAvailability(env, READ_OUTPUT)

    const expected: Availability = { status: 'ready', version: VERSION }
    expect(availability).toEqual(expected)
  })

  it('reports not_logged_in with the login hint when HOME has no .grok/auth.json', async () => {
    const env = { PATH: await installGrok(), HOME: await home('alice', false) }

    const availability = await grokAvailability(env, READ_OUTPUT)

    expect(availability).toEqual(NOT_LOGGED_IN)
  })

  it('reports ready when GROK_HOME holds auth.json and HOME has none', async () => {
    const env = {
      PATH: await installGrok(),
      HOME: await home('alice', false),
      GROK_HOME: await grokHome('grok-home', true),
    }

    await expect(grokAvailability(env, READ_OUTPUT)).resolves.toEqual({
      status: 'ready',
      version: VERSION,
    })
  })

  it('reports not_logged_in when GROK_HOME has no auth.json even if HOME has one', async () => {
    const env = {
      PATH: await installGrok(),
      HOME: await home('alice', true),
      GROK_HOME: await grokHome('grok-home', false),
    }

    await expect(grokAvailability(env, READ_OUTPUT)).resolves.toEqual(NOT_LOGGED_IN)
  })
})

describe('where grok keeps its credentials', () => {
  it('returns auth.json under HOME/.grok when GROK_HOME is unset', () => {
    expect(authFile({ HOME: '/Users/alice' })).toBe('/Users/alice/.grok/auth.json')
  })

  it('returns auth.json under GROK_HOME when GROK_HOME is set', () => {
    expect(authFile({ HOME: '/Users/alice', GROK_HOME: '/Volumes/work/grok' })).toBe(
      '/Volumes/work/grok/auth.json',
    )
  })
})

describe('availability when grok --version cannot run to completion', SLOW_PROBE, () => {
  it('reports the version as unknown and records why in diag when --version dies from a signal', async () => {
    const env = { PATH: await installGrok('kill -KILL $$'), HOME: await home('alice', true) }

    const availability = await grokAvailability(env, READ_OUTPUT)

    expect(availability).toEqual({ status: 'ready', version: 'unknown' })
    expect(drainDiag().map((e) => e.scope)).toEqual(['grok.auth'])
  })

  it('counts grok as ready with an unknown version inside the 3 s provider check when --version hangs', {
    timeout: 15_000,
  }, async () => {
    const sleep = uniqueSleep()
    const env = { PATH: await installGrok(`exec sleep ${sleep}`), HOME: await home('alice', true) }

    try {
      const statuses = await checkProviders(env, [grokAdapter])

      expect(statuses).toEqual([
        { provider: 'grok', availability: { status: 'ready', version: 'unknown' } },
      ])
      const diags = drainDiag()
      expect(diags.map((e) => e.scope)).toEqual(['grok.auth'])
      expect(diags[0]?.message).toContain('timed out')
    } finally {
      await killProcessesWithArgs(`sleep ${sleep}`)
    }
  })
})

describe('reading grok --version output', () => {
  it('returns the first line trimmed when the output has surrounding space and more lines', () => {
    expect(parseVersion(`  ${VERSION}  \nA newer version is available: 1.0.71\n`)).toBe(VERSION)
  })

  it('returns undefined when the output is empty', () => {
    expect(parseVersion('')).toBe(undefined)
  })
})
