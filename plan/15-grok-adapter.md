# 15 Grok adapter

## Goal

Grok Build as a provider. Dogfooding milestone 3: a review step runs on
the user's SuperGrok subscription.

## Context

Steps 01–14 merged. Contract: `plan/07-adapter-interface-and-fake.md`.
Pattern: `plan/10-claude-adapter.md`; mirror its file layout under
`src/engine/adapters/grok/`.

Flags below come from the Grok Build docs as of 2026-10-28. The
streaming JSON event shapes are not documented anywhere, so this step
is explicitly fixture-first: capture real output before writing the
parser.

## Capabilities

`{ resume: true, model: true, effort: [...], tools: ['read','write'] }`.
Effort levels: run `grok --help` and read the accepted values for
`--effort`; update `EFFORT.grok` in step 03's table to match, mapping
rensa's four levels onto them (nearest lower level when there are more
than four; `null` for levels the CLI lacks).

## Availability

1. `findOnPath('grok')`; missing → `not_installed`.
2. `grok version` (or `grok --version`; use whichever the installed
   build supports) → version.
3. `~/.grok/auth.json` exists → `ready`; else
   `{ status: 'not_logged_in', hint: 'run: grok login' }`. The file
   check cannot see expiry; an expired token surfaces at run time as
   `auth`.

## argv

Always: `grok -p <message> --output-format streaming-json --no-auto-update --cwd <cwd>`.
If `-p` with a large message hits ARG_MAX, check whether the installed
build reads the prompt from stdin; if not, write the message to
`<stagingDir>/message.md` and send a short `-p` that says the task is
in that file (read-only agents can read it). Record which path was
taken in `meta.json` of the fixtures.

| request | argv |
|---|---|
| first use | `-s <session id>` (must be a UUID; the engine's ids are) |
| resume | `-r <session id>` |
| persona (first use only) | `--rules "<persona text>"`; if the text is long, test `--rules` with a file argument or fall back to prepending the persona to the message under a `# Role` heading |
| model | `-m <model>` |
| effort | `--effort <mapped>` |
| tools read | `--tools <read-only tool list>` plus `--deny` rules for anything that writes; discover the built-in tool names with `grok inspect --json` or `grok --help` and pin them in `argv.ts` with a comment naming the CLI version |
| tools write | `--always-approve` |

## Skills

Nothing to do here: a chain's `skills:` are inlined into the message
by the engine (step 08). For the record, checked against Grok 1.0.70
and its bundled guide: `grok -p` has `--add-dir` but no per-process
skills or plugin flag, discovery reads only the checkout
(`.grok/skills/`, `.claude/skills/`, `.agents/`), the user's home and
`[skills] paths` in `~/.grok/config.toml`, the `GROK_CONFIG` overlay
cannot add a discovery source, and project skills load only in a
trusted folder. `grok agent --plugin-dir` is per process but is the
ACP protocol, not this adapter's `-p` mode. Never write under `~/.grok`
or into the checkout for skills. The user's own project skills are
still found by Grok's discovery when the folder is trusted.

## Parser

Capture first (`rensa capture grok read-only-hello "..."` from step
10's dev command), then write `parse.ts` against the captured lines.
Map whatever the stream offers onto step 07's union: `delta` for
streamed text if the CLI streams, then a `text` record per finished
block; `tool` (name, input, ok, output), `usage`, and `done`. Treat unknown event
types as `raw` only. Error classification: usage-limit and
authentication messages as observed in real output; add them to the
fixture `meta.json` note.

Minimum fixtures: `grok/read-only-hello`, `grok/tool-calls`.

## Tests

As in step 10: argv table, parser against both fixtures, error
classification, availability with a stubbed home directory.

## Dogfooding

Add a `grok` read-only reviewer to this repository's
`.rensa/project.yaml` and a `review-grok` step to `review.yaml`. Run it
through the TUI.

## Verification (human)

Compare the Grok transcript pane with Claude's on the same diff. If the
pane shows raw JSON or nothing, the parser missed an event type; open
`raw.jsonl` and extend the fixture.

## Out of scope

Codex.
