# Contributing

## Layout

```
index.html                 the single page shell
src/                       application code (TypeScript, no framework)
  main.ts                  wiring: every FR is hooked up here
  controls.ts              the inert-but-focusable control pattern
  editor.ts                CodeMirror 6 setup
  completion.ts            offline Python name completion source
  console.ts               console rendering; console-buffer.ts caps it
  runtime.ts               owns the Pyodide worker, runIds, stop-and-replace
  worker/pyodide.worker.ts the worker: Pyodide, the Python runner, the stdin shim
  stdin-channel.ts         the SharedArrayBuffer wire format
  stdin-stream.ts          the pure CPython stdin semantics
  lint/                    Ruff engine, diagnostics, markers, panel, format
  offline.ts               service-worker registration and status wiring
  symbols.ts               the 29-row special-character set (spec-03)
  symbol-pane.ts           the special-character pane: layout, keys, feedback
  layout.ts                the layout resolver, and what the two names mean (spec-04)
  theme.ts                 color-mode preference, bootstrap sync, editor hookup
scripts/                   build-time and test-time tooling
  precache.mjs             manifest + service-worker generation (shared)
  sw-template.js           the single service worker's source
  serve-plain.mjs          a non-isolated origin, for VC-015
  serve-deploy.mjs         a second deployment, for VC-063
  derive-version.mjs       the release bump derivation (pure; unit-tested)
  record-baseline-build.mjs    pins a build's shape and size (VC-326, VC-623)
  record-baseline-geometry.mjs pins the vertical layout's geometry (VC-408)
tests/unit/                Vitest units
tests/e2e/                 Playwright specs, one test per Verification Criterion
docs/                      deployment, architecture and CI references
specs/                     the specs and their implementation plans
.github/workflows/         the PR gate and the release pipeline
.nvmrc                     the Node.js major both CI and `nvm use` read
```

Every test is named after the Verification Criterion it discharges
(`VC-030 (FR-029, FR-030, FR-031): …`), so `--grep "VC-030"` finds it and the
spec's *Verification Criteria* table is directly traceable to the suite.

## Running the test suites

Install the browsers once:

```bash
npm ci
npx playwright install chromium firefox webkit
```

### Unit tests (Vitest)

Pure logic only — the stdin stream state machine, console retention and write
truncation, diagnostic mapping, autosave debouncing, the storage layer, the
`runId` discipline. No browser, no Pyodide.

```bash
npx vitest run             # or: npm run test:unit
npx vitest                 # watch mode
npx vitest run tests/unit/stdin-stream.test.ts
```

### Browser tests (Playwright)

These run against the **built** site. `playwright.config.ts` starts three
servers for you and waits for them:

| Port | What | Why |
|---|---|---|
| 4173 | `npm run build && vite preview` | the site under test, with COOP/COEP |
| 4174 | `scripts/serve-plain.mjs` | the same build with **no** isolation headers, for VC-015 |
| 4175 | `scripts/serve-deploy.mjs` | a private copy that can publish a second deployment, for VC-063 |

Set `PW_PORT_BASE` to shift all three ports at once — needed when two checkouts
of this repo (a git worktree and its main clone) run the suite at the same
time, since Playwright reuses an existing server on the port and would
otherwise silently test the other checkout's build.

The preview server is only rebuilt when Playwright has to *start* it. After
changing `src/`, run `npm run build` before re-running the suite, or a reused
server will keep serving the previous build.

```bash
npx playwright test                          # or: npm run test:e2e
npx playwright test tests/e2e/stdin.spec.ts
npx playwright test --grep "VC-030"
npx playwright test --headed --debug
```

spec-03's **VC-327** asks for the spec-01 suites in two configurations — with
the special-character pane never opened, and with it open before each spec's
first assertion. `PANE_OPEN=1` selects the second; `openPlayground()` in
`tests/e2e/helpers.ts` is the only place that reads it, so no spec needs to
know the pane exists:

