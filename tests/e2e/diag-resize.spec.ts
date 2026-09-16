/**
 * spec-09 — minimal diagnostics under input (vertical layout).
 *
 * VC-901 – VC-911, VC-913: behaviour against the built site.
 * VC-912 (NFR-901, NFR-903): hit target and apply-height latency. NFR-904's
 * shipped size measurement is historical as of spec-10. Contrast (NFR-902)
 * lives in `presentation.spec.ts` (VC-071); geometry regress (NFR-905) stays
 * on VC-409 / VC-435 in `layout.spec.ts`.
 */
import { expect, test, type Page, type Request } from '@playwright/test';
import {
  DIAG_CONSOLE_MIN,
  DIAG_HEIGHT_KEY,
  DIAG_HEIGHT_MAX_RATIO,
  DIAG_HEIGHT_STEP,
  DIAG_HEIGHT_STEP_LARGE,
} from '../../src/diag-resize';
import { DIAG_HEIGHT_SAVE_FAILED, DIAG_RESIZER_LABEL } from '../../src/format';
import {
  consoleText,
  diagnosticEntries,
  editorText,
  openPlayground,
  setProgram,
  trackLongTasks,
  waitForLinter,
  waitForPythonReady,
} from './helpers';

const WIDE = { width: 1280, height: 800 };
const NARROW_PHONE = { width: 375, height: 667 };
const LAYOUT_KEY = 'pyplay.layout.v2';
const THEME_KEY = 'pyplay.theme.v1';

test.use({ viewport: WIDE });

/** Seed layout (and optionally diagnostics height) before first paint. */
async function seedStorage(
  page: Page,
  opts: {
    layout?: 'vertical' | 'horizontal' | null;
    /**
     * `undefined` — leave the key alone (needed so reloads keep a committed
     * height). `null` — remove once per browser context (session flag), so a
     * later reload can restore a visitor-committed value (VC-907 / VC-913).
     * A string — write that raw value on every load (VC-908 oversize).
     */
    diagHeight?: string | null;
  } = {},
): Promise<void> {
  await page.addInitScript(
    ({ layoutKey, heightKey, layout, diagHeight, touchHeight, clearOnce }) => {
      try {
        if (layout === null) window.localStorage.removeItem(layoutKey);
        else if (layout !== undefined) window.localStorage.setItem(layoutKey, layout);
        if (!touchHeight) return;
        if (clearOnce) {
          const flag = 'pyplay.__diagHeightCleared';
          if (!sessionStorage.getItem(flag)) {
            window.localStorage.removeItem(heightKey);
            sessionStorage.setItem(flag, '1');
          }
          return;
        }
        if (diagHeight === null) window.localStorage.removeItem(heightKey);
        else window.localStorage.setItem(heightKey, diagHeight as string);
      } catch {
        /* storage denial is a dedicated criterion */
      }
    },
    {
      layoutKey: LAYOUT_KEY,
      heightKey: DIAG_HEIGHT_KEY,
      layout: opts.layout,
      diagHeight: opts.diagHeight ?? null,
      touchHeight: opts.diagHeight !== undefined,
      clearOnce: opts.diagHeight === null,
    },
  );
}

async function openVertical(page: Page, diagHeight: string | null = null): Promise<void> {
  await seedStorage(page, { layout: 'vertical', diagHeight });
  await openPlayground(page, { seedLayout: false });
  await waitForPythonReady(page);
  await waitForLinter(page);
  await expect
    .poll(() => page.evaluate(() => document.getElementById('app')?.dataset.layout))
    .toBe('vertical');
}

/** Lint findings so the Problems list is non-empty. */
async function seedDiagnostics(page: Page, count = 3): Promise<void> {
  const lines = Array.from({ length: count }, (_, i) => `unused_${i}`);
  await setProgram(page, `${lines.join('\n')}\n`);
  await expect
    .poll(() => diagnosticEntries(page), { timeout: 15_000 })
    .toHaveLength(count);
}

