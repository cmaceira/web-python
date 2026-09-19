import { spawnSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import {
  consoleSpans,
  consoleText,
  editorText,
  programStdout,
  runProgram,
  submitStdin,
  waitForPythonReady,
  waitForStdinPrompt,
} from './helpers';

const FINISHED = /Program finished in \d+\.\d{2} s/;

/** Load the playground and wait until Python is ready to run (FR-013). */
async function openReady(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForSelector('.cm-content');
  await waitForPythonReady(page);
  await page.evaluate(() => {
    (window as unknown as { __documentWitness?: string }).__documentWitness = 'alive';
  });
}

/** Wait until the current run has reported normal or abnormal termination. */
async function waitForTermination(page: Page): Promise<void> {
  await expect
    .poll(async () => /Program (finished in \d+\.\d{2} s|exited with an error\.)/.test(await consoleText(page)), {
      timeout: 30_000,
    })
    .toBe(true);
}

const stdinField = (page: Page) => page.locator('#stdin-input');

/** The field is enabled, focused and empty — the state FR-029 asks for. */
async function expectStdinReady(page: Page): Promise<void> {
  await waitForStdinPrompt(page);
  await expect(stdinField(page)).toBeEnabled();
  await expect(stdinField(page)).toBeFocused();
  await expect(stdinField(page)).toHaveValue('');
  await expect(stdinField(page)).toHaveAttribute('placeholder', 'Waiting for input…');
  await expect(page.locator('#btn-eof')).toBeEnabled();
}

/** The field takes no text at all — FR-032's idle state. */
async function expectStdinIdle(page: Page): Promise<void> {
  await expect(stdinField(page)).toBeDisabled();
  await expect(stdinField(page)).toHaveValue('');
  await expect(stdinField(page)).toHaveAttribute('placeholder', 'Program is not waiting for input');
  await expect(page.locator('#btn-eof')).toBeDisabled();
}

/**
 * Count every transition of the stdin field into the enabled state, so
 * "enables the field exactly once per read" is measurable (VC-067).
 */
async function countStdinEnables(page: Page): Promise<void> {
  await page.evaluate(() => {
    const field = document.getElementById('stdin-input') as HTMLInputElement;
    const box = window as unknown as { __stdinEnables: number };
    box.__stdinEnables = 0;
    // The field is inert via `aria-disabled` so it stays tab-reachable
    // (FR-049); see src/controls.ts.
    new MutationObserver(() => {
      if (field.getAttribute('aria-disabled') !== 'true') box.__stdinEnables++;
    }).observe(field, { attributes: true, attributeFilter: ['aria-disabled'] });
  });
}

const stdinEnables = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as { __stdinEnables: number }).__stdinEnables);

test('VC-030 (FR-029, FR-030, FR-031): a prompted read suspends, prompts once, and resumes', async ({
  page,
}) => {
  await openReady(page);
  await runProgram(page, 'n = input("Name: ")\nprint("Hi", n)\n');

  // FR-029: the field is enabled and focused; FR-030: the prompt appears once.
  await expectStdinReady(page);
  const prompted = await consoleText(page);
  expect(prompted.match(/Name: /g) ?? []).toHaveLength(1);
  // ...and it came from the message, not from the stdout stream (FR-030).
  expect(await programStdout(page)).toBe('');
  // The program is suspended at exactly that point.
  expect(prompted).not.toContain('Hi');
  expect(prompted).not.toMatch(FINISHED);

  await submitStdin(page, 'Ana');
  await waitForTermination(page);

  const spans = await consoleSpans(page);
  // FR-031: the submitted text is echoed into the console styled as input.
  expect(spans.some((span) => span.kind === 'input' && span.text === 'Ana\n')).toBe(true);
  expect(await programStdout(page)).toBe('Hi Ana\n');
  // Still exactly once — the resumed program did not re-emit the prompt.
  expect((await consoleText(page)).match(/Name: /g) ?? []).toHaveLength(1);
  // FR-031: cleared and disabled again.
  await expectStdinIdle(page);
});

