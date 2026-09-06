# Frozen: Minimal Diagnostics Under Input (Vertical Layout)

Source: `specs/09-minimal-diags.md` (v1.0.0)
Status: SHIPPED (implementation on branch; PR not yet merged at freeze)
Frozen: 2026-09-05
PR / commit: https://github.com/fclabs/web-python/pull/27
Parent: `specs/04-toogle-pane-aspect-frozen.md`, `specs/01-static-python-web-frozen.md`
Issue: https://github.com/fclabs/web-python/issues/25

## Purpose

In the two-column (`vertical`) layout the right column stacks console → stdin →
diagnostics. Today the diagnostics track takes a large share of free space
(`minmax(0, 0.66fr)` ≈ 40 % of the right column), so the Problems panel crowds
the console even when there are few or no findings. This spec makes that panel
**content-sized by default** — the same natural empty height as the stacked
(`horizontal`) layout — and lets the visitor **resize** the console /
diagnostics split with a pointer- and keyboard-accessible separator between the
console and the Input row. Students who care about program output keep the
console room; those who need the Problems list can enlarge it. The preference
is remembered on the origin.

## What it does

- Fresh vertical load (≥ 900 px, no usable stored height): diagnostics matches the stacked layout's natural empty height (Problems title + live count + empty/body line + padding); findings do not inflate that floor — the list scrolls inside it (BR-901). Console is the flexible track (`minmax(80px, 1fr)`), ≥ 80 px; diagnostics is not an `fr` share.
- `#diag-resizer` between console and stdin: `role="separator"`, horizontal, name `Resize diagnostics panel`, `aria-valuemin`/`max`/`now` in CSS px, sequential-focus reachable. Pointer drag and Arrow keys (16 px; Shift 48 px; Up grows diagnostics) resize; stdin stays content-sized; console takes remaining free space (BR-902).
- Clamps: content-derived empty-panel minimum ↔ lesser of 40 % right-column height or console 80 px floor. Viewport/layout-only clamps update memory/ARIA, not `localStorage`, until the visitor commits a resize.
- Outside vertical ≥ 900 px: resizer hidden + `setInert()` (never `disabled`); stacked diagnostics keep `max-height: 25vh` (BR-904, BR-905).
- Persist under `pyplay.diagnostics-height.v1` as canonical `^[1-9][0-9]*$`; restore clamps on first paint via inline bootstrap; absent/invalid → minimum; non-canonical left in place (BR-903). Persist failure: in-memory height still applies; notice once per load (BR-906).
- Document order unchanged (console → editor → stdin → diagnostics); resizer is a non-panel sibling after editor, before stdin. Resize does not touch editor, console, worker, stdin, lint, layout, or theme.

## Public interfaces / data

### Persisted state

Adds exactly one row to the playground's origin store:

| Store | Key | Contents | On read failure |
|---|---|---|---|
| `localStorage` | `pyplay.diagnostics-height.v1` | Canonical height string (FR-911): `^[1-9][0-9]*$`, CSS px of the diagnostics panel (e.g. `36`). No JSON, no units, no whitespace. | Treat as absent → FR-901 minimum. Non-canonical values treated as absent and left in place (FR-911). |

Still no cookies, no IndexedDB, no `sessionStorage` for this feature (BR-903).

Existing keys (`pyplay.program.v1`, `pyplay.layout.v2`, `pyplay.theme.v1`) are
untouched.

### Constants

| Constant | Value | Used by |
|---|---|---|
| `DIAG_HEIGHT_KEY` | `pyplay.diagnostics-height.v1` | FR-909 – FR-911 |
| `DIAG_HEIGHT_STEP` | `16` (CSS px) | FR-905 |
| `DIAG_HEIGHT_STEP_LARGE` | `48` (CSS px) | FR-905 (`Shift`) |
| `DIAG_HEIGHT_MAX_RATIO` | `0.40` of right-column height | FR-908 (same cap as FR-409) |
| `DIAG_CONSOLE_MIN` | `80` (CSS px) | FR-908 (same floor as FR-409) |

The content minimum (FR-901 / FR-907) is **content-derived** at runtime from
the Problems title row, its margin, one empty/body line, and
`.panel--diagnostics` padding — not a hard-coded pixel constant — so it stays
aligned with the stacked layout's natural empty height under font inflation.

### User-visible strings

