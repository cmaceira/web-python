/**
 * spec-04 — the horizontal / vertical pane layout.
 *
 * Both names describe the orientation of the divider between the panels, as
 * `vim`'s `:split` / `:vsplit` do: `horizontal` stacks them in one column
 * (spec-01's rendering, and the only layout below 900 px), `vertical` puts the
 * editor beside the console. `src/layout.ts` is normative for the two words;
 * the comments below say "stacked" and "two-column" where the geometry is what
 * matters, and use the token only when naming the attribute value.
 *
 * Iteration 2's criteria: the two renderings and the resolution rule. The
 * toolbar control that drives them arrives in iteration 3, so these tests
 * reach the layout the way the shipped code does — through the stored
 * preference and the viewport width — never by writing `data-layout` by hand
 * except where a criterion explicitly renders a given attribute value.
 *
 * VC-408 (FR-407) — the stacked layout is the baseline build, +/-1 px.
 * VC-409 (FR-408, BR-407) — editor column inline-start of the other three.
 * VC-410 (FR-409) — 58 % split, 320 px floors, no h-scroll, 40 % cap.
 * VC-411 (FR-410, BR-402) — identical document order; no `childList` churn.
 * VC-412 (FR-411, FR-412, BR-405) — the 900 px crossing re-resolves.
 * VC-413 (FR-413, BR-404, BR-405) — the narrow override never overwrites.
 * VC-416 (FR-416) — resolved in the first painted frame.
 * VC-417 (FR-417) — malformed stored values are absent, and left in place.
 * VC-418 (FR-417) — a throwing store still boots and still runs Python.
 * VC-435 (FR-409) — short viewports keep the console's 80 px floor.
 */
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LAYOUT_NARROW_HINT } from '../../src/format';
import { failures, measureContrast, type Sample } from './contrast';
import {
  openPlayground,
  runProgram,
  submitStdin,
  waitForLinter,
  waitForPythonReady,
  waitForStdinPrompt,
} from './helpers';

const LAYOUT_KEY = 'pyplay.layout.v2';

/** FR-411 / BR-404's breakpoint, and `LAYOUT_MIN_WIDTH` in `src/layout.ts`. */
const LAYOUT_MIN_WIDTH = 900;

const WIDE = { width: 1280, height: 800 };
const NARROW = { width: 375, height: 667 };

type Layout = 'horizontal' | 'vertical';
type Box = { top: number; right: number; bottom: number; left: number };

interface Stack {
  top: number;
  bottom: number;
  height: number;
  contentTop: number;
  contentBottom: number;
  gap: number;
  toolbarHeight: number;
}

interface PanelFlex {
  grow: string;
  shrink: string;
  basis: string;
  minHeight: string;
  maxHeight: string;
}

interface Measurement {
  boxes: Record<string, Box>;
  flex: Record<string, PanelFlex>;
  diagnosticsMaxHeight: string;
  appContentWidth: number;
  stack: Stack;
}

interface BaselineGeometry {
  commit: string;
  /** `<platform>-<arch> chromium <version>` of the run that recorded it. */
  recordedOn?: string;
  viewports: Record<string, Measurement>;
}

/**
 * VC-408's reference measurements, recorded from a build of commit `384cb70`
 * by `scripts/record-baseline-geometry.mjs`.
 *
 * The panel column's top and the toolbar's height are text metrics, so a
 * record is only comparable to a run of the environment that produced it: the
 * same `384cb70` build puts the stacked column's top at 82 px on a GitHub
 * `ubuntu-latest` runner, at 84 px in the Playwright Linux image and at 82 px
 * on darwin-arm64, with the toolbar a pixel taller in the two linux ones.
 * Comparing across that gap reports a font as a layout regression — it is what
 * made VC-408 red on CI while the same tree passed locally.
 *
 * So CI records its own baseline from `384cb70` before the suite runs and
 * points `PYPLAY_BASELINE_GEOMETRY` at it (`.github/workflows/pr.yml`), and
 * the committed record is the fallback for a local run of the environment it
 * names. A run that matches neither *skips* rather than reporting a pass it
 * did not earn — `scripts/record-baselines.mjs` records one in a command.
 */
const GEOMETRY_RECORD =
  process.env.PYPLAY_BASELINE_GEOMETRY ??
  fileURLToPath(new URL('./baseline-geometry.json', import.meta.url));

const BASELINE = JSON.parse(readFileSync(GEOMETRY_RECORD, 'utf8')) as BaselineGeometry;

/** Seed the preference before any script of the page runs (FR-416, FR-417). */
async function seedPreference(page: Page, value: string | null): Promise<void> {
  await page.addInitScript((seed) => {
    try {
      if (seed === null) window.localStorage.removeItem('pyplay.layout.v2');
      else window.localStorage.setItem('pyplay.layout.v2', seed);
    } catch {
      /* Storage denial is VC-418's subject, not this helper's. */
    }
  }, value);
}

/** The value under `pyplay.layout.v2`, byte for byte, or null. */
async function storedLayout(page: Page): Promise<string | null> {
  return page.evaluate((key) => window.localStorage.getItem(key), LAYOUT_KEY);
}

/** `#app`'s current `data-layout`. */
async function renderedLayout(page: Page): Promise<string | undefined> {
  return page.evaluate(() => document.getElementById('app')?.dataset.layout);
}

/** Wait for `data-layout` to reach `layout`. Correctness only — see below. */
async function expectLayoutWithin(page: Page, layout: Layout, timeout = 5_000): Promise<void> {
  await page.waitForFunction(
    (want) => document.getElementById('app')?.dataset.layout === want,
    layout,
    { timeout },
  );
}

/**
 * Record, inside the page, how long each `data-layout` change took to land
 * after the viewport crossing that caused it.
 *
 * FR-412's 100 ms is a property of the page: the resolver runs synchronously
 * in the `matchMedia` `change` handler, with no debounce. Polling for it from
 * the test process measures something else — Playwright's CDP round trip and
 * whatever else the machine is running — which under `fullyParallel` is
 * enough to blow a 100 ms budget the page itself met in under a millisecond.
 * So the clock lives in the page: `resize` and the `matchMedia` `change` are
 * dispatched from the same layout update, making the `resize` timestamp the
 * moment of the crossing, and the `MutationObserver` timestamp the moment the
 * attribute changed.
 */
async function recordCrossingLatency(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = { lastResize: performance.now(), latencies: [] as number[] };
    (window as unknown as { __layoutLatency: typeof state }).__layoutLatency = state;
    window.addEventListener('resize', () => {
      state.lastResize = performance.now();
    });
    new MutationObserver(() => {
      state.latencies.push(performance.now() - state.lastResize);
    }).observe(document.getElementById('app')!, {
      attributes: true,
      attributeFilter: ['data-layout'],
    });
  });
}

/** The recorded crossing latencies, in milliseconds (see above). */
async function crossingLatencies(page: Page): Promise<number[]> {
  return page.evaluate(
    () => (window as unknown as { __layoutLatency: { latencies: number[] } }).__layoutLatency.latencies,
  );
}

/**
 * The four panels' boxes, the diagnostics cap and the panel stack's envelope.
 * Deliberately the same shape `scripts/record-baseline-geometry.mjs` records,
 * so VC-408 compares like with like.
 */
async function measurePanels(page: Page): Promise<Measurement> {
  return page.evaluate(() => {
    const round = (n: number): number => Math.round(n * 100) / 100;
    const boxes: Record<string, Box> = {};
    const flex: Record<string, PanelFlex> = {};
    for (const name of ['console', 'editor', 'stdin', 'diagnostics']) {
      const el = document.querySelector(`.panel--${name}`);
      if (!el) throw new Error(`missing .panel--${name}`);
      const box = el.getBoundingClientRect();
      boxes[name] = {
        top: round(box.top),
        right: round(box.right),
        bottom: round(box.bottom),
        left: round(box.left),
      };
      const panelStyle = getComputedStyle(el);
      flex[name] = {
        grow: panelStyle.flexGrow,
        shrink: panelStyle.flexShrink,
        basis: panelStyle.flexBasis,
        minHeight: panelStyle.minHeight,
        maxHeight: panelStyle.maxHeight,
      };
    }
    const app = document.getElementById('app') as HTMLElement;
    const style = getComputedStyle(app);
    const appBox = app.getBoundingClientRect();
    return {
      boxes,
      flex,
      diagnosticsMaxHeight: getComputedStyle(
        document.querySelector('.panel--diagnostics') as Element,
      ).maxHeight,
      // The grid's `58%` resolves against the content box, so that — not
      // `clientWidth` — is the "app content width" VC-409 and VC-410 mean.
      appContentWidth: round(
        app.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      ),
      stack: {
        top: round(boxes['console']!.top),
        bottom: round(boxes['diagnostics']!.bottom),
        height: round(boxes['diagnostics']!.bottom - boxes['console']!.top),
        contentTop: round(appBox.top + parseFloat(style.paddingTop)),
        contentBottom: round(appBox.bottom - parseFloat(style.paddingBottom)),
        gap: round(parseFloat(style.rowGap)),
        toolbarHeight: round(
          (document.querySelector('.toolbar') as HTMLElement).getBoundingClientRect().height,
        ),
      },
    };
  });
}