function panelGeometry(page: Page): Promise<{
  diagH: number;
  consoleH: number;
  consoleContentH: number;
  rightH: number;
  resizer: { top: number; bottom: number; height: number; consoleBottom: number; stdinTop: number };
  titleH: number;
  titleMarginBottom: number;
  bodyH: number;
  panelPad: number;
}> {
  return page.evaluate(() => {
    const diag = document.querySelector('.panel--diagnostics') as HTMLElement;
    const consolePanel = document.querySelector('.panel--console') as HTMLElement;
    const consoleEl = document.getElementById('console') as HTMLElement;
    const stdin = document.querySelector('.panel--stdin') as HTMLElement;
    const resizer = document.getElementById('diag-resizer') as HTMLElement;
    const title = diag.querySelector('.panel-title') as HTMLElement;
    const empty = diag.querySelector('.diagnostics-empty') as HTMLElement;
    const style = getComputedStyle(diag);
    const titleStyle = getComputedStyle(title);
    const d = diag.getBoundingClientRect();
    const c = consolePanel.getBoundingClientRect();
    const s = stdin.getBoundingClientRect();
    const r = resizer.getBoundingClientRect();
    const wasHidden = empty.hidden;
    empty.hidden = false;
    const bodyH = empty.scrollHeight;
    empty.hidden = wasHidden;
    return {
      diagH: d.height,
      consoleH: c.height,
      consoleContentH: consoleEl.getBoundingClientRect().height,
      rightH: d.bottom - c.top,
      resizer: {
        top: r.top,
        bottom: r.bottom,
        height: r.height,
        consoleBottom: c.bottom,
        stdinTop: s.top,
      },
      titleH: title.getBoundingClientRect().height,
      titleMarginBottom: Number.parseFloat(titleStyle.marginBottom) || 0,
      bodyH,
      panelPad:
        (Number.parseFloat(style.paddingTop) || 0) +
        (Number.parseFloat(style.paddingBottom) || 0),
    };
  });
}

/** True when `el` intersects the diagnostics panel's client rect. */
function intersectsDiagClient(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const panel = document.querySelector('.panel--diagnostics') as HTMLElement;
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el || el.hidden) return false;
    const p = panel.getBoundingClientRect();
    const e = el.getBoundingClientRect();
    if (e.width <= 0 || e.height <= 0) return false;
    return !(e.bottom <= p.top || e.top >= p.bottom || e.right <= p.left || e.left >= p.right);
  }, selector);
}

test('VC-901 (FR-901, FR-902, BR-901): default min matches horizontal empty height', async ({
  page,
}) => {
  // Horizontal (stacked) empty panel height is the reference floor.
  await seedStorage(page, { layout: 'horizontal', diagHeight: null });
  await openPlayground(page, { seedLayout: false });
  await waitForPythonReady(page);
  await waitForLinter(page);
  await setProgram(page, 'x = 1\n');
  await expect.poll(() => diagnosticEntries(page)).toEqual([]);
  await expect(page.locator('#diagnostics-empty')).toBeVisible();
  const horizontalH = await page.evaluate(() => {
    const diag = document.querySelector('.panel--diagnostics') as HTMLElement;
    return diag.getBoundingClientRect().height;
  });

  // Fresh vertical load (no stored height) must match that floor.
  await openVertical(page, null);
  await setProgram(page, 'x = 1\n');
  await expect.poll(() => diagnosticEntries(page)).toEqual([]);
  await expect(page.locator('#diagnostics-empty')).toBeVisible();
  expect(await intersectsDiagClient(page, '#diagnostics-empty')).toBe(true);
  // Empty copy sits under the title — not vertically centered in leftover space.
  const emptyPlacement = await page.evaluate(() => {
    const title = document.querySelector('.panel--diagnostics .panel-title') as HTMLElement;
    const empty = document.getElementById('diagnostics-empty') as HTMLElement;
    const t = title.getBoundingClientRect();
    const e = empty.getBoundingClientRect();
    return { gap: e.top - t.bottom, emptyH: e.height };
  });
  expect(emptyPlacement.gap, 'empty directly under title').toBeGreaterThanOrEqual(0);
  expect(emptyPlacement.gap, 'empty directly under title').toBeLessThanOrEqual(12);

  let g = await panelGeometry(page);
  const minFromContent = Math.ceil(
    g.titleH + g.titleMarginBottom + g.bodyH + g.panelPad,
  );
  expect(g.diagH, 'content min height').toBeGreaterThanOrEqual(minFromContent - 2);
  expect(g.diagH, 'content min height').toBeLessThanOrEqual(minFromContent + 2);
  expect(g.diagH, 'matches horizontal empty height').toBeGreaterThanOrEqual(horizontalH - 2);
  expect(g.diagH, 'matches horizontal empty height').toBeLessThanOrEqual(horizontalH + 2);
  expect(g.consoleContentH, 'console content-box ≥ 80').toBeGreaterThanOrEqual(DIAG_CONSOLE_MIN);
  expect(g.diagH / g.rightH, 'diag ≤ 15 % of right column').toBeLessThanOrEqual(0.15);

  // With findings the floor is unchanged (empty-line sized); list does not grow it.
  await seedDiagnostics(page, 2);
  g = await panelGeometry(page);
  expect(g.diagH, 'findings do not inflate the default').toBeLessThanOrEqual(minFromContent + 2);
  expect(await page.locator('.diagnostic-entry').count()).toBeGreaterThan(0);
});

