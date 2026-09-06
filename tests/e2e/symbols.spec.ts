/**
 * Spec-03 — the vertical special-character pane.
 *
 * Iteration 1 criteria: VC-301 – VC-306, VC-321, VC-325, VC-331, VC-332.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  caretPosition,
  consoleText,
  editorText,
  noticeTexts,
  openPlayground,
  programStdout,
  runProgram,
  setCaret,
  setProgram,
  storedProgram,
  submitStdin,
  typeProgram,
  waitForLinter,
  waitForPythonReady,
  waitForStdinPrompt,
} from './helpers';

/** The 29 values of *Character set*, in table order (FR-305). */
export const SYMBOL_VALUES = [
  '"',
  "'",
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  '+',
  '-',
  '*',
  '/',
  '//',
  '%',
  '**',
  '==',
  '!=',
  '<',
  '>',
  '<=',
  '>=',
  ':',
  ',',
  '.',
  '#',
  '_',
  '\\',
  '|',
  '...',
];

/** The five group headings, in order (FR-305). */
export const SYMBOL_HEADINGS = ['Quotes', 'Brackets', 'Operators', 'Punctuation', 'Ellipsis'];

/** The accessible name of every row, in table order (FR-314). */
export const SYMBOL_NAMES = [
  'Double quote',
  'Single quote',
  'Left parenthesis',
  'Right parenthesis',
  'Left square bracket',
  'Right square bracket',
  'Left brace',
  'Right brace',
  'Plus',
  'Minus',
  'Asterisk',
  'Slash',
  'Floor division',
  'Percent',
  'Power',
  'Equal to',
  'Not equal to',
  'Less than',
  'Greater than',
  'Less than or equal to',
  'Greater than or equal to',
  'Colon',
  'Comma',
  'Period',
  'Hash',
  'Underscore',
  'Backslash',
  'Pipe',
  'Ellipsis',
];

/** Open the pane through its toggle, the way a visitor does (FR-302). */
export async function openSymbolPane(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Symbols' }).click();
  await expect(page.locator('#symbol-pane')).toBeVisible();
}

/** The `data-value` of the button that currently holds focus, or ''. */
export async function focusedSymbol(page: Page): Promise<string> {
  return page.evaluate(
    () => (document.activeElement as HTMLElement | null)?.dataset.value ?? '',
  );
}

/**
 * FR-309 / BR-305: the pane is still a live composite widget — exactly one of
 * its buttons is in the tab order, and it is the one focus is on or would
 * return to.
 */
export async function expectPaneNavigable(page: Page): Promise<void> {
  const tabindexes = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('#symbol-pane .symbol')).map(
      (b) => b.tabIndex,
    ),
  );
  expect(tabindexes.filter((t) => t === 0)).toHaveLength(1);
  expect(tabindexes.filter((t) => t === -1)).toHaveLength(28);

  // ...and `ArrowDown` still moves focus between its buttons.
  await page.locator('#symbol-pane .symbol').first().focus();
  await page.keyboard.press('ArrowDown');
  expect(await focusedSymbol(page)).not.toBe('');
  expect(await focusedSymbol(page)).not.toBe('"');
}

/* -------------------------------------------------------------------------
   FR-301 – FR-305, FR-314, FR-315
   ------------------------------------------------------------------------- */

test('VC-301 (FR-301): the toolbar ends with a closed, correctly wired Symbols toggle', async ({
  page,
}) => {
  await openPlayground(page);

  const toggle = page.locator('#btn-symbols');
  await expect(toggle).toHaveText('Symbols');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toHaveAttribute('aria-controls', 'symbol-pane');

  // It sits immediately before `#btn-theme` (spec-05); `#btn-about` is last
  // (spec-08 amendment). It has no disabled state.
  const wiring = await page.evaluate(() => {
    const controls = Array.from(document.querySelectorAll('.toolbar > button'));
    const toggle = document.getElementById('btn-symbols')!;
    const theme = document.getElementById('btn-theme');
    const about = document.getElementById('btn-about');
    const target = document.getElementById(toggle.getAttribute('aria-controls')!);
    return {
      followedByTheme: toggle.nextElementSibling === theme,
      aboutIsLast: controls[controls.length - 1] === about,
      themeIsLast: controls[controls.length - 1] === theme,
      resolves: target === document.getElementById('symbol-pane'),
      ariaDisabled: toggle.getAttribute('aria-disabled'),
      hidden: (document.getElementById('symbol-pane') as HTMLElement).hidden,
    };
  });
  expect(wiring.followedByTheme).toBe(true);
  expect(wiring.aboutIsLast).toBe(true);
  expect(wiring.themeIsLast).toBe(false);
  expect(wiring.resolves).toBe(true);
  expect(wiring.ariaDisabled).toBeNull();
  expect(wiring.hidden).toBe(true);

  // Neither rendered nor in the accessibility tree while closed.
  await expect(page.locator('#symbol-pane')).toBeHidden();
  await expect(page.getByRole('toolbar', { name: 'Special characters' })).toHaveCount(0);
});

test('VC-302 (FR-302): a pointer activation opens the pane and focuses the first button', async ({
  page,
}) => {
  await openPlayground(page);
  await openSymbolPane(page);

  await expect(page.locator('#btn-symbols')).toHaveAttribute('aria-expanded', 'true');
  expect(await focusedSymbol(page)).toBe('"');
});

