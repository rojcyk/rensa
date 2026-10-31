import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, assert, beforeEach, describe, expect, it } from 'vitest'
import { type TmpDir, tmpDir } from '../../testing/tmpRepo.js'
import { RensaError } from '../errors.js'
import type { AgentStep, ResolvedAgent, ResolvedChain, ShellStep, Step, VarSpec } from './types.js'
import { type UnvalidatedChain, validateChain, validateWithAdapters } from './validate.js'

function agent(overrides: Partial<ResolvedAgent> = {}): ResolvedAgent {
  return {
    provider: 'claude',
    tools: 'read',
    skills: [],
    label: 'reviewer',
    name: 'reviewer',
    session: 'named',
    ...overrides,
  }
}

function agentStep(id: string, prompt: string, overrides: Partial<AgentStep> = {}): AgentStep {
  return {
    id,
    kind: 'agent',
    prompt,
    agent: agent(),
    vars: {},
    onFail: 'stop',
    timeoutMs: 3_600_000,
    ...overrides,
  }
}

function shellStep(id: string): ShellStep {
  return { id, kind: 'shell', command: 'npm test', onFail: 'continue', timeoutMs: 3_600_000 }
}

const shell = (value: string): VarSpec => ({ kind: 'shell', value })
const ref = (value: string): VarSpec => ({ kind: 'ref', value })
const literal = (value: string): VarSpec => ({ kind: 'literal', value })

// ---------------------------------------------------------------------------
// Resolved chain checks: prompts are real files in a temp dir so each test
// shows the prompt text it validates.
// ---------------------------------------------------------------------------

