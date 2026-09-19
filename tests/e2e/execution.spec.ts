import { expect, test, type Page } from '@playwright/test';
import { consoleText, runProgram, setProgram, waitForPythonReady } from './helpers';

const SEPARATOR = /─── Running ([^\n]+) at (\d{2}):(\d{2}):(\d{2}) ───/g;

/** Load the playground and wait until Python is ready to run (FR-013). */
async function openReady(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForSelector('.cm-content');
  await waitForPythonReady(page);
}

/** Wait until the current run has reported termination. */
async function waitForTermination(page: Page, expected = 1): Promise<void> {
  await expect
    .poll(
      async () => {
        const text = await consoleText(page);
        return (text.match(/Program (finished in \d+\.\d{2} s|exited with an error\.)/g) ?? [])
          .length;
      },
      { timeout: 30_000 },
    )
    .toBe(expected);
}

test('VC-016 (FR-016, FR-019): print lands on its own console line', async ({ page }) => {
  await openReady(page);
  await runProgram(page, 'print("hello")');
  await waitForTermination(page);
  expect((await consoleText(page)).split('\n')).toContain('hello');
});

test('VC-017 (FR-019): output streams as it is produced, not at the end', async ({ page }) => {
  // Timestamp every console append in the page, so the measurement is not
  // limited by the resolution of test-side polling.
  await page.addInitScript(() => {
    const marks: { t: number; text: string }[] = [];
    (window as unknown as { __marks: typeof marks }).__marks = marks;
    // Console painting coalesces same-styled output into one span, so text can
    // arrive either as a new node or as a rewrite of the last one.
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'characterData') {
          marks.push({ t: performance.now(), text: record.target.textContent ?? '' });
          continue;
        }
        for (const node of record.addedNodes) {
          marks.push({ t: performance.now(), text: node.textContent ?? '' });
        }
      }
    });
    document.addEventListener('DOMContentLoaded', () => {
      observer.observe(document.getElementById('console')!, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    });
  });

  await openReady(page);
  await runProgram(page, 'import time\nfor i in range(3):\n    print(i)\n    time.sleep(1)\n');
  await waitForTermination(page);

  const marks = await page.evaluate(
    () => (window as unknown as { __marks: { t: number; text: string }[] }).__marks,
  );
  const at = (needle: string): number => {
    const mark = marks.find((m) => m.text.includes(needle));
    if (!mark) throw new Error(`console never showed ${JSON.stringify(needle)}`);
    return mark.t;
  };

  // `0` was painted well before the program ended (FR-019).
  expect(at('Program finished in') - at('0\n')).toBeGreaterThan(1500);
  // ...and the three lines arrived a second apart, not in one burst.
  expect(at('1\n') - at('0\n')).toBeGreaterThan(700);
  expect(at('2\n') - at('1\n')).toBeGreaterThan(700);
});

test('VC-018 (FR-019): tabs and leading spaces survive unchanged', async ({ page }) => {
  await openReady(page);
  await runProgram(page, 'print("a\\tb")\nprint("  indented")\n');
  await waitForTermination(page);

  const text = await consoleText(page);
  expect(text).toContain('a\tb\n');
  expect(text).toContain('  indented\n');
});

test('VC-019 (FR-017): Run is disabled for the whole run, so only one program is in flight', async ({
  page,
}) => {
  await openReady(page);
  await runProgram(page, 'import time; time.sleep(3)');

  const run = page.locator('#btn-run');
  await expect(run).toBeDisabled();
  // Even a synthetic activation must not start a second run.
  await run.dispatchEvent('click');
  await expect(run).toBeDisabled();

  await waitForTermination(page);
  await expect(run).toBeEnabled();
  expect((await consoleText(page)).match(SEPARATOR) ?? []).toHaveLength(1);
});

test('VC-064 (FR-054, Iteration 2 part): Stop is enabled only while a program runs', async ({
  page,
}) => {
  await openReady(page);
  const stop = page.getByRole('button', { name: 'Stop' });

  await expect(stop).toBeVisible();
  await expect(stop).toBeDisabled();

  await runProgram(page, 'import time; time.sleep(2)');
  await expect(stop).toBeEnabled();

  await waitForTermination(page);
  await expect(stop).toBeDisabled();
});