test('VC-303 (FR-302, FR-309): Enter and Space both open the pane and focus the first button', async ({
  page,
}) => {
  await openPlayground(page);

  for (const key of ['Enter', 'Space']) {
    await page.locator('#btn-symbols').focus();
    await page.keyboard.press(key);
    await expect(page.locator('#symbol-pane')).toBeVisible();
    await expect(page.locator('#btn-symbols')).toHaveAttribute('aria-expanded', 'true');
    expect(await focusedSymbol(page), `after ${key}`).toBe('"');

    // Back to closed for the next key, through the toggle (FR-303).
    await page.locator('#btn-symbols').click();
    await expect(page.locator('#symbol-pane')).toBeHidden();
  }
});

test('VC-304 (FR-303): the toggle closes the pane and takes focus back', async ({ page }) => {
  await openPlayground(page);
  await openSymbolPane(page);

  await page.locator('#btn-symbols').click();

  await expect(page.locator('#symbol-pane')).toBeHidden();
  await expect(page.locator('#btn-symbols')).toHaveAttribute('aria-expanded', 'false');
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('btn-symbols');
});

test('VC-305 (FR-304): Escape from inside the pane closes it and returns focus', async ({
  page,
}) => {
  await openPlayground(page);
  await openSymbolPane(page);

  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');

  await expect(page.locator('#symbol-pane')).toBeHidden();
  await expect(page.locator('#btn-symbols')).toHaveAttribute('aria-expanded', 'false');
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('btn-symbols');
});

test('VC-306 (FR-305, BR-302): 29 buttons and five headings, in table order', async ({ page }) => {
  await openPlayground(page);
  await openSymbolPane(page);

  const rendered = await page.evaluate(() => ({
    values: Array.from(document.querySelectorAll<HTMLElement>('#symbol-pane .symbol')).map(
      (b) => b.dataset.value ?? '',
    ),
    headings: Array.from(
      document.querySelectorAll('#symbol-pane .symbol-group-title'),
    ).map((h) => h.textContent ?? ''),
  }));

  expect(rendered.values).toEqual(SYMBOL_VALUES);
  expect(rendered.headings).toEqual(SYMBOL_HEADINGS);
});

test('VC-321 (FR-314, FR-315): every button carries its name, title and glyph', async ({
  page,
}) => {
  await openPlayground(page);
  await openSymbolPane(page);

  const rows = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('#symbol-pane .symbol')).map((b) => ({
      value: b.dataset.value ?? '',
      label: b.getAttribute('aria-label') ?? '',
      title: b.getAttribute('title') ?? '',
      text: b.textContent ?? '',
    })),
  );

  expect(rows).toHaveLength(29);
  rows.forEach((row, i) => {
    expect(row.value, `row ${i + 1} value`).toBe(SYMBOL_VALUES[i]);
    expect(row.label, `row ${i + 1} accessible name`).toBe(SYMBOL_NAMES[i]);
    expect(row.title, `row ${i + 1} title`).toBe(SYMBOL_NAMES[i]);
    // FR-314: the visible label is the glyph, which for every row equals the
    // value — including `...`, which is never the single code point U+2026.
    expect(row.text, `row ${i + 1} glyph`).toBe(SYMBOL_VALUES[i]);
  });

  // The accessible name really is the row's name, not the punctuation.
  await expect(page.getByRole('button', { name: 'Floor division', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Pipe', exact: true })).toHaveCount(1);
});

test('VC-325 (BR-302): the compiled character set holds no Python look-alike', async ({ page }) => {
  await openPlayground(page);
  await openSymbolPane(page);

  const points = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('#symbol-pane .symbol'))
      .flatMap((b) => [...(b.dataset.value ?? ''), ...(b.textContent ?? '')])
      .map((c) => c.codePointAt(0) ?? 0),
  );

  // Curly quotes, mathematical look-alikes and full-width parentheses.
  for (const bad of [0x2018, 0x2019, 0x201c, 0x201d, 0x2264, 0x2265, 0x2260, 0x00d7, 0x00f7, 0xff08, 0xff09]) {
    expect(points, `U+${bad.toString(16).toUpperCase()}`).not.toContain(bad);
  }
  // No emoji or other supplementary-plane glyph.
  expect(points.filter((p) => p >= 0x1f000)).toEqual([]);
  // Nothing outside printable ASCII at all, which subsumes the list above.
  expect(points.filter((p) => p < 0x21 || p > 0x7e)).toEqual([]);
});

/* -------------------------------------------------------------------------
   FR-317 — the pane's position in the document
   ------------------------------------------------------------------------- */

