import { stripVTControlCharacters } from 'node:util'
import { Box, Text } from 'ink'
import { render } from 'ink-testing-library'
import type { ReactElement } from 'react'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { Step } from '../../engine/index.js'
import { agentStep, shellStep } from '../../testing/steps.js'
import { Timeline } from './Timeline.js'

// The marker, id and detail colors are part of the spec; force truecolor
// before Ink (and its chalk) load.
const previousForceColor = vi.hoisted(() => {
  const previous = process.env.FORCE_COLOR
  process.env.FORCE_COLOR = '3'
  return previous
})

afterAll(() => {
  if (previousForceColor === undefined) delete process.env.FORCE_COLOR
  else process.env.FORCE_COLOR = previousForceColor
})

const fg = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`
const TEXT = fg(230, 230, 230) // theme.text #e6e6e6
const MUTED = fg(154, 154, 154) // theme.muted #9a9a9a
const DIM = fg(92, 92, 92) // theme.dim #5c5c5c
const ACCENT = fg(217, 184, 106) // theme.accent #d9b86a

let unmount: (() => void) | undefined

afterEach(() => {
  unmount?.()
  unmount = undefined
})

function draw(node: ReactElement): { frame: string; lines: string[] } {
  const view = render(node)
  unmount = view.unmount
  const frame = view.lastFrame() ?? ''
  return {
    frame,
    lines: stripVTControlCharacters(frame)
      .split('\n')
      .map((l) => l.trimEnd()),
  }
}

/** The steps of the plan's mock. */
const TDD_REVIEW_STEPS: Step[] = [
  shellStep('baseline', 'npm test'),
  agentStep('write-tests', {
    label: 'tester',
    provider: 'claude',
    model: 'opus',
    effort: 'high',
    tools: 'write',
  }),
  agentStep('implement', {
    label: 'impl',
    provider: 'claude',
    model: 'opus',
    effort: 'high',
    tools: 'write',
  }),
  shellStep('test', 'npm test'),
  agentStep('review-codex', { label: 'codex', provider: 'codex', effort: 'medium' }),
  shellStep('retest', 'npm test'),
]

/** A shell step and an agent whose label is longer than every id. */
const LONG_LABEL_STEPS: Step[] = [
  shellStep('test', 'npm test'),
  agentStep('review', { label: 'reviewer', provider: 'claude' }),
]

describe('the static timeline of a chain before a run', () => {
  it('puts shell commands beside the id and agent rows beneath with the id column at longest id + 2 when the plan mock chain renders', () => {
    const { lines } = draw(<Timeline steps={TDD_REVIEW_STEPS} mode="static" />)

    expect(lines).toEqual([
      '  ○ baseline      npm test',
      '  ○ write-tests',
      '    tester        claude · opus · high',
      '  ○ implement',
      '    impl          claude · opus · high',
      '  ○ test          npm test',
      '  ○ review-codex',
      '    codex         codex · default · medium',
      '  ○ retest        npm test',
    ])
  })

  it('prints default for an unset model and omits an unset effort when an agent sets neither', () => {
    const { lines } = draw(<Timeline steps={LONG_LABEL_STEPS} mode="static" />)

    expect(lines[2]).toBe('    reviewer  claude · default')
  })

  it('keeps a two-space gap after a label longer than every id when the shell row shares the column', () => {
    const { lines } = draw(<Timeline steps={LONG_LABEL_STEPS} mode="static" />)

    expect(lines).toEqual([
      '  ○ test      npm test',
      '  ○ review',
      '    reviewer  claude · default',
    ])
  })

  it('draws the marker in dim, the id in text, and the command, label and configuration in muted', () => {
    const { frame } = draw(<Timeline steps={LONG_LABEL_STEPS} mode="static" />)

    expect(frame).toContain(`${DIM}○`)
    expect(frame).toContain(`${TEXT}test`)
    expect(frame).toContain(`${TEXT}review`)
    expect(frame).toContain(`${MUTED}npm test`)
    expect(frame).toContain(`${MUTED}reviewer`)
    expect(frame).toContain(`${MUTED}claude · default`)
  })

  it('folds a multi-line shell command onto its one row when the command spans lines', () => {
    const steps: Step[] = [shellStep('lint', 'npm run lint\n  && npm run typecheck')]

    const { lines } = draw(<Timeline steps={steps} mode="static" />)

    expect(lines).toEqual(['  ○ lint  npm run lint && npm run typecheck'])
  })

  it('truncates the detail with … and keeps every row one line when the width is too small for it', () => {
    const steps: Step[] = [
      shellStep('baseline', 'npm test -- --run src/engine/engine.preflight.test.ts'),
    ]

    const { lines } = draw(
      <Box width={30} flexDirection="column">
        <Timeline steps={steps} mode="static" />
      </Box>,
    )

    expect(lines).toEqual(['  ○ baseline  npm test -- --r…'])
  })
})

describe('the live timeline of the run screen', () => {
  it('shows one row per step with no command or agent row when mode is live', () => {
    const { lines } = draw(<Timeline steps={LONG_LABEL_STEPS} mode="live" />)

    expect(lines).toEqual(['  ○ test', '  ○ review'])
  })

  it('keeps the id column at the longest id + 2 even when an agent label is longer', () => {
    // A cell drawn right after the timeline sits at its width: indent 2,
    // marker 2, then `review` (6) + 2.
    const { lines } = draw(
      <Box>
        <Timeline steps={LONG_LABEL_STEPS} mode="live" />
        <Text>|</Text>
      </Box>,
    )

    expect(lines[0]?.indexOf('|')).toBe(2 + 2 + 'review'.length + 2)
  })

  it('draws the selected step id in accent and the others in text when selected is set', () => {
    const { frame } = draw(<Timeline steps={LONG_LABEL_STEPS} mode="live" selected="review" />)

    expect(frame).toContain(`${ACCENT}review`)
    expect(frame).toContain(`${TEXT}test`)
    expect(frame).not.toContain(`${ACCENT}test`)
  })
})
