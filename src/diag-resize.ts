/**
 * Diagnostics-panel height preference + resize controller (spec-09:
 * FR-903 – FR-912, FR-914, BR-902, BR-905, BR-906).
 *
 * Pure load/save/clamp/max stay free of the DOM. The mount helper wires
 * `#diag-resizer` (pointer + keyboard), applies `--diagnostics-height`, and
 * persists only on visitor commit — never on viewport/layout clamp alone.
 */

import { isInert, setInert } from './controls';
import { DIAG_HEIGHT_SAVE_FAILED } from './format';
import type { Layout } from './layout';
import { LAYOUT_MIN_WIDTH } from './layout';
import type { StorageLike } from './storage';

/** localStorage key holding the canonical height string (FR-909 – FR-911). */
export const DIAG_HEIGHT_KEY = 'pyplay.diagnostics-height.v1';

/** Keyboard step in CSS px (FR-905). */
export const DIAG_HEIGHT_STEP = 16;

/** Shift+arrow step in CSS px (FR-905). */
export const DIAG_HEIGHT_STEP_LARGE = 48;

/** Cap as a fraction of right-column height (FR-908 / FR-409). */
export const DIAG_HEIGHT_MAX_RATIO = 0.4;

/** Console content-box floor in CSS px (FR-908 / FR-409). */
export const DIAG_CONSOLE_MIN = 80;

/** Canonical height string: non-empty decimal integer, no sign/leading zero/units (FR-911). */
const CANONICAL_HEIGHT = /^[1-9][0-9]*$/;

/**
 * FR-911: true iff `raw` is exactly a canonical height string.
 */
export function isCanonicalDiagHeight(raw: string): boolean {
  return CANONICAL_HEIGHT.test(raw);
}

/**
 * FR-910 / FR-911: read the stored height. Missing key, throw, or non-canonical
 * value → null. Never writes — a non-canonical value is left in place until
 * the visitor next commits a resize (FR-911).
 */
export function loadDiagHeight(storage: StorageLike | null): number | null {
  if (!storage) return null;
  let value: string | null;
  try {
    value = storage.getItem(DIAG_HEIGHT_KEY);
  } catch {
    return null;
  }
  if (value === null || !isCanonicalDiagHeight(value)) return null;
  return Number(value);
}

/**
 * FR-909 / FR-912: persist height as a canonical integer string. Returns false
 * rather than throwing when storage is unavailable or the write is rejected.
 */
export function saveDiagHeight(storage: StorageLike | null, height: number): boolean {
  if (!storage) return false;
  const canonical = String(Math.trunc(height));
  if (!isCanonicalDiagHeight(canonical)) return false;
  try {
    storage.setItem(DIAG_HEIGHT_KEY, canonical);
    return true;
  } catch {
    return false;
  }
}

/**
 * Clamp a diagnostics height into the inclusive [min, max] band (FR-907 / FR-908).
 * Degenerate (min > max) viewports resolve to `max` via the nested min/max.
 */
export function clampDiagHeight(
  height: number,
  bounds: { min: number; max: number },
): number {
  return Math.min(bounds.max, Math.max(bounds.min, height));
}

/**
 * FR-908: the largest diagnostics height that still respects both caps —
 * ≤ 40 % of the right column, and console ≥ `consoleMin` (default
 * `DIAG_CONSOLE_MIN`). Whichever bound is hit first wins:
 *
 *   Math.max(0, Math.floor(Math.min(
 *     rightColumnHeight * DIAG_HEIGHT_MAX_RATIO,
 *     rightColumnHeight - (consoleMin ?? DIAG_CONSOLE_MIN),
 *   )))
 */
export function maxDiagHeight(
  rightColumnHeight: number,
  consoleMin: number = DIAG_CONSOLE_MIN,
): number {
  const byRatio = rightColumnHeight * DIAG_HEIGHT_MAX_RATIO;
  const byConsoleFloor = rightColumnHeight - consoleMin;
  return Math.max(0, Math.floor(Math.min(byRatio, byConsoleFloor)));
}

/**
 * FR-901 / FR-907: content-derived minimum matching the stacked (horizontal)
 * panel's natural empty height — Problems title row, title→body gap, one empty
 * / body line, and `.panel--diagnostics` padding (not a hard-coded px).
 */