test('VC-031 (FR-029 suspension): the program stays parked for as long as it takes', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await openReady(page);
  await runProgram(page, 'n = input("Name: ")\nprint("Hi", n)\n');
  await expectStdinReady(page);

  await page.waitForTimeout(10_000);

  const text = await consoleText(page);
  expect(text).not.toContain('Hi');
  expect(text).not.toContain('Traceback');
  expect(text).not.toContain('EOFError');
  expect(text).not.toMatch(FINISHED);
  await expect(stdinField(page)).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Stop' })).toBeEnabled();

  // ...and it still resumes correctly afterwards.
  await submitStdin(page, 'Ana');
  await waitForTermination(page);
  expect(await programStdout(page)).toBe('Hi Ana\n');
});

/**
 * VC-067 (FR-057): six reads at four depths — top level, a loop body run three
 * times, a function called after 200 000 iterations of computation, and a
 * `try` block — interleaved with output.
 */
const DEPTHS_PROGRAM = [
  'name = input()',
  'print("hello", name)',
  '',
  'total = 0',
  'for i in range(3):',
  '    print("iter", i)',
  '    total += int(input())',
  '',
  '',
  'def ask():',
  '    return input()',
  '',
  '',
  'acc = 0',
  'for i in range(200000):',
  '    acc += i',
  'print("acc", acc)',
  'tag = ask()',
  '',
  'try:',
  '    extra = input()',
  '    print("extra", extra)',
  'except EOFError:',
  '    extra = "none"',
  '',
  'print("RESULT", name, total, tag, extra, acc)',
  '',
].join('\n');

const DEPTHS_LINES = ['Ana', '1', '2', '3', 'deep', 'last'];

/**
 * The transcript `python3` produces from the same program fed the same lines.
 * Generated by actually running the local interpreter when there is one; the
 * literal fallback is what CPython 3.13 prints, for machines without it.
 */
function expectedDepthsStdout(): string {
  const probe = spawnSync('python3', ['-c', DEPTHS_PROGRAM], {
    input: `${DEPTHS_LINES.join('\n')}\n`,
    encoding: 'utf8',
  });
  if (probe.status === 0 && typeof probe.stdout === 'string') return probe.stdout;
  return (
    'hello Ana\n' +
    'iter 0\n' +
    'iter 1\n' +
    'iter 2\n' +
    'acc 19999900000\n' +
    'extra last\n' +
    'RESULT Ana 6 deep last 19999900000\n'
  );
}

test('VC-067 (FR-057): six reads at four depths behave exactly as in a terminal', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openReady(page);
  await countStdinEnables(page);
  await runProgram(page, DEPTHS_PROGRAM);

  for (const [index, line] of DEPTHS_LINES.entries()) {
    // Each read suspends in source order and enables the field exactly once.
    await expectStdinReady(page);
    expect(await stdinEnables(page)).toBe(index + 1);
    await submitStdin(page, line);
  }

  await waitForTermination(page);
  expect(await stdinEnables(page)).toBe(DEPTHS_LINES.length);
  await expectStdinIdle(page);

  // The program's own output matches `python3` fed the same lines.
  expect(await programStdout(page)).toBe(expectedDepthsStdout());
});

test('VC-068 (FR-057 output ordering): nothing is printed ahead of the read that blocks it', async ({
  page,
}) => {
  await openReady(page);
  await runProgram(
    page,
    'for i in range(3):\n    print("before", i)\n    v = input()\n    print("after", v)\n',
  );

  for (const line of ['a', 'b', 'c']) {
    await expectStdinReady(page);
    // The output that precedes this read is already on screen; the output that
    // follows it is not.
    await submitStdin(page, line);
  }
  await waitForTermination(page);

  const ordered = (await consoleSpans(page))
    .filter((span) => span.kind === 'stdout' || span.kind === 'input')
    .map((span) => span.text)
    .join('')
    .trimEnd()
    .split('\n');

  expect(ordered).toEqual([
    'before 0',
    'a',
    'after a',
    'before 1',
    'b',
    'after b',
    'before 2',
    'c',
    'after c',
  ]);
});

test('VC-032 (FR-032): with no program running the field takes no text', async ({ page }) => {
  await openReady(page);
  await expectStdinIdle(page);

  // Clicking and typing at it changes nothing. The field stays reachable by
  // keyboard (FR-049), so it may take focus — what FR-032 forbids is text.
  await stdinField(page).click({ force: true });
  await page.keyboard.type('hola');
  await page.keyboard.press('Enter');
  await expect(stdinField(page)).toHaveValue('');
  expect(await stdinField(page).evaluate((el: HTMLInputElement) => el.readOnly)).toBe(true);
  await expect(stdinField(page)).toBeDisabled();
  await expect(page.locator('#btn-eof')).toBeDisabled();
});

