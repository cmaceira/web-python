/**
 * spec-13 — hide and resize the Output pane.
 *
 * VC-1301 – VC-1314 against the built site.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { expect, test, type Page, type Request } from '@playwright/test';
import {
  CONSOLE_HEIGHT_KEY,
  OUTPUT_EDITOR_MIN,
  OUTPUT_VISIBLE_KEY,
  OUTPUT_WIDTH_KEY,
  OUTPUT_WIDTH_MIN,
  OUTPUT_WIDTH_STEP,
  OUTPUT_WIDTH_STEP_LARGE,
} from '../../src/output-pane';
import {
  OUTPUT_LABEL,
  OUTPUT_RESIZER_LABEL,
  OUTPUT_VISIBLE_SAVE_FAILED,
  OUTPUT_WIDTH_SAVE_FAILED,
} from '../../src/format';
import {
  consoleText,
  editorText,
  openPlayground,
  runProgram,
  submitStdin,
  trackLongTasks,
  waitForLinter,
  waitForPythonReady,
  waitForStdinPrompt,
} from './helpers';

const LAYOUT_KEY = 'pyplay.layout.v2';
const THEME_KEY = 'pyplay.theme.v1';
const WIDE = { width: 1280, height: 800 };
const NARROW = { width: 375, height: 667 };

test.use({ viewport: WIDE });

async function seedStorage(
  page: Page,
  opts: {
    layout?: 'vertical' | 'horizontal' | null;
    visible?: string | null;
    width?: string | null;
  } = {},
): Promise<void> {
  await page.addInitScript(
    ({ layoutKey, visibleKey, widthKey, layout, visible, width, touchVisible, touchWidth }) => {
      try {
        if (layout === null) window.localStorage.removeItem(layoutKey);
        else if (layout !== undefined) window.localStorage.setItem(layoutKey, layout);
        if (touchVisible) {
          if (visible === null) window.localStorage.removeItem(visibleKey);
          else window.localStorage.setItem(visibleKey, visible as string);
        }
        if (touchWidth) {
          if (width === null) window.localStorage.removeItem(widthKey);
          else window.localStorage.setItem(widthKey, width as string);
        }
      } catch {
        /* storage denial is a dedicated criterion */
      }
    },
    {
      layoutKey: LAYOUT_KEY,
      visibleKey: OUTPUT_VISIBLE_KEY,
      widthKey: OUTPUT_WIDTH_KEY,
      layout: opts.layout,
      visible: opts.visible ?? null,
      width: opts.width ?? null,
      touchVisible: opts.visible !== undefined,
      touchWidth: opts.width !== undefined,
    },
  );
}

async function openVertical(page: Page): Promise<void> {
  await seedStorage(page, { layout: 'vertical' });
  await openPlayground(page, { seedLayout: false });
  await waitForPythonReady(page);
  await waitForLinter(page);
  await expect
    .poll(() => page.evaluate(() => document.getElementById('app')?.dataset.layout))
    .toBe('vertical');
}

async function closeFiles(page: Page): Promise<void> {
  const pane = page.locator('#file-pane');
  if (await pane.isVisible()) {
    await page.locator('#btn-files').click();
    await expect(pane).toBeHidden();
  }
}

test('VC-1301 (FR-1301, FR-1313): Output sits after Files; label Output', async ({ page }) => {
  await openVertical(page);
  const output = page.locator('#btn-output');
  await expect(output).toHaveText(OUTPUT_LABEL);
  await expect(output).toHaveAttribute('aria-expanded', 'true');
  await expect(output).toHaveAttribute(
    'aria-controls',
    'console-pane stdin-pane diagnostics-pane',
  );

  const order = await page.evaluate(() => {
    const ids = ['btn-files', 'btn-output', 'btn-symbols'];
    return ids.map((id) => {
      const el = document.getElementById(id)!;
      return { id, index: [...el.parentElement!.children].indexOf(el) };
    });
  });
  expect(order[0]!.index).toBeLessThan(order[1]!.index);
  expect(order[1]!.index).toBeLessThan(order[2]!.index);

  const chrome = (id: string) =>
    page.locator(`#${id}`).evaluate((el) => {
      const style = getComputedStyle(el);
      return { bg: style.backgroundColor, border: style.borderTopColor };
    });
  const outputOn = await chrome('btn-output');
  const filesOn = await chrome('btn-files');
  await output.click();
  const outputOff = await chrome('btn-output');
  await page.locator('#btn-files').click();
  const filesOff = await chrome('btn-files');
  expect(outputOn.border, 'Output open uses a distinct border').not.toBe(outputOff.border);
  expect(outputOn.bg, 'Output open uses a distinct fill').not.toBe(outputOff.bg);
  expect(filesOn.border, 'Files open uses a distinct border').not.toBe(filesOff.border);
  expect(filesOn.bg, 'Files open uses a distinct fill').not.toBe(filesOff.bg);
});