for (const viewport of [
  { width: 375, height: 667 },
  { width: 1280, height: 800 },
]) {
  test(`VC-331 (FR-317): the sibling chain is identical at ${viewport.width} px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await openPlayground(page);
    await openSymbolPane(page);

    const chain = await page.evaluate(() => {
      const notices = document.getElementById('notices')!;
      const pane = document.getElementById('symbol-pane')!;
      return {
        afterNotices: notices.nextElementSibling?.id ?? '',
        afterPane: pane.nextElementSibling?.className ?? '',
      };
    });

    expect(chain.afterNotices).toBe('symbol-pane');
    expect(chain.afterPane).toContain('panel--console');
  });
}

/* -------------------------------------------------------------------------
   FR-318 — the pane closes only two ways
   ------------------------------------------------------------------------- */

test('VC-332 (FR-318): nothing but the toggle and Escape dismisses the pane', async ({ page }) => {
  test.setTimeout(120_000);

  await openPlayground(page);
  await waitForPythonReady(page);
  await waitForLinter(page);
  await openSymbolPane(page);

  const pane = page.locator('#symbol-pane');
  const scrollTop = async (): Promise<number> =>
    page.evaluate(() => document.getElementById('symbol-pane')!.scrollTop);
  const before = await scrollTop();

  /** After every one of FR-318's events the pane is untouched. */
  const stillOpen = async (what: string): Promise<void> => {
    await expect(pane, what).toBeVisible();
    await expect(page.locator('#btn-symbols'), what).toHaveAttribute('aria-expanded', 'true');
    expect(await scrollTop(), what).toBe(before);
    await expectPaneNavigable(page);
  };

  // The visitor clicks the editor and types.
  await page.locator('.cm-content').click();
  await page.keyboard.type('x = 1');
  await stillOpen('after editing');

  // Focus leaves the pane by Tab.
  await page.locator('#symbol-pane .symbol').first().focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press('Tab');
  await stillOpen('after Tab-out');

  // A click on the page background.
  await page.locator('body').click({ position: { x: 2, y: 2 } });
  await stillOpen('after a background click');

  for (const name of ['Clear console', 'Copy code', 'Format']) {
    await page.getByRole('button', { name }).click();
    await stillOpen(`after ${name}`);
  }

  // Run, then Stop. A runaway loop keeps the program alive long enough for
  // Stop to be genuinely enabled while the pane is inspected.
  await setProgram(page, 'while True: pass\n');
  await stillOpen('after replacing the program');
  await page.locator('#btn-run').click();
  await stillOpen('after Run');
  await expect(page.getByRole('button', { name: 'Stop' })).toBeEnabled();
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect.poll(() => consoleText(page), { timeout: 15_000 }).toContain('Program stopped.');
  await stillOpen('after Stop');
});

/* -------------------------------------------------------------------------
   FR-311 / NFR-301 — the two layouts
   ------------------------------------------------------------------------- */

/** The geometry FR-311 constrains, measured on the rendered page. */
async function layout(page: Page): Promise<{
  pane: DOMRect;
  editor: DOMRect;
  /** `.app`'s content width — what "the app content width" means in VC-319. */
  appContentWidth: number;
  scrollWidth: number;
  paneScrolls: boolean;
}> {
  return page.evaluate(() => {
    const rect = (selector: string): DOMRect =>
      document.querySelector(selector)!.getBoundingClientRect().toJSON() as DOMRect;
    const pane = document.getElementById('symbol-pane')!;
    const app = document.querySelector('.app')!;
    const appStyle = getComputedStyle(app);
    return {
      pane: rect('#symbol-pane'),
      editor: rect('.panel--editor'),
      appContentWidth:
        app.clientWidth -
        Number.parseFloat(appStyle.paddingLeft) -
        Number.parseFloat(appStyle.paddingRight),
      scrollWidth: document.documentElement.scrollWidth,
      paneScrolls: pane.scrollHeight > pane.clientHeight,
    };
  });
}

test.describe('wide layout', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('VC-318 (FR-311): the pane docks as an inline-end column', async ({ page }) => {
    await openPlayground(page);
    await openSymbolPane(page);

    const { pane, editor } = await layout(page);

    expect(pane.x, 'pane starts at or after the editor panel’s inline-end edge').toBeGreaterThanOrEqual(
      editor.x + editor.width - 1,
    );
    expect(pane.width, 'pane inline size').toBeGreaterThanOrEqual(44);
    expect(pane.width, 'pane inline size').toBeLessThanOrEqual(96);
    expect(pane.height, 'pane block size vs the editor panel').toBeGreaterThanOrEqual(
      editor.height - 1,
    );

    // FR-309: one button per visual row, so ArrowRight/ArrowLeft cannot move.
    const rows = await page.evaluate(() => {
      const tops = Array.from(document.querySelectorAll('#symbol-pane .symbol')).map(
        (b) => Math.round(b.getBoundingClientRect().top),
      );
      return new Set(tops).size;
    });
    expect(rows, 'distinct visual rows in the wide layout').toBe(29);

    await expect(page.locator('#symbol-pane')).toHaveAttribute('aria-orientation', 'vertical');
  });
});

test.describe('narrow layout', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test('VC-319 (FR-311, FR-047, NFR-301): a full-width band that scrolls itself', async ({
    page,
  }) => {
    await openPlayground(page);
    await openSymbolPane(page);

    const { pane, editor, appContentWidth, scrollWidth, paneScrolls } = await layout(page);

    expect(scrollWidth, 'no horizontal page scrolling').toBeLessThanOrEqual(375);
    expect(pane.y, 'pane sits above the editor').toBeLessThan(editor.y);
    expect(pane.width, 'pane spans the app content width').toBeCloseTo(appContentWidth, 0);

    // Every button is inside the pane's scrollable content and big enough to
    // hit; the pane scrolls, the page does not.
    const buttons = await page.evaluate(() => {
      const pane = document.getElementById('symbol-pane')!;
      const box = pane.getBoundingClientRect();
      return Array.from(document.querySelectorAll('#symbol-pane .symbol')).map((b) => {
        const r = b.getBoundingClientRect();
        return { w: r.width, h: r.height, left: r.left - box.left, right: box.right - r.right };
      });
    });
    expect(buttons).toHaveLength(29);
    for (const [i, b] of buttons.entries()) {
      expect(b.w, `button ${i + 1} width`).toBeGreaterThanOrEqual(32);
      expect(b.h, `button ${i + 1} height`).toBeGreaterThanOrEqual(32);
      expect(b.left, `button ${i + 1} clipped at the pane’s inline start`).toBeGreaterThanOrEqual(-1);
      expect(b.right, `button ${i + 1} clipped at the pane’s inline end`).toBeGreaterThanOrEqual(-1);
    }
    expect(paneScrolls, 'the pane scrolls within its own bounds').toBe(true);

    // Scrolling the pane alone brings the last button into view.
    await page.evaluate(() => {
      const pane = document.getElementById('symbol-pane')!;
      pane.scrollTop = pane.scrollHeight;
    });
    const lastVisible = await page.evaluate(() => {
      const pane = document.getElementById('symbol-pane')!.getBoundingClientRect();
      const all = document.querySelectorAll('#symbol-pane .symbol');
      const last = all[all.length - 1]!.getBoundingClientRect();
      return last.top >= pane.top - 1 && last.bottom <= pane.bottom + 1;
    });
    expect(lastVisible, 'the last button is reachable by pane-only scrolling').toBe(true);

    await expect(page.locator('#symbol-pane')).toHaveAttribute('aria-orientation', 'horizontal');
  });
});

test('VC-330 (FR-311): the 700/699 px boundary flips the layout', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 800 });
  await openPlayground(page);
  await openSymbolPane(page);

  {
    const { pane, editor, scrollWidth } = await layout(page);
    expect(pane.x, '700 px: pane after the editor').toBeGreaterThanOrEqual(
      editor.x + editor.width - 1,
    );
    expect(pane.width, '700 px: pane inline size').toBeGreaterThanOrEqual(44);
    expect(pane.width, '700 px: pane inline size').toBeLessThanOrEqual(96);
    expect(scrollWidth, '700 px: no horizontal page scrolling').toBeLessThanOrEqual(700);
  }

  await page.setViewportSize({ width: 699, height: 800 });
  {
    const { pane, editor, appContentWidth, scrollWidth } = await layout(page);
    expect(pane.y, '699 px: pane above the editor').toBeLessThan(editor.y);
    expect(pane.width, '699 px: pane spans the app content width').toBeCloseTo(appContentWidth, 0);
    expect(scrollWidth, '699 px: no horizontal page scrolling').toBeLessThanOrEqual(699);
  }
});

test('A-305: the multi-character glyphs render as literal characters', async ({ page }) => {
  await openPlayground(page);
  await openSymbolPane(page);

  const rendered = await page.evaluate(() =>
    ['//', '**', '==', '!=', '<=', '>=', '...'].map((value) => {
      const button = document.querySelector<HTMLElement>(
        `#symbol-pane .symbol[data-value="${CSS.escape(value)}"]`,
      )!;
      return {
        value,
        text: button.textContent ?? '',
        ligatures: getComputedStyle(button).fontVariantLigatures,
        width: button.getBoundingClientRect().width,
      };
    }),
  );

  for (const row of rendered) {
    expect(row.text, `${row.value} text`).toBe(row.value);
    expect(row.ligatures, `${row.value} ligatures`).toBe('none');
    expect(row.width, `${row.value} rendered width`).toBeGreaterThan(0);
  }
});

