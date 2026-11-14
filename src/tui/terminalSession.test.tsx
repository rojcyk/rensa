import { type Instance, type RenderOptions, render, Text } from 'ink'
import type { ReactNode } from 'react'
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest'
import { diag } from '../engine/index.js'
import { MAX_FPS } from './frameRate.js'
import { createTeardown, type Session, startSession, terminalProblem } from './terminalSession.js'

// Ink's render and the process exit registry are the two boundaries the
// session does not own: render is replaced by a stub per test, and the
// registry's callbacks are collected so a test can run them as process
// exit would. Synchronous stderr writes (fd 2) are recorded in the same
// log as stdout writes, so their order can be asserted.

const boundary = vi.hoisted(() => ({
  render: undefined as undefined | ((node: ReactNode, options: RenderOptions) => Instance),
  shutdown: [] as Array<() => void>,
  /** stdout writes and fd-2 writes, in the order they happened. */
  log: [] as Array<{ to: 'stdout' | 'stderr'; text: string }>,
}))

vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>()
  return {
    ...actual,
    render: vi.fn((node: ReactNode, options: RenderOptions) => {
      if (!boundary.render) throw new Error('test did not set boundary.render')
      return boundary.render(node, options)
    }),
  }
})

vi.mock('../engine/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engine/index.js')>()
  return {
    ...actual,
    onShutdown: (fn: () => void) => {
      boundary.shutdown.push(fn)
      return () => {
        const i = boundary.shutdown.indexOf(fn)
        if (i !== -1) boundary.shutdown.splice(i, 1)
      }
    },
  }
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const writeSync = ((fd: number, data: unknown, ...rest: unknown[]) => {
    if (fd === 2) {
      boundary.log.push({ to: 'stderr', text: String(data) })
      return String(data).length
    }
    return (actual.writeSync as (...a: unknown[]) => number)(fd, data, ...rest)
  }) as typeof actual.writeSync
  return { ...actual, default: { ...actual, writeSync }, writeSync }
})

const renderMock = vi.mocked(render)

const ENTER_ALT = '\x1b[?1049h'
const LEAVE_ALT = '\x1b[?1049l'
const SHOW_CURSOR = '\x1b[?25h'
const RESET = '\x1b[0m'

/** Runs the collected shutdown callbacks as process exit does: LIFO, each once. */
function runShutdown(): void {
  for (const fn of boundary.shutdown.splice(0).reverse()) fn()
}

const stdoutText = () =>
  boundary.log
    .filter((e) => e.to === 'stdout')
    .map((e) => e.text)
    .join('')
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1

interface Deferred {
  promise: Promise<void>
  resolve(): void
  reject(error: unknown): void
}

function deferred(): Deferred {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * An Ink instance whose exit the test controls. `unmount` resolves the
 * exit as Ink's does, after running `onUnmount` (the writes Ink makes).
 */
function stubInstance(onUnmount: () => void = () => {}) {
  const exit = deferred()
  const unmount = vi.fn(() => {
    onUnmount()
    exit.resolve()
  })
  const instance: Instance = {
    rerender: vi.fn(),
    unmount,
    waitUntilExit: () => exit.promise as Promise<never>,
    waitUntilRenderFlush: () => Promise.resolve(),
    cleanup: vi.fn(),
    clear: vi.fn(),
  }
  return { instance, unmount, exit }
}

/** What Ink writes on unmount when it holds the alternate screen. */
const inkLeavesAlternateScreen = () => {
  process.stdout.write(LEAVE_ALT)
  process.stdout.write(SHOW_CURSOR)
}

const APP = <Text>rensa</Text>

let restoreDescriptors: Array<() => void> = []
const setRawMode = vi.fn()

function defineFor(target: object, prop: string, value: unknown): void {
  const previous = Object.getOwnPropertyDescriptor(target, prop)
  Object.defineProperty(target, prop, { value, configurable: true, writable: true })
  restoreDescriptors.push(() => {
    if (previous) Object.defineProperty(target, prop, previous)
    else delete (target as Record<string, unknown>)[prop]
  })
}

/** A terminal on stdout and stdin, or a pipe. */
function terminal(opts: { stdoutTTY: boolean; stdinTTY: boolean }): void {
  defineFor(process.stdout, 'isTTY', opts.stdoutTTY)
  defineFor(process.stdin, 'isTTY', opts.stdinTTY)
  defineFor(process.stdin, 'setRawMode', setRawMode)
}

beforeEach(() => {
  boundary.render = undefined
  boundary.shutdown = []
  boundary.log = []
  setRawMode.mockReset()
  renderMock.mockClear()
  vi.stubEnv('CI', undefined)
  vi.stubEnv('CONTINUOUS_INTEGRATION', undefined)
  vi.stubEnv('RENSA_DEBUG', undefined)
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    boundary.log.push({ to: 'stdout', text: String(chunk) })
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    boundary.log.push({ to: 'stderr', text: String(chunk) })
    return true
  })
  terminal({ stdoutTTY: true, stdinTTY: true })
})

