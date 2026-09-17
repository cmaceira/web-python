/**
 * Output-pane visibility + vertical column width (spec-13: FR-1301 – FR-1312,
 * BR-1301 – BR-1307).
 *
 * Pure load/save/clamp stay free of the DOM. The mount helper wires
 * `#btn-output` and `#output-resizer`, applies `--output-width` /
 * `data-output` / `data-stdin`, and persists only on visitor commit — never
 * on viewport/layout clamp alone.
 */

import { isInert, setInert } from './controls';
import {
  CONSOLE_HEIGHT_SAVE_FAILED,
  CONSOLE_RESIZER_LABEL,
  OUTPUT_RESIZER_LABEL,
  OUTPUT_VISIBLE_SAVE_FAILED,
  OUTPUT_WIDTH_SAVE_FAILED,
} from './format';
import type { Layout } from './layout';
import { LAYOUT_MIN_WIDTH } from './layout';
import type { StorageLike } from './storage';

/** localStorage key holding `shown` | `hidden` (FR-1309). */
export const OUTPUT_VISIBLE_KEY = 'pyplay.output-visible.v1';

/** localStorage key holding the canonical width string (FR-1310). */
export const OUTPUT_WIDTH_KEY = 'pyplay.output-width.v1';

/** Keyboard step in CSS px (FR-1305). */
export const OUTPUT_WIDTH_STEP = 16;

/** Shift+arrow step in CSS px (FR-1305). */
export const OUTPUT_WIDTH_STEP_LARGE = 48;

/** Output column floor in CSS px (FR-1308). Hide is how the visitor goes to 0. */
export const OUTPUT_WIDTH_MIN = 240;

/** Console panel floor in stacked layout (FR-1314 / FR-409). */
export const CONSOLE_HEIGHT_MIN = 80;

/** Editor panel floor when the console height is definite (FR-1314). */
export const EDITOR_HEIGHT_MIN = 120;

/** localStorage key holding the stacked console height (FR-1315). */
export const CONSOLE_HEIGHT_KEY = 'pyplay.console-height.v1';

/** Editor column floor in CSS px (FR-1308 / FR-409). */
export const OUTPUT_EDITOR_MIN = 320;

/** `.app { gap: 8px }` — counted in FR-1308's leftover. */
export const OUTPUT_GAP = 8;

export type OutputVisible = 'shown' | 'hidden';

/** Canonical integer string: non-empty decimal, no sign/leading zero/units (FR-1310). */
const CANONICAL_INT = /^[1-9][0-9]*$/;

