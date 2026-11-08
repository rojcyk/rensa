import { stripVTControlCharacters } from 'node:util'
import stringWidth from 'string-width'
import wrapAnsi from 'wrap-ansi'
import type { RingBuffer, TranscriptRecord } from '../engine/index.js'
import { oneLine, truncateEnd } from './format.js'

// The transcript viewport (step 14, rule C): a pure model, no React. It
// owns all measurement: normalization, wrapping, per-record heights in a
// Fenwick tree over the ring buffer's slots, the logical anchor, follow
// mode and the streaming tail. The component only mounts what
// `visible()` returns.

/** Columns an expanded tool record's body is indented by; its body wraps at `width − EXPAND_INDENT`. */
export const EXPAND_INDENT = 2
const INDENT = ' '.repeat(EXPAND_INDENT)
const TAB_STOP = 8

/** Rows after the transcript that are not records: a failed agent's error and where its transcript is. */
export type TrailerKind = 'error' | 'info'

export interface TrailerLine {
  kind: TrailerKind
  text: string
}

export interface VisibleRow {
  /**
   * The record's absolute buffer index; the streaming tail is `buffer.length`
   * (the index its record will take) and trailer line `i` is `buffer.length + 1 + i`.
   */
  record: number
  kind: TranscriptRecord['kind'] | 'partial' | TrailerKind
  /** The visible slice of the record's lines, top to bottom. */
  lines: string[]
  /** The index of `lines[0]` among the record's lines; line 0 of a tool record is its `▸` header. */
  firstLine: number
  expanded: boolean
}

export interface ViewportAnchor {
  /** The record the top visible line belongs to (same numbering as `VisibleRow.record`). */
  record: number
  /** The grapheme offset into that record's `recordText` where the top line begins. */
  offset: number
}

export interface ViewportStats {
  /** Wrap operations: one per record (re)wrapped, per completed tail line, per tail rewrap, per trailer line. */
  wraps: number
  /** Record heights written to the tree: on append, on an expansion change, on a width change. */
  measured: number
  /** Indexed tree queries (prefix sums and line → record searches), each `O(log capacity)`. */
  lookups: number
}

const graphemes = new Intl.Segmenter()
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/

/**
 * The one normalization for measuring and displaying: `\r` dropped, ANSI
 * escape sequences dropped, NFC (what `wrap-ansi` applies itself, so
 * wrapping never changes the text), tabs expanded to 8-column stops.
 * Blank lines and trailing newlines are kept; each becomes an empty row.
 * Nothing else is stripped.
 *
 * Escape sequences (colour codes in shell and tool output) are dropped
 * deliberately, beyond the plan's "strips nothing else": `wrap-ansi`
 * closes and reopens styles at each row break, so styled rows would not
 * concatenate back to the text, offsets would count escape bytes, and an
 * embedded reset would end the theme colour the pane draws the row in.
 * Rows take their colour from the record kind only. A sequence cut off
 * at the end of the streaming tail may be stripped only in part until the
 * rest arrives; the last logical line is renormalized from its raw text on
 * every update, so this lasts one update.
 */
export function normalize(text: string): string {
  return text.split('\n').map(normalizeLine).join('\n')
}

/**
 * The text a record's lines are cut from, and what `ViewportAnchor.offset`
 * counts graphemes in: a text record's text, a note as `» <text>`, a
 * tool record as its `▸ <name> <summary>` header and, when expanded, a
 * newline and its body (pretty JSON input, then output). The tool header
 * is shown truncated to the width and the body indented; the offsets
 * still count this text.
 */
export function recordText(record: TranscriptRecord, expanded: boolean): string {
  switch (record.kind) {
    case 'text':
      return normalize(record.text)
    case 'note':
      return normalize(`» ${record.text}`)
    case 'tool':
      return expanded ? `${toolHeader(record)}\n${toolBody(record)}` : toolHeader(record)
    default:
      return exhaustive(record)
  }
}

type ToolRecord = Extract<TranscriptRecord, { kind: 'tool' }>

function toolHeader(record: ToolRecord): string {
  const summary = toolSummary(record.input)
  return normalizeLine(oneLine(summary === '' ? `▸ ${record.name}` : `▸ ${record.name} ${summary}`))
}

