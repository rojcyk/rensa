declare const __RENSA_VERSION__: string

const USAGE = 'usage: rensa [--version] [--help]'

function main(argv: string[]): number {
  const [arg] = argv
  if (arg === '--version' || arg === '-v') {
    process.stdout.write(`${__RENSA_VERSION__}\n`)
    return 0
  }
  if (arg === '--help' || arg === '-h') {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  process.stderr.write('not implemented\n')
  return 1
}

process.exitCode = main(process.argv.slice(2))
