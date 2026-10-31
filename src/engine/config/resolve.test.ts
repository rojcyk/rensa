import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest'
import { type TmpDir, tmpDir } from '../../testing/tmpRepo.js'
import { RensaError } from '../errors.js'
import { classifyVar, deriveLabels, parseTimeout, resolveChain } from './resolve.js'
import type {
  Effort,
  Provider,
  RawAgent,
  RawAgentRef,
  RawChain,
  RawProject,
  RawStep,
  ResolvedAgent,
  ShellStep,
  VarSpec,
} from './types.js'
import type { UnvalidatedChain } from './validate.js'

// Declaring files live in the fixture tree so relative prompt, persona and
// skill paths resolve to real files. The YAML files themselves are not read
// here: resolveChain takes already-parsed raw objects.
const LEVELS = path.resolve(import.meta.dirname, '../../../test/fixtures/config/levels')
const USER_DIR = path.join(LEVELS, 'user')
const REPO_DIR = path.join(LEVELS, 'repo', '.rensa')
const USER_FILE = path.join(USER_DIR, 'project.yaml')
const PROJECT_FILE = path.join(REPO_DIR, 'project.yaml')
const CHAIN_FILE = path.join(REPO_DIR, 'review.yaml')

interface Levels {
  chain: RawChain
  project?: RawProject
  user?: RawProject
  name?: string
}

function resolve({ chain, project, user, name = 'review' }: Levels): Promise<UnvalidatedChain> {
  return resolveChain({
    name,
    chain: { raw: chain, file: CHAIN_FILE },
    ...(project && { project: { raw: project, file: PROJECT_FILE } }),
    ...(user && { user: { raw: user, file: USER_FILE } }),
  })
}

async function resolveError(levels: Levels): Promise<RensaError> {
  const err = await resolve(levels).catch((e: unknown) => e)
  assert(err instanceof RensaError, `expected RensaError, got ${String(err)}`)
  expect(err.code).toBe('CONFIG_INVALID')
  return err
}

function shellStep(overrides: Partial<RawStep> = {}): RawStep {
  return { id: 'lint', run: 'npm run lint', ...overrides }
}

function agentStep(agent: RawAgentRef, overrides: Partial<RawStep> = {}): RawStep {
  return { id: 'review', prompt: 'steps/review.md', agents: [agent], ...overrides }
}

function chainOf(steps: RawStep[], extra: Partial<RawChain> = {}): RawChain {
  return { steps, ...extra }
}

/**
 * A chain carrying a registry whose single entry its one step uses by
 * name. Entries are checked only when a step uses them.
 */
function registryChain(agents: Record<string, RawAgent>): RawChain {
  const [name] = Object.keys(agents)
  assert(name !== undefined && Object.keys(agents).length === 1, 'expected exactly one entry')
  return chainOf([agentStep(name)], { agents })
}

function agentAt(chain: UnvalidatedChain, i = 0): ResolvedAgent {
  const step = chain.steps[i]
  assert(step?.kind === 'agent', `steps[${i}] is not an agent step`)
  return step.agent
}

const CLAUDE_READ: RawAgent = { provider: 'claude', tools: 'read' }

