import path from 'node:path'
import { assert, describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { RensaError } from '../errors.js'
import { loadYaml, parseRaw } from './load.js'
import {
  RawAgentRefSchema,
  RawAgentSchema,
  RawChainSchema,
  RawProjectSchema,
  RawStepSchema,
} from './types.js'

const YAML_DIR = path.resolve(import.meta.dirname, '../../../test/fixtures/config/yaml')
const fixture = (name: string) => path.join(YAML_DIR, name)

async function loadError(file: string): Promise<RensaError> {
  const err = await loadYaml(file, RawChainSchema).catch((e: unknown) => e)
  assert(err instanceof RensaError, `expected RensaError, got ${String(err)}`)
  return err
}

function catchRensa(fn: () => unknown): RensaError {
  try {
    fn()
  } catch (err) {
    assert(err instanceof RensaError, `expected RensaError, got ${String(err)}`)
    return err
  }
  throw new Error('expected a RensaError, but nothing was thrown')
}

describe('parsing a well-formed YAML file', () => {
  it('returns the parsed mapping with nested lists and flow sequences intact', async () => {
    const doc = await loadYaml(fixture('review.yaml'), RawChainSchema)

    expect(doc).toEqual({
      name: 'review',
      description: 'Lint, then one read-only review.',
      steps: [
        { id: 'lint', run: 'npm run lint' },
        { id: 'review', prompt: 'steps/review.md', agents: ['reviewer'] },
      ],
    })
  })

  it('throws CONFIG_INVALID with the dotted path when the mapping has a reserved key', async () => {
    const file = fixture('unknown-key.yaml')

    const err = await loadError(file)

    expect(err.code).toBe('CONFIG_INVALID')
    expect(err.path).toBe('steps[0].when')
    expect(err.message).toBe(
      `${file}: unknown key \`when\` at steps[0]; not supported in this version`,
    )
  })
})

describe('rejecting files that are not YAML mappings', () => {
  it('throws CONFIG_PARSE with file:line:col when the YAML repeats a key', async () => {
    const file = fixture('duplicate-key.yaml')

    const err = await loadError(file)

    expect(err.code).toBe('CONFIG_PARSE')
    expect(err.path).toBe(file)
    expect(err.message).toMatch(new RegExp(`^${escapeRegExp(file)}:3:1: Map keys must be unique`))
  })

  it.each([
    ['top-level-list.yaml', 'a list'],
    ['top-level-scalar.yaml', 'a string'],
    ['empty.yaml', 'nothing'],
    ['comments-only.yaml', 'nothing'],
  ])('throws CONFIG_INVALID with the file as path when %s holds %s', async (name, got) => {
    const file = fixture(name)

    const err = await loadError(file)

    expect(err.code).toBe('CONFIG_INVALID')
    expect(err.path).toBe(file)
    expect(err.message).toBe(`${file}: expected a mapping at the top level, got ${got}`)
  })

  it('throws CONFIG_PARSE naming the file and ENOENT when the file does not exist', async () => {
    const file = fixture('no-such-chain.yaml')

    const err = await loadError(file)

    expect(err.code).toBe('CONFIG_PARSE')
    expect(err.path).toBe(file)
    expect(err.message).toBe(`cannot read ${file}: ENOENT`)
  })
})

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ---------------------------------------------------------------------------
// Raw shape: pure checks over parsed documents, no files involved.
// ---------------------------------------------------------------------------

describe('raw chain shape', () => {
  const FILE = '/home/alice/shop/.rensa/review.yaml'
  const chainError = (doc: unknown) => catchRensa(() => parseRaw(RawChainSchema, doc, FILE))

  it('returns the document when every key and type is valid', () => {
    const doc = {
      name: 'review',
      description: 'Tests, then review.',
      input: 'text',
      base: 'main',
      agents: {
        impl: {
          provider: 'claude',
          model: 'opus',
          effort: 'high',
          tools: 'write',
          prompt: 'agents/implementer.md',
          skills: ['~/.config/rensa/skills/code-review'],
        },
      },
      steps: [
        { id: 'baseline', run: 'npm test', on_fail: 'continue', timeout: '20m' },
        {
          id: 'review',
          prompt: 'steps/review.md',
          agents: [{ from: 'impl', effort: 'medium' }],
          tools: 'read',
          pause: 'before',
          vars: { diff: '$(git diff {{base}})', baseline: 'steps.baseline.output' },
        },
      ],
    }

    expect(parseRaw(RawChainSchema, doc, FILE)).toEqual(doc)
  })

  it('rejects an unknown step key with the spec message and path steps[i].<key>', () => {
    const steps = [
      { id: 'lint', run: 'npm run lint' },
      { id: 'test', run: 'npm test' },
      { id: 'build', run: 'npm run build' },
      { id: 'deploy', run: 'npm run deploy', when: 'steps.build.passed' },
    ]

    const err = chainError({ steps })

    expect(err.code).toBe('CONFIG_INVALID')
    expect(err.path).toBe('steps[3].when')
    expect(err.message).toBe(
      `${FILE}: unknown key \`when\` at steps[3]; not supported in this version`,
    )
  })

  it('rejects allow_api_keys in a chain file as an unknown top-level key', () => {
    const doc = { allow_api_keys: true, steps: [{ id: 'lint', run: 'npm run lint' }] }

    const err = chainError(doc)

    expect(err.path).toBe('allow_api_keys')
    expect(err.message).toBe(
      `${FILE}: unknown key \`allow_api_keys\` at the top level; not supported in this version`,
    )
  })

  it.each<[string, Record<string, unknown>]>([
    ['loop', { loop: 3, steps: [{ id: 'lint', run: 'npm run lint' }] }],
    ['steps[0].parallel', { steps: [{ id: 'lint', run: 'npm run lint', parallel: true }] }],
    [
      'agents.impl.temperature',
      {
        agents: { impl: { provider: 'claude', tools: 'write', temperature: 0.2 } },
        steps: [{ id: 'lint', run: 'npm run lint' }],
      },
    ],
    [
      'agents.impl.from',
      {
        agents: { impl: { from: 'codex', tools: 'write' } },
        steps: [{ id: 'lint', run: 'npm run lint' }],
      },
    ],
    [
      'steps[0].agents[0].temperature',
      {
        steps: [
          { id: 'review', prompt: 'steps/review.md', agents: [{ from: 'impl', temperature: 0 }] },
        ],
      },
    ],
  ])('rejects an unknown key with path %s', (keyPath, doc) => {
    const err = chainError(doc)

    expect(err.code).toBe('CONFIG_INVALID')
    expect(err.path).toBe(keyPath)
  })

  const step = { id: 'review', prompt: 'steps/review.md', agents: ['impl'] }
  const lint = { id: 'lint', run: 'npm run lint' }

  it.each<[string, Record<string, unknown>]>([
    ['name', { name: 42, steps: [lint] }],
    ['description', { description: ['two', 'lines'], steps: [lint] }],
    ['input', { input: true, steps: [lint] }],
    ['agents', { agents: ['impl'], steps: [lint] }],
    ['agents.impl', { agents: { impl: 'claude' }, steps: [lint] }],
    ['agents.impl.model', { agents: { impl: { model: 4.5 } }, steps: [lint] }],
    ['agents.impl.skills', { agents: { impl: { skills: 'skills/review' } }, steps: [lint] }],
    [
      'agents.impl.skills[1]',
      { agents: { impl: { skills: ['skills/review', 7] } }, steps: [lint] },
    ],
    ['steps', { steps: { lint } }],
    ['steps[1]', { steps: [lint, 'npm test'] }],
    ['steps[1].id', { steps: [lint, { run: 'npm test' }] }],
    ['steps[0].timeout', { steps: [{ ...lint, timeout: 30 }] }],
    ['steps[0].agents', { steps: [{ ...step, agents: 'impl' }] }],
    ['steps[0].agents[0]', { steps: [{ ...step, agents: [3] }] }],
    // An agent entry is a name or a mapping; a wrong field inside the
    // mapping is reported at the entry, since neither form matched.
    ['steps[0].agents[0]', { steps: [{ ...step, agents: [{ from: 3 }] }] }],
    ['steps[0].vars', { steps: [{ ...step, vars: ['diff'] }] }],
    ['steps[0].vars.retries', { steps: [{ ...step, vars: { retries: 3 } }] }],
    ['steps[0].vars.strict', { steps: [{ ...step, vars: { strict: true } }] }],
  ])('rejects a value of the wrong type with path %s', (valuePath, doc) => {
    const err = chainError(doc)

    expect(err.code).toBe('CONFIG_INVALID')
    expect(err.path).toBe(valuePath)
    expect(err.message.startsWith(`${FILE}: `)).toBe(true)
  })

  it("prefixes zod's own wording with the dotted path when a value has the wrong type", () => {
    const err = chainError({ steps: [{ ...lint, timeout: 30 }] })

    expect(err.message).toBe(
      `${FILE}: steps[0].timeout: Invalid input: expected string, received number`,
    )
  })

  it.each<[string, Record<string, unknown>]>([
    ['input', { input: 'stdin', steps: [lint] }],
    ['agents.impl.provider', { agents: { impl: { provider: 'gemini' } }, steps: [lint] }],
    ['agents.impl.effort', { agents: { impl: { effort: 'extreme' } }, steps: [lint] }],
    ['agents.impl.tools', { agents: { impl: { tools: 'admin' } }, steps: [lint] }],
    ['steps[0].on_fail', { steps: [{ ...lint, on_fail: 'retry' }] }],
    ['steps[0].pause', { steps: [{ ...lint, pause: 'during' }] }],
    ['steps[0].tools', { steps: [{ ...step, tools: 'none' }] }],
  ])('rejects a value outside its enum with path %s', (valuePath, doc) => {
    const err = chainError(doc)

    expect(err.code).toBe('CONFIG_INVALID')
    expect(err.path).toBe(valuePath)
  })

  it('rejects a timeout that is not <digits><s|m|h> with a duration hint', () => {
    const err = chainError({ steps: [{ ...lint, timeout: '20 minutes' }] })

    expect(err.path).toBe('steps[0].timeout')
    expect(err.message).toBe(`${FILE}: steps[0].timeout: expected a duration like 20m or 1h`)
  })

  it.each<[string, unknown[]]>([
    ['no agents', []],
    ['two agents', ['impl', 'impl']],
  ])('rejects an agent step listing %s with path steps[i].agents', (_, agents) => {
    const err = chainError({ steps: [{ ...step, agents }] })

    expect(err.path).toBe('steps[0].agents')
    expect(err.message).toBe(`${FILE}: steps[0].agents: exactly one agent per step in this version`)
  })

  it('rejects an empty step id with path steps[i].id', () => {
    const err = chainError({ steps: [{ id: '', run: 'npm test' }] })

    expect(err.path).toBe('steps[0].id')
  })

  it.each(['../../../..', 'team/rev', 'code review', 'rev.v2'])(
    'rejects the registry name %j because it would become a directory under the run',
    (name) => {
      const doc = {
        agents: { [name]: { provider: 'claude', tools: 'read' } },
        steps: [lint],
      }

      const err = chainError(doc)

      expect(err.code).toBe('CONFIG_INVALID')
      expect(err.path).toBe(`agents.${name}`)
      expect(err.message).toBe(
        `${FILE}: agents.${name}: agent name \`${name}\` may contain only letters, digits, \`_\` and \`-\``,
      )
    },
  )

  it('accepts registry names of mixed-case letters, digits, _ and -', () => {
    const doc = {
      agents: {
        Reviewer_2: { provider: 'claude', tools: 'read' },
        'code-review': { provider: 'codex', tools: 'read' },
      },
      steps: [lint],
    }

    expect(parseRaw(RawChainSchema, doc, FILE)).toEqual(doc)
  })

  // YAML parses `__proto__` as an own key; it must stay a declared var.
  it('keeps a var named __proto__ as an own key when a step declares it', () => {
    const vars: Record<string, string> = {}
    Object.defineProperty(vars, '__proto__', { value: 'main', enumerable: true })
    const doc = { steps: [{ ...step, vars }] }

    const chain = parseRaw(RawChainSchema, doc, FILE)

    const parsed = chain.steps[0]?.vars
    assert(parsed, 'expected the step to keep its vars')
    expect(Object.keys(parsed)).toEqual(['__proto__'])
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype)
  })

  it('rejects a chain without steps with path steps', () => {
    const err = chainError({ name: 'review' })

    expect(err.code).toBe('CONFIG_INVALID')
    expect(err.path).toBe('steps')
  })

  it('rejects an empty steps list with path steps', () => {
    const err = chainError({ steps: [] })

    expect(err.code).toBe('CONFIG_INVALID')
    expect(err.path).toBe('steps')
  })
})

