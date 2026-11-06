Hello! Here's what's in `/Users/user/Repos/rensa`.

**Top level**
- `package.json` (`@rojcyk/rensa` v0.1.0)
- `README.md`, `LICENSE`
- `biome.json`, `tsdown.config.ts`
- `.gitignore`
- `.claude/`: `CLAUDE.md` plus skills (`create-agent`, `create-skill`, `typescript-standards`, `typescript-tests`)
- `docs/`: `chain.yaml`, `project.yaml`
- `src/`: the source, broken down below
- `node_modules/`
- Some stray `.DS_Store` files (in the root and under `.claude/`)

**`src/`**
- `engine/`: `engine.ts`, `index.ts`, `errors.ts`, `diag.ts`, and these subfolders:
  - `adapters/`: `types.ts`, `registry.ts`, `available.ts`, `capture.ts`, `fake/`, `claude/` (`argv.ts`, `auth.ts`, …)
  - `config/`: discover, load, validate, resolve, paths, effort, issues, types
  - `process/`: spawn, shell, env, lines, shutdown
  - `run/`: runner, events, transcript, jsonl, lock, dir, id, runjson, view, git
  - `template/`: render, vars, namespace, output, skills
- `cli/`: `main.ts`, `args.ts`, `headless.ts`, `doctor.ts`, `format.ts`, `capture.ts`
- `tui/`: `app.tsx`
- `testing/`: helpers (`tmpRepo`, `chains`, `processes`, `cli`, `engine`)

Most engine modules have a `*.test.ts` next to them. My search stopped at 100 results, so a few files may be missing from this list. A `tsconfig.json` probably exists, but I didn't confirm it.

You also have uncommitted work on `main`: the Claude adapter (`src/engine/adapters/claude/`), the two `capture.ts` files, and changes to `args.ts`, `main.ts`, `registry.ts` and `engine/index.ts`. What do you want to work on?