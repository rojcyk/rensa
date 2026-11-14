import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest'
import { type TmpDir, tmpDir } from '../../testing/tmpRepo.js'
import type { VarSpec } from '../config/types.js'
import { RensaError } from '../errors.js'
import { childEnv } from '../process/env.js'
import { liveProcessGroups } from '../process/spawn.js'
import type { Namespace, StepResult } from './namespace.js'
import { evaluateVars } from './vars.js'

const shell = (value: string): VarSpec => ({ kind: 'shell', value })
const ref = (value: string): VarSpec => ({ kind: 'ref', value })
const literal = (value: string): VarSpec => ({ kind: 'literal', value })

// Captured before any test fakes timers, for waits that must use real time.
const realSetTimeout = globalThis.setTimeout

async function catchRensa(promise: Promise<unknown>): Promise<RensaError> {
  try {
    await promise
  } catch (err) {
    assert(err instanceof RensaError, `expected RensaError, got ${String(err)}`)
    return err
  }
  throw new Error('expected a RensaError, but the promise resolved')
}

const REVIEW: StepResult = {
  kind: 'agent',
  output: { claude: { verdict: 'pass', issues: [] } },
  text: '{"verdict": "pass", "issues": []}',
}

function namespace(): Namespace {
  return {
    input: 'Add a coupon field to checkout',
    base: 'main',
    run_id: '20261031-142233-review',
    steps: {
      review: REVIEW,
      test: { kind: 'shell', output: 'PASS src/cart.test.ts\n', passed: true, exit_code: 0 },
    },
  }
}

let dir: TmpDir

beforeEach(async () => {
  dir = await tmpDir('rensa-vars-')
})

afterEach(async () => {
  vi.useRealTimers()
  await dir.cleanup()
})

describe('literal vars', () => {
  it('returns the text with namespace placeholders rendered when the literal contains one', async () => {
    const vars = { scope: literal('Only files changed since {{base}} in run {{run_id}}.') }

    expect(await evaluateVars(vars, namespace(), dir.dir)).toEqual({
      scope: 'Only files changed since main in run 20261031-142233-review.',
    })
  })

  it('rejects with a TEMPLATE error naming the placeholder when the literal references nothing', async () => {
    const err = await catchRensa(
      evaluateVars({ scope: literal('{{ticket}}') }, namespace(), dir.dir),
    )

    expect([err.code, err.message]).toEqual(['TEMPLATE', expect.stringContaining('{{ticket}}')])
  })
})

describe('ref vars', () => {
  it('returns the very namespace object when the path resolves to an output map', async () => {
    const ns = namespace()

    const values = await evaluateVars({ review: ref('steps.review.output') }, ns, dir.dir)

    expect(values.review).toBe(ns.steps.review?.output)
  })

  it('returns the raw value without stringifying when the path resolves to a boolean', async () => {
    const values = await evaluateVars({ ok: ref('steps.test.passed') }, namespace(), dir.dir)

    expect(values).toEqual({ ok: true })
  })

  it('rejects with a TEMPLATE error naming the var and the path when the path misses', async () => {
    const vars = { baseline: ref('steps.baseline.output') }

    const err = await catchRensa(evaluateVars(vars, namespace(), dir.dir))

    expect(err.code).toBe('TEMPLATE')
    expect(err.message).toMatch(/baseline.*steps\.baseline\.output/)
  })
})

