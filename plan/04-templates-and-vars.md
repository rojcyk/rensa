# 04 Templates and variables

## Goal

Everything between "a step is about to run" and "here is the exact
message text": the run namespace, `vars` evaluation, placeholder
rendering, output-map rendering, output tails, and user notes. Pure
functions except for `$(...)` evaluation.

## Context

Steps 01–03 merged. `VarSpec` and `ResolvedChain` exist.

## Files to create

```
src/engine/template/namespace.ts
src/engine/template/vars.ts
src/engine/template/render.ts
src/engine/template/output.ts
src/engine/template/*.test.ts    one per module, next to it
```

## Namespace (namespace.ts)

```ts
interface StepResult {
  kind: 'shell' | 'agent'
  output: string | Record<string, unknown>   // shell: tail text; agent: map by label
  text?: string                               // agent: concatenated final replies
  passed?: boolean; exitCode?: number         // shell
}
interface Namespace {
  input?: string; input_path?: string; base: string; run_id: string
  steps: Record<string, StepResult>
}
export function lookup(ns: Namespace, path: string): unknown
```

`lookup('steps.test.output')` walks the dotted path. Missing anything
returns `undefined`; the caller decides whether that is an error.

## Vars evaluation (vars.ts)

```ts
export async function evaluateVars(
  vars: Record<string, VarSpec>, ns: Namespace, cwd: string,
): Promise<Record<string, unknown>>
```

- `literal`: the string. Placeholders inside literals are rendered with
  the namespace first (so `{{base}}` works inside a literal).
- `ref`: `lookup`; `undefined` → `RensaError('TEMPLATE')` naming the var
  and the path.
- `shell`: bind placeholders inside the command against the namespace
  (so `$(git diff {{base}})` works) with `renderForShell`: each value
  goes into an env var and the command expands it, quoted for the
  context it sits in, so input and agent output are data, never code.
  Then run with `/bin/sh -c` in
  `cwd`, stdin closed, 60 s timeout, env from step 06's `childEnv` once
  it exists (for now `process.env`). Stdout over 10 MiB kills the
  process group and fails like a timeout. Non-zero exit, timeout, or a
  kill by rensa (even if the shell itself exited 0) →
  `RensaError('TEMPLATE')` with the command and the first 500 chars of
  stderr. Value is stdout with one trailing newline stripped.

Evaluate sequentially in declaration order.

## Rendering (render.ts)

```ts
export function render(template: string, values: Record<string, unknown>, ns: Namespace): string
export function findPlaceholders(template: string): string[]
```

- Placeholder regex: `/\{\{\s*([a-z_][\w.-]*)\s*\}\}/gi`. Single braces
  are untouched.
- Resolution order: `values` (the evaluated vars), then the namespace via
  `lookup`. Unresolved → `RensaError('TEMPLATE')`. Step 03 already
  validated at load time; this is the runtime guard.
- Value to text:
  - string → as is
  - number, boolean → `String()`
  - a step output map (object whose values are strings or objects, from
    an agent step) → `renderOutputMap` (below)
  - any other object → pretty JSON, 2 spaces
  - `undefined` is impossible here

## Output map rendering (output.ts)

```ts
export function renderOutputMap(map: Record<string, unknown>): string
export function tail(text: string, maxBytes: number, fullPath: string): string
export function extractTrailingJson(text: string): Record<string, unknown> | undefined
```

`renderOutputMap`: for each entry in insertion order,

```
### <label>

<value>
```

where a string value is inserted verbatim and an object value as pretty
JSON. Entries separated by one blank line. Always use this form, even
for a single entry.

`tail`: if `text` is within `maxBytes` (UTF-8), return it. Otherwise
return the last `maxBytes` bytes, cut forward to the first line start
(staying put if the cut already is one), with a first line
`[… <n> bytes cut; full output: <fullPath>]`. If no whole line fits,
keep the end of the last line, starting on a whole UTF-8 character. Default
`maxBytes` 16384 at the call site in step 08.

`extractTrailingJson`: find the last top-level JSON object in `text`.
Strip a trailing fenced block marker if the text ends with ```` ``` ````.
Scan from the last `}` backwards for a matching `{` using a depth
counter that respects strings; attempt `JSON.parse`; on failure return
`undefined`. It must return an object (not an array or scalar).

## User notes

```ts
export function appendNotes(message: string, notes: string[]): string
```

If `notes` is empty, return `message`. Otherwise append two newlines,
`## User notes`, a blank line, and the notes as a numbered list in
order. Notes are plain text; do not render placeholders inside them.

## Tests

- `lookup` on nested paths and misses.
- `evaluateVars`: literal with placeholder; ref hit and miss; shell
  success, failure, and placeholder inside the command (use `printf`).
- `render`: single braces preserved, whitespace inside braces, missing
  placeholder throws with the name.
- `renderOutputMap`: one string entry, one object entry, two entries.
- `tail`: under limit unchanged; over limit cut at a line boundary with
  the marker line.
- `extractTrailingJson`: JSON at end, fenced JSON at end, prose only,
  JSON in the middle followed by prose (must return undefined), nested
  braces inside strings.
- `appendNotes`.

## Verification (human)

Render `docs`-style step prompt with a namespace containing two fake
step results and print it; confirm it reads as a document.

## Out of scope

Deciding when to render; the engine does that in step 08.

## As built

- Revision 2026-11-01 (skills): the `skills:` of an agent are delivered
  by inlining each skill's `SKILL.md` into the agent's first prompt,
  not through any provider mechanism. The renderer for that section,
  `appendSkills`, is created in step 08 next to the prompt assembly
  that calls it, with the same shape and tests as `appendNotes` here.
- Revision 2026-11-01: `vars.ts` spawns its shell commands directly
  with `process.env`, as this step allowed "for now". Step 06 owns the
  migration onto `spawnProcess` and `childEnv` (its "Migrate vars.ts"
  section): `evaluateVars` gains `env` and an optional kill signal, the
  byte limit and trailing-newline semantics are unchanged, and this
  file's tests are the acceptance criterion there.
