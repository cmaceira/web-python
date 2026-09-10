# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`pyplay` is a static, backend-free Python playground: CodeMirror 6 editor + Pyodide
(CPython 3.13 → WASM) in a Web Worker + Ruff-WASM lint/format, built by Vite into a
directory of static files. No framework, no server, no network calls off-origin.

## Commands

```bash
npm ci
npx playwright install chromium firefox webkit   # once

npm run dev            # vendors Pyodide/Ruff into public/, then Vite on :5173
npm run build          # vendor + tsc --noEmit + vite build → dist/
npm run preview        # serve dist/ with the isolation headers, :4173

npm run test:unit      # vitest run (jsdom, pure logic)
npx vitest run tests/unit/stdin-stream.test.ts
npx vitest             # watch

npx playwright test                        # against the *built* dist/
npx playwright test tests/e2e/stdin.spec.ts
npx playwright test --grep "VC-030"        # every test is named after its VC
npx playwright test --headed --debug

npm run audit:perf     # VC-053 / VC-323 / VC-326 / VC-513 — latency + size budgets
npm run audit:contrast # VC-051 / VC-071 / VC-514 — contrast in both palettes
npm run test:matrix    # the eight pinned browser projects; local only, never CI
```

`npm run vendor` copies Pyodide and Ruff out of `node_modules` into `public/pyodide/`
and `public/ruff/`, which are git-ignored — a fresh clone must run it (both `dev` and
`build` do).

### Playwright specifics that bite

- Specs run against the built site. **After changing `src/`, run `npm run build`**
  before re-running — Playwright reuses a server already on the port and will keep
  serving the previous build.
- `playwright.config.ts` starts three servers: `:4173` (the build, with COOP/COEP),
  `:4174` `scripts/serve-plain.mjs` (no isolation headers, for VC-015), `:4175`
  `scripts/serve-deploy.mjs` (a second deployment, for VC-063).
- **In a git worktree, set `PW_PORT_BASE`** to shift all three ports, or the suite
  silently tests the other checkout's build.
- Service workers are blocked by default (`use.serviceWorkers: 'block'`); the offline
  and storage specs opt back in.
- Re-run configurations the child specs depend on: `PANE_OPEN=1` (spec-03 VC-327),
  `PYPLAY_LAYOUT_PREF=horizontal|vertical` (spec-04 VC-433), `RUN_LONG=1` (VC-059's
  real six-minute run), `MATRIX=1` (the matrix projects; without it they skip).
  `openPlayground()` in `tests/e2e/helpers.ts` is the only reader of the first two.

## Architecture

Read [`docs/architecture.md`](docs/architecture.md) before changing the worker, the
stdin channel, the layout switch or the theme — it is the normative record of the
decisions below and of where the implementation deviates from the specs.

- **The visitor's program never runs on the main thread.** `src/runtime.ts` owns a
  dedicated worker (`src/worker/pyodide.worker.ts`, a *classic* worker using
  `importScripts('/pyodide/pyodide.js')`). Message types live in `src/protocol.ts`.
- **Stop is `worker.terminate()`, not a message** — a tight loop never yields. Stop
  terminates, nulls `currentRunId`, and spawns a replacement worker with a fresh
  `SharedArrayBuffer`. Recovery is silent (no second "ready" line). Replacements load
  from `<url>?respawn=<n>`: a WebKit COEP/HTTP-cache workaround, without which the
  first Stop in Safari is the last.
- **`runId` is allocated on the main thread, monotonic, never reset.** Every inbound
  message with a `runId` passes `isCurrentRun()`; mismatches are dropped, so output
  from a terminated worker can never be attributed to the current run.
- **Blocking `input()` is a `SharedArrayBuffer` + `Atomics.wait` channel**
  (`src/stdin-channel.ts` is the wire format; `src/stdin-stream.ts` is the pure,
  unit-tested CPython stdin semantics). This is why the whole site must be
  **cross-origin isolated** — `vite.config.ts` sends COOP `same-origin` /
  COEP `require-corp` on the dev *and* preview servers. Without them the page still
  loads and a banner explains Python cannot run: intended degradation, not a bug.
- **Ruff runs in-thread**, so Format is one synchronous, undoable editor transaction.
- **One service worker** does both COOP/COEP injection and precaching; the manifest is
  generated at build time by `scripts/precache.mjs` + `scripts/sw-template.js` via the
  Vite plugin in `scripts/vite-precache-plugin.mjs`.
