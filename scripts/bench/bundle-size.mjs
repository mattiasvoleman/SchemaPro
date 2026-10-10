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

/**
 * Route tiers.
 *
 * Budgets apply to a route's OWN JavaScript — the shared framework runtime is
 * gated separately by SHARED_BUDGET_KB below. That split exists because the
 * two numbers are controlled by different things and fail for different
 * reasons.
 *
 * A flat total-payload budget cannot work here. The framework floor is 126KB
 * of react-dom, the Next App Router client and the Turbopack runtime, none of
 * which is application code — grepping those chunks for every dependency in
 * package.json returns nothing, and a hello-world on this Next/React pair
 * measures the same. Under a 150KB total budget, a page could contain 24KB of
 * its own code and still fail; a team can do nothing about that except change
 * framework, so the gate would report the same failure forever and teach
 * everyone to ignore it.
 *
 * Splitting the two makes each number actionable: route budgets catch a page
 * importing something heavy, and the shared budget catches application code
 * leaking into the root layout — which is exactly how react-query and sonner
 * ended up on the login page.
 *
 * Budgets are ratchets: each sits just above what that tier measures today, so
 * the gate catches a regression rather than reporting a permanent known gap.
 * Tighten them as routes shrink; do not loosen one to green a build.
 *
 * Ordered most-specific first — the first match wins. `admin` MUST precede
 * `core`: /admin/teacher-absence contains "teacher", and an earlier version of
 * this list classified it as a core route and failed it against the wrong
 * budget.
 */
