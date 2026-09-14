/**
 * The latency gate's verdict on the rows of real CI runs.
 *
 *   node --test scripts/bench/latency-gate.test.mjs
 *
 * No dependencies: latency-gate.mjs imports nothing, so this runs on a pull
 * request without autocannon or the stack.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exitCodeOf, gate, READ_SHARE_MIN, scenarioLines } from './latency-gate.mjs';

// Rows as api-latency.mjs builds them, copied from the logs of five
// quality-gates runs on ubuntu-latest: 2 vCPU, 25 connections, 20 s per read,
// zero non-2xx. The logs print whole req/s, where the script passes the
// unrounded average.
const load = (id, scenario, kind, [p50Ms, p99Ms, maxMs, rps, totalRequests]) => ({
  id,
  scenario,
  kind,
  p50Ms,
  p99Ms,
  maxMs,
  rps,
  totalRequests,
  non2xx: 0,
});

const FLOOR_NAME = 'floor: GET /api/v1/schedule-versions (no matching row)';

function runOf({ health, versions, jobs, write: [p50Ms, p99Ms, maxMs, samples], floors = [] }) {
  return [
    load('health', 'GET /health/ready', 'read', health),
    load('read:schedule-versions', 'GET /api/v1/schedule-versions', 'read', versions),
    load('read:optimization-jobs', 'GET /api/v1/optimization/jobs', 'read', jobs),
    {
      id: 'write',
      scenario: 'POST /api/v1/attendance/report',
      kind: 'update',
      p50Ms,
      p99Ms,
      maxMs,
      rps: null,
      totalRequests: samples,
      non2xx: 0,
    },
    ...floors.map((f, i) =>
      load(`floor:${i + 1}`, `${FLOOR_NAME}, round ${i + 1}/${floors.length}`, 'floor', f),
    ),
  ];
}

// [p50, p99, max, req/s, requests]; the write is [p50, p99, max, samples].
const RUNS = {
  // 48c82db. No floor rounds, and the write was 24 samples.
  34825468923: runOf({
    health: [8, 24, 175, 2433, 48643],
    versions: [40, 86, 339, 586, 11710],
    jobs: [41, 72, 192, 590, 11809],
    write: [43, 152, 152, 24],
  }),
  // 15edbcc. The 300-sample write ran ungated after the floor rounds.
  34832429087: runOf({
    health: [11, 32, 241, 1930, 38587],
    versions: [49, 107, 363, 476, 9529],
    jobs: [49, 87, 224, 494, 9885],
    write: [51, 104, 157, 300],
    floors: [
      [50, 96, 150, 469, 9387],
      [50, 86, 241, 479, 9576],
      [50, 94, 214, 479, 9570],
    ],
  }),
  // 849858c. The absolute gate failed it on the write's p99 of 167 ms.
  34838510625: runOf({
    health: [8, 22, 229, 2708, 54146],
    versions: [35, 69, 320, 670, 13402],
    jobs: [36, 66, 154, 670, 13403],
    write: [39, 167, 236, 300],
    floors: [
      [35, 71, 175, 677, 13545],
      [35, 62, 112, 694, 13876],
      [34, 60, 152, 697, 13947],
    ],
  }),
  // 849858c. The absolute gate failed it on jobs' p99 of 181 ms.
  34839849296: runOf({
    health: [12, 32, 255, 1771, 35422],
    versions: [53, 120, 390, 441, 8820],
    jobs: [58, 181, 290, 400, 8001],
    write: [48, 85, 193, 300],
    floors: [
      [53, 112, 222, 444, 8889],
      [50, 84, 197, 481, 9624],
      [50, 87, 220, 480, 9605],
    ],
  }),
  // 849858c. Passed the absolute gate.
  34839859422: runOf({
    health: [12, 32, 267, 1722, 34438],
    versions: [53, 115, 342, 439, 8778],
    jobs: [53, 90, 135, 456, 9119],
    write: [48, 100, 183, 300],
    floors: [
      [51, 110, 262, 460, 9198],
      [50, 84, 175, 481, 9621],
      [50, 87, 170, 483, 9668],
    ],
  }),
};

const D = RUNS[34839849296];
const E = RUNS[34839859422];

const edit = (rows, id, patch) => rows.map((r) => (r.id === id ? { ...r, ...patch } : { ...r }));
const without = (rows, id) => rows.filter((r) => r.id !== id).map((r) => ({ ...r }));
const has = (verdict, ...parts) =>
  verdict.lines.some((line) => parts.every((part) => line.includes(part)));
const report = (verdict) => verdict.lines.join('\n');

const BASELINE = {
  id: 'write-baseline',
  scenario: 'write baseline: GET floor, interleaved with the write',
  kind: 'baseline',
  p50Ms: 0.96,
  p95Ms: 1.2,
  p99Ms: 1.7,
  maxMs: 9.4,
  rps: null,
  totalRequests: 300,
  non2xx: 0,
};

test('all five CI runs pass, the two the absolute budgets failed among them', () => {
  const shares = {
    34825468923: ['0.241', '0.242'],
    34832429087: ['0.247', '0.256'],
    34838510625: ['0.247', '0.247'],
    34839849296: ['0.249', '0.226'],
    34839859422: ['0.255', '0.265'],
  };
  for (const [run, rows] of Object.entries(RUNS)) {
    const verdict = gate(rows);
    assert.equal(exitCodeOf(verdict), 0, `${run}\n${report(verdict)}`);
    assert.deepEqual(
      verdict.lines.filter((l) => l.includes('✓ read share')).map((l) => l.match(/(\d\.\d{3}) ≥ 0\.20/)[1]),
      shares[run],
      run,
    );
    assert.equal(
      verdict.lines.at(-1),
      'PASS: health within its absolute guard and every authenticated read at least 0.20 of its throughput.',
    );
  }
});

test('the floor rounds, the write ratios and the fallback are printed', () => {
  const b = gate(RUNS[34832429087]);
  assert.deepEqual(
    b.lines.filter((l) => l.includes('· floor share')).map((l) => l.match(/round (\d\/3)\s+(\d\.\d{3})/).slice(1)),
    [
      ['1/3', '0.243'],
      ['2/3', '0.248'],
      ['3/3', '0.248'],
    ],
  );
  // The 24-sample write of 34825468923 had no baseline.
  assert.ok(has(gate(RUNS[34825468923]), '· write ÷ baseline', 'not measured'));
  assert.ok(has(gate(D), '· write p50 ÷ health p50', '4.00', 'not gated'));
});

// Per-request cost up by x divides req/s by 1 + x. The lowest share seen is
// 400 ÷ 1771 = 0.2259, which fails from +12.9%; the highest, 456 ÷ 1722 =
// 0.2648, from +32.4%.
const slowerReads = (rows, factor) =>
  rows.map((r) => (r.id.startsWith('read:') ? { ...r, rps: r.rps / factor } : { ...r }));

test('reads 33% more expensive per request fail in every runner state seen; 12% passes in every one', () => {
  for (const [run, rows] of Object.entries(RUNS)) {
    const slower = gate(slowerReads(rows, 1.33));
    assert.equal(exitCodeOf(slower), 1, `${run}\n${report(slower)}`);
    assert.equal(slower.lines.at(-1), 'FAIL: 2 gate(s) failed.', run);
    assert.equal(exitCodeOf(gate(slowerReads(rows, 1.12))), 0, run);
  }
});

test('the share is compared unrounded: 354 ÷ 1771 fails, 355 ÷ 1771 passes, exactly 0.20 passes', () => {
  const low = gate(edit(D, 'read:optimization-jobs', { rps: 354 }));
  assert.equal(exitCodeOf(low), 1);
  // 0.19989 would round to 0.200; it must not print as "0.200 < 0.20".
  assert.ok(has(low, '✗ read share', 'GET /api/v1/optimization/jobs', '0.199 < 0.20', '(354 ÷ 1771 req/s)'));
  assert.equal(low.lines.at(-1), 'FAIL: 1 gate(s) failed.');

  assert.equal(exitCodeOf(gate(edit(D, 'read:optimization-jobs', { rps: 355 }))), 0);

  const rows = edit(edit(edit(D, 'health', { rps: 2000 }), 'read:schedule-versions', { rps: 400 }), 'read:optimization-jobs', {
    rps: 400,
  });
  assert.equal(400 / 2000, READ_SHARE_MIN);
  const exact = gate(rows);
  assert.equal(exitCodeOf(exact), 0, report(exact));
  assert.ok(has(exact, '✓ read share', '0.200 ≥ 0.20'));
});

test('health p99 above 50 ms fails the run; 50 ms passes', () => {
  const slow = gate(edit(D, 'health', { p99Ms: 51 }));
  assert.equal(exitCodeOf(slow), 1);
  assert.ok(has(slow, '✗ health p99', '51ms > 50ms'));
  assert.equal(exitCodeOf(gate(edit(D, 'health', { p99Ms: 50 }))), 0);
});

test('health below 1000 req/s fails the run; 1000 passes', () => {
  assert.equal(exitCodeOf(gate(edit(D, 'health', { rps: 999 }))), 1);
  // Rounded, 999.6 would print as the threshold it fails.
  assert.ok(has(gate(edit(D, 'health', { rps: 999.6 })), '✗ health throughput', '999 req/s < 1000 req/s'));
  assert.equal(exitCodeOf(gate(edit(D, 'health', { rps: 1000 }))), 0);
});

test('a collapsed health window cannot turn the reads into a pass', () => {
  const verdict = gate(edit(E, 'health', { rps: 900, p99Ms: 30 }));
  assert.equal(exitCodeOf(verdict), 1);
  assert.ok(has(verdict, '✗ health throughput', '900 req/s < 1000 req/s'));
  // The shares look twice as healthy as they are, and pass on their own.
  assert.ok(has(verdict, '✓ read share', 'GET /api/v1/schedule-versions', '0.488 ≥ 0.20'));
  assert.ok(has(verdict, '✓ read share', 'GET /api/v1/optimization/jobs', '0.507 ≥ 0.20'));
  assert.equal(verdict.lines.at(-1), 'FAIL: 1 gate(s) failed.');
});

test('health that counted no request fails every share instead of dividing into a pass', () => {
  const verdict = gate(edit(D, 'health', { rps: 0, totalRequests: 0 }));
  assert.equal(exitCodeOf(verdict), 1);
  assert.equal(verdict.lines.at(-1), 'FAIL: 3 gate(s) failed.');
});

test('a run without health or either read is invalid, never a pass', () => {
  for (const id of ['health', 'read:schedule-versions', 'read:optimization-jobs']) {
    const verdict = gate(without(D, id));
    assert.equal(exitCodeOf(verdict), 2, id);
    assert.ok(verdict.failed, id);
    assert.ok(has(verdict, '✗ missing', id), id);
    assert.ok(has(verdict, 'INVALID: 1 required scenario(s) not measured', id), id);
    assert.ok(!verdict.lines.some((l) => l.startsWith('PASS') || l.startsWith('FAIL')), id);
  }
  // Without the denominator no share is computed at all.
  const noHealth = gate(without(D, 'health'));
  assert.ok(!has(noHealth, 'read share') && !has(noHealth, 'floor share'), report(noHealth));
});

test('more than 1% non-2xx in any row is invalid: 4 of 300 writes, a baseline, a floor round at 5%', () => {
  assert.equal(exitCodeOf(gate(edit(D, 'write', { non2xx: 4 }))), 2);
  assert.equal(exitCodeOf(gate(edit(D, 'write', { non2xx: 3 }))), 0);
  assert.equal(exitCodeOf(gate([...D, { ...BASELINE, non2xx: 4 }])), 2);

  const floor = gate(edit(D, 'floor:1', { non2xx: 445 }));
  assert.equal(exitCodeOf(floor), 2);
  assert.ok(has(floor, '✗ non-2xx', 'round 1/3', '5.0% (445/8889)'));
  assert.ok(has(floor, 'INVALID: 1 scenario(s) exceeded 1% non-2xx'));
  assert.ok(has(floor, 'Usual causes: an invalid --token (401)'));

  // Invalid wins over a failed gate in the same run.
  assert.equal(exitCodeOf(gate(edit(edit(D, 'read:optimization-jobs', { rps: 300 }), 'write', { non2xx: 4 }))), 2);
});

test('the write cannot fail the run while it calibrates', () => {
  const ratio50 = gate([...edit(D, 'write', { p95Ms: 60 }), { ...BASELINE }]);
  assert.equal(exitCodeOf(ratio50), 0, report(ratio50));
  assert.ok(has(ratio50, '· write ÷ baseline', 'p50 50.00   p95 50.00   p99 50.00', 'not gated'));

  // §2's 150 ms missed many times over.
  assert.equal(exitCodeOf(gate(edit(D, 'write', { p50Ms: 900, p99Ms: 5000, maxMs: 9000 }))), 0);

  // No --write-body: the write is SKIPPED, which is not an invalid run yet.
  const none = gate(without(D, 'write'));
  assert.equal(exitCodeOf(none), 0);
  assert.ok(has(none, '· write ÷ baseline', 'not measured'));
  assert.ok(has(none, '· write p50 ÷ health p50', 'not measured'));
});

test('a floor round far below the read threshold is information', () => {
  const verdict = gate(edit(D, 'floor:1', { rps: 177 }));
  assert.equal(exitCodeOf(verdict), 0);
  assert.ok(has(verdict, '· floor share', 'round 1/3', '0.100', 'not gated'));
});

test('each row prints its numbers and §2 as met or not met, the serial rows with p95 and samples', () => {
  const lines = scenarioLines([...edit(D, 'health', { p99Ms: 50 }), { ...BASELINE }]);
  assert.deepEqual(lines.slice(0, 2), [
    '  GET /health/ready',
    '      p50 12ms   p99 50ms   max 255ms   1771 req/s   non-2xx 0/35422   §2 50ms: met',
  ]);
  assert.equal(lines[5], '      p50 58ms   p99 181ms   max 290ms   400 req/s   non-2xx 0/8001   §2 50ms: not met');
  assert.equal(lines[7], '      p50 48ms   p99 85ms   max 193ms   300 serial samples   non-2xx 0/300   §2 150ms: met');
  assert.equal(lines[9], '      p50 53ms   p99 112ms   max 222ms   444 req/s   non-2xx 0/8889');
  assert.deepEqual(lines.slice(-2), [
    '  write baseline: GET floor, interleaved with the write',
    '      p50 1.0ms   p95 1.2ms   p99 1.7ms   max 9.4ms   300 serial samples   non-2xx 0/300',
  ]);
});
