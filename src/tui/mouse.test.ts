import { describe, expect, it } from 'vitest'
import {
  createWheelHub,
  filterMouseReads,
  type ReadableSource,
  type WheelDirection,
  wheelOf,
} from './mouse.js'

// SGR mouse reports as a terminal sends them: `ESC [ < button ; column ; row`
// then `M` for a press or `m` for a release.
const wheelUp = (column = 40, row = 12) => `\x1b[<64;${column};${row}M`
const wheelDown = (column = 40, row = 12) => `\x1b[<65;${column};${row}M`
const leftPress = '\x1b[<0;17;6M'
const leftRelease = '\x1b[<0;17;6m'
const ARROW_UP = '\x1b[A'
const ESC = '\x1b'

/**
 * A stdin stand-in: `read()` hands out what the terminal has sent, one
 * chunk per call, then null, as a paused Node stream does between
 * `readable` events.
 */
class TerminalInput implements ReadableSource {
  private readonly chunks: Array<string | Buffer> = []
  read(): string | Buffer | null {
    return this.chunks.shift() ?? null
  }
  /** The terminal sends more bytes. */
  send(...chunks: Array<string | Buffer>): void {
    this.chunks.push(...chunks)
  }
}

/**
 * A filtered stream whose reads and wheel turns land in one log, in the
 * order they happened, so a test can see that text before a report
 * reaches Ink before the turn is handled.
 */
function filtered() {
  const input = new TerminalInput()
  const log: string[] = []
  const restore = filterMouseReads(input, (direction) => log.push(`wheel ${direction}`))
  /** What Ink does on a `readable` event: read until null. */
  const inkReads = () => {
    for (;;) {
      const chunk = input.read()
      if (chunk === null) return
      log.push(`ink ${JSON.stringify(chunk)}`)
    }
  }
  return { input, log, restore, inkReads }
}

describe('reading the wheel direction from an SGR button code', () => {
  it.each<[string, number, WheelDirection]>([
    ['a plain wheel up', 64, 'up'],
    ['a plain wheel down', 65, 'down'],
    ['wheel up with shift', 64 | 4, 'up'],
    ['wheel down with meta', 65 | 8, 'down'],
    ['wheel up with ctrl', 64 | 16, 'up'],
    ['wheel down with shift, meta and ctrl', 65 | 4 | 8 | 16, 'down'],
  ])('returns the direction when the code is %s (%i)', (_case, button, direction) => {
    expect(wheelOf(button)).toBe(direction)
  })

  it.each([
    ['a left press', 0],
    ['a middle press', 1],
    ['a right press', 2],
    ['a drag with the left button', 32],
    ['a motion report with no button', 35],
    ['a horizontal wheel left', 66],
    ['a horizontal wheel right', 67],
    ['a ctrl-click', 0 | 16],
  ])('returns undefined when the code is %s (%i)', (_case, button) => {
    expect(wheelOf(button)).toBeUndefined()
  })
})

describe('fanning wheel turns out to subscribers', () => {
  it('delivers each turn to every subscriber when two are registered', () => {
    const hub = createWheelHub()
    const chains: WheelDirection[] = []
    const transcript: WheelDirection[] = []
    hub.subscribe((d) => chains.push(d))
    hub.subscribe((d) => transcript.push(d))

    hub.emit('down')
    hub.emit('up')

    expect({ chains, transcript }).toEqual({
      chains: ['down', 'up'],
      transcript: ['down', 'up'],
    })
  })

  it('stops delivering to a subscriber after its unsubscribe function is called', () => {
    const hub = createWheelHub()
    const turns: WheelDirection[] = []
    const unsubscribe = hub.subscribe((d) => turns.push(d))
    hub.emit('up')

    unsubscribe()
    hub.emit('down')

    expect(turns).toEqual(['up'])
  })
})

describe('filtering mouse reports out of stdin', () => {
  it('hands a wheel turn to onWheel and gives Ink nothing when a chunk is one wheel report', () => {
    const s = filtered()
    s.input.send(wheelDown())

    s.inkReads()

    expect(s.log).toEqual(['wheel down'])
  })

  it('passes keys through unchanged when a chunk has no mouse report', () => {
    const s = filtered()
    s.input.send(`q${ARROW_UP}\r`)

    s.inkReads()

    expect(s.log).toEqual([`ink ${JSON.stringify(`q${ARROW_UP}\r`)}`])
  })

  it('returns the text before a report first and handles the report on the next read when keys and a wheel turn share a chunk', () => {
    const s = filtered()
    s.input.send(`ab${wheelUp()}cd`)

    s.inkReads()

    expect(s.log).toEqual(['ink "ab"', 'wheel up', 'ink "cd"'])
  })

  it('returns the first text before handling any report when it is read once', () => {
    const s = filtered()
    s.input.send(`ab${wheelUp()}`)

    const first = s.input.read()

    expect({ first, log: s.log }).toEqual({ first: 'ab', log: [] })
  })

  it('handles every turn in order when several wheel reports arrive in one chunk', () => {
    const s = filtered()
    s.input.send(`${wheelDown()}${wheelDown(41, 12)}${wheelUp(41, 13)}`)

    s.inkReads()

    expect(s.log).toEqual(['wheel down', 'wheel down', 'wheel up'])
  })

  it('holds back a report cut off at the end of a chunk and joins it to the next one', () => {
    const s = filtered()
    s.input.send('\x1b[<6')
    s.inkReads()
    const afterFirstChunk = [...s.log]

    s.input.send('5;1;1M')
    s.inkReads()

    expect({ afterFirstChunk, log: s.log }).toEqual({ afterFirstChunk: [], log: ['wheel down'] })
  })

  it('returns the text before a cut-off report at once, then the turn and the text after it when the rest arrives', () => {
    const s = filtered()
    s.input.send('j\x1b[<64;8')
    s.inkReads()

    s.input.send(';3Mk')
    s.inkReads()

    expect(s.log).toEqual(['ink "j"', 'wheel up', 'ink "k"'])
  })

  it('lets a bare ESC through at once when it ends a chunk', () => {
    const s = filtered()
    s.input.send(ESC)

    s.inkReads()

    expect(s.log).toEqual([`ink ${JSON.stringify(ESC)}`])
  })

  it('drops a click press and release and gives onWheel nothing when the user clicks', () => {
    const s = filtered()
    s.input.send(`x${leftPress}${leftRelease}y`)

    s.inkReads()

    expect(s.log).toEqual(['ink "x"', 'ink "y"'])
  })

  it('reads a Buffer chunk as UTF-8 text and filters it when stdin has no encoding set', () => {
    const s = filtered()
    s.input.send(Buffer.from(`ž${wheelDown()}`, 'utf8'))

    s.inkReads()

    expect(s.log).toEqual(['ink "ž"', 'wheel down'])
  })
})

describe('removing the stdin filter', () => {
  it('gives reports back to the reader unfiltered after restore is called', () => {
    const s = filtered()
    s.restore()
    s.input.send(wheelUp())

    s.inkReads()

    expect(s.log).toEqual([`ink ${JSON.stringify(wheelUp())}`])
  })

  it('does nothing on a second restore when the filter was already removed', () => {
    const input = new TerminalInput()
    const original = input.read
    const restore = filterMouseReads(input, () => {})
    restore()

    restore()

    expect(input.read).toBe(original)
  })

  it('leaves a later replacement of read in place when restore is called after it', () => {
    const input = new TerminalInput()
    const restore = filterMouseReads(input, () => {})
    const later = () => 'replacement'
    input.read = later

    restore()

    expect(input.read).toBe(later)
  })
})
