/**
 * Spec 07 — right-align Symbols and color-mode on the toolbar.
 * Spec 08 amendment — `#btn-about` joins the inline-end cluster and is the
 * flush edge (FR-801 / assumption: Symbols → theme → About as a group).
 *
 * VC-701 (FR-701, amended) — #btn-about flush with toolbar content-box inline-end.
 * VC-702 (FR-702) — Symbols/theme gap is 6 ± 1 px; nothing between them.
 * VC-703 (FR-703, FR-706, FR-1313) — one oversized gap, between Output and Symbols.
 * VC-704 (FR-704, BR-701, amended) — Tab order is the twelve-stop sequence
 *   through `#btn-about`.
 * VC-705 (FR-705) — below 900 px no auto-margin; at 900 px VC-701 holds.
 * VC-707 (BR-703) — Symbols / theme still work from the new position.
 * VC-708 (BR-704, BR-301) — clicks do not touch the editor undo/doc.
 */
import { expect, test, type Page } from '@playwright/test';
import { openPlayground } from './helpers';

const LAYOUT_KEY = 'pyplay.layout.v2';
const THEME_KEY = 'pyplay.theme.v1';

const WIDE = { width: 1280, height: 800 };
const AT_BREAKPOINT = { width: 900, height: 667 };
const JUST_BELOW = { width: 899, height: 667 };
const NARROW = { width: 375, height: 667 };

/** Visible toolbar controls in DOM order (skip `#layout-narrow-hint`). */
const TOOLBAR_CONTROL_IDS = [
  'btn-run',
  'btn-stop',
  'btn-clear',
  'btn-copy',
  'btn-format',
  'btn-reset',
  'layout-group',
  'btn-files',
  'btn-output',
  'btn-symbols',
  'btn-theme',
  'btn-about',
] as const;

/** FR-704 Tab sequence from `#btn-run` through `#btn-about` (spec-08). */
const FR704_STOPS = [
  'btn-run',
  'btn-stop',
  'btn-clear',
  'btn-copy',
  'btn-format',
  'btn-reset',
  'layout-group',
  'btn-files',
  'btn-output',
  'btn-symbols',
  'btn-theme',
  'btn-about',
] as const;

type Layout = 'horizontal' | 'vertical';
type Box = { id: string; left: number; right: number; top: number; bottom: number; width: number; height: number };

async function seedLayout(page: Page, value: Layout): Promise<void> {
  await page.addInitScript(
    ({ key, value }) => {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        /* Storage denial is out of scope for these placement checks. */
      }
    },
    { key: LAYOUT_KEY, value },
  );
}

async function seedTheme(page: Page, value: string): Promise<void> {
  await page.addInitScript(
    ({ key, value }) => {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        /* ignore */
      }
    },
    { key: THEME_KEY, value },
  );
}

async function renderedLayout(page: Page): Promise<string | undefined> {
  return page.evaluate(() => document.getElementById('app')?.dataset.layout);
}

/**
 * Toolbar content-box inline-end edge and `#btn-about` border-box right
 * (spec-08: About is the last control in the presentation cluster).
 * Content-box = border-box right − border-right − padding-right (D-002).
 */
async function aboutFlushMeasurement(page: Page): Promise<{
  aboutRight: number;
  toolbarContentRight: number;
  delta: number;
}> {
  return page.evaluate(() => {
    const toolbar = document.querySelector('header.toolbar') as HTMLElement;
    const about = document.getElementById('btn-about') as HTMLElement;
    const style = getComputedStyle(toolbar);
    const box = toolbar.getBoundingClientRect();
    const toolbarContentRight =
      box.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth);
    const aboutRight = about.getBoundingClientRect().right;
    return {
      aboutRight,
      toolbarContentRight,
      delta: Math.abs(aboutRight - toolbarContentRight),
    };
  });
}