/* -------------------------------------------------------------------------
   VC-408 (FR-407): the stacked layout is the shipped one, to the pixel.
   ------------------------------------------------------------------------- */

for (const viewport of [WIDE, NARROW]) {
  const key = `${viewport.width}x${viewport.height}`;

  test(`VC-408 (FR-407): the stacked layout matches the ${BASELINE.commit} build at ${key}`, async ({
    page,
  }) => {
    test.skip(BASELINE.viewports[key] === undefined, `no baseline recorded for ${key}`);
    const reference = BASELINE.viewports[key]!;

    // The record has to come from this environment — see `GEOMETRY_RECORD`.
    const here = `${process.platform}-${process.arch} chromium ${page.context().browser()!.version()}`;
    test.skip(
      BASELINE.recordedOn !== here,
      `${GEOMETRY_RECORD} was recorded on "${BASELINE.recordedOn ?? 'an unrecorded environment'}", ` +
        `this run is "${here}" — text metrics differ between them, so the two are not ` +
        `comparable. Record one with: node scripts/record-baselines.mjs ${BASELINE.commit} ` +
        `--geometry <out.json>, then set PYPLAY_BASELINE_GEOMETRY to it.`,
    );

    await page.setViewportSize(viewport);
    // The preference is how the shipped resolver is asked for vertical at a
    // width where an unset preference would resolve to horizontal (FR-411).
    await seedPreference(page, 'horizontal');
    await openPlayground(page, { seedLayout: false });
    await waitForPythonReady(page);
    await waitForLinter(page);
    expect(await renderedLayout(page)).toBe('horizontal');

    // The files pane (undocumented by spec-04, predating none of this) opens
    // by default at >= 700 px and shifts every panel it doesn't appear in
    // this frozen `384cb70` baseline. Close it so FR-407's pixel-for-pixel
    // comparison is against the layout that baseline actually describes.
    const filePane = page.locator('#file-pane');
    if (!(await filePane.isHidden())) {
      await page.locator('#btn-files').click();
      await expect(filePane).toBeHidden();
    }

    const actual = await measurePanels(page);
    const names = ['console', 'editor', 'stdin', 'diagnostics'] as const;

    /*
     * FR-407 protects the stacked layout; FR-401 adds a control to the
     * toolbar. Those two pull in opposite directions on the panels' absolute
     * page coordinates: a taller toolbar row — and at 375 px a wrapped one —
     * starts the panel column lower and leaves it less height to share out.
     * No implementation of FR-401 can avoid that, so VC-408's +/-1 px is
     * asserted against what FR-407 actually names: the inline extents, the
     * document order, the flex ratios, the minimum heights and the `25vh`
     * cap. The one number allowed to differ is the header block's height,
     * and it is asserted to be the *only* difference — see the amendment
     * recorded in `specs/04-toogle-pane-aspect-frozen.md`.
     */
    const headerGrowth = actual.stack.top - reference.stack.top;
    const toolbarGrowth = actual.stack.toolbarHeight - reference.stack.toolbarHeight;
    expect(
      headerGrowth,
      'the panel column starts lower by exactly what the toolbar grew',
    ).toBeCloseTo(toolbarGrowth, 0);
    expect(
      actual.stack.height,
      'and the column lost exactly that much height, nothing more',
    ).toBeCloseTo(reference.stack.height - toolbarGrowth, 0);
    // The column still ends at the app's content edge: no panel escaped it.
    expect(actual.stack.bottom).toBeCloseTo(reference.stack.bottom, 0);
    expect(actual.stack.gap).toBe(reference.stack.gap);

    for (const panel of names) {
      // The inline extents are untouched, absolutely — the stacked layout is
      // still one full-width column.
      for (const edge of ['left', 'right'] as const) {
        expect(
          actual.boxes[panel]![edge],
          `${panel}.${edge} at ${key} vs ${BASELINE.commit}`,
        ).toBeCloseTo(reference.boxes[panel]![edge], 0);
      }
    }

    // The panels are still stacked in document order, separated by the gap.
    for (let i = 1; i < names.length; i++) {
      expect(
        actual.boxes[names[i]!]!.top - actual.boxes[names[i - 1]!]!.bottom,
        `${names[i - 1]} is directly above ${names[i]}`,
      ).toBeCloseTo(reference.stack.gap, 0);
    }

    /*
     * "The flex ratios, minimum heights and `max-height: 25vh` diagnostics
     * cap of the pre-change build" — FR-407's own words, and the assertion
     * that holds at every viewport size. The resulting pixel heights cannot
     * be compared directly at 375 px: `diagnostics` is `flex: 0 1 auto`, so a
     * column 40 px shorter shrinks it by design. What FR-407 forbids is a
     * change to the declarations, and none of them moved.
     */
    expect(actual.flex, 'every panel keeps its flex declaration').toEqual(reference.flex);

    // `stdin` alone is `flex-shrink: 0`, so it is the one panel whose pixel
    // height must be identical however much the column lost.
    expect(
      actual.boxes['stdin']!.bottom - actual.boxes['stdin']!.top,
      'the stdin row keeps its height exactly',
    ).toBeCloseTo(reference.boxes['stdin']!.bottom - reference.boxes['stdin']!.top, 0);

    // `console` (`1 1 30%`) and `editor` (`2 1 45%`) share the free space, and
    // it is their ratio the toolbar's growth must not disturb.
    const ratio = (m: Measurement): number =>
      (m.boxes['console']!.bottom - m.boxes['console']!.top) /
      (m.boxes['editor']!.bottom - m.boxes['editor']!.top);
    expect(ratio(actual), 'the console:editor flex ratio is unchanged').toBeCloseTo(
      ratio(reference),
      2,
    );

    // The diagnostics cap is still `25vh` — the same resolved value the
    // baseline reported at this height, and 25 % of that height.
    expect(actual.diagnosticsMaxHeight).toBe(reference.diagnosticsMaxHeight);
    expect(parseFloat(actual.diagnosticsMaxHeight)).toBeCloseTo(viewport.height * 0.25, 1);
  });
}

/* -------------------------------------------------------------------------
   VC-409 (FR-408, BR-407) and VC-410 (FR-409): the two-column geometry.
   ------------------------------------------------------------------------- */

