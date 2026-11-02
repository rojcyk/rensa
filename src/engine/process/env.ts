export const STRIPPED_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY'] as const

/**
 * The environment for a child process: a copy of `base` without the
 * vendor API keys (unless `allowApiKeys`), with color and terminal
 * features off so no ANSI reaches the transcripts, then `extra` on top.
 */
export function childEnv(
  base: NodeJS.ProcessEnv,
  opts: { allowApiKeys: boolean; extra?: Record<string, string> },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  if (!opts.allowApiKeys) {
    for (const key of STRIPPED_KEYS) delete env[key]
  }
  env.NO_COLOR = '1'
  env.TERM = 'dumb'
  return { ...env, ...opts.extra }
}