test('VC-033 (FR-032 mid-run): the field stays disabled while the program is not reading', async ({
  page,
}) => {
  await openReady(page);
  await runProgram(page, 'import time\ntime.sleep(5)\nprint("done")\n');
  await expect(page.getByRole('button', { name: 'Stop' })).toBeEnabled();

  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(700);
    await expectStdinIdle(page);
  }

  await waitForTermination(page);
  await expectStdinIdle(page);
});

test('VC-034 (FR-033, FR-064): Stop while suspended on a read', async ({ page }) => {
  await openReady(page);
  const code = 'n = input("Name: ")\nprint("Hi", n)\n';
  await runProgram(page, code);
  await expectStdinReady(page);

  // Issue #41: a pending read locks code editing but never the Stop escape hatch.
  const editor = page.locator('.cm-content');
  await expect(editor).toHaveAttribute('contenteditable', 'false');
  await expect(editor).toHaveAttribute('aria-readonly', 'true');
  const runningHint = page.locator('#editor-running-hint');
  await expect(runningHint).toBeVisible();
  await expect(runningHint).toHaveText('Program running — use Stop to edit code.');
  await editor.click();
  await page.keyboard.type('this must not replace the running snapshot');
  expect(await editorText(page)).toBe(code);
  await expect(page.getByRole('button', { name: 'Stop' })).toBeEnabled();
  for (const id of ['btn-format', 'btn-reset', 'btn-file-new', 'btn-file-rename', 'btn-file-delete']) {
    await expect(page.locator(`#${id}`)).toBeDisabled();
  }

  const startedAt = Date.now();
  await page.getByRole('button', { name: 'Stop' }).click();

  await page.waitForFunction(
    () => (document.getElementById('console')?.textContent ?? '').includes('Program stopped.'),
    undefined,
    { timeout: 5_000 },
  );
  // FR-033: the field is disabled again.
  await expectStdinIdle(page);

  // FR-064: Run comes back within 5.0 s, without a page reload.
  await expect(page.locator('#btn-run')).toBeEnabled({ timeout: 5_000 });
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await expect(editor).toHaveAttribute('aria-readonly', 'false');
  await expect(runningHint).toBeHidden();
  expect(Date.now() - startedAt).toBeLessThan(5_000);
  expect(
    await page.evaluate(
      () => (window as unknown as { __documentWitness?: string }).__documentWitness === 'alive',
    ),
  ).toBe(true);
  expect(await consoleText(page)).not.toContain('Hi');

  // The recovered runtime reads stdin again.
  await runProgram(page, 'print(input())\n');
  await submitStdin(page, 'again');
  await waitForTermination(page);
  expect(await programStdout(page)).toBe('again\n');
});

test('VC-035 (FR-031 multiple reads): two consecutive line reads', async ({ page }) => {
  await openReady(page);
  await runProgram(page, 'a = input()\nb = input()\nprint(int(a) + int(b))\n');

  await expectStdinReady(page);
  await submitStdin(page, '2');
  await expectStdinReady(page);
  await submitStdin(page, '3');

  await waitForTermination(page);
  expect(await programStdout(page)).toBe('5\n');
});

test('VC-036 (FR-031 empty line): an empty submission is a line, not EOF', async ({ page }) => {
  await openReady(page);
  await runProgram(page, 's = input()\nprint(repr(s))\n');

  await expectStdinReady(page);
  await stdinField(page).press('Enter');

  await waitForTermination(page);
  expect(await programStdout(page)).toBe("''\n");
  expect(await consoleText(page)).not.toContain('EOFError');
});

test('VC-037 (FR-034 — input()): Send EOF raises EOFError', async ({ page }) => {
  await openReady(page);
  await runProgram(page, 'input()\n');
  await expectStdinReady(page);

  await page.getByRole('button', { name: 'Send EOF' }).click();
  await waitForTermination(page);

  const text = await consoleText(page);
  expect(text).toContain('EOFError');
  expect(text).toContain('Traceback');
  expect(text).toContain('Program exited with an error.');
  await expectStdinIdle(page);
});

