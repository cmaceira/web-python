/**
 * Iteration 8 — presentation and accessibility.
 *
 * VC-050 (FR-047, FR-065) — the 375 px layout.
 * VC-051 (FR-048, NFR-010) — text contrast >= 4.5:1 in both palettes.
 * VC-071 (NFR-013) — non-text contrast >= 3:1 in both palettes.
 * VC-052 (FR-049) — every control reachable by `Tab`, with a visible ring.
 * VC-514 (NFR-502, NFR-503) — forced Light/Dark against the opposite OS.
 * VC-515 (NFR-504) — `#btn-theme` hit area at 375 × 667.
 * VC-815 (NFR-802, NFR-803) — About glyph / dialog / focus ring contrast.
 * VC-816 (NFR-804) — `#btn-about` hit area at 375 × 667.
 */
import { expect, test, type Page } from '@playwright/test';
import { failures, measureContrast, type Sample } from './contrast';
import {
  consoleText,
  diagnosticEntries,
  openPlayground,
  runProgram,
  setProgram,
  submitStdin,
  waitForLinter,
  waitForPythonReady,
  waitForStdinPrompt,
} from './helpers';

/* -------------------------------------------------------------------------
   VC-050 (FR-047, FR-065)
   ------------------------------------------------------------------------- */

const NARROW = { width: 375, height: 667 };

/** Every control FR-047 and FR-049 name, by the selector that finds it. */
const CONTROLS = [
  '#btn-run',
  '#btn-stop',
  '#btn-clear',
  '#btn-copy',
  '#btn-format',
  '#btn-reset',
  // spec-04 FR-401 / NFR-401: the layout control, amending VC-050. Its
  // three preference states are exercised by VC-427.
  '#layout-vertical',
  '#layout-horizontal',
  // spec-03 FR-301: the pane's toggle is a toolbar control like any other.
  '#btn-symbols',
  // spec-05 FR-501: color-mode control after Symbols.
  '#btn-theme',
  // spec-08 FR-801: About after theme.
  '#btn-about',
  '.cm-content',
  '#stdin-input',
  '#btn-eof',
];

test.describe('375 px viewport', () => {
  test.use({ viewport: NARROW });

  // spec-03 amendment: the same assertions hold with the special-character
  // pane open, which is the state VC-319 constrains.
  for (const pane of ['closed', 'open'] as const) {
  test(`VC-050 (FR-047, FR-065): nothing is clipped and the page never scrolls sideways — pane ${pane}`, async ({
    page,
  }) => {
    await openPlayground(page);
    await waitForPythonReady(page);
    await waitForLinter(page);

    if (pane === 'open') {
      await page.getByRole('button', { name: 'Symbols' }).click();
      await expect(page.locator('#symbol-pane')).toBeVisible();
    }

    // A long line in the editor and a long line in the console: the two places
    // horizontal overflow can originate.
    await setProgram(page, `x = "${'y'.repeat(400)}"\nprint(x)\n`);
    await page.locator('#btn-run').click();
    await expect.poll(() => consoleText(page)).toContain('yyyy');

    // FR-047: no horizontal page scrolling, whatever the content.
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
      inner: window.innerWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(NARROW.width);
    expect(overflow.bodyScrollWidth).toBeLessThanOrEqual(NARROW.width);

    // ...while the editor and the console do scroll within their own bounds.
    const inner = await page.evaluate(() => {
      const console = document.getElementById('console')!;
      const scroller = document.querySelector('.cm-scroller')!;
      return {
        consoleScrolls: console.scrollWidth > console.clientWidth,
        consoleWithin: console.getBoundingClientRect().right <= window.innerWidth + 1,
        editorWithin: scroller.getBoundingClientRect().right <= window.innerWidth + 1,
      };
    });
    expect(inner.consoleScrolls).toBe(true);
    expect(inner.consoleWithin).toBe(true);
    expect(inner.editorWithin).toBe(true);

    // Every control is present, inside the viewport, and not clipped away.
    for (const selector of CONTROLS) {
      const box = await page.locator(selector).first().boundingBox();
      expect(box, `${selector} has no box`).not.toBeNull();
      expect(box!.width, `${selector} width`).toBeGreaterThan(0);
      expect(box!.height, `${selector} height`).toBeGreaterThan(0);
      expect(box!.x, `${selector} left edge`).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width, `${selector} right edge`).toBeLessThanOrEqual(NARROW.width + 1);
    }

    // FR-065: the status bar sits between the toolbar and the console, is not
    // interactive, and overlaps neither the editor nor anything else.
    const geometry = await page.evaluate(() => {
      const rect = (selector: string): DOMRect =>
        document.querySelector(selector)!.getBoundingClientRect();
      return {
        toolbar: rect('.toolbar').bottom,
        status: { top: rect('#status-bar').top, bottom: rect('#status-bar').bottom },
        console: rect('.panel--console').top,
        editor: { top: rect('.panel--editor').top, bottom: rect('.panel--editor').bottom },
        pointerEvents: getComputedStyle(document.getElementById('status-bar')!).pointerEvents,
        tabIndex: (document.getElementById('status-bar') as HTMLElement).tabIndex,
      };
    });
    expect(geometry.status.top).toBeGreaterThanOrEqual(geometry.toolbar - 1);
    expect(geometry.status.bottom).toBeLessThanOrEqual(geometry.console + 1);
    // Never overlapping the editor, in either direction.
    expect(geometry.status.bottom).toBeLessThanOrEqual(geometry.editor.top + 1);
    expect(geometry.pointerEvents).toBe('none');
    expect(geometry.tabIndex).toBeLessThan(0);
  });
  }
});