function toolBody(record: ToolRecord): string {
  const input = prettyJson(record.input)
  const parts = record.output === '' ? [input] : [input, record.output]
  return normalize(parts.join('\n'))
}

/** The first string field of the input, or the input itself when it is a string. */
function toolSummary(input: unknown): string {
  if (typeof input === 'string') return input
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return ''
  return Object.values(input).find((v): v is string => typeof v === 'string') ?? ''
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

function normalizeLine(line: string): string {
  return expandTabs(stripVTControlCharacters(line.replaceAll('\r', '')).normalize('NFC'))
}

function expandTabs(line: string): string {
  if (!line.includes('\t')) return line
  let out = ''
  let column = 0
  for (const chunk of line.split(/(\t)/)) {
    if (chunk === '\t') {
      const spaces = TAB_STOP - (column % TAB_STOP)
      out += ' '.repeat(spaces)
      column += spaces
    } else {
      out += chunk
      column += stringWidth(chunk)
    }
  }
  return out
}

function graphemeCount(text: string): number {
  if (PRINTABLE_ASCII.test(text)) return text.length
  let n = 0
  for (const _ of graphemes.segment(text)) n++
  return n
}

/**
 * One logical line (no `\n`) cut into rows of at most `width` cells,
 * whose concatenation is the line exactly: `wrap-ansi`, hard, untrimmed,
 * with a grapheme hard-wrap as the fallback should its rows not
 * partition the line. A grapheme wider than `width` (a wide character at
 * width 1) is the only row that can exceed it.
 */
function wrapLine(line: string, width: number): string[] {
  if (line === '' || stringWidth(line) <= width) return [line]
  const rows = wrapAnsi(line, width, { hard: true, trim: false }).split('\n')
  return rows.join('') === line ? rows : hardWrap(line, width)
}

function hardWrap(line: string, width: number): string[] {
  const rows: string[] = []
  let row = ''
  let used = 0
  for (const { segment } of graphemes.segment(line)) {
    const w = stringWidth(segment)
    if (used > 0 && used + w > width) {
      rows.push(row)
      row = ''
      used = 0
    }
    row += segment
    used += w
  }
  rows.push(row)
  return rows
}

/** Rows and the grapheme offset each begins at. */
interface Lines {
  lines: string[]
  starts: number[]
}

/**
 * Appends the rows of normalized `text`, each wrapped at `width` and
 * drawn after `indent`, counting graphemes from `offset`; returns the
 * offset after the text.
 */
function appendWrapped(
  out: Lines,
  text: string,
  at: { width: number; offset: number; indent?: string },
): number {
  const { width, indent = '' } = at
  let offset = at.offset
  const logical = text.split('\n')
  for (const [i, line] of logical.entries()) {
    for (const row of wrapLine(line, width)) {
      out.lines.push(indent + row)
      out.starts.push(offset)
      offset += graphemeCount(row)
    }
    if (i < logical.length - 1) offset += 1
  }
  return offset
}

/** The index of the line containing grapheme `offset`: the last start at or before it. */
function lineIndex(starts: readonly number[], offset: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if ((starts[mid] ?? 0) <= offset) lo = mid
    else hi = mid - 1
  }
  return Math.max(0, lo)
}

/** A cached record: its wrapped lines at the current width and expansion. */
interface Entry extends Lines {
  kind: TranscriptRecord['kind']
  expanded: boolean
}

/**
 * Sums over a fixed number of slots with point updates; prefix sums and
 * "which slot holds line L" in `O(log size)`.
 */
class Fenwick {
  private readonly tree: Float64Array
  private readonly values: Float64Array
  private readonly topBit: number

  constructor(readonly size: number) {
    this.tree = new Float64Array(size + 1)
    this.values = new Float64Array(size)
    let bit = 1
    while (bit * 2 <= size) bit *= 2
    this.topBit = bit
  }

  get(slot: number): number {
    return this.values[slot] ?? 0
  }

