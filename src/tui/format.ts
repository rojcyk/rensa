import stringWidth from 'string-width'

/** `m:ss`, or `h:mm:ss` from an hour on. Negative or non-finite input reads as zero. */
export function formatElapsed(ms: number): string {
  const total = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  return hours > 0 ? `${hours}:${pad2(minutes)}:${pad2(seconds)}` : `${minutes}:${pad2(seconds)}`
}

/**
 * A token count: below 1000 as is (`850`), else thousands with one
 * decimal (`12.4k`). Negative or non-finite input reads as zero.
 */
export function formatTokens(n: number): string {
  const count = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0
  return count < 1000 ? String(count) : `${(count / 1000).toFixed(1)}k`
}

export const ELLIPSIS = '…'

const graphemes = new Intl.Segmenter()

/**
 * `text` cut to at most `width` terminal cells, ending in `…` when
 * anything was cut. Measured in cells and cut between grapheme clusters,
 * so a wide character or an emoji sequence is never split. A width below
 * 1 gives the empty string.
 */
export function truncateEnd(text: string, width: number): string {
  const cells = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0
  if (stringWidth(text) <= cells) return text
  if (cells === 0) return ''
  const room = cells - stringWidth(ELLIPSIS)
  let out = ''
  let used = 0
  for (const { segment } of graphemes.segment(text)) {
    const w = stringWidth(segment)
    if (used + w > room) break
    out += segment
    used += w
  }
  return `${out}${ELLIPSIS}`
}

/** A multi-line string folded onto one line: line breaks and the space around them become one space. */
export function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim()
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}