test.describe('the two-column layout', () => {
  test.use({ viewport: WIDE });

  test('VC-409 (FR-408, BR-407): the editor column sits inline-start of the other three', async ({
    page,
  }) => {
    await seedPreference(page, 'vertical');
    await openPlayground(page, { seedLayout: false });
    await waitForPythonReady(page);
    await waitForLinter(page);
    expect(await renderedLayout(page)).toBe('vertical');

    const { boxes, appContentWidth } = await measurePanels(page);
    const { editor, console: consolePanel, stdin, diagnostics } = boxes as Record<string, Box>;
    const right = [consolePanel!, stdin!, diagnostics!];

    // The editor's box is entirely to the inline-start side of all three.
    for (const box of right) {
      expect(editor!.right, 'the editor ends before the right column starts').toBeLessThanOrEqual(
        box.left,
      );
    }

    // Those three share an inline-start edge, in console/stdin/diagnostics
    // block order.
    expect(stdin!.left).toBeCloseTo(consolePanel!.left, 0);
    expect(diagnostics!.left).toBeCloseTo(consolePanel!.left, 0);
    expect(consolePanel!.bottom).toBeLessThanOrEqual(stdin!.top);
    expect(stdin!.bottom).toBeLessThanOrEqual(diagnostics!.top);

    // The editor spans the whole split: its block size equals the three
    // panels' span, gaps included.
    expect(editor!.top).toBeCloseTo(consolePanel!.top, 0);
    expect(editor!.bottom).toBeCloseTo(diagnostics!.bottom, 0);
    expect(editor!.bottom - editor!.top).toBeCloseTo(diagnostics!.bottom - consolePanel!.top, 0);

    // The four header rows each span the full app content width. Two of them
    // are not rendered at all on a healthy load: FR-015 keeps `#coi-banner`
    // `hidden`, and `.notices:empty` is `display: none`. A box-less element
    // cannot be measured, and FR-408 only constrains these rows when they are
    // rendered — so each is given the state that renders it, measured, and
    // restored. Populating the strip through `Notices` rather than by hand
    // would fire the real code path but also leave a notice on screen for the
    // rest of the test; the placeholder text is never asserted on.
    const rows = await page.evaluate(() => {
      const app = document.getElementById('app') as HTMLElement;
      const style = getComputedStyle(app);
      const contentLeft = app.getBoundingClientRect().left + parseFloat(style.paddingLeft);
      const contentRight = app.getBoundingClientRect().right - parseFloat(style.paddingRight);

      const banner = document.getElementById('coi-banner') as HTMLElement;
      const notices = document.getElementById('notices') as HTMLElement;
      const wasHidden = banner.hidden;
      banner.hidden = false;
      notices.append(document.createElement('p'));

      const measured = ['.toolbar', '#coi-banner', '.status-bar', '#notices'].map((selector) => {
        const box = (document.querySelector(selector) as HTMLElement).getBoundingClientRect();
        return { selector, left: box.left, right: box.right, contentLeft, contentRight };
      });

      banner.hidden = wasHidden;
      notices.replaceChildren();
      return measured;
    });
    for (const row of rows) {
      expect(row.left, `${row.selector} starts at the content edge`).toBeCloseTo(row.contentLeft, 0);
      expect(row.right, `${row.selector} ends at the content edge`).toBeCloseTo(row.contentRight, 0);
    }

    // BR-407: with the console holding no tab stop, the split's reading order
    // is left column then right column — asserted in full by VC-431.
    expect(appContentWidth).toBeGreaterThan(0);
  });

  for (const width of [1280, 1024, LAYOUT_MIN_WIDTH]) {
    test(`VC-410 (FR-409): the split is 58 % with both columns >= 320 px at ${width} px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await seedPreference(page, 'vertical');
      await openPlayground(page, { seedLayout: false });
      await waitForPythonReady(page);
      await waitForLinter(page);
      expect(await renderedLayout(page)).toBe('vertical');

      // The files pane (undocumented by spec-04) opens by default at this
      // width; close it so FR-409's split is measured the way this frozen
      // requirement defines it — the editor/console column alone.
      await page.locator('#btn-files').click();
      await expect(page.locator('#file-pane')).toBeHidden();

      const { boxes, appContentWidth } = await measurePanels(page);
      const editor = boxes['editor']!;
      const consolePanel = boxes['console']!;
      const diagnostics = boxes['diagnostics']!;

      const editorColumn = editor.right - editor.left;
      const rightColumn = consolePanel.right - consolePanel.left;

      // Exactly `LAYOUT_EDITOR_COLUMN`, and so inside FR-409's 50–65 % band.
      expect(editorColumn).toBeCloseTo(appContentWidth * 0.58, 0);
      expect(editorColumn / appContentWidth).toBeGreaterThanOrEqual(0.5);
      expect(editorColumn / appContentWidth).toBeLessThanOrEqual(0.65);

      expect(editorColumn, 'the editor column clears 320 px').toBeGreaterThanOrEqual(320);
      expect(rightColumn, 'the right column clears 320 px').toBeGreaterThanOrEqual(320);

      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
        'the page never scrolls sideways',
      ).toBeLessThanOrEqual(width);

      // The diagnostics panel is capped at 40 % of the right column, and the
      // console keeps a positive share of it.
      const rightColumnHeight = diagnostics.bottom - consolePanel.top;
      expect(diagnostics.bottom - diagnostics.top).toBeLessThanOrEqual(rightColumnHeight * 0.4);
      expect(consolePanel.bottom - consolePanel.top).toBeGreaterThan(0);
    });
  }

  test('VC-411 (FR-410, BR-402): both layouts render the same document order', async ({ page }) => {
    await seedPreference(page, 'horizontal');
    await openPlayground(page, { seedLayout: false });
    await waitForPythonReady(page);

    const readOrder = (): Promise<string[]> =>
      page.evaluate(() =>
        Array.from(document.getElementById('app')!.children)
          .filter((el) => el.classList.contains('panel'))
          .map((el) => el.getAttribute('aria-label') ?? el.className),
      );

    const stacked = await readOrder();
    // 'Files' (undocumented by spec-04) sits last, after the run FR-410 pins.
    expect(stacked).toEqual([
      'Special characters',
      'Console',
      'Editor',
      'Standard input',
      'Diagnostics',
      'Files',
    ]);

    // Watch for re-parenting across the switch (BR-402), then switch by the
    // only means that exists in this iteration.
    await page.evaluate(() => {
      const records: string[] = [];
      (window as unknown as { __panelMutations: string[] }).__panelMutations = records;
      new MutationObserver((entries) => {
        for (const entry of entries) {
          const touched = [...entry.addedNodes, ...entry.removedNodes].some(
            (node) => node instanceof Element && node.classList.contains('panel'),
          );
          if (entry.type === 'childList' && touched) records.push(entry.type);
        }
      }).observe(document.getElementById('app')!, { childList: true, subtree: true });
    });

    await page.evaluate(() => {
      document.getElementById('app')!.dataset.layout = 'vertical';
    });
    await expect
      .poll(() => renderedLayout(page))
      .toBe('vertical');

    expect(await readOrder(), 'the two-column layout reads the same order').toEqual(stacked);
    expect(
      await page.evaluate(
        () => (window as unknown as { __panelMutations: string[] }).__panelMutations,
      ),
      'no panel was moved, re-parented or re-created',
    ).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
   VC-435 (FR-409): short viewports.
   ------------------------------------------------------------------------- */

for (const viewport of [
  { width: 1280, height: 500 },
  { width: 900, height: 420 },
]) {
  test(`VC-435 (FR-409): the console keeps its 80 px floor at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await seedPreference(page, 'vertical');
    await openPlayground(page, { seedLayout: false });
    await waitForPythonReady(page);
    await waitForLinter(page);
    // Seed findings. Vertical defaults to a short content floor (spec-09), so entries
    // stay in the document but may be clipped — assert attachment, not paint.
    await runProgram(page, 'import os\nx=1\n');
    await expect(page.locator('#diagnostics-list .diagnostic-entry').first()).toBeAttached();

    expect(await renderedLayout(page)).toBe('vertical');

    const { boxes } = await measurePanels(page);
    expect(
      boxes['console']!.bottom - boxes['console']!.top,
      'the console never compresses below 80 px',
    ).toBeGreaterThanOrEqual(80);

    // Every stdin control and at least one diagnostics entry is reachable
    // without scrolling the page: the right column's own panels scroll.
    const reachable = await page.evaluate(() => {
      const within = (el: Element): boolean => {
        const box = el.getBoundingClientRect();
        return box.top >= -1 && box.bottom <= window.innerHeight + 1 && box.width > 0;
      };
      const entry = document.querySelector('#diagnostics-list .diagnostic-entry');
      return {
        stdinField: within(document.getElementById('stdin-input')!),
        eof: within(document.getElementById('btn-eof')!),
        entry: !!entry && entry.getBoundingClientRect().width > 0,
        pageScrollsVertically:
          document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
      };
    });
    expect(reachable.stdinField, 'the stdin field is on screen').toBe(true);
    expect(reachable.eof, 'Send EOF is on screen').toBe(true);
    expect(reachable.entry, 'a diagnostics entry is rendered').toBe(true);
    expect(reachable.pageScrollsVertically, 'the page itself does not scroll').toBe(false);

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
      'the page never scrolls sideways',
    ).toBeLessThanOrEqual(viewport.width);
  });
}