/* -------------------------------------------------------------------------
   FR-306 – FR-308, FR-313, FR-316 — copying and its feedback
   ------------------------------------------------------------------------- */

/** The pane's `role="status"` text (FR-307). */
async function symbolStatus(page: Page): Promise<string> {
  return page.evaluate(() => document.getElementById('symbol-status')?.textContent ?? '');
}

/** The `data-value` of every button currently in the copied state (FR-307). */
async function copiedButtons(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>('#symbol-pane .symbol[data-state="copied"]'),
    ).map((b) => b.dataset.value ?? ''),
  );
}

/**
 * The pane button for `value`, addressed by the value it copies. Every value
 * is printable ASCII (VC-325), so escaping `\` and `"` is enough to make a
 * valid attribute selector.
 */
function symbolButton(page: Page, value: string) {
  const escaped = value.replace(/([\\"])/g, '\\$1');
  return page.locator(`#symbol-pane .symbol[data-value="${escaped}"]`);
}

/** Reject every clipboard write, the way a denied permission does (FR-308). */
async function denyClipboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) },
    });
  });
}

test('VC-307 (FR-306, BR-301): every value lands on the clipboard, and the editor never moves', async ({
  page,
}) => {
  test.setTimeout(120_000);

  await openPlayground(page);
  // The buffer as it was before the single undoable edit this test makes.
  const original = await editorText(page);
  await setProgram(page, 'x = 1\ny = 2\n');
  await setCaret(page, 2, 3);
  await openSymbolPane(page);

  const before = { text: await editorText(page), caret: await caretPosition(page) };

  for (const value of SYMBOL_VALUES) {
    await symbolButton(page, value).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 5_000 })
      .toBe(value);
  }

  // BR-301: no transaction reached the editor at any point.
  expect(await editorText(page)).toBe(before.text);
  expect(await caretPosition(page)).toEqual(before.caret);

  // ...and the undo history is exactly where it was: a single undo still
  // reverses the one edit this test made, so no copy left an entry behind.
  await page.evaluate(() => {
    const content = document.querySelector('.cm-content') as
      | (HTMLElement & { cmView?: { view: { focus(): void } }; cmTile?: { view: { focus(): void } } })
      | null;
    (content?.cmTile?.view ?? content?.cmView?.view)?.focus();
  });
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => editorText(page)).toBe(original);
});

