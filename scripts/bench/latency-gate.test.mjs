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
import {
  exitCodeOf,
  FLOOR_RPS_MIN,
  gate,
  HEALTH_RPS_MIN,
  READ_SHARE_MIN,
  scenarioLines,
} from './latency-gate.mjs';

// Rows as api-latency.mjs builds them, copied from the logs of real CI runs:
// 25 connections, 20 s per read, zero non-2xx. The logs print whole req/s,
// where the script passes the unrounded average.
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
//
// FIVE RUNS ON THE PRIVATE REPOSITORY'S RUNNERS (August–September), ubuntu-latest
// then 2 vCPU. Three of them are the runs the absolute budgets failed.
const OLD = {
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
  // 849858c. The absolute gate failed it on jobs' p99 of 181 ms. jobs' window
  // is the slowest read window of any run with floor rounds: 0.833 of the floor.
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

// THE PUBLIC REPOSITORY'S RUNNERS, 4 vCPU, whose CPU model decides how fast
// health runs against a read. Run 41443397511 on a throwaway branch drew
// 35 runners: the three below are the healthy tree on one runner of each of
// three CPU models, and the next six are the same tree with K extra
// statements compiled into it — in one handler (jobs2, jobs4, jobs8, jobs12)
// or in every authenticated request's transaction (auth4, auth12). Floors are
// measured straight after the reads, as the script does.
const NEW = {
  // AMD EPYC 7763, the slowest model seen: health 2150 req/s.
  base7763: runOf({
    health: [11, 21, 178, 2150.3, 42997],
    versions: [56, 92, 418, 424.5, 8489],
    jobs: [57, 70, 155, 427, 8539],
    write: [14.932029, 22.184283, 129.722838, 300],
    floors: [
      [54, 66, 136, 455, 9100],
      [53, 66, 179, 460.5, 9210],
      [54, 66, 155, 454.7, 9093],
    ],
  }),
  // AMD EPYC 9V74: health 3039 req/s.
  base9V74: runOf({
    health: [7, 16, 142, 3039.2, 60771],
    versions: [44, 76, 338, 539.3, 10786],
    jobs: [46, 56, 130, 533.1, 10661],
    write: [13.128735, 16.652684, 115.89184, 300],
    floors: [
      [43, 56, 115, 565.7, 11314],
      [43, 52, 115, 570.5, 11409],
      [43, 53, 116, 566.3, 11326],
    ],
  }),
  // AMD EPYC 9V45, the fastest: health 5341 req/s, a read's share of it 0.12.
  base9V45: runOf({
    health: [4, 12, 129, 5341.2, 106819],
    versions: [36, 67, 306, 652.2, 13044],
    jobs: [35, 46, 117, 689.1, 13781],
    write: [11.2761, 19.129744, 83.666729, 300],
    floors: [
      [32, 48, 87, 748.9, 14977],
      [33, 43, 95, 743.5, 14869],
      [31, 46, 87, 768.9, 15377],
    ],
  }),
  // jobs2: two extra statements in optimization/jobs only, +10% on that read.
  jobs2: runOf({
    health: [11, 22, 198, 2110, 42193],
    versions: [60, 96, 397, 397.4, 7948],
    jobs: [67, 83, 187, 367.5, 7349],
    write: [15.979314, 27.421809, 137.526507, 300],
    floors: [
      [56, 69, 157, 436.6, 8731],
      [55, 68, 159, 443.8, 8875],
      [55, 67, 155, 443.7, 8873],
    ],
  }),
  // jobs4: +22%.
  jobs4: runOf({
    health: [11, 21, 173, 2131.9, 42628],
    versions: [59, 94, 389, 406.6, 8132],
    jobs: [73, 89, 175, 336.5, 6730],
    write: [15.399069, 25.684128, 125.384513, 300],
    floors: [
      [55, 65, 149, 446.8, 8936],
      [55, 67, 157, 442.9, 8858],
      [55, 68, 147, 442, 8839],
    ],
  }),
  // jobs8: +40%, on the EPYC 9V74.
  jobs8: runOf({
    health: [7, 15, 149, 3033.4, 60658],
    versions: [42, 71, 283, 561.2, 11223],
    jobs: [61, 74, 133, 401.6, 8031],
    write: [12.753771, 17.460055, 107.237969, 300],
    floors: [
      [41, 50, 121, 588.7, 11773],
      [41, 50, 117, 590.1, 11801],
      [42, 53, 119, 581.3, 11626],
    ],
  }),
  // jobs12: +53%, on the EPYC 9V45.
  jobs12: runOf({
    health: [5, 14, 110, 4398.5, 87964],
    versions: [41, 81, 264, 567.3, 11345],
    jobs: [59, 78, 139, 412, 8239],
    write: [12.086818, 24.07252, 95.272767, 300],
    floors: [
      [38, 47, 124, 635.3, 12706],
      [38, 50, 115, 637.1, 12741],
      [38, 48, 99, 635.1, 12701],
    ],
  }),
  // auth4: four extra statements in each of the two transactions a request
  // opens, on the EPYC 7763: the floor falls from 455 to 338 req/s, +35%.
  auth4: runOf({
    health: [10, 21, 197, 2192.1, 43829],
    versions: [77, 121, 409, 309.3, 6186],
    jobs: [77, 93, 168, 319.7, 6394],
    write: [15.528591, 22.502669, 137.842266, 300],
    floors: [
      [73, 86, 164, 338.2, 6763],
      [73, 88, 152, 336.6, 6731],
      [73, 87, 160, 337.8, 6755],
    ],
  }),
  // auth12: twelve, on the EPYC 7763: the floor falls to 205 req/s, +120%.
  auth12: runOf({
    health: [11, 22, 196, 2112.6, 42243],
    versions: [125, 187, 468, 191.5, 3829],
    jobs: [124, 148, 234, 198.1, 3962],
    write: [17.644972, 25.621813, 164.991662, 300],
    floors: [
      [117, 141, 221, 210.7, 4213],
      [120, 148, 205, 204.6, 4091],
      [121, 144, 227, 203.8, 4076],
    ],
  }),
};

const D = OLD[34839849296];
const E = OLD[34839859422];
const HEALTHY = { ...OLD, ...NEW };
delete HEALTHY[34825468923];
for (const id of ['jobs2', 'jobs4', 'jobs8', 'jobs12', 'auth4', 'auth12']) delete HEALTHY[id];

const edit = (rows, id, patch) => rows.map((r) => (r.id === id ? { ...r, ...patch } : { ...r }));
const without = (rows, id) => rows.filter((r) => r.id !== id).map((r) => ({ ...r }));
const has = (verdict, ...parts) =>
  verdict.lines.some((line) => parts.every((part) => line.includes(part)));
const report = (verdict) => verdict.lines.join('\n');
const shares = (verdict) =>
  verdict.lines.filter((l) => /^ {2}[✓✗] read share/.test(l)).map((l) => l.match(/(\d+\.\d{3}) [≥<] 0\.80/)[1]);

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

test('the healthy tree passes on every runner seen: four older runs and one on each of three CPU models', () => {
  const expected = {
    34832429087: ['0.994', '1.031'],
    34838510625: ['0.965', '0.965'],
    34839849296: ['0.919', '0.833'],
    34839859422: ['0.913', '0.948'],
    base7763: ['0.933', '0.938'],
    base9V74: ['0.952', '0.941'],
    base9V45: ['0.871', '0.920'],
  };
  assert.deepEqual(Object.keys(HEALTHY).sort(), Object.keys(expected).sort());
  for (const [run, rows] of Object.entries(HEALTHY)) {
    const verdict = gate(rows);
    assert.equal(exitCodeOf(verdict), 0, `${run}\n${report(verdict)}`);
    assert.deepEqual(shares(verdict), expected[run], run);
    assert.equal(
      verdict.lines.at(-1),
      "PASS: health and the floor within their absolute guards and every authenticated read at least 0.80 of the floor's throughput.",
    );
  }
});

// The reason for the change. Over the 35 runners the same tree drew, health
// ran from 2051 to 5341 req/s against reads that stayed between 403 and 725,
// so a read's share of health fell from 0.20 on an EPYC 7763 to 0.12 on an
// EPYC 9V45 with no change in the code, and the old gate (≥ 0.20) failed the
// nightly on every night since 2026-09-30 on a tree that had not regressed.
test("a read's share of health is printed and decides nothing: 0.12 on the fastest CPU passes", () => {
  const fast = gate(NEW.base9V45);
  assert.equal(exitCodeOf(fast), 0, report(fast));
  assert.ok(has(fast, '· read ÷ health', 'GET /api/v1/schedule-versions', '0.12', '(652 ÷ 5341 req/s, not gated)'));
  assert.ok(has(fast, '· read ÷ health', 'GET /api/v1/optimization/jobs', '0.13', '(689 ÷ 5341 req/s, not gated)'));
  assert.ok(has(fast, '· floor ÷ health', '0.14', '(749 ÷ 5341 req/s, not gated)'));
  // The same tree on the slowest CPU: 0.20 where the fastest shows 0.12.
  assert.ok(has(gate(NEW.base7763), '· read ÷ health', 'GET /api/v1/optimization/jobs', '0.20'));
  // Health decides through its own guards only; its throughput moves no share.
  for (const rps of [HEALTH_RPS_MIN, 2150, 9000]) {
    assert.deepEqual(shares(gate(edit(NEW.base7763, 'health', { rps }))), ['0.933', '0.938'], String(rps));
  }
});

test('a run without floor rounds is invalid, never a pass: a share has no verdict without its denominator', () => {
  const none = gate(OLD[34825468923]);
  assert.equal(exitCodeOf(none), 2, report(none));
  assert.ok(none.failed);
  assert.ok(has(none, '✗ missing', 'floor rounds'));
  assert.ok(has(none, 'INVALID: 1 required scenario(s) not measured (floor rounds)'));
  assert.ok(!none.lines.some((l) => l.startsWith('PASS') || l.startsWith('FAIL')));
  assert.ok(!has(none, 'read share') && !has(none, 'floor throughput'), report(none));
});

test('the write, the floor and the fallback are printed', () => {
  const b = gate(OLD[34832429087]);
  assert.ok(has(b, '✓ floor throughput', '479 req/s ≥ 300 req/s', '(median of 469, 479, 479)'));
  assert.ok(has(b, '· floor ÷ health', '0.25', '(479 ÷ 1930 req/s, not gated)'));
  assert.ok(has(b, '· write ÷ baseline', 'not measured'));
  assert.ok(has(gate(D), '· write p50 ÷ health p50', '4.00', 'not gated'));
});

// Per-request cost up by x divides req/s by 1 + x, and the floor is the same
// path without the read's own query: a read x more expensive than the floor
// fails when share ÷ (1 + x) < 0.80. Across the seven healthy runs the lowest
// share is 0.833 (jobs in 34839849296), which fails from +4.2%; the median,
// 0.941, from +17.6%; the highest, 1.031, from +28.9%.
const slowerReads = (rows, factor) =>
  rows.map((r) => (r.id.startsWith('read:') ? { ...r, rps: r.rps / factor } : { ...r }));

test('reads 35% more expensive fail every healthy run; 3% more expensive passes every one', () => {
  for (const [run, rows] of Object.entries(HEALTHY)) {
    const slower = gate(slowerReads(rows, 1.35));
    assert.equal(exitCodeOf(slower), 1, `${run}\n${report(slower)}`);
    assert.equal(slower.lines.at(-1), 'FAIL: 2 gate(s) failed.', run);
    assert.equal(exitCodeOf(gate(slowerReads(rows, 1.03))), 0, run);
  }
});

// What the gate reaches, on a handler: the same tree with K extra statements
// compiled into optimization/jobs, drawn on runners of three CPU models.
test('a handler made 22% to 53% more expensive fails on every CPU model; 10% passes', () => {
  const j2 = gate(NEW.jobs2);
  assert.equal(exitCodeOf(j2), 0, report(j2));
  assert.deepEqual(shares(j2), ['0.896', '0.828']);

  for (const [name, versions, jobs] of [
    ['jobs4', '0.918', '0.760'],
    ['jobs8', '0.953', '0.682'],
    ['jobs12', '0.893', '0.649'],
  ]) {
    const verdict = gate(NEW[name]);
    assert.equal(exitCodeOf(verdict), 1, `${name}\n${report(verdict)}`);
    // The read that was changed fails; the one beside it, on the same path
    // without the change, does not.
    assert.ok(has(verdict, '✓ read share', 'GET /api/v1/schedule-versions', `${versions} ≥ 0.80`), name);
    assert.ok(has(verdict, '✗ read share', 'GET /api/v1/optimization/jobs', `${jobs} < 0.80`), name);
    assert.equal(verdict.lines.at(-1), 'FAIL: 1 gate(s) failed.', name);
  }
});

// What it does not reach. A regression on the path every authenticated request
// shares slows the floor as much as the read, so no share moves; only the
// floor's absolute guard sees it, and only when it is large. The docs say so.
test('a regression on the shared authenticated path moves no share; only a large one trips the floor guard', () => {
  // +35% on the path: the floor falls from 455 to 338 req/s and the run passes.
  const a4 = gate(NEW.auth4);
  assert.equal(exitCodeOf(a4), 0, report(a4));
  assert.ok(has(a4, '✓ floor throughput', '338 req/s ≥ 300 req/s'));
  assert.deepEqual(shares(a4), ['0.916', '0.946']);

  // +120%: the floor is 205 req/s, under its guard, and the shares are still fine.
  const a12 = gate(NEW.auth12);
  assert.equal(exitCodeOf(a12), 1, report(a12));
  assert.ok(has(a12, '✗ floor throughput', '205 req/s < 300 req/s'));
  assert.deepEqual(shares(a12), ['0.936', '0.968']);
  assert.equal(a12.lines.at(-1), 'FAIL: 1 gate(s) failed.');
});

test('the share is compared unrounded: 359.99 ÷ 450 fails and prints 0.799, 360 ÷ 450 passes, exactly 0.80 passes', () => {
  const flat = (rows, floor) => [1, 2, 3].reduce((r, i) => edit(r, `floor:${i}`, { rps: floor }), rows);
  const rows = flat(D, 450);
  const low = gate(edit(rows, 'read:optimization-jobs', { rps: 359.99 }));
  assert.equal(exitCodeOf(low), 1);
  // 0.79998 would round to 0.800; it must not print as "0.800 < 0.80".
  assert.ok(has(low, '✗ read share', 'GET /api/v1/optimization/jobs', '0.799 < 0.80', '(360 ÷ 450 req/s)'));
  assert.equal(low.lines.at(-1), 'FAIL: 1 gate(s) failed.');

  const exact = gate(edit(rows, 'read:optimization-jobs', { rps: 360 }));
  assert.equal(360 / 450, READ_SHARE_MIN);
  assert.equal(exitCodeOf(exact), 0, report(exact));
  assert.ok(has(exact, '✓ read share', 'GET /api/v1/optimization/jobs', '0.800 ≥ 0.80'));
});

test('the floor is the median of its rounds: one wild round moves it no further than a neighbouring round, two move it', () => {
  // E's rounds are 460, 481 and 483: whichever one collapses to 5 or inflates
  // to 5000, the median is one of the other two.
  for (const rps of [5, 5000]) {
    for (const round of ['floor:1', 'floor:2', 'floor:3']) {
      const one = gate(edit(E, round, { rps }));
      assert.equal(exitCodeOf(one), 0, `${round} ${rps}\n${report(one)}`);
      const floor = Number(one.lines.find((l) => l.includes('floor throughput')).match(/(\d+) req\/s [≥<]/)[1]);
      assert.ok(floor >= 460 && floor <= 483, `${round} ${rps}: ${floor}`);
    }
  }
  const two = gate(edit(edit(E, 'floor:1', { rps: 100 }), 'floor:2', { rps: 100 }));
  assert.equal(exitCodeOf(two), 1, report(two));
  assert.ok(has(two, '✗ floor throughput', '100 req/s < 300 req/s', '(median of 100, 100, 483)'));
});

test('the floor below 300 req/s fails the run; 300 passes', () => {
  const at = (floor) => [1, 2, 3].reduce((r, i) => edit(r, `floor:${i}`, { rps: floor }), E);
  assert.equal(exitCodeOf(gate(at(299.6))), 1);
  // Rounded, 299.6 would print as the threshold it fails.
  assert.ok(has(gate(at(299.6)), '✗ floor throughput', '299 req/s < 300 req/s'));
  assert.equal(exitCodeOf(gate(at(FLOOR_RPS_MIN))), 0);
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

test('health that counted no request fails its own guard and no read share', () => {
  const verdict = gate(edit(D, 'health', { rps: 0, totalRequests: 0 }));
  assert.equal(exitCodeOf(verdict), 1);
  assert.ok(has(verdict, '✗ health throughput', '0 req/s < 1000 req/s'));
  assert.ok(has(verdict, '· read ÷ health', 'n/a'));
  assert.equal(verdict.lines.at(-1), 'FAIL: 1 gate(s) failed.');
});

test('a floor that counted no request fails every share instead of dividing into a pass', () => {
  const none = [1, 2, 3].reduce((r, i) => edit(r, `floor:${i}`, { rps: 0, totalRequests: 0 }), D);
  const verdict = gate(none);
  assert.equal(exitCodeOf(verdict), 1);
  assert.equal(verdict.lines.at(-1), 'FAIL: 3 gate(s) failed.');
});

test('a run without health, either read or the floor is invalid, never a pass', () => {
  for (const id of ['health', 'read:schedule-versions', 'read:optimization-jobs']) {
    const verdict = gate(without(D, id));
    assert.equal(exitCodeOf(verdict), 2, id);
    assert.ok(verdict.failed, id);
    assert.ok(has(verdict, '✗ missing', id), id);
    assert.ok(has(verdict, 'INVALID: 1 required scenario(s) not measured', id), id);
    assert.ok(!verdict.lines.some((l) => l.startsWith('PASS') || l.startsWith('FAIL')), id);
  }
  // Without the denominator no share is computed at all.
  const noFloor = gate(D.filter((r) => !r.id.startsWith('floor:')));
  assert.ok(!has(noFloor, 'read share'), report(noFloor));
});

test('more than 1% non-2xx in any row is invalid: a read, health, 4 of 300 writes, a baseline, a floor round at 5%', () => {
  // The rows where errors flatter the verdict. A read answering fast 401s
  // shows a share far above the line, and a floor row of fast failures
  // inflates its denominator; the share line may say ✓, the run is invalid.
  const read = gate(edit(D, 'read:schedule-versions', { non2xx: 89, rps: 5000 }));
  assert.equal(exitCodeOf(read), 2, report(read));
  assert.ok(has(read, '✓ read share', 'GET /api/v1/schedule-versions', '10.417 ≥ 0.80'));
  assert.ok(has(read, '✗ non-2xx', 'GET /api/v1/schedule-versions', '1.0% (89/8820)'));
  assert.equal(exitCodeOf(gate(edit(D, 'read:schedule-versions', { non2xx: 88 }))), 0);

  const health = gate(edit(D, 'health', { non2xx: 355 }));
  assert.equal(exitCodeOf(health), 2, report(health));
  assert.ok(has(health, '✗ non-2xx', 'GET /health/ready', '1.0% (355/35422)'));
  assert.equal(exitCodeOf(gate(edit(D, 'health', { non2xx: 354 }))), 0);

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
