# rensa

A terminal tool that runs chains of agent steps across vendor CLIs the
user already pays for: Claude Code, Codex, Grok Build. Each step can use
a different vendor. No API keys. Every agent runs as a headless
subprocess of its own CLI on the user's subscription login.

## What it is

- **Chain**: a YAML file in `<repo>/.rensa/`, a straight line of steps.
  Each step is either one agent with a prompt, or a shell command.
- **Run**: one execution of a chain with one input, recorded under
  `.rensa/runs/<run-id>/` as an append-only `events.jsonl` of state
  transitions plus per-agent transcripts.
- **TUI**: an Ink app that lists chains, starts a run, and shows each
  step's transcript as it streams. It can be closed and reattached.
- **Headless CLI**: `rensa run <chain>` does the same with no UI.

File formats: `docs/chain.yaml`, `docs/project.yaml`.

## Architecture rule

Engine and UI are separate. The engine (chain loading, run execution,
provider adapters, process management, event and transcript writing) has
no Ink import and no knowledge of a terminal. It exposes an event stream
and a command set: start, pause, resume, kill, abort, note. The TUI and
the headless CLI are two consumers of that interface.

- Provider output is parsed in the engine's adapters into one normalized
  transcript format. The UI never parses provider output.
- Status, token counts, errors: computed in the engine, emitted as
  events, rendered by the UI.
- The run screen is a pure function of the events and transcripts on
  disk.
- Transcripts are not held in React state; the UI renders slices of
  engine-owned buffers on a throttle.

The TUI library may be swapped later. The engine must not notice.

## Stack

TypeScript, Node 22+, Ink. Published on npm as `@rojcyk/rensa`; the binary is `rensa`.

## Provider adapters

One per vendor behind one interface: `capabilities()`, `available()`,
`spawn()`. Adapters strip `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and
`XAI_API_KEY` from the child environment. Build order: claude, grok,
codex.

## MVP scope

- One agent per step, sequential.
- Runs execute in the current checkout.
- No conditionals, loops, or per-run parameters.
- `pause: before | after` is the only control flow.

Do not add speculative hooks for deferred features.
