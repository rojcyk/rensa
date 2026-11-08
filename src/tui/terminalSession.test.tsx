import { type Instance, type RenderOptions, render, Text } from 'ink'
import type { ReactNode } from 'react'
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest'
import { diag } from '../engine/index.js'
import { MAX_FPS } from './frameRate.js'
import {
  createTeardown,
  type Mode,
  resolveMode,
  type Session,
  startSession,
  UsageError,
} from './terminalSession.js'

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

describe('resolving the session mode', () => {
  it.each([
    [{}, 'inline'],
    [{ fullscreen: true }, 'fullscreen'],
    [{ inline: true }, 'inline'],
  ] satisfies Array<[{ fullscreen?: boolean; inline?: boolean }, Mode]>)(
    'resolves %j on a terminal to %s',
    (flags, mode) => {
      expect(resolveMode(flags, {}, true)).toBe(mode)
    },
  )

  it('throws a usage error when both --fullscreen and --inline are given', () => {
    expect(() => resolveMode({ fullscreen: true, inline: true }, {}, true)).toThrow(UsageError)
  })

  it('resolves to inline when stdout is not a terminal even with --fullscreen', () => {
    expect(resolveMode({ fullscreen: true }, {}, false)).toBe('inline')
  })
})

describe('Ink render options', () => {
  it.each([
    ['fullscreen', true],
    ['inline', false],
  ] satisfies Array<[Mode, boolean]>)(
    'renders %s with the five session options',
    (mode, alternateScreen) => {
      const stub = stubInstance()
      boundary.render = () => stub.instance

      startSession(mode, APP)

      expect(renderMock).toHaveBeenCalledTimes(1)
      expect(renderMock.mock.calls[0]?.[1]).toEqual({
        alternateScreen,
        incrementalRendering: true,
        maxFps: MAX_FPS,
        exitOnCtrlC: false,
        patchConsole: false,
      })
    },
  )
})

describe('observing how Ink exited', () => {
  it('keeps done pending until Ink exits', async () => {
    const stub = stubInstance()
    boundary.render = () => stub.instance

    const session = startSession('inline', APP)

    expect(await settled(session.done)).toBe(false)
  })

  it('resolves done without quit when Ink exits on its own', async () => {
    const stub = stubInstance()
    boundary.render = () => stub.instance
    const session = startSession('inline', APP)

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
    const session = startSession('fullscreen', APP, teardown)
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
    const session = startSession('inline', APP)

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
    const session = startSession('inline', APP, teardown)

    await session.quit()

    expect(order).toEqual(['teardown', 'unmount'])
  })
})

describe('the fatal restore in fullscreen on a terminal', () => {
  it('lets Ink unmount and writes nothing of its own, so one leave sequence reaches the terminal', () => {
    const stub = stubInstance(inkLeavesAlternateScreen)
    boundary.render = () => stub.instance
    startSession('fullscreen', APP)

    runShutdown()

    expect(stub.unmount).toHaveBeenCalledTimes(1)
    expect(stdoutText()).toBe(`${LEAVE_ALT}${SHOW_CURSOR}`)
  })

  it('emits nothing when the callback runs a second time', () => {
    const stub = stubInstance(inkLeavesAlternateScreen)
    boundary.render = () => stub.instance
    startSession('fullscreen', APP)
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
    startSession('fullscreen', APP)
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

    expect(() => startSession('fullscreen', APP)).toThrow('kitty keyboard probe failed')
    runShutdown()

    expect(count(stdoutText(), LEAVE_ALT)).toBe(1)
    expect(count(stdoutText(), SHOW_CURSOR)).toBe(1)
    expect(stdoutText()).not.toContain(RESET)
  })
})

describe('the fatal restore in inline mode', () => {
  it('never leaves the alternate screen when Ink unmounts normally', () => {
    const stub = stubInstance()
    boundary.render = () => stub.instance
    startSession('inline', APP)

    runShutdown()

    expect(stdoutText()).not.toContain(LEAVE_ALT)
  })

  it('never leaves the alternate screen when Ink unmount throws', () => {
    const stub = stubInstance()
    stub.unmount.mockImplementation(() => {
      throw new Error('yoga node already freed')
    })
    boundary.render = () => stub.instance
    startSession('inline', APP)

    runShutdown()

    expect(stdoutText()).toBe(RESET)
    expect(setRawMode.mock.calls).toEqual([[false]])
  })

  it('emits nothing when render throws before anything rendered', () => {
    boundary.render = () => {
      throw new Error('kitty keyboard probe failed')
    }

    expect(() => startSession('inline', APP)).toThrow('kitty keyboard probe failed')
    runShutdown()

    expect(stdoutText()).toBe('')
  })
})

describe('the fatal restore when stdout is not a terminal', () => {
  it('never leaves the alternate screen in fullscreen mode when Ink unmount throws', () => {
    terminal({ stdoutTTY: false, stdinTTY: false })
    const stub = stubInstance()
    stub.unmount.mockImplementation(() => {
      throw new Error('yoga node already freed')
    })
    boundary.render = () => stub.instance
    startSession('fullscreen', APP)

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
    const session = startSession('inline', APP)
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
  function sessionWith(mode: Mode, onUnmount: () => void = () => {}) {
    const stub = stubInstance(onUnmount)
    boundary.render = () => stub.instance
    return startSession(mode, APP)
  }

  it('hands out each captured line once', () => {
    const session = sessionWith('inline')
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
    const session = sessionWith('fullscreen', inkLeavesAlternateScreen)
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
    const session = sessionWith('inline')
    // biome-ignore lint/suspicious/noConsole: the dependency output being captured
    console.log('dropped line')
    await session.quit()
    boundary.log = []

    runShutdown()

    expect(boundary.log).toEqual([])
  })
})