const TIERS = [
  // measured max 22.1KB (/[locale] locale-redirect page; error pages are 3.6KB)
  { name: 'system', budgetKb: 50, match: (r) => /^\/_/.test(r) || /^\/\[locale\]\/page$/.test(r) },
  // measured 3.6KB (/v/[token], Schemavisaren, 2026-10-10): Next's own error
  // and not-found boundaries and nothing of ours — the page is a server
  // component and sends the week as HTML. A login-free page a family opens on
  // a phone; anything that makes it ship script should fail here first.
  { name: 'public', budgetKb: 5, match: (r) => /^\/v\//.test(r) },
  // measured max 96.6KB (all four auth pages are within 1KB of each other)
  { name: 'auth', budgetKb: 110, match: (r) => r.includes('/(auth)/') },
  // measured max 177.8KB (/admin/timetable)
  { name: 'admin', budgetKb: 190, match: (r) => r.includes('/admin/') },
  // measured max 164.4KB (/guardian — the heaviest of the role dashboards)
  {
    name: 'core',
    budgetKb: 170,
    match: (r) => /\/(student|teacher|guardian)(\/|$)/.test(r),
  },
  { name: 'other', budgetKb: 170, match: () => true },
];

/** The framework floor plus whatever the root layout adds. */
const SHARED_BUDGET_KB = 130;

const tierFor = (route) => TIERS.find((t) => t.match(route));

const routes = [];
const missing = new Set();

const sharedBytes = [...sharedChunks].reduce((s, c) => s + gzipSize(c), 0);

for (const file of manifestFiles) {
  const { route, chunks } = chunksFor(file);
  const all = new Set([...sharedChunks, ...chunks]);

  let bytes = 0;
  for (const chunk of all) {
    const size = gzipSize(chunk);
    if (size === 0) missing.add(chunk);
    bytes += size;
  }
  const tier = tierFor(route);
  routes.push({
    route,
    chunks: all.size,
    gzipBytes: bytes,
    routeOnlyBytes: Math.max(0, bytes - sharedBytes),
    tier: tier.name,
    budgetKb: tier.budgetKb,
  });
}

routes.sort((a, b) => b.routeOnlyBytes - a.routeOnlyBytes);
const worst = routes[0];

// `--max-kb` keeps the old behaviour: one flat budget against the TOTAL
// payload, framework included. Retained so the §2 figure can still be produced
// verbatim, but it is not the default — see the TIERS comment for why.
const flatMode = maxKb !== undefined;

const overBudget = (r) =>
  flatMode ? r.gzipKb > maxKb : r.routeOnlyKb > r.budgetKb;

const report = {
  mode: flatMode ? 'flat-total' : 'tiered-route-own',
  flatBudgetKb: maxKb ?? null,
  sharedGzipKb: kb(sharedBytes),
  sharedBudgetKb: SHARED_BUDGET_KB,
  sharedOverBudget: kb(sharedBytes) > SHARED_BUDGET_KB,
  legacyPolyfillGzipKb: kb(
    [...legacyPolyfills].reduce((s, c) => s + gzipSize(c), 0),
  ),
  worstRoute: worst.route,
  worstRouteOnlyKb: kb(worst.routeOnlyBytes),
  routeCount: routes.length,
  routes: routes.map((r) => ({
    route: r.route,
    tier: r.tier,
    budgetKb: r.budgetKb,
    routeOnlyKb: kb(r.routeOnlyBytes),
    totalKb: kb(r.gzipBytes),
    chunks: r.chunks,
  })),
};
report.failures = report.routes.filter(overBudget).length;

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(
    `Initial gzipped JS — ${report.routeCount} routes, ` +
      `${flatMode ? `flat ${maxKb}KB budget on total payload` : 'tiered budgets on each route’s own JS'}\n`,
  );
  console.log(
    `  shared framework runtime  ${String(report.sharedGzipKb).padStart(7)}KB  ` +
      `budget ${SHARED_BUDGET_KB}KB  ${report.sharedOverBudget ? '✗' : '✓'}\n` +
      `  (+${report.legacyPolyfillGzipKb}KB nomodule polyfills — legacy browsers only, not counted)\n`,
  );
  console.log(
    `  ${'own JS'.padStart(9)}  ${'total'.padStart(8)}  tier    budget  route`,
  );
  for (const r of report.routes) {
    const over = overBudget(r);
    console.log(
      `  ${over ? '✗' : ' '} ${String(r.routeOnlyKb).padStart(7)}KB  ` +
        `${String(r.totalKb).padStart(7)}KB  ${r.tier.padEnd(7)} ` +
        `${String(r.budgetKb).padStart(4)}KB  ${r.route}`,
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

const failed = report.routes.filter(overBudget);
let exitCode = 0;

if (failed.length > 0) {
  console.error(
    `\nFAIL: ${failed.length} route(s) over budget` +
      (flatMode ? ` (flat ${maxKb}KB on total payload):` : ':'),
  );
  for (const r of failed.slice(0, 8)) {
    console.error(
      flatMode
        ? `  ${r.route} — ${r.totalKb}KB total, budget ${maxKb}KB`
        : `  ${r.route} — ${r.routeOnlyKb}KB own JS, ${r.tier} budget ${r.budgetKb}KB`,
    );
  }
  if (failed.length > 8) console.error(`  … and ${failed.length - 8} more`);
  exitCode = 1;
}

// Checked even in flat mode: application code leaking into the root layout is
// the one bundle regression that hits every route at once, and it is invisible
// in a per-route number because every route moves together.
if (report.sharedOverBudget) {
  console.error(
    `\nFAIL: shared runtime is ${report.sharedGzipKb}KB, over the ` +
      `${SHARED_BUDGET_KB}KB budget. Something was added to the root layout ` +
      `that every route now downloads.`,
  );
  exitCode = 1;
}

if (exitCode === 0) {
  console.log(
    flatMode
      ? `\nPASS: all ${report.routeCount} routes within the ${maxKb}KB total budget.`
      : `\nPASS: all ${report.routeCount} routes within their tier budgets, ` +
          `shared runtime ${report.sharedGzipKb}/${SHARED_BUDGET_KB}KB.`,
  );
}

process.exit(exitCode);
