import { readFile } from 'node:fs/promises'
import path from 'node:path'

// Fenced code blocks of a markdown file, for tests that pin what the
// README tells a user to type or copy. Imports nothing from the engine,
// so end-to-end tests can use it too.

export const README = path.resolve(import.meta.dirname, '../../README.md')

export interface FencedBlock {
  /** The info string after the opening fence, such as `yaml`; empty when none. */
  lang: string
  /** The lines between the fences, each ending in a newline. */
  body: string
  /** The last non-empty line before the opening fence, such as `` `.rensa/review.yaml`: ``. */
  caption: string
}

const OPENING = /^(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/

/**
 * Every top-level fenced block in `text`, in order. A block closes on a
 * fence of the same character at least as long as the one that opened it,
 * so a ```` fence can hold ``` blocks.
 */
export function fencedBlocks(text: string): FencedBlock[] {
  const lines = text.split('\n')
  const blocks: FencedBlock[] = []
  let caption = ''
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const open = OPENING.exec(line)
    if (!open) {
      if (line.trim() !== '') caption = line.trim()
      continue
    }
    const fence = open[1] ?? ''
    const closing = new RegExp(`^${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`)
    const body: string[] = []
    i++
    while (i < lines.length && !closing.test(lines[i] ?? '')) {
      body.push(`${lines[i]}\n`)
      i++
    }
    if (i >= lines.length) throw new Error(`unclosed ${fence} fence after: ${caption}`)
    blocks.push({ lang: open[2] ?? '', body: body.join(''), caption })
    caption = ''
  }
  return blocks
}

export async function readmeBlocks(): Promise<FencedBlock[]> {
  return fencedBlocks(await readFile(README, 'utf8'))
}

const FILE_CAPTION = /^`(\.rensa\/[^`]+)`/

/**
 * The files the README tells a user to create, keyed by their path from
 * the repository root: each block whose caption starts with a backquoted
 * `.rensa/...` path.
 */
export async function readmeRensaFiles(): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  for (const block of await readmeBlocks()) {
    const file = FILE_CAPTION.exec(block.caption)?.[1]
    if (file !== undefined) files.set(file, block.body)
  }
  return files
}