test('VC-1302 (FR-1302, FR-1304): toggle hides the stack and grows the editor', async ({
  page,
}) => {
  await openVertical(page);
  await closeFiles(page);
  const editorBefore = await page.locator('.panel--editor').boundingBox();
  expect(editorBefore).not.toBeNull();

  await page.locator('#btn-output').click();
  await expect(page.locator('#console-pane')).toBeHidden();
  await expect(page.locator('#stdin-pane')).toBeHidden();
  await expect(page.locator('#diagnostics-pane')).toBeHidden();
  await expect(page.locator('#output-resizer')).toBeHidden();
  await expect(page.locator('#diag-resizer')).toBeHidden();
  await expect(page.locator('#btn-output')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#file-pane')).toBeHidden();

  const editorHidden = await page.locator('.panel--editor').boundingBox();
  expect(editorHidden!.width).toBeGreaterThan(editorBefore!.width + 40);

  await page.locator('#btn-output').click();
  await expect(page.locator('#console-pane')).toBeVisible();
  await expect(page.locator('#stdin-pane')).toBeVisible();
  await expect(page.locator('#diagnostics-pane')).toBeVisible();
  await expect(page.locator('#btn-output')).toHaveAttribute('aria-expanded', 'true');
});

test('VC-1303 (FR-1303): pending input() reveals only the Input row', async ({ page }) => {
  await openVertical(page);
  await page.locator('#btn-output').click();
  await expect(page.locator('#console-pane')).toBeHidden();
  await expect(page.locator('#stdin-pane')).toBeHidden();

  await runProgram(page, 'name = input("¿Cómo te llamás? ")\nprint(name)\n');
  await waitForStdinPrompt(page);
  await expect(page.locator('#stdin-pane')).toBeVisible();
  await expect(page.locator('#console-pane')).toBeHidden();
  await expect(page.locator('#diagnostics-pane')).toBeHidden();
  await expect(page.locator('#btn-output')).toHaveAttribute('aria-expanded', 'false');

  await submitStdin(page, 'Ada');
  await expect(page.locator('#stdin-pane')).toBeHidden();
  await expect(page.locator('#console-pane')).toBeHidden();

  await page.locator('#btn-output').click();
  await expect(page.locator('#console-pane')).toBeVisible();
  await expect(page.locator('#console')).toContainText('Ada');
});

test('VC-1303-keep (FR-1303): hiding Output during a read keeps Input', async ({ page }) => {
  await openVertical(page);
  await runProgram(page, 'x = input("n: ")\nprint(x)\n');
  await waitForStdinPrompt(page);
  await expect(page.locator('#stdin-pane')).toBeVisible();
  await page.locator('#btn-output').click();
  await expect(page.locator('#console-pane')).toBeHidden();
  await expect(page.locator('#stdin-pane')).toBeVisible();
  await expect(page.locator('#btn-eof')).toBeVisible();
});

test('VC-1304 (FR-1305, FR-1308): keyboard and pointer resize the column', async ({ page }) => {
  await openVertical(page);
  await closeFiles(page);
  const resizer = page.locator('#output-resizer');
  await expect(resizer).toBeVisible();
  await expect(resizer).toHaveAttribute('aria-label', OUTPUT_RESIZER_LABEL);
  const before = Number(await resizer.getAttribute('aria-valuenow'));
  expect(before).toBeGreaterThanOrEqual(OUTPUT_WIDTH_MIN);

  await resizer.focus();
  await resizer.press('ArrowRight');
  const afterStep = Number(await resizer.getAttribute('aria-valuenow'));
  expect(afterStep).toBe(before + OUTPUT_WIDTH_STEP);
  expect(await page.evaluate((key) => window.localStorage.getItem(key), OUTPUT_WIDTH_KEY)).toBe(
    String(afterStep),
  );

  await resizer.press('Shift+ArrowRight');
  expect(Number(await resizer.getAttribute('aria-valuenow'))).toBe(
    afterStep + OUTPUT_WIDTH_STEP_LARGE,
  );

  const min = Number(await resizer.getAttribute('aria-valuemin'));
  const max = Number(await resizer.getAttribute('aria-valuemax'));
  expect(min).toBe(OUTPUT_WIDTH_MIN);
  expect(max).toBeGreaterThan(min);

  const box = await resizer.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(8);
  const now = Number(await resizer.getAttribute('aria-valuenow'));
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x - 40, box!.y + box!.height / 2, { steps: 5 });
  await page.mouse.up();
  const dragged = Number(await resizer.getAttribute('aria-valuenow'));
  expect(dragged).toBeGreaterThan(now);
  expect(dragged).toBeLessThanOrEqual(max);
  expect(dragged).toBeGreaterThanOrEqual(min);
});

