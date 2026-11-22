/**
 * The bundle gate's margin warning: the arithmetic in bundle-margin.mjs, and
 * the script itself against a made-up `.next` so that what matters most is
 * proven and not asserted — a warning never changes the exit code, and a
 * failing budget is still a failure.
 *
 *   node --test scripts/bench/bundle-margin.test.mjs
 *
 * No build and no dependencies: the fixture is a directory of random bytes
 * whose gzipped sizes the test measures itself.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
  WARN_MARGIN_BYTES,
  annotationOf,
  describe,
  marginOf,
  marginsOf,
  summaryOf,
  warningsOf,
} from './bundle-margin.mjs';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'bundle-size.mjs');
const ADMIN_CAP = 190 * 1024; // 194 560
const SHARED_CAP = 132 * 1024; // 135 168, raised from 130 KB on 2026-11-22

// ---- the arithmetic --------------------------------------------------------

// The numbers of main on 2026-11-21 (design note m6-design.md), before the
// Storage stub: the three routes the phase is about, and the shared runtime.
const MAIN = {
  sharedBytes: 131780,
  sharedBudgetKb: 130,
  routes: [
    { route: '/[locale]/(app)/admin/timetable/page', tier: 'admin', budgetKb: 190, routeOnlyBytes: 193100 },
    { route: '/[locale]/(app)/admin/people/page', tier: 'admin', budgetKb: 190, routeOnlyBytes: 192679 },
    { route: '/[locale]/(app)/admin/requirements/page', tier: 'admin', budgetKb: 190, routeOnlyBytes: 189200 },
  ],
};

test('margin is the nominal budget in bytes minus the measured bytes', () => {
  assert.equal(marginOf(193100, 190), 1460);
  assert.equal(marginOf(131780, 130), 1340);
  assert.equal(marginOf(194560, 190), 0);
  assert.equal(marginOf(194590, 190), -30);
});

test('rows come tightest first, the shared runtime among the routes', () => {
  const rows = marginsOf(MAIN);
  assert.deepEqual(
    rows.map((row) => [row.scope, row.marginBytes]),
    [
      ['shared runtime', 1340],
      ['/[locale]/(app)/admin/timetable/page', 1460],
      ['/[locale]/(app)/admin/people/page', 1881],
      ['/[locale]/(app)/admin/requirements/page', 5360],
    ],
  );
});

test('under 2 048 B warns, exactly 2 048 B does not, and the default is 2 KB', () => {
  assert.equal(WARN_MARGIN_BYTES, 2048);
  const at = (margin) =>
    warningsOf(
      marginsOf({
        sharedBytes: 1,
        sharedBudgetKb: 130,
        routes: [{ route: '/r/admin/x', tier: 'admin', budgetKb: 190, routeOnlyBytes: ADMIN_CAP - margin }],
      }),
    ).map((row) => row.scope);
  assert.deepEqual(at(2047), ['/r/admin/x']);
  assert.deepEqual(at(2048), []);
  assert.deepEqual(at(0), ['/r/admin/x']);
});

test('on main on 2026-11-21 the shared runtime, timetable and people warn and requirements does not', () => {
  assert.deepEqual(
    warningsOf(marginsOf(MAIN)).map((row) => row.scope),
    ['shared runtime', '/[locale]/(app)/admin/timetable/page', '/[locale]/(app)/admin/people/page'],
  );
});

test('a budget the gate already fails is not warned about a second time', () => {
  const rows = marginsOf({
    sharedBytes: SHARED_CAP + 500,
    sharedBudgetKb: 130,
    sharedFailing: true,
    routes: [{ route: '/r/admin/x', tier: 'admin', budgetKb: 190, routeOnlyBytes: ADMIN_CAP + 5000, failing: true }],
  });
  assert.deepEqual(warningsOf(rows), []);
});

test('a route inside the gate\'s 0.1 KB rounding is said to be over the nominal budget, not to have room', () => {
  const [row] = marginsOf({
    sharedBytes: 1,
    sharedBudgetKb: 130,
    routes: [{ route: '/r/admin/x', tier: 'admin', budgetKb: 190, routeOnlyBytes: ADMIN_CAP + 30 }],
  }).filter((r) => r.kind === 'route');
  assert.equal(row.marginBytes, -30);
  assert.match(describe(row), /30 B over 194 560 B \(inside the gate's 0\.1 KB rounding, so it still passes\)/);
});

test('describe names the room in bytes, the tier and the budget', () => {
  const [shared] = marginsOf(MAIN);
  assert.equal(describe(shared), 'the shared runtime — 1 340 B left of 133 120 B (shared, 130 KB)');
  const timetable = marginsOf(MAIN)[1];
  assert.equal(
    describe(timetable),
    '/[locale]/(app)/admin/timetable/page — 1 460 B left of 194 560 B (admin, 190 KB)',
  );
});

test('a GitHub annotation is one line, escaped as workflow commands require', () => {
  const [shared] = marginsOf(MAIN);
  const line = annotationOf(shared);
  assert.match(line, /^::warning title=Bundle margin under 2 KB::the shared runtime — 1 340 B left/);
  assert.equal(line.includes('\n'), false);
  const odd = annotationOf({ ...shared, scope: '100% a\nb', kind: 'route' });
  assert.match(odd, /100%25 a%0Ab/);
});

test('the step summary is a markdown table of the tightest rows', () => {
  const summary = summaryOf(marginsOf(MAIN), 2);
  assert.match(summary, /^### Bundle margins/);
  assert.match(summary, /\| shared runtime \| shared \| 130 KB \| 131 780 \| 1 340 \|/);
  assert.match(summary, /\| `\/\[locale\]\/\(app\)\/admin\/timetable\/page` \| admin \| 190 KB \| 193 100 \| 1 460 \|/);
  assert.equal(summary.includes('people'), false, 'only the two tightest rows');
});

// ---- the script, on a made-up build ---------------------------------------

/** Deterministic random bytes: they do not compress, so gzip is about as large as they are. */
function noise(length, seed) {
  const bytes = Buffer.alloc(length);
  let a = seed >>> 0;
  for (let i = 0; i < length; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    bytes[i] = ((t ^ (t >>> 14)) >>> 0) & 0xff;
  }
  return bytes;
}