/* -------------------------------------------------------------------------
   VC-051 / VC-071 — contrast in both palettes
   ------------------------------------------------------------------------- */

/**
 * Bring the page to a state in which every surface NFR-010 and NFR-013 name is
 * actually on screen: stdout, stderr, an echoed input line, a prompt, a
 * traceback, run metadata, an error diagnostic and a warning diagnostic (both
 * as editor markers and as panel entries), and a notice.
 */
async function paintEverySurface(page: Page): Promise<void> {
  // spec-09: `#diag-resizer` is only painted in vertical ≥ 900. Seed before
  // navigation so contrast samples can include it without a pointer click that
  // would clear `:focus-visible` for later focus-ring measurements.
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('pyplay.layout.v2', 'vertical');
    } catch {
      /* ignore */
    }
  });
  await openPlayground(page, { seedLayout: false });
  await waitForPythonReady(page);
  await waitForLinter(page);
  await expect
    .poll(() => page.evaluate(() => document.getElementById('app')?.dataset.layout))
    .toBe('vertical');
  await expect(page.locator('#diag-resizer')).toBeVisible();

  await runProgram(
    page,
    [
      'import os',
      'import sys',
      '',
      'sys.stderr.write("boom\\n")',
      'name = input("Name: ")',
      'print("hola", name)',
      'print(undefined_name)',
      '',
    ].join('\n'),
  );

  await waitForStdinPrompt(page);
  await submitStdin(page, 'Ana');
  await expect.poll(() => consoleText(page)).toContain('Program exited with an error.');

  // `import os` is an unused-import warning; `undefined_name` is an
  // error-severity F821 — one marker and one panel entry of each severity.
  await expect.poll(() => diagnosticEntries(page)).not.toHaveLength(0);
  await expect(page.locator('.cm-diagnostic-mark.cm-diagnostic-error')).toHaveCount(1);
  await expect(page.locator('.cm-diagnostic-mark.cm-diagnostic-warning')).not.toHaveCount(0);
  await expect(page.locator('.cm-diagnostic-gutter-error')).not.toHaveCount(0);
  await expect(page.locator('.cm-diagnostic-gutter-warning')).not.toHaveCount(0);

  // spec-03 VC-322: the pane's own surfaces are only measurable with the pane
  // open, so every sampling run paints it too. Opened from the keyboard, not
  // by pointer: a click would switch the browser's focus-visible heuristic to
  // pointer modality and suppress the focus rings VC-071 goes on to sample.
  await page.locator('#btn-symbols').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#symbol-pane')).toBeVisible();

  // VC-322 samples *inside* FR-307's 2 000 ms window, so the feedback text and
  // the `data-state="copied"` highlight are both genuinely on screen. `Enter`
  // on the focused button keeps the run in keyboard modality, which is what
  // makes the focus rings VC-071 samples visible.
  await page.keyboard.press('Enter');
  await expect(page.locator('#symbol-status')).toHaveText('Copied "');

  // spec-06 NFR-602: keep the completion list and its selected option painted
  // while both palette audits sample their rendered colours.
  await page.locator('.cm-content').focus();
  await page.keyboard.press('Control+Space');
  await expect(page.locator('.cm-tooltip-autocomplete')).toBeVisible();
}