afterEach(() => {
  // Whatever a test left running: restores the console and warning listeners.
  runShutdown()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const restore of restoreDescriptors.reverse()) restore()
  restoreDescriptors = []
})

/** Whether `promise` has settled once pending callbacks have run. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false
  promise.then(
    () => {
      done = true
    },
    () => {
      done = true
    },
  )
  await new Promise<void>((resolve) => setImmediate(resolve))
  return done
}

describe('checking for a terminal before the TUI starts', () => {
  const RUN_HINT = 'use `rensa run <chain>` to run a chain with no UI'

  it('reports no problem when stdout and stdin are both terminals', () => {
    expect(terminalProblem(true, true)).toBeUndefined()
  })

  it('names stdin when stdout is a terminal and stdin is not', () => {
    expect(terminalProblem(true, false)).toBe(`the TUI needs a terminal on stdin; ${RUN_HINT}`)
  })

  it('names stdout when stdin is a terminal and stdout is not', () => {
    expect(terminalProblem(false, true)).toBe(`the TUI needs a terminal on stdout; ${RUN_HINT}`)
  })

  it('names both when neither stdout nor stdin is a terminal', () => {
    expect(terminalProblem(false, false)).toBe(
      `the TUI needs a terminal on stdin and stdout; ${RUN_HINT}`,
    )
  })

  it('reads the process streams when called with no arguments and stdin is a pipe', () => {
    terminal({ stdoutTTY: true, stdinTTY: false })

    expect(terminalProblem()).toBe(`the TUI needs a terminal on stdin; ${RUN_HINT}`)
  })

  it('reads the process streams when called with no arguments and both are terminals', () => {
    expect(terminalProblem()).toBeUndefined()
  })
})

describe('Ink render options', () => {
  it('renders on the alternate screen, interactive, with the session options', () => {
    const stub = stubInstance()
    boundary.render = () => stub.instance

    startSession(APP)

    expect(renderMock).toHaveBeenCalledTimes(1)
    expect(renderMock.mock.calls[0]?.[1]).toEqual({
      alternateScreen: true,
      interactive: true,
      incrementalRendering: true,
      maxFps: MAX_FPS,
      exitOnCtrlC: false,
      patchConsole: false,
    })
  })

  it('still renders interactive on the alternate screen when CI is set', () => {
    vi.stubEnv('CI', 'true')
    const stub = stubInstance()
    boundary.render = () => stub.instance

    startSession(APP)

    expect(renderMock.mock.calls[0]?.[1]).toMatchObject({
      alternateScreen: true,
      interactive: true,
    })
  })
})

describe('repainting on resize', () => {
  const HOME_AND_ERASE_DOWN = '\x1b[H\x1b[J'
  const INK_CLEARED = '<ink cleared>'
  const INK_RESIZED = '<ink resized>'
  let inkListeners: Array<() => void> = []

  afterEach(() => {
    for (const listener of inkListeners) process.stdout.off('resize', listener)
    inkListeners = []
  })

  /**
   * Starts a session on a 100x30 terminal whose Ink stub, like Ink,
   * subscribes to resize inside render and writes to stdout when it
   * clears, so the order of everything that reaches the terminal shows.
   */
  function sessionOnTerminal() {
    defineFor(process.stdout, 'columns', 100)
    defineFor(process.stdout, 'rows', 30)
    const stub = stubInstance()
    vi.mocked(stub.instance.clear).mockImplementation(() => {
      process.stdout.write(INK_CLEARED)
    })
    boundary.render = () => {
      const listener = () => boundary.log.push({ to: 'stdout', text: INK_RESIZED })
      inkListeners.push(listener)
      process.stdout.on('resize', listener)
      return stub.instance
    }
    const session = startSession(APP)
    boundary.log = []
    return { stub, session }
  }

  function resizeTo(columns: number, rows: number): void {
    defineFor(process.stdout, 'columns', columns)
    defineFor(process.stdout, 'rows', rows)
    process.stdout.emit('resize')
  }

  it.each([
    ['wider', 120, 30],
    ['narrower', 80, 30],
    ['taller', 100, 40],
    ['shorter', 100, 20],
  ])(
    'clears Ink, then erases the screen from the top-left, before Ink redraws when the terminal gets %s',
    (_change, columns, rows) => {
      sessionOnTerminal()

      resizeTo(columns, rows)

      expect(stdoutText()).toBe(INK_CLEARED + HOME_AND_ERASE_DOWN + INK_RESIZED)
    },
  )

  it('leaves the screen alone when a resize event reports the same size', () => {
    sessionOnTerminal()

    resizeTo(100, 30)

    expect(stdoutText()).toBe(INK_RESIZED)
  })

  it('erases again on each later size change', () => {
    sessionOnTerminal()

    resizeTo(120, 30)
    resizeTo(120, 40)

    const repaint = INK_CLEARED + HOME_AND_ERASE_DOWN + INK_RESIZED
    expect(stdoutText()).toBe(repaint + repaint)
  })

  it.each([
    ['CI is set', 'CI', 'true'],
    ['CONTINUOUS_INTEGRATION is set', 'CONTINUOUS_INTEGRATION', '1'],
  ])(
    'clears Ink and erases the screen before Ink redraws when the terminal resizes and %s',
    (_condition, variable, value) => {
      vi.stubEnv(variable, value)
      sessionOnTerminal()

      resizeTo(120, 40)

      expect(stdoutText()).toBe(INK_CLEARED + HOME_AND_ERASE_DOWN + INK_RESIZED)
    },
  )

  it('leaves resizing to Ink when stdout is not a terminal', () => {
    terminal({ stdoutTTY: false, stdinTTY: true })
    sessionOnTerminal()

    resizeTo(120, 40)

    expect(stdoutText()).toBe(INK_RESIZED)
  })

  it('stops erasing on resize after a normal quit', async () => {
    const { session } = sessionOnTerminal()
    await session.quit()
    boundary.log = []

    resizeTo(120, 40)

    expect(stdoutText()).toBe(INK_RESIZED)
  })

  it('stops erasing on resize once Ink exits on its own', async () => {
    const { stub, session } = sessionOnTerminal()
    stub.exit.resolve()
    await session.done
    boundary.log = []

    resizeTo(120, 40)

    expect(stdoutText()).toBe(INK_RESIZED)
  })

  it('stops erasing on resize after the fatal restore', () => {
    sessionOnTerminal()
    runShutdown()
    boundary.log = []

    resizeTo(120, 40)

    expect(stdoutText()).toBe(INK_RESIZED)
  })
})

