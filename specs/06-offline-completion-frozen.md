# Frozen: Offline Python Name Completion

Source: `specs/06-offline-completion.md` (v1.0.0)
Status: SHIPPED (automated VCs); institutional VC-624 LockDown Browser sign-off still pending
Frozen: 2026-09-05
PR / commit: https://github.com/fclabs/web-python/pull/20 (`e569b81`); follow-up `1e9d7ed`
Parent: `specs/01-static-python-web-frozen.md`

## Purpose

Completion helps students discover and finish names without a server, account,
language server, or running Python interpreter. It is syntactic only: names
defined in the current file, Python built-ins, and Python 3.13 hard and soft
keywords. Imports/modules, member completion after `.`, signatures, type
inference, hover documentation, and snippets are deliberately excluded.

The maintained CodeMirror autocomplete UI supplies the listbox, selection, and
keyboard behavior. The source is compiled into the existing main bundle and is
always enabled. It neither reads from nor writes to the Pyodide/Ruff workers.

## What it does

- Offers current-scope names (incl. Unicode), built-ins, and every CPython 3.13 hard/soft keyword; local names win label collisions; accept inserts exactly the label (no snippet/docs/hover).
- Auto-opens 100 ms after an identifier prefix and on `Ctrl+Space` (incl. blank line) with best match selected; arrows/page navigate; Enter/Tab/pointer accept; Escape dismisses; Tab without popup stays page traversal (never indents).
- Suppressed in comments, strings, f-strings (incl. `{…}`), and after `.`; acceptance is one undoable editor transaction observed by autosave/lint.
- Always on, fully local (no network/worker/storage/API); usable during Python/Ruff load/fail and offline. While a program runs, issue #41's editor lock suppresses editing and completion until the run finishes or is stopped. Run keeps its activation-time workspace snapshot. Active file + fixed globals only; `@codemirror/autocomplete` 6.20.x stays in the main bundle.

## Public interfaces / data

### Python 3.13 keyword data

Hard keywords: `False`, `None`, `True`, `and`, `as`, `assert`, `async`,
`await`, `break`, `class`, `continue`, `def`, `del`, `elif`, `else`, `except`,
`finally`, `for`, `from`, `global`, `if`, `import`, `in`, `is`, `lambda`,
`nonlocal`, `not`, `or`, `pass`, `raise`, `return`, `try`, `while`, `with`,
`yield`.

Soft keywords: `_`, `case`, `match`, `type`.

The normative source is [CPython 3.13 `Lib/keyword.py`](https://github.com/python/cpython/blob/3.13/Lib/keyword.py).

## Key decisions

- Single-file syntactic completion outside Pyodide/Ruff workers — offline and zero new protocol surface.
- Always enabled, no preference key — avoids a fourth `localStorage` entry.
- Reuse CodeMirror autocomplete in the existing main bundle at locked 6.20.x — listbox/ARIA without a new asset URL.
- **Execution-lock amendment (issue #41):** the shipped “usable while running” behavior is superseded. Preventing a completed execution from restoring an older editor snapshot takes precedence; Stop remains available throughout the lock.

## Known limits (still true at freeze)

- 375×667: no horizontal overflow; list scrolls. Contrast: text ≥ 4.5:1; border/selected fill ≥ 3:1.
- 500-line auto-complete: paint ≤ 200 ms; no main-thread task > 100 ms. Zero completion requests; cold load ≤ 15 MB; no new asset URL.
- **NFR-606 size (amended by spec-09)**: the **7.51 KiB ≤ 9 KB** ship measurement vs `3efb8be` is immutable; VC-623 no longer subtracts every future whole-app build from that baseline. It retains the live latency, long-task, and zero-request checks. Later features carry their own anchored budgets (NFR-805, NFR-904).
- One `listbox` with `option` children and exactly one initially selected option.
- Cross-file semantic completion needs a future analysis-worker spec. VC-624 (real LockDown Browser exam smoke on every student platform) remains institutional sign-off.

## Deliberately excluded

- Imports/modules, `.` members, signatures, type inference, hover, snippets, toggles, and any completion network/worker path.