/** Every text surface NFR-010 lists, plus the syntax colours around them. */
const TEXT_SAMPLES: Sample[] = [
  { label: 'toolbar button label', selector: '#btn-clear', prop: 'color' },
  { label: 'primary button label (Run)', selector: '#btn-run', prop: 'color' },
  { label: 'inert button label (Stop)', selector: '#btn-stop', prop: 'color' },
  { label: 'status bar', selector: '#status-bar', prop: 'color' },
  { label: 'stdin label', selector: '.stdin-label', prop: 'color' },
  { label: 'stdin field text', selector: '#stdin-input', prop: 'color' },
  { label: 'diagnostics panel title', selector: '.panel-title', prop: 'color' },
  { label: 'diagnostics count', selector: '#diagnostics-count', prop: 'color' },
  { label: 'console stdout', selector: '.console-stdout', prop: 'color' },
  { label: 'console stderr', selector: '.console-stderr', prop: 'color' },
  { label: 'console echoed input', selector: '.console-input', prop: 'color' },
  { label: 'console prompt', selector: '.console-prompt', prop: 'color' },
  { label: 'console run metadata', selector: '.console-meta', prop: 'color' },
  { label: 'console traceback', selector: '.console-error', prop: 'color' },
  { label: 'diagnostics entry (error)', selector: '.diagnostic-entry--error', prop: 'color' },
  { label: 'diagnostics entry (warning)', selector: '.diagnostic-entry--warning', prop: 'color' },
  { label: 'editor text', selector: '.cm-content', prop: 'color' },
  { label: 'editor gutter numbers', selector: '.cm-lineNumbers .cm-gutterElement', prop: 'color' },
  { label: 'syntax: keyword', selector: '.tok-keyword', prop: 'color' },
  { label: 'syntax: string', selector: '.tok-string', prop: 'color' },
  { label: 'syntax: definition', selector: '.tok-def', prop: 'color' },
  { label: 'syntax: operator', selector: '.tok-operator', prop: 'color' },
  // spec-03 NFR-302: the pane's text — glyphs and group headings. The FR-307
  // feedback text is sampled separately, once a copy has actually happened.
  { label: 'symbol glyph', selector: '#symbol-pane .symbol', prop: 'color' },
  { label: 'symbol group heading', selector: '#symbol-pane .symbol-group-title', prop: 'color' },
  { label: 'symbol copy feedback', selector: '#symbol-status', prop: 'color' },
  { label: 'copied-state glyph', selector: '#symbol-pane .symbol[data-state="copied"]', prop: 'color' },
  /*
   * spec-04 NFR-402, amending VC-051: both layout radio labels, checked and
   * unchecked. The disabled rendering only exists below 900 px, so VC-428
   * samples that one — see `tests/e2e/layout.spec.ts`.
   */
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
  // spec-05 NFR-502: the color-mode control's glyph against the toolbar.
  { label: 'theme glyph', selector: '#btn-theme', prop: 'color' },
  // spec-08 NFR-802: the About control's glyph against the toolbar (dialog
  // surfaces are sampled separately once the modal is open — see ABOUT_*).
  { label: 'about glyph', selector: '#btn-about', prop: 'color' },
  // spec-06 NFR-602: both ordinary and initially-selected completion text.
  {
    label: 'completion option',
    selector: '.cm-tooltip-autocomplete [role="option"]:not([aria-selected="true"])',
    prop: 'color',
  },
  {
    label: 'selected completion option',
    selector: '.cm-tooltip-autocomplete [role="option"][aria-selected="true"]',
    prop: 'color',
  },
];

