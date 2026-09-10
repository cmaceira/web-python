# Frozen: Python Editor Tab Indentation

Source: issue #31
Status: SHIPPED (implementation on branch; PR not yet merged at freeze)
Frozen: 2026-09-09
Parent: `specs/01-static-python-web-frozen.md`, `specs/06-offline-completion-frozen.md`
Issue: https://github.com/fclabs/web-python/issues/31

This child spec uses the `11xx` identifier range.

## Purpose

Students write Python with four-space indentation. The editor must provide
that convention with Tab without introducing literal tab characters or taking
away completion acceptance.

## Functional Requirements

**FR-1101 — Four-space Tab indentation (Must)**

With no completion selected, `Tab` indents the current line or every selected
line by one four-space level. `Shift+Tab` removes one indentation level when
possible. Normal editor indentation introduces only ASCII spaces, never a
literal tab character.

**FR-1102 — Preserve editor interactions (Must)**

Indentation and dedentation remain normal CodeMirror edits: selection, Undo,
Redo, autosave, linting, and the active-file editor state keep their existing
behavior.

**FR-1103 — Completion and keyboard navigation (Must)**

An open completion still consumes `Tab` to accept its selected option before
indentation is considered. CodeMirror's built-in Tab-focus mode, toggled with
`Ctrl+M` (`Shift+Alt+M` on macOS), allows Tab and Shift+Tab to move focus out
of the editor.

**FR-1104 — Visible whitespace without layout changes (Must)**

Each leading indentation space in the editor is shown with a faint dot.
Ordinary spaces inside Python expressions, strings, and comments are not
marked. The marker is purely visual: it does not alter editor text, selection,
clipboard contents, line wrapping, editor dimensions, page dimensions, or the
width allocated to the Files, Editor, and Console columns. Indentation that
exceeds the available width remains within CodeMirror's scrollable area.

## Interfaces

No public API, storage key, DOM node, worker message, network request, or
user preference is added. `src/editor.ts` continues to configure CodeMirror's
four-space `indentUnit`; its native `indentWithTab` key binding supplies the
behavior.

## Verification Criteria

| ID | Covers | Criterion |
|---|---|---|
| **VC-1101** | FR-1101 | Tab indents one line with exactly four spaces, Shift+Tab restores it, and neither result contains `\t`. |
| **VC-1102** | FR-1101, FR-1102 | A multi-line selection indents with spaces; Undo, Redo, and Shift+Tab preserve the expected document. |
| **VC-1103** | FR-1103 | Tab accepts an open completion, and Tab-focus mode continues sequential focus navigation from the editor. |
| **VC-1104** | FR-1104 | Whitespace dots are visible after six Tab indents; the source and Files/Editor/Console/page geometry remain unchanged. |

## Deliberately excluded

- A configurable indentation width or a visitor preference.
- Conversion of literal tabs already present in existing files or pasted text.
- Custom keyboard handling, UI controls, notices, or accessibility shortcuts beyond CodeMirror's native Tab-focus mode.
