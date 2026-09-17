# Frozen: Editor Auto-Closing Brackets and Quotes

Source: issue #32
Status: SHIPPED (implementation on branch; PR not yet merged at freeze)
Frozen: 2026-09-10
Parent: `specs/01-static-python-web-frozen.md`
Issue: https://github.com/fclabs/web-python/issues/32

This child spec uses the `12xx` identifier range.

## Purpose

Typing Python in the playground should pair brackets, braces, parentheses, and
quotes the way a desktop editor does, without custom keyboard handling or a
visitor preference.

## Functional Requirements

**FR-1201 — Pair opening delimiters (Must)**

Typing `(`, `[`, `{`, `'`, or `"` in the editor inserts the matching closer
and leaves the caret between the two characters.

**FR-1202 — Skip an already-present closer (Must)**

When the next character is the closer that pairing just inserted, typing that
closer moves the caret past it and does not insert a duplicate.

**FR-1203 — Delete an empty pair (Must)**

With the caret between an empty automatically created pair, Backspace removes
both characters.

**FR-1204 — Surround a selection (Must)**

With a non-empty selection, typing `(`, `[`, `{`, `'`, or `"` wraps the
selected text in that pair and leaves the original text selected between the
new delimiters.

**FR-1205 — Nested pairs and history (Must)**

Pairing remains a normal CodeMirror edit: nested pairs compose, and Undo/Redo
restore the expected document. Selection, autosave, linting, and the rest of
the editor keyboard map keep their existing behavior.

## Business Rules

**BR-1201 — Native CodeMirror pairing only**

Pairing, skip-over, empty-pair deletion, and surround-selection come from
CodeMirror's `closeBrackets` extension and `closeBracketsKeymap`, configured
by `@codemirror/lang-python`. The playground adds no custom input handler or
key binding for these characters.

**BR-1202 — No new state or UI**

The feature adds no DOM node, user-visible string, preference, storage key,
worker message, or network request.

## Non-Functional Requirements

**NFR-1201 — Bounded application payload**

Against branch point `44f9afa` (`v0.8.0`), auto-closing brackets adds at most
2 KiB to the gzip-compressed first-party application payload and adds no
precache URL. The measurement excludes the byte-pinned Pyodide and Ruff vendor
assets and is recorded with the same runner-local compressor as the candidate
build.

This spec amends NFR-1001: its 1 KiB measurement remains the immutable ship
measurement for spec-10, but VC-1011 no longer charges every later whole-app
feature to the paste branch point. Pairing carries the independently anchored
NFR-1201 budget instead.

**Amendment (spec-13, 2026-09-15):** NFR-1201's ≤ 2 KiB ship measurement vs
`44f9afa` (`v0.8.0`) is immutable; VC-1206 no longer subtracts later whole-app
builds from that baseline. Output carries the independently anchored NFR-1301
budget instead.

## Interfaces

No public API, storage key, DOM node, worker message, network request, or
user preference is added. `src/editor.ts` enables `closeBrackets()` and places
`closeBracketsKeymap` ahead of the default keymap so Backspace can delete an
empty pair.

## Verification Criteria

| ID | Covers | Criterion |
|---|---|---|
| **VC-1201** | FR-1201 | Typing each of `(`, `[`, `{`, `'`, and `"` on an empty line produces the matching pair with the caret between the two characters. |
| **VC-1202** | FR-1202 | After `print(` auto-inserts `)`, typing `)` yields `print()` with the caret after the closer, not `print())`. |
| **VC-1203** | FR-1203 | After typing `(`, Backspace restores the empty document. |
| **VC-1204** | FR-1204 | Selecting `value` and typing `(` yields `(value)` with `value` still selected. |
| **VC-1205** | FR-1205 | Typing `(` then `[` yields `([])`; Undo restores `()` then the empty document; Redo restores each step. |
| **VC-1206** | NFR-1201 | The runner-local build is at most 2 KiB gzip above `44f9afa` and keeps the precache URL count unchanged. |

## Deliberately excluded

- A visitor preference or toolbar control to disable pairing.
- Pairing in the stdin field, notices, or any surface that is not the Python editor.
- Custom rules beyond CodeMirror's Python language data (string prefixes, triple quotes).
- Smart quotes or non-ASCII delimiters.