/** Every non-text component NFR-013 lists. */
const NON_TEXT_SAMPLES: Sample[] = [
  {
    label: 'diagnostic underline (error)',
    selector: '.cm-diagnostic-mark.cm-diagnostic-error',
    prop: 'textDecorationColor',
  },
  {
    label: 'diagnostic underline (warning)',
    selector: '.cm-diagnostic-mark.cm-diagnostic-warning',
    prop: 'textDecorationColor',
  },
  { label: 'gutter icon (error)', selector: '.cm-diagnostic-gutter-error', prop: 'color' },
  { label: 'gutter icon (warning)', selector: '.cm-diagnostic-gutter-warning', prop: 'color' },
  { label: 'control border (Clear console)', selector: '#btn-clear', prop: 'borderTopColor' },
  { label: 'control border (stdin field)', selector: '#stdin-input', prop: 'borderTopColor' },
  { label: 'panel border', selector: '.panel--console', prop: 'borderTopColor' },
  { label: 'status bar border', selector: '#status-bar', prop: 'borderTopColor' },
  {
    label: 'completion popup border',
    selector: '.cm-tooltip-autocomplete',
    prop: 'borderTopColor',
  },
  {
    label: 'selected completion highlight',
    selector: '.cm-tooltip-autocomplete [role="option"][aria-selected="true"]',
    prop: 'backgroundColor',
  },
  // FR-054 / FR-058: the disabled affordance is the control's boundary — its
  // border against the page behind it, which is what SC 1.4.11 measures.
  { label: 'disabled affordance (Stop border)', selector: '#btn-stop', prop: 'borderTopColor' },
  // FR-049 focus rings, measured with the element genuinely focused.
  { label: 'focus ring (Run)', selector: '#btn-run', prop: 'outlineColor', focus: true },
  { label: 'focus ring (Stop, inert)', selector: '#btn-stop', prop: 'outlineColor', focus: true },
  { label: 'focus ring (Copy code)', selector: '#btn-copy', prop: 'outlineColor', focus: true },
  { label: 'focus ring (editor)', selector: '.cm-content', prop: 'outlineColor', focus: true },
  { label: 'focus ring (stdin field)', selector: '#stdin-input', prop: 'outlineColor', focus: true },
  { label: 'focus ring (Send EOF)', selector: '#btn-eof', prop: 'outlineColor', focus: true },
  {
    label: 'focus ring (diagnostics entry)',
    selector: '.diagnostic-entry',
    prop: 'outlineColor',
    focus: true,
  },
  // spec-03 NFR-303: the pane's non-text components.
  // A button in its resting state: the copied one is a filled highlight,
  // measured separately below.
  {
    label: 'symbol button border',
    selector: '#symbol-pane .symbol:not([data-state])',
    prop: 'borderTopColor',
  },
  { label: 'symbol pane edge', selector: '#symbol-pane', prop: 'borderTopColor' },
  {
    label: 'focus ring (symbol button)',
    selector: '#symbol-pane .symbol:not([data-state])',
    prop: 'outlineColor',
    focus: true,
  },
  /*
   * spec-04 NFR-403, amending VC-071: the segment border, the checked-state
   * indicator and the focus ring. The disabled border and the horizontal
   * layout's column edge only exist in renderings this test does not produce,
   * so VC-428 samples those — see `tests/e2e/layout.spec.ts`.
   */
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
  // spec-05 NFR-503: the color-mode control's focus ring.
  {
    label: 'focus ring (theme)',
    selector: '#btn-theme',
    prop: 'outlineColor',
    focus: true,
  },
  // spec-09 NFR-902: diagnostics separator resting fill (hover/focus sampled
  // separately in VC-071 after the control is shown).
  {
    label: 'diag-resizer resting',
    selector: '#diag-resizer',
    prop: 'backgroundColor',
  },
  {
    label: 'focus ring (diag-resizer)',
    selector: '#diag-resizer',
    prop: 'outlineColor',
    focus: true,
  },
  // spec-08 NFR-803: About control focus ring (dialog chrome sampled after open).
  {
    label: 'focus ring (about)',
    selector: '#btn-about',
    prop: 'outlineColor',
    focus: true,
  },
];