test('VC-1316 (FR-1314): stacked layout resizes console and Problems', async ({ page }) => {
  await seedStorage(page, { layout: 'horizontal' });
  await openPlayground(page, { seedLayout: false });
  await waitForPythonReady(page);
  await waitForLinter(page);

  const consoleResizer = page.locator('#console-resizer');
  const diagResizer = page.locator('#diag-resizer');
  await expect(consoleResizer).toBeVisible();
  await expect(diagResizer).toBeVisible();
  await expect(page.locator('#output-resizer')).toBeHidden();

  const consoleBefore = Number(await consoleResizer.getAttribute('aria-valuenow'));
  await consoleResizer.focus();
  await consoleResizer.press('ArrowDown');
  const consoleAfter = Number(await consoleResizer.getAttribute('aria-valuenow'));
  expect(consoleAfter).toBe(consoleBefore + OUTPUT_WIDTH_STEP);
  expect(await page.evaluate((key) => window.localStorage.getItem(key), CONSOLE_HEIGHT_KEY)).toBe(
    String(consoleAfter),
  );

  const diagBefore = Number(await diagResizer.getAttribute('aria-valuenow'));
  await diagResizer.focus();
  await diagResizer.press('ArrowUp');
  const diagAfter = Number(await diagResizer.getAttribute('aria-valuenow'));
  expect(diagAfter).toBe(diagBefore + 16);
  expect(
    await page.evaluate((key) => window.localStorage.getItem(key), 'pyplay.diagnostics-height.v1'),
  ).toBe(String(diagAfter));
});

test('VC-1305 (FR-1305, BR-1305, BR-1306): column resizer inert in horizontal and below 900', async ({
  page,
}) => {
  await seedStorage(page, { layout: 'horizontal' });
  await openPlayground(page, { seedLayout: false });
  await waitForPythonReady(page);
  const resizer = page.locator('#output-resizer');
  await expect(resizer).toBeHidden();
  await expect(resizer).toHaveAttribute('aria-disabled', 'true');
  expect(await resizer.evaluate((el) => el.hasAttribute('disabled'))).toBe(false);

  await page.locator('#btn-output').click();
  await expect(page.locator('#console-pane')).toBeHidden();
  await page.locator('#btn-output').click();
  await expect(page.locator('#console-pane')).toBeVisible();

  await page.setViewportSize({ width: 800, height: 700 });
  await expect(resizer).toBeHidden();
  await page.locator('#btn-output').click();
  await expect(page.locator('#console-pane')).toBeHidden();
});

test('VC-1306 (FR-1306, FR-1307): default 58 %; committed width writes the key', async ({
  page,
}) => {
  await openVertical(page);
  await closeFiles(page);
  const split = await page.evaluate(() => {
    const app = document.getElementById('app')!;
    const style = getComputedStyle(app);
    const content =
      app.getBoundingClientRect().width -
      parseFloat(style.paddingLeft) -
      parseFloat(style.paddingRight);
    const editor = document.querySelector('.panel--editor')!.getBoundingClientRect().width;
    return { content, editor };
  });
  expect(split.editor).toBeCloseTo(split.content * 0.58, 0);

  const resizer = page.locator('#output-resizer');
  await resizer.focus();
  await resizer.press('ArrowRight');
  const now = await resizer.getAttribute('aria-valuenow');
  expect(await page.evaluate((key) => window.localStorage.getItem(key), OUTPUT_WIDTH_KEY)).toBe(
    now,
  );
  const sized = await page.evaluate(
    () => document.documentElement.style.getPropertyValue('--output-width'),
  );
  expect(sized).toBe(`${now}px`);
});

