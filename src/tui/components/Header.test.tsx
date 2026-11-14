import { stripVTControlCharacters } from 'node:util'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { type Frames, renderFrames } from '../../testing/inkFrames.js'
import { SizeProvider } from '../size.js'
import { Header, type HeaderProps } from './Header.js'

// The right part's colors are asserted; force truecolor before Ink (and
// its chalk) load.
const previousForceColor = vi.hoisted(() => {
  const previous = process.env.FORCE_COLOR
  process.env.FORCE_COLOR = '3'
  return previous
})

afterAll(() => {
  if (previousForceColor === undefined) delete process.env.FORCE_COLOR
  else process.env.FORCE_COLOR = previousForceColor
})

let view: Frames | undefined

afterEach(() => {
  view?.unmount()
  view = undefined
})

const fg = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`
const TEXT = fg(230, 230, 230) // theme.text #e6e6e6
const MUTED = fg(154, 154, 154) // theme.muted #9a9a9a

const DETAIL: HeaderProps = {
  branch: 'feat/quote-limits',
  mode: 'in place',
  path: '~/Repos/trezor-suite',
  version: '0.1.0',
  chain: 'tdd-review',
}

function render(props: HeaderProps, size: { columns: number; rows: number }): Frames {
  view = renderFrames(
    <SizeProvider columns={size.columns} rows={size.rows}>
      <Header {...props} />
    </SizeProvider>,
    size,
  )
  return view
}

function header(props: HeaderProps, size: { columns: number; rows: number }): string[] {
  return stripVTControlCharacters(render(props, size).lastFrame()).split('\n')
}

describe('the header line and rule', () => {
  it('shows branch, mode, path, the version and the chain above a full-width rule at 80x24', () => {
    const lines = header(DETAIL, { columns: 80, rows: 24 })

    expect(lines).toEqual([
      `  ⎇ feat/quote-limits (in place)  ~/Repos/trezor-suite${' '.repeat(2)}rensa 0.1.0 / tdd-review`,
      '─'.repeat(80),
    ])
  })

  it('shows only the version on the right when no chain is open', () => {
    const lines = header(
      { branch: 'main', path: '~/Repos/trezor-suite', version: '0.1.0' },
      { columns: 80, rows: 24 },
    )

    expect(lines[0]).toBe(`  ⎇ main  ~/Repos/trezor-suite${' '.repeat(39)}rensa 0.1.0`)
  })

  it('draws the version and separator in muted and the chain name in text', () => {
    const frame = render(DETAIL, { columns: 80, rows: 24 }).lastFrame()

    // Same color, so Ink draws the version and separator as one run.
    expect(frame).toContain(`${MUTED}rensa 0.1.0 / ${TEXT}tdd-review`)
  })

  it('cuts the path, not the right part, when the line does not fit', () => {
    const lines = header(DETAIL, { columns: 60, rows: 24 })

    expect(lines[0]?.slice(-27)).toBe('…  rensa 0.1.0 / tdd-review')
    expect(lines[0]).toHaveLength(60)
  })

  it('drops the left part and cuts the chain name with an ellipsis when the right part does not fit', () => {
    const lines = header(DETAIL, { columns: 24, rows: 24 })

    expect(lines).toEqual(['    rensa 0.1.0 / tdd-r…', '─'.repeat(24)])
  })

  it('omits the rule in short compact mode at 80x9', () => {
    const lines = header(DETAIL, { columns: 80, rows: 9 })

    expect(lines.map((l) => l.trimEnd())).toEqual([
      `  ⎇ feat/quote-limits (in place)  ~/Repos/trezor-suite${' '.repeat(2)}rensa 0.1.0 / tdd-review`,
    ])
  })
})
