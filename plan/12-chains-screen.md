# 12 Chains screen

## Goal

The first screen: provider availability, the list of chains with
descriptions or load errors, annotations for chains that cannot run,
and navigation into a chain.

## Context

Steps 01–11 merged. Data comes from `engine.providers()` and
`engine.chains()`; this screen computes nothing. `providers()` is
`undefined` until the first check completes (step 08 starts it in
`open` and does not await it), so the screen renders a checking state
first and re-renders on the engine's `'providers'` event; it never
awaits `providersChecked`.

## Layout

```
⎇ feat/quote-limits  ~/Repos/trezor-suite
──────────────────────────────────────────────────────────────────────────
  claude 2.1.3   codex 0.48 · not logged in   grok not installed

  tdd-review
    Tests first, implementation, three reviewers, routed fixes, re-test.
    ! needs grok

  review-only
    Three reviewers on the current diff.

  nightly-audit
    ! agents.codex: unknown provider "codx"
```

- Header without a mode suffix and without a right-side chain name.
- Provider line: one entry per provider in registry order, separated by
  three spaces. `ready` → `name version` in `text`; `not_logged_in` →
  `name version · not logged in` in `muted`; `not_installed` →
  `name not installed` in `dim`. The `fake` provider is listed only
  under `RENSA_DEV=1`. While `providers()` is `undefined`, the line is
  `checking providers…` in `muted` and no chain carries a provider
  annotation (`missingProviders` is empty until then). During a
  recheck the previous line stays until the new statuses arrive.
- Chain rows: name in `text` (selected row in `accent`), description
  indented two spaces in `muted`; if the chain failed to load, the
  error message in `err` instead of the description, prefixed `! `.
  Chains with `missingProviders` get a third line in `warn`:
  `! needs grok` for not installed, `! codex not logged in` for the
  other case, comma-joined when several.
- Empty state: `no chains in .rensa/` in `muted`.
- Rows beyond the terminal height scroll with the selection; keep the
  selected row visible.

## Keys

`up`/`down` move; `enter` opens the detail screen for the selected
chain (broken chains open a detail screen that shows only the error);
`recheck` (ctrl+r) calls `engine.recheckProviders()` and re-renders;
`quit` handled by the app.

## Files to create

```
src/tui/screens/Chains.tsx
src/tui/components/ProviderLine.tsx
src/tui/components/ChainRow.tsx
src/tui/screens/Chains.test.tsx   ink-testing-library snapshots
```

Add `ink-testing-library` as a dev dependency.

## Tests

Render with a stubbed engine (three providers in the three states,
three chains as in the mock, one broken) and snapshot the frame. Assert
`enter` calls `navigate({ name: 'detail', chain })` with the selected
name and that `down` past the end stays on the last row. A second
render with `providers()` returning `undefined` snapshots the checking
line; emitting `'providers'` on the stub then produces the first frame
without a remount.

## Verification (human)

Open `rensa` in this repository with the dogfooding chains from step 10
present; log out of one provider and confirm the line and annotation
change after `ctrl+r`.

## Out of scope

Starting a run.
