import type { Page } from '@playwright/test';

/** The slice of the CodeMirror view the helpers reach into from the page. */
interface EditorViewLike {
  state: {
    doc: { length: number; toString(): string };
    selection: { main: { from: number; to: number } };
  };
  dispatch(spec: unknown): void;
}

/** The starter program, byte for byte (spec: Data & Interfaces). */
export const STARTER_PROGRAM =
  '# Bienvenido al playground de Python.\n' +
  '# Escribí tu programa y apretá "Run" (Ctrl/Cmd+Enter).\n' +
  '\n' +
  'nombre = input("¿Cómo te llamás? ")\n' +
  'print(f"Hola, {nombre}!")\n' +
  '\n' +
  'for i in range(1, 6):\n' +
  '    print(i, "al cuadrado es", i * i)\n';

export const PROGRAM_KEY = 'pyplay.program.v1';
export const WORKSPACE_KEY = 'pyplay.workspace.v1';

/**
 * Load the playground and wait for the editor to be mounted.
 *
 * spec-03 VC-327 runs the spec-01 suites twice: once with the
 * special-character pane present but never opened (the default), and once with
 * it opened before each spec's first assertion. `PANE_OPEN=1` selects the
 * second configuration, so no spec needs to know about the pane to be verified
 * against it (BR-301).
 */
export interface OpenOptions {
  /**
   * Whether `PYPLAY_LAYOUT_PREF` may seed the layout preference for this load.
   * spec-04's own suites assert on that preference, so they pass `false` and
   * seed it themselves — otherwise a VC-433 run would overwrite the value
   * under test (the env seed is installed last and would win).
   */
  seedLayout?: boolean;
}

export async function openPlayground(page: Page, options: OpenOptions = {}): Promise<void> {
  if (options.seedLayout !== false) await seedLayoutPreference(page);
  await page.goto('/');
  await page.waitForSelector('.cm-content');
  if (process.env.PANE_OPEN) {
    await page.locator('#btn-symbols').click();
    await page.waitForSelector('#symbol-pane .symbol');
  }
}

/**
 * spec-04's `localStorage` key (spec-04: Constants). `v2` — `v1` held the same
 * two strings with their meanings swapped; see `src/layout.ts`.
 */
export const LAYOUT_KEY = 'pyplay.layout.v2';

/**
 * spec-04 VC-433 runs the spec-01 and spec-03 suites three times — with the
 * layout preference unset, `vertical` and `horizontal` — because the layout is
 * presentation only (BR-401) and every criterion those suites cover must hold
 * in both renderings.
 *
 * `PYPLAY_LAYOUT_PREF` selects the run. Unset (the default) is the shipped
 * behaviour: nothing is written, and FR-411 resolves from the viewport width.
 * The seed is installed with `addInitScript`, so it is in place before the
 * page's own scripts run and therefore before FR-416's first paint.
 *
 * A spec that asserts on the preference itself must not have it seeded from
 * the environment underneath it, so `tests/e2e/layout.spec.ts` and
 * `tests/e2e/layout-state.spec.ts` seed explicitly and never call this.
 */
export async function seedLayoutPreference(page: Page): Promise<void> {
  const preference = process.env.PYPLAY_LAYOUT_PREF;
  if (!preference) return;
  if (preference !== 'vertical' && preference !== 'horizontal') {
    throw new Error(
      `PYPLAY_LAYOUT_PREF must be "vertical" or "horizontal", got "${preference}"`,
    );
  }
  await page.addInitScript(
    ({ key, value }) => {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // VC-418: an unwritable store is the subject of its own criterion.
      }
    },
    { key: LAYOUT_KEY, value: preference },
  );
}

/** The editor's current contents, reconstructed from the rendered lines. */
export async function editorText(page: Page): Promise<string> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.cm-content > .cm-line'))
      .map((line) => (line.textContent === '​' ? '' : (line.textContent ?? '')))
      .join('\n'),
  );
}

/** Replace the editor contents by typing, so the change goes through the UI. */
export async function typeProgram(page: Page, text: string): Promise<void> {
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.keyboard.type(text);
}

/** `main.py`'s text as persisted in the workspace autosave key, or null. */
export async function storedProgram(page: Page): Promise<string | null> {
  return page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as { files: Array<{ name: string; dataBase64: string }> };
      const main = parsed.files.find((file) => file.name === 'main.py');
      if (!main) return null;
      const binary = atob(main.dataBase64);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
  }, WORKSPACE_KEY);
}

/**
 * Fill localStorage until even a small write is rejected.
 * Returns true when the quota is genuinely exhausted.
 */
export async function exhaustLocalStorage(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    let seq = 0;
    // Fill with progressively smaller writes so no usable slack is left.
    for (const size of [100_000, 10_000, 1_000, 100, 10, 1]) {
      const value = 'a'.repeat(size);
      for (let i = 0; i < 20_000; i++) {
        try {
          window.localStorage.setItem(`fill.${seq++}`, value);
        } catch {
          break;
        }
      }
    }
    try {
      window.localStorage.setItem('pyplay.probe.v1', 'c');
      return false;
    } catch {
      return true;
    }
  });
}

