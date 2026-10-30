# 03 Chain loading

## Goal

Turn a chain file plus the two optional project files into a
`ResolvedChain` (see `plan/index.md`, Core types) or a `RensaError` that
names the file and the dotted path of the problem. This is the loader
the TUI, the CLI, and the engine all use.

## Context

Steps 01 and 02 are merged. Formats: `docs/chain.yaml`,
`docs/project.yaml`. Read both before implementing; they are the
authoritative description of every key.

## Files to create

```
src/engine/config/types.ts        raw (as-parsed) and resolved types
src/engine/config/load.ts         parse one YAML file into raw types
src/engine/config/resolve.ts      merge levels, expand agents, derive labels
src/engine/config/validate.ts     loader rules
src/engine/config/effort.ts       per-provider effort tables
src/engine/config/index.ts        loadChain(name, discovered): ResolvedChain
src/engine/config/load.test.ts
src/engine/config/resolve.test.ts
src/engine/config/validate.test.ts
test/fixtures/config/              small yaml inputs for the tests
```

## Raw types (types.ts)

Mirror the YAML exactly, every field optional except where the docs say
required. Do not reuse resolved types for raw input.

```ts
interface RawAgent { provider?: string; model?: string; effort?: string; tools?: string; prompt?: string; skills?: string[] }
type RawAgentRef = string | ({ from?: string } & RawAgent)
interface RawStep {
  id?: string; prompt?: string; agents?: RawAgentRef[]; vars?: Record<string, string>
  run?: string; on_fail?: string; timeout?: string; pause?: string; tools?: string
}
interface RawChain { name?: string; description?: string; input?: string; base?: string; agents?: Record<string, RawAgent>; steps?: RawStep[] }
interface RawProject { base?: string; allow_api_keys?: boolean; agents?: Record<string, RawAgent> }
```

Unknown top-level or step keys are a `CONFIG_INVALID` error naming the
key: "unknown key `when` at steps[3]; not supported in this version".
This is how reserved keys are rejected. Unknown keys inside an agent
entry are errors too.

## load.ts

`loadYaml<T>(path): Promise<T>` using the `yaml` package. A parse error
becomes `CONFIG_PARSE` with the file path and the parser's line and
column in the message. The result must be a mapping; anything else is
`CONFIG_INVALID`.

## Resolution (resolve.ts)

Inputs: raw chain, optional raw project (repo), optional raw project
(user), and the three file paths.

1. `base`: chain, else repo project, else user project, else undefined.
2. `allowApiKeys`: repo project, else user project, else false. (A chain
   cannot set it.)
3. Agent registry: start with user project agents, overlay repo project
   agents, overlay chain agents. Overlay replaces the whole entry by
   name. Each entry remembers the file that declared it, for path
   resolution and error messages.
4. For each raw agent entry, produce an `AgentConfig`:
   - `provider` required, one of `claude | codex | grok | fake`
     (`fake` only when `process.env.RENSA_DEV === '1'`, otherwise
     report it as unknown).
   - `effort` normalized through `effort.ts` (below).
   - `tools` required: `read | write`.
   - `prompt` and each `skills` entry resolved to an absolute path
     relative to the declaring file; `~` expanded to the home directory.
     The files must exist (prompt: a file; skill: a directory containing
     `SKILL.md`), else `CONFIG_INVALID` with the path.
