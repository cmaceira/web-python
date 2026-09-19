import { expect, test, type Page } from '@playwright/test';
import { consoleText, editorText, runProgram, statusText, waitForPythonReady } from './helpers';

const READY_LINE = /Python 3\.\d+\.\d+ ready/g;
const TERMINATION = /Program (finished in \d+\.\d{2} s|exited with an error\.)/g;

/** Load the playground and wait until Python is ready to run (FR-013). */
async function openReady(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForSelector('.cm-content');
  await waitForPythonReady(page);
  // A witness that survives only as long as this document does: any page
  // reload would wipe it, which is what FR-064 forbids.
  await page.evaluate(() => {
    (window as unknown as { __documentWitness?: string }).__documentWitness = 'alive';
  });
}

/** True while the very document opened by `openReady` is still current. */
async function sameDocument(page: Page): Promise<boolean> {
  return page.evaluate(
    () => (window as unknown as { __documentWitness?: string }).__documentWitness === 'alive',
  );
}

/** Wait until the current run has reported termination. */
async function waitForTermination(page: Page, expected = 1): Promise<void> {
  await expect
    .poll(async () => (await consoleText(page)).match(TERMINATION)?.length ?? 0, {
      timeout: 30_000,
    })
    .toBe(expected);
}

/** Start a run and wait until Stop reports a program is actually in flight. */
async function startRun(page: Page, code: string): Promise<void> {
  await runProgram(page, code);
  await expect(page.getByRole('button', { name: 'Stop' })).toBeEnabled();
}

test('VC-024 (FR-023, FR-024, NFR-006, NFR-014, BR-003): Stop kills a non-terminating loop and the runtime comes back', async ({
  page,
}) => {
  await openReady(page);
  await startRun(page, 'while True: pass\n');

  // Two seconds of a loop that never yields control (FR-024).
  await page.waitForTimeout(2000);

  // The page is still accepting clicks while the loop spins (BR-003).
  const copy = page.locator('#btn-copy');
  await copy.click();
  await expect(copy).toHaveText('Copied');

  const startedAt = Date.now();
  await page.getByRole('button', { name: 'Stop' }).click();
  await page.waitForFunction(
    () => (document.getElementById('console')?.textContent ?? '').includes('Program stopped.'),
    undefined,
    { timeout: 5_000 },
  );
  // NFR-006: `Program stopped.` is painted within 500 ms of the activation.
  expect(Date.now() - startedAt).toBeLessThan(500);

  // FR-065: recovery is announced while it runs.
  expect(await statusText(page)).toBe('Restarting Python…');
  await expect(page.locator('#btn-run')).toBeDisabled();

  // NFR-014 / FR-064: Run is usable again within 5.0 s, without a reload.
  await expect(page.locator('#btn-run')).toBeEnabled({ timeout: 5_000 });
  expect(Date.now() - startedAt).toBeLessThan(5_000);
  expect(await statusText(page)).not.toBe('Restarting Python…');
  expect(await sameDocument(page)).toBe(true);

  // The recovered runtime runs programs again (FR-023).
  await runProgram(page, 'print("ok")');
  await waitForTermination(page, 1);
  expect((await consoleText(page)).split('\n')).toContain('ok');

  // The page still accepts clicks after recovery.
  await expect(copy).toHaveText('Copy code');
  await copy.click();
  await expect(copy).toHaveText('Copied');
});

test('VC-079 (FR-064, NFR-014, BR-003): the stop-then-run cycle needs no reload and appends no second ready line', async ({
  page,
}) => {
  await openReady(page);
  expect((await consoleText(page)).match(READY_LINE) ?? []).toHaveLength(1);

  await startRun(page, 'while True: pass\n');
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.locator('#btn-run')).toBeEnabled({ timeout: 5_000 });

  await runProgram(page, 'print("ok")');
  await waitForTermination(page, 1);

  const text = await consoleText(page);
  expect(text.split('\n')).toContain('ok');
  expect(text).toMatch(/Program finished in \d+\.\d{2} s/);
  // FR-064: recovery is silent — still exactly one `Python … ready` line.
  expect(text.match(READY_LINE) ?? []).toHaveLength(1);
  expect(text).toContain('Program stopped.');
  expect(await sameDocument(page)).toBe(true);
});

test('VC-025 (FR-025, BR-004): each run starts from a clean interpreter state', async ({
  page,
}) => {
  await openReady(page);

  await runProgram(page, 'x = 5\n');
  await waitForTermination(page, 1);

  await runProgram(page, 'print(x)\n');
  await waitForTermination(page, 2);

  const text = await consoleText(page);
  expect(text).toContain("NameError: name 'x' is not defined");
  expect(text).toContain('Program exited with an error.');
});