/** Bounding boxes of visible toolbar controls in DOM order. */
async function visibleToolbarBoxes(page: Page): Promise<Box[]> {
  return page.evaluate((ids) => {
    const boxes: Box[] = [];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      // Skip zero-size / visually hidden (e.g. empty narrow-hint is not in ids).
      if (r.width <= 0 || r.height <= 0) continue;
      boxes.push({
        id,
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      });
    }
    return boxes;
  }, [...TOOLBAR_CONTROL_IDS]);
}

/**
 * Inter-control gaps on the same flex line (shared rounded top). A packed
 * gap is 6 ± 1; anything larger is the FR-703 whitespace span.
 */
function sameLineGaps(boxes: Box[]): { from: string; to: string; gap: number }[] {
  const gaps: { from: string; to: string; gap: number }[] = [];
  for (let i = 0; i < boxes.length - 1; i++) {
    const a = boxes[i]!;
    const b = boxes[i + 1]!;
    if (Math.round(a.top) !== Math.round(b.top)) continue;
    gaps.push({ from: a.id, to: b.id, gap: b.left - a.right });
  }
  return gaps;
}

function isPackedGap(gap: number): boolean {
  return Math.abs(gap - 6) <= 1;
}

/** Doc text + CodeMirror undo depth (same form as theme.spec VC-510). */
async function editorDocAndUndo(page: Page): Promise<{ text: string; undoDepth: number }> {
  return page.evaluate(() => {
    const content = document.querySelector('.cm-content') as
      | (HTMLElement & {
          cmView?: {
            view: {
              state: { doc: { toString(): string }; values: unknown[] };
            };
          };
          cmTile?: {
            view: {
              state: { doc: { toString(): string }; values: unknown[] };
            };
          };
        })
      | null;
    const view = content?.cmTile?.view ?? content?.cmView?.view;
    if (!view) throw new Error('CodeMirror view not found');
    let undoDepth = 0;
    for (const v of view.state.values) {
      if (
        v &&
        typeof v === 'object' &&
        Array.isArray((v as { done?: unknown }).done) &&
        Array.isArray((v as { undone?: unknown }).undone)
      ) {
        const branch = (v as { done: { changes?: unknown }[] }).done;
        undoDepth = branch.length - (branch.length && !branch[0]?.changes ? 1 : 0);
        break;
      }
    }
    return { text: view.state.doc.toString(), undoDepth };
  });
}

/* -------------------------------------------------------------------------
   VC-701 (FR-701)
   ------------------------------------------------------------------------- */

for (const layout of ['horizontal', 'vertical'] as const) {
  test(`VC-701 (FR-701): #btn-about flush with toolbar content-box end (${layout})`, async ({
    page,
  }) => {
    await page.setViewportSize(WIDE);
    await seedLayout(page, layout);
    await openPlayground(page, { seedLayout: false });
    expect(await renderedLayout(page)).toBe(layout);

    const m = await aboutFlushMeasurement(page);
    expect(m.delta, `aboutRight=${m.aboutRight} toolbarContentRight=${m.toolbarContentRight}`).toBeLessThanOrEqual(
      1,
    );
  });
}

/* -------------------------------------------------------------------------
   VC-702 (FR-702)
   ------------------------------------------------------------------------- */

test('VC-702 (FR-702): Symbols/theme gap is 6 ± 1 px with nothing between', async ({ page }) => {
  await page.setViewportSize(WIDE);
  await seedLayout(page, 'horizontal');
  await openPlayground(page, { seedLayout: false });

  const result = await page.evaluate(() => {
    const symbols = document.getElementById('btn-symbols')!;
    const theme = document.getElementById('btn-theme')!;
    const s = symbols.getBoundingClientRect();
    const t = theme.getBoundingClientRect();
    const gap = t.left - s.right;

    // No other toolbar child with a positive box sits between them on the row.
    const between = Array.from(document.querySelectorAll('header.toolbar > *')).filter((el) => {
      if (el === symbols || el === theme) return false;
      if (el.id === 'layout-narrow-hint') return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const midY = (s.top + s.bottom) / 2;
      if (r.bottom <= midY || r.top >= midY) return false;
      return r.left >= s.right - 0.5 && r.right <= t.left + 0.5;
    });

    return {
      gap,
      immediatelyFollows: symbols.nextElementSibling === theme,
      interveningIds: between.map((el) => (el as HTMLElement).id || el.tagName),
    };
  });

  expect(Math.abs(result.gap - 6)).toBeLessThanOrEqual(1);
  expect(result.immediatelyFollows).toBe(true);
  expect(result.interveningIds).toEqual([]);
});

