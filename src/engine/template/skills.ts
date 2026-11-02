import { cp, readdir, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { parse } from 'yaml'
import type { ResolvedChain } from '../config/types.js'
import { RensaError } from '../errors.js'
import type { RunDir } from '../run/dir.js'

// A chain's `skills:` reach the agent in two parts: each SKILL.md body
// inlined into the first prompt of a session, and the whole skill
// directory copied under the run directory, inside the checkout, where
// every provider's CLI may read it without extra flags or trust.

export const SKILL_BODY_MAX_BYTES = 32 * 1024
export const STEP_SKILLS_MAX_BYTES = 96 * 1024
export const SKILL_DIR_MAX_BYTES = 10 * 1024 * 1024

const SKILL_FILE = 'SKILL.md'
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/
// `<name>` becomes a directory under `runs/<id>/skills/`.
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export interface Skill {
  name: string
  /** SKILL.md without its front matter. */
  body: string
  dir: string
}

/**
 * Splits a SKILL.md into its name and body. The name is the front
 * matter's `name` if present, else the basename of `dir`.
 */
export function parseSkill(text: string, dir: string): Skill {
  const file = path.join(dir, SKILL_FILE)
  const match = FRONT_MATTER.exec(text)
  let name = path.basename(dir)
  let body = text
  if (match) {
    body = text.slice(match[0].length)
    let meta: unknown
    try {
      meta = parse(match[1] ?? '')
    } catch (err) {
      const why = err instanceof Error ? err.message.split('\n')[0] : String(err)
      throw new RensaError(
        'CONFIG_INVALID',
        `${file}: front matter is not valid YAML: ${why}`,
        file,
      )
    }
    if (typeof meta === 'object' && meta !== null && 'name' in meta) {
      const value = (meta as { name: unknown }).name
      if (typeof value !== 'string') {
        throw new RensaError(
          'CONFIG_INVALID',
          `${file}: front matter \`name\` must be a string`,
          file,
        )
      }
      name = value
    }
  }
  if (!SKILL_NAME.test(name)) {
    throw new RensaError(
      'CONFIG_INVALID',
      `${file}: skill name \`${name}\` may contain only letters, digits, \`.\`, \`_\` and \`-\``,
      file,
    )
  }
  return { name, body, dir }
}

/** Reads and parses `<dir>/SKILL.md`. */
export async function readSkill(dir: string): Promise<Skill> {
  return parseSkill(await readFile(path.join(dir, SKILL_FILE), 'utf8'), dir)
}

/**
 * Load-time checks that need the skill files: names unique across the
 * chain, each body within 32 KB, each step's bodies within 96 KB, each
 * directory within 10 MB. Returns the first problem rather than
 * throwing, so the engine can attach it to the chain's summary.
 */
export async function validateSkills(chain: ResolvedChain): Promise<RensaError | undefined> {
  const skills = new Map<string, Promise<Skill>>()
  const read = (dir: string) => {
    let skill = skills.get(dir)
    if (!skill) {
      skill = readSkill(dir)
      skills.set(dir, skill)
    }
    return skill
  }
  const byName = new Map<string, string>()
  const sized = new Set<string>()
  try {
    for (const step of chain.steps) {
      if (step.kind !== 'agent' || step.agent.skills.length === 0) continue
      let total = 0
      for (const dir of step.agent.skills) {
        const skill = await read(dir)
        const other = byName.get(skill.name)
        if (other !== undefined && other !== dir) {
          return invalid(chain, `skills ${other} and ${dir} both have the name \`${skill.name}\``)
        }
        byName.set(skill.name, dir)
        const bytes = Buffer.byteLength(skill.body)
        if (bytes > SKILL_BODY_MAX_BYTES) {
          return invalid(
            chain,
            `skill ${dir}: SKILL.md body is ${kb(bytes)}, over the ${kb(SKILL_BODY_MAX_BYTES)} limit`,
          )
        }
        total += bytes
        if (!sized.has(dir)) {
          sized.add(dir)
          const size = await dirSize(dir, SKILL_DIR_MAX_BYTES)
          if (size > SKILL_DIR_MAX_BYTES) {
            return invalid(
              chain,
              `skill ${dir}: directory is over the ${SKILL_DIR_MAX_BYTES / 1024 / 1024} MB limit`,
            )
          }
        }
      }
      if (total > STEP_SKILLS_MAX_BYTES) {
        return invalid(
          chain,
          `step \`${step.id}\`: its skills' SKILL.md bodies total ${kb(total)}, over the ${kb(STEP_SKILLS_MAX_BYTES)} limit`,
        )
      }
    }
  } catch (err) {
    if (err instanceof RensaError) return err
    const code = (err as NodeJS.ErrnoException).code
    return invalid(chain, `cannot read a skill: ${code ?? String(err)}`)
  }
  return undefined
}

/**
 * Copies each skill directory to `runs/<id>/skills/<name>/`, keeping the
 * layout and file modes and following symlinks. A skill already copied
 * by an earlier step of the run is left as it is. Returns the copies in
 * the order given.
 */
export async function stageSkills(
  runDir: RunDir,
  skills: ReadonlyArray<{ dir: string }>,
): Promise<ReadonlyArray<{ name: string; dir: string }>> {
  const staged: Array<{ name: string; dir: string }> = []
  const names = new Map<string, string>()
  for (const { dir } of skills) {
    let skill: Skill
    try {
      skill = await readSkill(dir)
    } catch (err) {
      if (err instanceof RensaError) throw err
      throw new RensaError('TEMPLATE', `skill directory is gone or unreadable: ${dir}`, dir)
    }
    const other = names.get(skill.name)
    if (other !== undefined && other !== dir) {
      throw new RensaError(
        'CONFIG_INVALID',
        `skills ${other} and ${dir} both have the name \`${skill.name}\``,
        dir,
      )
    }
    names.set(skill.name, dir)
    const dest = path.join(runDir.root, 'skills', skill.name)
    if (!(await exists(dest))) {
      try {
        await cp(dir, dest, {
          recursive: true,
          dereference: true,
          errorOnExist: true,
          force: false,
        })
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT' && !(await exists(dir))) {
          throw new RensaError('TEMPLATE', `skill directory is gone: ${dir}`, dir)
        }
        throw err
      }
    }
    staged.push({ name: skill.name, dir: dest })
  }
  return staged
}

