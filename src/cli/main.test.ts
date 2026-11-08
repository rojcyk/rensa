import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Source-level boundaries of the TUI wiring: Ink stays out of the
// headless commands, and nothing but the terminal session writes to the
// terminal from the engine or the TUI.

const SRC = path.resolve(import.meta.dirname, '..')
const MAIN = path.join(SRC, 'cli', 'main.ts')

/** Specifiers of static `import … from` / `export … from` / bare `import '…'` statements. */
function staticImports(source: string): string[] {
  const specifiers: string[] = []
  const pattern = /^\s*(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm
  for (const match of source.matchAll(pattern)) {
    if (match[1] !== undefined) specifiers.push(match[1])
  }
  return specifiers
}

/** `./x.js` from `file` → the `.ts`/`.tsx` source it names. */
function resolveSource(file: string, specifier: string): string | undefined {
  const base = path.resolve(path.dirname(file), specifier).replace(/\.js$/, '')
  return [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')].find((f) => existsSync(f))
}

/** Every module main.ts loads statically, with the bare packages each imports. */
async function staticGraph(entry: string): Promise<Map<string, string[]>> {
  const graph = new Map<string, string[]>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop()
    if (file === undefined || graph.has(file)) continue
    const specifiers = staticImports(await readFile(file, 'utf8'))
    graph.set(file, specifiers)
    for (const specifier of specifiers) {
      if (!specifier.startsWith('.')) continue
      const resolved = resolveSource(file, specifier)
      if (resolved) queue.push(resolved)
    }
  }
  return graph
}

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return entries
    .filter((e) => e.isFile() && /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name))
    .map((e) => path.join(e.parentPath, e.name))
}

describe('loading Ink only for the TUI', () => {
  it('has no static import of src/tui or ink in main.ts', async () => {
    const specifiers = staticImports(await readFile(MAIN, 'utf8'))

    expect(specifiers.filter((s) => /(^|\/)tui(\/|$)/.test(s) || /^ink(\/|$)/.test(s))).toEqual([])
  })

  it('reaches no src/tui module and no ink import through the static imports of main.ts', async () => {
    const graph = await staticGraph(MAIN)

    const tuiModules = [...graph.keys()].filter((f) => f.startsWith(path.join(SRC, 'tui')))
    const inkImporters = [...graph].filter(([, specs]) => specs.some((s) => /^ink(\/|$)/.test(s)))
    expect(tuiModules).toEqual([])
    expect(inkImporters.map(([f]) => path.relative(SRC, f))).toEqual([])
  })

  it('loads the TUI through a dynamic import of ../tui/app.js', async () => {
    const source = await readFile(MAIN, 'utf8')

    expect(source).toMatch(/\bimport\(\s*['"]\.\.\/tui\/app\.js['"]\s*\)/)
  })
})

describe('writing to the terminal from the engine and the TUI', () => {
  it('has no process.stdout or process.stderr in src/engine or src/tui except terminalSession.ts', async () => {
    const files = [
      ...(await sourceFiles(path.join(SRC, 'engine'))),
      ...(await sourceFiles(path.join(SRC, 'tui'))),
    ]
    const offenders: string[] = []
    for (const file of files) {
      if (file === path.join(SRC, 'tui', 'terminalSession.ts')) continue
      if (/process\.std(out|err)\b/.test(await readFile(file, 'utf8'))) {
        offenders.push(path.relative(SRC, file))
      }
    }

    expect(files.length).toBeGreaterThan(20)
    expect(offenders).toEqual([])
  })
})
