import { expect, test } from '@playwright/test';
import {
  caretPosition,
  consoleText,
  diagnosticEntries,
  diagnosticsPanelState,
  editorText,
  openPlayground,
  openWithoutLinter,
  runProgram,
  setProgram,
  typeProgram,
  waitForLinter,
  waitForPythonReady,
} from './helpers';

/** FR-035's idle window plus NFR-007's round-trip budget, with slack. */
const LINT_SETTLE_MS = 400 + 300;

test('VC-038 (FR-035, FR-036, FR-037): an underline, a gutter icon and a tooltip', async ({
  page,
}) => {
  await openPlayground(page);
  await waitForLinter(page);
  await typeProgram(page, 'print(undefined_name)');

  // FR-036: the marker covers the exact source range, with a gutter icon.
  const mark = page.locator('.cm-content .cm-diagnostic-mark.cm-diagnostic-error');
  await expect(mark).toHaveText('undefined_name', { timeout: LINT_SETTLE_MS + 2000 });
  await expect(page.locator('.cm-diagnostic-gutter .cm-diagnostic-gutter-error')).toHaveCount(1);

  // FR-037: hovering shows the rule code and the human-readable message.
  await mark.hover();
  const tooltip = page.locator('.cm-diagnostic-tooltip');
  await expect(tooltip).toBeVisible();
  const text = (await tooltip.textContent()) ?? '';
  expect(text).toContain('F821');
  expect(text).toContain('Undefined name');
  expect(text).toContain('·');
});

test('VC-039 (FR-035): a new pass replaces the previous diagnostics entirely', async ({ page }) => {
  await openPlayground(page);
  await waitForLinter(page);
  await typeProgram(page, 'print(undefined_name)');
  await expect(page.locator('.cm-content .cm-diagnostic-mark')).toHaveCount(1, {
    timeout: LINT_SETTLE_MS + 2000,
  });

  await setProgram(page, 'undefined_name = 1\nprint(undefined_name)\n');

  // No marker, no gutter icon, no panel entry from the stale pass survives.
  await expect(page.locator('.cm-content .cm-diagnostic-mark')).toHaveCount(0, {
    timeout: LINT_SETTLE_MS + 2000,
  });
  await expect(page.locator('.cm-diagnostic-gutter .cm-diagnostic-gutter-icon')).toHaveCount(0);
  expect(await diagnosticEntries(page)).toEqual([]);
});

test('VC-040 (FR-038): the panel lists every diagnostic, ordered, with a live count', async ({
  page,
}) => {
  await openPlayground(page);
  await waitForLinter(page);
  // A warning on line 1 (unused import) and an error on line 4 (undefined name).
  await setProgram(page, 'import os\n\n\nprint(faltante)\n');

  await expect
    .poll(() => diagnosticEntries(page), { timeout: LINT_SETTLE_MS + 2000 })
    .toHaveLength(2);

  const entries = await diagnosticEntries(page);
  // FR-038: ordered by line, then column, formatted `line:col · code · message`.
  expect(entries[0]).toBe('1:8 · F401 · `os` imported but unused');
  expect(entries[1]).toBe('4:7 · F821 · Undefined name `faltante`');

  const panel = await diagnosticsPanelState(page);
  expect(panel.count).toBe('2');
  expect(panel.emptyHidden).toBe(true);
});

test('VC-041 (FR-039): activating an entry scrolls to it and places the caret', async ({ page }) => {
  await openPlayground(page);
  await waitForLinter(page);

  const lines = Array.from({ length: 100 }, (_, i) =>
    i === 39 ? 'print(faltante)' : `valor_${i} = ${i}`,
  );
  await setProgram(page, `${lines.join('\n')}\n`);

  await expect
    .poll(() => diagnosticEntries(page), { timeout: LINT_SETTLE_MS + 2000 })
    .toEqual(['40:7 · F821 · Undefined name `faltante`']);

  // Vertical content-floor default may clip entries; enlarge so the click lands.
  const diagResizer = page.locator('#diag-resizer');
  if (await diagResizer.isVisible()) {
    await diagResizer.focus();
    for (let i = 0; i < 20; i++) await diagResizer.press('ArrowUp');
  }

  // Line 40 is far outside the initial viewport of a 100-line file.
  const entry = page.locator('#diagnostics-list .diagnostic-entry').first();
  await entry.click();

  await expect(page.locator('.cm-content .cm-line', { hasText: 'print(faltante)' })).toBeInViewport();
  expect(await caretPosition(page)).toMatchObject({ line: 40, column: 7 });
});

