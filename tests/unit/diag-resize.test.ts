import { describe, expect, it } from 'vitest';
import {
  DIAG_CONSOLE_MIN,
  DIAG_HEIGHT_KEY,
  DIAG_HEIGHT_MAX_RATIO,
  DIAG_HEIGHT_STEP,
  DIAG_HEIGHT_STEP_LARGE,
  clampDiagHeight,
  isCanonicalDiagHeight,
  loadDiagHeight,
  maxDiagHeight,
  minDiagHeightFromMeasurements,
  saveDiagHeight,
} from '../../src/diag-resize';
import { DIAG_HEIGHT_SAVE_FAILED, DIAG_RESIZER_LABEL } from '../../src/format';
import type { StorageLike } from '../../src/storage';

type Recorder = StorageLike & { reads: string[]; writes: [string, string][] };

/** A store that records every call, so "rewrites nothing" is assertable. */
function recordingStorage(initial: Record<string, string> = {}): Recorder {
  const data = { ...initial };
  const reads: string[] = [];
  const writes: [string, string][] = [];
  return {
    reads,
    writes,
    getItem(key) {
      reads.push(key);
      return key in data ? data[key] : null;
    },
    setItem(key, value) {
      writes.push([key, value]);
      data[key] = value;
    },
  };
}

describe('Constants (Data & Interfaces / Constants)', () => {
  it('pins the key, steps, ratio and console floor the spec names', () => {
    expect(DIAG_HEIGHT_KEY).toBe('pyplay.diagnostics-height.v1');
    expect(DIAG_HEIGHT_STEP).toBe(16);
    expect(DIAG_HEIGHT_STEP_LARGE).toBe(48);
    expect(DIAG_HEIGHT_MAX_RATIO).toBe(0.4);
    expect(DIAG_CONSOLE_MIN).toBe(80);
  });
});

describe('User-visible strings (Data & Interfaces / User-visible strings)', () => {
  it('quotes the two diagnostics-resize strings verbatim from the spec', () => {
    expect(DIAG_RESIZER_LABEL).toBe('Resize diagnostics panel');
    expect(DIAG_HEIGHT_SAVE_FAILED).toBe("Diagnostics height won't be remembered");
  });
});

describe('isCanonicalDiagHeight (FR-911)', () => {
  for (const raw of ['1', '36', '100', '9999']) {
    it(`accepts canonical ${JSON.stringify(raw)}`, () => {
      expect(isCanonicalDiagHeight(raw)).toBe(true);
    });
  }

  // VC-909 non-canonical examples plus leading-zero / empty.
  const nonCanonical: [string, string][] = [
    ['empty string', ''],
    ['zero', '0'],
    ['leading zero', '036'],
    ['decimal', '12.5'],
    ['percent unit', '40%'],
    ['word', 'tall'],
    ['negative', '-1'],
    ['whitespace', ' 36'],
    ['trailing space', '36 '],
    ['plus sign', '+36'],
  ];

  for (const [label, raw] of nonCanonical) {
    it(`rejects ${label} (${JSON.stringify(raw)})`, () => {
      expect(isCanonicalDiagHeight(raw)).toBe(false);
    });
  }
});

describe('VC-909: loadDiagHeight (FR-911)', () => {
  const nonCanonical: [string, string][] = [
    ['an empty string', ''],
    ['zero', '0'],
    ['a leading zero', '036'],
    ['a decimal', '12.5'],
    ['a percent unit', '40%'],
    ['a word', 'tall'],
    ['a negative', '-1'],
  ];

  for (const [label, value] of nonCanonical) {
    it(`treats ${label} as absent and rewrites nothing`, () => {
      const store = recordingStorage({ [DIAG_HEIGHT_KEY]: value });
      expect(loadDiagHeight(store)).toBeNull();
      expect(store.writes).toEqual([]);
      expect(store.getItem(DIAG_HEIGHT_KEY)).toBe(value);
    });
  }

  it('treats an absent key as absent and rewrites nothing', () => {
    const store = recordingStorage();
    expect(loadDiagHeight(store)).toBeNull();
    expect(store.writes).toEqual([]);
  });

  it('treats a throwing read as absent and rewrites nothing', () => {
    const writes: [string, string][] = [];
    const store: StorageLike = {
      getItem() {
        throw new DOMException('blocked', 'SecurityError');
      },
      setItem(key, value) {
        writes.push([key, value]);
      },
    };
    expect(loadDiagHeight(store)).toBeNull();
    expect(writes).toEqual([]);
  });

  it('treats unavailable storage as absent', () => {
    expect(loadDiagHeight(null)).toBeNull();
  });

  it('returns the integer for a canonical height string', () => {
    const store = recordingStorage({ [DIAG_HEIGHT_KEY]: '36' });
    expect(loadDiagHeight(store)).toBe(36);
    expect(store.writes).toEqual([]);
  });

  it('reads only its own key', () => {
    const store = recordingStorage({ [DIAG_HEIGHT_KEY]: '40' });
    loadDiagHeight(store);
    expect(store.reads).toEqual([DIAG_HEIGHT_KEY]);
  });
});