- **Persisted state is exactly three `localStorage` keys** plus one Cache Storage
  bucket: `pyplay.program.v1`, `pyplay.layout.v2`, `pyplay.theme.v1`. Two-value enums
  are *superseded, never migrated* — `layout.v1` shipped with the opposite convention
  and is never read again.
- **Layout is one attribute**, `#app[data-layout]` = `horizontal` | `vertical`; all CSS
  keys off it. Both names describe **the divider** (like `vim`'s `:split`/`:vsplit`):
  `horizontal` = stacked, `vertical` = side by side. `src/layout.ts` is normative.
  Document order is fixed in both layouts — re-parenting would drop CodeMirror focus
  and reorder the tab sequence.
- **Theme has two writers**: an inline render-blocking bootstrap in `index.html` and
  `src/theme.ts`, which re-apply idempotently. `data-theme` = preference,
  `data-effective`/`color-scheme` = effective palette. System is load-scoped — the OS
  sample is taken once, never live-updated.

## Conventions

- **Every non-obvious line cites its requirement** (`FR-`, `BR-`, `NFR-`, `VC-`) in a
  comment, so a later change knows what it is allowed to break. Tests are named after
  the Verification Criterion they discharge, keeping `specs/` traceable to the suite.
- **`specs/*-frozen.md` are normative.** User-visible strings live in `src/format.ts`,
  quoted verbatim from the spec — change the spec first.
- **Never use the `disabled` attribute on a conditionally-inert control.** Use
  `setInert()` from `src/controls.ts` (`aria-disabled` + `tabindex="0"`), and guard
  *every* activation path with `isInert()`. Keyboard traversal must reach every
  control. `Tab` is deliberately not bound to editor indentation.
- **Two breakpoints live twice and must be changed twice**: 900 px (`LAYOUT_MIN_WIDTH`
  in `src/layout.ts` ↔ `@media` in `src/styles.css`) and 700 px (`WIDE_LAYOUT_QUERY` in
  `src/symbol-pane.ts` ↔ its `@media` block). The CSS mirror is what stops the page
  painting a layout the resolver did not choose.
- **The symbol pane must never touch the editor** (BR-301) — it holds no `EditorView`
  reference, so it can produce no transaction, no undo entry, no autosave or lint
  schedule. Changing the 29-character set is gated by BR-302 (Python 3 tokens only;
  lookalikes like `≤` `≠` `“` are forbidden and grepped for by VC-325).
- **Never relax a threshold to make a red gate green.** A threshold moves only in its
  own commit, with the numbers that justify it. CI-only tolerances and skipped
  assertions are not an option; a skip is never a pass.
- **Docs are part of the change**: worker protocol / stdin channel / deployment shape →
  `docs/architecture.md` or `docs/deployment.md`; workflows → `docs/ci.md`.
- TypeScript is strict, with `noUnusedLocals`, `noUnusedParameters` and
  `verbatimModuleSyntax`. `.nvmrc` pins Node 26 for both CI and `nvm use`.

## Pull requests and releases

PRs are squash-merged, so **the PR title becomes the commit subject and decides the
release**. It is validated by the `pr-title` check against Conventional Commits:
`feat` → minor, `fix`/`perf`/`revert` → patch, `!` or a `BREAKING CHANGE:` footer →
major (**including from `0.x`**), `chore`/`docs`/`style`/`refactor`/`test`/`build`/`ci`
→ no release. Editing the title alone re-runs the check; no empty commit is needed.

Seven required checks gate the merge: `pr-title`, `typecheck`, `unit`, `e2e-chromium`,
`audit-contrast`, `audit-perf`, `artifact` — all runnable locally with identical
commands. A passing `e2e-chromium` reads `94 passed, 1 skipped`; that one skip
(VC-059's six-minute variant) is the only permitted one.

On merge, the release pipeline re-runs the gate against `main` and, if the bump is not
none, tags `vX.Y.Z` on the merge commit and publishes a Release. It does **not** push a
version commit — the version's source of truth is the highest `vX.Y.Z` git tag, not
`package.json`. No CI job deploys; Netlify deploys from its own git integration.

The pinned browser matrix stays local: two of its eight projects have no launchable
engine on a Linux runner, and `docs/architecture.md` → *Browser matrix* records which
pinned names are engine aliases rather than genuine runs.

Baselines (`tests/e2e/baseline-*.json`) are environment-dependent and pin specific
commits; re-record with `node scripts/record-baselines.mjs <sha> --geometry|--build
<path>`. CI records its own on the runner. A run matching no record skips.
