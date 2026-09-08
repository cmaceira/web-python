import { pythonLanguage } from '@codemirror/lang-python';

export interface PasteRange {
  from: number;
  to: number;
}

export interface PasteEdit extends PasteRange {
  insert: string;
}

const SPACE_SEPARATOR = /\p{Zs}/u;
const FORMAT_CHARACTER = /\p{Cf}/u;

const SMART_QUOTES: Readonly<Record<string, string>> = {
  '\u2018': "'",
  '\u2019': "'",
  '\u201c': '"',
  '\u201d': '"',
};

const LOOKALIKE_DASHES: Readonly<Record<string, string>> = {
  '\u2013': '-',
  '\u2014': '-',
};

function pastedRangesWithin(document: string, ranges: readonly PasteRange[]): PasteRange[] {
  const sorted = ranges
    .map(({ from, to }) => ({
      from: Math.max(0, Math.min(document.length, from)),
      to: Math.max(0, Math.min(document.length, to)),
    }))
    .filter(({ from, to }) => from < to)
    .sort((a, b) => a.from - b.from || a.to - b.to);

  const merged: PasteRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.from <= previous.to) previous.to = Math.max(previous.to, range.to);
    else merged.push({ ...range });
  }
  return merged;
}

/**
 * Mark Python string/comment payload as protected from paste cleanup (BR-1002).
 * Formatted-string replacement fields switch back to code, while nested strings
 * and comments inside a replacement protect themselves again.
 */
function protectedPythonText(document: string): Uint8Array {
  const protectedText = new Uint8Array(document.length);
  const cursor = pythonLanguage.parser.parse(document).cursor();

  const visit = (mode: 'code' | 'protected'): void => {
    const { name, from, to } = cursor;
    let childMode = mode;

    if (name === 'String' || name === 'Comment') {
      protectedText.fill(1, from, to);
      return;
    }

    if (name === 'FormatString') {
      protectedText.fill(1, from, to);
      childMode = 'protected';
    } else if (name === 'FormatReplacement') {
      protectedText.fill(0, from, to);
      childMode = 'code';
    }

    if (!cursor.firstChild()) return;
    do {
      visit(childMode);
    } while (cursor.nextSibling());
    cursor.parent();
  };

  visit('code');
  return protectedText;
}

function editsForCharacters(
  document: string,
  ranges: readonly PasteRange[],
  protectedText: Uint8Array,
  replacementFor: (character: string) => string | null,
): PasteEdit[] {
  const edits: PasteEdit[] = [];
  for (const range of ranges) {
    for (let position = range.from; position < range.to; ) {
      const codePoint = document.codePointAt(position);
      if (codePoint === undefined) break;
      const character = String.fromCodePoint(codePoint);
      const width = character.length;
      const replacement = protectedText[position] === 0 ? replacementFor(character) : null;
      if (replacement !== null && replacement !== character) {
        edits.push({ from: position, to: position + width, insert: replacement });
      }
      position += width;
    }
  }
  return edits;
}

function applyEdits(document: string, edits: readonly PasteEdit[]): string {
  if (edits.length === 0) return document;
  let result = '';
  let position = 0;
  for (const edit of edits) {
    result += document.slice(position, edit.from) + edit.insert;
    position = edit.to;
  }
  return result + document.slice(position);
}

/**
 * Return edits, in post-paste document coordinates, for suspicious characters
 * inside the supplied pasted ranges (FR-1001 – FR-1003).
 *
 * Smart delimiters are repaired first without changing offsets. Re-parsing that
 * provisional document lets the second pass preserve the contents of a string
 * that arrived delimited by curly quotes.
 */
export function sanitizePythonPaste(
  document: string,
  pastedRanges: readonly PasteRange[],
): PasteEdit[] {
  const ranges = pastedRangesWithin(document, pastedRanges);
  if (ranges.length === 0) return [];

  const quoteEdits = editsForCharacters(
    document,
    ranges,
    protectedPythonText(document),
    (character) => SMART_QUOTES[character] ?? null,
  );
  const provisional = applyEdits(document, quoteEdits);
  const protectedText = protectedPythonText(provisional);

  const remainingEdits = editsForCharacters(
    provisional,
    ranges,
    protectedText,
    (character) => {
      if (character === '\u2028' || character === '\u2029') return '\n';
      if (SPACE_SEPARATOR.test(character)) return ' ';
      if (FORMAT_CHARACTER.test(character)) return '';
      return LOOKALIKE_DASHES[character] ?? null;
    },
  );

  return [...quoteEdits, ...remainingEdits].sort((a, b) => a.from - b.from || a.to - b.to);
}