describe('observing how Ink exited', () => {
  it('keeps done pending until Ink exits', async () => {
    const stub = stubInstance()
    boundary.render = () => stub.instance

    const session = startSession(APP)

    expect(await settled(session.done)).toBe(false)
  })

  it('resolves done without quit when Ink exits on its own', async () => {
    const stub = stubInstance()
    boundary.render = () => stub.instance
    const session = startSession(APP)

    stub.exit.resolve()

    await expect(session.done).resolves.toBeUndefined()
    expect(stub.unmount).not.toHaveBeenCalled()
  })

  it('rejects done with the same error, runs the teardown once and releases the terminal when React crashes', async () => {
    const stub = stubInstance()
    // Were the record not released, the fatal restore would try Ink again
    // and, on this throw, write the leave sequence itself.
    stub.unmount.mockImplementation(() => {
      throw new Error('yoga node already freed')
    })
    boundary.render = () => stub.instance
    const teardown = createTeardown()
    const cleanup = vi.fn()
    teardown.add(cleanup)
    const session = startSession(APP, teardown)
    const crash = new Error('Cannot read properties of undefined (reading "status")')

    stub.exit.reject(crash)
    await expect(session.done).rejects.toBe(crash)
    runShutdown()

    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(stub.unmount).not.toHaveBeenCalled()
    expect(stdoutText()).toBe('')
  })

  it('returns the same promise from a second quit and unmounts once', async () => {
    const stub = stubInstance()
    boundary.render = () => stub.instance
    const session = startSession(APP)

    const first = session.quit()
    const second = session.quit()
    await first

    expect(second).toBe(first)
    expect(stub.unmount).toHaveBeenCalledTimes(1)
    await expect(session.done).resolves.toBeUndefined()
  })

  it('runs the UI teardown before unmounting Ink on quit', async () => {
    const order: string[] = []
    const stub = stubInstance(() => order.push('unmount'))
    boundary.render = () => stub.instance
    const teardown = createTeardown()
    teardown.add(() => order.push('teardown'))
    const session = startSession(APP, teardown)

    await session.quit()

    expect(order).toEqual(['teardown', 'unmount'])
  })
})