/* -------------------------------------------------------------------------
   VC-402 / VC-412 / VC-413: resolution, the crossing and the override.
   ------------------------------------------------------------------------- */

test('VC-402 (FR-402, FR-411): an unset preference resolves from the width and stays unset', async ({
  page,
}) => {
  await page.setViewportSize(WIDE);
  await seedPreference(page, null);
  await openPlayground(page, { seedLayout: false });
  expect(await renderedLayout(page)).toBe('vertical');
  expect(await storedLayout(page), 'resolving writes nothing').toBeNull();

  await page.setViewportSize({ width: 800, height: 800 });
  await page.reload();
  await page.waitForSelector('.cm-content');
  expect(await renderedLayout(page)).toBe('horizontal');
  expect(await storedLayout(page), 'resolving writes nothing').toBeNull();
});

test('VC-412 (FR-411, FR-412, BR-405): crossing 900 px re-resolves within 100 ms', async ({
  page,
}) => {
  await page.setViewportSize(WIDE);
  await seedPreference(page, null);
  await openPlayground(page, { seedLayout: false });
  expect(await renderedLayout(page)).toBe('vertical');

  await recordCrossingLatency(page);

  await page.setViewportSize({ width: 899, height: 800 });
  await expectLayoutWithin(page, 'horizontal');

  await page.setViewportSize({ width: LAYOUT_MIN_WIDTH, height: 800 });
  await expectLayoutWithin(page, 'vertical');

  // Both crossings re-resolved within FR-412's 100 ms of the event that fired
  // them, and there were exactly two of them — no debounce, no extra pass.
  const latencies = await crossingLatencies(page);
  expect(latencies, 'one re-resolution per crossing').toHaveLength(2);
  for (const latency of latencies) {
    expect(latency, 'the crossing re-resolves within 100 ms').toBeLessThanOrEqual(100);
  }

  expect(await storedLayout(page), 'a resize never writes a preference').toBeNull();
});

test('VC-413 (FR-413, BR-404, BR-405): the narrow override never overwrites the preference', async ({
  page,
}) => {
  await page.setViewportSize(WIDE);
  await seedPreference(page, 'vertical');
  await openPlayground(page, { seedLayout: false });
  expect(await renderedLayout(page)).toBe('vertical');

  await page.setViewportSize(NARROW);
  await expectLayoutWithin(page, 'horizontal');
  expect(await storedLayout(page), 'the stored choice is untouched').toBe('vertical');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    NARROW.width,
  );

  // Widening restores it with no interaction at all.
  await page.setViewportSize(WIDE);
  await expectLayoutWithin(page, 'vertical');

  await page.setViewportSize(NARROW);
  await page.reload();
  await page.waitForSelector('.cm-content');
  expect(await renderedLayout(page)).toBe('horizontal');
  expect(await storedLayout(page)).toBe('vertical');
});

/* -------------------------------------------------------------------------
   VC-416 (FR-416): resolved in the first painted frame.
   ------------------------------------------------------------------------- */

for (const preference of ['vertical', 'horizontal'] as const) {
  test(`VC-416 (FR-416): the first painted frame already reads ${preference}`, async ({ page }) => {
    await page.setViewportSize(WIDE);
    await seedPreference(page, preference);
    // Installed from a document-start script, so the observer is watching
    // before `boot()` has run.
    await page.addInitScript(() => {
      const state = { firstFrame: null as string | null, changes: [] as string[] };
      (window as unknown as { __layoutFrames: typeof state }).__layoutFrames = state;
      const start = (): void => {
        const app = document.getElementById('app');
        if (!app) return;
        new MutationObserver((entries) => {
          for (const entry of entries) {
            if (entry.attributeName === 'data-layout') {
              state.changes.push(app.dataset.layout ?? '');
            }
          }
        }).observe(app, { attributes: true, attributeFilter: ['data-layout'] });
        requestAnimationFrame(() => {
          state.firstFrame = app.dataset.layout ?? null;
        });
      };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
      } else {
        start();
      }
    });

    await openPlayground(page, { seedLayout: false });
    await waitForPythonReady(page);

    const frames = await page.evaluate(
      () =>
        (
          window as unknown as {
            __layoutFrames: { firstFrame: string | null; changes: string[] };
          }
        ).__layoutFrames,
    );

    expect(frames.firstFrame, 'the value is already resolved in frame one').toBe(preference);
    // The attribute is written once, to the value it keeps: no frame ever
    // showed the other layout, and nothing changed it afterwards.
    expect(frames.changes.filter((value) => value !== preference)).toEqual([]);
    expect(await renderedLayout(page)).toBe(preference);
  });
}

/* -------------------------------------------------------------------------
   VC-417 / VC-418 (FR-417): malformed and hostile storage.
   ------------------------------------------------------------------------- */

const MALFORMED = [
  ['an empty string', ''],
  ['a leading space', ' vertical'],
  ['the wrong case', 'Horizontal'],
  ['a JSON string', '"vertical"'],
  ['a JSON document', '{"layout":"vertical"}'],
  ['an unknown layout', 'diagonal'],
  ['a 1 MB string', 'x'.repeat(1024 * 1024)],
] as const;

for (const [label, value] of MALFORMED) {
  test(`VC-417 (FR-417): ${label} is treated as absent and left in place`, async ({ page }) => {
    const problems: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text());
    });
    page.on('pageerror', (error) => problems.push(String(error)));

    await page.setViewportSize(WIDE);
    await seedPreference(page, value);
    await openPlayground(page, { seedLayout: false });
    await waitForPythonReady(page);

    expect(await renderedLayout(page), 'falls back to the unset default').toBe('vertical');
    expect(await storedLayout(page), 'the malformed bytes are not rewritten').toBe(value);
    expect(
      await page.locator('#notices [data-notice]').count(),
      'a malformed preference is not the visitor’s problem',
    ).toBe(0);
    expect(problems, 'no console error and no unhandled rejection').toEqual([]);
  });
}

test('VC-417 (FR-417): a malformed preference still narrows below 900 px', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 800 });
  await seedPreference(page, 'diagonal');
  await openPlayground(page, { seedLayout: false });
  expect(await renderedLayout(page)).toBe('horizontal');
});

test('VC-418 (FR-417): a throwing localStorage still boots and still runs Python', async ({
  page,
}) => {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(String(error)));

  await page.setViewportSize(WIDE);
  await page.addInitScript(() => {
    const deny = (): never => {
      throw new DOMException('denied', 'SecurityError');
    };
    // Both accessors throw, which is what a locked-down profile does.
    Object.defineProperty(window.localStorage, 'getItem', { value: deny, configurable: true });
    Object.defineProperty(window.localStorage, 'setItem', { value: deny, configurable: true });
  });

  await openPlayground(page, { seedLayout: false });
  await waitForPythonReady(page);

  expect(await renderedLayout(page)).toBe('vertical');

  await runProgram(page, 'print("ok")\n');
  await expect(page.locator('#console')).toContainText('ok');
  expect(problems, 'no uncaught exception').toEqual([]);
});

/* -------------------------------------------------------------------------
   The toolbar control (iteration 3).

   VC-401 (FR-401) — the radiogroup's shape and accessible names.
   VC-402 (FR-402) — the checked radio is always the effective layout's.
   VC-403 / VC-404 (FR-403, FR-404, FR-414) — pointer selection persists.
   VC-405 (FR-405) — one tab stop, roving tabindex, arrows and Home/End.
   VC-406 (FR-403 – FR-405) — Space and Enter apply without scrolling.
   VC-407 (FR-049 from spec-01, FR-405) — the toolbar's tab order.
   VC-414 (FR-415) — inert but focusable below 900 px; every path a no-op.
   VC-415 (FR-406) — the narrow hint, present only below 900 px.
   VC-419 (FR-418, BR-406) — one notice, and the layout still applies.
   VC-430 (BR-403) — exactly one new key, and no other store touched.
   VC-431 (BR-407) — the left column's tab stop precedes the right's.
   ------------------------------------------------------------------------- */

/** The layout radios, by the id FR-401 gives them. */
const RADIOS: Record<Layout, string> = {
  vertical: '#layout-vertical',
  horizontal: '#layout-horizontal',
};

