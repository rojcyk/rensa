# 16 Codex adapter

## Goal

Codex CLI as a provider. Dogfooding milestone 4: all three vendors in
one chain.

## Context

Steps 01–15 merged. Contract: `plan/07-adapter-interface-and-fake.md`.
Pattern: `plan/10-claude-adapter.md`; mirror its file layout under
`src/engine/adapters/codex/`. Verify every flag against `codex exec
--help` and `codex --help` on the installed version; Codex changes
flags between releases.

## Capabilities

`{ resume: true, model: true, effort: ['low','medium','high','max'], tools: ['read','write'] }`.
Effort table: `max` → `xhigh` (already in step 03). Note: on a ChatGPT
login the CLI may ignore `--model` and use the account default; if the
installed version does so, keep `model: true` but document that the
value is advisory, and have `available()` attach `note: 'model
selection ignored on ChatGPT login'` for the doctor output.

## Availability

1. `findOnPath('codex')`; missing → `not_installed`.
2. `codex --version` → version.
3. `codex login status`: exit 0 → `ready`; exit 1 or stdout containing
   `Not logged in` → `{ status: 'not_logged_in', hint: 'run: codex login' }`.

## argv

Always: `codex exec --json --cd <cwd> --skip-git-repo-check`
(include `--skip-git-repo-check` only if the installed version requires
it when the cwd is a repo subdirectory; otherwise omit).

| request | argv |
|---|---|
| first use | `codex exec ...`; the session id is read from the stream (see parser) and recorded by the engine from `done.sessionId` — extend `done` with an optional `sessionId` field in step 07's types, and have the engine prefer it over its own UUID when present |
| resume | `codex exec resume <session id> ...` |
| persona (first use only) | `-c instructions="<text>"` if the installed version supports config overrides for instructions; else prepend the persona to the message under a `# Role` heading |
| model | `-m <model>` |
| effort | `-c model_reasoning_effort=<mapped>` |
| tools read | `--sandbox read-only` |
| tools write | `--sandbox workspace-write --full-auto` |
| skills | nothing: inlined by the engine (step 08). Codex's own discovery reads `.agents/skills/` from the cwd up to the repo root, `~/.agents/skills/` and `/etc/codex/skills/`; there is no per-process flag, and `CODEX_HOME` moves auth and sessions along with skills, so it is not used |

The message is the trailing positional argument of `codex exec`, or
`-` with the message on stdin if the installed version supports it
(prefer stdin to avoid ARG_MAX).

## Parser

Capture first, then write `parse.ts`. Codex `--json` emits JSONL
events such as `thread.started` (carries the session/thread id),
`item.started` / `item.completed` with `item.type` of
`agent_message`, `command_execution`, `file_change`, `reasoning`, and
`turn.completed` with token usage. Map: completed `agent_message` → a `text`
record (preceded by `delta` events if the stream offers `item.delta`
or similar; step 07's union, no `partial` flag);
`command_execution` and `file_change` completed → `tool` with `name`
`Bash` or `Edit`, `input` from the item, `ok` from its status, `output`
from its captured output; `turn.completed` → `usage`; end of stream →
`done` with the last `agent_message` as reply. Error classification
from observed usage-limit and auth messages.

Minimum fixtures: `codex/read-only-hello`, `codex/tool-calls`.

## Tests

As in steps 10 and 15.

## Dogfooding

Add a `codex` reviewer to this repository's `.rensa/project.yaml` and a
`review-codex` step to `review.yaml`. Run the full chain through the
TUI.

## Verification (human)

One run, three providers, three transcript panes readable, three
`agent.finished` events with usage. That is the MVP feature-complete
state.

## Out of scope

Packaging.
