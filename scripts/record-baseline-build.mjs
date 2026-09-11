/**
 * Record the shape and compressed size of a built `dist/`, so a later build
 * can be diffed against it (spec-03 NFR-305 / VC-326; spec-05 NFR-505 / VC-513).
 *
 * Usage:
 *   git worktree add ... <baseline commit>
 *   npm run build
 *   node scripts/record-baseline-build.mjs dist tests/e2e/baseline-build.json 8df7fa5
 *   # color-mode budget (NFR-505):
 *   node scripts/record-baseline-build.mjs dist tests/e2e/baseline-build-theme.json 0a4194f
 *
 * `scripts/record-baselines.mjs` drives this from a commit rather than from a
 * built `dist/`, and is what CI and CONTRIBUTING.md use; call this one
 * directly only when the build is already in front of you.
 *
 * `gzipSync` is only as reproducible as the zlib Node was linked against, and
 * the flavours disagree: Node 26 ships stock zlib on darwin and zlib-ng on
 * linux, which differ by ~152 KB over the vendored blobs and ~1.1 KB over the
 * app files, and even the two linux arches differ by 2 B. `perf.spec.ts`
 * therefore diffs the app files only, against the entry of `gzippedAppBy` that
 * names the compressor doing the comparing — so a record grows an entry per
 * environment it is recorded on, and covers none it has not seen.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';

const dist = process.argv[2];
const out = process.argv[3];
const commit = process.argv[4];

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

/**
 * VC-326 allows exactly two filenames to change: the main JS chunk and the
 * main CSS file, which Vite content-hashes. Every other emitted name —
 * including the worker chunk — must match literally.
 */
const unhash = (url) => url.replace(/^\/assets\/index-[A-Za-z0-9_-]+\.(js|css)$/, '/assets/index-HASH.$1');

const files = walk(dist).map((f) => `/${relative(dist, f)}`).sort();
const manifest = JSON.parse(readFileSync(join(dist, 'precache-manifest.json'), 'utf8'));

/** The vendored runtimes, whose bytes are pinned by digest rather than by size. */
const isVendored = (url) => url.startsWith('/pyodide/') || url.startsWith('/ruff/');

/**
 * NFR-305 measures the cold load: every precached URL, plus the shell. It is
 * split in two, because only the app half is a meaningful budget — see the
 * note above, and `perf.spec.ts`.
 */
let gzippedApp = 0;
let gzippedVendored = 0;
for (const url of [...manifest.urls, '/index.html']) {
  if (url === '/') continue; // the shell is counted once, as /index.html
  const gzipped = gzipSync(readFileSync(join(dist, url.replace(/^\//, ''))), { level: 9 }).length;
  if (isVendored(url)) gzippedVendored += gzipped;
  else gzippedApp += gzipped;
}

const digest = (path) => createHash('sha256').update(readFileSync(join(dist, path))).digest('hex');
const vendored = files.filter(isVendored);

const compressor = `${process.platform}-${process.arch} zlib ${process.versions.zlib}`;

/*
 * A committed record is read by whoever runs the suite, so it carries one app
 * size per compressor and re-recording it *adds* this run's entry rather than
 * replacing the others' — a record narrowed to one machine makes the budget
 * skip on every other. Entries for a different commit are dropped: they are
 * measurements of a different tree.
 */
let previous = {};
try {
  // Read first and judge what came back: an `existsSync` guard would be a
  // check on a name rather than on the bytes actually read (CWE-367).
  const recorded = JSON.parse(readFileSync(out, 'utf8'));
  if (recorded.commit === commit) previous = recorded;
} catch {
  // No record yet, or one this run cannot parse: start a fresh one.
}
const gzippedAppBy = { ...previous.gzippedAppBy, [compressor]: gzippedApp };

writeFileSync(
  out,
  `${JSON.stringify(
    {
      commit,
      files: files.map(unhash),
      manifestUrls: manifest.urls.map(unhash),
      manifestUrlCount: manifest.urls.length,
      cacheNameScheme: 'pyplay-assets-v${BUILD}',
      vendored: Object.fromEntries(vendored.map((f) => [f, digest(f.slice(1))])),
      gzippedApp,
      gzippedVendored,
      gzippedBy: compressor,
      gzippedAppBy,
    },
    null,
    2,
  )}\n`,
);
console.log(
  `recorded ${files.length} files: ${(gzippedApp / 1024).toFixed(2)} KiB app + ` +
    `${(gzippedVendored / 1024 / 1024).toFixed(2)} MiB vendored, gzipped by ${compressor}`,
);
