import { RensaError } from '../errors.js'
import { isOutputMap, lookup, type Namespace } from './namespace.js'
import { renderOutputMap } from './output.js'

const PLACEHOLDER = /\{\{\s*([a-z_][\w.-]*)\s*\}\}/gi
/** Longest value `renderForShell` fills into its display text. */
const DISPLAY_VALUE_CHARS = 60

/** Placeholder names in `template`, unique, in order of first use. */
export function findPlaceholders(template: string): string[] {
  return [...new Set(Array.from(template.matchAll(PLACEHOLDER), (m) => m[1] ?? ''))]
}

/**
 * Replaces each `{{name}}` with its value from `values`, else from the
 * namespace. Load-time validation should make a miss impossible; this
 * is the runtime guard.
 */
export function render(template: string, values: Record<string, unknown>, ns: Namespace): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => resolve(name, values, ns))
}

export interface ShellBinding {
  /** The command with each placeholder replaced by a quoted `${RENSA_VAR_n}`. */
  script: string
  /** Placeholder values by environment variable name. */
  env: Record<string, string>
  /**
   * The command for messages: short one-line values filled in, the
   * rest left as `{{name}}`.
   */
  display: string
}

/**
 * Prepares a shell command whose placeholders hold untrusted text.
 * Values travel in environment variables and the command only expands
 * them, so the shell sees each as exactly one word and never parses it
 * as code. The quoting is chosen from the context the placeholder sits
 * in; a misread context can garble a value but cannot execute it.
 */
export function renderForShell(command: string, ns: Namespace): ShellBinding {
  const placeholder = new RegExp(PLACEHOLDER.source, 'iy')
  const env: Record<string, string> = {}
  const bound = new Map<string, string>()
  const texts = new Map<string, string>()
  /** Returns `${RENSA_VAR_n}` for `name`, binding its value on first use. */
  const bind = (name: string): string => {
    let variable = bound.get(name)
    if (variable === undefined) {
      variable = `RENSA_VAR_${bound.size}`
      bound.set(name, variable)
      const text = resolve(name, {}, ns)
      env[variable] = text
      texts.set(name, text)
    }
    return `\${${variable}}`
  }
  // `sh` is unquoted, at top level or inside `$(` / `(`; `ar` is inside
  // `$((`, where `<<` is a shift; `bq` is unquoted inside backticks.
  const context: Array<'sh' | 'ar' | 'bq' | 'sq' | 'dq'> = ['sh']
  /** Here-documents opened on the current line; bodies follow its newline. */
  let pending: HereDoc[] = []
  let script = ''

  const hereDocLine = (doc: HereDoc, line: string): string =>
    line.replace(HERE_DOC_TOKEN, (match, name: string | undefined) => {
      if (name === undefined) return doc.body === 'escape' ? `\\${match}` : match
      if (doc.body === 'literal') {
        throw new RensaError(
          'TEMPLATE',
          `placeholder \`{{${name}}}\` is in a quoted here-document whose delimiter \`${doc.delimiter}\` is not a plain word; use one such as EOF`,
        )
      }
      return bind(name)
    })
  /** Copies one here-document body starting at `from`; returns where it ends. */
  const copyHereDoc = (doc: HereDoc, from: number): number => {
    let at = from
    while (at < command.length) {
      const newline = command.indexOf('\n', at)
      const stop = newline === -1 ? command.length : newline
      const line = command.slice(at, stop)
      at = newline === -1 ? stop : stop + 1
      const closes = (doc.stripTabs ? line.replace(/^\t+/, '') : line) === doc.delimiter
      script += (closes ? line : hereDocLine(doc, line)) + (newline === -1 ? '' : '\n')
      if (closes) break
    }
    return at
  }

  let i = 0
  while (i < command.length) {
    const top = context[context.length - 1]
    placeholder.lastIndex = i
    const match = placeholder.exec(command)
    if (match) {
      const ref = bind(match[1] ?? '')
      script += top === 'sq' ? `'"${ref}"'` : top === 'dq' ? ref : `"${ref}"`
      i += match[0].length
      continue
    }
    const ch = command[i] ?? ''
    const next = command[i + 1] ?? ''
    if (top === 'sq') {
      if (ch === "'") context.pop()
    } else if (ch === '\\') {
      script += ch + next
      i += 2
      continue
    } else if (ch === '$' && next === '(') {
      const arithmetic = command[i + 2] === '('
      context.push('sh')
      if (arithmetic) context.push('ar')
      script += arithmetic ? '$((' : '$('
      i += arithmetic ? 3 : 2
      continue
    } else if (ch === '`') {
      if (top === 'bq') context.pop()
      else context.push('bq')
    } else if (top === 'dq') {
      if (ch === '"') context.pop()
    } else if (ch === '\n' && pending.length > 0) {
      script += ch
      i++
      for (const doc of pending) i = copyHereDoc(doc, i)
      pending = []
      continue
    } else if (ch === '<' && next === '<' && top === 'sh' && command[i + 2] !== '<') {
      const op = readHereDocOperator(command, i)
      if (op) {
        pending.push(op.doc)
        script += op.text
        i = op.end
        continue
      }
    } else if (ch === '#' && top === 'sh' && startsWord(command, i)) {
      // A comment runs to the newline; its quotes and placeholders are inert.
      const end = command.indexOf('\n', i)
      const stop = end === -1 ? command.length : end
      script += command.slice(i, stop)
      i = stop
      continue
    } else if (ch === "'") {
      context.push('sq')
    } else if (ch === '"') {
      context.push('dq')
    } else if (ch === '(') {
      context.push(top === 'ar' ? 'ar' : 'sh')
    } else if (ch === ')' && context.length > 1) {
      context.pop()
    }
    script += ch
    i++
  }
  const display = command.replace(PLACEHOLDER, (match, name: string) => {
    const text = texts.get(name) ?? match
    return text.length <= DISPLAY_VALUE_CHARS && !text.includes('\n') ? text : match
  })
  return { script, env, display }
}

