/** Exact user-visible strings and their formatting (spec: Functional Requirements). */

const two = (n: number): string => String(n).padStart(2, '0');

/**
 * `─── Running filename.py at HH:MM:SS ───`, 24-hour clock, visitor's local time zone.
 */
export function formatRunSeparator(filename: string, at: Date): string {
  return `─── Running ${filename} at ${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())} ───`;
}

/** Labels shared by the dynamic Run control and the Files execution state. */
export const RUN_LABEL = 'Run';
export const RUNNING_LABEL = 'Running';
export const LAST_RUN_LABEL = 'Last run';
export const RUN_PYTHON_FILE_LABEL = 'Python file';

/** FR-022: `Program finished in N.NN s`, wall-clock seconds to two decimals. */
export function formatFinished(durationMs: number): string {
  return `Program finished in ${(Math.max(0, durationMs) / 1000).toFixed(2)} s`;
}

/** FR-013: single ready line naming the Python version. */
export function formatReady(pythonVersion: string): string {
  return `Python ${pythonVersion} ready`;
}

/** FR-012 / FR-065: `Loading Python… N%` with an integer percentage. */
export function formatLoading(percent: number): string {
  const clamped = Math.min(100, Math.max(0, Math.round(percent)));
  return `Loading Python… ${clamped}%`;
}

/** FR-023: the visitor killed the run. */
export const PROGRAM_STOPPED = 'Program stopped.';

/** FR-021 */
export const PROGRAM_ERRORED = 'Program exited with an error.';

/** FR-014 */
export const RUNTIME_FAILED = 'Python runtime failed to load. Check your connection and reload the page.';

/** FR-015 */
export const NOT_ISOLATED_BANNER =
  'This page must be served with cross-origin isolation enabled (see Deployment). Python cannot run here.';

/** FR-020: literal prefix rendered immediately before each stderr chunk. */
export const STDERR_PREFIX = '[stderr] ';

/** FR-065 status-indicator texts. */
export const STATUS_PYTHON_UNAVAILABLE = 'Python unavailable';
export const STATUS_CACHING = 'Caching for offline…';
export const STATUS_OFFLINE_READY = 'Offline ready';
export const STATUS_OFFLINE_UNAVAILABLE = 'Offline unavailable';
export const STATUS_RESTARTING = 'Restarting Python…';

/** FR-053: a newer deployment's worker has installed and is waiting. */
export const UPDATE_AVAILABLE = 'A new version is available — reload to update';

/**
 * FR-006 / FR-307: how long `Copied` feedback stays on screen. One constant,
 * shared by **Copy code** and the special-character pane, so the two windows
 * cannot drift apart (spec-03: User-visible strings).
 */
export const COPIED_MS = 2000;

/** FR-301: the pane's toolbar toggle. */
export const SYMBOLS_LABEL = 'Symbols';

/** FR-307: the pane's `role="status"` confirmation. */
export function formatSymbolCopied(value: string): string {
  return `Copied ${value}`;
}

/** FR-308: the notice shown when the pane's clipboard write is rejected. */
export const SYMBOL_COPY_FAILED = "Couldn't copy — select the character and press Ctrl/Cmd+C";

/** FR-401: the layout control's accessible name and its two radio labels. */
export const LAYOUT_LABEL = 'Layout';
export const LAYOUT_VERTICAL = 'Vertical';
export const LAYOUT_HORIZONTAL = 'Horizontal';

/** FR-406: why the two-column `vertical` layout is unavailable below 900 px. */
export const LAYOUT_NARROW_HINT = 'Vertical layout needs a window at least 900 px wide';

/** FR-418: the preference write was rejected. */
export const LAYOUT_SAVE_FAILED = "Layout preference won't be remembered";

/** FR-903: `#diag-resizer` accessible name. */
export const DIAG_RESIZER_LABEL = 'Resize diagnostics panel';

/** FR-912: the height preference write was rejected. */
export const DIAG_HEIGHT_SAVE_FAILED = "Diagnostics height won't be remembered";

/** Mode table labels (FR-504): tooltip and accessible-name suffix. */
export const THEME_LABELS = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
} as const;

/**
 * Mode table glyphs (FR-503): U+2600 sun, U+263D first quarter moon, Latin `S`.
 */
export const THEME_GLYPHS = {
  light: '\u2600',
  dark: '\u263D',
  system: 'S',
} as const;

/** FR-504: accessible name `Color mode: <label>`. */
export function formatThemeAccessibleName(label: string): string {
  return `Color mode: ${label}`;
}

/* --- About control (spec 08-about-button; BR-807) --- */

/** FR-803: visible glyph of `#btn-about` (U+0069). */
export const ABOUT_GLYPH = 'i';

/** FR-804 / FR-805: control tooltip, accessible name, and dialog heading. */
export const ABOUT_LABEL = 'About';

/** FR-805: dialog field labels, in display order. */
export const ABOUT_VERSION_LABEL = 'Version';
export const ABOUT_BRANCH_LABEL = 'Branch';
export const ABOUT_COMMIT_LABEL = 'Commit';
export const ABOUT_BUILT_LABEL = 'Built';

/** FR-807: Close control visible label and accessible name. */
export const ABOUT_CLOSE_LABEL = 'Close';

/** BR-802: per-field fallback when build-time input is missing. */
export const UNKNOWN = 'unknown';