describe('resolved chain validation', () => {
  let dir: TmpDir
  let chainFile: string

  beforeEach(async () => {
    dir = await tmpDir('rensa-validate-')
    chainFile = path.join(dir.dir, 'review.yaml')
  })

  afterEach(async () => {
    await dir.cleanup()
  })

  async function promptFile(name: string, text: string): Promise<string> {
    const file = path.join(dir.dir, name)
    await writeFile(file, text)
    return file
  }

  function chainOf(steps: Step[], overrides: Partial<UnvalidatedChain> = {}): UnvalidatedChain {
    return {
      name: 'review',
      input: 'text',
      allowApiKeys: false,
      steps,
      sources: { chain: chainFile },
      ...overrides,
    }
  }

  async function validationError(chain: UnvalidatedChain): Promise<RensaError> {
    const err = await validateChain(chain).catch((e: unknown) => e)
    assert(err instanceof RensaError, `expected RensaError, got ${String(err)}`)
    expect(err.code).toBe('CONFIG_INVALID')
    return err
  }

  describe('placeholders', () => {
    it('accepts declared vars, built-ins and earlier step fields, ignoring single braces', async () => {
      const prompt = await promptFile(
        'review.md',
        [
          'Run {{run_id}} against {{base}} for: {{input}}',
          '{{ diff }}',
          '{{steps.baseline.output}} {{steps.baseline.passed}}',
          '{{steps.baseline.exit_code}} {{steps.draft.output}} {{steps.draft.text}}',
          'Format as {"verdict": "..."} and keep {tone} literal.',
        ].join('\n'),
      )
      const persona = await promptFile('persona.md', 'Be {{tone}}.')
      const draftPrompt = await promptFile('draft.md', 'Draft it.')
      const chain = chainOf([
        shellStep('baseline'),
        agentStep('draft', draftPrompt),
        agentStep('review', prompt, {
          agent: agent({ prompt: persona }),
          vars: { diff: shell('git diff {{base}}'), tone: literal('blunt') },
        }),
      ])

      const resolved = await validateChain(chain)

      const expected: ResolvedChain = { ...chain, writes: true, warnings: [] }
      expect(resolved).toStrictEqual(expected)
    })

    it('reports the step prompt path when it uses an undeclared placeholder', async () => {
      const prompt = await promptFile('review.md', 'Review this diff:\n{{diff}}\n')
      const chain = chainOf([shellStep('baseline'), agentStep('review', prompt)])

      const err = await validationError(chain)

      expect(err.path).toBe('steps[1].prompt')
      expect(err.message).toBe(
        `${chainFile}: unknown placeholder \`{{diff}}\`; declare it in this step's \`vars\` in ${prompt}`,
      )
    })

    it('reports the agent prompt path when the persona uses an undeclared placeholder', async () => {
      const prompt = await promptFile('review.md', 'Review the diff.')
      const persona = await promptFile('persona.md', 'You follow {{house_rules}}.')
      const chain = chainOf([agentStep('review', prompt, { agent: agent({ prompt: persona }) })])

      const err = await validationError(chain)

      expect(err.path).toBe('steps[0].agents[0].prompt')
    })

    it.each([
      ['the step prompt', 'step', 'steps[0].prompt'],
      ['the persona', 'persona', 'steps[0].agents[0].prompt'],
    ])('rejects {{input}} in %s when the chain has input: none', async (_, where, errPath) => {
      const usesInput = 'Handle this request: {{ input }}'
      const prompt = await promptFile('review.md', where === 'step' ? usesInput : 'Review.')
      const persona = await promptFile('persona.md', where === 'persona' ? usesInput : 'Be terse.')
      const chain = chainOf([agentStep('review', prompt, { agent: agent({ prompt: persona }) })], {
        input: 'none',
      })

      const err = await validationError(chain)

      expect(err.path).toBe(errPath)
      expect(err.message).toContain('`{{input}}` is used but the chain has `input: none`')
    })

    it.each(['text', 'file'] as const)(
      'accepts {{input}} when the chain has input: %s',
      async (input) => {
        const prompt = await promptFile('review.md', 'Handle this request: {{input}}')
        const chain = chainOf([agentStep('review', prompt)], { input })

        const resolved = await validateChain(chain)

        expect(resolved.input).toBe(input)
      },
    )

    it.each(['none', 'text'] as const)(
      'rejects {{input_path}} when the chain has input: %s',
      async (input) => {
        const prompt = await promptFile('review.md', 'The file is at {{input_path}}.')
        const chain = chainOf([agentStep('review', prompt)], { input })

        const err = await validationError(chain)

        expect(err.path).toBe('steps[0].prompt')
        expect(err.message).toContain(
          '`{{input_path}}` is used but the chain does not have `input: file`',
        )
      },
    )

    it('accepts {{input_path}} when the chain has input: file', async () => {
      const prompt = await promptFile('review.md', 'The file is at {{input_path}}.')
      const chain = chainOf([agentStep('review', prompt)], { input: 'file' })

      const resolved = await validateChain(chain)

      expect(resolved.warnings).toEqual([])
    })

    it.each([
      ['a later step', '{{steps.retest.output}}', 'which is not an earlier step'],
      ['the step itself', '{{steps.review.text}}', 'which is not an earlier step'],
      ['an unknown field', '{{steps.baseline.stdout}}', 'uses unknown field `stdout`'],
      ['a step without a field', '{{steps.baseline}}', 'unknown placeholder'],
    ])('rejects a steps reference to %s', async (_, placeholder, reason) => {
      const prompt = await promptFile('review.md', `Results: ${placeholder}`)
      const chain = chainOf([
        shellStep('baseline'),
        agentStep('review', prompt),
        shellStep('retest'),
      ])

      const err = await validationError(chain)

      expect(err.path).toBe('steps[1].prompt')
      expect(err.message).toContain(reason)
    })

    it('reports the step prompt path when the prompt file cannot be read', async () => {
      const prompt = await promptFile('review.md', 'Review.')
      await rm(prompt)
      const chain = chainOf([agentStep('review', prompt)])

      const err = await validationError(chain)

      expect(err.path).toBe('steps[0].prompt')
      expect(err.message).toBe(`${chainFile}: cannot read ${prompt}: ENOENT`)
    })
  })

  describe('unused vars', () => {
    it('warns about a declared var no prompt references and still resolves', async () => {
      const prompt = await promptFile('review.md', 'Review {{diff}}.')
      const chain = chainOf([
        shellStep('baseline'),
        agentStep('review', prompt, {
          vars: { diff: shell('git diff'), baseline: ref('steps.baseline.output') },
        }),
      ])

      const resolved = await validateChain(chain)

      expect(resolved.warnings).toEqual([
        'steps[1] (review): var `baseline` is declared but never used',
      ])
    })

    it('does not warn when a var is referenced only by the persona', async () => {
      const prompt = await promptFile('review.md', 'Review the diff.')
      const persona = await promptFile('persona.md', 'Your tone is {{tone}}.')
      const chain = chainOf([
        agentStep('review', prompt, {
          agent: agent({ prompt: persona }),
          vars: { tone: literal('blunt') },
        }),
      ])

      const resolved = await validateChain(chain)

      expect(resolved.warnings).toEqual([])
    })

    it('rejects a var that is used only inside another var, since var values see only the namespace', async () => {
      const prompt = await promptFile('review.md', 'Review {{diff}}.')
      const chain = chainOf([
        agentStep('review', prompt, {
          vars: { diff: shell('git diff {{target}}'), target: literal('origin/main') },
        }),
      ])

      const err = await validationError(chain)

      expect(err.path).toBe('steps[0].vars.diff')
      expect(err.message).toContain('unknown placeholder `{{target}}`')
    })
  })

  describe('placeholders and refs inside var values', () => {
    it('accepts built-ins and earlier step fields inside shell and literal vars', async () => {
      const prompt = await promptFile('review.md', 'Review {{diff}} with {{note}}.')
      const chain = chainOf([
        shellStep('baseline'),
        agentStep('review', prompt, {
          vars: {
            diff: shell('git diff {{base}}'),
            note: literal('exit {{steps.baseline.exit_code}}'),
          },
        }),
      ])

      const resolved = await validateChain(chain)

      expect(resolved.warnings).toEqual([])
    })

    it('reports the var path for a misspelled placeholder inside a shell var', async () => {
      const prompt = await promptFile('review.md', 'Review {{diff}}.')
      const chain = chainOf([
        agentStep('review', prompt, { vars: { diff: shell('git diff {{bsae}}') } }),
      ])

      const err = await validationError(chain)

      expect(err.path).toBe('steps[0].vars.diff')
      expect(err.message).toContain('unknown placeholder `{{bsae}}`')
    })

    it('rejects {{input}} inside a var when the chain has input: none', async () => {
      const prompt = await promptFile('review.md', 'Review {{topic}}.')
      const chain = chainOf(
        [agentStep('review', prompt, { vars: { topic: literal('{{input}}') } })],
        { input: 'none' },
      )

      const err = await validationError(chain)

      expect(err.path).toBe('steps[0].vars.topic')
      expect(err.message).toContain('`input: none`')
    })

    it.each([
      ['steps.baseline.output', true],
      ['steps.baseline.passed', true],
      ['steps.baseline.exit_code', true],
      ['steps.draft.output', true],
      ['steps.draft.output.codex', true],
      ['steps.draft.text', true],
      ['steps.retest.output', false],
      ['steps.basline.output', false],
      ['steps.baseline.stdout', false],
      ['steps.baseline.text', false],
      ['steps.baseline.output.codex', false],
      ['steps.baseline.passed.extra', false],
      ['steps.draft.exit_code', false],
      ['steps.draft.passed', false],
      ['steps.draft.text.extra', false],
    ])('ref var %s is accepted: %s', async (path, ok) => {
      const prompt = await promptFile('review.md', 'Results: {{results}}')
      const draftPrompt = await promptFile('draft.md', 'Draft it.')
      const chain = chainOf([
        shellStep('baseline'),
        agentStep('draft', draftPrompt),
        agentStep('review', prompt, { vars: { results: ref(path) } }),
        shellStep('retest'),
      ])

      if (ok) {
        await expect(validateChain(chain)).resolves.toMatchObject({ warnings: [] })
      } else {
        const err = await validationError(chain)
        expect(err.path).toBe('steps[2].vars.results')
        expect(err.message).toContain(`ref \`${path}\``)
      }
    })

    it.each([
      ['{{steps.draft.exit_code}}', 'agent step `draft` has output, text'],
      ['{{steps.draft.passed}}', 'agent step `draft` has output, text'],
      ['{{steps.baseline.text}}', 'shell step `baseline` has output, passed, exit_code'],
    ])(
      'rejects %s in a prompt because the referenced step kind lacks that field',
      async (placeholder, reason) => {
        const prompt = await promptFile('review.md', `Results: ${placeholder}`)
        const draftPrompt = await promptFile('draft.md', 'Draft it.')
        const chain = chainOf([
          shellStep('baseline'),
          agentStep('draft', draftPrompt),
          agentStep('review', prompt),
        ])

        const err = await validationError(chain)

        expect(err.path).toBe('steps[2].prompt')
        expect(err.message).toContain(reason)
      },
    )

    it('rejects steps.<id> with no field', async () => {
      const prompt = await promptFile('review.md', 'Results: {{results}}')
      const chain = chainOf([
        shellStep('baseline'),
        agentStep('review', prompt, { vars: { results: ref('steps.baseline') } }),
      ])

      const err = await validationError(chain)

      expect(err.path).toBe('steps[1].vars.results')
      expect(err.message).toContain('must be `steps.<id>.<field>`')
    })
  })

  describe('step ids', () => {
    it('reports steps[i].id for the second step that reuses an id', async () => {
      const chain = chainOf([shellStep('lint'), shellStep('test'), shellStep('lint')])

      const err = await validationError(chain)

      expect(err.path).toBe('steps[2].id')
      expect(err.message).toBe(`${chainFile}: duplicate step id \`lint\``)
    })

    it('reports steps[i].id when a later id differs from an earlier one only in case', async () => {
      const chain = chainOf([shellStep('review'), shellStep('lint'), shellStep('Review')])

      const err = await validationError(chain)

      expect(err.path).toBe('steps[2].id')
      expect(err.message).toBe(
        `${chainFile}: step id \`Review\` differs from \`review\` only in case; step ids name directories, which some filesystems treat as the same`,
      )
    })

    it('reports only duplicate step id, not also a case clash, when an id repeats exactly', async () => {
      const chain = chainOf([shellStep('review'), shellStep('review')])

      const err = await validationError(chain)

      expect(err.message).toBe(`${chainFile}: duplicate step id \`review\``)
      expect(err.details).toEqual([])
    })

    it('reports one problem per later step when ids repeat both exactly and by case', async () => {
      const chain = chainOf([shellStep('review'), shellStep('Review'), shellStep('Review')])

      const err = await validationError(chain)

      expect([err.message, ...(err.details ?? [])]).toEqual([
        `${chainFile}: step id \`Review\` differs from \`review\` only in case; step ids name directories, which some filesystems treat as the same`,
        `${chainFile}: duplicate step id \`Review\``,
      ])
    })
  })

  describe('collecting every problem', () => {
    it('throws the first problem and carries the others in details', async () => {
      const prompt = await promptFile('review.md', 'Review {{diff}} at {{input_path}}.')
      const chain = chainOf([agentStep('review', prompt), shellStep('review')])

      const err = await validationError(chain)

      expect(err.path).toBe('steps[0].prompt')
      expect(err.message).toBe(
        `${chainFile}: unknown placeholder \`{{diff}}\`; declare it in this step's \`vars\` in ${prompt}`,
      )
      expect(err.details).toEqual([
        `${chainFile}: \`{{input_path}}\` is used but the chain does not have \`input: file\` in ${prompt}`,
        `${chainFile}: duplicate step id \`review\``,
      ])
    })
  })

  describe('writes flag', () => {
    it.each<[string, (prompt: string) => Step[], boolean]>([
      ['a shell step', (p) => [shellStep('lint'), agentStep('review', p)], true],
      [
        'an agent step whose agent has write tools',
        (p) => [agentStep('review', p, { agent: agent({ tools: 'write' }) })],
        true,
      ],
      [
        'only agent steps with read tools',
        (p) => [agentStep('review', p), agentStep('second-review', p)],
        false,
      ],
    ])('sets writes when the chain has %s (expected %s)', async (_, steps, writes) => {
      const prompt = await promptFile('review.md', 'Review the diff.')

      const resolved = await validateChain(chainOf(steps(prompt)))

      expect(resolved.writes).toBe(writes)
    })
  })
})