describe('shell vars', () => {
  it('returns stdout when the command succeeds', async () => {
    const values = await evaluateVars(
      { diff: shell("printf 'M src/cart.ts'") },
      namespace(),
      dir.dir,
    )

    expect(values).toEqual({ diff: 'M src/cart.ts' })
  })

  it('strips exactly one trailing newline when stdout ends with several', async () => {
    const values = await evaluateVars(
      { log: shell("printf 'one\\ntwo\\n\\n'") },
      namespace(),
      dir.dir,
    )

    expect(values).toEqual({ log: 'one\ntwo\n' })
  })

  it('renders namespace placeholders into the command before running it', async () => {
    const vars = { range: shell("printf '%s..HEAD (%s)' {{base}} {{ run_id }}") }

    expect(await evaluateVars(vars, namespace(), dir.dir)).toEqual({
      range: 'main..HEAD (20261031-142233-review)',
    })
  })

  describe('placeholder values holding shell syntax', () => {
    const HOSTILE = 'explain `printf A` and $(printf B); it\'s "$HOME" * \\n'

    async function printed(command: string, input = HOSTILE): Promise<unknown> {
      const values = await evaluateVars({ out: shell(command) }, { ...namespace(), input }, dir.dir)
      return values.out
    }

    it('passes the value through untouched when the placeholder sits in double quotes', async () => {
      expect(await printed('printf \'%s\' "{{input}}"')).toBe(HOSTILE)
    })

    it('passes the value through untouched when the placeholder sits in single quotes', async () => {
      expect(await printed("printf '%s' '{{input}}'")).toBe(HOSTILE)
    })

    it('passes the value as one argument when the placeholder is unquoted', async () => {
      expect(await printed("printf '[%s]' {{input}}")).toBe(`[${HOSTILE}]`)
    })

    it('keeps surrounding text when the placeholder sits mid-word in quotes', async () => {
      expect(await printed("printf '%s' \"<{{input}}>\" '<{{input}}>'")).toBe(
        `<${HOSTILE}><${HOSTILE}>`,
      )
    })

    it('passes the value through untouched when the placeholder sits in a nested substitution', async () => {
      expect(await printed("printf '%s' \"$(printf '%s' {{input}})\"")).toBe(HOSTILE)
    })

    it('passes the value through untouched when the placeholder sits in backticks', async () => {
      expect(await printed("printf '%s' \"`printf '%s' {{input}}`\"")).toBe(HOSTILE)
    })

    it('ignores an apostrophe in a comment when a placeholder follows on a later line', async () => {
      expect(await printed("# don't include lockfiles\nprintf '[%s]' {{input}}")).toBe(
        `[${HOSTILE}]`,
      )
    })

    it('ignores an unmatched double quote in a comment when a placeholder follows', async () => {
      expect(await printed("# say \"hello\nprintf '[%s]' {{input}}")).toBe(`[${HOSTILE}]`)
    })

    it('keeps tracking quotes after a # when the # sits inside a word', async () => {
      expect(await printed("printf '%s' x#'{{input}}'")).toBe(`x#${HOSTILE}`)
    })

    it('passes the value through untouched when the placeholder sits in an unquoted here-document', async () => {
      expect(await printed('cat <<EOF\n<{{input}}>\nEOF')).toBe(`<${HOSTILE}>`)
    })

    it('keeps the body literal and passes the value untouched when the here-document is quoted', async () => {
      const command = "cat <<'EOF'\n$HOME `x` \\$ <{{input}}>\nEOF"

      expect(await printed(command)).toBe(`$HOME \`x\` \\$ <${HOSTILE}>`)
    })

    it('ends the here-document at its own delimiter when the value contains that line', async () => {
      const input = 'first\nEOF\nprintf pwned > pwned.txt'

      expect(await printed("cat <<'EOF'\n{{input}}\nEOF", input)).toBe(input)
    })

    it('rejects a placeholder in a quoted here-document whose delimiter is not a plain word', async () => {
      const vars = { body: shell("cat <<'END OF BODY'\n{{input}}\nEND OF BODY") }

      const err = await catchRensa(evaluateVars(vars, namespace(), dir.dir))

      expect([err.code, err.message]).toEqual([
        'TEMPLATE',
        expect.stringContaining('quoted here-document'),
      ])
    })

    it('ends a <<- here-document when its delimiter line is tab-indented', async () => {
      expect(await printed('cat <<-EOF\n\t<{{input}}>\n\tEOF\nprintf done')).toBe(
        `<${HOSTILE}>\ndone`,
      )
    })

    it('passes the value through untouched when the placeholder shares a line with <<EOF', async () => {
      expect(await printed("cat <<EOF; printf '%s' '{{input}}'\nbody\nEOF\n")).toBe(
        `body\n${HOSTILE}`,
      )
    })

    it("passes a later line's value through untouched when an arithmetic shift precedes it", async () => {
      // Read as a here-document, `<< 2` would swallow the next line as its body.
      const command = "printf '%s/' $((1 << 2))\nprintf '%s' {{input}}"

      expect(await printed(command)).toBe(`4/${HOSTILE}`)
    })

    it('does not run commands embedded in a prior step output', async () => {
      const ns = namespace()
      ns.steps.review = { ...REVIEW, text: "$(printf 'pwned' > pwned.txt)" }

      const values = await evaluateVars(
        { text: shell('printf \'%s\' "{{steps.review.text}}"') },
        ns,
        dir.dir,
      )

      expect(values.text).toBe("$(printf 'pwned' > pwned.txt)")
      expect(existsSync(path.join(dir.dir, 'pwned.txt'))).toBe(false)
    })
  })

  it('runs the command in the given cwd when one is passed', async () => {
    await writeFile(path.join(dir.dir, 'VERSION'), '2.4.0\n')

    const values = await evaluateVars({ version: shell('cat VERSION') }, namespace(), dir.dir)

    expect(values).toEqual({ version: '2.4.0' })
  })

  it('gives the command a closed stdin when it reads from stdin', async () => {
    const vars = { piped: shell("cat; printf 'after-eof'") }

    expect(await evaluateVars(vars, namespace(), dir.dir)).toEqual({ piped: 'after-eof' })
  })

  it('rejects with a TEMPLATE error naming the command and stderr when it exits non-zero', async () => {
    const command = "printf 'fatal: bad revision main~99' >&2; exit 128"

    const err = await catchRensa(evaluateVars({ diff: shell(command) }, namespace(), dir.dir))

    expect(err.code).toBe('TEMPLATE')
    expect(err.message).toContain(command)
    expect(err.message).toContain('fatal: bad revision main~99')
  })

  it('names the rendered command when a failing command contained a placeholder', async () => {
    const err = await catchRensa(
      evaluateVars({ diff: shell('git diff {{base}} 2>/dev/null; exit 3') }, namespace(), dir.dir),
    )

    expect(err.message).toContain('git diff main 2>/dev/null; exit 3')
  })

  describe('naming a failing command that holds a placeholder', () => {
    async function failureMessage(input: string): Promise<string> {
      const vars = { echo: shell('printf \'%s\' "{{input}}" >/dev/null; exit 1') }
      const err = await catchRensa(evaluateVars(vars, { ...namespace(), input }, dir.dir))
      return err.message
    }

    it('fills in the value when it is one line of exactly 60 characters', async () => {
      const input = 'Add a coupon field to checkout and reject expired codes fast'

      expect(await failureMessage(input)).toBe(
        `var \`echo\`: \`printf '%s' "${input}" >/dev/null; exit 1\` exited with 1`,
      )
    })

    it('leaves the placeholder when the value is one line of 61 characters', async () => {
      const input = 'Add a coupon field to checkout and reject expired codes early'

      expect(await failureMessage(input)).toBe(
        'var `echo`: `printf \'%s\' "{{input}}" >/dev/null; exit 1` exited with 1',
      )
    })

    it('leaves the placeholder when the value is short but spans two lines', async () => {
      expect(await failureMessage('Add a coupon field\nto checkout')).toBe(
        'var `echo`: `printf \'%s\' "{{input}}" >/dev/null; exit 1` exited with 1',
      )
    })
  })

  it('includes only the first 500 characters of stderr when stderr is longer', async () => {
    const command = "head -c 500 /dev/zero | tr '\\0' E >&2; printf 'BEYOND' >&2; exit 1"

    const err = await catchRensa(evaluateVars({ noisy: shell(command) }, namespace(), dir.dir))

    expect(err.message).toMatch(/exited with 1: E{500}$/)
  })

  it('rejects with a TEMPLATE error after 60 s when the command keeps running', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let settled = false
    const pending = evaluateVars({ slow: shell('sleep 30') }, namespace(), dir.dir)
    const outcome = pending.then(
      () => undefined,
      (err: unknown) => err,
    )
    void outcome.finally(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(59_999)
    const settledBeforeDeadline = settled
    await vi.advanceTimersByTimeAsync(1)
    const err = await outcome

    expect(settledBeforeDeadline).toBe(false)
    assert(err instanceof RensaError, `expected RensaError, got ${String(err)}`)
    expect([err.code, err.message]).toEqual([
      'TEMPLATE',
      expect.stringMatching(/sleep 30.*timed out after 60 s/),
    ])
  })

  it('rejects promptly after 60 s when a compound command keeps running', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const command = "printf '' > started; sleep 3; printf 'late'"
    const pending = evaluateVars({ slow: shell(command) }, namespace(), dir.dir)
    const outcome = pending.then(
      () => 'resolved',
      (err: unknown) => err,
    )
    // Let the shell fork `sleep` before the deadline passes.
    await vi.waitFor(() => assert(existsSync(path.join(dir.dir, 'started'))))

    await vi.advanceTimersByTimeAsync(60_000)
    const first = await Promise.race([
      outcome,
      new Promise((resolve) => realSetTimeout(() => resolve('still pending'), 1_000)),
    ])

    assert(first instanceof RensaError, `expected RensaError, got ${String(first)}`)
    expect(first.message).toContain('timed out after 60 s')
  })
})

