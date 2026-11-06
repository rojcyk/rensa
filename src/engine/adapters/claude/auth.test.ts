import { randomInt } from 'node:crypto'
import { chmod, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { killProcessesWithArgs, processesWithArgs } from '../../../testing/processes.js'
import { type TmpDir, tmpDir } from '../../../testing/tmpRepo.js'
import { drainDiag } from '../../diag.js'
import { checkProviders } from '../available.js'
import type { Availability } from '../types.js'
import { claudeAvailability, parseAuthStatus, parseVersion } from './auth.js'
import { claudeAdapter } from './index.js'

// `claude auth status` as observed on Claude Code 2.1.319: pretty-printed
// JSON on stdout, exit 0 when logged in and 1 when not. Personal fields
// of the logged-in output are replaced with stand-ins of the same shape.
const LOGGED_IN_STATUS = `{
  "loggedIn": true,
  "authMethod": "claude.ai",
  "apiProvider": "firstParty",
  "analyticsDisabled": false,
  "projectsDirectory": "/Users/alice/.claude/projects",
  "configDirectory": "/Users/alice/.claude",
  "loginExpiresAt": "2026-12-01T09:00:00.000Z",
  "email": "alice@example.com",
  "orgId": "3f9c2a71-5b8e-4d06-a1c4-7e2b9d0f6a35",
  "orgName": "alice@example.com's Organization",
  "subscriptionType": "pro",
  "storedClaudeAiLogin": true,
  "planTier": "pro"
}`
const LOGGED_OUT_STATUS = `{
  "loggedIn": false,
  "authMethod": "none",
  "apiProvider": "firstParty",
  "loginExpiresAt": null
}`
const VERSION = '2.1.319 (Claude Code)'

let tmp: TmpDir

beforeEach(async () => {
  tmp = await tmpDir('rensa-claude-auth-')
  drainDiag()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await tmp.cleanup()
})

/**
 * Puts a `claude` shell script on a PATH of its own: `--version` prints
 * the 2.1.319 version line, `auth status` runs `authStatus`.
 */
async function installClaude(authStatus: string): Promise<NodeJS.ProcessEnv> {
  const file = path.join(tmp.dir, 'claude')
  const script = [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then',
    `  echo '${VERSION}'`,
    '  exit 0',
    'fi',
    'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then',
    authStatus,
    'fi',
    'exit 2',
    '',
  ].join('\n')
  await writeFile(file, script)
  await chmod(file, 0o755)
  return { PATH: `${tmp.dir}:/usr/bin:/bin` }
}

/** A shell `cat` of `text` as a here-document. */
function print(text: string): string {
  return `cat <<'EOF'\n${text}\nEOF`
}

/** An argument no other test's process carries, so `ps` finds only this one. */
function uniqueSleep(): string {
  return `30.${randomInt(100_000, 999_999)}`
}

describe('availability when claude is not installed', () => {
  it('reports not_installed when no PATH directory holds claude', async () => {
    const availability = await claudeAvailability({ PATH: tmp.dir })

    expect(availability).toEqual({ status: 'not_installed' })
  })
})

describe('availability from the observed claude auth status output', () => {
  it('reports ready with the version when auth status prints loggedIn true and exits 0', async () => {
    const env = await installClaude(`${print(LOGGED_IN_STATUS)}\nexit 0`)

    const availability = await claudeAvailability(env)

    const expected: Availability = { status: 'ready', version: VERSION }
    expect(availability).toEqual(expected)
  })

  it('reports not_logged_in with the login hint when auth status prints loggedIn false and exits 1', async () => {
    const env = await installClaude(`${print(LOGGED_OUT_STATUS)}\nexit 1`)

    const availability = await claudeAvailability(env)

    const expected: Availability = {
      status: 'not_logged_in',
      version: VERSION,
      hint: 'run: claude auth login',
    }
    expect(availability).toEqual(expected)
  })

  it('believes loggedIn false over exit code 0 when the JSON says logged out', async () => {
    const env = await installClaude(`${print(LOGGED_OUT_STATUS)}\nexit 0`)

    await expect(claudeAvailability(env)).resolves.toMatchObject({ status: 'not_logged_in' })
  })

  it('reports ready when auth status prints no JSON and exits 0', async () => {
    const env = await installClaude(`echo 'Logged in as alice@example.com'\nexit 0`)

    await expect(claudeAvailability(env)).resolves.toEqual({ status: 'ready', version: VERSION })
  })

  it('reports not_logged_in when auth status prints no JSON and exits 1', async () => {
    const env = await installClaude(`echo 'Not logged in'\nexit 1`)

    await expect(claudeAvailability(env)).resolves.toMatchObject({ status: 'not_logged_in' })
  })
})

describe('availability when claude auth status cannot run', () => {
  it('reports ready and records why in diag when auth status dies from a signal', async () => {
    const env = await installClaude('kill -KILL $$')

    const availability = await claudeAvailability(env)

    expect(availability).toEqual({ status: 'ready', version: VERSION })
    expect(drainDiag().map((e) => e.scope)).toEqual(['claude.auth'])
  })

  it('answers ready before a SIGTERM-ignoring auth status has exited and then leaves it dead', {
    timeout: 15_000,
  }, async () => {
    const sleep = uniqueSleep()
    const env = await installClaude(`trap '' TERM\nexec sleep ${sleep}`)
    const stderr = vi.spyOn(process.stderr, 'write')

    try {
      const availability = await claudeAvailability(env)
      const stillRunning = await processesWithArgs(`sleep ${sleep}`)

      expect(availability).toEqual({ status: 'ready', version: VERSION })
      // Answered at the 2 s deadline, inside the SIGTERM → SIGKILL grace.
      expect(stillRunning).toHaveLength(1)
      await vi.waitFor(async () => expect(await processesWithArgs(`sleep ${sleep}`)).toEqual([]), {
        timeout: 5_000,
        interval: 100,
      })
      const diags = drainDiag()
      expect(diags.map((e) => e.scope)).toEqual(['claude.auth'])
      expect(diags[0]?.message).toContain('timed out')
      expect(stderr).not.toHaveBeenCalled()
    } finally {
      await killProcessesWithArgs(`sleep ${sleep}`)
    }
  })

  it('counts claude as ready inside the 3 s provider check when auth status hangs', {
    timeout: 15_000,
  }, async () => {
    const sleep = uniqueSleep()
    const env = await installClaude(`exec sleep ${sleep}`)

    try {
      const statuses = await checkProviders(env, [claudeAdapter])

      expect(statuses).toEqual([
        { provider: 'claude', availability: { status: 'ready', version: VERSION } },
      ])
    } finally {
      await killProcessesWithArgs(`sleep ${sleep}`)
    }
  })
})

describe('reading claude auth status output', () => {
  it('returns true when given the observed logged-in output and exit 0', () => {
    expect(parseAuthStatus(LOGGED_IN_STATUS, 0)).toBe(true)
  })

  it('returns false when given the observed logged-out output and exit 1', () => {
    expect(parseAuthStatus(LOGGED_OUT_STATUS, 1)).toBe(false)
  })

  it('returns true when the JSON says loggedIn true even if the exit code is 1', () => {
    expect(parseAuthStatus(LOGGED_IN_STATUS, 1)).toBe(true)
  })

  it.each([
    ['plain text', 'Logged in as alice@example.com'],
    ['JSON without loggedIn', '{"authMethod":"claude.ai"}'],
    ['JSON with a string loggedIn', '{"loggedIn":"yes"}'],
    ['empty output', ''],
  ])('falls back to the exit code when the output is %s', (_, stdout) => {
    expect([parseAuthStatus(stdout, 0), parseAuthStatus(stdout, 1)]).toEqual([true, false])
  })
})

describe('reading claude --version output', () => {
  it('returns the first line trimmed when the output has surrounding space and more lines', () => {
    expect(parseVersion(`  ${VERSION}  \nUpdate available: 2.1.320\n`)).toBe(VERSION)
  })

  it('returns the observed version line when given it alone', () => {
    expect(parseVersion(`${VERSION}\n`)).toBe(VERSION)
  })
})
