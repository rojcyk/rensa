import { writeSync } from 'node:fs'

// The one place that listens for process death. Callbacks run once, last
// registered first, synchronously: by the time 'exit' fires the event loop
// is gone, so nothing in here may wait on a promise or a timer.

interface Entry {
  fn: () => void
}

const callbacks: Entry[] = []
let shutDown = false
let interrupt: Entry | undefined

/** Registers a synchronous cleanup callback; returns its unregister function. */
export function onShutdown(fn: () => void): () => void {
  const entry: Entry = { fn }
  callbacks.push(entry)
  return () => {
    const i = callbacks.indexOf(entry)
    if (i !== -1) callbacks.splice(i, 1)
  }
}

/** Runs every registered callback once, LIFO. Later calls do nothing. */
export function runShutdown(): void {
  if (shutDown) return
  shutDown = true
  for (const entry of callbacks.splice(0).reverse()) {
    try {
      entry.fn()
    } catch (err) {
      writeStderr(`rensa: shutdown callback failed: ${describe(err)}\n`)
    }
  }
}

/**
 * Replaces the default SIGINT behaviour (run the callbacks, exit 130).
 * Holds one handler; a later registration replaces an earlier one. The
 * returned function restores the default only while its own handler is
 * still the current one.
 */
export function onInterrupt(fn: () => void): () => void {
  const entry: Entry = { fn }
  interrupt = entry
  return () => {
    if (interrupt === entry) interrupt = undefined
  }
}

/** Tests only: clears the callbacks, the once-only guard and the interrupt handler. */
export function resetShutdownForTests(): void {
  callbacks.length = 0
  shutDown = false
  interrupt = undefined
}

export function handleInterrupt(): void {
  if (interrupt) {
    interrupt.fn()
    return
  }
  runShutdown()
  process.exit(130)
}

export function handleTerminate(): void {
  runShutdown()
  process.exit(143)
}

export function handleHangup(): void {
  runShutdown()
  process.exit(129)
}

function handleUncaught(err: unknown): void {
  // Restore the terminal first so the stack is readable.
  runShutdown()
  writeStderr(`${describe(err)}\n`)
  process.exit(1)
}

function describe(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err)
}

// Synchronous, so the text is out before the process exits even when
// stderr is a pipe.
function writeStderr(text: string): void {
  try {
    writeSync(2, text)
  } catch {
    // Nowhere left to report to.
  }
}

// Installed once at module load and never removed. Every signal path ends
// in process.exit(), never in death by the signal, which would skip
// 'exit'. Ink's signal-exit stands down while these are present, and its
// unmount then runs from 'exit' after the callbacks above.
process.on('exit', runShutdown)
process.on('SIGTERM', handleTerminate)
process.on('SIGHUP', handleHangup)
process.on('SIGINT', handleInterrupt)
process.on('uncaughtException', handleUncaught)