/**
 * spec-08 VC-815: dialog text and labels — only measurable with the modal open.
 * Opened after the parent sample set so the backdrop cannot hide other surfaces.
 */
const ABOUT_TEXT_SAMPLES: Sample[] = [
  { label: 'about dialog title', selector: '#about-title', prop: 'color' },
  { label: 'about field label', selector: '#about-version-label', prop: 'color' },
  { label: 'about field value', selector: '#about-version', prop: 'color' },
  { label: 'about Close label', selector: '#about-close', prop: 'color' },
];

/** spec-08 VC-815: dialog border, backdrop distinction, Close focus ring. */
const ABOUT_NON_TEXT_SAMPLES: Sample[] = [
  { label: 'about dialog border', selector: '#about-dialog', prop: 'borderTopColor' },
  {
    label: 'about backdrop distinction',
    selector: '#about-backdrop',
    prop: 'backgroundColor',
  },
  {
    label: 'focus ring (about Close)',
    selector: '#about-close',
    prop: 'outlineColor',
    focus: true,
  },
];

/** Open About via keyboard so focus-visible modality stays active for rings. */
async function openAboutDialog(page: Page): Promise<void> {
  await page.locator('#btn-about').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#about-dialog')).toBeVisible();
  await expect(page.locator('#about-backdrop')).toBeVisible();
}

/** The notice strip, which only exists once something has gone wrong. */
const NOTICE_SAMPLES: Sample[] = [
  { label: 'notice text', selector: '.notice', prop: 'color' },
  { label: 'notice border', selector: '.notice', prop: 'borderTopColor' },
];