/** The console's full text content. */
export async function consoleText(page: Page): Promise<string> {
  return page.evaluate(() => document.getElementById('console')?.textContent ?? '');
}

/** The status indicator's text (FR-065). */
export async function statusText(page: Page): Promise<string> {
  return page.evaluate(() => document.getElementById('status-bar')?.textContent ?? '');
}

/**
 * The conditionally-inert controls carry `aria-disabled` rather than
 * `disabled`, so they stay in the tab order (FR-049) while remaining
 * non-activatable (FR-054, FR-058) — see `src/controls.ts`. Playwright's
 * `toBeDisabled()`/`toBeEnabled()` read the same attribute.
 */

/** Wait for FR-013: the runtime is ready and Run is enabled. */
export async function waitForPythonReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const run = document.getElementById('btn-run');
      return !!run && run.getAttribute('aria-disabled') !== 'true';
    },
    undefined,
    { timeout: 60_000 },
  );
}

/**
 * Replace the editor contents without typing — used when the program's exact
 * bytes matter more than the input path (indentation, tabs, long programs).
 * Reaches the CodeMirror view the way `EditorView.findFromDOM` does.
 */
export async function setProgram(page: Page, code: string): Promise<void> {
  await page.evaluate((text) => {
    const content = document.querySelector('.cm-content') as
      | (HTMLElement & {
          cmView?: { view: EditorViewLike };
          cmTile?: { view: EditorViewLike };
        })
      | null;
    const view = content?.cmTile?.view ?? content?.cmView?.view;
    if (!view) throw new Error('CodeMirror view not found');
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  }, code);
}

/** Document bytes and the main selection, read from the live CodeMirror view. */
export async function editorSnapshot(
  page: Page,
): Promise<{ text: string; from: number; to: number }> {
  return page.evaluate(() => {
    const content = document.querySelector('.cm-content') as
      | (HTMLElement & {
          cmView?: { view: EditorViewLike };
          cmTile?: { view: EditorViewLike };
        })
      | null;
    const view = content?.cmTile?.view ?? content?.cmView?.view;
    if (!view) throw new Error('CodeMirror view not found');
    const { from, to } = view.state.selection.main;
    return { text: view.state.doc.toString(), from, to };
  });
}

/** The console's spans, in DOM order, with the class that styled each one. */
export async function consoleSpans(page: Page): Promise<{ kind: string; text: string }[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#console > span')).map((span) => ({
      kind: span.className.replace('console-', ''),
      text: span.textContent ?? '',
    })),
  );
}

/**
 * Exactly what the program wrote to stdout — no run separators, no prompts
 * (FR-030 keeps those out of the stream) and no echoed input.
 */
export async function programStdout(page: Page): Promise<string> {
  const spans = await consoleSpans(page);
  return spans
    .filter((span) => span.kind === 'stdout')
    .map((span) => span.text)
    .join('');
}

/** Wait until the program is suspended on a read with the field ready (FR-029). */
export async function waitForStdinPrompt(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const field = document.getElementById('stdin-input');
      return !!field && field.getAttribute('aria-disabled') !== 'true';
    },
    undefined,
    { timeout: 30_000 },
  );
}

/** Type a line into the stdin field and submit it with Enter (FR-031). */
export async function submitStdin(page: Page, text: string): Promise<void> {
  await waitForStdinPrompt(page);
  const field = page.locator('#stdin-input');
  await field.fill(text);
  await field.press('Enter');
}

/** Load, wait for the runtime, put `code` in the editor and press Run. */
export async function runProgram(page: Page, code: string): Promise<void> {
  await setProgram(page, code);
  await page.locator('#btn-run').click();
}

/**
 * Wait until the Ruff engine has loaded: Format is the control that is
 * enabled exactly when the engine is usable (FR-058).
 */
export async function waitForLinter(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const btn = document.getElementById('btn-format');
      return !!btn && btn.getAttribute('aria-disabled') !== 'true';
    },
    undefined,
    { timeout: 30_000 },
  );
}

/** The diagnostics panel entries, in listed order (FR-038). */
export async function diagnosticEntries(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#diagnostics-list .diagnostic-entry')).map(
      (el) => el.textContent ?? '',
    ),
  );
}

/** The panel's live count (FR-038) and empty-state text (FR-040, FR-046). */
export async function diagnosticsPanelState(
  page: Page,
): Promise<{ count: string; empty: string; emptyHidden: boolean }> {
  return page.evaluate(() => {
    const empty = document.getElementById('diagnostics-empty') as HTMLElement | null;
    return {
      count: document.getElementById('diagnostics-count')?.textContent ?? '',
      empty: empty?.textContent ?? '',
      emptyHidden: !!empty?.hidden,
    };
  });
}