function readKey(storage: StorageLike | null, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function writeKey(storage: StorageLike | null, key: string, value: string): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function loadCanonicalInt(storage: StorageLike | null, key: string): number | null {
  const value = readKey(storage, key);
  if (value === null || !CANONICAL_INT.test(value)) return null;
  return Number(value);
}

function saveCanonicalInt(storage: StorageLike | null, key: string, n: number): boolean {
  const canonical = String(Math.trunc(n));
  if (!CANONICAL_INT.test(canonical)) return false;
  return writeKey(storage, key, canonical);
}

/** Canonical visibility string (FR-1309). */
export function isCanonicalOutputVisible(raw: string): raw is OutputVisible {
  return raw === 'shown' || raw === 'hidden';
}

export function isCanonicalOutputWidth(raw: string): boolean {
  return CANONICAL_INT.test(raw);
}

/**
 * FR-1309: read the stored visibility. Missing key, throw, or non-canonical
 * value → null (caller treats as shown). Never writes.
 */
export function loadOutputVisible(storage: StorageLike | null): OutputVisible | null {
  const value = readKey(storage, OUTPUT_VISIBLE_KEY);
  return value !== null && isCanonicalOutputVisible(value) ? value : null;
}

/**
 * FR-1309: persist `shown` | `hidden`. Returns false rather than throwing
 * when storage is unavailable or the write is rejected.
 */
export function saveOutputVisible(
  storage: StorageLike | null,
  visible: OutputVisible,
): boolean {
  return writeKey(storage, OUTPUT_VISIBLE_KEY, visible);
}

/**
 * FR-1310: read the stored width. Missing, throw, or non-canonical → null.
 * Never writes.
 */
export function loadOutputWidth(storage: StorageLike | null): number | null {
  return loadCanonicalInt(storage, OUTPUT_WIDTH_KEY);
}

/**
 * FR-1307 / FR-1310: persist width as a canonical integer string.
 */
export function saveOutputWidth(storage: StorageLike | null, width: number): boolean {
  return saveCanonicalInt(storage, OUTPUT_WIDTH_KEY, width);
}

/**
 * FR-1315: read the stored stacked console height. Missing / junk → null.
 */
export function loadConsoleHeight(storage: StorageLike | null): number | null {
  return loadCanonicalInt(storage, CONSOLE_HEIGHT_KEY);
}

/**
 * FR-1315: persist stacked console height as a canonical integer string.
 */
export function saveConsoleHeight(storage: StorageLike | null, height: number): boolean {
  return saveCanonicalInt(storage, CONSOLE_HEIGHT_KEY, height);
}

/**
 * FR-1314: largest console height that still leaves `editorMin` for the editor.
 */
export function maxConsoleHeight(
  consoleHeight: number,
  editorHeight: number,
  editorMin: number = EDITOR_HEIGHT_MIN,
): number {
  return Math.max(CONSOLE_HEIGHT_MIN, Math.floor(consoleHeight + editorHeight - editorMin));
}

/**
 * Clamp an output width into the inclusive [min, max] band (FR-1308).
 * Degenerate (min > max) viewports resolve to `max` via the nested min/max.
 */
export function clampOutputWidth(width: number, bounds: { min: number; max: number }): number {
  return Math.min(bounds.max, Math.max(bounds.min, width));
}

/**
 * FR-1308: largest output width that still leaves `editorMin` for the editor
 * after Files, Symbols, and gaps (`occupiedBeside`).
 */
export function maxOutputWidth(
  contentWidth: number,
  occupiedBeside: number,
  editorMin: number = OUTPUT_EDITOR_MIN,
): number {
  return Math.max(0, Math.floor(contentWidth - occupiedBeside - editorMin));
}

/** Notice strip surface used for FR-1310 (at most once per key per load). */
export interface OutputPaneNotices {
  show(text: string): void;
}

export interface OutputPaneOptions {
  app: HTMLElement;
  toggle: HTMLButtonElement;
  consolePane: HTMLElement;
  stdinPane: HTMLElement;
  diagnosticsPane: HTMLElement;
  resizer: HTMLElement;
  /** Stacked-layout console height separator (FR-1314). */
  consoleResizer: HTMLElement;
  storage: StorageLike | null;
  notices: OutputPaneNotices;
  /** Effective layout after `resolveLayout` (same value on `#app[data-layout]`). */
  getEffectiveLayout(): Layout;
}

export interface OutputPaneHandle {
  /** Re-measure bounds, refresh ARIA, clamp in memory without rewriting storage. */
  sync(): void;
  /** FR-1303: reveal or re-hide Input according to a pending stdin read. */
  setStdinPending(pending: boolean): void;
}

function setAriaRange(el: HTMLElement, min: number, max: number, now: number): void {
  el.setAttribute('aria-valuemin', String(min));
  el.setAttribute('aria-valuemax', String(max));
  el.setAttribute('aria-valuenow', String(now));
}

function setSizedVar(cssVar: string, flag: string, px: number): void {
  document.documentElement.style.setProperty(cssVar, `${px}px`);
  document.documentElement.dataset[flag] = '';
}

function clearSizedVar(cssVar: string, flag: string): void {
  document.documentElement.style.removeProperty(cssVar);
  delete document.documentElement.dataset[flag];
}

/**
 * Mount the Output toggle + vertical column separator (FR-1301 – FR-1312).
 * Call {@link OutputPaneHandle.sync} from layout render.
 */
export function mountOutputPane(options: OutputPaneOptions): OutputPaneHandle {
  const {
    app,
    toggle,
    consolePane,
    stdinPane,
    diagnosticsPane,
    resizer,
    consoleResizer,
    storage,
    notices,
    getEffectiveLayout,
  } = options;

  let visible: OutputVisible = loadOutputVisible(storage) ?? 'shown';
  let preferredWidth: number | null = loadOutputWidth(storage);
  let preferredConsoleHeight: number | null = loadConsoleHeight(storage);
  let visibleSaveWarned = false;
  let widthSaveWarned = false;
  let consoleHeightSaveWarned = false;
  let stdinPending = false;
  let currentWidth = 0;
  let currentMin = OUTPUT_WIDTH_MIN;
  let currentMax = OUTPUT_WIDTH_MIN;
  let currentConsoleHeight = 0;
  let currentConsoleMin = CONSOLE_HEIGHT_MIN;
  let currentConsoleMax = CONSOLE_HEIGHT_MIN;

  const isResizerActive = (): boolean =>
    visible === 'shown' &&
    getEffectiveLayout() === 'vertical' &&
    window.matchMedia(`(min-width: ${LAYOUT_MIN_WIDTH}px)`).matches;

  const isConsoleResizerActive = (): boolean =>
    visible === 'shown' && getEffectiveLayout() === 'horizontal';

  const applyVisibility = (next: OutputVisible, persist: boolean): void => {
    visible = next;
    if (next === 'hidden') document.documentElement.dataset.output = 'hidden';
    else delete document.documentElement.dataset.output;
    const hideStack = next === 'hidden';
    consolePane.hidden = hideStack;
    diagnosticsPane.hidden = hideStack;
    stdinPane.hidden = hideStack && !stdinPending;
    toggle.setAttribute('aria-expanded', String(next === 'shown'));
    if (persist && !saveOutputVisible(storage, next) && !visibleSaveWarned) {
      visibleSaveWarned = true;
      notices.show(OUTPUT_VISIBLE_SAVE_FAILED);
    }
  };

  const applyWidth = (width: number, persist: boolean): void => {
    const clamped = clampOutputWidth(width, { min: currentMin, max: currentMax });
    currentWidth = clamped;
    setSizedVar('--output-width', 'outputSized', clamped);
    setAriaRange(resizer, currentMin, currentMax, clamped);
    if (persist) {
      preferredWidth = clamped;
      if (!saveOutputWidth(storage, clamped) && !widthSaveWarned) {
        widthSaveWarned = true;
        notices.show(OUTPUT_WIDTH_SAVE_FAILED);
      }
    }
  };

  const applyConsoleHeight = (height: number, persist: boolean): void => {
    const clamped = clampOutputWidth(height, {
      min: currentConsoleMin,
      max: currentConsoleMax,
    });
    currentConsoleHeight = clamped;
    setSizedVar('--console-height', 'consoleSized', clamped);
    setAriaRange(consoleResizer, currentConsoleMin, currentConsoleMax, clamped);
    if (persist) {
      preferredConsoleHeight = clamped;
      if (!saveConsoleHeight(storage, clamped) && !consoleHeightSaveWarned) {
        consoleHeightSaveWarned = true;
        notices.show(CONSOLE_HEIGHT_SAVE_FAILED);
      }
    }
  };

  const measureContentWidth = (): number => {
    const style = getComputedStyle(app);
    const padStart = Number.parseFloat(style.paddingInlineStart || style.paddingLeft) || 0;
    const padEnd = Number.parseFloat(style.paddingInlineEnd || style.paddingRight) || 0;
    return Math.max(0, app.getBoundingClientRect().width - padStart - padEnd);
  };

  const measureOccupiedBeside = (): number => {
    const files = document.getElementById('file-pane');
    const symbols = document.getElementById('symbol-pane');
    const filesOpen = files !== null && !files.hidden;
    const symbolsOpen = symbols !== null && !symbols.hidden;
    const columns = 2 + (filesOpen ? 1 : 0) + (symbolsOpen ? 1 : 0);
    const gaps = Math.max(0, columns - 1) * OUTPUT_GAP;
    const filesWidth = filesOpen ? files.getBoundingClientRect().width : 0;
    const symbolsWidth = symbolsOpen ? symbols.getBoundingClientRect().width : 0;
    return filesWidth + symbolsWidth + gaps;
  };

  const syncResizer = (): void => {
    const active = isResizerActive();
    // FR-1305 / BR-1305: hidden + setInert; never the HTML `disabled` attribute.
    resizer.hidden = !active;
    setInert(resizer, !active);
    if (!active) return;

    currentMin = OUTPUT_WIDTH_MIN;
    currentMax = maxOutputWidth(measureContentWidth(), measureOccupiedBeside());
    if (currentMin > currentMax) currentMin = currentMax;

    if (preferredWidth === null) {
      // FR-1306: leave `--output-width` unset so CSS keeps the 58 % split.
      clearSizedVar('--output-width', 'outputSized');
      currentWidth = clampOutputWidth(Math.round(consolePane.getBoundingClientRect().width), {
        min: currentMin,
        max: currentMax,
      });
      setAriaRange(resizer, currentMin, currentMax, currentWidth);
      return;
    }
    // FR-1308: viewport / layout clamp updates memory + aria only — no storage rewrite.
    applyWidth(clampOutputWidth(preferredWidth, { min: currentMin, max: currentMax }), false);
  };

  const syncConsoleResizer = (): void => {
    const active = isConsoleResizerActive();
    consoleResizer.hidden = !active;
    setInert(consoleResizer, !active);
    if (!active) return;

    const editor = app.querySelector<HTMLElement>('.panel--editor');
    const consoleH = consolePane.getBoundingClientRect().height;
    const editorH = editor?.getBoundingClientRect().height ?? EDITOR_HEIGHT_MIN;
    currentConsoleMin = CONSOLE_HEIGHT_MIN;
    currentConsoleMax = maxConsoleHeight(consoleH, editorH);
    if (currentConsoleMin > currentConsoleMax) currentConsoleMin = currentConsoleMax;

    if (preferredConsoleHeight === null) {
      clearSizedVar('--console-height', 'consoleSized');
      currentConsoleHeight = clampOutputWidth(Math.round(consoleH), {
        min: currentConsoleMin,
        max: currentConsoleMax,
      });
      setAriaRange(consoleResizer, currentConsoleMin, currentConsoleMax, currentConsoleHeight);
      return;
    }
    applyConsoleHeight(
      clampOutputWidth(preferredConsoleHeight, {
        min: currentConsoleMin,
        max: currentConsoleMax,
      }),
      false,
    );
  };

  const sync = (): void => {
    applyVisibility(visible, false);
    if (stdinPending) app.dataset.stdin = 'pending';
    else delete app.dataset.stdin;
    syncResizer();
    syncConsoleResizer();
  };

  const bindDrag = (
    el: HTMLElement,
    axis: 'clientX' | 'clientY',
    sign: 1 | -1,
    isActive: () => boolean,
    apply: (n: number, persist: boolean) => void,
    current: () => number,
  ): void => {
    el.addEventListener('pointerdown', (event: PointerEvent) => {
      if (isInert(el) || !isActive()) return;
      event.preventDefault();
      const origin = event[axis];
      const start = current();
      el.setPointerCapture(event.pointerId);
      const onMove = (move: PointerEvent): void => {
        apply(start + sign * (move[axis] - origin), false);
      };
      const onEnd = (): void => {
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onEnd);
        el.removeEventListener('pointercancel', onEnd);
        apply(current(), true);
      };
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onEnd);
      el.addEventListener('pointercancel', onEnd);
    });
  };

  const bindKeys = (
    el: HTMLElement,
    grow: string,
    shrink: string,
    isActive: () => boolean,
    apply: (n: number, persist: boolean) => void,
    current: () => number,
    bounds: () => { min: number; max: number },
    preferred: () => number | null,
  ): void => {
    el.addEventListener('keydown', (event: KeyboardEvent) => {
      if (isInert(el) || !isActive()) return;
      if (event.key !== grow && event.key !== shrink) return;
      event.preventDefault();
      const step = event.shiftKey ? OUTPUT_WIDTH_STEP_LARGE : OUTPUT_WIDTH_STEP;
      const value = current();
      const next = clampOutputWidth(value + (event.key === grow ? step : -step), bounds());
      if (next === value && preferred() !== null) return;
      apply(next, true);
    });
  };

  toggle.addEventListener('click', () => {
    applyVisibility(visible === 'shown' ? 'hidden' : 'shown', true);
    syncResizer();
    syncConsoleResizer();
  });
  // Output is the inline-end column: dragging the start edge right shrinks it.
  bindDrag(resizer, 'clientX', -1, isResizerActive, applyWidth, () => currentWidth);
  bindKeys(
    resizer,
    'ArrowRight',
    'ArrowLeft',
    isResizerActive,
    applyWidth,
    () => currentWidth,
    () => ({ min: currentMin, max: currentMax }),
    () => preferredWidth,
  );
  // Bottom edge: dragging down grows the console.
  bindDrag(
    consoleResizer,
    'clientY',
    1,
    isConsoleResizerActive,
    applyConsoleHeight,
    () => currentConsoleHeight,
  );
  bindKeys(
    consoleResizer,
    'ArrowDown',
    'ArrowUp',
    isConsoleResizerActive,
    applyConsoleHeight,
    () => currentConsoleHeight,
    () => ({ min: currentConsoleMin, max: currentConsoleMax }),
    () => preferredConsoleHeight,
  );
  window.addEventListener('resize', sync);
  resizer.setAttribute('aria-label', OUTPUT_RESIZER_LABEL);
  consoleResizer.setAttribute('aria-label', CONSOLE_RESIZER_LABEL);

  sync();
  return {
    sync,
    setStdinPending(pending: boolean): void {
      stdinPending = pending;
      if (pending) {
        app.dataset.stdin = 'pending';
        stdinPane.hidden = false;
        return;
      }
      delete app.dataset.stdin;
      const active = document.activeElement;
      const focusWasInside = active instanceof Node && stdinPane.contains(active);
      stdinPane.hidden = visible === 'hidden';
      if (focusWasInside && visible === 'hidden') toggle.focus();
    },
  };
}