test('VC-308 (FR-306): the copied `**` pastes as exactly two characters', async ({ page }) => {
  await openPlayground(page);
  await setProgram(page, 'x = 1\n');
  await openSymbolPane(page);

  await symbolButton(page, '**').click();
  await expect(page.locator('#symbol-status')).toHaveText('Copied **');

  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.keyboard.press('ControlOrMeta+v');

  await expect.poll(() => editorText(page)).toBe('**');
});

test('VC-309 (FR-307): `Copied (` appears at once and reverts after the window', async ({
  page,
}) => {
  await openPlayground(page);
  await openSymbolPane(page);

  const clickedAt = Date.now();
  await symbolButton(page, '(').click();
  await expect(page.locator('#symbol-status')).toHaveText('Copied (', { timeout: 1_000 });
  await expect(symbolButton(page, '(')).toHaveAttribute('data-state', 'copied');
  expect(Date.now() - clickedAt, 'feedback painted promptly').toBeLessThan(1_000);

  // Still there well inside the 2 000 ms window...
  await page.waitForTimeout(1_200);
  expect(await symbolStatus(page)).toBe('Copied (');

  // ...and gone after it.
  await expect.poll(() => symbolStatus(page), { timeout: 3_000 }).toBe('');
  expect(await copiedButtons(page)).toEqual([]);
});

test('VC-310 (FR-307): a second copy replaces the text and restarts the timer', async ({
  page,
}) => {
  await openPlayground(page);
  await openSymbolPane(page);

  await symbolButton(page, '(').click();
  await expect(page.locator('#symbol-status')).toHaveText('Copied (');

  await page.waitForTimeout(1_200);
  const secondAt = Date.now();
  await symbolButton(page, ':').click();
  await expect(page.locator('#symbol-status')).toHaveText('Copied :');
  expect(await copiedButtons(page)).toEqual([':']);

  // 1 900 ms after the *first* click the second copy's text is still showing:
  // the window restarted from zero rather than running down.
  await page.waitForTimeout(Math.max(0, 700 - (Date.now() - secondAt)));
  expect(await symbolStatus(page)).toBe('Copied :');

  // It clears 2 000 ms after the second click, not the first.
  await expect.poll(() => symbolStatus(page), { timeout: 3_000 }).toBe('');
  expect(await copiedButtons(page)).toEqual([]);
});

test('VC-311 (FR-308, BR-303, FR-313): a denied write notifies, selects the glyph and degrades nothing', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await denyClipboard(page);
  await openPlayground(page);
  await openSymbolPane(page);

  await symbolButton(page, '{').click();

  await expect(
    page.locator(
      '[data-notice="Couldn\'t copy — select the character and press Ctrl/Cmd+C"]',
    ),
  ).toHaveCount(1);
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''))
    .toBe('{');
  expect(await symbolStatus(page)).toBe('');
  expect(await copiedButtons(page)).toEqual([]);

  // BR-303: the pane is still open and still navigable...
  await expect(page.locator('#symbol-pane')).toBeVisible();
  await expect(page.locator('#btn-symbols')).toHaveAttribute('aria-expanded', 'true');
  await symbolButton(page, '"').first().focus();
  await page.keyboard.press('ArrowDown');
  expect(await focusedSymbol(page)).not.toBe('"');

  // ...and editing plus Copy code behave exactly as spec-01 requires.
  await typeProgram(page, 'print("hi")');
  expect(await editorText(page)).toBe('print("hi")');
  await page.getByRole('button', { name: 'Copy code' }).click();
  await expect(
    page.locator('[data-notice="Couldn\'t copy — select the code and press Ctrl/Cmd+C"]'),
  ).toHaveCount(1);
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''))
    .toBe('print("hi")');

  expect(pageErrors).toEqual([]);
});

test('VC-312 (FR-313): with no clipboard API at all the pane falls back and Run still works', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  });

  await openPlayground(page);
  await waitForPythonReady(page);
  await openSymbolPane(page);

  await symbolButton(page, '+').click();
  await expect(
    page.locator(
      '[data-notice="Couldn\'t copy — select the character and press Ctrl/Cmd+C"]',
    ),
  ).toHaveCount(1);
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''))
    .toBe('+');
  expect(await symbolStatus(page)).toBe('');

  await runProgram(page, 'print("ok")\n');
  await expect.poll(() => programStdout(page), { timeout: 30_000 }).toBe('ok\n');
  expect(pageErrors).toEqual([]);
});

