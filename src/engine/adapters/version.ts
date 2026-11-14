// Each CLI decorates its version differently (`2.1.325 (Claude Code)`,
// `codex-cli 0.166.0`, `grok 1.0.70 (f50904eaee6c) [stable]`), so only the
// dotted number is kept and every provider reads as `<name> <version>`.
const DOTTED_NUMBER = /\d+(?:\.\d+)+/

/**
 * The first dotted number on the first line of a `--version` output, or
 * that line trimmed when it has none; undefined when the line is empty.
 */
export function parseVersion(stdout: string): string | undefined {
  const first = stdout.split('\n', 1)[0]?.trim()
  if (first === undefined || first === '') return undefined
  return DOTTED_NUMBER.exec(first)?.[0] ?? first
}
