#!/usr/bin/env node
/**
 * Initial-JS bundle-size gate for the web package.
 *
 * Engineering spec §2: "Bundle Size ≤ 150KB (initial Gzip JS)".
 *
 * Measures what a browser must download before a route is interactive, gzipped
 * at the level a CDN would serve. Two sources, both Next build output:
 *
 *   .next/build-manifest.json
 *       `rootMainFiles` + `polyfillFiles` — the framework runtime every route
 *       pays for regardless of which page is requested.
 *
 *   .next/server/app/**\/page_client-reference-manifest.js
 *       One per App Router route. Each assigns
 *       `globalThis.__RSC_MANIFEST["<route>"] = {...}` whose `clientModules`
 *       and `entryCSSFiles`/`entryJSFiles` name the chunks that route's client
 *       component tree needs.
 *
 * Note for Next upgrades: App Router + Turbopack does **not** emit
 * `app-build-manifest.json` (that is the webpack/Pages-Router file). If a future
 * version changes this layout the script fails loudly rather than reporting 0KB
 * — a silent pass here would be worse than no gate.
 *
 *   node scripts/bench/bundle-size.mjs                 # report every route
 *   node scripts/bench/bundle-size.mjs --max-kb 150    # exit 1 if over budget
 *   node scripts/bench/bundle-size.mjs --json
 *
 * Requires a completed `next build` in web/.
 */

import { gzipSync } from 'node:zlib';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const NEXT_DIR = join(REPO_ROOT, 'web', '.next');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const maxKb = flag('--max-kb') ? Number(flag('--max-kb')) : undefined;
const asJson = args.includes('--json');

function fail(message) {
  console.error(message);
  process.exit(2);
}

if (!existsSync(NEXT_DIR)) {
  fail(`No build found at ${NEXT_DIR}.\nRun \`npm run build --prefix web\` first.`);
}

// ---- Shared runtime -------------------------------------------------------

const buildManifestPath = join(NEXT_DIR, 'build-manifest.json');
if (!existsSync(buildManifestPath)) {
  fail(
    `${buildManifestPath} is missing. The Next.js build output format has ` +
      'changed — update this gate rather than skipping it.',
  );
}
const buildManifest = JSON.parse(readFileSync(buildManifestPath, 'utf8'));

const isJs = (asset) => typeof asset === 'string' && asset.endsWith('.js');

/** Normalises the two path spellings Next uses across manifests. */
const toAssetPath = (chunk) =>
  chunk.startsWith('/_next/') ? chunk.slice('/_next/'.length) : chunk;

/**
 * Chunks every route pays for — but NOT the polyfills.
 *
 * Next's App Router emits `polyfillFiles` with `noModule: true` (see
 * app-render.js), so any browser supporting ES modules — which is every
 * browser this app targets — skips them entirely. Counting them inflated every
 * route in this report by 38.6KB of code that modern users never download.
 *
 * They are still measured and reported separately, because the legacy payload
 * is real for the browsers that do fetch it; it just is not what the budget
 * is about.
 */
const sharedChunks = new Set(
  (buildManifest.rootMainFiles ?? []).filter(isJs).map(toAssetPath),
);

const legacyPolyfills = new Set(
  (buildManifest.polyfillFiles ?? []).filter(isJs).map(toAssetPath),
);

if (sharedChunks.size === 0) {
  fail(
    'build-manifest.json listed no rootMainFiles. Either the build is ' +
      'incomplete or the manifest shape changed.',
  );
}

// ---- Per-route client chunks ----------------------------------------------

function findManifests(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findManifests(full));
    else if (entry.name.endsWith('page_client-reference-manifest.js'))
      found.push(full);
  }
  return found;
}

const appDir = join(NEXT_DIR, 'server', 'app');
if (!existsSync(appDir)) {
  fail(`${appDir} is missing — this does not look like an App Router build.`);
}

const manifestFiles = findManifests(appDir);
if (manifestFiles.length === 0) {
  fail(
    `No page_client-reference-manifest.js under ${appDir}. The build output ` +
      'layout has changed — update this gate.',
  );
}