/** Which radio is checked, and which is tabbable (FR-402, FR-405). */
async function controlState(page: Page): Promise<{
  checked: string[];
  tabbable: string[];
  groupDisabled: string | null;
}> {
  return page.evaluate(() => {
    const radios = Array.from(document.querySelectorAll('#layout-group [role="radio"]'));
    return {
      checked: radios
        .filter((el) => el.getAttribute('aria-checked') === 'true')
        .map((el) => el.id),
      tabbable: radios.filter((el) => (el as HTMLElement).tabIndex === 0).map((el) => el.id),
      groupDisabled: document.getElementById('layout-group')!.getAttribute('aria-disabled'),
    };
  });
}

test.describe('the layout control', () => {
  test.use({ viewport: WIDE });

  test('VC-401 (FR-401): the group is a two-radio radiogroup named Layout', async ({ page }) => {
    await seedPreference(page, null);
    await openPlayground(page, { seedLayout: false });

    const group = page.locator('#layout-group');
    await expect(group).toHaveRole('radiogroup');
    await expect(group).toHaveAccessibleName('Layout');

    // FR-401's own Given/When/Then: immediately after `#btn-reset`. The DOM
    // contract's "last child of header.toolbar" is amended in the spec —
    // spec-03 VC-301 had already claimed that slot for `Symbols`.
    const order = await page.evaluate(() =>
      Array.from(document.querySelector('header.toolbar')!.children).map((el) => el.id),
    );
    expect(order.indexOf('layout-group')).toBe(order.indexOf('btn-reset') + 1);

    const radios = group.getByRole('radio');
    await expect(radios).toHaveCount(2);
    // FR-401's order. `Horizontal` is first: it is spec-01's rendering and
    // the only layout below 900 px (BR-404), so it is the one `Home` reaches.
    await expect(radios.nth(0)).toHaveAccessibleName('Horizontal');
    await expect(radios.nth(1)).toHaveAccessibleName('Vertical');
  });

  test('VC-402 (FR-402): the checked radio is the effective layout, at both widths', async ({
    page,
  }) => {
    await seedPreference(page, null);
    await openPlayground(page, { seedLayout: false });
    expect(await renderedLayout(page)).toBe('vertical');
    expect(await controlState(page)).toMatchObject({ checked: ['layout-vertical'] });
    expect(await storedLayout(page)).toBeNull();

    await page.setViewportSize({ width: 800, height: 800 });
    await page.reload();
    await page.waitForSelector('.cm-content');
    expect(await renderedLayout(page)).toBe('horizontal');
    expect(await controlState(page)).toMatchObject({ checked: ['layout-horizontal'] });
    expect(await storedLayout(page)).toBeNull();
  });

  test('VC-402 (FR-402): the masked preference is never the one shown as checked', async ({
    page,
  }) => {
    // The stored choice is horizontal, but below 900 px the effective layout
    // is vertical — so `Vertical` is checked while `horizontal` stays stored.
    await seedPreference(page, 'vertical');
    await openPlayground(page, { seedLayout: false });
    expect(await controlState(page)).toMatchObject({ checked: ['layout-vertical'] });

    await page.setViewportSize(NARROW);
    await expectLayoutWithin(page, 'horizontal');
    expect(await controlState(page)).toMatchObject({ checked: ['layout-horizontal'] });
    expect(await storedLayout(page)).toBe('vertical');
  });

  test('VC-403 (FR-403, FR-414): clicking Vertical applies and persists it', async ({ page }) => {
    await seedPreference(page, 'horizontal');
    await openPlayground(page, { seedLayout: false });
    expect(await renderedLayout(page)).toBe('horizontal');

    await page.click(RADIOS.vertical);

    expect(await renderedLayout(page)).toBe('vertical');
    await expect(page.locator(RADIOS.vertical)).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator(RADIOS.horizontal)).toHaveAttribute('aria-checked', 'false');
    // FR-414: exactly the 8 characters, no quotes and no whitespace.
    const stored = await storedLayout(page);
    expect(stored).toBe('vertical');
    expect(stored).toHaveLength(8);
  });

  test('VC-404 (FR-404, FR-414): clicking Horizontal applies and persists it', async ({ page }) => {
    await seedPreference(page, 'vertical');
    await openPlayground(page, { seedLayout: false });
    expect(await renderedLayout(page)).toBe('vertical');

    await page.click(RADIOS.horizontal);

    expect(await renderedLayout(page)).toBe('horizontal');
    await expect(page.locator(RADIOS.horizontal)).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator(RADIOS.vertical)).toHaveAttribute('aria-checked', 'false');
    const stored = await storedLayout(page);
    expect(stored).toBe('horizontal');
    expect(stored).toHaveLength(10);
  });

  test('VC-405 (FR-405): one tab stop, and every arrow key applies and persists', async ({
    page,
  }) => {
    await seedPreference(page, 'horizontal');
    await openPlayground(page, { seedLayout: false });

    // Tab lands on the checked radio, which is the only tabbable one.
    await page.locator('#btn-reset').focus();
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('layout-horizontal');
    expect(await controlState(page)).toMatchObject({
      checked: ['layout-horizontal'],
      tabbable: ['layout-horizontal'],
    });

    // Each of the four arrow keys moves, checks, applies and persists — and
    // both directions wrap over the group of two.
    for (const key of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'] as const) {
      const before = (await renderedLayout(page)) as Layout;
      const after: Layout = before === 'horizontal' ? 'vertical' : 'horizontal';

      await page.keyboard.press(key);

      expect(await page.evaluate(() => document.activeElement?.id), `${key} moves focus`).toBe(
        RADIOS[after].slice(1),
      );
      expect(await renderedLayout(page), `${key} applies`).toBe(after);
      expect(await controlState(page), `${key} checks`).toMatchObject({
        checked: [RADIOS[after].slice(1)],
        tabbable: [RADIOS[after].slice(1)],
      });
      expect(await storedLayout(page), `${key} persists`).toBe(after);
    }

    // Home and End are absolute, not relative.
    await page.keyboard.press('Home');
    expect(await renderedLayout(page)).toBe('horizontal');
    expect(await storedLayout(page)).toBe('horizontal');
    await page.keyboard.press('End');
    expect(await renderedLayout(page)).toBe('vertical');
    expect(await storedLayout(page)).toBe('vertical');
  });

  test('VC-406 (FR-403 – FR-405): Space and Enter apply without scrolling the page', async ({
    page,
  }) => {
    await seedPreference(page, 'horizontal');
    await openPlayground(page, { seedLayout: false });

    for (const key of [' ', 'Enter'] as const) {
      for (const layout of ['vertical', 'horizontal'] as const) {
        await page.locator(RADIOS[layout]).focus();
        const scrollBefore = await page.evaluate(() => window.scrollY);

        await page.keyboard.press(key === ' ' ? 'Space' : key);

        expect(await renderedLayout(page), `${key} on ${layout}`).toBe(layout);
        expect(await storedLayout(page), `${key} on ${layout} persists`).toBe(layout);
        expect(await page.evaluate(() => window.scrollY), 'no activation scrolls').toBe(
          scrollBefore,
        );
      }
    }
  });

  test('VC-431 (BR-407): the left column precedes the right in tab order', async ({ page }) => {
    await seedPreference(page, 'vertical');
    await openPlayground(page, { seedLayout: false });
    await waitForPythonReady(page);
    await waitForLinter(page);
    await runProgram(page, 'import os\nx=1\n');
    await expect(page.locator('#diagnostics-list .diagnostic-entry').first()).toBeAttached();
    // Content-floor default may clip entries; enlarge so Tab can land on one.
    const diagResizer = page.locator('#diag-resizer');
    await diagResizer.focus();
    for (let i = 0; i < 20; i++) await diagResizer.press('ArrowUp');
    expect(await renderedLayout(page)).toBe('vertical');

    /*
     * The real tab order, walked with `Tab` rather than inferred from a DOM
     * query — which is what BR-407 is about. Each stop is recorded as the
     * `aria-label` of the panel that contains it, so the sequence reads as the
     * columns the visitor traverses. `#diag-resizer` is a non-panel stop
     * between editor and stdin (spec-09 FR-913); it is recorded by id.
     */
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.locator('body').click({ position: { x: 2, y: 2 } });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    const stops: { panel: string; target: string }[] = [];
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press('Tab');
      const stop = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const panel = el.closest('.panel');
        return {
          panel: panel?.getAttribute('aria-label') ?? '',
          target: el.classList.contains('cm-content')
            ? 'editor'
            : el.classList.contains('diagnostic-entry')
              ? 'diagnostic-entry'
              : el.id,
          isEntry: el.classList.contains('diagnostic-entry'),
          isDiagResizer: el.id === 'diag-resizer',
        };
      });
      if (!stop) break;
      if (stop.panel || stop.isDiagResizer) stops.push({ panel: stop.panel, target: stop.target });
      if (stop.isEntry) break;
      // Issue #31: CodeMirror captures Tab for indentation until Ctrl+M turns
      // on its standard Tab-focus mode.
      if (stop.target === 'editor') await page.keyboard.press('Control+m');
    }

    // BR-407: no tab stop inside the console panel at all — which is what
    // makes FR-410's fixed document order safe for WCAG SC 2.4.3.
    expect(
      stops.filter((stop) => stop.panel === 'Console'),
      'the console holds no focusable element',
    ).toEqual([]);

    // The left column's stop precedes every right-column stop; the diagnostics
    // resizer sits between editor and stdin in document order (FR-913).
    expect(stops.map((stop) => stop.target)).toEqual([
      'editor',
      'diag-resizer',
      'stdin-input',
      'btn-eof',
      'diagnostic-entry',
    ]);
    expect(stops.map((stop) => stop.panel)).toEqual([
      'Editor',
      '',
      'Standard input',
      'Standard input',
      'Diagnostics',
    ]);
  });

  test('VC-419 (FR-418, BR-406): a refused write warns once and still applies', async ({
    page,
  }) => {
    await seedPreference(page, 'vertical');
    // `getItem` keeps working; only the write is refused.
    await page.addInitScript(() => {
      const original = window.localStorage.setItem.bind(window.localStorage);
      Object.defineProperty(window.localStorage, 'setItem', {
        configurable: true,
        value: (key: string, value: string) => {
          if (key === 'pyplay.layout.v2') {
            throw new DOMException('quota', 'QuotaExceededError');
          }
          original(key, value);
        },
      });
    });
    await openPlayground(page, { seedLayout: false });
    await waitForPythonReady(page);
    await waitForLinter(page);

    for (const layout of ['horizontal', 'vertical', 'horizontal'] as const) {
      await page.click(RADIOS[layout]);
      expect(await renderedLayout(page), 'the layout still applies').toBe(layout);
    }

    // FR-418: at most once per page load.
    const notices = page.locator(`#notices [data-notice="Layout preference won't be remembered"]`);
    await expect(notices).toHaveCount(1);

    // BR-406: the failure degrades this feature only.
    await page.click('#btn-copy');
    await expect(page.locator('#btn-copy')).toHaveText('Copied');
    await runProgram(page, 'print(input("? "))\n');
    await submitStdin(page, 'hola');
    await expect(page.locator('#console')).toContainText('hola');
    await expect(page.locator('#btn-format')).toBeEnabled();
  });

  test('VC-430 (BR-403): exactly one new key, and no other store touched', async ({ page }) => {
    // Deliberately *not* seeded: `addInitScript` runs on every navigation,
    // including the reload below, and would wipe the key under test.
    await openPlayground(page, { seedLayout: false });
    await waitForPythonReady(page);

    const snapshot = (): Promise<{ session: string[]; cookies: string; databases: string[] }> =>
      page.evaluate(async () => ({
        session: Object.keys(window.sessionStorage).sort(),
        cookies: document.cookie,
        databases: (await indexedDB.databases()).map((db) => db.name ?? '').sort(),
      }));

    const before = await snapshot();

    // The autosave key exists once the visitor has edited (FR-002), which is
    // the state VC-430's "exactly these two keys" describes.
    await page.locator('.cm-content').click();
    await page.keyboard.type('x');
    await expect.poll(() => page.evaluate(() => window.localStorage.getItem('pyplay.workspace.v1'))).
      not.toBeNull();

    for (const layout of ['horizontal', 'vertical', 'horizontal', 'vertical'] as const) {
      await page.click(RADIOS[layout]);
    }
    expect(await storedLayout(page)).toBe('vertical');

    await page.reload();
    await page.waitForSelector('.cm-content');

    expect(await snapshot()).toEqual(before);
    expect(
      await page.evaluate(() => Object.keys(window.localStorage).sort()),
      'exactly the autosave key and the layout key',
    ).toEqual(['pyplay.layout.v2', 'pyplay.workspace.v1']);
    expect(await storedLayout(page), 'the choice survived the reload').toBe('vertical');
  });
});