```bash
npx playwright test                                    # pane never opened
PANE_OPEN=1 npx playwright test \
  --grep-invert "VC-3[0-9][0-9]|VC-050|VC-051|VC-052|VC-071|A-305"
```

The excluded criteria are spec-03's own, plus the four parent criteria it
amends — all of which already run with the pane open in the first
configuration.

spec-04's **VC-433** does the same for the layout: the parent suites run three
times, with the preference unset, `horizontal` (stacked) and `vertical` (two
columns) — both words name the orientation of the divider, see
`src/layout.ts` — because the
layout is presentation only (BR-401) and every criterion must hold in both
renderings. `PYPLAY_LAYOUT_PREF` selects the run, and `openPlayground()` is
again the only place that reads it:

```bash
npx playwright test                                   # unset: FR-411 resolves from the width
PYPLAY_LAYOUT_PREF=horizontal npx playwright test     # stacked
PYPLAY_LAYOUT_PREF=vertical   npx playwright test     # two columns
```

spec-04's own suites (`layout.spec.ts`, `layout-state.spec.ts`) seed the
preference themselves and opt out with `openPlayground(page, { seedLayout:
false })`, so the environment cannot overwrite the value they are asserting on.

### Re-recording the pinned baselines

Records pin what a build is compared against:

| Record | Criterion | Pinned commit |
|---|---|---|
| `tests/e2e/baseline-build.json` | VC-326 (spec-03, build shape) | `8df7fa5` |
| `tests/e2e/baseline-build-completion.json` | VC-429 (shape only); NFR-606 size historical | `3efb8be` |
| `tests/e2e/baseline-build-about.json` | VC-814 (NFR-805, ≤ 4 KB) | `e569b81` |
| `tests/e2e/baseline-build-diag-resize.json` | VC-912 (NFR-904, ≤ 2 KB) | `562cb27` |
| `tests/e2e/baseline-build-paste.json` | VC-1011 (NFR-1001 size historical) | `2eb0bd4` |
| `tests/e2e/baseline-build-brackets.json` | VC-1206 (NFR-1201 size historical) | `44f9afa` |
| `tests/e2e/baseline-build-output.json` | VC-1314 (NFR-1301, ≤ 3 KiB) | `6ab5936` |
| `tests/e2e/baseline-build-theme.json` | VC-513 (spec-05, shape / latency) | `0a4194f` |
| `tests/e2e/baseline-geometry.json` | VC-408 (spec-04, ±1 px) | `384cb70` |

`baseline-geometry.json` records the **stacked** rendering, which is what
FR-407 protects; the recorder seeds `pyplay.layout.v2` to ask the shipped
resolver for it.

All but the shape record are **environment-dependent**, and comparing across
environments reports the environment as a regression:

- The panel column's height is a text metric. The same `384cb70` build puts
  the stacked column's top at 82 px on a GitHub runner, 84 px in the
  Playwright Linux image and 82 px on darwin-arm64, with the toolbar a pixel
  taller on linux.
- `gzipSync` is only as reproducible as the zlib Node was linked against.
  Node 26 ships stock zlib on darwin and zlib-ng on linux, and even the two
  linux arches differ by 2 B over this app payload.

So `pr.yml` builds the pinned commits on the runner and records its own before
each suite, pointing `PYPLAY_BASELINE_GEOMETRY`, `PYPLAY_BASELINE_BUILD`, and
`PYPLAY_BASELINE_OUTPUT` at them. The committed records are the fallback
for a local run: a geometry record names the environment it was made on and
the size records are keyed by compressor, and a run matching neither **skips**
rather than reporting a pass it did not earn.

One command records either, from a throwaway worktree it cleans up after:

```bash
node scripts/record-baselines.mjs 384cb70 --geometry tests/e2e/baseline-geometry.json
node scripts/record-baselines.mjs 3efb8be --build    tests/e2e/baseline-build-completion.json
node scripts/record-baselines.mjs 562cb27 --build    tests/e2e/baseline-build-diag-resize.json
node scripts/record-baselines.mjs 44f9afa --build    tests/e2e/baseline-build-brackets.json
node scripts/record-baselines.mjs 6ab5936 --build    tests/e2e/baseline-build-output.json
```

Commit the result only when it is your own environment's record of a commit
the specs still pin, or when a spec pins a new baseline commit. To measure
against a record without committing it, point the environment variable at it:

```bash
PYPLAY_BASELINE_GEOMETRY=/tmp/geometry.json npx playwright test --project=chromium
```

Service workers are **blocked** by default (`use.serviceWorkers: 'block'`) so a
cache-first worker cannot mask the deliberately-404ed assets of VC-014 and
VC-049, and VC-015 can observe the page "with the service worker
unregistered". The offline and storage specs opt back in with
`test.use({ serviceWorkers: 'allow' })`.

Both suites together:

```bash
npm test                   # vitest run && playwright test
```

### Audits

```bash
npm run audit:perf         # runtime/pane/completion latency + the NFR-004 15 MB budget
npm run audit:contrast     # page, pane, and completion contrast in light/dark palettes
```

`audit:perf` prints every measurement next to its threshold. `audit:contrast`
samples `getComputedStyle` on the rendered page in both palettes, so a token
that is defined but never applied cannot make a sample pass.

### The browser matrix (VC-055, VC-432, NFR-011)

```bash
npm run test:matrix
# or, spelled out:
npx playwright test --project=chrome-141 --project=chrome-140 \
                    --project=edge-141   --project=edge-140 \
                    --project=firefox-145 --project=firefox-144 \
                    --project=safari-26.1 --project=safari-26.0
```