test('VC-902 (FR-903, FR-913): separator between console and stdin with ARIA contract', async ({
  page,
}) => {
  await openVertical(page, null);
  await seedDiagnostics(page, 1);

  const resizer = page.locator('#diag-resizer');
  await expect(resizer).toBeVisible();
  await expect(resizer).toHaveAttribute('role', 'separator');
  await expect(resizer).toHaveAttribute('aria-orientation', 'horizontal');
  await expect(resizer).toHaveAttribute('aria-label', DIAG_RESIZER_LABEL);
  await expect(resizer).toHaveAttribute('aria-valuemin', /.+/);
  await expect(resizer).toHaveAttribute('aria-valuemax', /.+/);
  await expect(resizer).toHaveAttribute('aria-valuenow', /.+/);

  const g = await panelGeometry(page);
  expect(g.resizer.top, 'below console').toBeGreaterThanOrEqual(g.resizer.consoleBottom - 2);
  expect(g.resizer.bottom, 'above stdin').toBeLessThanOrEqual(g.resizer.stdinTop + 2);

  const order = await page.evaluate(() =>
    Array.from(document.getElementById('app')!.children)
      .filter(
        (el) =>
          el.classList.contains('panel') ||
          el.id === 'diag-resizer' ||
          el.id === 'output-resizer',
      )
      .map((el) =>
        el.id === 'diag-resizer' || el.id === 'output-resizer'
          ? el.id
          : (el.getAttribute('aria-label') ?? el.className),
      ),
  );
  expect(order).toEqual([
    'Special characters',
    'Console',
    'Editor',
    'output-resizer',
    'diag-resizer',
    'Standard input',
    'Diagnostics',
    'Files',
  ]);
  expect(await page.locator('#diag-resizer.panel').count()).toBe(0);
});

test('VC-903 (FR-904, FR-908): pointer drag upward clamps at 40 % / console ≥ 80', async ({
  page,
}) => {
  await openVertical(page, null);
  await seedDiagnostics(page, 1);
  const resizer = page.locator('#diag-resizer');
  const box = await resizer.boundingBox();
  expect(box).not.toBeNull();

  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2, box!.y - 800, { steps: 20 });
  await page.mouse.up();

  const g = await panelGeometry(page);
  expect(g.diagH / g.rightH).toBeLessThanOrEqual(DIAG_HEIGHT_MAX_RATIO + 0.01);
  expect(g.consoleContentH).toBeGreaterThanOrEqual(DIAG_CONSOLE_MIN);
  const now = Number(await resizer.getAttribute('aria-valuenow'));
  expect(now).toBeGreaterThanOrEqual(Math.round(g.diagH) - 1);
  expect(now).toBeLessThanOrEqual(Math.round(g.diagH) + 1);
});

test('VC-904 (FR-904, FR-907): pointer drag downward stops at content minimum', async ({
  page,
}) => {
  await openVertical(page, null);
  await seedDiagnostics(page, 1);
  const resizer = page.locator('#diag-resizer');
  // Grow first so there is room to shrink.
  await resizer.focus();
  await resizer.press('Shift+ArrowUp');
  await resizer.press('Shift+ArrowUp');

  const box = await resizer.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + 800, { steps: 20 });
  await page.mouse.up();

  const min = Number(await resizer.getAttribute('aria-valuemin'));
  const now = Number(await resizer.getAttribute('aria-valuenow'));
  const g = await panelGeometry(page);
  expect(g.diagH).toBeGreaterThanOrEqual(min - 2);
  expect(g.diagH).toBeLessThanOrEqual(min + 2);
  expect(now).toBe(min);

  // Further drag does not shrink past min.
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + 200, { steps: 5 });
  await page.mouse.up();
  expect(Number(await resizer.getAttribute('aria-valuenow'))).toBe(min);
});

