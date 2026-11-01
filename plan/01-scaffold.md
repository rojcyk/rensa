# 01 Scaffold

## Goal

An empty but complete TypeScript project that builds, lints, tests, and
installs a `rensa` binary which prints its version. Every later step adds
code to this layout.

## Decisions already made

- TypeScript, Node 22+, published on npm as `rensa`.
- Build: `tsdown`. Lint and format: `biome`. Tests: `vitest`.
- ESM only. `"type": "module"`.
- Single package, no workspaces.
- Engine and UI separation enforced by lint.

## Files to create

```
package.json
tsconfig.json
tsdown.config.ts
biome.json
vitest.config.ts
.gitignore
.github/workflows/ci.yml
src/engine/index.ts        export {}  (placeholder)
src/engine/errors.ts
src/cli/main.ts
src/tui/app.tsx            placeholder component, not wired yet
test/unit/smoke.test.ts
CLAUDE.md                  already exists; leave as is
docs/                      already exists; leave as is
```

## package.json

```json
{
  "name": "@rojcyk/rensa",
  "version": "0.1.0",
  "description": "Chains of agent steps across the coding CLIs you already pay for.",
  "type": "module",
  "bin": { "rensa": "./dist/cli/main.js" },
  "files": ["dist", "README.md", "LICENSE"],
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsdown",
    "dev": "tsdown --watch",
    "lint": "biome check .",
    "format": "biome format --write .",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit && tsc -p tsconfig.test.json",
    "check": "npm run lint && npm run typecheck && npm run test && npm run build"
  },
  "repository": "github:rojcyk/rensa",
  "publishConfig": { "access": "public" },
  "license": "MIT"
}
```

Dependencies, latest stable at implementation time:

- runtime: `ink`, `react`, `ink-text-input`, `ink-spinner`, `yaml`
- dev: `typescript`, `tsdown`, `@biomejs/biome`, `vitest`, `@types/node`, `@types/react`

Pin exact versions in `package.json` (no `^`). Commit `package-lock.json`.

## tsconfig.json

Strict. `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`,
`"target": "ES2022"`, `"jsx": "react-jsx"`, `"rootDir": "src"`,
`"outDir": "dist"`, `"noUncheckedIndexedAccess": true`,
`"exactOptionalPropertyTypes": true`. Include `src` only. `tsconfig.test.json` extends it with `rootDir: "."`,
`noEmit`, and includes `src`, `test`, and `*.config.ts`; the `typecheck`
script runs both, since vitest strips types without checking them.

## tsdown.config.ts

Two entries: `src/cli/main.ts` and `src/engine/index.ts`. Output
`dist/`, format `esm`, `platform: 'node'`, `target: 'node22'`, shims
off, sourcemaps on, `dts` on for the engine entry only. The CLI entry
gets a `#!/usr/bin/env node` banner.

## biome.json

Formatter: 2 spaces, single quotes, no semicolons, line width 100.
Linter: recommended rules on. Add the import boundary as a project rule:

- `src/engine/**` must not import from `src/tui/**` or `src/cli/**`.
- `src/tui/**` and `src/cli/**` must not import any path under
  `src/engine/` other than `src/engine/index.ts` (and its `.js` form).

If the installed biome version lacks import-restriction rules, implement
the boundary as a small script `scripts/check-boundaries.mjs` that walks
`src/`, reads import specifiers, and exits non-zero on a violation; add
it to the `lint` script. Either way the check must fail CI.

## .gitignore

`node_modules/`, `dist/`, `coverage/`, `.rensa/runs/` (so this repo can
dogfood itself later without committing runs), `*.tgz`.

## src/engine/errors.ts

```ts
export type RensaErrorCode =
  | 'NOT_A_REPO' | 'CONFIG_PARSE' | 'CONFIG_INVALID' | 'CHAIN_NOT_FOUND'
  | 'PROVIDER_UNAVAILABLE' | 'DIRTY_TREE' | 'LOCKED' | 'INPUT_REQUIRED'
  | 'TEMPLATE' | 'PROCESS' | 'INTERNAL'

export class RensaError extends Error {
  constructor(
    public readonly code: RensaErrorCode,
    message: string,
    public readonly path?: string,   // file or dotted config path the error points at
    public readonly hint?: string,   // one-line remedy, e.g. "run: claude auth login"
  ) { super(message); this.name = 'RensaError' }
}
```

## src/cli/main.ts

Minimal for this step: parse `argv`; `--version` or `-v` prints the
version read from `package.json` at build time (inject via tsdown
`define`, do not read the file at runtime); `--help` prints a one-line
usage; anything else prints "not implemented" and exits 1. No Ink yet.

## test/unit/smoke.test.ts

One test asserting `RensaError` carries code and message. Exists so `npm
test` runs something.

## CI

`.github/workflows/ci.yml`: on push and pull request, Node 22, `npm ci`,
`npm run check`.

## Verification (human)

1. `npm ci && npm run check` passes.
2. `npm pack`, install the tarball globally in a scratch directory,
   `rensa --version` prints `0.1.0`.
3. Add a temporary `import '../tui/app.js'` to `src/engine/index.ts`;
   `npm run lint` must fail. Remove it.

## Out of scope

Any engine logic, any Ink screen, README content.

## Note 2026-10-31

Dependency changes decided after this step shipped; apply them as a
small follow-up change, not a rewrite of the step:

- Pin `ink@8.0.0` and `react@19.3.x` exactly (Ink 8 requires React
  19.3+). `package.json` already carries these.
- Remove `ink-spinner` and `ink-text-input` from the dependency list
  and from `package.json`. Both predate Ink 8 (May 2024) and are not
  used: step 11 builds `Spinner` on Ink's `useAnimation` and `InputBox`
  on `usePaste` + `useCursor` with keys routed through the screen's
  `useKeys` (step 11's focus model). _Done 2026-11-01: removed
  from `package.json` and the lockfile; `ink-testing-library@4.0.0`
  added as an exact dev dependency; `npm run check` passes._
- `ink-testing-library@4.0.0` must be smoke-tested against Ink 8 before
  any step relies on it. Add `src/tui/smoke.test.tsx` rendering
  `<Text>hi</Text>` through it and asserting `lastFrame() === 'hi'`. If
  it fails under Ink 8, remove the library, add
  `src/testing/inkFrames.ts` (a helper that renders with Ink's own
  `render()` into a `Writable` that collects frames and exposes
  `lastFrame()` and `frames`), and record the choice here as a dated
  line. Steps 11–14 say "render" and work with either.
- Record of the choice: _(pending)_