describe('the fatal restore on a terminal', () => {
  it('lets Ink unmount and writes nothing of its own, so one leave sequence reaches the terminal', () => {
    const stub = stubInstance(inkLeavesAlternateScreen)
    boundary.render = () => stub.instance
    startSession(APP)

    runShutdown()

    expect(stub.unmount).toHaveBeenCalledTimes(1)
    expect(stdoutText()).toBe(`${LEAVE_ALT}${SHOW_CURSOR}`)
  })

  it('emits nothing when the callback runs a second time', () => {
    const stub = stubInstance(inkLeavesAlternateScreen)
    boundary.render = () => stub.instance
    startSession(APP)
    const [callback] = boundary.shutdown
    assert(callback, 'startSession registered a shutdown callback')
    callback()
    boundary.log = []

    callback()

    expect(stdoutText()).toBe('')
    expect(stub.unmount).toHaveBeenCalledTimes(1)
  })

  it('leaves the alternate screen, shows the cursor, resets attributes and leaves raw mode itself, once, when Ink unmount throws', () => {
    const stub = stubInstance()
    stub.unmount.mockImplementation(() => {
      throw new Error('yoga node already freed')
    })
    boundary.render = () => stub.instance
    startSession(APP)
    const [callback] = boundary.shutdown
    assert(callback, 'startSession registered a shutdown callback')

    callback()
    callback()

    expect(stdoutText()).toBe(`${LEAVE_ALT}${SHOW_CURSOR}${RESET}`)
    expect(setRawMode.mock.calls).toEqual([[false]])
  })

  it('leaves the alternate screen and shows the cursor but resets nothing when render throws after entering the screen', () => {
    boundary.render = () => {
      process.stdout.write(ENTER_ALT)
      throw new Error('kitty keyboard probe failed')
    }

    expect(() => startSession(APP)).toThrow('kitty keyboard probe failed')
    runShutdown()

    expect(count(stdoutText(), LEAVE_ALT)).toBe(1)
    expect(count(stdoutText(), SHOW_CURSOR)).toBe(1)
    expect(stdoutText()).not.toContain(RESET)
  })

  it('leaves the alternate screen and shows the cursor itself when Ink unmount throws and CI is set', () => {
    vi.stubEnv('CI', 'true')
    const stub = stubInstance()
    stub.unmount.mockImplementation(() => {
      throw new Error('yoga node already freed')
    })
    boundary.render = () => stub.instance
    startSession(APP)

    runShutdown()

    expect(stdoutText()).toBe(`${LEAVE_ALT}${SHOW_CURSOR}${RESET}`)
  })
})

describe('the fatal restore when stdout is not a terminal', () => {
  it('never leaves the alternate screen when Ink unmount throws', () => {
    terminal({ stdoutTTY: false, stdinTTY: false })
    const stub = stubInstance()
    stub.unmount.mockImplementation(() => {
      throw new Error('yoga node already freed')
    })
    boundary.render = () => stub.instance
    startSession(APP)

    runShutdown()

    expect(stdoutText()).not.toContain(LEAVE_ALT)
    expect(setRawMode).not.toHaveBeenCalled()
  })
})