test('VC-1307 (FR-1309, FR-1311): hidden restores before paint', async ({ page }) => {
  await seedStorage(page, { layout: 'vertical', visible: 'hidden' });
  await openPlayground(page, { seedLayout: false });
  await expect(page.locator('#console-pane')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.dataset.output)).toBe('hidden');
  await expect(page.locator('#btn-output')).toHaveAttribute('aria-expanded', 'false');
});

test('VC-1307-junk (FR-1309): non-canonical visibility is shown and left in place', async ({
  page,
}) => {
  await seedStorage(page, { layout: 'vertical', visible: 'TRUE' });
  await openPlayground(page, { seedLayout: false });
  await expect(page.locator('#console-pane')).toBeVisible();
  expect(await page.evaluate((key) => window.localStorage.getItem(key), OUTPUT_VISIBLE_KEY)).toBe(
    'TRUE',
  );
});

test('VC-1308 (FR-1310, FR-1308): junk width yields 58 %; clamp does not rewrite', async ({
  page,
}) => {
  await seedStorage(page, { layout: 'vertical', width: '036' });
  await openPlayground(page, { seedLayout: false });
  await waitForPythonReady(page);
  await closeFiles(page);
  const editor = await page.evaluate(() => {
    const app = document.getElementById('app')!;
    const style = getComputedStyle(app);
    const content =
      app.getBoundingClientRect().width -
      parseFloat(style.paddingLeft) -
      parseFloat(style.paddingRight);
    return document.querySelector('.panel--editor')!.getBoundingClientRect().width / content;
  });
  expect(editor).toBeCloseTo(0.58, 2);
  expect(await page.evaluate((key) => window.localStorage.getItem(key), OUTPUT_WIDTH_KEY)).toBe(
    '036',
  );

  await seedStorage(page, { layout: 'vertical', width: '9999' });
  await page.goto('/');
  await page.waitForSelector('.cm-content');
  await waitForPythonReady(page);
  await closeFiles(page);
  const resizer = page.locator('#output-resizer');
  const now = Number(await resizer.getAttribute('aria-valuenow'));
  const max = Number(await resizer.getAttribute('aria-valuemax'));
  expect(now).toBe(max);
  expect(now).toBeLessThan(9999);
  expect(await page.evaluate((key) => window.localStorage.getItem(key), OUTPUT_WIDTH_KEY)).toBe(
    '9999',
  );
});

test('VC-1309 (FR-1310): failed setItem shows the notice once', async ({ page }) => {
  await page.addInitScript((key) => {
    const original = window.localStorage.setItem.bind(window.localStorage);
    Object.defineProperty(window.localStorage, 'setItem', {
      configurable: true,
      value: (k: string, value: string) => {
        if (k === key) throw new DOMException('quota', 'QuotaExceededError');
        original(k, value);
      },
    });
  }, OUTPUT_VISIBLE_KEY);
  await openVertical(page);
  await page.locator('#btn-output').click();
  await expect(page.locator('#console-pane')).toBeHidden();
  await expect(
    page.locator(`#notices [data-notice="${OUTPUT_VISIBLE_SAVE_FAILED}"]`),
  ).toHaveCount(1);
  await page.locator('#btn-output').click();
  await expect(
    page.locator(`#notices [data-notice="${OUTPUT_VISIBLE_SAVE_FAILED}"]`),
  ).toHaveCount(1);
});

test('VC-1309-width (FR-1310): failed width write still applies', async ({ page }) => {
  await page.addInitScript((key) => {
    const original = window.localStorage.setItem.bind(window.localStorage);
    Object.defineProperty(window.localStorage, 'setItem', {
      configurable: true,
      value: (k: string, value: string) => {
        if (k === key) throw new DOMException('quota', 'QuotaExceededError');
        original(k, value);
      },
    });
  }, OUTPUT_WIDTH_KEY);
  await openVertical(page);
  await closeFiles(page);
  const resizer = page.locator('#output-resizer');
  const before = Number(await resizer.getAttribute('aria-valuenow'));
  await resizer.focus();
  await resizer.press('ArrowRight');
  expect(Number(await resizer.getAttribute('aria-valuenow'))).toBe(before + OUTPUT_WIDTH_STEP);
  await expect(
    page.locator(`#notices [data-notice="${OUTPUT_WIDTH_SAVE_FAILED}"]`),
  ).toHaveCount(1);
});