describe('saveDiagHeight (FR-909, FR-912)', () => {
  it('writes the canonical integer string under pyplay.diagnostics-height.v1', () => {
    const store = recordingStorage();
    expect(saveDiagHeight(store, 36)).toBe(true);
    expect(store.writes).toEqual([[DIAG_HEIGHT_KEY, '36']]);
  });

  it('truncates toward zero before writing (canonical integer string)', () => {
    const store = recordingStorage();
    expect(saveDiagHeight(store, 36.9)).toBe(true);
    expect(store.writes).toEqual([[DIAG_HEIGHT_KEY, '36']]);
  });

  it('rejects non-positive heights without writing', () => {
    const store = recordingStorage();
    expect(saveDiagHeight(store, 0)).toBe(false);
    expect(saveDiagHeight(store, -1)).toBe(false);
    expect(store.writes).toEqual([]);
  });

  it('reports failure instead of throwing when the write is rejected', () => {
    const store: StorageLike = {
      getItem: () => null,
      setItem() {
        throw new DOMException('quota', 'QuotaExceededError');
      },
    };
    expect(() => saveDiagHeight(store, 40)).not.toThrow();
    expect(saveDiagHeight(store, 40)).toBe(false);
  });

  it('reports failure when storage is unavailable', () => {
    expect(saveDiagHeight(null, 40)).toBe(false);
  });
});

describe('clampDiagHeight (FR-907 / FR-908)', () => {
  it('returns height when already inside the band', () => {
    expect(clampDiagHeight(50, { min: 36, max: 200 })).toBe(50);
  });

  it('clamps below min up to min', () => {
    expect(clampDiagHeight(10, { min: 36, max: 200 })).toBe(36);
  });

  it('clamps above max down to max', () => {
    expect(clampDiagHeight(300, { min: 36, max: 200 })).toBe(200);
  });

  it('prefers max when the band is inverted', () => {
    expect(clampDiagHeight(50, { min: 100, max: 40 })).toBe(40);
  });
});

describe('maxDiagHeight (FR-908)', () => {
  it('is limited by the 40% ratio when that is tighter than the console floor', () => {
    // 1000 * 0.4 = 400; 1000 - 80 = 920 → 400
    expect(maxDiagHeight(1000)).toBe(400);
  });

  it('is limited by the console floor when that is tighter than the ratio', () => {
    // 150 * 0.4 = 60; 150 - 80 = 70 → 60 still wins; need a case where floor wins:
    // 180 * 0.4 = 72; 180 - 80 = 100 → 72 (ratio still tighter)
    // 100 * 0.4 = 40; 100 - 80 = 20 → 20 (console floor wins)
    expect(maxDiagHeight(100)).toBe(20);
  });

  it('honours an explicit consoleMin override', () => {
    // 200 * 0.4 = 80; 200 - 120 = 80 → 80
    expect(maxDiagHeight(200, 120)).toBe(80);
    // 200 * 0.4 = 80; 200 - 150 = 50 → 50
    expect(maxDiagHeight(200, 150)).toBe(50);
  });

  it('floors fractional results and never goes negative', () => {
    // 99 * 0.4 = 39.6; 99 - 80 = 19 → 19
    expect(maxDiagHeight(99)).toBe(19);
    // 50 * 0.4 = 20; 50 - 80 = -30 → 0
    expect(maxDiagHeight(50)).toBe(0);
  });
});

describe('minDiagHeightFromMeasurements (FR-901 / FR-907)', () => {
  it('sums title, gap, body line and panel padding, ceil, and never below 1', () => {
    expect(
      minDiagHeightFromMeasurements({
        titleHeight: 20,
        titleMarginBottom: 4,
        bodyHeight: 16,
        panelPaddingTop: 6,
        panelPaddingBottom: 6,
      }),
    ).toBe(52);
    expect(
      minDiagHeightFromMeasurements({
        titleHeight: 20.2,
        titleMarginBottom: 4,
        bodyHeight: 16.4,
        panelPaddingTop: 6.4,
        panelPaddingBottom: 6.1,
      }),
    ).toBe(54);
    expect(
      minDiagHeightFromMeasurements({
        titleHeight: 0,
        titleMarginBottom: 0,
        bodyHeight: 0,
        panelPaddingTop: 0,
        panelPaddingBottom: 0,
      }),
    ).toBe(1);
  });
});
