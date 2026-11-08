import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { checkProviders, type ProviderStatus } from './adapters/available.js'
import { allAdapters } from './adapters/registry.js'
import { type Discovered, discover } from './config/discover.js'
import { loadAllChains } from './config/index.js'
import type { Provider, ResolvedChain } from './config/types.js'
import { validateWithAdapters } from './config/validate.js'
import { diag } from './diag.js'
import { RensaError } from './errors.js'
import { createRunDir, type RunDir } from './run/dir.js'
import { EventLog } from './run/events.js'
import { commitOf, currentRef, isDirty } from './run/git.js'
import { newRunId } from './run/id.js'
import { acquireLock, type Lock } from './run/lock.js'
import { type RunJson, writeRunJson } from './run/runjson.js'
import { type RunHandle, type RunInput, Runner } from './run/runner.js'
import { validateSkills } from './template/skills.js'

// Replaced at build time by tsdown; absent under vitest.
declare const __RENSA_VERSION__: string | undefined
const RENSA_VERSION = typeof __RENSA_VERSION__ === 'string' ? __RENSA_VERSION__ : 'dev'

/** Attempts at a fresh run id when one collides with an existing run directory. */
const RUN_ID_ATTEMPTS = 5
const STORAGE_HINT = 'check free space and permissions under .rensa/runs'

export interface ChainSummary {
  name: string
  description?: string
  chain?: ResolvedChain
  error?: RensaError
  /**
   * Providers used by the chain that are not `ready`. Empty while no
   * provider check has completed; show the checking state alongside.
   */
  missingProviders: ProviderStatus[]
}

export interface StartOptions {
  /** Run declared pauses as if absent. */
  noPause?: boolean
  /** The caller cannot resume a pause; a chain with pauses then needs `noPause`. */
  headless?: boolean
  /** Overrides the chain's and project's base. */
  base?: string
}

interface LoadedChain {
  name: string
  chain?: ResolvedChain
  error?: RensaError
}

/**
 * The engine's entry point: discovered config, loaded chains, provider
 * availability, and starting runs. Its emitter carries only `'providers'`;
 * every run stream lives on the run's handle.
 */
export class Engine extends EventEmitter<{ providers: [ProviderStatus[]] }> {
  private statuses: ProviderStatus[] | undefined
  private checking: Promise<ProviderStatus[]>
  /** Only the latest check may replace the stored statuses. */
  private generation = 0

  private constructor(
    private readonly discovered: Discovered,
    private readonly loaded: LoadedChain[],
    check: Promise<ProviderStatus[]>,
  ) {
    super()
    this.checking = this.track(check)
  }

  static async open(cwd: string): Promise<Engine> {
    // First, before any await: the provider checks are subprocesses and
    // the slowest part of startup, so everything below overlaps them.
    const check = checkProviders(process.env)
    const discovered = await discover(cwd)
    const loaded = await loadAllChains(discovered)
    const validated = await Promise.all(loaded.map(validateLoaded))
    return new Engine(discovered, validated, check)
  }

  /** The repository root: the directory every run executes in. */
  get root(): string {
    return this.discovered.paths.root
  }

  /** The checked-out branch, or the commit sha when `HEAD` is detached. */
  currentRef(): Promise<string> {
    return currentRef(this.root)
  }

  /** Statuses of the last completed check; undefined until the first completes. */
  providers(): ProviderStatus[] | undefined {
    return this.statuses
  }

  /** The check in flight, or the last one once it completed. Never rejects. */
  get providersChecked(): Promise<ProviderStatus[]> {
    return this.checking
  }

  /** Starts a new check; the previous statuses stay visible until it lands. */
  recheckProviders(): Promise<ProviderStatus[]> {
    this.checking = this.track(checkProviders(process.env))
    return this.checking
  }

  chains(): ChainSummary[] {
    return this.loaded.map(({ name, chain, error }) => ({
      name,
      ...(chain?.description !== undefined && { description: chain.description }),
      ...(chain && { chain }),
      ...(error && { error }),
      missingProviders: chain ? this.missingProviders(chain) : [],
    }))
  }

  chain(name: string): ResolvedChain {
    const entry = this.loaded.find((c) => c.name === name)
    if (!entry) {
      throw new RensaError(
        'CHAIN_NOT_FOUND',
        `no chain named \`${name}\` in ${this.discovered.paths.projectDir}`,
      )
    }
    if (entry.error) throw entry.error
    if (!entry.chain)
      throw new RensaError('INTERNAL', `chain \`${name}\` has neither a value nor an error`)
    return entry.chain
  }

