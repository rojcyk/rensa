import { cp, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest'
import { readmeRensaFiles } from '../../testing/markdown.js'
import { type TmpDir, type TmpRepo, tmpDir, tmpRepo } from '../../testing/tmpRepo.js'
import { RensaError } from '../errors.js'
import { discover } from './discover.js'
import { loadAllChains, loadChain } from './index.js'
import type { ResolvedAgent, ResolvedChain, Step } from './types.js'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const FIXTURES = path.join(ROOT, 'test/fixtures/config')

let repo: TmpRepo
let home: TmpDir
let projectDir: string
let userDir: string

beforeEach(async () => {
  repo = await tmpRepo()
  home = await tmpDir('rensa-home-')
  projectDir = path.join(repo.dir, '.rensa')
  // With no ~/.rensa and XDG_CONFIG_HOME unset, the user config dir is
  // ~/.config/rensa, which is also where docs/project.yaml points `~` skills.
  userDir = path.join(home.dir, '.config', 'rensa')
  vi.stubEnv('HOME', home.dir)
  vi.stubEnv('XDG_CONFIG_HOME', undefined)
  vi.stubEnv('GIT_DIR', undefined)
  vi.stubEnv('GIT_WORK_TREE', undefined)
  vi.stubEnv('RENSA_DEV', undefined)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all([repo.cleanup(), home.cleanup()])
})

function agentOf(step: Step | undefined): ResolvedAgent {
  assert(step?.kind === 'agent', `expected an agent step, got ${step?.kind}`)
  return step.agent
}

async function loadError(name: string): Promise<RensaError> {
  const err = await loadChain(name, await discover(repo.dir)).catch((e: unknown) => e)
  assert(err instanceof RensaError, `expected RensaError, got ${String(err)}`)
  return err
}

describe('loading the documented example chain', () => {
  it('resolves docs/chain.yaml with docs/project.yaml into the documented steps with no warnings', async () => {
    const example = path.join(FIXTURES, 'docs-example')
    await mkdir(projectDir)
    await cp(path.join(ROOT, 'docs/chain.yaml'), path.join(projectDir, 'tdd-review.yaml'))
    await cp(path.join(ROOT, 'docs/project.yaml'), path.join(projectDir, 'project.yaml'))
    await cp(path.join(example, 'agents'), path.join(projectDir, 'agents'), { recursive: true })
    await cp(path.join(example, 'steps'), path.join(projectDir, 'steps'), { recursive: true })
    await cp(path.join(example, 'skills'), path.join(userDir, 'skills'), { recursive: true })

    const chain = await loadChain('tdd-review', await discover(repo.dir))

    const summary = chain.steps.map((s) =>
      s.kind === 'shell'
        ? `${s.id}: shell \`${s.command}\` on_fail=${s.onFail}`
        : `${s.id}: ${s.agent.label} ${s.agent.session} ${s.agent.provider} ${s.agent.tools}`,
    )
    expect(summary).toEqual([
      'baseline: shell `npm test` on_fail=continue',
      'write-tests: tester named claude write',
      'implement: impl named claude write',
      'test: shell `npm test` on_fail=continue',
      'review-codex: codex fresh codex read',
      'review-grok: grok fresh grok read',
      'review-logic: logic fresh claude read',
      'fix-tests: tester named claude write',
      'fix-impl: impl named claude write',
      'retest: shell `npm test` on_fail=stop',
    ])
    const codex: ResolvedAgent = {
      provider: 'codex',
      effort: 'medium',
      tools: 'read',
      prompt: path.join(projectDir, 'agents/reviewer-correctness.md'),
      skills: [path.join(userDir, 'skills/code-review')],
      label: 'codex',
      session: 'fresh',
    }
    expect(agentOf(chain.steps[4])).toStrictEqual(codex)
    expect(chain.steps[7]).toMatchObject({ pause: 'before' })
    expect(chain).toMatchObject({
      name: 'tdd-review',
      input: 'text',
      allowApiKeys: false,
      writes: true,
      warnings: [],
      sources: { chain: path.join(projectDir, 'tdd-review.yaml') },
    })
    expect(chain.sources).toStrictEqual({
      chain: path.join(projectDir, 'tdd-review.yaml'),
      project: path.join(projectDir, 'project.yaml'),
    })
  })
})

describe("loading the README's minimal chain", () => {
  it('finds exactly the three files the 60-second start tells a user to create', async () => {
    const files = await readmeRensaFiles()

    expect([...files.keys()]).toEqual([
      '.rensa/review.yaml',
      '.rensa/agents/reviewer.md',
      '.rensa/steps/review.md',
    ])
  })

  it('resolves the README chain and prompts into one read-only claude review step with no warnings', async () => {
    for (const [file, body] of await readmeRensaFiles()) {
      await mkdir(path.dirname(path.join(repo.dir, file)), { recursive: true })
      await writeFile(path.join(repo.dir, file), body)
    }

    const chain = await loadChain('review', await discover(repo.dir))

    const review: Step = {
      id: 'review',
      kind: 'agent',
      prompt: path.join(projectDir, 'steps/review.md'),
      agent: {
        provider: 'claude',
        tools: 'read',
        prompt: path.join(projectDir, 'agents/reviewer.md'),
        skills: [],
        label: 'reviewer',
        name: 'reviewer',
        session: 'named',
      },
      vars: { diff: { kind: 'shell', value: 'git diff {{base}}' } },
      onFail: 'stop',
      timeoutMs: expect.any(Number),
    }
    expect(chain.steps).toStrictEqual([review])
    expect(chain).toMatchObject({
      name: 'review',
      description: 'Review the current diff.',
      writes: false,
      warnings: [],
    })
  })
})

describe('loading a chain through all three levels', () => {
  it('merges the user config, repo project and chain registries found by discover', async () => {
    await cp(path.join(FIXTURES, 'levels/repo/.rensa'), projectDir, { recursive: true })
    await cp(path.join(FIXTURES, 'levels/user'), userDir, { recursive: true })

    const chain = await loadChain('review', await discover(repo.dir))

    const agents: ResolvedAgent[] = [
      {
        provider: 'claude',
        tools: 'write',
        prompt: path.join(projectDir, 'agents/implementer.md'),
        skills: [],
        label: 'writer',
        name: 'writer',
        session: 'named',
      },
      {
        provider: 'claude',
        model: 'opus',
        tools: 'read',
        prompt: path.join(projectDir, 'agents/reviewer.md'),
        skills: [path.join(projectDir, 'skills/house-rules')],
        label: 'reviewer',
        name: 'reviewer',
        session: 'named',
      },
      {
        provider: 'codex',
        tools: 'read',
        prompt: path.join(userDir, 'agents/reviewer.md'),
        skills: [path.join(userDir, 'skills/code-review')],
        label: 'auditor',
        name: 'auditor',
        session: 'named',
      },
    ]
    expect(chain.steps.map(agentOf)).toStrictEqual(agents)
    const levels: Pick<ResolvedChain, 'base' | 'allowApiKeys' | 'sources'> = {
      base: 'main',
      allowApiKeys: true,
      sources: {
        chain: path.join(projectDir, 'review.yaml'),
        project: path.join(projectDir, 'project.yaml'),
        user: path.join(userDir, 'project.yaml'),
      },
    }
    expect(chain).toMatchObject(levels)
  })

  it('fails the chain with an error naming project.yaml when the repo project is invalid', async () => {
    await mkdir(projectDir)
    await writeFile(
      path.join(projectDir, 'lint.yaml'),
      'steps:\n  - id: lint\n    run: npm run lint\n',
    )
    await writeFile(path.join(projectDir, 'project.yaml'), 'allow_api_keys: "yes"\n')

    const err = await loadError('lint')

    expect(err.code).toBe('CONFIG_INVALID')
    expect(err.path).toBe('allow_api_keys')
    expect(err.message.startsWith(`${path.join(projectDir, 'project.yaml')}: `)).toBe(true)
  })
})

describe('loading every chain in a repository', () => {
  it('returns a chain for valid files and an error for broken ones without throwing', async () => {
    await mkdir(projectDir)
    await writeFile(
      path.join(projectDir, 'lint.yaml'),
      'steps:\n  - id: lint\n    run: npm run lint\n',
    )
    await writeFile(
      path.join(projectDir, 'deploy.yaml'),
      'steps:\n  - id: deploy\n    run: npm run deploy\n    when: steps.lint.passed\n',
    )
    await writeFile(
      path.join(projectDir, 'audit.yaml'),
      'steps:\n  - id: audit\n   run: npm audit\n',
    )

    const results = await loadAllChains(await discover(repo.dir))

    expect(results.map((r) => r.name)).toEqual(['audit', 'deploy', 'lint'])
    const [audit, deploy, lint] = results
    expect(audit?.error?.code).toBe('CONFIG_PARSE')
    expect(audit?.error?.path).toBe(path.join(projectDir, 'audit.yaml'))
    expect(deploy?.error?.code).toBe('CONFIG_INVALID')
    expect(deploy?.error?.path).toBe('steps[0].when')
    expect(lint?.error).toBeUndefined()
    expect(lint?.chain?.steps.map((s) => s.id)).toEqual(['lint'])
  })

  it('rejects with CHAIN_NOT_FOUND when no chain file has the requested name', async () => {
    await mkdir(projectDir)
    await writeFile(
      path.join(projectDir, 'lint.yaml'),
      'steps:\n  - id: lint\n    run: npm run lint\n',
    )

    const err = await loadError('deploy')

    expect(err.code).toBe('CHAIN_NOT_FOUND')
  })
})