/* -------------------------------------------------------------------------
   VC-703 (FR-703, FR-706)
   ------------------------------------------------------------------------- */

test('VC-703 (FR-703, FR-706, FR-1313): exactly one oversized gap, between Output and Symbols', async ({
  page,
}) => {
  await page.setViewportSize(WIDE);
  await seedLayout(page, 'horizontal');
  await openPlayground(page, { seedLayout: false });

  const boxes = await visibleToolbarBoxes(page);
  expect(boxes.map((b) => b.id)).toEqual([...TOOLBAR_CONTROL_IDS]);

  const gaps = sameLineGaps(boxes);
  const oversized = gaps.filter((g) => !isPackedGap(g.gap));
  expect(
    oversized,
    `gaps: ${gaps.map((g) => `${g.from}→${g.to}=${g.gap.toFixed(1)}`).join(', ')}`,
  ).toHaveLength(1);
  expect(oversized[0]!.from).toBe('btn-output');
  expect(oversized[0]!.to).toBe('btn-symbols');
  expect(oversized[0]!.gap).toBeGreaterThan(7);
});

/* -------------------------------------------------------------------------
   VC-704 (FR-704, BR-701)
   ------------------------------------------------------------------------- */

for (const layout of ['horizontal', 'vertical'] as const) {
  for (const palette of [
    { theme: 'light', colorScheme: 'light' as const, effective: 'light' },
    { theme: 'dark', colorScheme: 'dark' as const, effective: 'dark' },
  ]) {
    test(`VC-704 (FR-704): Tab twelve stops ${layout} / effective ${palette.effective}`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: palette.colorScheme });
      await page.setViewportSize(WIDE);
      await seedLayout(page, layout);
      await seedTheme(page, palette.theme);
      await openPlayground(page, { seedLayout: false });
      expect(await renderedLayout(page)).toBe(layout);
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.effective))
        .toBe(palette.effective);

      // Land on `#btn-run` via keyboard so `:focus-visible` rings apply.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.locator('body').click({ position: { x: 2, y: 2 } });
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

      let onRun = false;
      for (let i = 0; i < 16; i++) {
        await page.keyboard.press('Tab');
        const id = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el || el === document.body) return '';
          if (el.closest('#layout-group')) return 'layout-group';
          return el.id;
        });
        if (id === 'btn-run') {
          onRun = true;
          break;
        }
      }
      expect(onRun, 'Tab reached #btn-run').toBe(true);

      const stops: string[] = ['btn-run'];
      for (let i = 0; i < FR704_STOPS.length - 1; i++) {
        await page.keyboard.press('Tab');
        const id = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el || el === document.body) return '';
          if (el.closest('#layout-group')) return 'layout-group';
          return el.id;
        });
        stops.push(id);
      }

      expect(stops).toEqual([...FR704_STOPS]);
      expect(stops.filter((s) => s === 'layout-group')).toHaveLength(1);
      expect(stops).toContain('btn-files');
    });
  }
}

/* -------------------------------------------------------------------------
   VC-705 (FR-705)
   ------------------------------------------------------------------------- */