test('VC-905 (FR-905): ArrowUp/Down steps are 16 px, Shift 48 px', async ({ page }) => {
  await openVertical(page, null);
  await seedDiagnostics(page, 1);
  const resizer = page.locator('#diag-resizer');
  await resizer.focus();
  const start = Number(await resizer.getAttribute('aria-valuenow'));

  await resizer.press('ArrowUp');
  expect(Number(await resizer.getAttribute('aria-valuenow'))).toBe(start + DIAG_HEIGHT_STEP);

  await resizer.press('Shift+ArrowUp');
  expect(Number(await resizer.getAttribute('aria-valuenow'))).toBe(
    start + DIAG_HEIGHT_STEP + DIAG_HEIGHT_STEP_LARGE,
  );

  await resizer.press('ArrowDown');
  expect(Number(await resizer.getAttribute('aria-valuenow'))).toBe(
    start + DIAG_HEIGHT_STEP_LARGE,
  );

  await resizer.press('Shift+ArrowDown');
  expect(Number(await resizer.getAttribute('aria-valuenow'))).toBe(start);
});

test('VC-906 (FR-906): Problems resizer is available in stacked layout', async ({ page }) => {
  await seedStorage(page, { layout: 'horizontal', diagHeight: null });
  await openPlayground(page, { seedLayout: false });
  await waitForPythonReady(page);
  await waitForLinter(page);

  const resizer = page.locator('#diag-resizer');
  await expect(resizer).toBeVisible();
  await expect(resizer).toHaveAttribute('aria-disabled', 'false');
  const maxH = await page.evaluate(
    () => getComputedStyle(document.querySelector('.panel--diagnostics')!).maxHeight,
  );
  expect(maxH).toMatch(/vh|px/);

  await page.setViewportSize(NARROW_PHONE);
  await page.evaluate((key) => window.localStorage.setItem(key, 'vertical'), LAYOUT_KEY);
  await page.reload();
  await page.waitForSelector('.cm-content');
  await waitForPythonReady(page);
  await expect
    .poll(() => page.evaluate(() => document.getElementById('app')?.dataset.layout))
    .toBe('horizontal');
  await expect(page.locator('#diag-resizer')).toBeVisible();
});
test('VC-907 (FR-909, FR-910): mid-range height restores on reload', async ({ page }) => {
  await openVertical(page, null);
  await seedDiagnostics(page, 1);
  const resizer = page.locator('#diag-resizer');
  await resizer.focus();
  for (let i = 0; i < 6; i++) await resizer.press('ArrowUp');
  const mid = Number(await resizer.getAttribute('aria-valuenow'));
  expect(mid).toBeGreaterThan(Number(await resizer.getAttribute('aria-valuemin')));

  const stored = await page.evaluate((key) => window.localStorage.getItem(key), DIAG_HEIGHT_KEY);
  expect(stored).toBe(String(mid));

  await page.reload();
  await page.waitForSelector('.cm-content');
  await waitForPythonReady(page);
  await waitForLinter(page);
  await expect
    .poll(async () => Number(await page.locator('#diag-resizer').getAttribute('aria-valuenow')))
    .toBe(mid);
  const g = await panelGeometry(page);
  expect(g.diagH).toBeGreaterThanOrEqual(mid - 2);
  expect(g.diagH).toBeLessThanOrEqual(mid + 2);
});

test('VC-908 (FR-910, FR-908): oversize stored height clamps without rewrite', async ({ page }) => {
  await openVertical(page, '9999');
  await seedDiagnostics(page, 1);
  const resizer = page.locator('#diag-resizer');
  const now = Number(await resizer.getAttribute('aria-valuenow'));
  const max = Number(await resizer.getAttribute('aria-valuemax'));
  expect(now).toBe(max);
  expect(now).toBeLessThan(9999);
  expect(await page.evaluate((key) => window.localStorage.getItem(key), DIAG_HEIGHT_KEY)).toBe(
    '9999',
  );
});