test('VC-328 (FR-307, FR-308): a denial after a success leaves no stale feedback', async ({
  page,
}) => {
  // The first write succeeds; the second, 500 ms later, is rejected.
  await page.addInitScript(() => {
    const real = navigator.clipboard;
    let calls = 0;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) =>
          ++calls === 1
            ? real.writeText(text)
            : Promise.reject(new DOMException('denied', 'NotAllowedError')),
        readText: () => real.readText(),
      },
    });
  });

  await openPlayground(page);
  await openSymbolPane(page);

  const firstAt = Date.now();
  await symbolButton(page, '(').click();
  await expect(page.locator('#symbol-status')).toHaveText('Copied (');

  await page.waitForTimeout(Math.max(0, 500 - (Date.now() - firstAt)));
  await symbolButton(page, ')').click();

  await expect(
    page.locator(
      '[data-notice="Couldn\'t copy — select the character and press Ctrl/Cmd+C"]',
    ),
  ).toHaveCount(1);

  // The FR-307 window that was still pending is cancelled, not merely hidden:
  // nothing reappears at any point up to 3 000 ms after the first click.
  const deadline = firstAt + 3_000;
  while (Date.now() < deadline) {
    expect(await symbolStatus(page)).toBe('');
    expect(await copiedButtons(page)).toEqual([]);
    await page.waitForTimeout(150);
  }
});

test('VC-333 (FR-316): a pane closed mid-write produces no feedback at all', async ({ page }) => {
  // Every clipboard write resolves 300 ms late, so `Escape` can land first.
  await page.addInitScript(() => {
    const real = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) =>
          new Promise<void>((resolve, reject) => {
            setTimeout(() => real.writeText(text).then(resolve, reject), 300);
          }),
      },
    });
  });

  await openPlayground(page);
  await openSymbolPane(page);

  await symbolButton(page, '#').click();
  await page.waitForTimeout(50);
  await page.keyboard.press('Escape');
  await expect(page.locator('#symbol-pane')).toBeHidden();

  await page.waitForTimeout(500);
  expect(await symbolStatus(page)).toBe('');
  expect(await copiedButtons(page)).toEqual([]);
  expect(await noticeTexts(page)).toEqual([]);
  await expect(page.locator('#symbol-pane')).toBeHidden();
  await expect(page.locator('#btn-symbols')).toHaveAttribute('aria-expanded', 'false');
});

/* -------------------------------------------------------------------------
   FR-309 — keyboard navigation
   ------------------------------------------------------------------------- */

test.describe('wide layout keyboard model', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('VC-313 (FR-309, BR-305): one tab stop, and one button per visual row', async ({ page }) => {
    await openPlayground(page);
    await openSymbolPane(page);

    expect(await focusedSymbol(page)).toBe('"');
    // Exactly one button is in the tab order (the helper also moves focus, so
    // `Home` puts it back at the start before the walk).
    await expectPaneNavigable(page);
    await page.keyboard.press('Home');
    expect(await focusedSymbol(page)).toBe('"');

    // 28 ArrowDown presses walk the whole set in Character set order.
    for (let i = 1; i < 29; i++) {
      await page.keyboard.press('ArrowDown');
      expect(await focusedSymbol(page), `after ${i} ArrowDown presses`).toBe(SYMBOL_VALUES[i]);
    }
    await page.keyboard.press('ArrowDown');
    expect(await focusedSymbol(page), 'no wrap at the end').toBe('...');

    await page.keyboard.press('Home');
    expect(await focusedSymbol(page)).toBe('"');
    await page.keyboard.press('End');
    expect(await focusedSymbol(page)).toBe('...');

    await page.keyboard.press('ArrowUp');
    expect(await focusedSymbol(page)).toBe('|');

    for (let i = 0; i < 40; i++) await page.keyboard.press('ArrowUp');
    expect(await focusedSymbol(page), 'no wrap at the start').toBe('"');

    // One button per visual row, so the row-wise keys cannot move focus.
    await page.keyboard.press('ArrowRight');
    expect(await focusedSymbol(page)).toBe('"');
    await page.keyboard.press('ArrowLeft');
    expect(await focusedSymbol(page)).toBe('"');

    // The roving tabindex followed focus, and there is still exactly one.
    await page.keyboard.press('End');
    expect(
      await page.evaluate(
        () =>
          document.querySelector<HTMLElement>('#symbol-pane .symbol[tabindex="0"]')?.dataset
            .value ?? '',
      ),
    ).toBe('...');
    await expectPaneNavigable(page);
  });

  test('VC-315 (FR-049, BR-305): the pane contributes exactly one tab stop', async ({ page }) => {
    await openPlayground(page);
    await openSymbolPane(page);

    // Start the traversal from the very top of the document, as a fresh page
    // load does. Blurring alone leaves the sequential starting point where it
    // was; a click on the page background moves it (and, per FR-318, leaves
    // the pane open).
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.locator('body').click({ position: { x: 2, y: 2 } });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    const visited: string[] = [];
    // About (+1) and optional `#diag-resizer` under vertical (≥900) need headroom.
    const tabBudget = 21;
    for (let i = 0; i < tabBudget; i++) {
      await page.keyboard.press('Tab');
      visited.push(
        await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el || el === document.body) return '';
          if (el.classList.contains('symbol')) return 'pane';
          if (el.classList.contains('cm-content')) return 'editor';
          if (el.classList.contains('file-tree-button')) return 'file-tree';
          // spec-04 FR-405: the layout radiogroup is one tab stop, whichever
          // of its two radios currently holds the roving `tabindex="0"`.
          if (el.closest('#layout-group')) return 'layout';
          return el.id ? `#${el.id}` : el.tagName.toLowerCase();
        }),
      );
    }

    expect(visited.filter((id) => id === 'pane')).toHaveLength(1);
    // spec-04 VC-407: the layout group contributes exactly one tab stop.
    expect(visited.filter((id) => id === 'layout')).toHaveLength(1);
    // The files pane is open by default at this width (`FilePane`'s
    // `syncLayout`); its own DOM position (after Diagnostics, per FR-317 and
    // FR-410's fixed runs) puts its tab stops after the editor/stdin group.
    // Vertical ≥ 900 inserts `#diag-resizer` between editor and stdin (FR-913).
    const layout = await page.locator('#app').getAttribute('data-layout');
    const diagResizerVisible = await page.locator('#diag-resizer').isVisible();
    const afterEditor =
      layout === 'vertical' && diagResizerVisible
        ? (['#diag-resizer', '#stdin-input', '#btn-eof'] as const)
        : (['#stdin-input', '#btn-eof'] as const);
    const expected = [
      '#btn-run',
      '#btn-stop',
      '#btn-clear',
      '#btn-copy',
      '#btn-format',
      '#btn-reset',
      // spec-04 FR-401: immediately after `Reset`, before `Symbols`.
      'layout',
      '#btn-files',
      '#btn-symbols',
      '#btn-theme',
      // spec-08 FR-801: About is last toolbar control after theme.
      '#btn-about',
      'pane',
      'editor',
      ...afterEditor,
      '#btn-file-new',
      '#btn-file-rename',
      '#btn-file-delete',
      'file-tree',
      '#file-resizer',
    ];
    expect(visited.slice(0, expected.length)).toEqual(expected);
  });

  test('VC-314 (FR-309, FR-306): Enter and Space both copy the focused character', async ({
    page,
  }) => {
    await openPlayground(page);

    for (const key of ['Enter', 'Space']) {
      await openSymbolPane(page);
      // Reach `//` with arrow keys alone: it is row 13 of the wide layout.
      for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowDown');
      expect(await focusedSymbol(page)).toBe('//');

      await page.keyboard.press(key);
      await expect(page.locator('#symbol-status'), key).toHaveText('Copied //');
      await expect(symbolButton(page, '//'), key).toHaveAttribute('data-state', 'copied');
      expect(await page.evaluate(() => navigator.clipboard.readText()), key).toBe('//');

      await page.keyboard.press('Escape');
      await expect(page.locator('#symbol-pane')).toBeHidden();
    }
  });
});

