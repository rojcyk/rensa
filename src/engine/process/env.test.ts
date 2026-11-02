import { describe, expect, it } from 'vitest'
import { childEnv } from './env.js'

function userEnv(): NodeJS.ProcessEnv {
  return {
    PATH: '/opt/homebrew/bin:/usr/bin:/bin',
    HOME: '/Users/alice',
    TERM: 'xterm-256color',
    ANTHROPIC_API_KEY: 'sk-ant-api03-7f3a9c',
    OPENAI_API_KEY: 'sk-proj-b41e8d',
    XAI_API_KEY: 'xai-5c2d90',
  }
}

describe('vendor API keys', () => {
  it('removes all three keys and keeps everything else when allowApiKeys is false', () => {
    const env = childEnv(userEnv(), { allowApiKeys: false })

    expect(env).toEqual({
      PATH: '/opt/homebrew/bin:/usr/bin:/bin',
      HOME: '/Users/alice',
      TERM: 'dumb',
      NO_COLOR: '1',
    })
  })

  it('keeps all three keys when allowApiKeys is true', () => {
    const env = childEnv(userEnv(), { allowApiKeys: true })

    expect([env.ANTHROPIC_API_KEY, env.OPENAI_API_KEY, env.XAI_API_KEY]).toEqual([
      'sk-ant-api03-7f3a9c',
      'sk-proj-b41e8d',
      'xai-5c2d90',
    ])
  })

  it('leaves the base environment untouched when it strips keys', () => {
    const base = userEnv()

    childEnv(base, { allowApiKeys: false })

    expect(base).toEqual(userEnv())
  })
})

describe('terminal features', () => {
  it('sets NO_COLOR=1 and TERM=dumb when the base environment has a color terminal', () => {
    const env = childEnv(userEnv(), { allowApiKeys: true })

    expect([env.NO_COLOR, env.TERM]).toEqual(['1', 'dumb'])
  })
})

describe('extra variables', () => {
  it('adds extra variables and lets them override TERM when extra is given', () => {
    const env = childEnv(userEnv(), {
      allowApiKeys: false,
      extra: { TERM: 'xterm-256color', RENSA_RUN_ID: '20261102-091544-review' },
    })

    expect([env.TERM, env.RENSA_RUN_ID, env.NO_COLOR]).toEqual([
      'xterm-256color',
      '20261102-091544-review',
      '1',
    ])
  })
})