test('VC-020 (FR-018): each run appends a 24-hour separator without clearing the console', async ({
  page,
}) => {
  await openReady(page);

  await runProgram(page, 'print(1)');
  await waitForTermination(page, 1);

  const before = await page.evaluate(() => Date.now());
  await runProgram(page, 'print(2)');
  await waitForTermination(page, 2);
  const after = await page.evaluate(() => Date.now());

  const text = await consoleText(page);
  const matches = [...text.matchAll(SEPARATOR)];
  expect(matches).toHaveLength(2);

  // The first run's output was not erased, and the ordering is run 1, separator, run 2.
  const lines = text.split('\n');
  expect(lines).toContain('1');
  expect(lines).toContain('2');
  expect(text.indexOf('\n1\n')).toBeLessThan(text.lastIndexOf('─── Running'));
  expect(text.lastIndexOf('─── Running')).toBeLessThan(text.lastIndexOf('2'));

  // The second separator carries the visitor's local wall-clock time, 24-hour.
  const [, filename, hh, mm, ss] = matches[1];
  expect(filename).toBe('main.py');
  expect(Number(hh)).toBeLessThanOrEqual(23);
  const window = await page.evaluate(
    ([start, end, h, m, s]) => {
      const stamp = (t: number) => {
        const d = new Date(t as number);
        return [d.getHours(), d.getMinutes(), d.getSeconds()];
      };
      const secs = ([a, b, c]: number[]) => a * 3600 + b * 60 + c;
      const shown = secs([Number(h), Number(m), Number(s)]);
      return shown >= secs(stamp(start as number)) - 1 && shown <= secs(stamp(end as number)) + 1;
    },
    [before, after, hh, mm, ss] as const,
  );
  expect(window).toBe(true);
});

test('VC-021 (FR-020): stderr carries the literal prefix and a distinct colour', async ({
  page,
}) => {
  await openReady(page);
  await runProgram(page, 'import sys\nprint("out")\nsys.stderr.write("boom\\n")\n');
  await waitForTermination(page);

  expect((await consoleText(page)).split('\n')).toContain('[stderr] boom');

  const colours = await page.evaluate(() => ({
    stdout: getComputedStyle(document.querySelector('.console-stdout')!).color,
    stderr: getComputedStyle(document.querySelector('.console-stderr')!).color,
  }));
  expect(colours.stderr).not.toBe(colours.stdout);
});

test('VC-022 (FR-021): an uncaught exception shows the full traceback and the notice', async ({
  page,
}) => {
  await openReady(page);
  await runProgram(page, 'a = 1\nb = 0\na / b\n');
  await waitForTermination(page);

  const text = await consoleText(page);
  expect(text).toContain('Traceback (most recent call last):');
  expect(text).toContain('line 3');
  expect(text).toContain('ZeroDivisionError');
  expect(text).toContain('division by zero');
  expect(text.indexOf('ZeroDivisionError')).toBeLessThan(
    text.indexOf('Program exited with an error.'),
  );
  expect(text).not.toContain('Program finished in');
  await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'true');
});

test('VC-023 (FR-022): a normal return reports a two-decimal duration', async ({ page }) => {
  await openReady(page);
  await runProgram(page, 'pass');
  await waitForTermination(page);
  expect(await consoleText(page)).toMatch(/Program finished in \d+\.\d{2} s/);
  await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'true');
});

test('VC-065 (FR-055): empty and comment-only programs finish normally', async ({ page }) => {
  await openReady(page);

  await runProgram(page, '');
  await waitForTermination(page, 1);
  let text = await consoleText(page);
  expect(text).toMatch(SEPARATOR);
  expect(text).toMatch(/Program finished in \d+\.\d{2} s/);
  expect(text).not.toContain('Traceback');

  await runProgram(page, '# nada\n\n');
  await waitForTermination(page, 2);
  text = await consoleText(page);
  expect((text.match(/Program finished in \d+\.\d{2} s/g) ?? [])).toHaveLength(2);
  expect(text).not.toContain('Traceback');
  expect(text).not.toContain('Program exited with an error.');
});

test('VC-008 (FR-008): Ctrl/Cmd+Enter in the editor runs the program', async ({ page }) => {
  await openReady(page);
  await setProgram(page, 'print("via shortcut")');

  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+Enter');

  await waitForTermination(page);
  const text = await consoleText(page);
  expect(text.split('\n')).toContain('via shortcut');
  expect(text.match(SEPARATOR) ?? []).toHaveLength(1);
  // The shortcut must not have inserted a newline into the buffer.
  expect(await page.evaluate(() => document.querySelectorAll('.cm-content .cm-line').length)).toBe(
    1,
  );
});
