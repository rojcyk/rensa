import { parseArgs, USAGE } from './args.js'
import { runCapture } from './capture.js'
import { doctor } from './doctor.js'
import { guardOutput, writeLines } from './format.js'
import { runHeadless } from './headless.js'

declare const __RENSA_VERSION__: string

/** sysexits EX_USAGE. */
const EXIT_USAGE = 64
const EXIT_NO_TUI = 2

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv)
  if (!parsed.ok) {
    writeLines(process.stderr, [`rensa: ${parsed.message}`, USAGE])
    return EXIT_USAGE
  }
  const { command } = parsed
  switch (command.kind) {
    case 'version':
      writeLines(process.stdout, [__RENSA_VERSION__])
      return 0
    case 'help':
      writeLines(process.stdout, [USAGE])
      return 0
    case 'tui':
      // Step 11 wires the TUI.
      writeLines(process.stderr, ['TUI not implemented'])
      return EXIT_NO_TUI
    case 'doctor':
      return doctor(process.cwd(), process.env)
    case 'run':
      return runHeadless(command, process.cwd(), process.env)
    case 'capture':
      if (process.env.RENSA_DEV !== '1') {
        writeLines(process.stderr, ['rensa: capture is a development command; set RENSA_DEV=1'])
        return EXIT_USAGE
      }
      return runCapture(command, process.cwd(), process.env)
  }
}

// A rejection reaches the engine's uncaughtException handler, which runs
// the shutdown callbacks and exits 1. The exit code is set rather than
// forced so buffered stdout drains to a pipe before the process ends.
guardOutput()
void main(process.argv.slice(2)).then((code) => {
  process.exitCode = code
})