test.describe('narrow layout keyboard model', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test('VC-329 (FR-309, FR-311): row-wise and column-wise moves over the rendered grid', async ({
    page,
  }) => {
    await openPlayground(page);
    await openSymbolPane(page);

    /** The rendered visual rows, as values, derived exactly as FR-309 says. */
    const rows: string[][] = await page.evaluate(() => {
      const out: { top: number; values: string[] }[] = [];
      for (const button of document.querySelectorAll<HTMLElement>('#symbol-pane .symbol')) {
        const top = button.getBoundingClientRect().top;
        const row = out.find((candidate) => Math.abs(candidate.top - top) <= 2);
        if (row) row.values.push(button.dataset.value ?? '');
        else out.push({ top, values: [button.dataset.value ?? ''] });
      }
      return out.sort((a, b) => a.top - b.top).map((row) => row.values);
    });

    expect(rows.length, 'the narrow layout wraps into several rows').toBeGreaterThan(1);
    expect(rows.flat()).toEqual(SYMBOL_VALUES);

    /** Focus the button for `value` without going through the arrow keys. */
    const focus = async (value: string): Promise<void> => {
      await symbolButton(page, value).focus();
    };

    const secondRow = rows[1]!;
    await focus(secondRow[0]!);
    await page.keyboard.press('ArrowLeft');
    expect(await focusedSymbol(page), 'no wrap at a row’s start').toBe(secondRow[0]);

    await page.keyboard.press('ArrowRight');
    expect(await focusedSymbol(page)).toBe(secondRow[1]);

    await focus(secondRow[0]!);
    await page.keyboard.press('ArrowUp');
    expect(await focusedSymbol(page), 'ArrowUp keeps the column index').toBe(rows[0]![0]);

    const lastOfSecond = secondRow[secondRow.length - 1]!;
    await focus(lastOfSecond);
    await page.keyboard.press('ArrowRight');
    expect(await focusedSymbol(page), 'no wrap at a row’s end').toBe(lastOfSecond);

    // A column index past the next row's length clamps to that row's last
    // button rather than moving nowhere.
    const short = rows.findIndex(
      (row, i) => i > 0 && rows[i - 1] !== undefined && row.length < rows[i - 1]!.length,
    );
    expect(short, 'the narrow layout has a shorter row to clamp into').toBeGreaterThan(0);
    const above = rows[short - 1]!;
    await focus(above[above.length - 1]!);
    await page.keyboard.press('ArrowDown');
    expect(await focusedSymbol(page), 'ArrowDown clamps to the shorter row’s last button').toBe(
      rows[short]![rows[short]!.length - 1],
    );

    await page.keyboard.press('Home');
    expect(await focusedSymbol(page)).toBe('"');
    await page.keyboard.press('End');
    expect(await focusedSymbol(page)).toBe('...');
  });
});

/* -------------------------------------------------------------------------
   FR-310 — the pane never reaches a running program
   ------------------------------------------------------------------------- */

