import { expect, test, type Page } from '@playwright/test';
import {
  diagnosticEntries,
  editorText,
  openPlayground,
  openWithoutLinter,
  storedProgram,
  typeProgram,
  waitForLinter,
  waitForPythonReady,
} from './helpers';

const popup = (page: Page) => page.locator('.cm-tooltip-autocomplete');
const options = (page: Page) => popup(page).getByRole('option');

async function typeAndWait(page: Page, text: string): Promise<void> {
  await typeProgram(page, text);
  if (!text) await page.keyboard.press('Control+Space');
  await expect(popup(page)).toBeVisible();
}

test('VC-607 (FR-601, FR-602, FR-605): automatic and explicit name completion', async ({
  page,
}) => {
  await openPlayground(page);

  await typeAndWait(page, 'pri');
  await expect(options(page).filter({ hasText: /^print$/ })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  expect(await editorText(page)).toBe('print');

  await typeAndWait(page, 'def greet(student_name):\n    stu');
  await page.keyboard.press('Enter');
  expect(await editorText(page)).toContain('student_name');

  await typeAndWait(page, 'ret');
  await page.keyboard.press('Enter');
  expect(await editorText(page)).toBe('return');

  await typeProgram(page, '');
  await page.keyboard.press('Control+Space');
  await expect(popup(page)).toBeVisible();
  expect(await options(page).count()).toBeGreaterThan(20);
  await expect(options(page).first()).toHaveAttribute('aria-selected', 'true');
});

test('VC-608 (FR-606): arrows, pages, Enter, pointer, Escape, and Tab use standard UI behavior', async ({
  page,
}) => {
  await openPlayground(page);
  await typeAndWait(page, '');

  const firstLabel = await options(page).first().textContent();
  await page.keyboard.press('ArrowDown');
  await expect(popup(page).locator('[role="option"][aria-selected="true"]')).toHaveCount(1);
  await page.keyboard.press('PageDown');
  await expect(popup(page).locator('[role="option"][aria-selected="true"]')).toHaveCount(1);
  expect(await popup(page).locator('[role="option"][aria-selected="true"]').textContent()).not.toBe(
    firstLabel,
  );

  await page.keyboard.press('Escape');
  await expect(popup(page)).toBeHidden();

  await typeAndWait(page, 'pri');
  await options(page).filter({ hasText: /^print$/ }).click();
  expect(await editorText(page)).toBe('print');

  await typeAndWait(page, 'pri');
  await page.keyboard.press('Tab');
  await expect(popup(page)).toBeHidden();
  expect(await editorText(page)).toBe('print');
  await expect(page.locator('.cm-content')).toBeFocused();

  // Leave the editor for the next sequential stop. Vertical ≥ 900 inserts
  // `#diag-resizer` between editor and stdin (FR-913); stacked / narrow skip it.
  await page.keyboard.press('Tab');
  const layout = await page.locator('#app').getAttribute('data-layout');
  const diagResizerVisible = await page.locator('#diag-resizer').isVisible();
  if (layout === 'vertical' && diagResizerVisible) {
    await expect(page.locator('#diag-resizer')).toBeFocused();
    await page.keyboard.press('Tab');
  }
  await expect(page.locator('#stdin-input')).toBeFocused();
});

test('VC-609 (FR-604): keyword acceptance never inserts a snippet or placeholder', async ({ page }) => {
  await openPlayground(page);
  await typeAndWait(page, 'fo');
  await options(page).filter({ hasText: /^for$/ }).click();

  expect(await editorText(page)).toBe('for');
  expect(await editorText(page)).not.toContain('${');
  await expect(page.locator('.cm-snippetField')).toHaveCount(0);
});

test('VC-610 (FR-607): comments, strings, formatted strings, and members suppress completion', async ({
  page,
}) => {
  await openPlayground(page);

  for (const text of ['# pri', '"pri', 'f"{pri', 'value.pri']) {
    await typeProgram(page, text);
    await page.keyboard.press('Control+Space');
    await page.waitForTimeout(150);
    await expect(popup(page), text).toBeHidden();
  }
});

test('VC-611 (FR-608): acceptance is one undoable edit observed by autosave and lint', async ({
  page,
}) => {
  await openPlayground(page);
  await waitForLinter(page);
  await typeAndWait(page, 'ret');
  await page.keyboard.press('Enter');
  expect(await editorText(page)).toBe('return');

  await page.keyboard.press('ControlOrMeta+z');
  expect(await editorText(page)).toBe('ret');
  // `Mod-y` is CodeMirror's redo on Windows/Linux only; `Mod-Shift-z` is
  // bound on every platform (see layout-state.spec.ts).
  await page.keyboard.press('ControlOrMeta+Shift+Z');
  expect(await editorText(page)).toBe('return');

  await expect.poll(() => storedProgram(page)).toBe('return');
  await expect.poll(() => diagnosticEntries(page)).not.toHaveLength(0);
});

test('VC-612 (FR-609): completion works while Python loads and after runtime failure', async ({
  page,
}) => {
  await page.route('**/pyodide/python_stdlib.zip', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await route.abort();
  });
  await page.goto('/');
  await page.waitForSelector('.cm-content');

  await typeAndWait(page, 'pri');
  await page.keyboard.press('Enter');
  expect(await editorText(page)).toBe('print');

  await expect(page.locator('#status-bar')).toHaveText('Python unavailable', { timeout: 30_000 });
  await typeAndWait(page, 'ret');
  await page.keyboard.press('Enter');
  expect(await editorText(page)).toBe('return');
});

test('VC-613 (FR-609): editing and completion do not alter an executing snapshot', async ({ page }) => {
  await openPlayground(page);
  await waitForPythonReady(page);
  await typeProgram(page, 'import time\ntime.sleep(0.5)\nprint("snapshot")');
  await page.getByRole('button', { name: 'Run' }).click();

  await typeProgram(page, 'pri');
  await page.keyboard.press('Control+Space');
  await expect(popup(page)).toBeVisible();
  await page.keyboard.press('Enter');
  expect(await editorText(page)).toBe('print');
  await expect(page.locator('#console')).toContainText('snapshot');
});

test('VC-614 (FR-609): completion remains available when Ruff fails', async ({ page }) => {
  await openWithoutLinter(page);
  await expect(page.getByRole('button', { name: 'Format' })).toBeDisabled();
  await typeAndWait(page, 'pri');
  await page.keyboard.press('Enter');
  expect(await editorText(page)).toBe('print');
});

test('VC-619 (NFR-601, NFR-602): popup fits a 375 px viewport with listbox semantics', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await openPlayground(page);
  await typeAndWait(page, '');

  const geometry = await page.evaluate(() => {
    const popup = document.querySelector('.cm-tooltip-autocomplete')!.getBoundingClientRect();
    return {
      popupLeft: popup.left,
      popupRight: popup.right,
      pageWidth: document.documentElement.scrollWidth,
      listRole: document.querySelector('.cm-tooltip-autocomplete ul')?.getAttribute('role'),
      selected: document.querySelectorAll(
        '.cm-tooltip-autocomplete [role="option"][aria-selected="true"]',
      ).length,
    };
  });

  expect(geometry.popupLeft).toBeGreaterThanOrEqual(0);
  expect(geometry.popupRight).toBeLessThanOrEqual(375);
  expect(geometry.pageWidth).toBeLessThanOrEqual(375);
  expect(geometry.listRole).toBe('listbox');
  expect(geometry.selected).toBe(1);
});
