import { describe, expect, it } from 'vitest';
import {
  CONSOLE_HEIGHT_KEY,
  CONSOLE_HEIGHT_MIN,
  EDITOR_HEIGHT_MIN,
  OUTPUT_EDITOR_MIN,
  OUTPUT_GAP,
  OUTPUT_VISIBLE_KEY,
  OUTPUT_WIDTH_KEY,
  OUTPUT_WIDTH_MIN,
  OUTPUT_WIDTH_STEP,
  OUTPUT_WIDTH_STEP_LARGE,
  loadConsoleHeight,
  maxConsoleHeight,
  saveConsoleHeight,
  clampOutputWidth,
  isCanonicalOutputVisible,
  isCanonicalOutputWidth,
  loadOutputVisible,
  loadOutputWidth,
  maxOutputWidth,
  saveOutputVisible,
  saveOutputWidth,
} from '../../src/output-pane';
import {
  OUTPUT_LABEL,
  OUTPUT_RESIZER_LABEL,
  OUTPUT_VISIBLE_SAVE_FAILED,
  OUTPUT_WIDTH_SAVE_FAILED,
} from '../../src/format';
import type { StorageLike } from '../../src/storage';

type Recorder = StorageLike & { reads: string[]; writes: [string, string][] };

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

describe('Constants (spec-13)', () => {
  it('pins the keys, steps, floors and gap the spec names', () => {
    expect(OUTPUT_VISIBLE_KEY).toBe('pyplay.output-visible.v1');
    expect(OUTPUT_WIDTH_KEY).toBe('pyplay.output-width.v1');
    expect(OUTPUT_WIDTH_STEP).toBe(16);
    expect(OUTPUT_WIDTH_STEP_LARGE).toBe(48);
    expect(OUTPUT_WIDTH_MIN).toBe(240);
    expect(OUTPUT_EDITOR_MIN).toBe(320);
    expect(OUTPUT_GAP).toBe(8);
    expect(CONSOLE_HEIGHT_KEY).toBe('pyplay.console-height.v1');
    expect(CONSOLE_HEIGHT_MIN).toBe(80);
    expect(EDITOR_HEIGHT_MIN).toBe(120);
  });
});

describe('User-visible strings (spec-13)', () => {
  it('quotes the four Output strings verbatim from the spec', () => {
    expect(OUTPUT_LABEL).toBe('Output');
    expect(OUTPUT_RESIZER_LABEL).toBe('Resize output pane');
    expect(OUTPUT_VISIBLE_SAVE_FAILED).toBe("Output layout won't be remembered");
    expect(OUTPUT_WIDTH_SAVE_FAILED).toBe("Output width won't be remembered");
  });
});

describe('isCanonicalOutputVisible (FR-1309)', () => {
  for (const raw of ['shown', 'hidden'] as const) {
    it(`accepts ${raw}`, () => {
      expect(isCanonicalOutputVisible(raw)).toBe(true);
    });
  }
  for (const raw of ['', 'Shown', ' hidden', 'true', '0', 'false']) {
    it(`rejects ${JSON.stringify(raw)}`, () => {
      expect(isCanonicalOutputVisible(raw)).toBe(false);
    });
  }
});

describe('isCanonicalOutputWidth (FR-1310)', () => {
  for (const raw of ['1', '240', '400', '9999']) {
    it(`accepts canonical ${JSON.stringify(raw)}`, () => {
      expect(isCanonicalOutputWidth(raw)).toBe(true);
    });
  }
  for (const raw of ['', '0', '036', '12.5', '240px', '240 ', '-1', '1e2']) {
    it(`rejects ${JSON.stringify(raw)}`, () => {
      expect(isCanonicalOutputWidth(raw)).toBe(false);
    });
  }
});

