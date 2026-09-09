import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
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

interface BaselineBuild {
  commit: string;
  manifestUrlCount: number;
  gzippedApp?: number;
  gzippedBy?: string;
  gzippedAppBy?: Record<string, number>;
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(repoRoot, 'dist');
const PASTE_BASELINE_PATH =
  process.env.PYPLAY_BASELINE_PASTE ??
  join(repoRoot, 'tests', 'e2e', 'baseline-build-paste.json');
const pasteBaseline = JSON.parse(readFileSync(PASTE_BASELINE_PATH, 'utf8')) as BaselineBuild;
const compressor = `${process.platform}-${process.arch} zlib ${process.versions.zlib}`;
const baselineApp =
  pasteBaseline.gzippedAppBy?.[compressor] ??
  (pasteBaseline.gzippedBy === compressor ? pasteBaseline.gzippedApp : undefined);
const PASTE_SIZE_BUDGET_BYTES = 1024;

if (process.env.PYPLAY_BASELINE_PASTE !== undefined && baselineApp === undefined) {
  throw new Error(
    `${PASTE_BASELINE_PATH} records no app size for "${compressor}" (gzipped by ` +
      `"${pasteBaseline.gzippedBy}")`,
  );
}

const uncoveredPasteCompressor =
  `no ${pasteBaseline.commit} baseline for "${compressor}" — have: ` +
  `${Object.keys(pasteBaseline.gzippedAppBy ?? {}).join(', ')}. Record with: ` +
  `node scripts/record-baselines.mjs ${pasteBaseline.commit} --build <out.json>`;

const isVendored = (url: string): boolean =>
  url.startsWith('/pyodide/') || url.startsWith('/ruff/');

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

test('VC-1011 (NFR-1001): paste sanitisation adds ≤ 1 KiB gzip and no asset', async () => {
  test.skip(baselineApp === undefined, uncoveredPasteCompressor);

  const manifest = JSON.parse(readFileSync(join(dist, 'precache-manifest.json'), 'utf8')) as {
    urls: string[];
  };
  let gzippedApp = 0;
  for (const url of [...manifest.urls, '/index.html']) {
    if (url === '/' || isVendored(url)) continue;
    gzippedApp += gzipSync(readFileSync(join(dist, url.replace(/^\//, ''))), { level: 9 }).length;
  }

  const delta = gzippedApp - baselineApp!;
  expect(
    delta,
    `NFR-1001 app size delta vs ${pasteBaseline.commit}: ${delta} B gzipped ` +
      `(budget ${PASTE_SIZE_BUDGET_BYTES} B, compressor "${compressor}")`,
  ).toBeLessThanOrEqual(PASTE_SIZE_BUDGET_BYTES);
  expect(manifest.urls).toHaveLength(pasteBaseline.manifestUrlCount);

  console.log(
    [
      'VC-1011 measurements:',
      `  NFR-1001 app delta vs ${pasteBaseline.commit} ${delta} B (<= ${PASTE_SIZE_BUDGET_BYTES})`,
      `  NFR-1001 precache URL count           ${manifest.urls.length} (unchanged)`,
    ].join('\n'),
  );
});