/** The editor's caret offset and the 1-based line/column it sits on. */
export async function caretPosition(
  page: Page,
): Promise<{ offset: number; line: number; column: number }> {
  return page.evaluate(() => {
    const content = document.querySelector('.cm-content') as
      | (HTMLElement & {
          cmView?: { view: { state: unknown } };
          cmTile?: { view: { state: unknown } };
        })
      | null;
    const view = (content?.cmTile?.view ?? content?.cmView?.view) as
      | {
          state: {
            selection: { main: { head: number } };
            doc: { lineAt(pos: number): { number: number; from: number } };
          };
        }
      | undefined;
    if (!view) throw new Error('CodeMirror view not found');
    const offset = view.state.selection.main.head;
    const line = view.state.doc.lineAt(offset);
    return { offset, line: line.number, column: offset - line.from + 1 };
  });
}

/** Place the caret at a 1-based line/column without going through the mouse. */
export async function setCaret(page: Page, line: number, column: number): Promise<void> {
  await page.evaluate(
    ({ line, column }) => {
      const content = document.querySelector('.cm-content') as
        | (HTMLElement & {
            cmView?: { view: unknown };
            cmTile?: { view: unknown };
          })
        | null;
      const view = (content?.cmTile?.view ?? content?.cmView?.view) as
        | {
            state: { doc: { line(n: number): { from: number; to: number } } };
            dispatch(spec: unknown): void;
            focus(): void;
          }
        | undefined;
      if (!view) throw new Error('CodeMirror view not found');
      const target = view.state.doc.line(line);
      view.dispatch({ selection: { anchor: Math.min(target.to, target.from + column - 1) } });
      view.focus();
    },
    { line, column },
  );
}

/**
 * Load the playground with every Ruff asset returning 404, so the lint/format
 * engine can never initialise (VC-049, VC-070).
 */
export async function openWithoutLinter(page: Page): Promise<void> {
  await page.route('**/ruff/**', (route) => route.fulfill({ status: 404, body: 'not found' }));
  await openPlayground(page);
}

/** Wait for the status indicator to read exactly `text` (FR-065). */
export async function waitForStatus(page: Page, text: string, timeout = 90_000): Promise<void> {
  await page.waitForFunction(
    (expected) => document.getElementById('status-bar')?.textContent === expected,
    text,
    { timeout },
  );
}

/**
 * Record every value the status indicator takes, from the very first paint.
 * Must be installed before navigation (VC-080).
 */
export async function recordStatuses(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __statuses: string[] }).__statuses = seen;
    const start = (): void => {
      const bar = document.getElementById('status-bar');
      if (!bar) return;
      const push = (): void => {
        const text = bar.textContent ?? '';
        if (seen[seen.length - 1] !== text) seen.push(text);
      };
      push();
      new MutationObserver(push).observe(bar, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start);
    } else {
      start();
    }
  });
}

/** The recorded status sequence (see `recordStatuses`). */
export async function statusHistory(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __statuses: string[] }).__statuses ?? []);
}

/** The origin's Cache Storage bucket names. */
export async function cacheBuckets(page: Page): Promise<string[]> {
  return page.evaluate(() => caches.keys());
}

/**
 * The build's precache manifest, and which of its URLs are missing from the
 * `pyplay-assets-v<build>` bucket (VC-072).
 */
export async function precacheReport(
  page: Page,
): Promise<{ build: string; urls: string[]; missing: string[] }> {
  return page.evaluate(async () => {
    const manifest = (await (await fetch('/precache-manifest.json')).json()) as {
      build: string;
      urls: string[];
    };
    const cache = await caches.open(`pyplay-assets-v${manifest.build}`);
    const missing: string[] = [];
    for (const url of manifest.urls) {
      if (!(await cache.match(url))) missing.push(url);
    }
    return { build: manifest.build, urls: manifest.urls, missing };
  });
}

/** The texts of every non-blocking notice currently shown (FR-053, BR-009). */
export async function noticeTexts(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#notices [data-notice]')).map(
      (el) => (el as HTMLElement).dataset.notice ?? '',
    ),
  );
}

/**
 * Starts a `longtask` `PerformanceObserver` in-page (VC-323, VC-513): call
 * `reset` once anything left over from page load has settled, and `read`
 * after the interaction under test to collect only what it caused.
 */
export async function trackLongTasks(
  page: Page,
): Promise<{ reset: () => Promise<void>; read: () => Promise<number[]> }> {
  await page.evaluate(() => {
    const box = window as unknown as { __longTasks: number[] };
    box.__longTasks = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) box.__longTasks.push(entry.duration);
    }).observe({ entryTypes: ['longtask'] });
  });
  return {
    reset: () =>
      page.evaluate(() => {
        (window as unknown as { __longTasks: number[] }).__longTasks.length = 0;
      }),
    read: () => page.evaluate(() => (window as unknown as { __longTasks: number[] }).__longTasks),
  };
}
