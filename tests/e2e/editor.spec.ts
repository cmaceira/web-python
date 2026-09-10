import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import {
  STARTER_PROGRAM,
  editorSnapshot,
  editorText,
  openPlayground,
  setProgram,
  storedProgram,
  typeProgram,
} from './helpers';

interface BaselineBuild {
  commit: string;
  manifestUrlCount: number;
  gzippedApp?: number;
  gzippedBy?: string;
  gzippedAppBy?: Record<string, number>;
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(repoRoot, 'dist');
const BRACKETS_BASELINE_PATH =
  process.env.PYPLAY_BASELINE_BRACKETS ??
  join(repoRoot, 'tests', 'e2e', 'baseline-build-brackets.json');
const bracketsBaseline = JSON.parse(readFileSync(BRACKETS_BASELINE_PATH, 'utf8')) as BaselineBuild;
const compressor = `${process.platform}-${process.arch} zlib ${process.versions.zlib}`;
const bracketsBaselineApp =
  bracketsBaseline.gzippedAppBy?.[compressor] ??
  (bracketsBaseline.gzippedBy === compressor ? bracketsBaseline.gzippedApp : undefined);
const BRACKETS_SIZE_BUDGET_BYTES = 2 * 1024;

if (process.env.PYPLAY_BASELINE_BRACKETS !== undefined && bracketsBaselineApp === undefined) {
  throw new Error(
    `${BRACKETS_BASELINE_PATH} records no app size for "${compressor}" (gzipped by ` +
      `"${bracketsBaseline.gzippedBy}")`,
  );
}

const uncoveredBracketsCompressor =
  `no ${bracketsBaseline.commit} baseline for "${compressor}" — have: ` +
  `${Object.keys(bracketsBaseline.gzippedAppBy ?? {}).join(', ')}. Record with: ` +
  `node scripts/record-baselines.mjs ${bracketsBaseline.commit} --build <out.json>`;

const isVendored = (url: string): boolean =>
  url.startsWith('/pyodide/') || url.startsWith('/ruff/');

test('cross-origin isolation headers are served (BR-002)', async ({ page }) => {
  const response = await page.goto('/');
  const headers = response?.headers() ?? {};
  expect(headers['cross-origin-opener-policy']).toBe('same-origin');
  expect(headers['cross-origin-embedder-policy']).toBe('require-corp');
});

test('VC-001 (FR-001): multi-line Python with keyword highlighting and line numbers', async ({
  page,
}) => {
  await openPlayground(page);
  await typeProgram(page, 'def f():\nreturn 1');

  const lines = (await editorText(page)).split('\n');
  expect(lines).toHaveLength(2);
  expect(lines[0]).toBe('def f():');
  expect(lines[1].trim()).toBe('return 1');

  const keywords = await page
    .locator('.cm-content .tok-keyword')
    .evaluateAll((nodes) => nodes.map((n) => n.textContent));
  // Joined, not matched span by span: CodeMirror may split a highlighted run
  // across sibling text nodes while it is measuring, so `return` can arrive as
  // `re` + `turn` — both still inside `.tok-keyword`, which is what FR-001 asks.
  expect(keywords.join('')).toContain('def');
  expect(keywords.join('')).toContain('return');

  const gutter = await page
    .locator('.cm-gutter.cm-lineNumbers .cm-gutterElement')
    .evaluateAll((nodes) => nodes.map((n) => n.textContent?.trim()).filter(Boolean));
  expect(gutter).toContain('1');
  expect(gutter).toContain('2');
});

test('VC-002 (FR-002, FR-003): autosave after 500 ms is restored on reload', async ({ page }) => {
  await openPlayground(page);
  await typeProgram(page, 'x = 42');
  await page.waitForTimeout(1000);

  await page.reload();
  await page.waitForSelector('.cm-content');
  expect(await editorText(page)).toBe('x = 42');
});

test('VC-003 (FR-050): pagehide inside the debounce window flushes the full contents', async ({
  page,
}) => {
  await openPlayground(page);
  await typeProgram(page, 'x = 42');
  await page.waitForTimeout(100);

  // Still inside the 500 ms debounce: nothing written yet.
  const before = await page.evaluate(
    (key) => window.localStorage.getItem(key),
    'pyplay.workspace.v1',
  );
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
  });

  expect(before).toBeNull();
  expect(await storedProgram(page)).toBe('x = 42');