5. For each step:
   - `run` present and `prompt`/`agents` absent: `ShellStep`.
   - `prompt` and `agents` present and `run` absent: `AgentStep`.
   - Anything else: `CONFIG_INVALID`.
   - `on_fail` default `stop`; `timeout` parsed from `Ns|Nm|Nh`, default
     `1h`; `pause` one of `before | after` or absent.
   - `agents` must be a list with exactly one entry (MVP rule). Resolve
     the entry:
     - string → registry lookup; `session: 'named'`, `name` set.
     - `{ from: X, ...overrides }` → registry lookup of X, overlay the
       override fields, `session: 'fresh'`.
     - inline object without `from` → build from fields, `session: 'fresh'`.
     - step `tools` narrows: `write` agent in a `read` step becomes
       `read`; `read` agent in a `write` step is `CONFIG_INVALID`.
   - Label: the registry name, else the `from` name, else the provider.
     With one agent per step there are no collisions, but implement the
     suffix rule anyway (`claude`, `claude-2`) as a pure function with a
     test, since step 07's fixtures and later parallel steps depend on it.
   - Step `prompt` resolved to an absolute path relative to the chain
     file; must exist.
   - `vars`: keep as `Record<string, VarSpec>` where
     `VarSpec = { kind: 'literal' | 'shell' | 'ref', value: string }`,
     classified by syntax: `$(...)` → shell with the inner command;
     matches `/^steps(\.[a-z0-9_-]+)+$/` → ref; else literal. (Only
     `steps` has nested fields, so `package.json` or `v1.2.3` stay literal.)
     Evaluation is step 04's job.
6. `name`: file stem; if `name` is present in the file and differs,
   `CONFIG_INVALID`.
7. `input` default `none`.

## effort.ts

```ts
export const EFFORT: Record<Provider, Partial<Record<Effort, string | null>>> = {
  claude: { low: 'low', medium: 'medium', high: 'high', max: 'max' },
  codex:  { low: 'low', medium: 'medium', high: 'high', max: 'xhigh' },
  grok:   { low: 'low', medium: 'medium', high: 'high', max: null },   // adjust in step 15 once verified
  fake:   { low: 'low', medium: 'medium', high: 'high', max: 'max' },
}
```

`null` means the provider has no such level: `CONFIG_INVALID` with the
message "grok does not support effort: max (agent `grok`)". The table is
data so adapters steps can correct it without touching resolution.

## Validation (validate.ts)

Runs on the resolved chain, collects all errors, throws the first with
the rest attached as `details: string[]` on the error (add that optional
field to `RensaError`).

- Step ids unique.
- Agent step has prompt and exactly one agent.
- Named agent on a provider whose adapter cannot resume: cannot be
  checked until step 07 defines adapters; leave a hook
  `validateWithAdapters(chain, caps)` that step 08 calls.
- Placeholder check: read every step prompt and every agent persona,
  find all `{{name}}` occurrences (regex `/\{\{\s*([a-z_][\w.-]*)\s*\}\}/gi`),
  and ensure each name is declared in that step's `vars` or is a
  built-in (`input`, `input_path`, `base`, `run_id`, or `steps.<id>.<field>`
  where `<id>` is an earlier step and `<field>` is one of `output`,
  `passed`, `exit_code`, `text`). `{{input}}` in a chain with
  `input: none` is an error. A declared var no prompt references is a
  warning, returned on the chain as `warnings: string[]`.
- Any shell step, or any step whose agent ends up with `write`, marks the
  chain `writes: true` (add to `ResolvedChain`).

## index.ts

```ts
export async function loadChain(name: string, d: Discovered): Promise<ResolvedChain>
export async function loadAllChains(d: Discovered): Promise<Array<{ name: string; chain?: ResolvedChain; error?: RensaError }>>
```

`loadAllChains` never throws; it returns per-chain results so the chains
screen can show broken entries.

## Tests

Use small fixtures under `test/fixtures/config/`. Cover: three-level
registry override; `from` with override; inline agent; label derivation
including the suffix rule; every `CONFIG_INVALID` path listed above with
an assertion on the `path` field; `timeout` parsing; unknown key
rejection; placeholder check success, unknown placeholder, `{{input}}`
under `input: none`, unused-var warning; `writes` flag.

## Verification (human)

Copy `docs/chain.yaml` and `docs/project.yaml` into a scratch repo's
`.rensa/`, create the referenced prompt and skill files, and load the
chain from a one-off script. Print the resolved steps. Then introduce a
typo in a key and confirm the error names it.

## Out of scope

Evaluating `vars`, running anything, checking providers.