test('VC-073 (FR-060, FR-062): read() collects every line until EOF', async ({ page }) => {
  await openReady(page);
  await runProgram(page, 'import sys\ndata = sys.stdin.read()\nprint(repr(data))\n');

  await expectStdinReady(page);
  await submitStdin(page, 'line1');
  // FR-062: cleared, but still enabled for the next line.
  await expect(stdinField(page)).toBeEnabled();
  await expect(stdinField(page)).toHaveValue('');
  await expect(stdinField(page)).toBeFocused();
  await submitStdin(page, 'line2');
  await expect(stdinField(page)).toBeEnabled();

  await page.getByRole('button', { name: 'Send EOF' }).click();
  await waitForTermination(page);
  expect(await programStdout(page)).toBe("'line1\\nline2\\n'\n");
});

test('VC-074 (FR-061): read(3) takes the first three characters of one line', async ({ page }) => {
  await openReady(page);
  await runProgram(page, 'import sys\nprint(repr(sys.stdin.read(3)))\n');

  await expectStdinReady(page);
  await submitStdin(page, 'abcdef');

  await waitForTermination(page);
  expect(await programStdout(page)).toBe("'abc'\n");
});

test('VC-075 (FR-061, FR-062): read(5) keeps the field open across submissions', async ({
  page,
}) => {
  await openReady(page);
  await runProgram(page, 'import sys\nprint(repr(sys.stdin.read(5)))\n');

  await expectStdinReady(page);
  await submitStdin(page, 'hi');
  // Only three characters are buffered, so the read is still blocked (FR-062).
  await expect(stdinField(page)).toBeEnabled();
  expect(await consoleText(page)).not.toContain("'hi");
  await submitStdin(page, 'abc');

  await waitForTermination(page);
  expect(await programStdout(page)).toBe("'hi\\nab'\n");
});

test('VC-076 (FR-034, FR-060): read() with an immediate EOF returns the empty string', async ({
  page,
}) => {
  await openReady(page);
  await runProgram(page, 'import sys\nprint(repr(sys.stdin.read()))\n');
  await expectStdinReady(page);

  await page.getByRole('button', { name: 'Send EOF' }).click();
  await waitForTermination(page);

  expect(await programStdout(page)).toBe("''\n");
  expect(await consoleText(page)).not.toContain('EOFError');
});

test('VC-077 (FR-034 — readline()): EOF returns the empty string, without raising', async ({
  page,
}) => {
  await openReady(page);
  await runProgram(page, 'import sys\nprint(repr(sys.stdin.readline()))\n');
  await expectStdinReady(page);

  // Ctrl+D in the field is the same end-of-file as the control (FR-034).
  await stdinField(page).press('Control+d');
  await waitForTermination(page);

  expect(await programStdout(page)).toBe("''\n");
  expect(await consoleText(page)).not.toContain('EOFError');
  await expectStdinIdle(page);
});

test('VC-078 (FR-034, FR-061): read(10) returns the partial buffer on EOF', async ({ page }) => {
  await openReady(page);
  await runProgram(page, 'import sys\nprint(repr(sys.stdin.read(10)))\n');

  await expectStdinReady(page);
  await submitStdin(page, 'hi');
  await expect(stdinField(page)).toBeEnabled();

  await page.getByRole('button', { name: 'Send EOF' }).click();
  await waitForTermination(page);

  expect(await programStdout(page)).toBe("'hi\\n'\n");
  expect(await consoleText(page)).not.toContain('EOFError');
});

test('VC-082 (FR-066): an over-long line is rejected and the read stays blocked', async ({
  page,
}) => {
  await openReady(page);
  await runProgram(page, 'print(repr(input()))\n');
  await expectStdinReady(page);

  const tooLong = 'a'.repeat(65_537);
  await stdinField(page).fill(tooLong);
  await stdinField(page).press('Enter');

  // FR-066: the notice appears and the line is not delivered.
  await expect(page.locator('.notice')).toContainText(
    'Input line too long (max 65536 characters)',
  );
  await expect(stdinField(page)).toBeEnabled();
  await expect(stdinField(page)).toHaveValue(tooLong);
  // ...with its contents selected for editing.
  expect(
    await stdinField(page).evaluate((el: HTMLInputElement) => [
      el.selectionStart,
      el.selectionEnd,
    ]),
  ).toEqual([0, tooLong.length]);
  expect(await consoleText(page)).not.toMatch(FINISHED);

  // The read is still there, and a valid line completes it.
  await submitStdin(page, 'ok');
  await waitForTermination(page);
  expect(await programStdout(page)).toBe("'ok'\n");
});