describe('the fatal restore before the TUI started', () => {
  it('emits nothing when no session was started', () => {
    runShutdown()

    expect(boundary.log).toEqual([])
  })
})

describe('capturing foreign output during a session', () => {
  const nextTick = () => new Promise<void>((resolve) => process.nextTick(resolve))

  async function sessionWithForeignOutput(): Promise<Session> {
    const stub = stubInstance()
    boundary.render = () => stub.instance
    const session = startSession(APP)
    diag('engine', 'provider check for codex took 4100 ms')
    // biome-ignore lint/suspicious/noConsole: the dependency output being captured
    console.warn('punycode is deprecated')
    process.emitWarning('rensa-test MaxListenersExceededWarning probe')
    await nextTick()
    await nextTick()
    return session
  }

  it('writes nothing to stdout or stderr while the session runs', async () => {
    await sessionWithForeignOutput()

    expect(boundary.log).toEqual([])
  })

  it('holds the three lines in order in the captured list after quit', async () => {
    const session = await sessionWithForeignOutput()

    await session.quit()

    expect(session.captured).toEqual([
      expect.stringContaining('provider check for codex took 4100 ms'),
      'punycode is deprecated',
      expect.stringContaining('rensa-test MaxListenersExceededWarning probe'),
    ])
  })

  it('restores console.warn and the warning listeners after quit', async () => {
    // biome-ignore lint/suspicious/noConsole: compared, never called
    const originalWarn = console.warn
    const listenersBefore = process.listeners('warning')
    const session = await sessionWithForeignOutput()

    await session.quit()

    // biome-ignore lint/suspicious/noConsole: compared, never called
    expect(console.warn).toBe(originalWarn)
    expect(process.listeners('warning')).toEqual(listenersBefore)
  })

  it('restores console.warn and the warning listeners after the fatal restore', async () => {
    // biome-ignore lint/suspicious/noConsole: compared, never called
    const originalWarn = console.warn
    const listenersBefore = process.listeners('warning')
    await sessionWithForeignOutput()

    runShutdown()

    // biome-ignore lint/suspicious/noConsole: compared, never called
    expect(console.warn).toBe(originalWarn)
    expect(process.listeners('warning')).toEqual(listenersBefore)
  })
})

describe('handing out captured lines', () => {
  function sessionWith(onUnmount: () => void = () => {}) {
    const stub = stubInstance(onUnmount)
    boundary.render = () => stub.instance
    return startSession(APP)
  }

  it('hands out each captured line once', () => {
    const session = sessionWith()
    // biome-ignore lint/suspicious/noConsole: the dependency output being captured
    console.log('first dependency line')
    const first = session.drainCaptured()
    // biome-ignore lint/suspicious/noConsole: the dependency output being captured
    console.log('second dependency line')

    expect([first, session.drainCaptured(), session.drainCaptured()]).toEqual([
      ['first dependency line'],
      ['second dependency line'],
      [],
    ])
  })

  it('prints the undrained lines once, on stderr after the terminal is restored, when the process dies during the session', () => {
    const session = sessionWith(inkLeavesAlternateScreen)
    // biome-ignore lint/suspicious/noConsole: the dependency output being captured
    console.log('already shown line')
    session.drainCaptured()
    // biome-ignore lint/suspicious/noConsole: the dependency output being captured
    console.log('undrained line')
    const [callback] = boundary.shutdown
    assert(callback, 'startSession registered a shutdown callback')

    callback()
    callback()

    expect(boundary.log).toEqual([
      { to: 'stdout', text: LEAVE_ALT },
      { to: 'stdout', text: SHOW_CURSOR },
      { to: 'stderr', text: 'undrained line\n' },
    ])
  })

  it('prints nothing at exit after a normal quit when RENSA_DEBUG is not set', async () => {
    const session = sessionWith()
    // biome-ignore lint/suspicious/noConsole: the dependency output being captured
    console.log('dropped line')
    await session.quit()
    boundary.log = []

    runShutdown()

    expect(boundary.log).toEqual([])
  })
})