test('VC-026 (FR-025 after crash): a run after a crash leaves no residue', async ({ page }) => {
  await openReady(page);

  await runProgram(page, 'leftover = 1\nraise ValueError("boom")\n');
  await waitForTermination(page, 1);
  expect(await consoleText(page)).toContain('ValueError: boom');

  await runProgram(page, 'print("ok")\n');
  await waitForTermination(page, 2);

  const text = await consoleText(page);
  expect(text.split('\n')).toContain('ok');
  // The second run neither re-reported the old failure nor inherited its names.
  expect(text.match(/ValueError: boom/g) ?? []).toHaveLength(1);
  expect(text.match(/Program exited with an error\./g) ?? []).toHaveLength(1);

  await runProgram(page, 'print(leftover)\n');
  await waitForTermination(page, 3);
  expect(await consoleText(page)).toContain("NameError: name 'leftover' is not defined");
});

test('VC-064 (FR-054): the complete Stop control cycle, inert while disabled', async ({ page }) => {
  await openReady(page);
  const stop = page.locator('#btn-stop');

  // Present at all times, and visibly disabled while nothing is running.
  await expect(stop).toBeVisible();
  await expect(stop).toBeDisabled();

  const disabledStyle = await stop.evaluate((el) => {
    const style = getComputedStyle(el);
    return { background: style.backgroundColor, color: style.color, cursor: style.cursor };
  });

  // Non-activatable by pointer: a real click, and a synthetic one that no
  // pointer-events rule could swallow.
  await stop.click({ force: true });
  await stop.dispatchEvent('click');

  // Non-activatable by keyboard: focus it outright, then Enter and Space.
  await stop.evaluate((el: HTMLButtonElement) => el.focus());
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');

  // Nothing happened: no console output at all beyond the ready line.
  const idleText = await consoleText(page);
  expect(idleText).not.toContain('Program stopped.');
  expect(idleText).not.toContain('Restarting Python…');
  expect(await statusText(page)).not.toBe('Restarting Python…');
  await expect(page.locator('#btn-run')).toBeEnabled();

  // Enabled if and only if a program is running.
  await startRun(page, 'import time\ntime.sleep(2)\n');
  const enabledStyle = await stop.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(enabledStyle).not.toBe(disabledStyle.background);
  expect(disabledStyle.cursor).toBe('not-allowed');

  // ...and disabled again when the run finishes on its own.
  await waitForTermination(page, 1);
  await expect(stop).toBeDisabled();
  expect(await consoleText(page)).not.toContain('Program stopped.');
});

test('VC-060 (BR-003): a runaway loop never occupies the main thread', async ({ page }) => {
  await openReady(page);
  const code = 'while True: pass\n';
  await startRun(page, code);
  await page.waitForTimeout(1000);

  // Issue #41: the responsive UI keeps the editor locked during execution.
  const editor = page.locator('.cm-content');
  await expect(editor).toHaveAttribute('contenteditable', 'false');
  await editor.click();
  await page.keyboard.type('x = 1');
  expect(await editorText(page)).toBe(code);

  // ...and the diagnostics panel still renders and responds.
  const panel = page.locator('.panel--diagnostics');
  await expect(panel).toBeVisible();
  await panel.click();
  expect(await panel.textContent()).toContain('Problems');

  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.locator('#btn-run')).toBeEnabled({ timeout: 5_000 });
  await expect(editor).toHaveAttribute('contenteditable', 'true');
});

/**
 * VC-059 (BR-008) — the spec's own check is a 6-minute untouched run. That is
 * far too slow for every suite run, so it ships in two halves:
 *
 *  - a fast variant, always run, that leaves the same program untouched for
 *    20 s — long enough that any plausible watchdog would already have fired;
 *  - the literal 6-minute variant, skipped unless `RUN_LONG=1` is set.
 *
 * The static half of the guarantee — that no timeout logic exists anywhere in
 * the run code path at all — is asserted by `tests/unit/no-timeout.test.ts`.
 */
const LONG_PROGRAM = 'import time\nfor i in range(400): time.sleep(1)\n';

/** Assert the run is still alive and nothing timed it out. */
async function expectStillRunning(page: Page): Promise<void> {
  const text = await consoleText(page);
  expect(text).not.toMatch(TERMINATION);
  expect(text).not.toContain('Program stopped.');
  expect(text.toLowerCase()).not.toContain('timeout');
  expect(text.toLowerCase()).not.toContain('timed out');
  await expect(page.getByRole('button', { name: 'Stop' })).toBeEnabled();
  await expect(page.locator('#btn-run')).toBeDisabled();
  expect(await statusText(page)).not.toBe('Restarting Python…');
}

test('VC-059 (BR-008, fast variant): a long run is not timed out', async ({ page }) => {
  test.setTimeout(120_000);
  await openReady(page);
  await startRun(page, LONG_PROGRAM);

  await page.waitForTimeout(20_000);
  await expectStillRunning(page);

  // Only the visitor ends it.
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.locator('#btn-run')).toBeEnabled({ timeout: 5_000 });
  expect(await consoleText(page)).toContain('Program stopped.');
});

test('VC-059 (BR-008): a 6-minute untouched run is still running', async ({ page }) => {
  test.skip(process.env.RUN_LONG !== '1', 'set RUN_LONG=1 to run the 6-minute check');
  test.setTimeout(600_000);

  await openReady(page);
  await startRun(page, LONG_PROGRAM);

  await page.waitForTimeout(6 * 60_000);
  await expectStillRunning(page);
});