describe('shell vars that outlive their shell', () => {
  it('rejects with a timeout when the shell exits 0 but a background child keeps its output open', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    // The child signals only once the shell itself (`$$`) is gone.
    const command =
      "printf 'partial'; (while kill -0 $$ 2>/dev/null; do sleep 0.05; done; printf '' > started; sleep 30) &"
    const outcome = evaluateVars({ slow: shell(command) }, namespace(), dir.dir).then(
      () => 'resolved',
      (err: unknown) => err,
    )
    await vi.waitFor(() => assert(existsSync(path.join(dir.dir, 'started'))))

    await vi.advanceTimersByTimeAsync(60_000)
    const err = await outcome

    assert(err instanceof RensaError, `expected RensaError, got ${String(err)}`)
    expect(err.message).toContain('timed out after 60 s')
  })
})

describe('shell vars with large output', () => {
  it('returns stdout whole when it is exactly 10 MiB', async () => {
    const vars = { huge: shell("head -c 10485760 /dev/zero | tr '\\0' a") }

    const values = await evaluateVars(vars, namespace(), dir.dir)

    assert(typeof values.huge === 'string', `expected a string, got ${typeof values.huge}`)
    expect(values.huge.length).toBe(10 * 1024 * 1024)
  })

  it('rejects with a TEMPLATE error when stdout exceeds 10 MiB', async () => {
    const vars = { huge: shell('head -c 11000000 /dev/zero') }

    const err = await catchRensa(evaluateVars(vars, namespace(), dir.dir))

    expect([err.code, err.message]).toEqual([
      'TEMPLATE',
      expect.stringContaining('printed more than 10 MiB'),
    ])
  })
})