/**
 * Extracts every `static/chunks/*.js` path a route references. Reads the
 * manifest as text rather than executing it: it is generated code, and a size
 * gate has no business running the build output it measures.
 */
function chunksFor(file) {
  const source = readFileSync(file, 'utf8');

  const routeMatch = /__RSC_MANIFEST\[(?:"|')(.+?)(?:"|')\]/.exec(source);
  const route = routeMatch ? routeMatch[1] : relative(appDir, file);

  const chunks = new Set();
  for (const [, path] of source.matchAll(
    /(?:\/_next\/)?(static\/chunks\/[A-Za-z0-9._\-[\]()]+\.js)/g,
  )) {
    chunks.add(path);
  }
  return { route, chunks };
}

// ---- Sizing ---------------------------------------------------------------

const gzipCache = new Map();
function gzipSize(assetPath) {
  if (gzipCache.has(assetPath)) return gzipCache.get(assetPath);

  const full = join(NEXT_DIR, assetPath);
  let size = 0;
  if (existsSync(full) && statSync(full).isFile()) {
    // Level 9 approximates what a CDN serves; Brotli would be smaller still,
    // so this is a deliberately conservative reading of the budget.
    size = gzipSync(readFileSync(full), { level: 9 }).length;
  }
  gzipCache.set(assetPath, size);
  return size;
}

const kb = (bytes) => Math.round((bytes / 1024) * 10) / 10;

const routes = [];
const missing = new Set();

for (const file of manifestFiles) {
  const { route, chunks } = chunksFor(file);
  const all = new Set([...sharedChunks, ...chunks]);

  let bytes = 0;
  for (const chunk of all) {
    const size = gzipSize(chunk);
    if (size === 0) missing.add(chunk);
    bytes += size;
  }
  routes.push({ route, chunks: all.size, gzipBytes: bytes });
}

routes.sort((a, b) => b.gzipBytes - a.gzipBytes);
const worst = routes[0];

const report = {
  budgetKb: maxKb ?? null,
  worstRoute: worst.route,
  worstGzipKb: kb(worst.gzipBytes),
  sharedGzipKb: kb([...sharedChunks].reduce((s, c) => s + gzipSize(c), 0)),
  legacyPolyfillGzipKb: kb(
    [...legacyPolyfills].reduce((s, c) => s + gzipSize(c), 0),
  ),
  routeCount: routes.length,
  routes: routes.map((r) => ({
    route: r.route,
    gzipKb: kb(r.gzipBytes),
    chunks: r.chunks,
  })),
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(
    `Initial gzipped JS per route ` +
      `(${report.routeCount} routes, shared runtime ${report.sharedGzipKb}KB; ` +
        `+${report.legacyPolyfillGzipKb}KB nomodule polyfills, legacy browsers only)\n`,
  );
  for (const r of report.routes) {
    const over = maxKb !== undefined && r.gzipKb > maxKb;
    console.log(
      `  ${over ? '✗' : ' '} ${String(r.gzipKb).padStart(7)}KB  ` +
        `${String(r.chunks).padStart(3)} chunks  ${r.route}`,
    );
  }
}

// A chunk named by a manifest but absent from disk means the measurement is
// incomplete — report it rather than quietly undercounting.
if (missing.size > 0) {
  console.error(
    `\nWARNING: ${missing.size} referenced chunk(s) not found on disk and ` +
      `counted as 0 bytes:\n  ${[...missing].slice(0, 5).join('\n  ')}`,
  );
}

if (maxKb !== undefined) {
  if (worst.gzipBytes / 1024 > maxKb) {
    console.error(
      `\nFAIL: ${worst.route} ships ${report.worstGzipKb}KB of initial ` +
        `gzipped JS, over the ${maxKb}KB budget.`,
    );
    process.exit(1);
  }
  console.log(
    `\nPASS: worst route ${worst.route} at ${report.worstGzipKb}KB ` +
      `is within the ${maxKb}KB budget.`,
  );
}
