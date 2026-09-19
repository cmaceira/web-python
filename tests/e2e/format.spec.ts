import { expect, test } from '@playwright/test';
import {
  caretPosition,
  consoleText,
  editorText,
  openPlayground,
  openWithoutLinter,
  programStdout,
  runProgram,
  setCaret,
  setProgram,
  typeProgram,
  waitForLinter,
  waitForPythonReady,
} from './helpers';

/** A 50-line file whose every statement needs reformatting (VC-047, VC-069). */
const UNFORMATTED_50 = `${Array.from({ length: 50 }, (_, i) => `a_${i}   =    ${i}`).join('\n')}\n`;
const FORMATTED_50 = `${Array.from({ length: 50 }, (_, i) => `a_${i} = ${i}`).join('\n')}\n`;

test('VC-045 (FR-043): Format replaces the buffer with a PEP 8 reformatting', async ({ page }) => {
  await openPlayground(page);
  await waitForLinter(page);
  await setProgram(page, 'x=1\ny   =    2\n');

  await page.getByRole('button', { name: 'Format' }).click();

  // Ruff always terminates the file with a newline.
  await expect.poll(() => editorText(page)).toBe('x = 1\ny = 2\n');
});

test('VC-046 (BR-007): formatting is idempotent', async ({ page }) => {
  await openPlayground(page);
  await waitForLinter(page);
  await setProgram(page, 'x=1\ny   =    2\ndef  f( a ,b ):\n  return a+b\n');

  const format = page.getByRole('button', { name: 'Format' });
  await format.click();
  await expect.poll(() => editorText(page)).not.toBe('x=1\ny   =    2\ndef  f( a ,b ):\n  return a+b\n');
  const once = await editorText(page);

  await format.click();
  await page.waitForTimeout(200);
  expect(await editorText(page)).toBe(once);
});

test('VC-047 (FR-044): the whole reformat is one undoable edit', async ({ page }) => {
  await openPlayground(page);
  await waitForLinter(page);
  await setProgram(page, UNFORMATTED_50);
  await page.locator('.cm-content').click();

  await page.getByRole('button', { name: 'Format' }).click();
  await expect.poll(() => editorText(page)).toBe(FORMATTED_50);

  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+z');

  // One undo, the exact pre-format contents back.
  await expect.poll(() => editorText(page)).toBe(UNFORMATTED_50);
});

test('VC-069 (FR-059): the caret follows its statement across the reformat', async ({ page }) => {
  await openPlayground(page);
  await waitForLinter(page);
  await setProgram(page, UNFORMATTED_50);

  // Middle of the statement on line 30: `a_29   =    29`.
  await setCaret(page, 30, 8);
  expect(await caretPosition(page)).toMatchObject({ line: 30, column: 8 });

  await page.getByRole('button', { name: 'Format' }).click();
  await expect.poll(() => editorText(page)).toBe(FORMATTED_50);

  // First character of that same statement's reformatted counterpart.
  expect(await caretPosition(page)).toMatchObject({ line: 30, column: 1 });
  const offset = (await caretPosition(page)).offset;
  expect(FORMATTED_50.slice(offset, offset + 'a_29 = 29'.length)).toBe('a_29 = 29');
});

test('VC-048 (FR-045): Format refuses on a syntax error and leaves the buffer alone', async ({
  page,
}) => {
  await openPlayground(page);
  await waitForLinter(page);
  await setProgram(page, 'def f(:\n');

  await page.getByRole('button', { name: 'Format' }).click();

  await expect(page.locator('.notice')).toHaveText("Can't format — fix the syntax error first.");
  expect(await editorText(page)).toBe('def f(:\n');
});

test('VC-009 (FR-009): Shift+Alt+F formats from the editor', async ({ page }) => {
  await openPlayground(page);
  await waitForLinter(page);
  await typeProgram(page, 'x=1');

  await page.locator('.cm-content').press('Shift+Alt+f');

  await expect.poll(() => editorText(page)).toBe('x = 1\n');
});

test('VC-070 (FR-058): without the engine, Format is disabled and inert', async ({ page }) => {
  await openWithoutLinter(page);
  await expect
    .poll(() => page.locator('#diagnostics-empty').textContent(), { timeout: 15_000 })
    .toBe('Linter unavailable.');

  const format = page.locator('#btn-format');
  await expect(format).toBeDisabled();
  await expect(format).toHaveAttribute('aria-disabled', 'true');

  await typeProgram(page, 'x=1');
  const before = await editorText(page);

  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  // Pointer: a disabled control swallows the click outright.
  await format.click({ force: true });
  // Keyboard: focus it and try both activation keys.
  await format.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  // The FR-009 shortcut.
  await page.locator('.cm-content').press('Shift+Alt+f');

  await page.waitForTimeout(300);
  expect(await editorText(page)).toBe(before);
  expect(errors).toEqual([]);
});

test('VC-083 (BR-006, issue #41): formatting is unavailable while code is executing', async ({
  page,
}) => {
  await openPlayground(page);
  await waitForPythonReady(page);
  await waitForLinter(page);

  await runProgram(page, 'import time\nfor _ in range(10):\n    print("tick")\n    time.sleep(1)\n');

  // Wait until the run is genuinely under way.
  await expect.poll(() => consoleText(page)).toContain('tick');

  const before = await editorText(page);
  const format = page.getByRole('button', { name: 'Format' });
  await expect(format).toBeDisabled();
  await format.dispatchEvent('click');
  expect(await editorText(page)).toBe(before);

  // The run is untouched: it keeps printing `tick`, roughly once per second.
  const ticksBefore = (await programStdout(page)).split('tick').length - 1;
  await page.waitForTimeout(2500);
  const ticksAfter = (await programStdout(page)).split('tick').length - 1;
  expect(ticksAfter).toBeGreaterThan(ticksBefore);
  expect(await editorText(page)).toBe(before);

  // Stop the still-running program so the fixture tears down cleanly.
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(format).toBeEnabled({ timeout: 5_000 });
});