describe('adapter-dependent validation', () => {
  function resolvedChain(steps: Step[]): ResolvedChain {
    return {
      name: 'review',
      input: 'none',
      allowApiKeys: false,
      steps,
      writes: true,
      warnings: [],
      sources: { chain: '/home/alice/shop/.rensa/review.yaml' },
    }
  }

  const named = agentStep('review', '/home/alice/shop/.rensa/steps/review.md', {
    agent: agent({ provider: 'grok', label: 'scout', name: 'scout', session: 'named' }),
  })

  it('returns an error at steps[i].agents[0] when a named agent uses a provider without resume', () => {
    const chain = resolvedChain([shellStep('lint'), named])

    const err = validateWithAdapters(chain, { grok: { resume: false }, claude: { resume: true } })

    assert(err instanceof RensaError, 'expected a RensaError')
    expect(err.code).toBe('CONFIG_INVALID')
    expect(err.path).toBe('steps[1].agents[0]')
    expect(err.message).toContain('use `{ from: scout }`')
  })

  it('returns undefined when the same provider is used through a fresh agent', () => {
    const { name: _, ...freshAgent } = agent({ provider: 'grok', label: 'scout' })
    const fresh = agentStep('review', named.prompt, {
      agent: { ...freshAgent, session: 'fresh' },
    })

    expect(
      validateWithAdapters(resolvedChain([fresh]), { grok: { resume: false } }),
    ).toBeUndefined()
  })

  it.each<[string, Partial<Record<'grok', { resume: boolean }>>]>([
    ['supports resume', { grok: { resume: true } }],
    ['is absent from the capabilities', {}],
  ])('returns undefined when the provider %s', (_, caps) => {
    expect(validateWithAdapters(resolvedChain([named]), caps)).toBeUndefined()
  })
})