test('VC-909 (FR-911): non-canonical / missing height yields the minimum', async ({ page }) => {
  // Layout only — VC-909 writes the height key itself before each reload.
  await seedStorage(page, { layout: 'vertical' });
  await openPlayground(page, { seedLayout: false });
  await waitForPythonReady(page);
  await waitForLinter(page);

  const assertMinAndStored = async (raw: string | null, label: string): Promise<void> => {
    await page.evaluate(
      ({ heightKey, layoutKey, raw: value }) => {
        window.localStorage.setItem(layoutKey, 'vertical');
        if (value === null) window.localStorage.removeItem(heightKey);
        else window.localStorage.setItem(heightKey, value);
      },
      { heightKey: DIAG_HEIGHT_KEY, layoutKey: LAYOUT_KEY, raw },
    );
    await page.reload();
    await page.waitForSelector('.cm-content');
    await waitForPythonReady(page);
    await waitForLinter(page);
    const resizer = page.locator('#diag-resizer');
    const min = Number(await resizer.getAttribute('aria-valuemin'));
    expect(Number(await resizer.getAttribute('aria-valuenow')), label).toBe(min);
    expect(
      await page.evaluate((key) => window.localStorage.getItem(key), DIAG_HEIGHT_KEY),
      `${label} left in place`,
    ).toBe(raw);
  };

  for (const raw of ['', '0', '036', '12.5', '40%', 'tall', '-1'] as const) {
    await assertMinAndStored(raw, `raw=${JSON.stringify(raw)}`);
  }
  await assertMinAndStored(null, 'missing key');

  // getItem throwing → minimum.
  await page.addInitScript((key) => {
    const original = window.localStorage.getItem.bind(window.localStorage);
    Object.defineProperty(window.localStorage, 'getItem', {
      configurable: true,
      value: (k: string) => {
        if (k === key) throw new DOMException('denied', 'SecurityError');
        return original(k);
      },
    });
  }, DIAG_HEIGHT_KEY);
  await page.evaluate((key) => window.localStorage.setItem(key, '120'), DIAG_HEIGHT_KEY);
  await page.reload();
  await page.waitForSelector('.cm-content');
  await waitForPythonReady(page);
  {
    const resizer = page.locator('#diag-resizer');
    const min = Number(await resizer.getAttribute('aria-valuemin'));
    expect(Number(await resizer.getAttribute('aria-valuenow'))).toBe(min);
  }
});
test('VC-910 (FR-912): failed setItem shows the notice once', async ({ page }) => {
  await page.addInitScript((key) => {
    const original = window.localStorage.setItem.bind(window.localStorage);
    Object.defineProperty(window.localStorage, 'setItem', {
      configurable: true,
      value: (k: string, value: string) => {
        if (k === key) throw new DOMException('quota', 'QuotaExceededError');
        original(k, value);
      },
    });
  }, DIAG_HEIGHT_KEY);
  await openVertical(page, null);
  await seedDiagnostics(page, 1);
  const resizer = page.locator('#diag-resizer');
  const before = Number(await resizer.getAttribute('aria-valuenow'));
  await resizer.focus();
  await resizer.press('ArrowUp');
  expect(Number(await resizer.getAttribute('aria-valuenow'))).toBe(before + DIAG_HEIGHT_STEP);
  await expect(page.locator(`#notices [data-notice="${DIAG_HEIGHT_SAVE_FAILED}"]`)).toHaveCount(1);

  await resizer.press('ArrowUp');
  await expect(page.locator(`#notices [data-notice="${DIAG_HEIGHT_SAVE_FAILED}"]`)).toHaveCount(1);
  expect(Number(await resizer.getAttribute('aria-valuenow'))).toBe(before + 2 * DIAG_HEIGHT_STEP);
});

test('VC-911 (FR-914, BR-905): resize leaves editor/console/layout/theme alone; never disabled', async ({
  page,
}) => {
  const requests: string[] = [];
  const record = (request: Request): void => void requests.push(request.url());
  page.on('request', record);

  await openVertical(page, null);
  await seedDiagnostics(page, 2);
  const before = {
    editor: await editorText(page),
    console: await consoleText(page),
    count: await page.locator('#diagnostics-count').textContent(),
    layout: await page.evaluate((key) => window.localStorage.getItem(key), LAYOUT_KEY),
    theme: await page.evaluate((key) => window.localStorage.getItem(key), THEME_KEY),
  };

  requests.length = 0;
  const resizer = page.locator('#diag-resizer');
  await expect(resizer).not.toHaveAttribute('disabled', /.*/);
  const box = await resizer.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2, box!.y - 40, { steps: 5 });
  await page.mouse.up();
  await resizer.focus();
  await resizer.press('ArrowUp');
  await expect(resizer).not.toHaveAttribute('disabled', /.*/);

  page.off('request', record);
  expect(await editorText(page)).toBe(before.editor);
  expect(await consoleText(page)).toBe(before.console);
  expect(await page.locator('#diagnostics-count').textContent()).toBe(before.count);
  expect(await page.evaluate((key) => window.localStorage.getItem(key), LAYOUT_KEY)).toBe(
    before.layout,
  );
  expect(await page.evaluate((key) => window.localStorage.getItem(key), THEME_KEY)).toBe(
    before.theme,
  );
  expect(requests, 'no resize-triggered network').toEqual([]);
});