Those eight projects run `tests/e2e/matrix.spec.ts` only; the default
`chromium` project runs everything else. That is why the criteria spec-03's
VC-324 and spec-04's VC-432 cover are re-asserted in that file rather than
grepped out of their own specs. The matrix is **opt-in** via `MATRIX=1`
(which `npm run test:matrix` sets, along with `--workers=1`): VC-024's NFR-014
budget is a *reference-profile* wall-clock measurement, and six browser engines
running concurrently is not that profile. Without the flag the matrix projects
report `skipped`. A project whose engine cannot be launched on this machine is
also **skipped** — never stubbed onto a substitute engine under a pinned name —
and the runner prints which ones. See
[`docs/architecture.md` → *Browser matrix*](docs/architecture.md#browser-matrix)
for what each pinned name is actually mapped onto.

### Long-running and manual criteria

- `RUN_LONG=1 npx playwright test --grep "VC-059"` runs the real six-minute
  no-timeout check (skipped by default).
- Five criteria no script can assert: VC-056 (physically disconnect the
  network and reload), VC-059 (a six-minute untouched run), VC-063 (deploy a
  second build and watch for the update notice) and VC-021's greyscale check
  that the `[stderr] ` prefix survives without colour, plus spec-06 VC-624 in
  the institution's real Respondus student exam flow.

## Node.js version

[`.nvmrc`](.nvmrc) pins **Node.js 26**. Both workflows activate it with
`node-version-file: .nvmrc`, and locally `nvm use` picks up the same value, so
CI and your machine agree by construction. Bump the file, not the workflows.

## Pull request titles

Pull requests are **squash-merged**, and the squash commit's subject defaults to
the pull request title. That subject is what the release pipeline derives the
version from — so the title is validated by the `pr-title` check before the
merge is allowed.

```
<type>[(<scope>)][!]: <subject>
```

| Type | Bump on merge |
|---|---|
| `feat` | **minor** — `0.1.0` → `0.2.0` |
| `fix`, `perf`, `revert` | **patch** — `0.2.0` → `0.2.1` |
| any type with `!` before the colon, or a `BREAKING CHANGE:` footer in the body | **major** — including from `0.x`, so `0.1.0` → `1.0.0` |
| `chore`, `docs`, `style`, `refactor`, `test`, `build`, `ci` | none — no release is cut |

The scope is optional and must be non-empty if present; the subject must be
non-empty after the `: `. Examples that pass:

```
fix: boot the worker under Vite
feat(editor)!: drop the v1 storage key
chore: bump docs
```

A breaking change bumps major **even below 1.0**. The usual alternative
(breaking → minor while below 1.0) means the version stops carrying breakage
information for the whole pre-1.0 period — exactly when the persisted-state and
worker-protocol contracts are most likely to break.

### Fixing a bad title needs no push

The PR workflow also triggers on `edited`, so correcting the title alone starts
a fresh run and clears the red `pr-title` check. You do not need an empty
commit, and you do not need to re-request a review.

## What CI runs

Seven required checks gate the merge: `pr-title`, `typecheck`, `unit`,
`e2e-chromium`, `audit-contrast`, `audit-perf` and `artifact`. Everything they
run, you can run locally — the commands are identical, with no CI-only
thresholds or tolerances (see *Conventions* below).

**The browser matrix stays local.** CI never runs `npm run test:matrix`. Two of
its eight pinned projects (`edge-141`, `edge-140`) have no launchable engine on
a GitHub Linux runner and would report `skipped`, and a skip is not a pass — so
VC-055 remains a local, manual criterion and CI makes no eight-browser claim.
Run it yourself before a change that touches rendering or engine behaviour.

A passing `e2e-chromium` log reads `94 passed, 1 skipped`. That one skip is
VC-059's six-minute variant, which is out of CI scope; it is the **only**
permitted skip, and a second one is a regression. See
[`docs/ci.md`](docs/ci.md#the-one-skipped-test).

A green run attaches the built site to the pull request as a downloadable
artifact, so a reviewer can try your actual build —
[`docs/ci.md`](docs/ci.md#downloading-a-pr-build) has the commands.

## Conventions

- **TypeScript is strict** and the build type-checks before it bundles
  (`npm run build` runs `tsc --noEmit`). `noUnusedLocals` and
  `verbatimModuleSyntax` are on.
- **Every non-obvious line cites its requirement.** Comments name the FR, BR,
  NFR or VC that forces the behaviour, so a future change knows what it is
  allowed to break.
- **User-visible strings live in `src/format.ts`** and are quoted verbatim from
  the spec. Change the spec first.
- **Never use the `disabled` attribute on a conditionally-inert control.** Use
  `setInert()` from `src/controls.ts` — see
  [`docs/architecture.md` → *Inert controls*](docs/architecture.md#inert-controls-fr-049-vs-fr-054--fr-058).
- **Docs are part of the change.** If you touch the worker protocol, the stdin
  channel or the deployment shape, update `docs/architecture.md` or
  `docs/deployment.md` in the same commit; if you touch a workflow, update
  `docs/ci.md`.
- **Never relax a threshold to make a red gate green.** A threshold that moves
  to match the hardware measures the hardware instead of the product, so the
  first answer to a red audit is a real performance fix, and the second is a
  faster runner. Two numbers have been moved anyway, deliberately and once:
  NFR-003's warm-ready gate (2.5 s → 5.0 s) and NFR-404's switch budget
  (100 ms → 250 ms paint / 500 ms main-thread task), because they were failing
  on `main` with nothing in the boot or layout path changed — they had stopped
  measuring the product and started measuring a GitHub runner's spare CPU.
  Both moves are recorded where the number lives (`specs/01-…-frozen.md`,
  `specs/04-…-frozen.md`), keep the reference-profile expectation intact
  alongside, cite the runs behind them, and leave the measurement printed next
  to the threshold. Nothing else about the rule changed: a threshold moves in
  its own commit, with the numbers that justify it, never as part of getting a
  branch green. Adding a CI-only tolerance or skipping an assertion is still
  not the way to do it.
