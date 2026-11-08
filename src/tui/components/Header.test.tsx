import { stripVTControlCharacters } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { type Frames, renderFrames } from '../../testing/inkFrames.js'
import { SizeProvider } from '../size.js'
import { Header } from './Header.js'

let view: Frames | undefined

afterEach(() => {
  view?.unmount()
  view = undefined
})

function header(size: { columns: number; rows: number }): string[] {
  view = renderFrames(
    <SizeProvider columns={size.columns} rows={size.rows}>
      <Header
        branch="feat/quote-limits"
        mode="in place"
        path="~/Repos/trezor-suite"
        right="tdd-review"
      />
    </SizeProvider>,
    size,
  )
  return stripVTControlCharacters(view.lastFrame()).split('\n')
}

describe('the header line and rule', () => {
  it('shows branch, mode, path and the right part above a full-width rule at 80x24', () => {
    const lines = header({ columns: 80, rows: 24 })

    expect(lines).toEqual([
      `⎇ feat/quote-limits (in place)  ~/Repos/trezor-suite${' '.repeat(18)}tdd-review`,
      '─'.repeat(80),
    ])
  })

  it('omits the rule in short compact mode at 80x9', () => {
    const lines = header({ columns: 80, rows: 9 })

    expect(lines.map((l) => l.trimEnd())).toEqual([
      `⎇ feat/quote-limits (in place)  ~/Repos/trezor-suite${' '.repeat(18)}tdd-review`,
    ])
  })
})