test('VC-1310 (FR-1312): hide/resize leave editor, layout, theme; Run while hidden', async ({
  page,
}) => {
  const requests: string[] = [];
  const record = (request: Request): void => void requests.push(request.url());
  page.on('request', record);
  await openVertical(page);
  const before = {
    layout: await page.evaluate((key) => window.localStorage.getItem(key), LAYOUT_KEY),
    theme: await page.evaluate((key) => window.localStorage.getItem(key), THEME_KEY),
  };
  requests.length = 0;

  await page.locator('#btn-output').click();
  await runProgram(page, 'print("hidden-run")\n');
  await expect.poll(async () => consoleText(page)).toContain('hidden-run');
  const afterRun = await editorText(page);
  await page.locator('#btn-output').click();
  await expect(page.locator('#console')).toContainText('hidden-run');

  const resizer = page.locator('#output-resizer');
  await resizer.focus();
  await resizer.press('ArrowRight');
  page.off('request', record);

  expect(await editorText(page)).toBe(afterRun);
  expect(await page.evaluate((key) => window.localStorage.getItem(key), LAYOUT_KEY)).toBe(
    before.layout,
  );
  expect(await page.evaluate((key) => window.localStorage.getItem(key), THEME_KEY)).toBe(
    before.theme,
  );
  expect(requests, 'no hide/resize network').toEqual([]);
});

test('VC-1311 (BR-1303): theme cycle keeps --output-width', async ({ page }) => {
  await openVertical(page);
  await closeFiles(page);
  const resizer = page.locator('#output-resizer');
  await resizer.focus();
  await resizer.press('ArrowRight');
  const width = await page.evaluate(
    () => document.documentElement.style.getPropertyValue('--output-width'),
  );
  expect(width).toMatch(/^\d+px$/);
  const column = await page.locator('#console-pane').boundingBox();
  await page.locator('#btn-theme').click();
  expect(
    await page.evaluate(() => document.documentElement.style.getPropertyValue('--output-width')),
  ).toBe(width);
  const after = await page.locator('#console-pane').boundingBox();
  expect(after!.width).toBeCloseTo(column!.width, 0);
});

test('VC-1312 (FR-1305, BR-1302): default split still clears 320 px', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await openVertical(page);
  await closeFiles(page);
  const measures = await page.evaluate(() => {
    const app = document.getElementById('app')!;
    const style = getComputedStyle(app);
    const content =
      app.getBoundingClientRect().width -
      parseFloat(style.paddingLeft) -
      parseFloat(style.paddingRight);
    const editor = document.querySelector('.panel--editor')!.getBoundingClientRect();
    const consolePanel = document.getElementById('console-pane')!.getBoundingClientRect();
    return {
      editor: editor.width,
      output: consolePanel.width,
      content,
      tracks: style.gridTemplateColumns,
    };
  });
  expect(measures.editor).toBeCloseTo(measures.content * 0.58, 0);
  expect(measures.editor).toBeGreaterThanOrEqual(OUTPUT_EDITOR_MIN);
  expect(measures.output).toBeGreaterThanOrEqual(OUTPUT_WIDTH_MIN);
  expect(measures.tracks.split(' ').length, 'no extra separator track').toBe(2);
});

test('VC-1313 (NFR-1303, NFR-1304): hit areas and 375 px', async ({ page }) => {
  await openVertical(page);
  const hit = await page.evaluate(() => {
    const resizer = document.getElementById('output-resizer')!.getBoundingClientRect();
    const toggle = document.getElementById('btn-output')!.getBoundingClientRect();
    return { resizer: resizer.width, toggleW: toggle.width, toggleH: toggle.height };
  });
  expect(hit.resizer).toBeGreaterThanOrEqual(8);
  expect(hit.toggleW).toBeGreaterThanOrEqual(32);
  expect(hit.toggleH).toBeGreaterThanOrEqual(32);

  await page.setViewportSize(NARROW);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(375);
  await page.locator('#btn-output').click();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(375);
});