  await page.reload();
  await page.waitForSelector('.cm-content');
  expect(await editorText(page)).toBe('x = 42');
});

test('VC-004 (FR-004, BR-010): a clean origin loads the starter program', async ({ page }) => {
  await openPlayground(page);
  const text = await editorText(page);
  expect(text).toBe(STARTER_PROGRAM);
  expect(text).toContain('input(');
  expect(text).toContain('print(');
});

test('VC-1101 (FR-1101): Tab and Shift+Tab indent Python with four spaces only', async ({
  page,
}) => {
  await openPlayground(page);
  await setProgram(page, 'print("one")');
  await page.locator('.cm-content').focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('Tab');

  expect(await editorText(page)).toBe('    print("one")');
  expect(await editorText(page)).not.toContain('\t');

  await page.keyboard.press('Shift+Tab');
  expect(await editorText(page)).toBe('print("one")');
});

test('VC-1102 (FR-1102): selected lines indent together and preserve undo and redo', async ({
  page,
}) => {
  await openPlayground(page);
  const source = 'first = 1\nsecond = 2';
  const indented = '    first = 1\n    second = 2';
  await setProgram(page, source);
  await page.locator('.cm-content').focus();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Tab');
  expect(await editorText(page)).toBe(indented);
  expect(await editorText(page)).not.toContain('\t');

  await page.keyboard.press('ControlOrMeta+z');
  expect(await editorText(page)).toBe(source);
  await page.keyboard.press('ControlOrMeta+Shift+Z');
  expect(await editorText(page)).toBe(indented);

  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Shift+Tab');
  expect(await editorText(page)).toBe(source);
});

test('VC-1104 (FR-1104): whitespace dots and repeated indentation preserve grid geometry', async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('pyplay.layout.v2', 'vertical');
  });
  await openPlayground(page, { seedLayout: false });
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--files-width', '480px');
  });

  const source = 'print("inner spaces")';
  await setProgram(page, source);
  await page.locator('.cm-content').focus();

  const before = await page.evaluate(() => {
    const bounds = (selector: string) => {
      const { x, width } = document.querySelector(selector)!.getBoundingClientRect();
      return { x, width };
    };
    const scroller = document.querySelector('.cm-scroller')!;
    return {
      files: bounds('.panel--files'),
      editor: bounds('.panel--editor'),
      console: bounds('.panel--console'),
      pageWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      scrollerWidth: scroller.clientWidth,
    };
  });

  await expect(page.locator('.cm-highlightIndent')).toHaveCount(0);
  expect(await editorText(page)).toBe(source);
  await page.keyboard.press('Home');
  for (let index = 0; index < 6; index += 1) await page.keyboard.press('Tab');

  const after = await page.evaluate(() => {
    const bounds = (selector: string) => {
      const { x, width } = document.querySelector(selector)!.getBoundingClientRect();
      return { x, width };
    };
    const scroller = document.querySelector('.cm-scroller')!;
    return {
      files: bounds('.panel--files'),
      editor: bounds('.panel--editor'),
      console: bounds('.panel--console'),
      pageWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      scrollerWidth: scroller.clientWidth,
    };
  });

  expect(after).toEqual(before);
  expect(await editorText(page)).toBe(`${' '.repeat(24)}${source}`);
  await expect(page.locator('.cm-highlightIndent')).toHaveCount(24);
});

test('VC-1201 (FR-1201): opening delimiters insert a matching closer around the caret', async ({
  page,
}) => {
  await openPlayground(page);
  const pairs: Array<[string, string]> = [
    ['(', '()'],
    ['[', '[]'],
    ['{', '{}'],
    ["'", "''"],
    ['"', '""'],
  ];

  for (const [open, pair] of pairs) {
    await setProgram(page, '');
    await page.locator('.cm-content').click();
    await page.keyboard.type(open);
    expect(await editorSnapshot(page), open).toEqual({ text: pair, from: 1, to: 1 });
  }
});

test('VC-1202 (FR-1202): typing an auto-inserted closer skips it instead of duplicating', async ({
  page,
}) => {
  await openPlayground(page);
  await setProgram(page, '');
  await page.locator('.cm-content').click();
  await page.keyboard.type('print()');
  expect(await editorSnapshot(page)).toEqual({ text: 'print()', from: 7, to: 7 });
});