  set(slot: number, value: number): void {
    const delta = value - (this.values[slot] ?? 0)
    if (delta === 0) return
    this.values[slot] = value
    for (let i = slot + 1; i <= this.size; i += i & -i) this.tree[i] = (this.tree[i] ?? 0) + delta
  }

  /** The sum of slots `[0, end)`. */
  prefix(end: number): number {
    let sum = 0
    for (let i = end; i > 0; i -= i & -i) sum += this.tree[i] ?? 0
    return sum
  }

  /** The slot holding unit `target` (0 ≤ target < total) and the target's position inside it. */
  find(target: number): { slot: number; within: number } {
    let pos = 0
    let rem = target
    for (let bit = this.topBit; bit > 0; bit >>= 1) {
      const next = pos + bit
      const node = this.tree[next] ?? 0
      if (next <= this.size && node <= rem) {
        pos = next
        rem -= node
      }
    }
    return { slot: pos, within: rem }
  }

  /** Replaces every slot at once, in linear time. */
  reset(values: Float64Array): void {
    this.values.set(values)
    this.tree.fill(0)
    for (let i = 1; i <= this.size; i++) {
      this.tree[i] = (this.tree[i] ?? 0) + (values[i - 1] ?? 0)
      const parent = i + (i & -i)
      if (parent <= this.size) this.tree[parent] = (this.tree[parent] ?? 0) + (this.tree[i] ?? 0)
    }
  }
}

/** The streaming tail: completed logical lines wrapped once, the growing last one rewrapped. */
interface Tail {
  /** The raw text of the completed lines, through their last `\n`. */
  doneRaw: string
  done: Lines
  /** The grapheme offset where the last logical line begins. */
  doneGraphemes: number
  last: Lines
}

const EMPTY_TAIL: Tail = {
  doneRaw: '',
  done: { lines: [], starts: [] },
  doneGraphemes: 0,
  last: { lines: [], starts: [] },
}

/** Something after the records: the tail or a trailer line, never in the tree. */
interface TailItem {
  record: number
  kind: 'partial' | TrailerKind
  count: number
  slice(from: number, to: number): string[]
  start(line: number): number
  lineOf(offset: number): number
}

/**
 * The window onto one transcript ring buffer. Inputs (`sync`,
 * `setPartial`, `setWidth`, `setExpanded`, `setTrailer`) update the
 * cache and the tree; navigation moves a logical anchor; `visible(height)`
 * returns exactly the rows intersecting the window.
 */
export class TranscriptViewport {
  readonly stats: ViewportStats = { wraps: 0, measured: 0, lookups: 0 }

  private readonly buffer: RingBuffer<TranscriptRecord>
  private readonly capacity: number
  private readonly tree: Fenwick
  /** Absolute index → entry, for the retained range only. */
  private readonly cache = new Map<number, Entry>()
  private readonly expandedSet = new Set<number>()
  /** The retained range as of the last `sync()`: `[start, end)`. */
  private start: number
  private end: number
  private treeTotal = 0
  private wrapWidth: number

  private partialRaw: string | undefined
  private tail: Tail = EMPTY_TAIL
  private trailer: { kind: TrailerKind; text: string; lines: Lines }[] = []

  private followingFlag = true
  private anchorPos: ViewportAnchor
  /** The height of the last `visible()` call: the window `scrollBy` clamps to. */
  private lastHeight = 0

  constructor(buffer: RingBuffer<TranscriptRecord>, opts: { width: number; capacity: number }) {
    this.buffer = buffer
    // A tree smaller than the buffer would put two retained records in one slot.
    this.capacity = Math.max(cells(opts.capacity), buffer.capacity)
    this.tree = new Fenwick(this.capacity)
    this.wrapWidth = cells(opts.width)
    this.start = buffer.start
    this.end = buffer.start
    this.anchorPos = { record: buffer.start, offset: 0 }
    this.sync()
  }

  // -------------------------------------------------------------------------
  // Inputs
  // -------------------------------------------------------------------------

  /** Ingests the records appended to and evicted from the buffer since the last sync. */
  sync(): void {
    const start = this.buffer.start
    const end = this.buffer.length
    if (start === this.start && end === this.end) return
    const evictTo = Math.min(start, this.end)
    for (let i = this.start; i < evictTo; i++) this.drop(i)
    this.start = start
    for (let i = Math.max(this.end, start); i < end; i++) this.add(i)
    this.end = end
    if (this.anchorPos.record < start) this.anchorPos = { record: start, offset: 0 }
  }

