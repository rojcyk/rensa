# rensa

A terminal tool that runs chains of agent steps across vendor CLIs you
already pay for: Claude Code, Codex, Grok Build. Each step can use a
different vendor. No API keys. Every agent runs as a headless subprocess
of its own CLI on your subscription login.

A chain is a YAML file in `<repo>/.rensa/`: a straight line of steps,
each either one agent with a prompt or a shell command. Every run is
recorded under `.rensa/runs/<run-id>/`, which rensa keeps out of git.

## Install

```sh
npm install -g @rojcyk/rensa
```

## Requirements

- Node 22 or later.
- At least one of the three CLIs installed and logged in: `claude`
  (Claude Code), `codex` (Codex), `grok` (Grok Build). Each must be on
  your `PATH`. `rensa doctor` shows which ones rensa found and whether
  each is logged in.
- A git repository with at least one commit. rensa runs in the current
  checkout and keeps its files in `.rensa/` at the repository root.

By default `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `XAI_API_KEY` are
removed from every agent's environment, so each CLI uses its
subscription login; `allow_api_keys: true` in a `project.yaml` turns
this off (see [`docs/project.yaml`](docs/project.yaml)).

## 60-second start

In a git repository (a fresh one needs a first commit,
`git commit --allow-empty -m init`):

```sh
mkdir -p .rensa/agents .rensa/steps
```

Create the three files below, then:

```sh
rensa doctor       # is Claude Code found and logged in?
rensa              # open the TUI
```

In the TUI, select `review` with the arrow keys, press `enter` to open
it, and `enter` again to start the run. `rensa review` opens straight on
the chain, and `rensa run review` runs it with no UI.

`.rensa/review.yaml`:

```yaml
name: review
description: Review the current diff.
agents:
  reviewer: { provider: claude, tools: read, prompt: agents/reviewer.md }
steps:
  - id: review
    prompt: steps/review.md
    agents: [reviewer]
    vars:
      diff: $(git diff {{base}})
```

`.rensa/agents/reviewer.md`, the agent's persona:

```markdown
You are a careful code reviewer for this repository. You read code; you
never change it. Report concrete defects with file and line, most severe
first, and say plainly when you find none. Do not pad the review with
style preferences the linter already enforces.
```

`.rensa/steps/review.md`, the message the step sends:

````markdown
Review this change against `{{base}}`.

Diff:

```diff
{{diff}}
```

Read whatever files you need for context. List the defects you find,
each with its location and why it is wrong. End with one line: the
change is ready to commit, or it is not and why.
````

`{{base}}` is the git ref the run diffs against; with no `base:` set
anywhere it is the ref checked out when the run starts. `$(…)` runs a
shell command in the repository root and captures its output.

## Reference

- [`docs/chain.yaml`](docs/chain.yaml): every key a chain file accepts.
- [`docs/project.yaml`](docs/project.yaml): shared agents and defaults
  for every chain in a repository, or on your machine.

```text
rensa [<chain>]                           open the TUI, on the chain if given
      [--fullscreen | --inline]           use the alternate screen, or not
rensa run <chain> [input text]            run a chain with no UI
      [--input-file <path>]               read the input from a file
      [--base <ref>]                      override the chain's base ref
      [--no-pause]                        run declared pauses as if absent
      [--quiet | --json]                  only run/step/agent lines, or JSONL
rensa doctor                              show provider availability
rensa --version | --help
```

## Run screen keys

| key | action |
|---|---|
| `←` / `→` | select the previous / next step; stops following the running step |
| `ctrl+f` | follow the running step again |
| `↑` / `↓` | move the cursor between the tool calls in view |
| `enter` | continue a paused run; otherwise expand or collapse the tool call under the cursor |
| `shift+↑` / `shift+↓`, `page up` / `page down` | scroll the transcript half a screen |
| `shift+←` / `shift+→` | jump to the top / bottom of the transcript |
| any character | start a note for the next steps; `enter` sends it, `esc` leaves the box and keeps the text |
| `ctrl+p` | pause after the current step |
| `ctrl+x` | kill the running step (asks `y`/`n`) |
| `esc` | back to the chain list; the run keeps going |
| `ctrl+c` | abort the run and quit (asks `y`/`n`) |

## Skills

An agent's `skills:` are inlined into its first prompt as text, so they
count against context on every turn. Each CLI additionally finds the
skills it would find on its own in this checkout: `.claude/skills/` for
Claude and Grok, `.agents/skills/` for Codex and Grok. Grok loads them
only in a folder it has been told to trust.

## Not yet

- Parallel agents within a step.
- Conditionals and loops.
- Worktrees: runs execute in the current checkout.
- Windows.

## Limits

- `SIGKILL` of rensa itself leaves the terminal as it was: it can stay
  in raw mode or on the alternate screen (`reset` restores it).
- A child that moves itself out of its process group with `setsid` is
  not stopped by kill, abort or exit.

## License

[MIT](LICENSE)
