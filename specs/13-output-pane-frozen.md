# Frozen: Hide and Resize the Output Pane

Source: issue #21
Status: SHIPPED (implementation on branch; PR not yet merged at freeze)
Frozen: 2026-09-15
Parent: `specs/04-toogle-pane-aspect-frozen.md`, `specs/09-minimal-diags-frozen.md`, `specs/01-static-python-web-frozen.md`
Issue: https://github.com/fclabs/web-python/issues/21

This child spec uses the `13xx` identifier range.

## Purpose

Students writing in the playground often want the editor to fill the window —
the same reason the Files pane can be hidden and resized. The console,
standard-input row, and Problems list are one **Output** pane: a single
toolbar toggle hides or shows them together, and in the two-column layout a
separator resizes that column against the editor. Spec-09's diagnostics
separator still splits Console vs Problems *inside* the column. A program that
calls `input()` while Output is hidden reveals only the Input row.

## What it does

- `#btn-output` immediately after `#btn-files` (leading toolbar cluster)
  toggles the Output pane. `aria-expanded` mirrors the hide/show preference,
  not the stdin exception. `aria-controls` lists `console-pane`, `stdin-pane`,
  `diagnostics-pane`.
- Hidden Output sets `hidden` on the console, stdin, and diagnostics panels
  and on both separators. Document order is unchanged. The editor (and Files /
  Symbols if open) takes the freed space. Run still writes the console buffer;
  Clear console and Copy code still work.
- A pending stdin read unhides **only** `.panel--stdin`. Console and Problems
  stay hidden. When the read ends, Input hides again if Output is still
  hidden. Focus inside a re-hidden Input row moves to `#btn-output`.
- Vertical ≥ 900 px: `#output-resizer` overlays the output column's
  inline-start edge (`role="separator"`, vertical, name `Resize output pane`).
  Pointer drag and Arrow keys (16 px; Shift 48 px; ArrowRight grows output)
  resize. No extra grid track — `.app` `gap: 8px` would otherwise shrink both
  columns and break FR-409. Hidden + `setInert()` outside vertical ≥ 900 or
  while Output is hidden.
- Unset width keeps FR-409's 58 % editor column (and the files-open `58fr` /
  `42fr` remainder split). A committed width sets `--output-width` on
  `:root`.
- Clamps: output ≥ 240 px, editor ≥ 320 px; max is the leftover after the
  editor floor, Files, Symbols, and gaps. Viewport/layout-only clamps update
  memory/ARIA, not `localStorage`, until the visitor commits a resize.
- Persist `pyplay.output-visible.v1` (`shown` | `hidden`) and
  `pyplay.output-width.v1` (canonical px). Render-blocking bootstrap applies
  both before first paint. Failed writes still apply in memory; one notice
  per key per load. Non-canonical values are left in place.
- Horizontal / stacked layout: hide/show only. No new height splitter.
  Spec-09's `#diag-resizer` stays vertical-only and is inert while Output is
  hidden.

## Functional Requirements

**FR-1301 — Output toggle (Must)**

`#btn-output` sits immediately after `#btn-files` and before `#btn-symbols`.
Its visible label and accessible name are `Output`. Activating it (pointer,
Enter, Space) hides the Output pane if it is shown and shows it if it is
hidden. `aria-expanded` is `true` iff the preference is shown. The control is
never routed through `setInert()` and is not `disabled`.

**FR-1302 — Hide the three panels together (Must)**

Hiding Output sets `hidden` on `#console-pane`, `#stdin-pane`,
`#diagnostics-pane`, `#diag-resizer`, and `#output-resizer`. Showing Output
clears `hidden` on the three panels and restores the separators according to
FR-1305 / FR-906. No panel is moved, re-parented, cloned, or re-created
(BR-402). Sequential focus skips the hidden panels.

**FR-1303 — Pending stdin reveals Input only (Must)**

While Output is hidden and a stdin read is pending (FR-029), `#stdin-pane` is
not `hidden` and `#app[data-stdin="pending"]` is set. Console and Problems
stay hidden. FR-029's enablement and focus still apply. Hiding Output during
a pending read leaves Input visible. When the read ends (line, EOF, stdout,
stderr, stop, done, or error — every existing `stdinIdle()` path), Input
hides again if Output is still hidden, `data-stdin` is removed, and if focus
is inside `#stdin-pane` it moves to `#btn-output`.

**FR-1304 — Editor takes the freed space (Must)**

With Output hidden, the editor column fills the space the output column (or
the stacked console / stdin / diagnostics bands) occupied. Files and Symbols,
if open, keep their existing tracks. In vertical layout a pending Input row
is a full-width band under the editor (Files / Symbols still span), not a
skinny right column.

**FR-1305 — Vertical column separator (Must)**