test('VC-913 (end-to-end): enlarge, persist, layout and viewport round-trip', async ({ page }) => {
  await openVertical(page, null);
  await seedDiagnostics(page, 3);
  const resizer = page.locator('#diag-resizer');
  const min = Number(await resizer.getAttribute('aria-valuemin'));
  expect(Number(await resizer.getAttribute('aria-valuenow')), 'starts at content min').toBe(min);

  // Enlarge past the content floor so a restored height is distinguishable.
  await resizer.focus();
  for (let i = 0; i < 10; i++) {
    await resizer.press('ArrowUp');
  }
  const restored = Number(await resizer.getAttribute('aria-valuenow'));
  expect(restored, 'keyboard enlarge past min').toBeGreaterThan(min);
  expect(await intersectsDiagClient(page, '.diagnostic-entry')).toBe(true);

  await page.reload();
  await page.waitForSelector('.cm-content');
  await waitForPythonReady(page);
  await waitForLinter(page);
  await expect
    .poll(async () => Number(await page.locator('#diag-resizer').getAttribute('aria-valuenow')))
    .toBe(restored);

  await page.click('#layout-horizontal');
  await expect(page.locator('#diag-resizer')).toBeVisible();
  expect(Number(await page.locator('#diag-resizer').getAttribute('aria-valuenow'))).toBe(restored);

  await page.click('#layout-vertical');
  await expect(page.locator('#diag-resizer')).toBeVisible();
  expect(Number(await page.locator('#diag-resizer').getAttribute('aria-valuenow'))).toBe(restored);

  await page.setViewportSize({ width: 800, height: 700 });
  await expect(page.locator('#diag-resizer')).toBeVisible();

  await page.setViewportSize(WIDE);
  await expect(page.locator('#diag-resizer')).toBeVisible();
  expect(Number(await page.locator('#diag-resizer').getAttribute('aria-valuenow'))).toBe(restored);
});

/* -------------------------------------------------------------------------
   VC-912 — NFR-901 / NFR-903 (contrast → VC-071; geometry → VC-409/435)
   ------------------------------------------------------------------------- */
test('VC-912 (NFR-901, NFR-903): hit target and apply-height ≤ 50 ms', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openVertical(page, null);

  // NFR-901: separator hit height ≥ 8 CSS px.
  const hit = await page.evaluate(() => {
    const el = document.getElementById('diag-resizer')!;
    return el.getBoundingClientRect().height;
  });
  expect(hit, 'NFR-901 hit height').toBeGreaterThanOrEqual(8);

  // Fifty diagnostics for the latency probe (NFR-903).
  const fifty = Array.from({ length: 50 }, (_, i) => `unused_${i}`).join('\n');
  await setProgram(page, `${fifty}\n`);
  await expect.poll(async () => (await diagnosticEntries(page)).length).toBeGreaterThanOrEqual(50);
  await waitForPythonReady(page);

  const longTaskTracker = await trackLongTasks(page);
  await page.waitForTimeout(250);
  await longTaskTracker.reset();

  const applyMs = await page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const resizer = document.getElementById('diag-resizer')!;
        const start = performance.now();
        const before = resizer.getAttribute('aria-valuenow');
        const check = (): void => {
          if (resizer.getAttribute('aria-valuenow') !== before) {
            requestAnimationFrame(() => resolve(performance.now() - start));
            return;
          }
          requestAnimationFrame(check);
        };
        setTimeout(() => reject(new Error('height never changed')), 5_000);
        resizer.focus();
        resizer.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }),
        );
        requestAnimationFrame(check);
      }),
  );
  await page.waitForTimeout(300);
  const longTasks = await longTaskTracker.read();

  expect(applyMs, 'NFR-903 paint after apply-height').toBeLessThanOrEqual(50);
  expect(Math.max(0, ...longTasks), 'NFR-903 longest task').toBeLessThanOrEqual(50);

  console.log(
    [
      'VC-912 measurements:',
      `  NFR-901 hit height                    ${hit.toFixed(0)} px   (>= 8)`,
      `  NFR-903 apply-height -> paint          ${applyMs.toFixed(0)} ms   (<= 50)`,
      `  NFR-903 longest task                   ${Math.max(0, ...longTasks).toFixed(0)} ms   (<= 50)`,
      '  NFR-904 app size delta                 (historical — see specs/09-minimal-diags-frozen.md)',
    ].join('\n'),
  );
});