export function minDiagHeightFromMeasurements(m: {
  titleHeight: number;
  titleMarginBottom: number;
  bodyHeight: number;
  panelPaddingTop: number;
  panelPaddingBottom: number;
}): number {
  return Math.max(
    1,
    Math.ceil(
      m.titleHeight +
        m.titleMarginBottom +
        m.bodyHeight +
        m.panelPaddingTop +
        m.panelPaddingBottom,
    ),
  );
}

/** Notice strip surface used for FR-912 (at most once per load). */
export interface DiagResizerNotices {
  show(text: string): void;
}

export interface DiagResizerOptions {
  app: HTMLElement;
  resizer: HTMLElement;
  diagnostics: HTMLElement;
  /** Console panel — top edge anchors the FR-409 / FR-908 right-column measure. */
  consolePanel: HTMLElement;
  storage: StorageLike | null;
  notices: DiagResizerNotices;
  /**
   * Effective layout after `resolveLayout` (same value written to
   * `#app[data-layout]`). Vertical + viewport ≥ 900 enables the separator.
   */
  getEffectiveLayout(): Layout;
}

export interface DiagResizerHandle {
  /** Re-measure bounds, refresh aria, clamp in memory without rewriting storage. */
  sync(): void;
}

/**
 * Mount pointer / keyboard resize for `#diag-resizer` (FR-903 – FR-912).
 * Call {@link DiagResizerHandle.sync} from layout render and after fonts are ready.
 */
