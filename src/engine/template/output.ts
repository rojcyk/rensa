/**
 * Renders an agent step's output map as one `### <label>` section per
 * entry: strings verbatim, anything else as pretty JSON.
 */
export function renderOutputMap(map: Record<string, unknown>): string {
  return Object.entries(map)
    .map(([label, value]) => {
      const body = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
      return `### ${label}\n\n${body}`
    })
    .join('\n\n')
}

/**
 * Keeps the last `maxBytes` UTF-8 bytes of `text`, starting at a line
 * boundary, behind a marker line that says where the full output is.
 * When no whole line fits, keeps the end of the last line instead.
 */
export function tail(text: string, maxBytes: number, fullPath: string): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return text
  let start = bytes.length - maxBytes
  const newline = bytes[start - 1] === 0x0a ? start - 1 : bytes.indexOf(0x0a, start)
  if (newline !== -1 && newline + 1 < bytes.length) {
    start = newline + 1
  } else {
    // No whole line fits: at least avoid splitting a character.
    while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++
  }
  return `[… ${start} bytes cut; full output: ${fullPath}]\n${bytes.subarray(start).toString('utf8')}`
}

const FENCE = '```'

/**
 * Returns the JSON object the text ends with, or undefined. A closing
 * code fence after the object is allowed; anything else after it is not.
 */
export function extractTrailingJson(text: string): Record<string, unknown> | undefined {
  let body = text.trimEnd()
  if (body.endsWith(FENCE)) body = body.slice(0, -FENCE.length).trimEnd()
  if (!body.endsWith('}')) return undefined

  const start = matchingOpenBrace(body)
  if (start === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(body.slice(start))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  // Narrowed above: a non-null, non-array object from JSON.parse.
  return parsed as Record<string, unknown>
}

/** Index of the `{` matching the `}` that ends `body`, skipping strings. */
function matchingOpenBrace(body: string): number | undefined {
  let depth = 0
  let inString = false
  for (let i = body.length - 1; i >= 0; i--) {
    const ch = body[i]
    if (ch === '"' && !isEscaped(body, i)) {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === '}') depth++
    else if (ch === '{') {
      depth--
      if (depth === 0) return i
    }
  }
  return undefined
}

/** A quote is escaped when an odd number of backslashes precede it. */
function isEscaped(text: string, index: number): boolean {
  let slashes = 0
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) slashes++
  return slashes % 2 === 1
}

/** Appends user notes as a numbered list. Notes are never rendered. */
export function appendNotes(message: string, notes: string[]): string {
  if (notes.length === 0) return message
  const list = notes.map((note, i) => `${i + 1}. ${note}`).join('\n')
  return `${message}\n\n## User notes\n\n${list}`
}