test('VC-1203 (FR-1203): Backspace deletes an empty automatically created pair', async ({
  page,
}) => {
  await openPlayground(page);
  await setProgram(page, '');
  await page.locator('.cm-content').click();
  await page.keyboard.type('(');
  await page.keyboard.press('Backspace');
  expect(await editorSnapshot(page)).toEqual({ text: '', from: 0, to: 0 });
});

test('VC-1204 (FR-1204): an opening delimiter wraps the current selection', async ({
  page,
}) => {
  await openPlayground(page);
  await setProgram(page, 'value');
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('(');
  expect(await editorSnapshot(page)).toEqual({ text: '(value)', from: 1, to: 6 });
});

test('VC-1205 (FR-1205): nested pairs undo and redo as ordinary editor edits', async ({
  page,
}) => {
  await openPlayground(page);
  await setProgram(page, '');
  await page.locator('.cm-content').click();
  await page.keyboard.type('(');
  expect(await editorSnapshot(page)).toEqual({ text: '()', from: 1, to: 1 });
  // CodeMirror joins `input.type` events within 500 ms. FR-1205 asks for
  // nested pairs as ordinary edits, so the two insertions must be separate
  // history events.
  await page.waitForTimeout(600);
  await page.keyboard.type('[');
  expect(await editorSnapshot(page)).toEqual({ text: '([])', from: 2, to: 2 });

  await page.keyboard.press('ControlOrMeta+z');
  expect(await editorSnapshot(page)).toEqual({ text: '()', from: 1, to: 1 });
  await page.keyboard.press('ControlOrMeta+z');
  expect(await editorSnapshot(page)).toEqual({ text: '', from: 0, to: 0 });

  // Redo restores the documents. Native history maps the caret through the
  // inverted insert with assoc 1, so it lands after the reinserted pair
  // rather than between the delimiters.
  await page.keyboard.press('ControlOrMeta+Shift+Z');
  expect((await editorSnapshot(page)).text).toBe('()');
  await page.keyboard.press('ControlOrMeta+Shift+Z');
  expect((await editorSnapshot(page)).text).toBe('([])');
});

test('VC-1206 (NFR-1201): pairing adds ≤ 2 KiB gzip and no asset', async () => {
  test.skip(bracketsBaselineApp === undefined, uncoveredBracketsCompressor);

  const manifest = JSON.parse(readFileSync(join(dist, 'precache-manifest.json'), 'utf8')) as {
    urls: string[];
  };
  let gzippedApp = 0;
  for (const url of [...manifest.urls, '/index.html']) {
    if (url === '/' || isVendored(url)) continue;
    gzippedApp += gzipSync(readFileSync(join(dist, url.replace(/^\//, ''))), { level: 9 }).length;
  }

  const delta = gzippedApp - bracketsBaselineApp!;
  expect(
    delta,
    `NFR-1201 app size delta vs ${bracketsBaseline.commit}: ${delta} B gzipped ` +
      `(budget ${BRACKETS_SIZE_BUDGET_BYTES} B, compressor "${compressor}")`,
  ).toBeLessThanOrEqual(BRACKETS_SIZE_BUDGET_BYTES);
  expect(manifest.urls).toHaveLength(bracketsBaseline.manifestUrlCount);

  console.log(
    [
      'VC-1206 measurements:',
      `  NFR-1201 app delta vs ${bracketsBaseline.commit} ${delta} B (<= ${BRACKETS_SIZE_BUDGET_BYTES})`,
      `  NFR-1201 precache URL count           ${manifest.urls.length} (unchanged)`,
    ].join('\n'),
  );
});

test('VC-010 (FR-010): Reset replaces the buffer on confirm and leaves it on cancel', async ({
  page,
}) => {
  await openPlayground(page);
  await typeProgram(page, 'mi_codigo = 1');
  await page.waitForTimeout(600);

  const messages: string[] = [];

  page.once('dialog', (dialog) => {
    messages.push(dialog.message());
    void dialog.accept();
  });
  await page.getByRole('button', { name: 'Reset' }).click();
  await expect
    .poll(() => editorText(page))
    .toBe(STARTER_PROGRAM);

  await typeProgram(page, 'mi_codigo = 1');
  page.once('dialog', (dialog) => {
    messages.push(dialog.message());
    void dialog.dismiss();
  });
  await page.getByRole('button', { name: 'Reset' }).click();
  await page.waitForTimeout(200);
  expect(await editorText(page)).toBe('mi_codigo = 1');

  expect(messages).toEqual([
    'Delete all files and reset the workspace?',
    'Delete all files and reset the workspace?',
  ]);
});