export function mountDiagResizer(options: DiagResizerOptions): DiagResizerHandle {
  const { app, resizer, diagnostics, consolePanel, storage, notices, getEffectiveLayout } =
    options;

  // Preferred height the visitor last committed (or loaded). Null → FR-901 min.
  let preferredHeight: number | null = loadDiagHeight(storage);
  // FR-912: at most one persist-failure notice per page load.
  let saveWarned = false;
  let currentHeight = 0;
  let currentMin = 1;
  let currentMax = 1;

  const isVertical = (): boolean =>
    getEffectiveLayout() === 'vertical' &&
    window.matchMedia(`(min-width: ${LAYOUT_MIN_WIDTH}px)`).matches;

  const isActive = (): boolean =>
    // FR-1314: stacked layout also resizes Problems; vertical still needs ≥ 900.
    !consolePanel.hidden && (isVertical() || getEffectiveLayout() === 'horizontal');

  const clearHorizontalPlacement = (): void => {
    resizer.style.cssText = '';
  };

  const placeOnDiagnosticsTop = (): void => {
    const appRect = app.getBoundingClientRect();
    const diagRect = diagnostics.getBoundingClientRect();
    resizer.style.cssText =
      `position:absolute;left:${diagRect.left - appRect.left}px;` +
      `width:${diagRect.width}px;height:8px;` +
      `top:${diagRect.top - appRect.top - 4}px;z-index:2;margin:0`;
  };

  /**
   * Intrinsic height of the empty-state line. Stable whether findings are
   * showing (empty is `hidden`) or the body is flex-collapsed to 0 — matches
   * the stacked layout's content-sized empty panel (FR-901).
   */
  const measureBodyMin = (): number => {
    const empty = diagnostics.querySelector<HTMLElement>('.diagnostics-empty');
    if (!empty) return 0;
    const wasHidden = empty.hidden;
    empty.hidden = false;
    const height = empty.scrollHeight;
    empty.hidden = wasHidden;
    return height;
  };

  const measureMin = (): number => {
    const title = diagnostics.querySelector<HTMLElement>('.panel-title');
    const titleHeight = title?.getBoundingClientRect().height ?? 0;
    const titleStyle = title ? getComputedStyle(title) : null;
    const style = getComputedStyle(diagnostics);
    return minDiagHeightFromMeasurements({
      titleHeight,
      titleMarginBottom: Number.parseFloat(titleStyle?.marginBottom ?? '') || 0,
      bodyHeight: measureBodyMin(),
      panelPaddingTop: Number.parseFloat(style.paddingTop) || 0,
      panelPaddingBottom: Number.parseFloat(style.paddingBottom) || 0,
    });
  };

  /** FR-409 / FR-908: right column = console top → diagnostics bottom. */
  const measureRightColumnHeight = (): number => {
    const top = consolePanel.getBoundingClientRect().top;
    const bottom = diagnostics.getBoundingClientRect().bottom;
    return Math.max(0, bottom - top);
  };

  const applyHeight = (height: number, persist: boolean): void => {
    const clamped = clampDiagHeight(height, { min: currentMin, max: currentMax });
    currentHeight = clamped;
    // BR-902: only the diagnostics track; stdin stays content-sized.
    document.documentElement.style.setProperty('--diagnostics-height', `${clamped}px`);
    document.documentElement.dataset.diagSized = '';
    resizer.setAttribute('aria-valuemin', String(currentMin));
    resizer.setAttribute('aria-valuemax', String(currentMax));
    resizer.setAttribute('aria-valuenow', String(clamped));
    if (persist) {
      preferredHeight = clamped;
      // FR-912 / BR-906: keep in-memory height; notice at most once per load.
      if (!saveDiagHeight(storage, clamped) && !saveWarned) {
        saveWarned = true;
        notices.show(DIAG_HEIGHT_SAVE_FAILED);
      }
    }
    if (getEffectiveLayout() === 'horizontal' && isActive()) placeOnDiagnosticsTop();
  };

  const sync = (): void => {
    const active = isActive();
    // FR-906 / BR-905: hidden + setInert; never the HTML `disabled` attribute.
    resizer.hidden = !active;
    setInert(resizer, !active);
    if (!active) {
      clearHorizontalPlacement();
      return;
    }

    currentMin = measureMin();
    const stacked = getEffectiveLayout() === 'horizontal';
    if (stacked && preferredHeight === null) {
      // Keep spec-01's 25vh default until the visitor commits a resize.
      document.documentElement.style.removeProperty('--diagnostics-height');
      delete document.documentElement.dataset.diagSized;
      currentMax = maxDiagHeight(measureRightColumnHeight());
      if (currentMin > currentMax) currentMin = currentMax;
      currentHeight = clampDiagHeight(
        Math.round(diagnostics.getBoundingClientRect().height),
        { min: currentMin, max: currentMax },
      );
      resizer.setAttribute('aria-valuemin', String(currentMin));
      resizer.setAttribute('aria-valuemax', String(currentMax));
      resizer.setAttribute('aria-valuenow', String(currentHeight));
      placeOnDiagnosticsTop();
      return;
    }

    // Pin to the content floor before measuring the column so an oversize
    // bootstrap `--diagnostics-height` cannot inflate the FR-908 max (VC-908).
    document.documentElement.style.setProperty('--diagnostics-height', `${currentMin}px`);
    currentMax = maxDiagHeight(measureRightColumnHeight());
    const target =
      preferredHeight === null
        ? currentMin
        : clampDiagHeight(preferredHeight, { min: currentMin, max: currentMax });
    // FR-908: viewport / layout clamp updates memory + aria only — no storage rewrite.
    applyHeight(target, false);
    if (stacked) placeOnDiagnosticsTop();
    else clearHorizontalPlacement();
  };

  const startResize = (event: PointerEvent): void => {
    if (isInert(resizer) || !isActive()) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = currentHeight;
    resizer.setPointerCapture(event.pointerId);
    // FR-904: upward (clientY↓) grows diagnostics; downward shrinks.
    const onMove = (move: PointerEvent): void => {
      applyHeight(startHeight + (startY - move.clientY), false);
    };
    const onEnd = (): void => {
      resizer.removeEventListener('pointermove', onMove);
      resizer.removeEventListener('pointerup', onEnd);
      resizer.removeEventListener('pointercancel', onEnd);
      // FR-909: persist only on pointerup / cancel.
      applyHeight(currentHeight, true);
    };
    resizer.addEventListener('pointermove', onMove);
    resizer.addEventListener('pointerup', onEnd);
    resizer.addEventListener('pointercancel', onEnd);
  };

  const handleKey = (event: KeyboardEvent): void => {
    if (isInert(resizer) || !isActive()) return;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const step = event.shiftKey ? DIAG_HEIGHT_STEP_LARGE : DIAG_HEIGHT_STEP;
    // FR-905: ArrowUp grows; ArrowDown shrinks.
    const delta = event.key === 'ArrowUp' ? step : -step;
    const next = clampDiagHeight(currentHeight + delta, {
      min: currentMin,
      max: currentMax,
    });
    if (next === currentHeight) return;
    // FR-909: persist after each step that changes height.
    applyHeight(next, true);
  };

  resizer.addEventListener('pointerdown', startResize);
  resizer.addEventListener('keydown', handleKey);
  // FR-908: continuous viewport resize while staying vertical ≥ 900.
  window.addEventListener('resize', sync);
  // Re-measure once fonts settle so the content min matches paint (FR-901).
  void document.fonts.ready.then(() => {
    if (app.isConnected) sync();
  });

  sync();
  return { sync };
}