Live in `src/format.ts`, quoted verbatim:

| Constant | Value |
|---|---|
| `DIAG_RESIZER_LABEL` | `Resize diagnostics panel` (FR-903) |
| `DIAG_HEIGHT_SAVE_FAILED` | `Diagnostics height won't be remembered` (FR-912) |

### DOM contract

| Element | Id | Contract |
|---|---|---|
| Diagnostics resizer | `diag-resizer` | Non-panel sibling **immediately after** the editor `<section>` and **before** the stdin `<section>`. `role="separator"`, `aria-orientation="horizontal"`, `aria-label` = `DIAG_RESIZER_LABEL`, `aria-valuemin` / `aria-valuemax` / `aria-valuenow` in CSS px, `tabindex="0"` when available. Hidden + `setInert()` when FR-906 applies. |
| Diagnostics panel | existing `.panel--diagnostics` | Unchanged markup and ARIA label; height driven by a CSS custom property (e.g. `--diagnostics-height`) when vertical layout is effective. |
| App root | `app` (existing) | No new `data-*` for this feature; layout attribute semantics unchanged. |
| Notice strip | `notices` (existing) | Reused for FR-912. |

Grid: under `#app[data-layout='vertical']` the right column gains a separator
track between console and stdin. Every vertical `grid-template-areas` variant
(plain, symbols open, files open, both open) includes that track; the separator
is never placed inside the editor, files, or symbols columns. Document order of
the four panels does not change (FR-913).

### Modules

- A dedicated helper (e.g. `src/diag-resize.ts`) owns load / save / clamp of the
  height, unit-testable without a DOM, reusing `StorageLike` /
  `getLocalStorage()` from `src/storage.ts`.
- Pointer and keyboard wiring may live beside that helper or in `src/main.ts`;
  mirror the `#file-resizer` patterns in `src/file-pane.ts` (capture, arrows,
  shift step) without coupling to the files pane.
- **First paint (FR-910):** a render-blocking inline bootstrap in `index.html`
  (theme precedent) reads `pyplay.diagnostics-height.v1` and, when the value is
  canonical, sets the diagnostics height custom property before CSS paint.
  When the key is absent or non-canonical, CSS alone defaults the vertical
  diagnostics track to the content-sized empty minimum — never to an `fr` share.

### Reused interfaces

- `setInert` / `isInert` from `src/controls.ts`
- `Notices.show` from `src/notices.ts`
- `StorageLike` / `getLocalStorage` from `src/storage.ts`
- No change to `src/protocol.ts`, the worker, stdin channel, lint engine, or
  layout resolver semantics (`resolveLayout` unchanged)

### Docs

`docs/architecture.md` records the new key, the separator's role, and that the
vertical diagnostics default matches the stacked empty-panel height rather than
a `0.66fr` track.

## Key decisions

- **Content-sized default matching horizontal empty** — empty line visible; findings scroll inside the floor without inflating it (BR-901).
- **Separator under Input controls diagnostics height only** — stdin `auto`; console takes free space (BR-902).
- **One versioned key, supersede-don't-migrate** — `pyplay.diagnostics-height.v1` only (BR-903).
- **Horizontal layout out of scope** — keeps `25vh`; hide/collapse is issue #21 (BR-904).
- **`setInert()`, never `disabled`** (BR-905); persist failure degrades only this preference (BR-906).
- **Bounds reuse FR-409** — 40 % right-column max, 80 px console floor; min is content-derived from the empty panel.

## Known limits (still true at freeze)

- Hit target ≥ 8 CSS px; separator contrast ≥ 3:1 both palettes; no new text &lt; 4.5:1 (NFR-901/902).
- Apply-height ≤ 50 ms paint / ≤ 50 ms longest task; ≤ 2 KB gzipped payload delta vs merge-base `562cb27` (About on `main`); no resize network (NFR-903/904).
- Spec-06 amendment: NFR-606's ≤ 9 KB ship measurement vs `3efb8be` is historical; VC-623 keeps latency / long-task / zero-request only.
- VC-409 / VC-435 stay green; diagnostics ≤ 40 % after resize (NFR-905); same browser matrix as NFR-406 (NFR-906).
- Four-panel document order and editor/right-column width band are untouched.

## Deliberately excluded

- Stdin channel; lint/Problems semantics; hide/collapse of either panel; separator or minimal default in `horizontal` layout.