At effective `vertical` layout and viewport ≥ 900 px, with Output shown,
`#output-resizer` is sequential-focus reachable: `role="separator"`,
`aria-orientation="vertical"`, `aria-label` = `OUTPUT_RESIZER_LABEL`,
`aria-valuemin` / `aria-valuemax` / `aria-valuenow` in CSS px, `tabindex="0"`.
It overlays the output column's inline-start edge and spans console →
diagnostics. Pointer capture drags the width; ArrowRight grows output,
ArrowLeft shrinks it, by `OUTPUT_WIDTH_STEP` (16) or `OUTPUT_WIDTH_STEP_LARGE`
(48) with Shift. Outside that layout, or while Output is hidden, the control
is `hidden` and `setInert()` — never the HTML `disabled` attribute.

**FR-1306 — Default split is FR-409 (Must)**

With no usable stored width, the vertical editor column remains `58%` of the
app content box (files-open: `58fr` / `42fr` of the remainder after Files).
`--output-width` is unset. VC-410 continues to assert that split when Output
is shown and `pyplay.output-width.v1` is absent.

**FR-1307 — Committed width (Must)**

A committed resize (pointer release, or a keyboard step that changes width)
clamps to FR-1308, sets `--output-width` on `document.documentElement` to
`<integer>px`, and writes the canonical integer string to
`pyplay.output-width.v1`. The editor column becomes `minmax(0, 1fr)` and the
output column `var(--output-width)`. Files and Symbols tracks are unchanged.

**FR-1308 — Width clamps (Must)**

Inclusive bounds: output width ≥ `OUTPUT_WIDTH_MIN` (240 CSS px) and ≤ the
largest integer that still leaves the editor `OUTPUT_EDITOR_MIN` (320 CSS px)
after Files, Symbols, and `.app` gaps. Degenerate viewports (min > max)
resolve to max. A clamp caused only by viewport, layout, Files, or Symbols
changes updates in-memory width and ARIA, and does **not** rewrite storage
until the visitor next commits a resize.

**FR-1309 — Persist visibility (Must)**

A successful toggle writes exactly `shown` or `hidden` to
`localStorage['pyplay.output-visible.v1']` — raw string, no JSON. Reload
restores that preference before first paint (FR-1311). Absent, unreadable, or
non-canonical values yield `shown` for the session and are left in place.

**FR-1310 — Persist width (Must)**

`pyplay.output-width.v1` holds a canonical height-style integer
(`^[1-9][0-9]*$`). Absent, unreadable, or non-canonical → FR-1306; bytes left
in place. A rejected write still applies the in-memory width and shows
`OUTPUT_WIDTH_SAVE_FAILED` at most once per page load. A rejected visibility
write shows `OUTPUT_VISIBLE_SAVE_FAILED` at most once per page load.

**FR-1311 — First paint (Must)**

A render-blocking inline bootstrap in `index.html` reads both keys. Canonical
`hidden` sets `document.documentElement.dataset.output = "hidden"` before any
stylesheet that sizes panels. A canonical width sets `--output-width` and
`data-output-sized` so the restored column does not flash at 58 %. Missing or
non-canonical keys leave those attributes unset.

**FR-1312 — Presentation only (Must)**

Show, hide, and resize mutate visibility, `--output-width`, ARIA, the two
storage keys, and at most the two notices. They never touch the editor
document, caret, undo, `EditorView` identity, console buffer, follow/scroll
policy, worker, `runId`, lint, format, theme, or layout preference. They
schedule no autosave and issue no network request.

**FR-1313 — Toolbar cluster (Must)**

At ≥ 900 px the leading cluster is `#btn-run` … `#btn-output` packed at the
inline-start; the presentation cluster (`#btn-symbols`, `#btn-theme`,
`#btn-about`) stays flush with the inline-end. The oversized flex gap is
between `#btn-output` and `#btn-symbols`. Tab order inserts `#btn-output`
after `#btn-files`. Below 900 px the row packs (and wraps) as today.

## Business Rules

**BR-1301 — One pane, three panels**

Output is Console + Input + Problems as a unit. There is no independent
Console or Problems toggle. Spec-09's `#diag-resizer` continues to split
those two *inside* the column when Output is shown in vertical ≥ 900.

**BR-1302 — Overlay separator, no extra track**

`#output-resizer` must not introduce a grid column. `.app { gap: 8px }`
between three columns would steal 8 px from FR-409's 58 % split.

**BR-1303 — `--output-width` is geometry, not a palette token**

