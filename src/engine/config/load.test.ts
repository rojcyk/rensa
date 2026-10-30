import path from 'node:path'
import { assert, describe, expect, it } from 'vitest'
import { RensaError } from '../errors.js'
import { loadYaml } from './load.js'

const YAML_DIR = path.resolve(import.meta.dirname, '../../../test/fixtures/config/yaml')
const fixture = (name: string) => path.join(YAML_DIR, name)

async function loadError(file: string): Promise<RensaError> {
  const err = await loadYaml(file).catch((e: unknown) => e)
  assert(err instanceof RensaError, `expected RensaError, got ${String(err)}`)
  return err
}

describe('parsing a well-formed YAML file', () => {
  it('returns the parsed mapping with nested lists and flow sequences intact', async () => {
    const doc = await loadYaml<Record<string, unknown>>(fixture('review.yaml'))

    expect(doc).toEqual({
      name: 'review',
      description: 'Lint, then one read-only review.',
      steps: [
        { id: 'lint', run: 'npm run lint' },
        { id: 'review', prompt: 'steps/review.md', agents: ['reviewer'] },
      ],
    })
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