/** Provoke FR-045's `Can't format` notice, so the notice strip is painted. */
async function paintNotice(page: Page): Promise<void> {
  await setProgram(page, 'def f(:\n');
  await page.getByRole('button', { name: 'Format' }).click();
  await expect(page.locator('.notice')).toBeVisible();
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} palette`, () => {
    test.use({ colorScheme: scheme });

    test(`VC-051, VC-622, VC-815 (FR-048, NFR-010, NFR-602, NFR-802): every text pair clears 4.5:1 — ${scheme}`, async ({ page }) => {
      await paintEverySurface(page);

      const measured = await measureContrast(page, TEXT_SAMPLES);
      await paintNotice(page);
      measured.push(...(await measureContrast(page, [NOTICE_SAMPLES[0]!])));

      // spec-08 VC-815: dialog text only exists once About is open.
      await openAboutDialog(page);
      measured.push(...(await measureContrast(page, ABOUT_TEXT_SAMPLES)));

      // FR-048: dark mode really is a different palette, not the light one.
      const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(bodyBg).toBe(scheme === 'dark' ? 'rgb(20, 22, 26)' : 'rgb(255, 255, 255)');

      expect(measured).toHaveLength(TEXT_SAMPLES.length + 1 + ABOUT_TEXT_SAMPLES.length);
      expect(failures(measured, 4.5)).toEqual([]);
    });

    test(`VC-071, VC-622, VC-815 (NFR-013, NFR-602, NFR-803): every non-text pair clears 3:1 — ${scheme}`, async ({ page }) => {
      await paintEverySurface(page);

      const measured = await measureContrast(page, NON_TEXT_SAMPLES);
      await paintNotice(page);
      measured.push(...(await measureContrast(page, [NOTICE_SAMPLES[1]!])));

      // FR-058's Format affordance. The missing-engine path changes exactly
      // one thing about the control — `aria-disabled` — so putting the live
      // control into that state measures the rendering FR-058 specifies.
      await page.evaluate(() =>
        document.getElementById('btn-format')!.setAttribute('aria-disabled', 'true'),
      );
      measured.push(
        ...(await measureContrast(page, [
          {
            label: 'disabled affordance (Format border)',
            selector: '#btn-format',
            prop: 'borderTopColor',
          },
        ])),
      );

      // spec-03 FR-307: the copied highlight is a fill on the activated
      // button, measured against the pane behind it (NFR-303), in the state a
      // real copy put it in.
      measured.push(
        ...(await measureContrast(page, [
          {
            label: 'copied-state highlight',
            selector: '#symbol-pane .symbol[data-state="copied"]',
            prop: 'backgroundColor',
          },
        ])),
      );

      // spec-09 NFR-902: hover fill on the diagnostics separator.
      await page.locator('#diag-resizer').hover();
      measured.push(
        ...(await measureContrast(page, [
          {
            label: 'diag-resizer hover',
            selector: '#diag-resizer',
            prop: 'backgroundColor',
          },
        ])),
      );

      // spec-08 VC-815: dialog border / backdrop / Close ring with modal open.
      await openAboutDialog(page);
      measured.push(...(await measureContrast(page, ABOUT_NON_TEXT_SAMPLES)));

      expect(measured).toHaveLength(NON_TEXT_SAMPLES.length + 4 + ABOUT_NON_TEXT_SAMPLES.length);
      expect(failures(measured, 3)).toEqual([]);
    });
  });
}

/* -------------------------------------------------------------------------
   VC-514 (NFR-502, NFR-503) — forced Light / Dark against the opposite OS
   ------------------------------------------------------------------------- */

const THEME_KEY = 'pyplay.theme.v1';

async function seedTheme(page: Page, value: 'light' | 'dark'): Promise<void> {
  await page.addInitScript(
    ({ key, value }) => {
      window.localStorage.setItem(key, value);
    },
    { key: THEME_KEY, value },
  );
}

/**
 * Forced preference under the opposite OS scheme — the parent VC-051 / VC-071
 * amendment that VC-514 discharges. Same sample sets as System-driven runs,
 * including the theme glyph and its focus ring.
 */
for (const forced of [
  { preference: 'light' as const, os: 'dark' as const, bodyBg: 'rgb(255, 255, 255)' },
  { preference: 'dark' as const, os: 'light' as const, bodyBg: 'rgb(20, 22, 26)' },
]) {
  test.describe(`VC-514 forced ${forced.preference} under OS ${forced.os}`, () => {
    test.use({ colorScheme: forced.os });

    test(`VC-514, VC-815 (NFR-502, NFR-802): text contrast under forced ${forced.preference}`, async ({ page }) => {
      await seedTheme(page, forced.preference);
      await paintEverySurface(page);

      const measured = await measureContrast(page, TEXT_SAMPLES);
      await paintNotice(page);
      measured.push(...(await measureContrast(page, [NOTICE_SAMPLES[0]!])));
      await openAboutDialog(page);
      measured.push(...(await measureContrast(page, ABOUT_TEXT_SAMPLES)));

      const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(bodyBg).toBe(forced.bodyBg);
      expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(
        forced.preference,
      );

      expect(measured).toHaveLength(TEXT_SAMPLES.length + 1 + ABOUT_TEXT_SAMPLES.length);
      expect(failures(measured, 4.5)).toEqual([]);
    });

    test(`VC-514, VC-815 (NFR-503, NFR-803): non-text contrast under forced ${forced.preference}`, async ({
      page,
    }) => {
      await seedTheme(page, forced.preference);
      await paintEverySurface(page);

      const measured = await measureContrast(page, NON_TEXT_SAMPLES);
      await paintNotice(page);
      measured.push(...(await measureContrast(page, [NOTICE_SAMPLES[1]!])));

      await page.evaluate(() =>
        document.getElementById('btn-format')!.setAttribute('aria-disabled', 'true'),
      );
      measured.push(
        ...(await measureContrast(page, [
          {
            label: 'disabled affordance (Format border)',
            selector: '#btn-format',
            prop: 'borderTopColor',
          },
          {
            label: 'copied-state highlight',
            selector: '#symbol-pane .symbol[data-state="copied"]',
            prop: 'backgroundColor',
          },
        ])),
      );

      await openAboutDialog(page);
      measured.push(...(await measureContrast(page, ABOUT_NON_TEXT_SAMPLES)));

      expect(measured).toHaveLength(NON_TEXT_SAMPLES.length + 3 + ABOUT_NON_TEXT_SAMPLES.length);
      expect(failures(measured, 3)).toEqual([]);
    });
  });
}

/* -------------------------------------------------------------------------
   VC-515 (NFR-504) — `#btn-theme` at 375 × 667
   VC-816 (NFR-804) — `#btn-about` at 375 × 667
   ------------------------------------------------------------------------- */

