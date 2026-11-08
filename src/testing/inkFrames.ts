import { EventEmitter } from 'node:events'
import { type Instance, render } from 'ink'
import type { ReactNode } from 'react'

// Renders an Ink tree into an in-memory terminal whose size a test can
// change. `ink-testing-library` fixes the width at 100 and has no rows,
// so the size and layout tests use this instead; it renders the same way
// (Ink's debug mode: every frame written whole, unthrottled).

class FakeStdout extends EventEmitter {
  readonly frames: string[] = []
  constructor(
    public columns: number,
    public rows: number,
  ) {
    super()
  }
  write = (frame: string): boolean => {
    this.frames.push(frame)
    return true
  }
}

class FakeStderr extends EventEmitter {
  readonly frames: string[] = []
  write = (frame: string): boolean => {
    this.frames.push(frame)
    return true
  }
}

/** A TTY-like stdin, so hooks that need raw mode (useInput, usePaste) are active. */
export class FakeStdin extends EventEmitter {
  isTTY = true
  private data: string | null = null
  write(data: string): void {
    this.data = data
    this.emit('readable')
    this.emit('data', data)
  }
  read = (): string | null => {
    const { data } = this
    this.data = null
    return data
  }
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
}

export interface Frames {
  /** Every frame written, oldest first. */
  frames: string[]
  lastFrame(): string
  /** Changes the terminal size and emits `resize`, as a terminal does. */
  resize(columns: number, rows: number): void
  rerender(node: ReactNode): void
  unmount(): void
  stdin: FakeStdin
  stderrFrames: string[]
}

export function renderFrames(node: ReactNode, size: { columns: number; rows: number }): Frames {
  const stdout = new FakeStdout(size.columns, size.rows)
  const stderr = new FakeStderr()
  const stdin = new FakeStdin()
  const instance: Instance = render(node, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  return {
    frames: stdout.frames,
    lastFrame: () => stdout.frames.at(-1) ?? '',
    resize(columns, rows) {
      stdout.columns = columns
      stdout.rows = rows
      stdout.emit('resize')
    },
    rerender: (next) => instance.rerender(next),
    unmount: () => instance.unmount(),
    stdin,
    stderrFrames: stderr.frames,
  }
}