  /**
   * The mutable streaming tail, once per published update. Completed
   * logical lines are wrapped once and kept; only the last, still
   * growing one is rewrapped, soft-wrap points included.
   */
  setPartial(text: string | undefined): void {
    if (text === this.partialRaw) return
    this.partialRaw = text
    if (text === undefined || text === '') {
      this.tail = EMPTY_TAIL
      return
    }
    const cut = text.lastIndexOf('\n')
    const doneRaw = cut < 0 ? '' : text.slice(0, cut + 1)
    let tail = this.tail
    if (!doneRaw.startsWith(tail.doneRaw)) tail = EMPTY_TAIL
    let done = tail.done
    let doneGraphemes = tail.doneGraphemes
    const fresh = doneRaw.slice(tail.doneRaw.length)
    if (fresh !== '') {
      done = { lines: [...done.lines], starts: [...done.starts] }
      for (const raw of fresh.slice(0, -1).split('\n')) {
        doneGraphemes =
          appendWrapped(done, normalizeLine(raw), {
            width: this.wrapWidth,
            offset: doneGraphemes,
          }) + 1
        this.stats.wraps++
      }
    }
    const last: Lines = { lines: [], starts: [] }
    appendWrapped(last, normalizeLine(text.slice(cut + 1)), {
      width: this.wrapWidth,
      offset: doneGraphemes,
    })
    this.stats.wraps++
    this.tail = { doneRaw, done, doneGraphemes, last }
  }

  /** The settled pane width; rewraps every retained record when it changes. */
  setWidth(width: number): void {
    const next = cells(width)
    if (next === this.wrapWidth) return
    this.wrapWidth = next
    const heights = new Float64Array(this.capacity)
    this.treeTotal = 0
    for (let i = this.start; i < this.end; i++) {
      const record = this.buffer.get(i)
      if (record === undefined) continue
      const entry = this.wrap(record, this.expandedSet.has(i))
      this.cache.set(i, entry)
      heights[i % this.capacity] = entry.lines.length
      this.treeTotal += entry.lines.length
      this.stats.measured++
    }
    this.tree.reset(heights)
    const partial = this.partialRaw
    this.partialRaw = undefined
    this.tail = EMPTY_TAIL
    this.setPartial(partial)
    this.wrapTrailer(this.trailer)
  }

  /** Shows or hides a tool record's body; anything else is ignored. */
  setExpanded(record: number, expanded: boolean): void {
    const entry = this.cache.get(record)
    if (entry === undefined || entry.kind !== 'tool') return
    if (expanded) this.expandedSet.add(record)
    else this.expandedSet.delete(record)
    if (entry.expanded === expanded) return
    const item = this.buffer.get(record)
    if (item === undefined) return
    this.place(record, this.wrap(item, expanded))
  }