test('VC-316 (FR-310, BR-301): copying mid-run interrupts neither the run nor its output', async ({
  page,
}) => {
  test.setTimeout(120_000);

  await openPlayground(page);
  await waitForPythonReady(page);
  await runProgram(page, 'import time\nfor i in range(20):\n    print(i)\n    time.sleep(0.2)\n');

  const run = page.locator('#btn-run');
  const stop = page.getByRole('button', { name: 'Stop' });
  await expect(stop).toBeEnabled();
  await expect(run).toBeDisabled();

  // Sample the two controls continuously while the pane is used.
  const states: string[] = [];
  const sample = async (): Promise<void> => {
    states.push(
      await page.evaluate(
        () =>
          `${document.getElementById('btn-run')!.getAttribute('aria-disabled')}/` +
          `${document.getElementById('btn-stop')!.getAttribute('aria-disabled')}`,
      ),
    );
  };

  await sample();
  await openSymbolPane(page);
  await sample();
  await symbolButton(page, '%').click();
  await expect(page.locator('#symbol-status')).toHaveText('Copied %');
  await sample();
  await page.getByRole('button', { name: 'Symbols' }).click();
  await expect(page.locator('#symbol-pane')).toBeHidden();
  await sample();

  expect(new Set(states), 'Run stayed disabled and Stop stayed enabled').toEqual(
    new Set(['true/false']),
  );
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('%');

  await expect
    .poll(() => consoleText(page), { timeout: 60_000 })
    .toMatch(/Program finished in \d+\.\d{2} s/);

  // The program was neither interrupted nor restarted: 0–19, in order, once.
  expect(await programStdout(page)).toBe(
    Array.from({ length: 20 }, (_, i) => `${i}\n`).join(''),
  );
});

test('VC-317 (FR-310): copying while a read is pending injects nothing into stdin', async ({
  page,
}) => {
  test.setTimeout(120_000);

  await openPlayground(page);
  await waitForPythonReady(page);
  await runProgram(page, 'x = input("? ")\nprint(x)\n');
  await waitForStdinPrompt(page);

  const stdinEnabled = async (): Promise<boolean> =>
    page.evaluate(
      () => document.getElementById('stdin-input')!.getAttribute('aria-disabled') !== 'true',
    );

  expect(await stdinEnabled()).toBe(true);
  await openSymbolPane(page);
  expect(await stdinEnabled()).toBe(true);
  await symbolButton(page, ',').click();
  await expect(page.locator('#symbol-status')).toHaveText('Copied ,');
  expect(await stdinEnabled()).toBe(true);

  // The pane put nothing in the field, and the read is still the one pending.
  expect(await page.inputValue('#stdin-input')).toBe('');

  await submitStdin(page, 'a,b');
  await expect.poll(() => programStdout(page), { timeout: 30_000 }).toBe('a,b\n');
});

/* -------------------------------------------------------------------------
   FR-312 / BR-304 — the pane persists nothing
   ------------------------------------------------------------------------- */

/** Everything spec-01's *Persisted state* table says the origin may hold. */
async function storageSnapshot(page: Page): Promise<{
  local: Record<string, string>;
  session: Record<string, string>;
  cookie: string;
  databases: string[];
}> {
  return page.evaluate(async () => {
    const dump = (store: Storage): Record<string, string> => {
      const out: Record<string, string> = {};
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i)!;
        out[key] = store.getItem(key) ?? '';
      }
      return out;
    };
    const databases = (await indexedDB.databases()).map((db) => db.name ?? '').sort();
    return {
      local: dump(window.localStorage),
      session: dump(window.sessionStorage),
      cookie: document.cookie,
      databases,
    };
  });
}

test('VC-320 (FR-312, BR-304): opening and copying persists nothing, and a reload closes the pane', async ({
  page,
}) => {
  await openPlayground(page);

  // The autosave key only exists once the visitor has edited, and VC-320 names
  // it as the one key that may be there.
  await typeProgram(page, 'print("hi")');
  await expect.poll(() => storedProgram(page)).toBe('print("hi")');

  /*
   * The keys that may legitimately be present: the workspace autosave key,
   * spec-05's `pyplay.theme.v1`, and — under a spec-04 VC-433 run, which loads
   * the parent suites with the layout preference pre-seeded — spec-04's
   * `pyplay.layout.v2`. None is the pane's; what VC-320 asserts is that *the
   * pane* writes nothing, which is the unchanged-snapshot comparisons below,
   * plus the absence of any key outside this set.
   */
  const ALLOWED_KEYS = ['pyplay.layout.v2', 'pyplay.workspace.v1', 'pyplay.theme.v1'];
  const unexpectedKeys = (snapshot: { local: Record<string, string> }): string[] =>
    Object.keys(snapshot.local).filter((key) => !ALLOWED_KEYS.includes(key));

  const before = await storageSnapshot(page);
  expect(Object.keys(before.local)).toContain('pyplay.workspace.v1');
  expect(unexpectedKeys(before)).toEqual([]);

  await openSymbolPane(page);
  await symbolButton(page, '_').click();
  await expect(page.locator('#symbol-status')).toHaveText('Copied _');
  expect(await storageSnapshot(page)).toEqual(before);

  await page.reload();
  await page.waitForSelector('.cm-content');

  // FR-312: the pane is closed again — its open state was never persisted.
  await expect(page.locator('#symbol-pane')).toBeHidden();
  await expect(page.locator('#btn-symbols')).toHaveAttribute('aria-expanded', 'false');
  expect(await storageSnapshot(page)).toEqual(before);
  expect(unexpectedKeys(await storageSnapshot(page))).toEqual([]);
});