  /**
   * Checks every precondition, creates the run and returns its handle
   * with `run.started` already emitted; the steps run asynchronously.
   * Throws a `RensaError` before anything is written when a check fails.
   */
  async start(name: string, input: RunInput, opts: StartOptions = {}): Promise<RunHandle> {
    const chain = this.chain(name)
    await this.checking
    const [missing] = this.missingProviders(chain)
    if (missing) throw unavailable(missing)
    const resolvedInput = await this.readInput(chain, input)
    if (opts.headless && !opts.noPause && chain.steps.some((s) => s.pause !== undefined)) {
      throw new RensaError(
        'CONFIG_INVALID',
        `chain \`${name}\` pauses, and nothing can resume it without a UI`,
        chain.sources.chain,
        'pass --no-pause',
      )
    }
    const { paths } = this.discovered
    // Only a write agent's edits would mix with the user's uncommitted
    // ones; shell steps still take the lock (`chain.writes`) but may run
    // on a dirty tree, so a chain can test and review a change in progress.
    if (hasWriteAgent(chain) && (await isDirty(paths.root))) {
      throw new RensaError(
        'DIRTY_TREE',
        `chain \`${name}\` has an agent with write tools, and the checkout has uncommitted changes`,
        paths.root,
        'commit or stash your changes first',
      )
    }
    const baseRef = opts.base ?? chain.base ?? (await currentRef(paths.root))
    const base = { ref: baseRef, sha: await commitOf(paths.root, baseRef) }

    const { id, runDir, lock } = await createRun(chain, paths.projectDir, paths.runsDir)
    let log: EventLog
    const runJson: RunJson = {
      id,
      chain,
      input: { kind: chain.input, ...resolvedInput },
      base,
      started_at: new Date().toISOString(),
      sessions: {},
      steps: {},
    }
    try {
      await writeRunJson(runDir.runJson, runJson)
      log = await EventLog.create(runDir.events)
    } catch (err) {
      lock?.release()
      throw storageError(err, runDir.root)
    }

    const runner = new Runner({
      id,
      runDir,
      cwd: paths.root,
      chain,
      input: resolvedInput,
      base,
      noPause: opts.noPause ?? false,
      log,
      runJson,
      ...(lock && { lock }),
      rensaVersion: RENSA_VERSION,
    })
    runner.begin()
    return runner
  }

  private track(check: Promise<ProviderStatus[]>): Promise<ProviderStatus[]> {
    const generation = ++this.generation
    return check.then((statuses) => {
      if (generation === this.generation) {
        this.statuses = statuses
        try {
          this.emit('providers', statuses)
        } catch (err) {
          diag(
            'engine',
            `providers listener threw: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
      return statuses
    })
  }

  private missingProviders(chain: ResolvedChain): ProviderStatus[] {
    const statuses = this.statuses
    if (!statuses) return []
    const used = new Set<Provider>()
    for (const step of chain.steps) if (step.kind === 'agent') used.add(step.agent.provider)
    const missing: ProviderStatus[] = []
    for (const provider of used) {
      // A provider with no registered adapter (`fake` without RENSA_DEV) was never checked.
      const status = statuses.find((s) => s.provider === provider) ?? {
        provider,
        availability: { status: 'not_installed' },
      }
      if (status.availability.status !== 'ready') missing.push(status)
    }
    return missing
  }

  private async readInput(
    chain: ResolvedChain,
    input: RunInput,
  ): Promise<{ text?: string; path?: string }> {
    const wrong = (message: string) =>
      new RensaError('INPUT_REQUIRED', `chain \`${chain.name}\` ${message}`, chain.sources.chain)
    switch (chain.input) {
      case 'none':
        if (input.kind !== 'none') throw wrong('takes no input')
        return {}
      case 'text':
        if (input.kind !== 'text' || input.text.trim() === '') throw wrong('needs text input')
        return { text: input.text }
      case 'file': {
        if (input.kind !== 'file') throw wrong('needs an input file')
        const file = path.resolve(this.discovered.paths.cwd, input.path)
        try {
          return { text: await readFile(file, 'utf8'), path: file }
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code ?? String(err)
          throw new RensaError('INPUT_REQUIRED', `cannot read input file ${file}: ${code}`, file)
        }
      }
    }
  }
}

/** Load-time checks that need adapters or skill files; the first problem replaces the chain. */
async function validateLoaded(entry: LoadedChain): Promise<LoadedChain> {
  const { chain } = entry
  if (!chain) return entry
  const caps: Partial<Record<Provider, { resume: boolean }>> = {}
  for (const adapter of allAdapters()) caps[adapter.provider] = adapter.capabilities()
  const error = validateWithAdapters(chain, caps) ?? (await validateSkills(chain))
  return error ? { name: entry.name, error } : entry
}

/** Any agent step whose resolved tools are `write`: the condition for refusing a dirty tree. */
function hasWriteAgent(chain: ResolvedChain): boolean {
  return chain.steps.some((s) => s.kind === 'agent' && s.agent.tools === 'write')
}

/**
 * A new run id, its lock when the chain writes, and its directory. An id
 * that collides with an existing run is replaced by a fresh one.
 */
async function createRun(
  chain: ResolvedChain,
  projectDir: string,
  runsDir: string,
): Promise<{ id: string; runDir: RunDir; lock?: Lock }> {
  for (let attempt = 1; ; attempt++) {
    const id = newRunId(chain.name)
    const lock = chain.writes ? await acquireLock(projectDir, id) : undefined
    try {
      const runDir = await createRunDir(runsDir, id)
      return { id, runDir, ...(lock && { lock }) }
    } catch (err) {
      lock?.release()
      const collided = (err as NodeJS.ErrnoException).code === 'EEXIST'
      if (!collided || attempt >= RUN_ID_ATTEMPTS) throw storageError(err, path.join(runsDir, id))
    }
  }
}

function unavailable({ provider, availability }: ProviderStatus): RensaError {
  switch (availability.status) {
    case 'not_logged_in':
      return new RensaError(
        'PROVIDER_UNAVAILABLE',
        `${provider} is installed but not logged in`,
        undefined,
        availability.hint,
      )
    case 'not_installed':
      return new RensaError(
        'PROVIDER_UNAVAILABLE',
        `${provider} is not available`,
        undefined,
        provider === 'fake' && process.env.RENSA_DEV !== '1'
          ? 'set RENSA_DEV=1'
          : `install the ${provider} CLI and make sure it is on PATH`,
      )
    case 'ready':
      return new RensaError('INTERNAL', `${provider} is ready but was reported missing`)
  }
}

function storageError(err: unknown, file: string): RensaError {
  const message = err instanceof Error ? err.message : String(err)
  return new RensaError('STORAGE', `cannot create the run: ${message}`, file, STORAGE_HINT)
}