/**
 * Appends a `## Skills` section: per skill a `### <name>` heading, a
 * `Files:` line naming the copy, a blank line and the body verbatim.
 * Placeholders inside a body are not rendered; a skill is data.
 */
export function appendSkills(
  message: string,
  staged: ReadonlyArray<{ name: string; body: string; dir: string }>,
): string {
  if (staged.length === 0) return message
  const sections = staged.map((s) => `### ${s.name}\nFiles: ${s.dir}\n\n${s.body}`)
  return `${message}\n\n## Skills\n\n${sections.join('\n\n')}`
}

/** Total bytes of the files under `dir`, following symlinks; stops counting past `limit`. */
async function dirSize(dir: string, limit: number): Promise<number> {
  let total = 0
  const seen = new Set<string>()
  const walk = async (current: string): Promise<void> => {
    const real = await realpath(current)
    if (seen.has(real)) return
    seen.add(real)
    for (const entry of await readdir(current)) {
      if (total > limit) return
      const full = path.join(current, entry)
      const info = await stat(full)
      if (info.isDirectory()) await walk(full)
      else total += info.size
    }
  }
  await walk(dir)
  return total
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

function invalid(chain: ResolvedChain, message: string): RensaError {
  return new RensaError('CONFIG_INVALID', `${chain.sources.chain}: ${message}`, chain.sources.chain)
}

function kb(bytes: number): string {
  return `${Math.ceil(bytes / 1024)} KB`
}