describe('evaluation order', () => {
  it('runs vars sequentially in declaration order when a later var reads an earlier side effect', async () => {
    const vars = {
      first: shell("sleep 0.2; printf 'written' > stamp.txt; printf 'first'"),
      second: shell('cat stamp.txt'),
    }

    expect(await evaluateVars(vars, namespace(), dir.dir)).toEqual({
      first: 'first',
      second: 'written',
    })
  })

  it('does not run later vars when an earlier var fails', async () => {
    const vars = {
      broken: shell('exit 2'),
      later: shell("printf 'ran' > later.txt"),
    }

    await catchRensa(evaluateVars(vars, namespace(), dir.dir))

    expect(existsSync(path.join(dir.dir, 'later.txt'))).toBe(false)
  })
})

describe('shell var environment', () => {
  const vars = { key: shell('printf \'%s\' "$ANTHROPIC_API_KEY"') }

  beforeEach(() => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-api03-9d41e7c2')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('hides ANTHROPIC_API_KEY from the command when the env is built without allowApiKeys', async () => {
    const env = childEnv(process.env, { allowApiKeys: false })

    expect(await evaluateVars(vars, namespace(), dir.dir, env)).toEqual({ key: '' })
  })

  it('passes ANTHROPIC_API_KEY to the command when the env is built with allowApiKeys', async () => {
    const env = childEnv(process.env, { allowApiKeys: true })

    expect(await evaluateVars(vars, namespace(), dir.dir, env)).toEqual({
      key: 'sk-ant-api03-9d41e7c2',
    })
  })
})

describe('shell var process groups', () => {
  it('registers the command group while it runs and drops it once evaluateVars resolves', async () => {
    // The shell runs in the group the lifeline leads, so it reads the
    // pgid from ps. It waits for the test to create `release` before it exits.
    const command =
      "ps -o pgid= -p $$ | tr -d ' \\n' > pgid.txt; while [ ! -e release ]; do sleep 0.05; done; printf 'released'"
    const pending = evaluateVars({ gate: shell(command) }, namespace(), dir.dir)
    const pgid = await vi.waitFor(async () => {
      const text = await readFile(path.join(dir.dir, 'pgid.txt'), 'utf8')
      assert(/^\d+$/.test(text), `pgid.txt holds ${JSON.stringify(text)}`)
      return Number(text)
    })
    const registeredWhileRunning = liveProcessGroups.has(pgid)

    await writeFile(path.join(dir.dir, 'release'), '')
    const values = await pending

    expect([registeredWhileRunning, values, liveProcessGroups.has(pgid)]).toEqual([
      true,
      { gate: 'released' },
      false,
    ])
  })
})
