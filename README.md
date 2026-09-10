# Python Playground (`pyplay`)

A **static**, backend-free web page where a visitor works in a small local Python
workspace, runs `main.py`, watches `stdout`/`stderr` stream into a console, types input
into the running program, copies the program to the clipboard, picks Python
punctuation out of a special-character pane, forces light or dark chrome (or
follows the system), and gets inline Ruff lint diagnostics plus one-click PEP 8
formatting. The editor also completes local
names, Python built-ins, and Python 3.13 keywords entirely in the browser. When
Python code is pasted, it also removes invisible formatting characters and
repairs common typographic lookalikes outside strings and comments.

Everything runs in the visitor's own browser:

| Concern | How |
|---|---|
| Python | [Pyodide](https://pyodide.org) 0.28.x — CPython 3.13 compiled to WebAssembly — inside a dedicated Web Worker, self-hosted from this site's own origin |
| Editor | CodeMirror 6 with `@codemirror/lang-python`; syntax-aware cleanup of suspicious Unicode characters pasted into `.py` files |
| Completion | Name-only CodeMirror completion from the current file, built-ins, and Python 3.13 hard/soft keywords; no language server or network request |
| Lint + format | `@astral-sh/ruff-wasm-web` 0.14.x, self-hosted, default rule selection |
| Blocking `input()` | A `SharedArrayBuffer` + `Atomics.wait` channel between the page and the worker |
| Offline + isolation | A **single** service worker that both injects COOP/COEP and precaches every asset the Run loop needs |
| Special characters | A dismissible pane of 29 Python-relevant characters that copies one at a time to the clipboard, for keyboards where `[`, `]`, `{`, `}`, `\` and `|` are hard to reach |
| Color mode | A toolbar control that cycles Light → Dark → System; System follows the OS preference sampled once per page load. The choice persists under `pyplay.theme.v1` |
| Build | Vite → a directory of static files (`dist/`) deployable to any static host |

There is **no server** and no cloud sync. The site issues no request to any
origin but its own, and the visitor's workspace is never transmitted anywhere.
It lives in the editor, the Web Worker, and `localStorage` on this origin
(`pyplay.workspace.v1`, plus the `pyplay.theme.v1` color-mode preference). The
workspace starts with `main.py`, permits a small flat set of files (including
importable `.py` modules), accepts Python-created text or binary files, and is
limited to 2 MB for classroom exercises.

- Specification: [`specs/01-static-python-web-frozen.md`](specs/01-static-python-web-frozen.md)
- Special-character pane: [`specs/03-vertical-pane-frozen.md`](specs/03-vertical-pane-frozen.md)
- Layout control: [`specs/04-toogle-pane-aspect-frozen.md`](specs/04-toogle-pane-aspect-frozen.md)
- Color mode: [`specs/05-dark-mode-frozen.md`](specs/05-dark-mode-frozen.md)
- Offline name completion: [`specs/06-offline-completion.md`](specs/06-offline-completion.md)
- Python paste sanitisation: [`specs/10-paste-sanitisation-frozen.md`](specs/10-paste-sanitisation-frozen.md)
- Python Tab indentation: [`specs/11-tab-indentation-frozen.md`](specs/11-tab-indentation-frozen.md)
- Deploying it: [`docs/deployment.md`](docs/deployment.md)
- How it works inside: [`docs/architecture.md`](docs/architecture.md)
- Working on it: [`CONTRIBUTING.md`](CONTRIBUTING.md)
- CI, PR builds and releases: [`docs/ci.md`](docs/ci.md)

---

## Requirements

- Node.js **26.x** (the version in [`.nvmrc`](.nvmrc), which CI reads and
  `nvm use` picks up), and npm.
- A browser with `WebAssembly`, `SharedArrayBuffer`, `Atomics.wait`, Web
  Workers, service workers and the async Clipboard API. The pinned baseline is
  Chrome 141/140, Edge 141/140, Firefox 145/144 and Safari 26.1/26.0.

## Running it locally

```bash
npm ci
npm run dev            # http://localhost:5173
```

`npm run dev` first vendors Pyodide and Ruff out of `node_modules` into
`public/pyodide/` and `public/ruff/` (they are git-ignored, so this step is
required on a fresh clone), then starts Vite.

### The dev server must be cross-origin isolated

Blocking `input()` needs `SharedArrayBuffer`, which browsers only expose to a
**cross-origin isolated** document. `vite.config.ts` therefore sends, on both
the dev server and the preview server:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

If you serve the build with anything else, make sure it sends those two headers
(or registers the shipped service worker at `/` — see
[`docs/deployment.md`](docs/deployment.md)). Without them the page loads, the
editor, Format and Copy code all work, and a permanent banner explains that
Python cannot run there — which is the intended, explicit degradation, not a
bug.

## Building

```bash
npm run build          # vendor assets, type-check, then emit dist/
npm run preview        # serve dist/ with the isolation headers, port 4173
```

`dist/` is the whole deployable site: `index.html`, hashed JS/CSS, the vendored
`pyodide/` and `ruff/` directories, `_headers` (host configuration),
`precache-manifest.json` and `sw.js`. Nothing in it needs a runtime.

The build also prints the precache manifest summary, e.g.

```
precache manifest: build ea81789389d2, 13 URLs -> sw.js
```

## Testing

See [`CONTRIBUTING.md`](CONTRIBUTING.md#running-the-test-suites) for the full
story. The short version:

```bash
npx vitest run         # unit tests (pure logic, jsdom)
npx playwright test    # browser verification criteria against the built dist/
npm run audit:perf     # VC-053 + VC-323/326 + VC-513 performance and size budgets
npm run audit:contrast # VC-051 / VC-071 / VC-514 contrast, System and forced modes
npm run test:matrix    # VC-055 / VC-324 / VC-432 / VC-516, the pinned browser matrix
```

Two environment variables re-run the suites in a different configuration,
which is how the child specs verify that they changed nothing:

```bash
PANE_OPEN=1                   npx playwright test   # spec-03 VC-327
PYPLAY_LAYOUT_PREF=horizontal npx playwright test   # spec-04 VC-433, stacked
PYPLAY_LAYOUT_PREF=vertical   npx playwright test   # spec-04 VC-433, two columns
```

## Continuous integration

Every pull request into `main` runs the suite as a merge gate. Seven required
checks must be green before GitHub will let the pull request merge:

| Check | What it runs |
|---|---|
| `pr-title` | the pull request title against the Conventional Commits grammar |
| `typecheck` | `tsc --noEmit` |
| `unit` | `npm run test:unit` |
| `e2e-chromium` | `npx playwright test --project=chromium` |
| `audit-contrast` | `npm run audit:contrast` |
| `audit-perf` | `npm run audit:perf` |
| `artifact` | `npm run build`, then packs `dist/` |

The pinned browser matrix (`npm run test:matrix`) stays a **local** command: two
of its eight pinned projects have no launchable engine on a Linux runner, and a
skipped test is never reported as a pass.

### Downloading a build from a pull request

A passing run publishes the built site as one workflow artifact named
`pyplay-<version>-pr.<number>+<short-sha>`, kept for 14 days, containing a
single `.tar.gz` that extracts to the contents of `dist/`. Find it under the
pull request's **Checks** → `artifact` → **Artifacts**, or:

```bash
gh run download --name "pyplay-<version>-pr.<number>+<sha>" --dir /tmp/build
```

Serve it with the two isolation headers, or blocking `input()` will not work.

When a browser check fails, that run instead uploads
`playwright-report-pr.<number>` — the Playwright HTML report plus traces — kept
for 7 days.

### Versions and releases

Pull requests are squash-merged, so the **pull request title becomes the commit
subject**, and that subject decides the release:

| Title starts with | Result |
|---|---|
| `feat:` | minor bump |
| `fix:` / `perf:` / `revert:` | patch bump |
| anything with `!` before the colon, or a `BREAKING CHANGE:` footer | major bump, including from `0.x` |
| `chore:` `docs:` `style:` `refactor:` `test:` `build:` `ci:` | no release |

On merge, the release pipeline re-runs the whole gate against `main` and then,
if the bump is not *none*, creates the annotated tag `vX.Y.Z` on that merge
commit and publishes a GitHub Release with generated notes and one asset,
`pyplay-X.Y.Z.tar.gz`. It does not push a version commit to `main` (the branch
ruleset requires a pull request). The version's source of truth is the highest
`vX.Y.Z` git tag, not `package.json`.

No CI job deploys anything — Netlify deploys from its own git integration.

Full detail, including the caches, the fork-PR permission model and the
repository settings that live outside this repository:
[`docs/ci.md`](docs/ci.md).

## Keyboard

| Key | Action |
|---|---|
| `Ctrl`/`Cmd` + `Enter` | Run (from the editor) |
| `Ctrl` + `Space` | Open Python name completion, including on a blank line |
| `↑` / `↓`, `Page Up` / `Page Down` | Navigate an open completion list |
| `Enter` or click/tap | Accept the selected completion |
| `Tab` with completion open | Accept the selected completion |
| `Tab` in the editor | Indent the current or selected lines by four spaces |
| `Shift` + `Tab` in the editor | Remove one four-space indentation level |
| `Ctrl` + `M` (`Shift` + `Alt` + `M` on macOS) | Toggle CodeMirror's Tab-focus mode, then use Tab/Shift+Tab to leave the editor |
| `Escape` | Dismiss completion |
| `Shift` + `Alt` + `F` | Format (from the editor) |
| `Enter` in the input field | Submit a line to the running program |
| `Ctrl` + `D` in the input field | Send EOF |
| `Tab` outside the editor | Move to the next control — including Run, Stop, Clear console, Copy code, Format, Reset, the layout control, Symbols, the editor, the input field, Send EOF and the diagnostics entries |
| `←` `→` `↑` `↓` in the layout control | Select the other layout — and apply it |
| `Home` / `End` in the layout control | Select `Horizontal` / `Vertical` |

`Tab` accepts a selected completion while the list is open. Otherwise it
indents with four ASCII spaces, including every selected line; `Shift` + `Tab`
dedents by one level. No literal tab character is introduced by editor
indentation. Use CodeMirror's Tab-focus mode when keyboard navigation needs to
leave the editor. Leading indentation spaces appear as faint dots inside the
editor.

The **layout control** picks how the panels are divided, and both names
describe **the divider**, the way `vim`'s `:split` and `:vsplit` do:

| | |
|---|---|
| `Horizontal` | the panels are stacked top to bottom, separated by horizontal rules |
| `Vertical` | the editor sits beside the console, separated by a vertical rule |

It is one tab stop, not two: `Tab` lands on whichever option is currently
selected and the arrow keys move between them — the same model the Symbols pane
uses. Your choice is remembered on this browser.

Below a **900 px** window width `Horizontal` is the only layout, and the
control is shown disabled with the reason attached — two columns at phone width
leave neither one wide enough to read code or a traceback in. Your choice is
not discarded: widen the window and `Vertical` comes back without you
re-selecting it.
