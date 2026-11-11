import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, assert, beforeAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { builtCli, cliEnv, runCli } from '../../src/testing/cli.js'
import { readmeBlocks } from '../../src/testing/markdown.js'
import { type TmpDir, tmpDir } from '../../src/testing/tmpRepo.js'

// The package as npm publishes it and the release workflow that publishes
// it: the manifest, the tarball listing of the built tree, the workflow
// file, and the README's CLI reference against the built CLI.

const ROOT = path.resolve(import.meta.dirname, '../..')
const execFileAsync = promisify(execFile)

let dirs: TmpDir[] = []

beforeAll(() => {
  builtCli()
})

afterEach(async () => {
  await Promise.all(dirs.map((d) => d.cleanup()))
  dirs = []
})

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(ROOT, file), 'utf8')) as Record<string, unknown>
}

async function cli(args: string[]) {
  const home = await tmpDir('rensa-home-')
  dirs.push(home)
  return runCli(args, { cwd: home.dir, env: cliEnv(home.dir) })
}

describe('the package manifest', () => {
  it('names @rojcyk/rensa 0.1.0 with a rensa binary at the built CLI when read from package.json', async () => {
    const pkg = await readJson('package.json')

    expect({ name: pkg.name, version: pkg.version, bin: pkg.bin }).toEqual({
      name: '@rojcyk/rensa',
      version: '0.1.0',
      bin: { rensa: './dist/cli/main.js' },
    })
  })

  it('publishes only dist, README.md and LICENSE when read from package.json files', async () => {
    const pkg = await readJson('package.json')

    expect(pkg.files).toEqual(['dist', 'README.md', 'LICENSE'])
  })

  it('points repository, homepage and bugs at rojcyk/rensa on GitHub when read from package.json', async () => {
    const pkg = await readJson('package.json')

    expect({ repository: pkg.repository, homepage: pkg.homepage, bugs: pkg.bugs }).toEqual({
      repository: { type: 'git', url: 'git+https://github.com/rojcyk/rensa.git' },
      homepage: 'https://github.com/rojcyk/rensa#readme',
      bugs: { url: 'https://github.com/rojcyk/rensa/issues' },
    })
  })
})

describe('the packed tarball', () => {
  it('lists only dist/, README.md, LICENSE and package.json, including the built CLI, when packed', async () => {
    const { stdout } = await execFileAsync(
      'npm',
      ['pack', '--dry-run', '--json', '--ignore-scripts'],
      { cwd: ROOT },
    )
    const [packed] = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>
    assert(packed, `npm pack printed no package: ${stdout}`)

    const paths = packed.files.map((f) => f.path).sort()
    const outside = paths.filter(
      (p) => !p.startsWith('dist/') && !['README.md', 'LICENSE', 'package.json'].includes(p),
    )
    expect({ outside, tests: paths.filter((p) => /\.test\./.test(p)) }).toEqual({
      outside: [],
      tests: [],
    })
    expect(paths).toEqual(
      expect.arrayContaining(['LICENSE', 'README.md', 'dist/cli/main.js', 'package.json']),
    )
  })
})

interface WorkflowStep {
  run?: string
  uses?: string
  with?: Record<string, unknown>
  env?: Record<string, unknown>
}

interface Workflow {
  on: unknown
  jobs: Record<string, { steps: WorkflowStep[] }>
}

async function releaseWorkflow(): Promise<Workflow> {
  return parse(await readFile(path.join(ROOT, '.github/workflows/release.yml'), 'utf8')) as Workflow
}

/** Every step of every job, in file order. */
function allSteps(wf: Workflow): WorkflowStep[] {
  return Object.values(wf.jobs).flatMap((job) => job.steps)
}

describe('the release workflow', () => {
  it('triggers only on a push of a v* tag', async () => {
    const wf = await releaseWorkflow()

    expect(wf.on).toEqual({ push: { tags: ['v*'] } })
  })

  it('runs npm ci, then npm run check, then npm publish --access public in the same job', async () => {
    const wf = await releaseWorkflow()

    const runs = Object.values(wf.jobs).map((job) =>
      job.steps.flatMap((s) => (s.run === undefined ? [] : [s.run.trim()])),
    )
    expect(runs).toEqual([['npm ci', 'npm run check', 'npm publish --access public']])
  })

  it('publishes with NODE_AUTH_TOKEN from secrets.NPM_TOKEN against the npm registry', async () => {
    const wf = await releaseWorkflow()

    const steps = allSteps(wf)
    const publish = steps.find((s) => s.run?.trim() === 'npm publish --access public')
    const setupNode = steps.find((s) => s.uses?.startsWith('actions/setup-node@'))
    assert(publish, 'no npm publish step')
    assert(setupNode, 'no actions/setup-node step')
    expect({
      token: publish.env?.NODE_AUTH_TOKEN,
      registry: setupNode.with?.['registry-url'],
    }).toEqual({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template
      token: '${{ secrets.NPM_TOKEN }}',
      registry: 'https://registry.npmjs.org',
    })
  })
})

describe("the README's CLI reference", () => {
  it('matches the usage the built CLI prints for --help', async () => {
    const reference = (await readmeBlocks()).find(
      (b) => b.lang === 'text' && b.body.startsWith('rensa '),
    )
    assert(reference, 'no ```text block starting with `rensa ` in README.md')

    const { code, stdout } = await cli(['--help'])

    const usage = stdout
      .replace(/^usage:\n/, '')
      .split('\n')
      .map((line) => line.replace(/^ {2}/, ''))
      .join('\n')
    expect({ code, usage: usage.trimEnd() }).toEqual({ code: 0, usage: reference.body.trimEnd() })
  })

  it('reports the package.json version for --version', async () => {
    const pkg = await readJson('package.json')

    const { code, stdout } = await cli(['--version'])

    expect({ code, version: stdout.trim() }).toEqual({ code: 0, version: pkg.version })
  })
})
