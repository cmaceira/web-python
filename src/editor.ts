import { Compartment, EditorState, Prec, type Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  type DecorationSet,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { acceptCompletion, autocompletion } from '@codemirror/autocomplete';
import {
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from '@codemirror/language';
import { python } from '@codemirror/lang-python';
import { tags as t } from '@lezer/highlight';
import { diagnosticMarkers } from './lint/markers';
import { pythonNameCompletionSource } from './completion';
import { sanitizePythonPaste, type PasteRange } from './paste';

/**
 * Syntax highlighting mapped to stable class names so the palette lives in CSS
 * (light/dark tokens) and the highlighting is assertable from tests (FR-001).
 */
const pyHighlight = HighlightStyle.define([
  { tag: t.keyword, class: 'tok-keyword' },
  { tag: t.controlKeyword, class: 'tok-keyword' },
  { tag: t.definitionKeyword, class: 'tok-keyword' },
  { tag: t.operatorKeyword, class: 'tok-keyword' },
  { tag: t.moduleKeyword, class: 'tok-keyword' },
  { tag: t.string, class: 'tok-string' },
  { tag: t.special(t.string), class: 'tok-string' },
  { tag: t.comment, class: 'tok-comment' },
  { tag: t.number, class: 'tok-number' },
  { tag: t.bool, class: 'tok-atom' },
  { tag: t.null, class: 'tok-atom' },
  { tag: t.definition(t.variableName), class: 'tok-def' },
  { tag: t.function(t.variableName), class: 'tok-def' },
  { tag: t.propertyName, class: 'tok-property' },
  { tag: t.operator, class: 'tok-operator' },
  { tag: t.punctuation, class: 'tok-punct' },
]);

/** Drive CodeMirror's dark-theme facet from the effective palette (BR-503). */
const colorScheme = new Compartment();
const editability = new Compartment();

function colorSchemeExtensions(effective: 'light' | 'dark'): Extension[] {
  return effective === 'dark' ? [EditorView.darkTheme.of(true)] : [];
}

function editabilityExtensions(readOnly: boolean): Extension[] {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
}

const indentationSpace = Decoration.mark({ class: 'cm-highlightIndent' });

function indentationDecorations(view: EditorView): DecorationSet {
  const ranges = [];
  for (const { from, to } of view.visibleRanges) {
    let line = view.state.doc.lineAt(from);
    while (line.from <= to) {
      const indentation = /^[ \t]+/.exec(line.text)?.[0];
      if (indentation) {
        for (let offset = 0; offset < indentation.length; offset += 1) {
          ranges.push(indentationSpace.range(line.from + offset, line.from + offset + 1));
        }
      }
      if (line.to >= to) break;
      line = view.state.doc.line(line.number + 1);
    }
  }
  return Decoration.set(ranges, true);
}

/** Issue #31: show only indentation, never ordinary spaces inside Python code. */
const highlightIndentation = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = indentationDecorations(view);
    }

    update(update: { docChanged: boolean; viewportChanged: boolean; view: EditorView }): void {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = indentationDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

export interface EditorOptions {
  parent: HTMLElement;
  initialDoc: string;
  onChange: (doc: string) => void;
  /** FR-008: `Ctrl+Enter` / `Cmd+Enter` triggers Run from inside the editor. */
  onRun?: () => void;
  /** FR-009: `Shift+Alt+F` triggers Format from inside the editor. */
  onFormat?: () => void;
  /** Effective palette from the theme module (BR-502 — no matchMedia here). */
  effectiveColorScheme: 'light' | 'dark';
  /** Issue #28: paste cleanup is active only for the current lowercase `.py` file. */
  shouldSanitizePaste?: () => boolean;
}

export function createEditor({
  parent,
  initialDoc,
  onChange,
  onRun,
  onFormat,
  effectiveColorScheme,
  shouldSanitizePaste,
}: EditorOptions): EditorView {
  const extensions: Extension[] = [
    // Ahead of the default keymap, which binds `Mod-Enter` to insertBlankLine.
    Prec.highest(
      keymap.of([
        {
          // FR-606: accept only while CodeMirror has an active completion.
          // Returning false lets the lower-priority indentation binding run.
          key: 'Tab',
          run: acceptCompletion,
        },
        {
          key: 'Mod-Enter',
          preventDefault: true,
          run: () => {
            onRun?.();
            return true;
          },
        },
        {
          // FR-009 / FR-058: the page decides whether Format is available at
          // all, so the binding is always installed and always consumed.
          key: 'Shift-Alt-f',
          preventDefault: true,
          run: () => {
            onFormat?.();
            return true;
          },
        },
      ]),
    ),
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    highlightSpecialChars(),
    highlightIndentation,
    drawSelection(),
    history(),
    indentOnInput(),
    bracketMatching(),
    indentUnit.of('    '),
    syntaxHighlighting(pyHighlight),
    python(),
    // FR-1001 / FR-1003: keep CodeMirror's native paste transaction and add
    // cleanup sequentially inside that same transaction. Undo therefore
    // restores the exact pre-paste document, and every observer sees only the
    // sanitized result.
    EditorState.transactionFilter.of((transaction) => {
      if (!transaction.isUserEvent('input.paste') || !shouldSanitizePaste?.()) {
        return transaction;
      }

      const pastedRanges: PasteRange[] = [];
      transaction.changes.iterChanges((_fromA, _toA, fromB, toB) => {
        if (fromB < toB) pastedRanges.push({ from: fromB, to: toB });
      });
      const edits = sanitizePythonPaste(transaction.newDoc.toString(), pastedRanges);
      return edits.length === 0
        ? transaction
        : [transaction, { changes: edits, sequential: true }];
    }),
    // FR-601 – FR-607: name-only completion is local and independent of the
    // Python/Ruff workers. Tab accepts an open completion before the
    // lower-priority indentation binding handles it.
    autocompletion({
      activateOnTyping: true,
      activateOnTypingDelay: 100,
      selectOnOpen: true,
      interactionDelay: 0,
      override: [pythonNameCompletionSource],
    }),
    // FR-036 / FR-037: diagnostic underlines, gutter icons and tooltips.
    diagnosticMarkers(),
    // Issue #31: CodeMirror's native binding indents and dedents whole lines
    // with `indentUnit`, which is four ASCII spaces above. The default keymap
    // keeps Ctrl+M (Shift+Alt+M on macOS) as the accessible Tab-focus escape.
    keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
    EditorView.lineWrapping,
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onChange(update.state.doc.toString());
    }),
    EditorView.contentAttributes.of({ 'aria-label': 'Python program editor' }),
    colorScheme.of(colorSchemeExtensions(effectiveColorScheme)),
    editability.of(editabilityExtensions(false)),
  ];

  return new EditorView({
    parent,
    state: EditorState.create({ doc: initialDoc, extensions }),
  });
}