test('VC-1314 (NFR-1302): hide and resize paint in ≤ 50 ms', async ({ page }) => {
  test.setTimeout(120_000);
  await openVertical(page);
  await closeFiles(page);
  await waitForPythonReady(page);

  const longTaskTracker = await trackLongTasks(page);
  await page.waitForTimeout(250);
  await longTaskTracker.reset();

  const hideMs = await page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const pane = document.getElementById('console-pane')!;
        const start = performance.now();
        const check = (): void => {
          if (pane.hidden) {
            requestAnimationFrame(() => resolve(performance.now() - start));
            return;
          }
          requestAnimationFrame(check);
        };
        setTimeout(() => reject(new Error('hide never applied')), 5_000);
        document.getElementById('btn-output')!.click();
        requestAnimationFrame(check);
      }),
  );
  await page.waitForTimeout(300);
  const hideTasks = await longTaskTracker.read();
  expect(hideMs, 'NFR-1302 hide paint').toBeLessThanOrEqual(50);
  expect(Math.max(0, ...hideTasks), 'NFR-1302 hide long task').toBeLessThanOrEqual(50);

  await page.locator('#btn-output').click();
  await expect(page.locator('#console-pane')).toBeVisible();
  await longTaskTracker.reset();
  const resizeMs = await page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const resizer = document.getElementById('output-resizer')!;
        const start = performance.now();
        const before = resizer.getAttribute('aria-valuenow');
        const check = (): void => {
          if (resizer.getAttribute('aria-valuenow') !== before) {
            requestAnimationFrame(() => resolve(performance.now() - start));
            return;
          }
          requestAnimationFrame(check);
        };
        setTimeout(() => reject(new Error('width never changed')), 5_000);
        resizer.focus();
        resizer.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
        );
        requestAnimationFrame(check);
      }),
  );
  await page.waitForTimeout(300);
  const resizeTasks = await longTaskTracker.read();
  expect(resizeMs, 'NFR-1302 resize paint').toBeLessThanOrEqual(50);
  expect(Math.max(0, ...resizeTasks), 'NFR-1302 resize long task').toBeLessThanOrEqual(50);
});

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(repoRoot, 'dist');
const OUTPUT_BASELINE_PATH =
  process.env.PYPLAY_BASELINE_OUTPUT ??
  join(repoRoot, 'tests', 'e2e', 'baseline-build-output.json');

interface BaselineBuild {
  commit: string;
  manifestUrlCount: number;
  gzippedApp?: number;
  gzippedBy?: string;
  gzippedAppBy?: Record<string, number>;
}

const outputBaseline = JSON.parse(readFileSync(OUTPUT_BASELINE_PATH, 'utf8')) as BaselineBuild;
const compressor = `${process.platform}-${process.arch} zlib ${process.versions.zlib}`;
const outputBaselineApp =
  outputBaseline.gzippedAppBy?.[compressor] ??
  (outputBaseline.gzippedBy === compressor ? outputBaseline.gzippedApp : undefined);
const OUTPUT_SIZE_BUDGET_BYTES = 3 * 1024;

if (process.env.PYPLAY_BASELINE_OUTPUT !== undefined && outputBaselineApp === undefined) {
  throw new Error(
    `${OUTPUT_BASELINE_PATH} records no app size for "${compressor}" (gzipped by ` +
      `"${outputBaseline.gzippedBy}")`,
  );
}

const uncoveredOutputCompressor =
  `no ${outputBaseline.commit} baseline for "${compressor}" — have: ` +
  `${Object.keys(outputBaseline.gzippedAppBy ?? {}).join(', ')}. Record with: ` +
  `node scripts/record-baselines.mjs ${outputBaseline.commit} --build <out.json>`;

const isVendored = (url: string): boolean =>
  url.startsWith('/pyodide/') || url.startsWith('/ruff/');

test('VC-1314-size (NFR-1301): Output adds ≤ 3 KiB gzip and no asset', async () => {
  test.skip(outputBaselineApp === undefined, uncoveredOutputCompressor);

  const manifest = JSON.parse(readFileSync(join(dist, 'precache-manifest.json'), 'utf8')) as {
    urls: string[];
  };
  let gzippedApp = 0;
  for (const url of [...manifest.urls, '/index.html']) {
    if (url === '/' || isVendored(url)) continue;
    gzippedApp += gzipSync(readFileSync(join(dist, url.replace(/^\//, ''))), { level: 9 }).length;
  }

  const delta = gzippedApp - outputBaselineApp!;
  expect(
    delta,
    `NFR-1301 app size delta vs ${outputBaseline.commit}: ${delta} B gzipped ` +
      `(budget ${OUTPUT_SIZE_BUDGET_BYTES} B, compressor "${compressor}")`,
  ).toBeLessThanOrEqual(OUTPUT_SIZE_BUDGET_BYTES);
  expect(manifest.urls).toHaveLength(outputBaseline.manifestUrlCount);

  console.log(
    [
      'VC-1314 measurements:',
      `  NFR-1301 app delta vs ${outputBaseline.commit} ${delta} B (<= ${OUTPUT_SIZE_BUDGET_BYTES})`,
      `  NFR-1301 precache URL count           ${manifest.urls.length} (unchanged)`,
    ].join('\n'),
  );
});
