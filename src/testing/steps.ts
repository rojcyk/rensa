import type { AgentStep, ResolvedAgent, ResolvedChain, ShellStep } from '../engine/index.js'

// Typed builders for resolved chains, for UI tests that render a chain
// without loading YAML. Defaults are what the resolver produces for a
// step that sets nothing else.

const TEN_MINUTES_MS = 600_000

export function shellStep(
  id: string,
  command: string,
  overrides: Partial<ShellStep> = {},
): ShellStep {
  return { id, kind: 'shell', command, onFail: 'stop', timeoutMs: TEN_MINUTES_MS, ...overrides }
}

export function agentStep(
  id: string,
  agent: Partial<ResolvedAgent> & Pick<ResolvedAgent, 'label' | 'provider'>,
  overrides: Partial<AgentStep> = {},
): AgentStep {
  return {
    id,
    kind: 'agent',
    prompt: `/Users/ryowa/Repos/trezor-suite/.rensa/steps/${id}.md`,
    agent: { tools: 'read', skills: [], session: 'fresh', ...agent },
    vars: {},
    onFail: 'stop',
    timeoutMs: TEN_MINUTES_MS,
    ...overrides,
  }
}

export function resolvedChain(
  name: string,
  steps: ResolvedChain['steps'],
  overrides: Partial<ResolvedChain> = {},
): ResolvedChain {
  return {
    name,
    input: 'text',
    allowApiKeys: false,
    steps,
    writes: steps.some((s) => s.kind === 'shell' || s.agent.tools === 'write'),
    warnings: [],
    sources: { chain: `/Users/ryowa/Repos/trezor-suite/.rensa/${name}.yaml` },
    ...overrides,
  }
}