describe('raw project shape', () => {
  const FILE = '/home/alice/.config/rensa/project.yaml'
  const projectError = (doc: unknown) => catchRensa(() => parseRaw(RawProjectSchema, doc, FILE))

  it('returns the document when every key and type is valid', () => {
    const doc = {
      base: 'main',
      allow_api_keys: false,
      agents: { codex: { provider: 'codex', effort: 'medium', tools: 'read' } },
    }

    expect(parseRaw(RawProjectSchema, doc, FILE)).toEqual(doc)
  })

  it.each<[string, Record<string, unknown>]>([
    ['steps', { steps: [{ id: 'lint', run: 'npm run lint' }] }],
    ['name', { name: 'shared' }],
    ['agents.codex.from', { agents: { codex: { from: 'grok' } } }],
  ])('rejects an unknown key with path %s', (keyPath, doc) => {
    const err = projectError(doc)

    expect(err.code).toBe('CONFIG_INVALID')
    expect(err.path).toBe(keyPath)
  })

  it('rejects a registry name containing a path separator with path agents.<name>', () => {
    const doc = { agents: { 'team/rev': { provider: 'codex', tools: 'read' } } }

    const err = projectError(doc)

    expect(err.code).toBe('CONFIG_INVALID')
    expect(err.path).toBe('agents.team/rev')
    expect(err.message).toContain('agent name `team/rev` may contain only letters')
  })

  it.each<[string, Record<string, unknown>]>([
    ['allow_api_keys', { allow_api_keys: 'yes' }],
    ['base', { base: 42 }],
    ['agents', { agents: ['codex'] }],
  ])('rejects a value of the wrong type with path %s', (valuePath, doc) => {
    const err = projectError(doc)

    expect(err.code).toBe('CONFIG_INVALID')
    expect(err.path).toBe(valuePath)
  })
})