/** Reconfigure the editor's dark-theme compartment (BR-502, BR-503). */
export function setEditorColorScheme(
  view: EditorView,
  effective: 'light' | 'dark',
): void {
  view.dispatch({
    effects: colorScheme.reconfigure(colorSchemeExtensions(effective)),
  });
}

/** Replace the whole document as a single undoable edit. */
export function setDoc(view: EditorView, doc: string): void {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: doc },
    selection: { anchor: Math.min(doc.length, view.state.selection.main.anchor) },
  });
}

/** A binary workspace file is visible but deliberately cannot be rewritten as text. */
export function setEditorReadOnly(view: EditorView, readOnly: boolean): void {
  view.dispatch({ effects: editability.reconfigure(editabilityExtensions(readOnly)) });
}

/** FR-007: leave the editor contents selected so the visitor can copy manually. */
export function selectAll(view: EditorView): void {
  view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
  view.focus();
}

/**
 * FR-039: scroll the given 1-based line/column into view and put the caret on
 * it. Used by the diagnostics panel to reveal an entry's source position.
 */
export function revealPosition(view: EditorView, line: number, column: number): void {
  const lineNumber = Math.min(Math.max(1, line), view.state.doc.lines);
  const target = view.state.doc.line(lineNumber);
  const pos = Math.min(target.to, target.from + Math.max(0, column - 1));
  view.dispatch({
    selection: { anchor: pos },
    effects: EditorView.scrollIntoView(pos, { y: 'center' }),
  });
  view.focus();
}
