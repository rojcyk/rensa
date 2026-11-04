# 02 Config discovery

## Goal

Pure functions that locate everything rensa reads and writes on disk,
plus the one side effect allowed before a run: creating `.rensa/` with
its `.gitignore`. No YAML parsing here; step 03 does that.

## Context

Step 01 is merged. `RensaError` exists.

## Locations

| what | path | rule |
|---|---|---|
| repo root | `git rev-parse --show-toplevel` from `cwd` | not a repo: `RensaError('NOT_A_REPO')` |
| project dir | `<root>/.rensa/` | created on demand |
| project config | `<root>/.rensa/project.yaml` | optional |
| chain files | `<root>/.rensa/*.yaml` and `*.yml` except `project.yaml` | name = file stem |
| runs dir | `<root>/.rensa/runs/` | created by step 05 |
| user config dir | `~/.rensa/` if it exists, else `$XDG_CONFIG_HOME/rensa` if set, else `~/.config/rensa`; on win32 `%APPDATA%\rensa` | never created by rensa |
| user config | `<user dir>/project.yaml` | optional |

## Files to create

```
src/engine/config/paths.ts
src/engine/config/discover.ts
test/unit/config/paths.test.ts
test/unit/config/discover.test.ts
test/helpers/tmpRepo.ts
```

## paths.ts

```ts
export interface Paths {
  cwd: string; root: string; projectDir: string; projectConfig: string
  runsDir: string; userDir: string; userConfig: string
}
export async function resolvePaths(cwd: string, env = process.env): Promise<Paths>
export function userConfigDir(env = process.env, platform = process.platform, home = os.homedir()): string
```

`resolvePaths` runs `git rev-parse --show-toplevel` with `cwd` (use
`node:child_process` `execFile`, not a shell). Non-zero exit or a
non-git error maps to `NOT_A_REPO` with the message "not a git
repository: <cwd>". Everything else is string concatenation; no fs
access.

## discover.ts

```ts
export interface ChainFile { name: string; path: string }
export interface Discovered {
  paths: Paths
  chains: ChainFile[]                 // sorted by name
  projectConfig?: string              // present only if the file exists
  userConfig?: string
  created: boolean                    // true if .rensa/ was created by this call
}
export async function discover(cwd: string): Promise<Discovered>
export async function ensureProjectDir(paths: Paths): Promise<boolean>
```

`ensureProjectDir`: if `projectDir` is missing, create it and write
`.gitignore` containing exactly `runs/\n`; return true. If it exists,
ensure `.gitignore` exists with that line (append the line if the file
exists without it); return false. Never touch the repository's own
`.gitignore`. The resulting content is the pure, exported
`withRunsLine(current)`, which step 08's dirty-tree check uses to
recognise this write as rensa's own.

`discover` calls `resolvePaths`, `ensureProjectDir`, lists chain files
(case-insensitive extension match, skip dotfiles and `project.yaml`),
and stats the two optional config files.

## Tests

`test/helpers/tmpRepo.ts`: creates a temp directory, runs `git init`,
sets a user name and email locally, makes one commit so HEAD exists,
returns `{ dir, cleanup }`. Used by every later integration test; make
it solid.

- `userConfigDir`: with `~/.rensa` present it wins; `XDG_CONFIG_HOME`
  honored; win32 branch uses `APPDATA`.
- `resolvePaths` rejects a non-repo directory with `NOT_A_REPO`.
- `discover` on a fresh repo creates `.rensa/.gitignore` with `runs/`,
  reports `created: true` and no chains.
- Second `discover` call reports `created: false` and does not rewrite
  the file (compare mtime).
- Chain listing excludes `project.yaml`, includes `.yml`, sorts by name,
  ignores `.hidden.yaml`.

## Verification (human)

Run `npx vitest run test/unit/config`. In a scratch repo, call `discover`
from a one-off script and confirm the `.rensa/.gitignore` content.

## Out of scope

Parsing any file. Checking providers.
