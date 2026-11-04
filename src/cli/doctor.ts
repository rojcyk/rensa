import { checkProviders, Engine, type ProviderStatus, RensaError } from '../engine/index.js'
import { formatError, formatProvider, paintFor, streamDiag, writeLines } from './format.js'

/**
 * `rensa doctor`: one line per provider. Exits 0 when every chain in the
 * repository loaded and every provider they use is ready, else 1; each
 * chain that failed to load is reported on stderr. Outside a repository
 * it lists the providers and exits 0.
 */
export async function doctor(cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  const stopDiag = streamDiag(env)
  try {
    let engine: Engine
    try {
      engine = await Engine.open(cwd)
    } catch (err) {
      if (!(err instanceof RensaError)) throw err
      if (err.code === 'NOT_A_REPO') {
        printProviders(await checkProviders(env), env)
        return 0
      }
      writeLines(process.stderr, formatError(err, paintFor(process.stderr, env)))
      return 1
    }
    await engine.providersChecked
    const statuses = engine.providers() ?? []
    const chains = engine.chains()
    // A provider a chain uses but no adapter checked (`fake` without
    // RENSA_DEV) is missing too, and gets a row of its own.
    const missing = chains.flatMap((c) => c.missingProviders)
    const unchecked = missing.filter(
      (m, i) =>
        !statuses.some((s) => s.provider === m.provider) &&
        missing.findIndex((other) => other.provider === m.provider) === i,
    )
    printProviders([...statuses, ...unchecked], env)
    // A chain that failed to load has no resolved steps, so its providers
    // are unknown and its empty `missingProviders` proves nothing.
    const failed = chains.flatMap(({ name, error }) => (error ? [{ name, error }] : []))
    const errPaint = paintFor(process.stderr, env)
    for (const { name, error } of failed) {
      const message = `cannot check the providers of chain \`${name}\`: ${error.message}`
      writeLines(
        process.stderr,
        formatError({ message, hint: error.hint, details: error.details }, errPaint),
      )
    }
    return missing.length === 0 && failed.length === 0 ? 0 : 1
  } finally {
    stopDiag()
  }
}

function printProviders(statuses: readonly ProviderStatus[], env: NodeJS.ProcessEnv): void {
  const paint = paintFor(process.stdout, env)
  writeLines(
    process.stdout,
    statuses.map((s) => formatProvider(s, paint)),
  )
}