/** A chunk whose gzip (level 9, as the gate reads it) is `target` bytes, give or take a few. */
function chunkOfGzipSize(target, seed) {
  let length = target;
  for (let i = 0; i < 12; i++) {
    const bytes = noise(length, seed);
    const size = gzipSync(bytes, { level: 9 }).length;
    if (size === target) return { bytes, size };
    length += target - size;
  }
  const bytes = noise(length, seed);
  return { bytes, size: gzipSync(bytes, { level: 9 }).length };
}

/**
 * A `.next` with a shared chunk and one admin route; returns the directory,
 * plus the sizes the gate will read (it counts the route's chunks minus the
 * shared ones, both gzipped).
 */
function fixture({ sharedLeft = 20000, routeLeft = 20000, publicBytes = null }) {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-margin-'));
  const next = join(dir, '.next');
  mkdirSync(join(next, 'static', 'chunks'), { recursive: true });
  const manifestDir = join(next, 'server', 'app', '[locale]', '(app)', 'admin', 'x');
  mkdirSync(manifestDir, { recursive: true });

  const shared = chunkOfGzipSize(SHARED_CAP - sharedLeft, 1);
  const own = chunkOfGzipSize(ADMIN_CAP - routeLeft, 2);
  writeFileSync(join(next, 'static', 'chunks', 'shared.js'), shared.bytes);
  writeFileSync(join(next, 'static', 'chunks', 'route.js'), own.bytes);
  writeFileSync(
    join(next, 'build-manifest.json'),
    JSON.stringify({ rootMainFiles: ['static/chunks/shared.js'], polyfillFiles: [] }),
  );
  writeFileSync(
    join(manifestDir, 'page_client-reference-manifest.js'),
    `globalThis.__RSC_MANIFEST = globalThis.__RSC_MANIFEST || {};\n` +
      `globalThis.__RSC_MANIFEST["/[locale]/(app)/admin/x/page"] = ` +
      `{"entryJSFiles":{"/x":["static/chunks/shared.js","static/chunks/route.js"]}};\n`,
  );
  if (publicBytes !== null) {
    // A page of the public tier (/v/…): Next's own boundaries, nothing else.
    const pub = chunkOfGzipSize(publicBytes, 3);
    writeFileSync(join(next, 'static', 'chunks', 'pub.js'), pub.bytes);
    const pubDir = join(next, 'server', 'app', 'v', '[token]');
    mkdirSync(pubDir, { recursive: true });
    writeFileSync(
      join(pubDir, 'page_client-reference-manifest.js'),
      `globalThis.__RSC_MANIFEST = globalThis.__RSC_MANIFEST || {};\n` +
        `globalThis.__RSC_MANIFEST["/v/[token]/page"] = ` +
        `{"entryJSFiles":{"/v":["static/chunks/shared.js","static/chunks/pub.js"]}};\n`,
    );
  }
  return {
    dir: next,
    sharedLeft: SHARED_CAP - shared.size,
    routeLeft: ADMIN_CAP - own.size,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function gate(nextDir, extra = [], env = {}) {
  const clean = { ...process.env };
  delete clean.GITHUB_ACTIONS;
  delete clean.GITHUB_STEP_SUMMARY;
  const run = spawnSync(process.execPath, [SCRIPT, '--next-dir', nextDir, ...extra], {
    encoding: 'utf8',
    env: { ...clean, ...env },
  });
  return { code: run.status, out: run.stdout, err: run.stderr };
}

test('a route with 1 500 B left warns, names the bytes, and still exits 0', () => {
  const f = fixture({ routeLeft: 1500 });
  try {
    const run = gate(f.dir);
    assert.equal(run.code, 0, run.err);
    assert.match(run.err, new RegExp(`WARNING: /\\[locale\\]/\\(app\\)/admin/x/page — ${String(f.routeLeft).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} B left`));
    assert.match(run.err, /1 budget\(s\) with under 2048 B left\. Not a failure/);
    assert.match(run.out, /^PASS: /m);
    assert.match(run.out, /Tightest margins/);
  } finally {
    f.cleanup();
  }
});

test('the shared runtime with 1 340 B left warns the same way', () => {
  const f = fixture({ sharedLeft: 1340 });
  try {
    const run = gate(f.dir);
    assert.equal(run.code, 0, run.err);
    assert.match(run.err, /WARNING: the shared runtime — 1 3\d\d B left of 135 168 B/);
    assert.equal((run.err.match(/WARNING:/g) ?? []).length, 1);
  } finally {
    f.cleanup();
  }
});

test('room to spare is not warned about, but is still printed', () => {
  const f = fixture({ routeLeft: 10000, sharedLeft: 10000 });
  try {
    const run = gate(f.dir);
    assert.equal(run.code, 0, run.err);
    assert.doesNotMatch(run.err, /WARNING/);
    assert.match(run.out, /Tightest margins[\s\S]*B {2}shared runtime/);
  } finally {
    f.cleanup();
  }
});

test('over the budget is still a failure, reported once and not also as a warning', () => {
  const f = fixture({ routeLeft: -3000 });
  try {
    const run = gate(f.dir);
    assert.equal(run.code, 1, 'exit code unchanged: 1 for a route over budget');
    assert.match(run.err, /FAIL: 1 route\(s\) over budget/);
    assert.doesNotMatch(run.err, /WARNING/);
  } finally {
    f.cleanup();
  }
});

test('--warn-bytes moves the threshold and 0 turns the warning off', () => {
  const f = fixture({ routeLeft: 1500 });
  try {
    assert.match(gate(f.dir, ['--warn-bytes', '1000']).err, /^(?![\s\S]*WARNING)/);
    assert.match(gate(f.dir, ['--warn-bytes', '4096']).err, /WARNING/);
    const off = gate(f.dir, ['--warn-bytes', '0']);
    assert.equal(off.code, 0);
    assert.doesNotMatch(off.err, /WARNING/);
    const bad = gate(f.dir, ['--warn-bytes', 'lots']);
    assert.equal(bad.code, 2);
    assert.match(bad.err, /--warn-bytes needs a number of bytes/);
  } finally {
    f.cleanup();
  }
});

test('--json carries the margins and the near-budget rows, and stdout is the report and nothing else', () => {
  const f = fixture({ routeLeft: 1500, sharedLeft: 9000 });
  try {
    const run = gate(f.dir, ['--json']);
    assert.equal(run.code, 0, run.err);
    const report = JSON.parse(run.out);
    assert.equal(report.warnBytes, 2048);
    assert.equal(report.sharedMarginBytes, f.sharedLeft);
    assert.deepEqual(
      report.nearBudget.map((row) => [row.scope, row.marginBytes]),
      [['/[locale]/(app)/admin/x/page', f.routeLeft]],
    );
    assert.doesNotMatch(run.out, /Tightest margins/, 'the JSON mode stays machine-readable');
  } finally {
    f.cleanup();
  }
});

test('in GitHub Actions the warning is an annotation and the run gets a summary table', () => {
  const f = fixture({ routeLeft: 1500 });
  const summary = join(dirname(f.dir), 'summary.md');
  try {
    const run = gate(f.dir, [], { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary });
    assert.equal(run.code, 0, run.err);
    assert.match(run.err, /^::warning title=Bundle margin under 2 KB::\/\[locale\]\/\(app\)\/admin\/x\/page — /m);
    const table = readFileSync(summary, 'utf8');
    assert.match(table, /### Bundle margins/);
    assert.match(table, /admin\/x\/page/);
  } finally {
    f.cleanup();
  }
});

test('outside GitHub Actions there is no annotation', () => {
  const f = fixture({ routeLeft: 1500 });
  try {
    assert.doesNotMatch(gate(f.dir).err, /::warning/);
  } finally {
    f.cleanup();
  }
});

test('the public tier is 6 KB: Next\'s own 3 534 B has room, and 5 000 B does not', () => {
  const roomy = fixture({ publicBytes: 3534, routeLeft: 20000, sharedLeft: 20000 });
  const tight = fixture({ publicBytes: 5000, routeLeft: 20000, sharedLeft: 20000 });
  try {
    const ok = gate(roomy.dir, ['--json']);
    assert.equal(ok.code, 0, ok.err);
    const report = JSON.parse(ok.out);
    const page = report.routes.find((r) => r.route === '/v/[token]/page');
    assert.equal(page.tier, 'public');
    assert.equal(page.budgetKb, 6);
    assert.doesNotMatch(ok.err, /WARNING/, 'Next\'s own boundaries leave 2 610 B, which is not a warning');

    const warned = gate(tight.dir);
    assert.equal(warned.code, 0, warned.err);
    assert.match(warned.err, /WARNING: \/v\/\[token\]\/page — 1 1\d\d B left of 6 144 B \(public, 6 KB\)/);
  } finally {
    roomy.cleanup();
    tight.cleanup();
  }
});

// ---- every tier is measured against its own budget ------------------------

/** gzip of every route the gate reads is `budgetKb * 1024 - left`, so a route's margin is `left`, give or take a few bytes. */
const TIER_ROUTES = [
  { route: '/v/[token]/page', tier: 'public', budgetKb: 6, left: 1200 },
  { route: '/[locale]/(auth)/login/page', tier: 'auth', budgetKb: 110, left: 1300 },
  { route: '/[locale]/(app)/teacher/page', tier: 'core', budgetKb: 170, left: 1400 },
  { route: '/[locale]/(app)/notifications/page', tier: 'other', budgetKb: 170, left: 1500 },
  { route: '/[locale]/page', tier: 'system', budgetKb: 50, left: 1600 },
  { route: '/[locale]/(app)/admin/x/page', tier: 'admin', budgetKb: 190, left: 1700 },
];

/** A `.next` with a shared chunk and one route per entry of TIER_ROUTES (each with a chunk of its own). */
function tierFixture({ sharedLeft = 20000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-margin-tiers-'));
  const next = join(dir, '.next');
  mkdirSync(join(next, 'static', 'chunks'), { recursive: true });
  const shared = chunkOfGzipSize(SHARED_CAP - sharedLeft, 1);
  writeFileSync(join(next, 'static', 'chunks', 'shared.js'), shared.bytes);
  writeFileSync(
    join(next, 'build-manifest.json'),
    JSON.stringify({ rootMainFiles: ['static/chunks/shared.js'], polyfillFiles: [] }),
  );
  const left = new Map();
  TIER_ROUTES.forEach((entry, index) => {
    const own = chunkOfGzipSize(entry.budgetKb * 1024 - entry.left, 10 + index);
    writeFileSync(join(next, 'static', 'chunks', `route-${index}.js`), own.bytes);
    const manifestDir = join(next, 'server', 'app', `r${index}`);
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(
      join(manifestDir, 'page_client-reference-manifest.js'),
      `globalThis.__RSC_MANIFEST = globalThis.__RSC_MANIFEST || {};\n` +
        `globalThis.__RSC_MANIFEST[${JSON.stringify(entry.route)}] = ` +
        `{"entryJSFiles":{"/x":["static/chunks/shared.js","static/chunks/route-${index}.js"]}};\n`,
    );
    left.set(entry.route, entry.budgetKb * 1024 - own.size);
  });
  return { dir: next, left, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const grouped = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

test('each tier (public, auth, core, other, system, admin) is measured against its own budget', () => {
  const f = tierFixture();
  try {
    const run = gate(f.dir);
    assert.equal(run.code, 0, run.err);
    for (const { route, tier, budgetKb } of TIER_ROUTES) {
      const left = f.left.get(route);
      assert.ok(
        run.err.includes(`WARNING: ${route} — ${grouped(left)} B left of ${grouped(budgetKb * 1024)} B (${tier}, ${budgetKb} KB)`),
        `${tier}: ${route} should warn with ${left} B left of ${budgetKb} KB\n${run.err}`,
      );
    }
    assert.match(run.err, /6 budget\(s\) with under 2048 B left\. Not a failure/);

    const json = gate(f.dir, ['--json']);
    assert.equal(json.code, 0, json.err);
    const report = JSON.parse(json.out.slice(0, json.out.lastIndexOf('\n}') + 2));
    assert.deepEqual(
      report.nearBudget.map((row) => [row.scope, row.tier, row.budgetKb, row.marginBytes]).sort(),
      TIER_ROUTES.map(({ route, tier, budgetKb }) => [route, tier, budgetKb, f.left.get(route)]).sort(),
    );
  } finally {
    f.cleanup();
  }
});

// ---- what a warning must never do ------------------------------------------

test('the shared runtime over its budget is a failure, reported once and not also as a warning', () => {
  const f = fixture({ sharedLeft: -3000 });
  try {
    const run = gate(f.dir);
    assert.equal(run.code, 1, 'exit code unchanged: 1 for the shared runtime over budget');
    assert.match(run.err, /FAIL: shared runtime is /);
    assert.doesNotMatch(run.err, /WARNING/);
  } finally {
    f.cleanup();
  }
});

test('a step summary that cannot be written does not fail the gate', () => {
  const f = fixture({ routeLeft: 1500 });
  const summary = join(dirname(f.dir), 'no-such-directory', 'summary.md');
  try {
    const run = gate(f.dir, [], { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary });
    assert.equal(run.code, 0, run.err);
    assert.match(run.err, /WARNING: /);
    assert.match(run.out, /^PASS: /m);
  } finally {
    f.cleanup();
  }
});

test('the flat mode (--max-kb) has no margins to warn about and prints none', () => {
  const f = fixture({ routeLeft: 1500, sharedLeft: 1500 });
  try {
    const run = gate(f.dir, ['--max-kb', '100000']);
    assert.equal(run.code, 0, run.err);
    assert.doesNotMatch(run.err, /WARNING/);
    assert.doesNotMatch(run.out, /Tightest margins/);
  } finally {
    f.cleanup();
  }
});
