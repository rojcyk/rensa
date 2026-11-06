import { captureFixture, RensaError } from '../engine/index.js'
import type { CaptureArgs } from './args.js'
import { formatError, paintFor, streamDiag, writeLines } from './format.js'

/**
 * `rensa capture` (RENSA_DEV=1 only): runs one read-only turn in `cwd`
 * and writes it as a fixture. Exits 0 once the fixture is written, even
 * when the turn itself failed, since a failed turn is a fixture too.
 */
export async function runCapture(
  args: CaptureArgs,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const stopDiag = streamDiag(env)
  try {
    const { dir, done } = await captureFixture({ ...args, cwd, env })
    const outcome = done.error
      ? `${done.error.kind}: ${done.error.message}`
      : `exit ${done.exitCode ?? 'none'}`
    writeLines(process.stdout, [`wrote ${dir}`, `the turn ended with ${outcome}`])
    return 0
  } catch (err) {
    if (!(err instanceof RensaError)) throw err
    writeLines(process.stderr, formatError(err, paintFor(process.stderr, env)))
    return 1
  } finally {
    stopDiag()
  }
}