describe('reserved keys', () => {
  const FILE = '/home/alice/shop/.rensa/review.yaml'

  it.each<[string, z.ZodType, Record<string, unknown>, string, string]>([
    [
      'chain',
      RawChainSchema,
      { params: { target: 'main' }, steps: [{ id: 'lint', run: 'npm run lint' }] },
      'params',
      'the top level',
    ],
    ['project', RawProjectSchema, { setup: 'npm ci' }, 'setup', 'the top level'],
    [
      'step',
      RawStepSchema,
      { id: 'lint', run: 'npm run lint', when: 'x' },
      'when',
      'the top level',
    ],
    [
      'registry entry',
      RawAgentSchema,
      { provider: 'claude', tools: 'read', workspace: 'tmp' },
      'workspace',
      'the top level',
    ],
    [
      'step agent entry',
      RawAgentRefSchema,
      { from: 'impl', loop_to: 'review' },
      'loop_to',
      'the top level',
    ],
  ])(
    'a %s schema rejects a reserved key as not supported in this version',
    (_, schema, doc, key, where) => {
      const err = catchRensa(() => parseRaw(schema, doc, FILE))

      expect(err.code).toBe('CONFIG_INVALID')
      expect(err.path).toBe(key)
      expect(err.message).toBe(
        `${FILE}: unknown key \`${key}\` at ${where}; not supported in this version`,
      )
    },
  )

  it('reports the first reserved key as the error and the second in details when a step has two', () => {
    const doc = {
      steps: [
        { id: 'lint', run: 'npm run lint' },
        { id: 'deploy', run: 'npm run deploy', when: 'steps.lint.passed', loop_to: 'lint' },
      ],
    }

    const err = catchRensa(() => parseRaw(RawChainSchema, doc, FILE))

    expect(err.path).toBe('steps[1].when')
    expect(err.details).toEqual([
      `${FILE}: unknown key \`loop_to\` at steps[1]; not supported in this version`,
    ])
  })
})