test.describe('VC-515 / VC-816 icon controls at 375 px', () => {
  test.use({ viewport: NARROW });

  test('VC-515 (NFR-504): #btn-theme is unclipped with a >= 32 × 32 hit box', async ({
    page,
  }) => {
    await openPlayground(page);
    await waitForPythonReady(page);

    const layout = await page.evaluate(() => {
      const btn = document.getElementById('btn-theme')!;
      const box = btn.getBoundingClientRect();
      return {
        scrollWidth: document.documentElement.scrollWidth,
        width: box.width,
        height: box.height,
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
      };
    });

    expect(layout.scrollWidth).toBeLessThanOrEqual(NARROW.width);
    expect(layout.width).toBeGreaterThanOrEqual(32);
    expect(layout.height).toBeGreaterThanOrEqual(32);
    expect(layout.left).toBeGreaterThanOrEqual(0);
    expect(layout.right).toBeLessThanOrEqual(NARROW.width + 1);
    expect(layout.top).toBeGreaterThanOrEqual(0);
    expect(layout.bottom).toBeLessThanOrEqual(NARROW.height + 1);
  });

  test('VC-816 (NFR-804): #btn-about is unclipped >= 32×32; open dialog has no horizontal overflow', async ({
    page,
  }) => {
    await openPlayground(page);
    await waitForPythonReady(page);

    const closed = await page.evaluate(() => {
      const btn = document.getElementById('btn-about')!;
      const box = btn.getBoundingClientRect();
      return {
        scrollWidth: document.documentElement.scrollWidth,
        width: box.width,
        height: box.height,
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
      };
    });

    expect(closed.scrollWidth).toBeLessThanOrEqual(NARROW.width);
    expect(closed.width).toBeGreaterThanOrEqual(32);
    expect(closed.height).toBeGreaterThanOrEqual(32);
    expect(closed.left).toBeGreaterThanOrEqual(0);
    expect(closed.right).toBeLessThanOrEqual(NARROW.width + 1);
    expect(closed.top).toBeGreaterThanOrEqual(0);
    expect(closed.bottom).toBeLessThanOrEqual(NARROW.height + 1);

    await openAboutDialog(page);

    const open = await page.evaluate(() => {
      const dialog = document.getElementById('about-dialog')!;
      const box = dialog.getBoundingClientRect();
      return {
        scrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        dialogLeft: box.left,
        dialogRight: box.right,
        dialogTop: box.top,
        dialogBottom: box.bottom,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
      };
    });

    expect(open.scrollWidth).toBeLessThanOrEqual(NARROW.width);
    expect(open.bodyScrollWidth).toBeLessThanOrEqual(NARROW.width);
    expect(open.dialogLeft).toBeGreaterThanOrEqual(0);
    expect(open.dialogRight).toBeLessThanOrEqual(open.innerWidth + 1);
    expect(open.dialogTop).toBeGreaterThanOrEqual(0);
    expect(open.dialogBottom).toBeLessThanOrEqual(open.innerHeight + 1);
  });
});

/* -------------------------------------------------------------------------
   VC-052 (FR-049)
   ------------------------------------------------------------------------- */

