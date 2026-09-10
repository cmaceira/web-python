# Frozen: Python Paste Sanitisation

Source: issue #28 decisions (v1.0.0)
Status: SHIPPED (implementation on branch; PR not yet merged at freeze)
Frozen: 2026-09-08
Parent: `specs/01-static-python-web-frozen.md`
Issue: https://github.com/fclabs/web-python/issues/28

This child spec uses the `10xx` identifier range.

## Purpose

Code copied from Blackboard, PDFs, slide decks, and chat clients can contain
invisible Unicode formatting characters or typographic lookalikes that make an
otherwise readable Python program fail. Clean those characters as part of a
paste into a Python file, without changing intentional string/comment content
or adding another classroom-facing control or message.

## Functional Requirements

**FR-1001 — Sanitize Python paste (Must)**
Given an editable active file whose name ends in lowercase `.py`, when the
visitor pastes into the CodeMirror editor, only characters inside the inserted
ranges are transformed according to this table before editor observers see the
result:

| Input | Result |
|---|---|
| Any Unicode `Space_Separator` (`General_Category=Zs`) | One ASCII space U+0020 |
| Any Unicode `Format` character (`General_Category=Cf`) | Removed |
| U+2018 / U+2019 | ASCII apostrophe `'` |
| U+201C / U+201D | ASCII quotation mark `"` |
| U+2013 / U+2014 | ASCII hyphen-minus `-` |
| U+2028 / U+2029 | LF U+000A |
| CRLF or lone CR | LF, through CodeMirror's existing text construction |

ASCII spaces and tabs are unchanged; a trailing Unicode hard space is mapped
to one ASCII space rather than trimmed.

**FR-1002 — Preserve Python text payloads (Must)**
Except for CodeMirror's existing CRLF/lone-CR normalization, characters in
ordinary, prefixed, triple-quoted, and formatted-string literal text, and in
comments, are byte-for-byte preserved. Smart quotes used as delimiters in code
are repaired first so their newly delimited payload is also protected.
Formatted-string replacement expressions are code and are cleaned; nested
strings/comments inside a replacement are protected.

**FR-1003 — One native paste transaction (Must)**
The native CodeMirror paste and all cleanup compose into one `input.paste`
transaction. One Undo restores the document, selection, and history state from
immediately before the paste; Redo restores the cleaned result. Raw pasted
characters are never rendered, autosaved, linted, formatted, or executed.

**FR-1004 — Silent operation (Must)**
Sanitization shows no notice, status text, dialog, diagnostic, or other
feedback. A paste requiring no transformations is byte-for-byte unchanged.

## Business Rules

**BR-1001 — Paste and Python files only**
Only editor transactions identified as `input.paste` while the active file
ends in lowercase `.py` are sanitized. Existing/restored content, typing,
completion, drag/drop, Format, stdin, binary files, and every non-`.py` text
file are unchanged.

**BR-1002 — Syntax-aware, deterministic, local**
Protection is derived locally from the shipped CodeMirror Python parser with a
two-pass parse; no Ruff/runtime dependency or network request is introduced.
No broad Unicode normalization such as NFC/NFKC is applied.

**BR-1003 — No new state or UI**
The feature adds no DOM node, user-visible string, preference, storage key,
worker message, or clipboard write.

## Non-Functional Requirements

**NFR-1001 — Bounded application payload**
Against branch point `2eb0bd4` (`v0.6.0`), paste sanitisation adds at most
1 KiB to the gzip-compressed first-party application payload and adds no
precache URL. The measurement excludes the byte-pinned Pyodide and Ruff vendor
assets and is recorded with the same runner-local compressor as the candidate
build.

This spec amends NFR-904: its 2 KiB measurement remains the immutable ship
measurement for spec-09, but VC-912 no longer charges every later whole-app
feature to the diagnostics branch point. Its hit-target and latency assertions
remain live. Paste sanitisation carries the independently anchored NFR-1001
budget instead.

**Amendment (spec-12, 2026-09-10):** NFR-1001's ≤ 1 KiB ship measurement vs
`2eb0bd4` (`v0.6.0`) is immutable; VC-1011 no longer subtracts later whole-app
builds from that baseline. Pairing carries the independently anchored NFR-1201
budget instead.

## Interfaces

- `sanitizePythonPaste(document, pastedRanges)` is a deterministic helper that
  returns non-overlapping editor changes in post-paste document coordinates.
- `EditorOptions.shouldSanitizePaste()` supplies the active-file gate without
  coupling the editor module to the workspace.
- Existing workspace, worker, lint, format, notices, stdin, and clipboard-output
  interfaces are unchanged.

## Verification Criteria

| ID | Covers | Criterion |
|---|---|---|
| **VC-1001** | FR-1001 | Unit coverage maps every listed category and lookalike. |
| **VC-1002** | FR-1002 | Ordinary/triple strings and comments retain suspicious characters. |
| **VC-1003** | FR-1002 | Smart delimiters are repaired while their payload is retained. |
| **VC-1004** | FR-1002 | F-string literal text is retained and replacement code is cleaned. |
| **VC-1005** | BR-1001 | Suspicious characters outside inserted ranges remain unchanged. |
| **VC-1006** | FR-1001 | The issue's exam sample loses exactly its four embedded U+FEFF characters. |
| **VC-1007** | FR-1003 | One Undo removes the cleaned paste and one Redo restores it. |
| **VC-1008** | BR-1001 | Disabled gating and non-paste edits remain byte-exact. |
| **VC-1009** | FR-1001, FR-1003, FR-1004 | A real contaminated clipboard paste is cleaned, silent, persisted, undoable, and executable. |
| **VC-1010** | BR-1001 | The same real paste into a `.txt` file remains byte-exact. |
| **VC-1011** | NFR-1001 | The runner-local build is at most 1 KiB gzip above `2eb0bd4` and keeps the precache URL count unchanged. |

## Deliberately Excluded

- A manual cleanup command or paste-and-format command.
- Diagnostics/highlights for suspicious characters already in the buffer.
- Cleanup of stdin, drag/drop, non-Python files, string/comment payloads, or the
  clipboard itself.
- Any cleanup notice; the issue's proposed feedback was explicitly rejected for
  this classroom workflow.
