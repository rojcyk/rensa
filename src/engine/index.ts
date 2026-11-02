// Shutdown callbacks run last-registered first. At exit the intended
// sequence is terminal restore (registered by the TUI, last), SIGKILL
// to live child groups, lock release. Children are signalled, not
// awaited, before the lock goes. So the lock must register before the kill:
// step 08's `import './run/lock.js'` goes above this line, and lock.ts
// must not import process/spawn.js, directly or transitively.
import './process/spawn.js'

export type { ProviderStatus } from './adapters/available.js'
export type { AgentProcess, Availability, Capabilities } from './adapters/types.js'
export { type ChainFile, type Discovered, discover, ensureProjectDir } from './config/discover.js'
export { EFFORT } from './config/effort.js'
export { loadAllChains, loadChain } from './config/index.js'
export { type Paths, resolvePaths, userConfigDir } from './config/paths.js'
export type {
  AgentConfig,
  AgentStep,
  Effort,
  Provider,
  ResolvedAgent,
  ResolvedChain,
  ShellStep,
  Step,
  Tools,
  VarSpec,
} from './config/types.js'
export { validateWithAdapters } from './config/validate.js'
export { type DiagEntry, diag, drainDiag, onDiag } from './diag.js'
export { RensaError, type RensaErrorCode } from './errors.js'
export { onInterrupt, onShutdown } from './process/shutdown.js'
export { type AgentFileName, openRunDir, type RunDir } from './run/dir.js'
export { type ReadEvents, readEvents } from './run/events.js'
export { type RunJson, readRunJson } from './run/runjson.js'
export { type ReadTranscript, readTranscript } from './run/transcript.js'
export type {
  AgentError,
  RunEvent,
  RunEventType,
  RunStatus,
  StepStatus,
  TranscriptRecord,
  Usage,
} from './run/types.js'
