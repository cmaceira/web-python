/**
 * The Format action (FR-043 – FR-045, FR-059, BR-007).
 *
 * The reformat is one transaction, isolated in the history, so a single undo
 * reverts it in full (FR-044). The caller keeps Format inert while a program
 * is running so execution and editor state cannot race (issue #41).
 */
import { isolateHistory } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import { mapCaretAcrossFormat } from './caret';
import type { RuffEngine } from './ruff';

/** FR-045 */
export const CANNOT_FORMAT = "Can't format — fix the syntax error first.";

export type FormatOutcome = 'formatted' | 'unchanged' | 'syntax-error';

/**
 * Reformat the buffer in place. Returns `syntax-error` — leaving the document
 * byte-for-byte untouched — when the program does not parse (FR-045), and
 * `unchanged` when the buffer was already formatted (BR-007).
 */
export function formatDocument(view: EditorView, engine: RuffEngine): FormatOutcome {
  const before = view.state.doc.toString();

  let after: string;
  try {
    after = engine.format(before);
  } catch {
    return 'syntax-error';
  }

  // FR-059: the caret follows its statement to wherever the reformat put it.
  const caret = mapCaretAcrossFormat(before, after, view.state.selection.main.head);

  if (after === before) {
    // BR-007: nothing to write. FR-059 still applies, so only the caret moves.
    view.dispatch({ selection: { anchor: Math.max(0, Math.min(caret, after.length)) } });
    return 'unchanged';
  }

  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: after },
    selection: { anchor: Math.max(0, Math.min(caret, after.length)) },
    // FR-044: one undoable edit, never merged with the typing before it.
    annotations: isolateHistory.of('full'),
    scrollIntoView: true,
  });

  return 'formatted';
}