  /** The lines after the records: a failed agent's error and transcript path. */
  setTrailer(lines: ReadonlyArray<TrailerLine>): void {
    const same =
      lines.length === this.trailer.length &&
      lines.every((l, i) => l.kind === this.trailer[i]?.kind && l.text === this.trailer[i]?.text)
    if (!same) this.wrapTrailer(lines)
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  /** Moves the window by wrapped lines; detaches. */
  scrollBy(lines: number): void {
    const maxTop = this.maxTop(this.lastHeight)
    const from = this.followingFlag ? maxTop : Math.min(this.lineOf(this.anchorPos), maxTop)
    this.followingFlag = false
    const step = Number.isFinite(lines) ? Math.trunc(lines) : 0
    this.anchorPos = this.anchorAt(Math.min(Math.max(0, from + step), maxTop))
  }

  /** `top` detaches at the first retained line; `bottom` reattaches. */
  scrollTo(edge: 'top' | 'bottom'): void {
    if (edge === 'bottom') {
      this.follow()
      return
    }
    this.followingFlag = false
    this.anchorPos = this.anchorAt(0)
  }

  follow(): void {
    this.followingFlag = true
  }

  detach(): void {
    this.followingFlag = false
  }

  get following(): boolean {
    return this.followingFlag
  }

  get anchor(): { record: number; offset: number } {
    return { ...this.anchorPos }
  }

  /** The current wrap width. */
  get width(): number {
    return this.wrapWidth
  }

  /** Cache entries held: never more than the buffer's capacity. */
  get retained(): number {
    return this.cache.size
  }

  // -------------------------------------------------------------------------
  // Output
  // -------------------------------------------------------------------------

  /**
   * The rows intersecting a window `height` lines tall, each with its
   * visible slice. While following, the window ends at the last line
   * and the anchor moves with it.
   */
  visible(height: number): VisibleRow[] {
    const rowsWanted = cells(height, 0)
    this.lastHeight = rowsWanted
    const maxTop = this.maxTop(rowsWanted)
    let top: number
    if (this.followingFlag) {
      top = maxTop
      this.anchorPos = this.anchorAt(top)
    } else {
      top = Math.min(this.lineOf(this.anchorPos), maxTop)
    }

    const rows: VisibleRow[] = []
    let remaining = Math.min(rowsWanted, this.totalLines() - top)
    if (remaining <= 0) return rows
    let { record, within } = this.locate(top)

    for (; remaining > 0 && record < this.end; record++, within = 0) {
      const entry = this.cache.get(record)
      if (entry === undefined) continue
      const lines = entry.lines.slice(within, within + remaining)
      rows.push({ record, kind: entry.kind, lines, firstLine: within, expanded: entry.expanded })
      remaining -= lines.length
    }
    for (const item of this.tailItems()) {
      if (remaining <= 0) break
      if (item.record < record) continue
      const lines = item.slice(within, within + remaining)
      rows.push({ record: item.record, kind: item.kind, lines, firstLine: within, expanded: false })
      remaining -= lines.length
      within = 0
    }
    return rows
  }

  totalLines(): number {
    let total = this.treeTotal
    for (const item of this.tailItems()) total += item.count
    return total
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private wrap(record: TranscriptRecord, expanded: boolean): Entry {
    this.stats.wraps++
    const width = this.wrapWidth
    const out: Entry = { kind: record.kind, expanded: false, lines: [], starts: [] }
    if (record.kind !== 'tool') {
      appendWrapped(out, recordText(record, false), { width, offset: 0 })
      return out
    }
    const header = toolHeader(record)
    out.lines.push(truncateEnd(header, width))
    out.starts.push(0)
    if (expanded) {
      out.expanded = true
      const bodyWidth = Math.max(1, width - EXPAND_INDENT)
      appendWrapped(out, toolBody(record), {
        width: bodyWidth,
        offset: graphemeCount(header) + 1,
        indent: INDENT,
      })
    }
    return out
  }

  private wrapTrailer(lines: ReadonlyArray<TrailerLine>): void {
    this.trailer = lines.map(({ kind, text }) => {
      const wrapped: Lines = { lines: [], starts: [] }
      appendWrapped(wrapped, normalize(text), { width: this.wrapWidth, offset: 0 })
      this.stats.wraps++
      return { kind, text, lines: wrapped }
    })
  }

  private add(index: number): void {
    const record = this.buffer.get(index)
    if (record === undefined) return
    this.place(index, this.wrap(record, false))
  }

  private drop(index: number): void {
    this.cache.delete(index)
    this.expandedSet.delete(index)
    const slot = index % this.capacity
    this.treeTotal -= this.tree.get(slot)
    this.tree.set(slot, 0)
  }

  /** Caches the entry and writes its height to its slot. */
  private place(index: number, entry: Entry): void {
    this.cache.set(index, entry)
    const slot = index % this.capacity
    this.treeTotal += entry.lines.length - this.tree.get(slot)
    this.tree.set(slot, entry.lines.length)
    this.stats.measured++
  }

  private prefix(end: number): number {
    this.stats.lookups++
    return this.tree.prefix(end)
  }

  /** Lines of the records in `[this.start, index)`; the live range is at most two slot ranges. */
  private linesBefore(index: number): number {
    const count = Math.min(index, this.end) - this.start
    if (count <= 0) return 0
    const from = this.start % this.capacity
    if (from + count <= this.capacity) return this.prefix(from + count) - this.prefix(from)
    return (
      this.prefix(this.capacity) - this.prefix(from) + this.prefix(from + count - this.capacity)
    )
  }

  /** The record holding tree line `line` (0 ≤ line < treeTotal) and the line's index inside it. */
  private recordAtLine(line: number): { record: number; within: number } {
    const from = this.start % this.capacity
    const count = this.end - this.start
    const before = this.prefix(from)
    const wraps = from + count > this.capacity
    const firstRun = wraps ? this.prefix(this.capacity) - before : this.treeTotal
    this.stats.lookups++
    if (line < firstRun) {
      const { slot, within } = this.tree.find(before + line)
      return { record: this.start + (slot - from), within }
    }
    const { slot, within } = this.tree.find(line - firstRun)
    return { record: this.start + (this.capacity - from) + slot, within }
  }

  /** The record and line index at window line `line` (0 ≤ line < totalLines). */
  private locate(line: number): { record: number; within: number } {
    if (line < this.treeTotal) return this.recordAtLine(line)
    let rest = line - this.treeTotal
    for (const item of this.tailItems()) {
      if (rest < item.count) return { record: item.record, within: rest }
      rest -= item.count
    }
    return { record: this.end, within: 0 }
  }

  private anchorAt(line: number): ViewportAnchor {
    if (this.totalLines() === 0) return { record: this.start, offset: 0 }
    const { record, within } = this.locate(Math.max(0, line))
    if (record < this.end) {
      return { record, offset: this.cache.get(record)?.starts[within] ?? 0 }
    }
    const item = this.tailItems().find((t) => t.record === record)
    return { record, offset: item?.start(within) ?? 0 }
  }

  /** The window line the anchor's line is on; past the end when its row is gone. */
  private lineOf(anchor: ViewportAnchor): number {
    const record = Math.max(anchor.record, this.start)
    if (record < this.end) {
      const entry = this.cache.get(record)
      const within = entry === undefined ? 0 : lineIndex(entry.starts, anchor.offset)
      return this.linesBefore(record) + within
    }
    let line = this.treeTotal
    for (const item of this.tailItems()) {
      if (item.record === record) return line + item.lineOf(anchor.offset)
      line += item.count
    }
    return line
  }

  private maxTop(height: number): number {
    return Math.max(0, this.totalLines() - height)
  }

  private tailItems(): TailItem[] {
    const items: TailItem[] = []
    const { done, last } = this.tail
    const doneCount = done.lines.length
    const count = doneCount + last.lines.length
    if (count > 0) {
      const lineAt = (i: number) => (i < doneCount ? done.lines[i] : last.lines[i - doneCount])
      const startAt = (i: number) => (i < doneCount ? done.starts[i] : last.starts[i - doneCount])
      items.push({
        record: this.end,
        kind: 'partial',
        count,
        slice: (from, to) => {
          const out: string[] = []
          for (let i = from; i < Math.min(to, count); i++) out.push(lineAt(i) ?? '')
          return out
        },
        start: (i) => startAt(i) ?? 0,
        lineOf: (offset) =>
          offset >= (last.starts[0] ?? Number.POSITIVE_INFINITY)
            ? doneCount + lineIndex(last.starts, offset)
            : lineIndex(done.starts, offset),
      })
    }
    for (const [i, line] of this.trailer.entries()) {
      const { lines, starts } = line.lines
      items.push({
        record: this.end + 1 + i,
        kind: line.kind,
        count: lines.length,
        slice: (from, to) => lines.slice(from, to),
        start: (n) => starts[n] ?? 0,
        lineOf: (offset) => lineIndex(starts, offset),
      })
    }
    return items
  }
}

/** A whole number of cells, at least `min`. */
function cells(n: number, min = 1): number {
  return Number.isFinite(n) ? Math.max(min, Math.floor(n)) : min
}

function exhaustive(value: never): never {
  throw new Error(`unhandled transcript record: ${JSON.stringify(value)}`)
}