The custom property lives on `document.documentElement` / `:root`, never
inside `[data-theme]` or `[data-effective]` rules (issue #14).

**BR-1304 — Two versioned keys, supersede-don't-migrate**

`pyplay.output-visible.v1` and `pyplay.output-width.v1` only. No JSON, no
cookie, IndexedDB, or `sessionStorage`. Non-canonical values are never
rewritten except by a later successful visitor commit.

**BR-1305 — `setInert()`, never `disabled`**

`#output-resizer` uses `setInert()` from `src/controls.ts`. `#btn-output` is
always activatable.

**BR-1306 — Horizontal height splitters, not a column splitter**

Stacked layout has no editor↔output *column* splitter. It does expose
`#console-resizer` (console height vs editor) and `#diag-resizer` (Problems
height) while Output is shown. Unset heights keep spec-01's flex 30 % /
`25vh` defaults until the visitor commits a resize. Hide/show still applies
at every width, including below 900 px.

**BR-1307 — Diagnostics separator follows Output**

`#diag-resizer` is active only when spec-09's conditions hold **and** Output
is shown (console panel not `hidden`). Measuring a `display: none` column is
not a resize.

**BR-1308 — Parent amendments**

- spec-04 *Deliberately excluded* ("a draggable splitter", "collapsing,
  hiding"): this child owns hide of the output stack and the editor/output
  splitter. FR-409's 58 % remains the **default** when width is unset.
- spec-09 BR-904 / *Deliberately excluded* ("hide/collapse of either panel"):
  hide of the stack moves here; independent collapse of Console vs Problems
  stays out of scope. `#diag-resizer` is inert while Output is hidden.

## Non-Functional Requirements

**NFR-1301 — Bounded application payload**

Against branch point `6ab5936` (Apache-2.0 license; `origin/main` at
implementation), Output adds at most 3 KiB to the gzip-compressed first-party
application payload and adds no precache URL. The measurement excludes the
byte-pinned Pyodide and Ruff vendor assets and is recorded with the same
runner-local compressor as the candidate build. The implementation measured
~2.50 KiB on `linux-x64 zlib 1.3.1-470d3a2`; 3 KiB is the bound that
leaves compressor headroom. A 2 KiB pairing-style bound does not fit a toggle,
two splitters, three storage keys, first-paint bootstrap, and the hidden-output
grid maps (those maps drop tracks rather than zeroing them, because
`.app { gap: 8px }` would otherwise keep a gap around an empty column/row).

This spec amends NFR-1201: its 2 KiB measurement remains the immutable ship
measurement for spec-12, but VC-1206 no longer charges every later whole-app
feature to the pairing branch point. Output carries the independently anchored
NFR-1301 budget instead.

**NFR-1302 — Apply latency**

Hide, show, and a committed resize paint in ≤ 50 ms and introduce no
main-thread task longer than 50 ms (500-line program, 5 000 console lines).
Zero network requests.

**NFR-1303 — Hit target and contrast**

`#output-resizer` hit target ≥ 8 CSS px. Resting / hover / focus fill
contrast ≥ 3:1 in both palettes. `#btn-output` text ≥ 4.5:1. Hit area of the
toggle ≥ 32 × 32 px.

**NFR-1304 — Narrow viewport**

At 375 × 667, with Output shown or hidden, `scrollWidth` ≤ 375 px; toolbar,
status, editor, and (when shown) console / stdin / diagnostics unclipped;
`#btn-output` hit area ≥ 32 × 32 px.

## Public interfaces / data

### Persisted state

| Store | Key | Contents | On read failure |
|---|---|---|---|
| `localStorage` | `pyplay.output-visible.v1` | Exactly `shown` or `hidden` — raw string. | Treat as absent → shown (FR-1309). Non-canonical left in place. |
| `localStorage` | `pyplay.output-width.v1` | Canonical integer CSS px: `^[1-9][0-9]*$`. | Treat as absent → FR-1306. Non-canonical left in place. |

### Constants

| Constant | Value | Used by |
|---|---|---|
| `OUTPUT_VISIBLE_KEY` | `pyplay.output-visible.v1` | FR-1309, FR-1311 |
| `OUTPUT_WIDTH_KEY` | `pyplay.output-width.v1` | FR-1307, FR-1310, FR-1311 |
| `OUTPUT_WIDTH_STEP` | `16` (CSS px) | FR-1305 |
| `OUTPUT_WIDTH_STEP_LARGE` | `48` (CSS px) | FR-1305 (`Shift`) |
| `OUTPUT_WIDTH_MIN` | `240` (CSS px) | FR-1308 |
| `OUTPUT_EDITOR_MIN` | `320` (CSS px) | FR-1308 / FR-409 |
| `OUTPUT_GAP` | `8` (CSS px) | FR-1308; mirrors `.app { gap: 8px }` |

### User-visible strings

Live in `src/format.ts`, quoted verbatim:

| Constant | Value |
|---|---|
| `OUTPUT_LABEL` | `Output` |
| `OUTPUT_RESIZER_LABEL` | `Resize output pane` |
| `OUTPUT_VISIBLE_SAVE_FAILED` | `Output layout won't be remembered` |
| `OUTPUT_WIDTH_SAVE_FAILED` | `Output width won't be remembered` |

### DOM contract

| Element | Id | Contract |
|---|---|---|
| Output toggle | `btn-output` | Immediately after `#btn-files`. `aria-expanded`, `aria-controls="console-pane stdin-pane diagnostics-pane"`. Label `OUTPUT_LABEL`. |
| Console panel | `console-pane` | Existing `.panel--console`; id added. Inner `#console` unchanged. |
| Stdin panel | `stdin-pane` | Existing `.panel--stdin`; id added. |
| Diagnostics panel | `diagnostics-pane` | Existing `.panel--diagnostics`; id added. |
| Output resizer | `output-resizer` | Non-panel sibling immediately after the editor `<section>` and before `#diag-resizer`. Overlay; not a grid track. |
| App root | `app` | `data-stdin="pending"` only while FR-1303 applies. Layout attribute unchanged. |
| Document element | — | `data-output="hidden"` while preference is hidden; `data-output-sized` while a definite `--output-width` is applied. |

### Modules

- `src/output-pane.ts` owns load / save / clamp (unit-testable without a DOM)
  and `mountOutputPane`. Mirror `#diag-resizer` / `#file-resizer` pointer and
  keyboard patterns without importing `file-pane.ts`.
- `src/diag-resize.ts` `isActive()` additionally requires the console panel
  not `hidden` (BR-1307).
- Bootstrap in `index.html` next to the diagnostics-height script.

## Verification Criteria

| ID | Covers | Criterion |
|---|---|---|
| **VC-1301** | FR-1301, FR-1313 | `#btn-output` is after Files and before Symbols; label `Output`; Tab order … Files → Output → Symbols …; ≥ 900 px the oversized toolbar gap is Output→Symbols. |
| **VC-1302** | FR-1302, FR-1304 | Toggling hides console, stdin, diagnostics, and both separators; editor grows; toggling again restores them. Files and Symbols stay independently open or closed. |
| **VC-1303** | FR-1303 | Hidden Output + `input()` shows only Input (and Send EOF); after a line is submitted Input hides again; hiding Output during a pending read keeps Input. |
| **VC-1304** | FR-1305, FR-1308 | In vertical ≥ 900 with Output shown, ArrowRight grows `aria-valuenow` by 16 (Shift 48); ArrowLeft shrinks; values stay inside min/max; pointer drag changes width. |
| **VC-1305** | FR-1305, BR-1305, BR-1306 | Horizontal layout and viewports &lt; 900 px: `#output-resizer` is hidden and `aria-disabled`; hide/show still works; no `disabled` attribute. |
| **VC-1306** | FR-1306, FR-1307 | No width key + Output shown → editor column is 58 % at 1280/1024/900 (files closed). After a committed resize, `--output-width` matches `aria-valuenow` and storage. |
| **VC-1307** | FR-1309, FR-1311 | `hidden` in storage → first paint has no visible console column; reload restores hidden. `shown` / absent / junk → shown; junk left in place. |
| **VC-1308** | FR-1310, FR-1308 | Canonical width restores (clamped); `0` / `036` / `12.5` / missing → 58 % default; junk left in place. Viewport clamp does not rewrite storage. |
| **VC-1309** | FR-1310 | Rejected `setItem` on either key still applies the in-memory change and shows that key's notice once. |
| **VC-1310** | FR-1312 | Hide, show, and resize do not change editor text, console buffer (except by Run/Clear), layout preference, or theme; Run/Clear while hidden still update the buffer, visible after show. |
| **VC-1311** | BR-1303 | Cycling color mode leaves `--output-width` and the column width unchanged. |
| **VC-1312** | FR-1305, BR-1302 | Default vertical geometry (no stored width) still satisfies VC-410's 58 % and ≥ 320 px floors; the resizer is not a grid track. |
| **VC-1313** | NFR-1303, NFR-1304 | Resizer ≥ 8 px; toggle ≥ 32 × 32; 375 × 667 `scrollWidth` ≤ 375 with Output shown and hidden. Contrast via VC-071 samples. |
| **VC-1314** | NFR-1301, NFR-1302 | ≤ 3 KiB gzip vs `6ab5936`; precache URL count unchanged; hide/resize paint and long-task ≤ 50 ms; zero new requests. |

## Deliberately excluded

- Independent Console vs Problems toggles or collapsing `#diag-resizer` in
  stacked layout (still spec-09 BR-904).
- A horizontal console-height splitter.
- Wrapping the three panels in a parent (would re-parent the editor).
- Changing the stdin channel, worker protocol, lint, or document order.
- A shared splitter helper with Files.
