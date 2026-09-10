import { expect, test } from '@playwright/test';
import {
  STARTER_PROGRAM,
  editorText,
  openPlayground,
  setProgram,
  storedProgram,
  typeProgram,
} from './helpers';

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