/* -------------------------------------------------------------------------
   VC-414 / VC-415 (FR-415, FR-406): the narrow-viewport inert state.
   ------------------------------------------------------------------------- */

test.describe('the layout control below 900 px', () => {
  test.use({ viewport: NARROW });

  test('VC-414 (FR-415): inert but focusable, and every interaction a no-op', async ({ page }) => {
    await seedPreference(page, null);
    await openPlayground(page, { seedLayout: false });
    await waitForPythonReady(page);

    const group = page.locator('#layout-group');
    // `aria-disabled`, which is what `isInert()` reads and what Playwright's
    // `toBeDisabled()` reports — never the `disabled` attribute (FR-049).
    await expect(group).toHaveAttribute('aria-disabled', 'true');
    for (const selector of Object.values(RADIOS)) {
      await expect(page.locator(selector)).toHaveAttribute('aria-disabled', 'true');
      expect(
        await page.locator(selector).evaluate((el) => el.hasAttribute('disabled')),
        'the disabled attribute is never used',
      ).toBe(false);
    }

    // Still exactly one tab stop, and it still shows a focus ring.
    await page.locator('#btn-reset').focus();
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('layout-horizontal');
    await page.keyboard.press('Tab');
    expect(
      await page.evaluate(() => document.activeElement?.id),
      'the group contributes exactly one stop',
    ).toBe('btn-files');

    // `:focus-visible` is a pseudo-*class*, so it cannot be passed to
    // `getComputedStyle`; the rule is already in effect on the focused
    // element's own computed style, which is how spec-01's VC-052 reads it.
    await page.locator(RADIOS.horizontal).focus();
    const ring = await page.locator(RADIOS.horizontal).evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        width: Number.parseFloat(style.outlineWidth || '0'),
        style: style.outlineStyle,
        color: style.outlineColor,
      };
    });
    expect(ring.style, 'the inert radio still shows a focus ring').not.toBe('none');
    expect(ring.width).toBeGreaterThanOrEqual(1);
    expect(ring.color).not.toBe('transparent');

    // Every activation and navigation path is a strict no-op.
    const expectUnchanged = async (what: string): Promise<void> => {
      expect(await page.evaluate(() => document.activeElement?.id), `${what}: focus`).toBe(
        'layout-horizontal',
      );
      expect(await renderedLayout(page), `${what}: data-layout`).toBe('horizontal');
      expect(await controlState(page), `${what}: aria-checked`).toMatchObject({
        checked: ['layout-horizontal'],
      });
      expect(await storedLayout(page), `${what}: storage`).toBeNull();
    };

    // Playwright reads `aria-disabled` as "disabled" and would wait forever
    // for the element to become actionable. FR-415's subject is precisely a
    // real pointer activation landing on an inert control, so the actionability
    // check is bypassed rather than the click avoided.
    await page.locator(RADIOS.vertical).click({ force: true });
    // A pointer click focuses the element it lands on; what FR-415 forbids is
    // the *selection*, so focus is restored before the key paths are checked.
    expect(await renderedLayout(page), 'click: data-layout').toBe('horizontal');
    expect(await controlState(page), 'click: aria-checked').toMatchObject({
      checked: ['layout-horizontal'],
    });
    expect(await storedLayout(page), 'click: storage').toBeNull();

    await page.locator(RADIOS.horizontal).focus();
    for (const key of [
      'ArrowRight',
      'ArrowLeft',
      'ArrowDown',
      'ArrowUp',
      'Home',
      'End',
      'Space',
      'Enter',
    ] as const) {
      await page.keyboard.press(key);
      await expectUnchanged(key);
    }
  });

  test('VC-415 (FR-406): the hint is present only below 900 px', async ({ page }) => {
    await seedPreference(page, null);
    await openPlayground(page, { seedLayout: false });

    const group = page.locator('#layout-group');
    await expect(group).toHaveAttribute('title', LAYOUT_NARROW_HINT);
    await expect(group).toHaveAttribute('aria-describedby', 'layout-narrow-hint');
    await expect(page.locator('#layout-narrow-hint')).toHaveText(LAYOUT_NARROW_HINT);
    // The accessibility tree reports it as the group's description.
    await expect(group).toHaveAccessibleDescription(LAYOUT_NARROW_HINT);

    await page.setViewportSize(WIDE);
    await expectLayoutWithin(page, 'vertical');
    await expect(group).not.toHaveAttribute('aria-disabled', 'true');
    await expect(group).not.toHaveAttribute('title', /./);
    await expect(group).not.toHaveAttribute('aria-describedby', /./);
    expect(
      await page.evaluate((hint) => document.documentElement.textContent?.includes(hint), LAYOUT_NARROW_HINT),
      'the string is absent from the document at >= 900 px',
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------
   VC-407 (FR-049 from spec-01, FR-405): the toolbar's tab order.
   ------------------------------------------------------------------------- */

test('VC-407 (FR-049 from spec-01, FR-405): Tab reaches every control once in both layouts', async ({
  page,
}) => {
  await page.setViewportSize(WIDE);
  await seedPreference(page, 'horizontal');
  await openPlayground(page, { seedLayout: false });
  await waitForPythonReady(page);
  await waitForLinter(page);
  await runProgram(page, 'import os\nx=1\n');
  await expect(page.locator('#diagnostics-list .diagnostic-entry').first()).toBeAttached();

  /**
   * Walk `Tab` forward from the top of the document, recording each stop and
   * checking it shows a focus ring, until the diagnostics entries are
   * reached. The whole enumeration is done in one page session for both
   * layouts, because `fullyParallel` gives each test its own worker and
   * module-level state would not survive between them.
   */
  const enumerateTabOrder = async (): Promise<string[]> => {
    const reached: string[] = [];
    // Start from the top of the document, as a fresh load does. Focus must be
    // reached *by keyboard*: `:focus-visible` does not match a programmatic
    // `.focus()` on a button, so the ring would read as absent.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.locator('body').click({ position: { x: 2, y: 2 } });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    for (let i = 0; i < 24; i++) {
      await page.keyboard.press('Tab');
      const stop = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const style = getComputedStyle(el);
        return {
          id: el.id,
          className: typeof el.className === 'string' ? el.className : '',
          hasRing:
            style.outlineStyle !== 'none' &&
            Number.parseFloat(style.outlineWidth || '0') >= 1 &&
            style.outlineColor !== 'transparent',
          insideGroup: !!el.closest('#layout-group'),
          isEntry: el.classList.contains('diagnostic-entry'),
          isEditor: el.classList.contains('cm-content'),
        };
      });
      if (!stop) break;
      expect(stop.hasRing, `${stop.id || stop.className} shows a focus ring`).toBe(true);
      reached.push(
        stop.insideGroup
          ? 'layout-group'
          : stop.isEntry
            ? 'diagnostic-entry'
            : stop.isEditor
              ? 'editor'
              : stop.id || stop.className,
      );
      if (stop.isEntry) break;
      // Issue #31: continue the document traversal after CodeMirror's Tab
      // indentation binding with its standard keyboard focus mode.
      if (stop.isEditor) await page.keyboard.press('Control+m');
    }
    // Ctrl+M toggles a persistent mode, so return it to the default before
    // this test repeats the traversal for the other layout.
    if (reached.includes('editor')) {
      await page.locator('.cm-content').focus();
      await page.keyboard.press('Control+m');
    }
    return reached;
  };

  /** Toolbar → editor → stdin → diagnostics. Horizontal hides `#diag-resizer`. */
  const EXPECTED_HORIZONTAL = [
    'btn-run',
    'btn-stop',
    'btn-clear',
    'btn-copy',
    'btn-format',
    'btn-reset',
    // spec-04 FR-405 / parent VC-052: exactly one stop for the whole group,
    // however many radios it holds.
    'layout-group',
    // The files toggle (undocumented by spec-04), immediately after the
    // layout group. The pane's own internal stops sit after `Diagnostics` in
    // the document, past where this enumeration stops.
    'btn-files',
    // spec-03 FR-301.
    'btn-symbols',
    // spec-05 FR-501: the color-mode control, immediately after Symbols.
    'btn-theme',
    // spec-08 FR-801: About, immediately after theme.
    'btn-about',
    'editor',
    'stdin-input',
    'btn-eof',
    'diagnostic-entry',
  ];

  /** Vertical ≥ 900 inserts `#diag-resizer` between editor and stdin (FR-913). */
  const EXPECTED_VERTICAL = [
    ...EXPECTED_HORIZONTAL.slice(0, EXPECTED_HORIZONTAL.indexOf('stdin-input')),
    'diag-resizer',
    ...EXPECTED_HORIZONTAL.slice(EXPECTED_HORIZONTAL.indexOf('stdin-input')),
  ];

  expect(await renderedLayout(page)).toBe('horizontal');
  // Stacked layout keeps a visible diagnostics body (`25vh`), so entries are
  // reachable without enlarging.
  const horizontal = await enumerateTabOrder();
  expect(horizontal).toEqual(EXPECTED_HORIZONTAL);
  expect(horizontal.filter((stop) => stop === 'layout-group')).toHaveLength(1);

  // Switch through the control itself, then enumerate again.
  await page.click(RADIOS.vertical);
  expect(await renderedLayout(page)).toBe('vertical');
  // Content-floor default may clip entries; enlarge so Tab reaches one.
  const diagResizer = page.locator('#diag-resizer');
  await diagResizer.focus();
  for (let i = 0; i < 20; i++) await diagResizer.press('ArrowUp');
  const vertical = await enumerateTabOrder();

  expect(vertical, 'vertical includes the diagnostics resizer').toEqual(EXPECTED_VERTICAL);
});

