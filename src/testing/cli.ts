import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { isolatedGitEnv } from './tmpRepo.js'

// Runs the built CLI the way a user does, for the end-to-end tests. Imports
// nothing from the engine: e2e tests see rensa only through its process.

const CLI = path.resolve(import.meta.dirname, '../../dist/cli/main.js')

/** `dist/cli/main.js`; throws with the fix when it has not been built. */
export function builtCli(): string {
  if (!existsSync(CLI)) {
    throw new Error(`${CLI} does not exist; run \`npm run build\` before \`npm run test:e2e\``)
  }
  return CLI
}

/**
 * The environment for a CLI child: git isolated from the user's config,
 * `home` as the home directory (so no user-level rensa config applies),
 * no inherited `RENSA_*` variable and no forced colors, then `vars`.
 */
export function cliEnv(
  home: string,
  vars: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const env = isolatedGitEnv()
  for (const key of Object.keys(env)) {
    if (key.startsWith('RENSA_')) delete env[key]
  }
  delete env.FORCE_COLOR
  delete env.XDG_CONFIG_HOME
  env.HOME = home
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return env
}

export interface CliOptions {
  cwd: string
  env: NodeJS.ProcessEnv
}

/** Starts `node dist/cli/main.js <args>` with stdout and stderr piped and stdin closed. */
export function startCli(args: readonly string[], opts: CliOptions): ChildProcess {
  return spawn(process.execPath, [builtCli(), ...args], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

export interface CliResult {
  /** Null when the process died by a signal. */
  code: number | null
  stdout: string
  stderr: string
}

/** Collects stderr and waits for the process to exit; SIGKILLs it after `timeoutMs`. */
export function exited(
  child: ChildProcess,
  timeoutMs = 20_000,
): Promise<{ code: number | null; stderr: string }> {
  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk
  })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`rensa did not exit within ${timeoutMs} ms; stderr so far:\n${stderr}`))
    }, timeoutMs)
    child.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stderr })
    })
  })
}

/** Runs the CLI to completion and returns its exit code and output. */
export async function runCli(args: readonly string[], opts: CliOptions): Promise<CliResult> {
  const child = startCli(args, opts)
  let stdout = ''
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk
  })
  const { code, stderr } = await exited(child)
  return { code, stdout, stderr }
}

/** Non-empty lines of `text`. */
export function linesOf(text: string): string[] {
  return text.split('\n').filter((line) => line !== '')
}