test('VC-052 (FR-049): Tab reaches every target, each with a visible ring', async ({ page }) => {
  await openPlayground(page);
  await waitForPythonReady(page);
  await waitForLinter(page);

  // Diagnostics entries only exist once something is wrong; FR-049 names them
  // among the targets, so the traversal is measured with one present.
  await setProgram(page, 'import os\nprint(undefined_name)\n');
  await expect.poll(() => diagnosticEntries(page)).not.toHaveLength(0);

  // spec-03 amendment: the enumeration is taken with the pane **open**, which
  // is the state in which it could add tab stops (BR-305, VC-315).
  await page.getByRole('button', { name: 'Symbols' }).click();
  await expect(page.locator('#symbol-pane')).toBeVisible();

  // Start from the very top of the document, as a fresh page load does.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.locator('body').click({ position: { x: 2, y: 2 } });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  /** Identity of whatever currently holds focus, plus whether it shows a ring. */
  const focused = async (): Promise<{ id: string; ring: boolean }> =>
    page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return { id: '', ring: false };
      const style = getComputedStyle(el);
      const width = Number.parseFloat(style.outlineWidth || '0');
      const ring =
        style.outlineStyle !== 'none' && width >= 1 && style.outlineColor !== 'transparent';
      const id = el.closest('#layout-group')
        ? '#layout-group'
        : el.classList.contains('symbol')
        ? '.symbol'
        : el.id
        ? `#${el.id}`
        : el.classList.contains('cm-content')
          ? '.cm-content'
          : el.classList.contains('diagnostic-entry')
            ? '.diagnostic-entry'
            : (el.tagName.toLowerCase() ?? '');
      return { id, ring };
    });

  const seen = new Map<string, boolean>();
  const sequence: string[] = [];
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    const { id, ring } = await focused();
    if (id) sequence.push(id);
    if (id && !seen.has(id)) seen.set(id, ring);
  }

  // FR-049's targets, in the order the document presents them, as amended by
  // spec-03 / spec-05 / spec-08: `Symbols`, color mode, About, then the pane
  // as a single stop. spec-04 FR-405: `#layout-group` contributes exactly one
  // stop, immediately after `Reset` and before `Symbols`.
  const targets = [
    '#btn-run',
    '#btn-stop',
    '#btn-clear',
    '#btn-copy',
    '#btn-format',
    '#btn-reset',
    '#layout-group',
    '#btn-symbols',
    '#btn-theme',
    '#btn-about',
    '.symbol',
    '.cm-content',
    '#stdin-input',
    '#btn-eof',
    '.diagnostic-entry',
  ];

  // BR-305 / VC-315: 29 buttons, exactly one tab stop. Counted over one full
  // cycle — the first pass over the document, before Tab wraps around.
  const firstCycle = sequence.slice(0, sequence.indexOf('#btn-run', 1) + 1 || sequence.length);
  expect(
    firstCycle.filter((id) => id === '.symbol'),
    `the pane contributed ${firstCycle.filter((id) => id === '.symbol').length} tab stops`,
  ).toHaveLength(1);

  // spec-04 FR-405 / VC-407, amending VC-052: two radios, one tab stop.
  expect(
    firstCycle.filter((id) => id === '#layout-group'),
    `the layout group contributed ${
      firstCycle.filter((id) => id === '#layout-group').length
    } tab stops`,
  ).toHaveLength(1);

  // ...and in the amended order: `Symbols`, then the pane, then the editor.
  const order = targets.map((t) => firstCycle.indexOf(t));
  expect(order, `observed order: ${firstCycle.join(' -> ')}`).toEqual(
    [...order].sort((a, b) => a - b),
  );

  const unreachable = targets.filter((t) => !seen.has(t));
  expect(unreachable, `unreachable by Tab: ${unreachable.join(', ')}`).toEqual([]);

  const ringless = targets.filter((t) => !seen.get(t));
  expect(ringless, `reached without a visible focus indicator: ${ringless.join(', ')}`).toEqual([]);

  // Stop and the stdin field were reached while inert — FR-054 / FR-058 hold
  // at the same time as FR-049.
  await expect(page.locator('#btn-stop')).toBeDisabled();
  await expect(page.locator('#stdin-input')).toBeDisabled();
});