/* -------------------------------------------------------------------------
   VC-427 (NFR-401, FR-047 from spec-01) — the 375 px viewport, in all three
   preference states. Also parent VC-050's amendment.
   ------------------------------------------------------------------------- */

for (const preference of [null, 'horizontal', 'vertical'] as const) {
  const label = preference ?? 'unset';

  test(`VC-427 (NFR-401, FR-047 from spec-01): 375 px works with the preference ${label}`, async ({
    page,
  }) => {
    await page.setViewportSize(NARROW);
    await seedPreference(page, preference);
    await openPlayground(page, { seedLayout: false });
    await waitForPythonReady(page);
    await waitForLinter(page);

    // BR-404: vertical is the only layout here, whatever is stored.
    expect(await renderedLayout(page)).toBe('horizontal');

    /** Nothing is clipped and the page never scrolls sideways. */
    const check = async (stage: string): Promise<void> => {
      const report = await page.evaluate(() => {
        const selectors = [
          '.toolbar',
          '#status-bar',
          '.panel--console',
          '.panel--editor',
          '#stdin-input',
          '#btn-eof',
          '.panel--diagnostics',
          '#layout-group',
          '#layout-horizontal',
          '#layout-vertical',
        ];
        const clipped: string[] = [];
        const radios: { id: string; width: number; height: number }[] = [];
        for (const selector of selectors) {
          const el = document.querySelector(selector) as HTMLElement | null;
          if (!el) {
            clipped.push(`${selector}: missing`);
            continue;
          }
          const box = el.getBoundingClientRect();
          if (box.width <= 0 || box.height <= 0) clipped.push(`${selector}: no box`);
          if (box.left < -1 || box.right > window.innerWidth + 1) {
            clipped.push(`${selector}: outside the viewport inline`);
          }
          if (el.scrollWidth > el.clientWidth + 1 && !getComputedStyle(el).overflowX.match(/auto|scroll/)) {
            clipped.push(`${selector}: content wider than its box`);
          }
          if (el.id.startsWith('layout-') && el.getAttribute('role') === 'radio') {
            radios.push({ id: el.id, width: box.width, height: box.height });
          }
        }
        return { clipped, radios, scrollWidth: document.documentElement.scrollWidth };
      });

      expect(report.clipped, `${stage}: nothing clipped`).toEqual([]);
      expect(report.scrollWidth, `${stage}: no horizontal scroll`).toBeLessThanOrEqual(
        NARROW.width,
      );
      // NFR-401: each radio's rendered hit area is at least 32 x 32 px, even
      // though FR-415 renders it disabled at this width.
      expect(report.radios, `${stage}: both radios measured`).toHaveLength(2);
      for (const radio of report.radios) {
        expect(radio.width, `${stage}: ${radio.id} width`).toBeGreaterThanOrEqual(32);
        expect(radio.height, `${stage}: ${radio.id} height`).toBeGreaterThanOrEqual(32);
      }
    };

    await check('on load');

    // Run the starter program through to a submitted `input()`, which is the
    // widest the console and the stdin row ever get.
    await page.locator('#btn-run').click();
    await waitForStdinPrompt(page);
    await check('blocked on input()');
    await submitStdin(page, 'Ana');
    await expect(page.locator('#console')).toContainText('Hola, Ana!');
    await expect(page.locator('#console')).toContainText('Program finished in');
    await check('after the run');
  });
}

