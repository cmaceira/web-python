import { redo, undo } from '@codemirror/commands';
import { describe, expect, test } from 'vitest';
import { createEditor } from '../../src/editor';
import { sanitizePythonPaste, type PasteEdit, type PasteRange } from '../../src/paste';

function applyEdits(document: string, edits: readonly PasteEdit[]): string {
  let result = '';
  let position = 0;
  for (const edit of edits) {
    result += document.slice(position, edit.from) + edit.insert;
    position = edit.to;
  }
  return result + document.slice(position);
}

function clean(document: string, ranges: readonly PasteRange[] = [{ from: 0, to: document.length }]) {
  return applyEdits(document, sanitizePythonPaste(document, ranges));
}

describe('sanitizePythonPaste', () => {
  test('VC-1001 (FR-1001): maps spaces, formatting characters, lookalikes and separators', () => {
    const pasted =
      'total\u00a0=\u20071\u202f+\u30002\u200b\u200c\u200d\ufeff\u00ad\u2060\n' +
      'message = “hello”\n' +
      'other = ‘world’\n' +
      'difference = 5–2—1\u2028print(message)\u2029';

    expect(clean(pasted)).toBe(
      'total = 1 + 2\n' +
        'message = "hello"\n' +
        "other = 'world'\n" +
        'difference = 5-2-1\nprint(message)\n',
    );
  });

  test('VC-1002 (FR-1002): preserves ordinary, triple-quoted and comment contents', () => {
    const pasted =
      'ordinary = "keep\u00a0\u200b“—\u2028”"\n' +
      'triple = """keep\u202f\ufeff‘–\u2029’"""\n' +
      '# keep\u3000\u200d“—\u2028”\n';

    expect(clean(pasted)).toBe(pasted);
  });

  test('VC-1003 (FR-1002): repairs smart delimiters before protecting their contents', () => {
    expect(clean('message = “keep\u00a0—\ufefftext”\nother = ‘keep\u200b–text’\n')).toBe(
      'message = "keep\u00a0—\ufefftext"\nother = \'keep\u200b–text\'\n',
    );
  });

  test('VC-1004 (FR-1002): cleans f-string expressions but preserves literal text', () => {
    const pasted = 'result = f"literal\u00a0—\ufeff {left\ufeff–right} {\"nested\u200b—\"}"\n';
    expect(clean(pasted)).toBe(
      'result = f"literal\u00a0—\ufeff {left-right} {\"nested\u200b—\"}"\n',
    );
  });

  test('VC-1005 (BR-1001): changes only inserted ranges', () => {
    const document = 'old\ufeff = 1\nnew\ufeff\u00a0=\u00a02\n';
    expect(clean(document, [{ from: 10, to: document.length }])).toBe(
      'old\ufeff = 1\nnew = 2\n',
    );
  });

  test('VC-1006 (FR-1001): removes the four BOM characters from the supplied exam sample', () => {
    const pasted =
      'v\ufeffalido=True\n' +
      'while valido:\n' +
      '  j=0\n' +
      '  while j\ufeff<len(texto) and valido:\n' +
      '    j+=1\ufeff\ufeff\n';

    expect(clean(pasted)).toBe(
      'valido=True\n' +
        'while valido:\n' +
        '  j=0\n' +
        '  while j<len(texto) and valido:\n' +
        '    j+=1\n',
    );
  });
});

describe('editor paste transaction', () => {
  function editor(shouldSanitizePaste: () => boolean) {
    return createEditor({
      parent: document.body.appendChild(document.createElement('div')),
      initialDoc: 'before = 1\n',
      onChange: () => {},
      effectiveColorScheme: 'light',
      shouldSanitizePaste,
    });
  }

  test('VC-1007 (FR-1003): cleanup stays inside one native paste undo step', () => {
    const view = editor(() => true);
    view.dispatch(
      view.state.replaceSelection('value\ufeff\u00a0=\u00a0“ok”\n'),
      { userEvent: 'input.paste' },
    );

    expect(view.state.doc.toString()).toBe('value = "ok"\nbefore = 1\n');
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('before = 1\n');
    expect(redo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('value = "ok"\nbefore = 1\n');
    view.destroy();
  });

  test('VC-1008 (BR-1001): non-Python gating and non-paste edits remain byte-exact', () => {
    const disabled = editor(() => false);
    disabled.dispatch(disabled.state.replaceSelection('value\ufeff\u00a0=\u00a0“ok”'), {
      userEvent: 'input.paste',
    });
    expect(disabled.state.doc.toString()).toContain('value\ufeff\u00a0=\u00a0“ok”');
    disabled.destroy();

    const enabled = editor(() => true);
    enabled.dispatch(enabled.state.replaceSelection('value\ufeff\u00a0=\u00a0“ok”'), {
      userEvent: 'input.type',
    });
    expect(enabled.state.doc.toString()).toContain('value\ufeff\u00a0=\u00a0“ok”');
    enabled.dispatch(enabled.state.replaceSelection('drop\ufeff\u00a0—'), {
      userEvent: 'input.drop',
    });
    expect(enabled.state.doc.toString()).toContain('drop\ufeff\u00a0—');
    enabled.destroy();
  });
});