describe('loadOutputVisible (FR-1309)', () => {
  it('returns shown/hidden and does not write', () => {
    const shown = recordingStorage({ [OUTPUT_VISIBLE_KEY]: 'shown' });
    expect(loadOutputVisible(shown)).toBe('shown');
    expect(shown.writes).toEqual([]);
    const hidden = recordingStorage({ [OUTPUT_VISIBLE_KEY]: 'hidden' });
    expect(loadOutputVisible(hidden)).toBe('hidden');
  });

  it('returns null for missing, junk, throw, or null store, and never writes', () => {
    const missing = recordingStorage();
    expect(loadOutputVisible(missing)).toBeNull();
    expect(missing.writes).toEqual([]);
    const junk = recordingStorage({ [OUTPUT_VISIBLE_KEY]: 'true' });
    expect(loadOutputVisible(junk)).toBeNull();
    expect(junk.writes).toEqual([]);
    expect(loadOutputVisible(null)).toBeNull();
    const throwing: StorageLike = {
      getItem() {
        throw new Error('denied');
      },
      setItem() {
        throw new Error('denied');
      },
    };
    expect(loadOutputVisible(throwing)).toBeNull();
  });
});

describe('saveOutputVisible (FR-1309)', () => {
  it('writes the bare canonical string', () => {
    const store = recordingStorage();
    expect(saveOutputVisible(store, 'hidden')).toBe(true);
    expect(store.writes).toEqual([[OUTPUT_VISIBLE_KEY, 'hidden']]);
  });

  it('returns false when storage is missing or setItem throws', () => {
    expect(saveOutputVisible(null, 'shown')).toBe(false);
    const throwing: StorageLike = {
      getItem() {
        return null;
      },
      setItem() {
        throw new Error('quota');
      },
    };
    expect(saveOutputVisible(throwing, 'hidden')).toBe(false);
  });
});

describe('loadOutputWidth / saveOutputWidth (FR-1310)', () => {
  it('round-trips a canonical integer and does not rewrite junk', () => {
    const store = recordingStorage({ [OUTPUT_WIDTH_KEY]: '400' });
    expect(loadOutputWidth(store)).toBe(400);
    expect(store.writes).toEqual([]);
  });

  it('returns null for missing or non-canonical values without writing', () => {
    const junk = recordingStorage({ [OUTPUT_WIDTH_KEY]: '036' });
    expect(loadOutputWidth(junk)).toBeNull();
    expect(junk.writes).toEqual([]);
    expect(loadOutputWidth(null)).toBeNull();
  });

  it('writes a truncated canonical integer', () => {
    const store = recordingStorage();
    expect(saveOutputWidth(store, 401.9)).toBe(true);
    expect(store.writes).toEqual([[OUTPUT_WIDTH_KEY, '401']]);
  });

  it('rejects a non-canonical truncation (0) without writing', () => {
    const store = recordingStorage();
    expect(saveOutputWidth(store, 0)).toBe(false);
    expect(store.writes).toEqual([]);
  });
});

describe('clampOutputWidth / maxOutputWidth (FR-1308)', () => {
  it('clamps into [min, max] and degenerates to max', () => {
    expect(clampOutputWidth(200, { min: 240, max: 800 })).toBe(240);
    expect(clampOutputWidth(900, { min: 240, max: 800 })).toBe(800);
    expect(clampOutputWidth(400, { min: 240, max: 800 })).toBe(400);
    expect(clampOutputWidth(100, { min: 500, max: 400 })).toBe(400);
  });
});

describe('console height (FR-1314 / FR-1315)', () => {
  it('round-trips a canonical integer', () => {
    const store = recordingStorage();
    expect(saveConsoleHeight(store, 160.9)).toBe(true);
    expect(loadConsoleHeight(store)).toBe(160);
  });

  it('max console height leaves the editor floor', () => {
    expect(maxConsoleHeight(200, 400, 120)).toBe(480);
  });
});

describe('clampOutputWidth / maxOutputWidth (FR-1308)', () => {
  it('subtracts occupied-beside and the editor floor', () => {
    // 1264 content, no files/symbols, one 8 px gap, editor 320 → max 936.
    expect(maxOutputWidth(1264, OUTPUT_GAP)).toBe(1264 - 8 - 320);
    expect(maxOutputWidth(900, 260 + 72 + 24)).toBe(
      Math.max(0, Math.floor(900 - (260 + 72 + 24) - 320)),
    );
  });
});
