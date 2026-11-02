import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  handleHangup,
  handleInterrupt,
  handleTerminate,
  onInterrupt,
  onShutdown,
  resetShutdownForTests,
  runShutdown,
} from './shutdown.js'

// shutdown.ts reports through a synchronous write to fd 2; capture it so a
// reported failure can be asserted and stays out of the test output.
const stderrWrites = vi.hoisted((): string[] => [])
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return {
    ...fs,
    writeSync: (fd: number, text: string): number => {
      if (fd !== 2) throw new Error(`unexpected writeSync to fd ${fd}`)
      stderrWrites.push(text)
      return text.length
    },
  }
})

let events: string[]

/** Replaces process.exit so a handler's exit is recorded, not performed. */
function recordExit(): void {
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    events.push(`exit ${code}`)
    return undefined as never
  })
}

beforeEach(() => {
  resetShutdownForTests()
  events = []
  stderrWrites.length = 0
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('running the shutdown callbacks', () => {
  it('runs callbacks last-registered first when three are registered', () => {
    onShutdown(() => events.push('release lock'))
    onShutdown(() => events.push('kill children'))
    onShutdown(() => events.push('restore terminal'))

    runShutdown()

    expect(events).toEqual(['restore terminal', 'kill children', 'release lock'])
  })

  it('runs nothing when runShutdown is called a second time', () => {
    onShutdown(() => events.push('release lock'))
    runShutdown()

    runShutdown()

    expect(events).toEqual(['release lock'])
  })

  it('skips a callback when it was unregistered before shutdown', () => {
    onShutdown(() => events.push('release lock'))
    const unregister = onShutdown(() => events.push('kill children'))
    onShutdown(() => events.push('restore terminal'))

    unregister()
    runShutdown()

    expect(events).toEqual(['restore terminal', 'release lock'])
  })

  it('runs the remaining callbacks and reports to stderr when one throws', () => {
    onShutdown(() => events.push('release lock'))
    onShutdown(() => {
      throw new Error('EPERM: cannot signal process group 48213')
    })
    onShutdown(() => events.push('restore terminal'))

    runShutdown()

    expect(events).toEqual(['restore terminal', 'release lock'])
    expect(stderrWrites).toEqual([
      expect.stringContaining('EPERM: cannot signal process group 48213'),
    ])
  })
})

describe('process death listeners', () => {
  it('installs the shutdown listeners on exit, SIGTERM, SIGHUP and SIGINT at module load', () => {
    expect([
      process.listeners('exit').includes(runShutdown),
      process.listeners('SIGTERM').includes(handleTerminate),
      process.listeners('SIGHUP').includes(handleHangup),
      process.listeners('SIGINT').includes(handleInterrupt),
    ]).toEqual([true, true, true, true])
  })
})

describe('signal handlers', () => {
  it('runs the callbacks then exits 130 when SIGINT arrives with no interrupt handler', () => {
    recordExit()
    onShutdown(() => events.push('restore terminal'))

    handleInterrupt()

    expect(events).toEqual(['restore terminal', 'exit 130'])
  })

  it('runs the interrupt handler instead of the callbacks when one is registered', () => {
    recordExit()
    onShutdown(() => events.push('restore terminal'))
    onInterrupt(() => events.push('abort run'))

    handleInterrupt()

    expect(events).toEqual(['abort run'])
  })

  it('restores the default SIGINT behaviour when the interrupt handler is unregistered', () => {
    recordExit()
    onShutdown(() => events.push('restore terminal'))
    const unregister = onInterrupt(() => events.push('abort run'))

    unregister()
    handleInterrupt()

    expect(events).toEqual(['restore terminal', 'exit 130'])
  })

  it('keeps the newer interrupt handler when an older, replaced one is unregistered', () => {
    recordExit()
    const unregisterFirst = onInterrupt(() => events.push('first press aborts'))
    onInterrupt(() => events.push('second press exits'))

    unregisterFirst()
    handleInterrupt()

    expect(events).toEqual(['second press exits'])
  })

  it('runs the callbacks then exits 143 when SIGTERM arrives', () => {
    recordExit()
    onShutdown(() => events.push('restore terminal'))

    handleTerminate()

    expect(events).toEqual(['restore terminal', 'exit 143'])
  })

  it('runs the callbacks then exits 129 when SIGHUP arrives', () => {
    recordExit()
    onShutdown(() => events.push('restore terminal'))

    handleHangup()

    expect(events).toEqual(['restore terminal', 'exit 129'])
  })
})