interface HereDoc {
  /** The delimiter word with its quotes removed. */
  delimiter: string
  /** `<<-`: leading tabs are stripped before matching the delimiter. */
  stripTabs: boolean
  /**
   * `expand`: unquoted, placeholders become bare references. `escape`:
   * quoted, rewritten as unquoted with `\`, `$` and backticks escaped so
   * the body stays literal. `literal`: quoted with a delimiter that
   * cannot be unquoted, so a placeholder in it is an error.
   */
  body: 'expand' | 'escape' | 'literal'
}

/** A placeholder, or a character an unquoted here-document expands. */
const HERE_DOC_TOKEN = new RegExp(`${PLACEHOLDER.source}|[\\\\$\`]`, 'gi')
/** A delimiter that means the same written without quotes. */
const BARE_DELIMITER = /^[\w.+,@%:/-]+$/

/**
 * Reads the `<<` or `<<-` operator at `i` and its delimiter word. Returns
 * the text to emit, which unquotes a plain quoted delimiter, and the
 * index after the word; undefined when no word follows.
 */
function readHereDocOperator(
  command: string,
  i: number,
): { doc: HereDoc; text: string; end: number } | undefined {
  let j = i + 2
  const stripTabs = command[j] === '-'
  if (stripTabs) j++
  while (command[j] === ' ' || command[j] === '\t') j++
  const wordStart = j
  let delimiter = ''
  let quoted = false
  while (j < command.length && !/[\s;&|()<>]/.test(command[j] ?? '')) {
    const c = command[j] ?? ''
    if (c === "'" || c === '"') {
      quoted = true
      const close = command.indexOf(c, j + 1)
      const stop = close === -1 ? command.length : close
      delimiter += command.slice(j + 1, stop)
      j = stop + 1
    } else if (c === '\\') {
      quoted = true
      delimiter += command[j + 1] ?? ''
      j += 2
    } else {
      delimiter += c
      j++
    }
  }
  const end = Math.min(j, command.length)
  if (end === wordStart) return undefined
  const operator = command.slice(i, wordStart)
  const word = command.slice(wordStart, end)
  if (!quoted) return { doc: { delimiter, stripTabs, body: 'expand' }, text: operator + word, end }
  if (BARE_DELIMITER.test(delimiter)) {
    return { doc: { delimiter, stripTabs, body: 'escape' }, text: operator + delimiter, end }
  }
  return { doc: { delimiter, stripTabs, body: 'literal' }, text: operator + word, end }
}

/** True when `command[i]` begins a shell word, so a `#` there starts a comment. */
function startsWord(command: string, i: number): boolean {
  return i === 0 || /[\s;&|()<>]/.test(command[i - 1] ?? '')
}

function resolve(name: string, values: Record<string, unknown>, ns: Namespace): string {
  const value = Object.hasOwn(values, name) ? values[name] : lookup(ns, name)
  if (value === undefined) {
    throw new RensaError('TEMPLATE', `placeholder \`{{${name}}}\` has no value`)
  }
  return toText(value, ns)
}

function toText(value: unknown, ns: Namespace): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (isOutputMap(value, ns)) return renderOutputMap(value)
  return JSON.stringify(value, null, 2)
}