test('VC-042 (FR-040): a clean program shows the empty state', async ({ page }) => {
  await openPlayground(page);
  await waitForLinter(page);
  await setProgram(page, 'print("ok")\n');

  await expect
    .poll(() => diagnosticsPanelState(page), { timeout: LINT_SETTLE_MS + 2000 })
    .toMatchObject({ count: '0', empty: 'No problems found.', emptyHidden: false });
  expect(await diagnosticEntries(page)).toEqual([]);
});

test('VC-043 (FR-041): a syntax error is an error-severity diagnostic at its position', async ({
  page,
}) => {
  await openPlayground(page);
  await waitForLinter(page);
  // Dispatch the buffer rather than type it: auto-closed `()` would otherwise
  // leave `def f(:)` and move the diagnostic column (FR-1201).
  await setProgram(page, 'def f(:');

  await expect
    .poll(() => diagnosticEntries(page), { timeout: LINT_SETTLE_MS + 2000 })
    .not.toHaveLength(0);

  const first = page.locator('#diagnostics-list .diagnostic-entry').first();
  // The parser's own message, at the offending position, at error severity.
  await expect(first).toHaveAttribute('data-severity', 'error');
  await expect(first).toHaveText(
    '1:7 · invalid-syntax · Expected a parameter or the end of the parameter list',
  );
  await expect(page.locator('.cm-content .cm-diagnostic-mark.cm-diagnostic-error')).not.toHaveCount(
    0,
  );
});

test('VC-044 (FR-042, BR-006): a warning never gates Run', async ({ page }) => {
  await openPlayground(page);
  await waitForPythonReady(page);
  await waitForLinter(page);
  await setProgram(page, 'import os\nprint("still runs")\n');

  // The unused-import warning is on screen when Run is activated.
  await expect
    .poll(() => diagnosticEntries(page), { timeout: LINT_SETTLE_MS + 2000 })
    .toEqual(['1:8 · F401 · `os` imported but unused']);

  const runBtn = page.locator('#btn-run');
  await expect(runBtn).toBeEnabled();
  await runBtn.click();

  await expect.poll(() => consoleText(page)).toContain('still runs');
  await expect.poll(() => consoleText(page)).toContain('Program finished in');
});

test('VC-061 (FR-042, BR-006): an error-severity diagnostic never gates Run either', async ({
  page,
}) => {
  await openPlayground(page);
  await waitForPythonReady(page);
  await waitForLinter(page);
  await setProgram(page, 'print(nunca_definido)\n');

  await expect
    .poll(() => diagnosticEntries(page), { timeout: LINT_SETTLE_MS + 2000 })
    .toEqual(['1:7 · F821 · Undefined name `nunca_definido`']);
  await expect(page.locator('#diagnostics-list .diagnostic-entry').first()).toHaveAttribute(
    'data-severity',
    'error',
  );

  const runBtn = page.locator('#btn-run');
  await expect(runBtn).toBeEnabled();
  await runBtn.click();

  // The failure came from CPython at run time, not from the page refusing.
  await expect.poll(() => consoleText(page)).toContain('NameError');
  expect(await consoleText(page)).toContain('Program exited with an error.');
});

test('VC-049 (FR-046, BR-009): a missing engine degrades the linter alone', async ({ page }) => {
  await openWithoutLinter(page);

  await expect
    .poll(() => diagnosticsPanelState(page), { timeout: 15_000 })
    .toMatchObject({ empty: 'Linter unavailable.', emptyHidden: false });

  // Editing still works…
  await typeProgram(page, 'print("sigue andando")');
  expect(await editorText(page)).toBe('print("sigue andando")');

  // …and so does Run.
  await waitForPythonReady(page);
  await runProgram(page, 'print("sigue andando")\n');
  await expect.poll(() => consoleText(page)).toContain('sigue andando');
});
