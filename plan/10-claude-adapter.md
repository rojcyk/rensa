# 10 Claude adapter

## Goal

Claude Code as a real provider. After this step, `rensa run` executes a
chain on the user's Claude subscription, and the first fixtures are
captured from real output. This is dogfooding milestone 1.

## Context

Steps 01–09 merged. Contract: `plan/07-adapter-interface-and-fake.md`.
Flags below were verified against the Claude Code docs on 2026-10-28;
re-verify with `claude --help` on the installed version before
implementing, and record the version in the fixture `meta.json`.

## Files to create

```
src/engine/adapters/claude/index.ts     Adapter implementation
src/engine/adapters/claude/argv.ts      request → argv, pure
src/engine/adapters/claude/parse.ts     stream-json lines → AgentEvent, pure
src/engine/adapters/claude/auth.ts      availability
src/engine/adapters/claude/*.test.ts    argv, parse, auth: one per module, next to it
test/fixtures/claude/<name>/            captured, see "Fixture capture"
```

## Capabilities

`{ resume: true, model: true, effort: ['low','medium','high','max'], tools: ['read','write'] }`.
Effort table (step 03): `max` maps to `max`.

## Availability (auth.ts)

1. `findOnPath('claude')`; missing → `not_installed`.
2. `claude --version` → version string (first line, trimmed).
3. `claude auth status`; parse stdout as JSON if it parses and read a
   boolean `loggedIn`; otherwise treat exit code 0 as logged in. If not
   logged in → `{ status: 'not_logged_in', hint: 'run: claude auth login' }`.
   Any failure to run the command → treat as logged in and let the run
   surface an `auth` error; report the reason with
   `diag('claude.auth', …)` (step 07), never to stderr: the frontend
   decides whether and when it is shown.

Verify the exact `auth status` output on the installed version and
adjust the parser; add the observed output to a unit test.

## argv (argv.ts)

```ts
export function buildArgv(req: SpawnRequest, staged: { personaFile?: string }): string[]
```

Always:

```
claude -p --output-format stream-json --verbose --include-partial-messages
       --input-format stream-json
```

Never pass `--no-session-persistence` or `--bare`: sessions must
persist for resume, and the user's own CLAUDE.md and project skills
(`.claude/skills/` in the checkout) are part of the agent; `--bare`
would also stop Claude from being told which skills exist. A chain's
`skills:` arrive inlined in the message (step 08); this adapter does
nothing for them.

Then:

| request | argv |
|---|---|
| first use | `--session-id <req.session.id>` |
| resume | `--resume <req.session.id>` |
| persona (first use only) | `--append-system-prompt-file <personaFile>` |
| model | `--model <model>` |
| effort | `--effort <mapped>` |
| tools read | `--tools "Read,Glob,Grep" --allowedTools "Read,Glob,Grep" --permission-mode dontAsk --permission-prompts none` |
| tools write | `--permission-mode acceptEdits --allowedTools "Read,Edit,Write,Glob,Grep,Bash" --permission-prompts none` |

The message is not in argv. It is written to stdin as one line:

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"<req.message>"}]}}
```

then stdin is closed. If the installed version rejects this (no
positional prompt), fall back to passing `req.message` as the positional
argument after `-p` and note the limit (ARG_MAX) in `index.ts`. Decide
by trying both on the installed version and keep the one that works;
leave the other as a documented alternative in a comment.

## Persona staging

Write `req.persona` to `<stagingDir>/persona.md` and pass that path.
Nothing else is written outside `stagingDir`.

## Parsing (parse.ts)

Input: raw stdout lines. Each line is a JSON object with `type`. Emit
`raw` first for every line, then:

| line | AgentEvent |
|---|---|
| `type: system, subtype: init` | nothing (record `session_id`, `model` for `done`) |
| `type: stream_event` with `event.delta.type == 'text_delta'` | `delta { text: delta.text }` |
| `type: assistant`, content block `text` | `text { text }` (the full block; supersedes its deltas) |
| `type: assistant`, content block `tool_use` | remember `{id, name, input}` until its result |
| `type: user`, content block `tool_result` | `tool { name, input, ok: !is_error, output: <content as text, 4 KB cap> }` |
| `type: result` | `done` (below) |
| anything else | ignore |

The parser's `done` is provisional (step 07): `reply = result.result ?? ''`;
`exitCode: null` (the stream does not carry it; `spawn` fills it in);
`usage` from `result.usage` → `{ input: input_tokens, output: output_tokens, cache_read: cache_read_input_tokens, context: <input tokens of the last assistant message usage if present> }`;
`sessionId` is not set (Claude uses the id rensa passes);
`error` when `result.subtype !== 'success'`, from stdout only:

- reply matching `/usage limit|hit your .* limit|resets/i` → `usage_limit`
- reply matching `/not logged in|auth|login/i` → `auth`
- no `result` event at all → `no_output`
- else `exit`

`message` is the reply text.

Non-JSON lines (warnings, progress) are emitted as `raw` only.

## spawn (index.ts)

Wires `spawnProcess` (step 06) with `argv`, `cwd`, `env`, stdin
message, timeout; pipes stdout lines into `parse`; stderr lines are
emitted as `raw` prefixed with `stderr: ` and kept for error
classification. `kill()` delegates. Holds the parser's `done` and emits
the one final `done` by step 07's reconciliation rules: `exitCode` from
the process; for errors, a stderr line matching
`/not logged in|auth|login/i` turns a parser `no_output` or `exit`, or
an unexplained non-zero exit, into `auth` with that line as `message`
(so empty stdout plus "not logged in" on stderr is `auth`, not
`no_output`); otherwise a non-zero exit without a parser error is
`exit` with the last stderr line as `message`.

## Fixture capture

Add a dev command `rensa capture <provider> <name> "<prompt>"` (dev
only, `RENSA_DEV=1`) that runs the adapter in the current directory
with `tools: read`, writes `raw.jsonl`, the parsed `transcript.jsonl`,
`reply.md`, `done.json` (the parser's `done` minus `kind` and `reply`,
not the final reconciled one; step 07), and `meta.json` into
`test/fixtures/<provider>/<name>/`. Capture at least:

- `claude/read-only-hello`: "List the files in this directory and say hello."
- `claude/tool-calls`: a prompt that makes it read two files.

Review the captured files by hand, redact nothing automatically, commit
them, and wire them through `fixtureTest` so `parse` is pinned to real
output.

## Dogfooding chain

Add to this repository's `.rensa/`: `project.yaml` with an `opus`
read-only reviewer, `hello.yaml` (`input: text`, one agent step that
answers the input), and `review.yaml` (one shell step `npm test`, one
read-only step reviewing `git diff {{base}}`). Prompts under
`.rensa/agents/` and `.rensa/steps/`. These are the chains the TUI
steps use.

## Tests

- `buildArgv` for each row of the table; read-only argv never contains
  `Bash`.
- `parse` against both captured fixtures.
- Error classification from synthetic `result` lines.
- Persona staging writes `persona.md` and nothing else.

## Verification (human)

`rensa run hello "say hi in one line"` against this repo prints a
transcript and ends `complete`. Then `rensa run review` after making a
small change. Open the run directory; `raw.jsonl` should match what you
saw.

## Out of scope

Grok, Codex, the TUI.