/* -------------------------------------------------------------------------
   VC-428 (NFR-402, NFR-403) — the control's contrast, in every rendering.
   Extends parent VC-051 and VC-071, whose sampling sets grow in
   `presentation.spec.ts` for the renderings that test produces.
   ------------------------------------------------------------------------- */

/** Both radio labels, checked and unchecked (NFR-402: >= 4.5:1). */
const LAYOUT_TEXT_SAMPLES: Sample[] = [
  {
    label: 'layout radio label (checked)',
    selector: '#layout-group [role="radio"][aria-checked="true"]',
    prop: 'color',
  },
  {
    label: 'layout radio label (unchecked)',
    selector: '#layout-group [role="radio"][aria-checked="false"]',
    prop: 'color',
  },
];

/** The control's non-text components (NFR-403: >= 3:1). */
const LAYOUT_NON_TEXT_SAMPLES: Sample[] = [
  {
    label: 'layout segment border',
    selector: '#layout-group [role="radio"][aria-checked="false"]',
    prop: 'borderTopColor',
  },
  {
    label: 'layout checked indicator',
    selector: '#layout-group [role="radio"][aria-checked="true"]',
    prop: 'backgroundColor',
  },
  {
    label: 'focus ring (layout radio)',
    selector: '#layout-group [role="radio"][aria-checked="true"]',
    prop: 'outlineColor',
    focus: true,
  },
];

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`VC-428 — ${scheme} palette`, () => {
    test.use({ colorScheme: scheme });

    for (const layout of ['horizontal', 'vertical'] as const) {
      test(`VC-428 (NFR-402, NFR-403): the control clears contrast at 1280 px — ${layout}, ${scheme}`, async ({
        page,
      }) => {
        await page.setViewportSize(WIDE);
        await seedPreference(page, layout);
        await openPlayground(page, { seedLayout: false });
        await waitForPythonReady(page);
        expect(await renderedLayout(page)).toBe(layout);

        const text = await measureContrast(page, LAYOUT_TEXT_SAMPLES);
        expect(text).toHaveLength(LAYOUT_TEXT_SAMPLES.length);
        expect(failures(text, 4.5)).toEqual([]);

        const nonText = await measureContrast(page, [
          ...LAYOUT_NON_TEXT_SAMPLES,
          // NFR-403's "edge between the two columns": the panels' own
          // borders are what draws it, so they are sampled in the rendering
          // that actually has two columns.
          ...(layout === 'vertical'
            ? ([
                {
                  label: 'horizontal column edge (editor)',
                  selector: '.panel--editor',
                  prop: 'borderTopColor',
                },
                {
                  label: 'horizontal column edge (console)',
                  selector: '.panel--console',
                  prop: 'borderTopColor',
                },
              ] as Sample[])
            : []),
        ]);
        expect(failures(nonText, 3)).toEqual([]);
      });
    }

    test(`VC-428 (NFR-402, NFR-403): the disabled control clears contrast at 375 px — ${scheme}`, async ({
      page,
    }) => {
      await page.setViewportSize(NARROW);
      await seedPreference(page, null);
      await openPlayground(page, { seedLayout: false });
      await waitForPythonReady(page);

      // FR-415's rendering: `aria-disabled`, styled as disabled.
      await expect(page.locator('#layout-group')).toHaveAttribute('aria-disabled', 'true');

      const text = await measureContrast(page, LAYOUT_TEXT_SAMPLES);
      expect(text).toHaveLength(LAYOUT_TEXT_SAMPLES.length);
      expect(failures(text, 4.5), 'the disabled labels').toEqual([]);

      const nonText = await measureContrast(page, [
        {
          label: 'layout disabled border',
          selector: '#layout-group [role="radio"][aria-checked="false"]',
          prop: 'borderTopColor',
        },
        {
          // The disabled indicator is the checked segment's border, not a
          // fill — see the note in `src/styles.css`.
          label: 'layout disabled checked indicator',
          selector: '#layout-group [role="radio"][aria-checked="true"]',
          prop: 'borderTopColor',
        },
        {
          label: 'focus ring (layout radio, disabled)',
          selector: '#layout-group [role="radio"][aria-checked="true"]',
          prop: 'outlineColor',
          focus: true,
        },
      ]);
      expect(failures(nonText, 3), 'the disabled non-text components').toEqual([]);
    });
  });
}

/* -------------------------------------------------------------------------
   VC-409 / VC-410 with spec-03's pane open.

   spec-04's *Relationship to spec 03* requires that whichever spec merges
   second re-runs the other's layout criteria: the pane keeps its full-height
   **inline-end** column in *both* layouts, never inside the editor column and
   never inside the right column. Spec-03 merged first, so that assertion
   belongs here.
   ------------------------------------------------------------------------- */

for (const layout of ['horizontal', 'vertical'] as const) {
  test(`VC-409 / VC-410 (spec-03 FR-311, FR-317): the pane keeps its inline-end column — ${layout}`, async ({
    page,
  }) => {
    await page.setViewportSize(WIDE);
    await seedPreference(page, layout);
    await openPlayground(page, { seedLayout: false });
    await waitForPythonReady(page);
    await page.locator('#btn-symbols').click();
    await expect(page.locator('#symbol-pane .symbol').first()).toBeVisible();
    expect(await renderedLayout(page)).toBe(layout);

    const boxes = await page.evaluate(() => {
      const box = (selector: string): { top: number; right: number; bottom: number; left: number } => {
        const rect = (document.querySelector(selector) as HTMLElement).getBoundingClientRect();
        return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left };
      };
      const app = document.getElementById('app') as HTMLElement;
      const style = getComputedStyle(app);
      return {
        pane: box('#symbol-pane'),
        editor: box('.panel--editor'),
        console: box('.panel--console'),
        stdin: box('.panel--stdin'),
        diagnostics: box('.panel--diagnostics'),
        contentRight: app.getBoundingClientRect().right - parseFloat(style.paddingRight),
        scrollWidth: document.documentElement.scrollWidth,
      };
    });

    // The pane is the inline-end column: every other panel ends before it
    // starts, and it reaches the app's content edge.
    for (const name of ['editor', 'console', 'stdin', 'diagnostics'] as const) {
      expect(
        boxes[name].right,
        `${name} ends before the pane's column starts`,
      ).toBeLessThanOrEqual(boxes.pane.left + 1);
    }
    expect(boxes.pane.right, 'the pane reaches the content edge').toBeCloseTo(
      boxes.contentRight,
      0,
    );

    // ...and it is full-height across the split, in both layouts.
    expect(boxes.pane.top, 'the pane spans the split').toBeCloseTo(
      Math.min(boxes.console.top, boxes.editor.top),
      0,
    );
    expect(boxes.pane.bottom, 'the pane spans the split').toBeCloseTo(
      Math.max(boxes.diagnostics.bottom, boxes.editor.bottom),
      0,
    );

    // spec-04 FR-408's split still holds inside the remaining space.
    if (layout === 'vertical') {
      expect(boxes.editor.right, 'the editor is still inline-start').toBeLessThanOrEqual(
        boxes.console.left,
      );
      expect(boxes.stdin.left).toBeCloseTo(boxes.console.left, 0);
      expect(boxes.diagnostics.left).toBeCloseTo(boxes.console.left, 0);
    }

    expect(boxes.scrollWidth, 'the page never scrolls sideways').toBeLessThanOrEqual(WIDE.width);
  });
}