for (const viewport of [JUST_BELOW, NARROW] as const) {
  test(`VC-705 (FR-705): no oversized same-line gap at ${viewport.width}×${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await seedLayout(page, 'horizontal');
    await openPlayground(page, { seedLayout: false });

    const boxes = await visibleToolbarBoxes(page);
    const gaps = sameLineGaps(boxes);
    const oversized = gaps.filter((g) => !isPackedGap(g.gap));
    expect(
      oversized,
      `oversized at ${viewport.width}: ${oversized.map((g) => `${g.from}→${g.to}=${g.gap.toFixed(1)}`).join(', ')}`,
    ).toEqual([]);
  });
}

test('VC-705 (FR-705): at 900×667 VC-701 flush still holds', async ({ page }) => {
  await page.setViewportSize(AT_BREAKPOINT);
  await seedLayout(page, 'horizontal');
  await openPlayground(page, { seedLayout: false });

  const m = await aboutFlushMeasurement(page);
  expect(m.delta, `aboutRight=${m.aboutRight} toolbarContentRight=${m.toolbarContentRight}`).toBeLessThanOrEqual(
    1,
  );
});

/* -------------------------------------------------------------------------
   VC-707 (BR-703)
   ------------------------------------------------------------------------- */

test('VC-707 (BR-703): Symbols and theme still work from the new position', async ({ page }) => {
  await page.setViewportSize(WIDE);
  await seedLayout(page, 'horizontal');
  await seedTheme(page, 'light');
  await openPlayground(page, { seedLayout: false });

  const beforeTheme = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    effective: document.documentElement.dataset.effective,
  }));

  const hit = await page.evaluate(() => {
    const symbols = document.getElementById('btn-symbols')!.getBoundingClientRect();
    const theme = document.getElementById('btn-theme')!.getBoundingClientRect();
    return {
      symbols: { w: symbols.width, h: symbols.height },
      theme: { w: theme.width, h: theme.height },
      symbolsDisabled: document.getElementById('btn-symbols')!.getAttribute('aria-disabled'),
      themeDisabled: document.getElementById('btn-theme')!.getAttribute('aria-disabled'),
    };
  });
  expect(hit.symbols.w).toBeGreaterThanOrEqual(32);
  expect(hit.symbols.h).toBeGreaterThanOrEqual(32);
  expect(hit.theme.w).toBeGreaterThanOrEqual(32);
  expect(hit.theme.h).toBeGreaterThanOrEqual(32);
  expect(hit.symbolsDisabled).toBeNull();
  expect(hit.themeDisabled).toBeNull();

  await page.locator('#btn-symbols').click();
  await expect(page.locator('#btn-symbols')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#symbol-pane')).toBeVisible();

  await page.locator('#btn-theme').click();
  const afterTheme = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    effective: document.documentElement.dataset.effective,
  }));
  expect(
    afterTheme.theme !== beforeTheme.theme || afterTheme.effective !== beforeTheme.effective,
    `theme did not advance: before=${JSON.stringify(beforeTheme)} after=${JSON.stringify(afterTheme)}`,
  ).toBe(true);
});

/* -------------------------------------------------------------------------
   VC-708 (BR-704, BR-301)
   ------------------------------------------------------------------------- */

test('VC-708 (BR-704): Symbols/theme clicks leave editor undo and doc unchanged', async ({
  page,
}) => {
  await page.setViewportSize(WIDE);
  await seedLayout(page, 'horizontal');
  await openPlayground(page, { seedLayout: false });

  await page.locator('.cm-content').click();
  await page.keyboard.type('x');

  const before = await editorDocAndUndo(page);
  expect(before.undoDepth).toBeGreaterThanOrEqual(1);

  await page.locator('#btn-symbols').click();
  await expect(page.locator('#symbol-pane')).toBeVisible();
  await page.locator('#btn-theme').click();

  const after = await editorDocAndUndo(page);
  expect(after.text).toBe(before.text);
  expect(after.undoDepth).toBe(before.undoDepth);
});