beforeEach(() => {
  // `fake` is accepted only with RENSA_DEV=1; make sure the outer shell
  // cannot turn it on for tests that expect it rejected.
  vi.stubEnv('RENSA_DEV', undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('agent registry across user, repo and chain levels', () => {
  const user: RawProject = {
    agents: {
      reviewer: {
        provider: 'codex',
        effort: 'max',
        tools: 'read',
        prompt: 'agents/reviewer.md',
        skills: ['skills/code-review'],
      },
      auditor: { provider: 'codex', tools: 'read', prompt: 'agents/reviewer.md' },
    },
  }
  const project: RawProject = {
    agents: {
      reviewer: { provider: 'grok', tools: 'read' },
      writer: { provider: 'claude', tools: 'write', prompt: 'agents/implementer.md' },
    },
  }

  it('takes each name from the nearest level and resolves paths against the declaring file', async () => {
    const chain = chainOf(
      [
        agentStep('writer', { id: 'implement', prompt: 'steps/implement.md' }),
        agentStep('reviewer', { id: 'review' }),
        agentStep('auditor', { id: 'audit' }),
      ],
      {
        agents: {
          reviewer: {
            provider: 'claude',
            model: 'opus',
            tools: 'read',
            prompt: 'agents/reviewer.md',
            skills: ['skills/house-rules'],
          },
        },
      },
    )

    const resolved = await resolve({ chain, project, user })

    const writer: ResolvedAgent = {
      provider: 'claude',
      tools: 'write',
      prompt: path.join(REPO_DIR, 'agents/implementer.md'),
      skills: [],
      label: 'writer',
      name: 'writer',
      session: 'named',
    }
    // The chain's entry replaces the whole user entry: no effort or user skills leak in.
    const reviewer: ResolvedAgent = {
      provider: 'claude',
      model: 'opus',
      tools: 'read',
      prompt: path.join(REPO_DIR, 'agents/reviewer.md'),
      skills: [path.join(REPO_DIR, 'skills/house-rules')],
      label: 'reviewer',
      name: 'reviewer',
      session: 'named',
    }
    const auditor: ResolvedAgent = {
      provider: 'codex',
      tools: 'read',
      prompt: path.join(USER_DIR, 'agents/reviewer.md'),
      skills: [],
      label: 'auditor',
      name: 'auditor',
      session: 'named',
    }
    expect(resolved.steps.map((_, i) => agentAt(resolved, i))).toEqual([writer, reviewer, auditor])
  })

  it('replaces the whole user entry with the repo entry when the chain does not define the name', async () => {
    const chain = chainOf([agentStep('reviewer')])

    const resolved = await resolve({ chain, project, user })

    const expected: ResolvedAgent = {
      provider: 'grok',
      tools: 'read',
      skills: [],
      label: 'reviewer',
      name: 'reviewer',
      session: 'named',
    }
    expect(agentAt(resolved)).toEqual(expected)
  })

  it('does not check a user entry that a nearer level replaces, even when it is invalid', async () => {
    const brokenUser: RawProject = {
      agents: { reviewer: { provider: 'codex', tools: 'read', prompt: 'agents/missing.md' } },
    }
    const chain = chainOf([agentStep('reviewer')])

    const resolved = await resolve({ chain, project, user: brokenUser })

    expect(agentAt(resolved).provider).toBe('grok')
  })

  it('names the user project file and dotted path when a used user-level entry is invalid', async () => {
    const brokenUser: RawProject = {
      agents: { auditor: { provider: 'codex', tools: 'read', prompt: 'agents/missing.md' } },
    }

    const err = await resolveError({ chain: chainOf([agentStep('auditor')]), user: brokenUser })

    expect(err.path).toBe('agents.auditor.prompt')
    expect(err.message).toBe(
      `${USER_FILE}: file not found: ${path.join(USER_DIR, 'agents/missing.md')}`,
    )
  })

  it('ignores a broken registry entry that no step uses', async () => {
    const brokenUser: RawProject = {
      agents: {
        stale: { provider: 'codex', prompt: 'agents/missing.md', skills: ['skills/gone'] },
      },
    }

    const resolved = await resolve({ chain: chainOf([shellStep()]), user: brokenUser })

    expect(resolved.steps).toHaveLength(1)
  })

  it('lets a from override replace a registry prompt that no longer exists', async () => {
    const brokenUser: RawProject = {
      agents: { auditor: { provider: 'codex', tools: 'read', prompt: 'agents/missing.md' } },
    }
    const chain = chainOf([agentStep({ from: 'auditor', prompt: 'agents/implementer.md' })])

    const resolved = await resolve({ chain, user: brokenUser })

    expect(agentAt(resolved).prompt).toBe(path.join(REPO_DIR, 'agents/implementer.md'))
  })

  it('still reports the copied registry path when a from override leaves it in place', async () => {
    const brokenUser: RawProject = {
      agents: { auditor: { provider: 'codex', tools: 'read', prompt: 'agents/missing.md' } },
    }
    const chain = chainOf([agentStep({ from: 'auditor', model: 'gpt-5.2-codex' })])

    const err = await resolveError({ chain, user: brokenUser })

    expect(err.path).toBe('agents.auditor.prompt')
    expect(err.message).toContain(USER_FILE)
  })
})

describe('step agents listed with from', () => {
  const user: RawProject = {
    agents: {
      auditor: {
        provider: 'codex',
        effort: 'medium',
        tools: 'read',
        prompt: 'agents/reviewer.md',
        skills: ['skills/code-review'],
      },
    },
  }

  it('copies the registry entry as a fresh agent with inline fields overriding copied ones', async () => {
    const chain = chainOf([agentStep({ from: 'auditor', effort: 'max', model: 'gpt-5.2-codex' })])

    const resolved = await resolve({ chain, user })

    const expected: ResolvedAgent = {
      provider: 'codex',
      model: 'gpt-5.2-codex',
      effort: 'max',
      tools: 'read',
      prompt: path.join(USER_DIR, 'agents/reviewer.md'),
      skills: [path.join(USER_DIR, 'skills/code-review')],
      label: 'auditor',
      session: 'fresh',
    }
    expect(agentAt(resolved)).toStrictEqual(expected)
  })

  it('resolves an overriding prompt against the chain file, not the registry entry file', async () => {
    const chain = chainOf([agentStep({ from: 'auditor', prompt: 'agents/implementer.md' })])

    const resolved = await resolve({ chain, user })

    expect(agentAt(resolved).prompt).toBe(path.join(REPO_DIR, 'agents/implementer.md'))
  })

  it('reports steps[i].agents[0].from when the named entry does not exist', async () => {
    const chain = chainOf([shellStep(), agentStep({ from: 'ghost' })])

    const err = await resolveError({ chain, user })

    expect(err.path).toBe('steps[1].agents[0].from')
    expect(err.message).toContain('unknown agent `ghost`')
  })

  it('reports the override effort path when the override asks grok for max', async () => {
    const chain = chainOf([agentStep({ from: 'grok', effort: 'max' })], {
      agents: { grok: { provider: 'grok', tools: 'read' } },
    })

    const err = await resolveError({ chain })

    expect(err.path).toBe('steps[0].agents[0].effort')
    expect(err.message).toBe(`${CHAIN_FILE}: grok does not support effort: max (agent \`grok\`)`)
  })
})

describe('step agents written inline', () => {
  it('builds a fresh agent labelled by provider with the persona resolved against the chain file', async () => {
    const chain = chainOf([
      agentStep({
        provider: 'claude',
        model: 'sonnet',
        effort: 'low',
        tools: 'read',
        prompt: 'agents/reviewer.md',
      }),
    ])

    const resolved = await resolve({ chain })

    const expected: ResolvedAgent = {
      provider: 'claude',
      model: 'sonnet',
      effort: 'low',
      tools: 'read',
      prompt: path.join(REPO_DIR, 'agents/reviewer.md'),
      skills: [],
      label: 'claude',
      session: 'fresh',
    }
    expect(agentAt(resolved)).toStrictEqual(expected)
  })

  it.each([
    ['provider', { tools: 'read' }],
    ['tools', { provider: 'claude' }],
  ] as const)('reports steps[i].agents[0] when the inline agent lacks %s', async (_, agent) => {
    const err = await resolveError({ chain: chainOf([agentStep(agent)]) })

    expect(err.path).toBe('steps[0].agents[0]')
  })
})

describe('step agents listed by name', () => {
  it('reports steps[i].agents[0] when the name is not in any registry', async () => {
    const chain = chainOf([agentStep('impl')], { agents: { reviewer: CLAUDE_READ } })

    const err = await resolveError({ chain })

    expect(err.path).toBe('steps[0].agents[0]')
    expect(err.message).toBe(
      `${CHAIN_FILE}: unknown agent \`impl\` at steps[0].agents[0]; known agents: reviewer`,
    )
  })
})

describe('registry entry fields', () => {
  it('reports the entry path when provider is missing', async () => {
    const err = await resolveError({ chain: registryChain({ impl: { tools: 'write' } }) })

    expect(err.path).toBe('agents.impl')
  })

  it('rejects provider fake as unknown when RENSA_DEV is not 1', async () => {
    const err = await resolveError({
      chain: registryChain({ impl: { provider: 'fake', tools: 'write' } }),
    })

    expect(err.path).toBe('agents.impl.provider')
    expect(err.message).toContain('unknown provider `fake`')
  })

  it('accepts provider fake when RENSA_DEV is 1', async () => {
    vi.stubEnv('RENSA_DEV', '1')
    const chain = chainOf([agentStep('impl')], {
      agents: { impl: { provider: 'fake', tools: 'write' } },
    })

    const resolved = await resolve({ chain })

    expect(agentAt(resolved).provider).toBe('fake')
  })

  // Translation to the provider's value (codex max -> xhigh) is the
  // adapter's job; the resolved config keeps rensa's level.
  it.each<[Provider, Effort]>([
    ['claude', 'max'],
    ['codex', 'max'],
    ['codex', 'low'],
    ['grok', 'high'],
  ])('keeps %s effort %s as the canonical level', async (provider, effort) => {
    const chain = chainOf([agentStep('impl')], {
      agents: { impl: { provider, effort, tools: 'read' } },
    })

    const resolved = await resolve({ chain })

    expect(agentAt(resolved).effort).toBe(effort)
  })

  it('reports the effort path with the spec message when grok is asked for max', async () => {
    const chain = registryChain({ grok: { provider: 'grok', effort: 'max', tools: 'read' } })

    const err = await resolveError({ chain })

    expect(err.path).toBe('agents.grok.effort')
    expect(err.message).toBe(`${CHAIN_FILE}: grok does not support effort: max (agent \`grok\`)`)
  })

  it('reports the entry path when tools is missing', async () => {
    const err = await resolveError({ chain: registryChain({ impl: { provider: 'claude' } }) })

    expect(err.path).toBe('agents.impl')
  })

  it.each([
    ['does not exist', 'agents/missing.md'],
    ['is a directory', 'agents'],
  ])('reports the prompt path when the persona file %s', async (_, prompt) => {
    const chain = registryChain({ impl: { ...CLAUDE_READ, prompt } })

    const err = await resolveError({ chain })

    expect(err.path).toBe('agents.impl.prompt')
    expect(err.message).toBe(`${CHAIN_FILE}: file not found: ${path.join(REPO_DIR, prompt)}`)
  })

  it('reports the skills index when a skill directory does not exist', async () => {
    const chain = registryChain({ impl: { ...CLAUDE_READ, skills: ['skills/missing'] } })

    const err = await resolveError({ chain })

    expect(err.path).toBe('agents.impl.skills[0]')
  })

  it('reports the skills index when a skill directory has no SKILL.md', async () => {
    const chain = registryChain({
      impl: { ...CLAUDE_READ, skills: ['skills/house-rules', 'skills/notes-only'] },
    })

    const err = await resolveError({ chain })

    expect(err.path).toBe('agents.impl.skills[1]')
    expect(err.message).toContain(path.join(REPO_DIR, 'skills/notes-only'))
  })
})

describe('home directory expansion in agent paths', () => {
  let home: TmpDir

  beforeEach(async () => {
    home = await tmpDir('rensa-home-')
    vi.stubEnv('HOME', home.dir)
  })

  afterEach(async () => {
    await home.cleanup()
  })

  it('expands a leading ~ in prompt and skills to the home directory', async () => {
    await mkdir(path.join(home.dir, 'rensa/skills/code-review'), { recursive: true })
    await writeFile(path.join(home.dir, 'rensa/persona.md'), 'You review diffs.\n')
    await writeFile(path.join(home.dir, 'rensa/skills/code-review/SKILL.md'), '# code-review\n')
    const chain = chainOf([agentStep('impl')], {
      agents: {
        impl: {
          ...CLAUDE_READ,
          prompt: '~/rensa/persona.md',
          skills: ['~/rensa/skills/code-review'],
        },
      },
    })

    const resolved = await resolve({ chain })

    const agent = agentAt(resolved)
    expect(agent.prompt).toBe(path.join(home.dir, 'rensa/persona.md'))
    expect(agent.skills).toEqual([path.join(home.dir, 'rensa/skills/code-review')])
  })
})

describe('step shapes', () => {
  it('resolves a run step to a shell step with on_fail stop and a one hour timeout by default', async () => {
    const resolved = await resolve({ chain: chainOf([shellStep()]) })

    const expected: ShellStep = {
      id: 'lint',
      kind: 'shell',
      command: 'npm run lint',
      onFail: 'stop',
      timeoutMs: 3_600_000,
    }
    expect(resolved.steps).toStrictEqual([expected])
  })

  it('resolves an agent step with its prompt made absolute against the chain file', async () => {
    const chain = chainOf(
      [agentStep('impl', { on_fail: 'continue', timeout: '20m', pause: 'before' })],
      { agents: { impl: CLAUDE_READ } },
    )

    const resolved = await resolve({ chain })

    expect(resolved.steps[0]).toMatchObject({
      id: 'review',
      kind: 'agent',
      prompt: path.join(REPO_DIR, 'steps/review.md'),
      vars: {},
      onFail: 'continue',
      timeoutMs: 1_200_000,
      pause: 'before',
    })
  })

  it.each<[string, RawStep]>([
    ['run with prompt', { id: 'mixed', run: 'npm test', prompt: 'steps/review.md' }],
    ['run with agents', { id: 'mixed', run: 'npm test', agents: ['impl'] }],
    ['prompt without agents', { id: 'half', prompt: 'steps/review.md' }],
    ['agents without prompt', { id: 'half', agents: ['impl'] }],
    ['neither run nor prompt', { id: 'empty', on_fail: 'continue' }],
  ])('reports steps[i] when a step has %s', async (_, step) => {
    const chain = chainOf([shellStep(), step], { agents: { impl: CLAUDE_READ } })

    const err = await resolveError({ chain })

    expect(err.path).toBe('steps[1]')
  })

  it.each(['review codex', 'review.codex', 'résumé', ''])(
    'reports steps[i].id when the id is %j',
    async (id) => {
      const err = await resolveError({ chain: chainOf([shellStep({ id })]) })

      expect(err.path).toBe('steps[0].id')
    },
  )

  it.each<[string, RawAgentRef[]]>([
    ['no agents', []],
    ['two agents', ['impl', 'impl']],
  ])('reports steps[i].agents when an agent step lists %s', async (_, agents) => {
    const chain = chainOf([agentStep('impl', { agents })], { agents: { impl: CLAUDE_READ } })

    const err = await resolveError({ chain })

    expect(err.path).toBe('steps[0].agents')
  })

  it('reports steps[i].prompt when the step prompt file does not exist', async () => {
    const chain = chainOf([agentStep('impl', { prompt: 'steps/missing.md' })], {
      agents: { impl: CLAUDE_READ },
    })

    const err = await resolveError({ chain })

    expect(err.path).toBe('steps[0].prompt')
    expect(err.message).toBe(
      `${CHAIN_FILE}: file not found: ${path.join(REPO_DIR, 'steps/missing.md')}`,
    )
  })

  // The schema only checks the `<digits><unit>` shape; zero is caught here.
  it('reports steps[i].timeout when the timeout is zero', async () => {
    const err = await resolveError({ chain: chainOf([shellStep({ timeout: '0s' })]) })

    expect(err.path).toBe('steps[0].timeout')
    expect(err.message).toContain('invalid timeout `0s`')
  })

  it.each<[string, Partial<RawStep>]>([
    ['tools', { tools: 'read' }],
    ['vars', { vars: { target: 'main' } }],
  ])('reports steps[i].%s when a run step sets it', async (key, overrides) => {
    const err = await resolveError({ chain: chainOf([shellStep(overrides)]) })

    expect(err.path).toBe(`steps[0].${key}`)
  })
})

describe('step tools narrowing', () => {
  const agents: Record<string, RawAgent> = {
    impl: { provider: 'claude', tools: 'write' },
    reviewer: CLAUDE_READ,
  }

  it('narrows a write agent to read in a read step', async () => {
    const chain = chainOf([agentStep('impl', { tools: 'read' })], { agents })

    const resolved = await resolve({ chain })

    expect(agentAt(resolved).tools).toBe('read')
  })

  it('keeps a write agent at write in a write step', async () => {
    const chain = chainOf([agentStep('impl', { tools: 'write' })], { agents })

    const resolved = await resolve({ chain })

    expect(agentAt(resolved).tools).toBe('write')
  })

  it('reports steps[i].agents[0] when a write step lists a read agent', async () => {
    const chain = chainOf([agentStep('reviewer', { tools: 'write' })], { agents })

    const err = await resolveError({ chain })

    expect(err.path).toBe('steps[0].agents[0]')
  })
})

describe('step vars', () => {
  const agents: Record<string, RawAgent> = { reviewer: CLAUDE_READ }

  it('classifies each var as shell, ref or literal by its syntax', async () => {
    const chain = chainOf(
      [
        agentStep('reviewer', {
          vars: {
            diff: '$(git diff {{base}})',
            baseline: 'steps.baseline.output',
            tone: 'blunt',
          },
        }),
      ],
      { agents },
    )

    const resolved = await resolve({ chain })

    const expected: Record<string, VarSpec> = {
      diff: { kind: 'shell', value: 'git diff {{base}}' },
      baseline: { kind: 'ref', value: 'steps.baseline.output' },
      tone: { kind: 'literal', value: 'blunt' },
    }
    expect(resolved.steps[0]).toMatchObject({ vars: expected })
  })

  it.each(['2fast', 'test output', 'diff.full'])(
    'reports steps[i].vars.<name> when the var name is %j',
    async (name) => {
      const chain = chainOf([agentStep('reviewer', { vars: { [name]: 'main' } })], { agents })

      const err = await resolveError({ chain })

      expect(err.path).toBe(`steps[0].vars.${name}`)
    },
  )

  it.each(['input', 'input_path', 'base', 'run_id', 'steps'])(
    'rejects a var named %j because it would shadow the namespace',
    async (name) => {
      const chain = chainOf([agentStep('reviewer', { vars: { [name]: 'main' } })], { agents })

      const err = await resolveError({ chain })

      expect(err.path).toBe(`steps[0].vars.${name}`)
      expect(err.message).toContain('reserved')
    },
  )

  // YAML parses `__proto__` as an own key; it must stay a declared var.
  it('keeps a var named __proto__ as an own declared var', async () => {
    const vars: Record<string, string> = {}
    Object.defineProperty(vars, '__proto__', { value: 'main', enumerable: true })
    const chain = chainOf([agentStep('reviewer', { vars })], { agents })

    const resolved = await resolve({ chain })

    const step = resolved.steps[0]
    assert(step?.kind === 'agent')
    expect(Object.keys(step.vars)).toEqual(['__proto__'])
  })
})

describe('chain-level fields', () => {
  it('reports name when the name key differs from the file stem', async () => {
    const err = await resolveError({ chain: chainOf([shellStep()], { name: 'reveiw' }) })

    expect(err.path).toBe('name')
    expect(err.message).toBe(
      `${CHAIN_FILE}: \`name: reveiw\` does not match the file name \`review\``,
    )
  })

  it.each(['tdd review', 'review.v2', '../review', 'rëview', ''])(
    'rejects the chain name %j when the file stem has characters outside letters, digits, _ and -',
    async (name) => {
      const err = await resolveError({ chain: chainOf([shellStep()]), name })

      expect(err.path).toBe('')
      expect(err.message).toBe(
        `${CHAIN_FILE}: chain name \`${name}\` may contain only letters, digits, \`_\` and \`-\`; rename the file`,
      )
    },
  )

  it('accepts a chain name of mixed-case letters, digits, _ and -', async () => {
    const resolved = await resolve({ chain: chainOf([shellStep()]), name: 'TDD_review-2' })

    expect(resolved.name).toBe('TDD_review-2')
  })

  it('accepts a name key equal to the file stem and keeps the description', async () => {
    const chain = chainOf([shellStep()], { name: 'review', description: 'Lint the repo.' })

    const resolved = await resolve({ chain })

    expect(resolved.name).toBe('review')
    expect(resolved.description).toBe('Lint the repo.')
  })

  it('defaults input to none when the chain omits it', async () => {
    const resolved = await resolve({ chain: chainOf([shellStep()]) })

    expect(resolved.input).toBe('none')
  })

  it.each<[string, Partial<Levels>, string | undefined]>([
    ['the chain', { chain: chainOf([shellStep()], { base: 'release' }) }, 'release'],
    ['the repo project', {}, 'main'],
    ['the user project', { project: {} }, 'develop'],
    ['nowhere', { project: {}, user: {} }, undefined],
  ])('takes base from %s when nearer levels omit it', async (_, overrides, base) => {
    const levels: Levels = {
      chain: chainOf([shellStep()]),
      project: { base: 'main' },
      user: { base: 'develop' },
      ...overrides,
    }

    const resolved = await resolve(levels)

    expect(resolved.base).toBe(base)
  })

  it.each<[string, RawProject | undefined, RawProject | undefined, boolean]>([
    ['repo false over user true', { allow_api_keys: false }, { allow_api_keys: true }, false],
    ['user true when repo omits it', {}, { allow_api_keys: true }, true],
    ['false when no level sets it', undefined, undefined, false],
  ])('resolves allowApiKeys from %s', async (_, project, user, expected) => {
    const resolved = await resolve({
      chain: chainOf([shellStep()]),
      ...(project && { project }),
      ...(user && { user }),
    })

    expect(resolved.allowApiKeys).toBe(expected)
  })

  it('records the source file of each level that was supplied', async () => {
    const resolved = await resolve({ chain: chainOf([shellStep()]), project: {}, user: {} })

    expect(resolved.sources).toEqual({ chain: CHAIN_FILE, project: PROJECT_FILE, user: USER_FILE })
  })

  it('records only the chain source when no project files exist', async () => {
    const resolved = await resolve({ chain: chainOf([shellStep()]) })

    expect(resolved.sources).toStrictEqual({ chain: CHAIN_FILE })
  })
})

describe('agent label derivation', () => {
  it.each<[string, string[], string[]]>([
    ['no agents', [], []],
    ['distinct bases', ['impl', 'codex', 'claude'], ['impl', 'codex', 'claude']],
    ['a repeated base', ['claude', 'claude', 'codex'], ['claude', 'claude-2', 'codex']],
    ['three of one base', ['claude', 'claude', 'claude'], ['claude', 'claude-2', 'claude-3']],
    [
      'a base that collides with a suffixed label',
      ['claude', 'claude-2', 'claude'],
      ['claude', 'claude-2', 'claude-3'],
    ],
  ])('suffixes repeats with -2, -3 in order given %s', (_, bases, labels) => {
    expect(deriveLabels(bases)).toEqual(labels)
  })

  it('labels a named agent by its registry name and a from agent by the from name', async () => {
    const chain = chainOf(
      [agentStep('reviewer', { id: 'first' }), agentStep({ from: 'reviewer' }, { id: 'second' })],
      { agents: { reviewer: CLAUDE_READ } },
    )

    const resolved = await resolve({ chain })

    expect([agentAt(resolved, 0).label, agentAt(resolved, 1).label]).toEqual([
      'reviewer',
      'reviewer',
    ])
  })
})

describe('timeout parsing', () => {
  it.each([
    ['90s', 90_000],
    ['20m', 1_200_000],
    ['2h', 7_200_000],
    ['05m', 300_000],
  ])('parses %s to %i ms', (value, ms) => {
    expect(parseTimeout(value)).toBe(ms)
  })

  it.each(['0s', '0m', '1.5h', '10', 'm', '-5m', '20M', '20 m', ' 20m', '20d', ''])(
    'returns undefined for %j',
    (value) => {
      expect(parseTimeout(value)).toBeUndefined()
    },
  )
})

describe('var classification by syntax', () => {
  it.each<[string, VarSpec]>([
    ['$(git diff {{base}})', { kind: 'shell', value: 'git diff {{base}}' }],
    [
      '$(git log --oneline\n  | head -5)',
      { kind: 'shell', value: 'git log --oneline\n  | head -5' },
    ],
    ['$()', { kind: 'shell', value: '' }],
    ['steps.baseline.output', { kind: 'ref', value: 'steps.baseline.output' }],
    ['steps.review-codex.output', { kind: 'ref', value: 'steps.review-codex.output' }],
    ['steps.draft.output.codex', { kind: 'ref', value: 'steps.draft.output.codex' }],
    // Only `steps.` paths are refs; other dotted values are literals.
    ['input.text', { kind: 'literal', value: 'input.text' }],
    ['README.md', { kind: 'literal', value: 'README.md' }],
    ['package.json', { kind: 'literal', value: 'package.json' }],
    ['example.com', { kind: 'literal', value: 'example.com' }],
    ['v1.2.3', { kind: 'literal', value: 'v1.2.3' }],
    ['feat.add-logging', { kind: 'literal', value: 'feat.add-logging' }],
    ['Steps.a.output', { kind: 'literal', value: 'Steps.a.output' }],
    ['main', { kind: 'literal', value: 'main' }],
    ['$(git diff', { kind: 'literal', value: '$(git diff' }],
    ['Focus on error handling.', { kind: 'literal', value: 'Focus on error handling.' }],
    ['steps.', { kind: 'literal', value: 'steps.' }],
    ['', { kind: 'literal', value: '' }],
    // YAML block scalars (`|`, `>`) end in a newline.
    ['$(git diff {{base}})\n', { kind: 'shell', value: 'git diff {{base}}' }],
    ['  $(git log\n  | head -5)\n', { kind: 'shell', value: 'git log\n  | head -5' }],
    ['steps.baseline.output\n', { kind: 'ref', value: 'steps.baseline.output' }],
    ['Focus on errors.\n', { kind: 'literal', value: 'Focus on errors.\n' }],
  ])('classifies %j', (value, spec) => {
    expect(classifyVar(value)).toEqual(spec)
  })
})
