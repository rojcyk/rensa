# 17 Release

## Goal

`npm install -g @rojcyk/rensa` on a clean machine gives a working tool. README,
packaging, version, publish.

## Context

Steps 01–16 merged. The `@rojcyk/rensa` npm name was reserved with a
placeholder; this step publishes over it.

## Checklist

1. `README.md`: what rensa is (reuse the first paragraph of
   `CLAUDE.md`), install (`npm install -g @rojcyk/rensa`), requirements (Node
   22+, at least one of the three CLIs installed and logged in), a
   60-second start (create `.rensa/`, copy the minimal chain below,
   run `rensa`), links to `docs/chain.yaml` and `docs/project.yaml`,
   the key map for the run screen, and a "not yet" list: parallel
   agents, conditionals, loops, worktrees, Windows.

   Minimal chain for the README:

   ```yaml
   name: review
   description: Review the current diff.
   agents:
     reviewer: { provider: claude, tools: read, prompt: agents/reviewer.md }
   steps:
     - id: review
       prompt: steps/review.md
       agents: [reviewer]
       vars: { diff: $(git diff {{base}}) }
   ```

   with the two prompt files shown in full.
2. `LICENSE`: MIT, year and holder as the repository owner.
3. `package.json`: fill `repository`, `homepage`, `bugs`; confirm
   `files` and `bin`; version `0.1.0`.
4. `npm pack`, inspect the tarball listing: `dist/`, `README.md`,
   `LICENSE`, `package.json` only. No `src/`, no `*.test.*`, no `test/`, no `plan/`.
5. Clean-machine smoke test: a fresh user account or container with
   Node 22 and Claude Code installed and logged in. Install the
   tarball globally, create a repo with the README's minimal chain,
   run `rensa doctor`, `rensa run review`, then `rensa` and run it
   through the TUI. Everything in the README must be what actually
   happened.
6. Tag `v0.1.0`, `npm publish --access public`, verify `npm view @rojcyk/rensa version`.
7. CI: add a release workflow that publishes on a `v*` tag with
   `NPM_TOKEN`, running `npm run check` first.

## Verification (human)

Step 5 is the verification. Do not publish until it passes without
consulting anything outside the README.

## Out of scope

Homebrew, binaries, changelog tooling.
