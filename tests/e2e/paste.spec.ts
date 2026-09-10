import { expect, test, type Page } from '@playwright/test';
import {
  openPlayground,
  programStdout,
  setProgram,
  storedProgram,
  waitForPythonReady,
} from './helpers';

const DIRTY_PROGRAM =
  'message\u00a0=\u00a0“hello”\r\n' +
  'value\u2007=\u202f5\u2009–\u20092\u200b\u2028' +
  'print(message, value)\u2029';

const CLEAN_PROGRAM = 'message = "hello"\nvalue = 5 - 2\nprint(message, value)\n';

async function writeClipboardAndPaste(page: Page, text: string): Promise<void> {
  await page.evaluate((value) => navigator.clipboard.writeText(value), text);
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('ControlOrMeta+v');
}

async function editorStateText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const content = document.querySelector('.cm-content') as
      | (HTMLElement & {
          cmView?: { view: { state: { doc: { toString(): string } } } };
          cmTile?: { view: { state: { doc: { toString(): string } } } };
        })
      | null;
    const view = content?.cmTile?.view ?? content?.cmView?.view;
    if (!view) throw new Error('CodeMirror view not found');
    return view.state.doc.toString();
  });
}

async function createFile(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'New' }).click();
  const input = page.locator('#file-name-input');
  await input.fill(name);
  await input.press('Enter');
}

test('VC-1009 (FR-1001, FR-1003): a contaminated Python paste is clean, undoable and runnable', async ({
  page,
}) => {
  await openPlayground(page);
  await waitForPythonReady(page);
  const before = 'sentinel = 1\n';
  await setProgram(page, before);

  await writeClipboardAndPaste(page, DIRTY_PROGRAM);
  await expect.poll(() => editorStateText(page)).toBe(CLEAN_PROGRAM);
  await expect(page.locator('#notices [data-notice]')).toHaveCount(0);

  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => editorStateText(page)).toBe(before);
  // CodeMirror binds Ctrl-Shift-Z on Linux and Mod-Shift-Z on macOS.
  await page.keyboard.press('ControlOrMeta+Shift+Z');
  await expect.poll(() => editorStateText(page)).toBe(CLEAN_PROGRAM);

  await expect.poll(() => storedProgram(page), { timeout: 3_000 }).toBe(CLEAN_PROGRAM);
  await page.getByRole('button', { name: 'Run' }).click();
  await expect.poll(() => programStdout(page), { timeout: 30_000 }).toBe('hello 3\n');
});

test('VC-1010 (BR-1001): non-Python text files preserve pasted characters exactly', async ({
  page,
}) => {
  await openPlayground(page);
  await createFile(page, 'notes.txt');
  const pasted = 'keep\u00a0“quotes” — dash \ufeff marker';

  await writeClipboardAndPaste(page, pasted);

  await expect.poll(() => editorStateText(page)).toBe(pasted);
  await expect(page.locator('#notices [data-notice]')).toHaveCount(0);
});

test('VC-1011 (NFR-1001): paste sanitisation size is historical as of spec-12', () => {
  console.log(
    [
      'VC-1011 measurements:',
      '  NFR-1001 app size delta                 (historical — see specs/10-paste-sanitisation-frozen.md)',
    ].join('\n'),
  );
});
