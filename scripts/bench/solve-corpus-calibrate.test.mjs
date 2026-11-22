/**
 * The calibration script against a stub of the engine's routes.
 *
 *   node --test scripts/bench/solve-corpus-calibrate.test.mjs
 *
 * No engine, no network beyond localhost: a stub answers check-week, optimize and timing the way the
 * engine's schema does (camelCase, a TIMEOUT report with stages and phases).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { LADDER, compare, convert, measureWeek, reportOf, timingOf, withSearch, workAt } from './solve-corpus-calibrate.mjs';

const KEY = 'a-key-that-must-never-appear-in-an-output';

/** A stub engine: one worker times out with a report; every core solves from a budget of `solvesFrom`. */
function stub({ solvesFrom = 40, conflictsPerSecond = 1000, buildSeconds = 0.2 } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url, key: req.headers['x-api-key'], body: body ? JSON.parse(body) : null });
      if (req.headers['x-api-key'] !== KEY) {
        res.writeHead(401).end();
        return;
      }
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/v1/timing') return res.end(JSON.stringify({ solverMaxTimeSeconds: 180 }));
      if (req.url === '/api/v1/check-week') return res.end(JSON.stringify({ verdict: 'OK' }));
      const search = JSON.parse(body).search;
      if (search.workers === 1) {
        return res.end(JSON.stringify({
          status: 'TIMEOUT',
          lessons: [],
          report: {
            totalSeconds: search.maxSeconds,
            stages: [{ stage: 'PRECHECKS', seconds: 0.1 }, { stage: 'BUILD', seconds: buildSeconds }, { stage: 'SEARCH_CLEAN', seconds: search.maxSeconds }],
            search: { solutions: 0, phases: [{ phase: 'CLEAN', seconds: 10, conflicts: 10 * conflictsPerSecond, branches: 5 }] },
          },
        }));
      }
      return res.end(JSON.stringify({ status: search.maxSeconds >= solvesFrom ? 'FEASIBLE' : 'TIMEOUT', lessons: [] }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}

test('a week goes through check-week, the one-worker probe and the ladder, and the ladder stops at the first timetable', async () => {
  const { server, seen, url } = await stub({ solvesFrom: 40 });
  try {
    const week = await measureWeek({ url, key: KEY, name: 'w', request: { requestId: 'x' } });
    assert.equal(week.checkWeek.verdict, 'OK');
    assert.equal(week.probe.status, 'TIMEOUT');
    assert.equal(week.probe.report.stages.BUILD, 0.2);
    assert.equal(week.probe.report.phases[0].conflictsPerSecond, 1000);
    assert.deepEqual(week.ladder.rungs.map((r) => [r.budget, r.status]), [[10, 'TIMEOUT'], [20, 'TIMEOUT'], [40, 'FEASIBLE']]);
    assert.equal(week.ladder.solvedWithin, 40);
    // Every request carried the key, and the searches carried a fixed seed and no probe.
    assert.ok(seen.every((r) => r.key === KEY));
    const searches = seen.filter((r) => r.url === '/api/v1/optimize').map((r) => r.body.search);
    assert.deepEqual(searches[0], { probes: false, workers: 1, seed: 1, maxSeconds: 20 });
    assert.ok(searches.slice(1).every((s) => s.seed === 1 && s.probes === false && s.workers === undefined));
  } finally {
    server.close();
  }
});

test('a week no budget of the ladder solves says so, after the whole ladder', async () => {
  const { server, url } = await stub({ solvesFrom: 10_000 });
  try {
    const week = await measureWeek({ url, key: KEY, name: 'w', request: {} });
    assert.equal(week.ladder.solvedWithin, null);
    assert.equal(week.ladder.rungs.length, LADDER.length);
  } finally {
    server.close();
  }
});

test('the report is read as stage seconds and each search\'s pace, and an answer without one gives none', () => {
  const report = reportOf({ report: { totalSeconds: 20, stages: [{ stage: 'BUILD', seconds: 0.5 }], search: { phases: [{ phase: 'CLEAN', seconds: 4, conflicts: 2000 }, { phase: 'CLONE', seconds: 0, conflicts: 0 }] } } });
  assert.deepEqual(report.stages, { BUILD: 0.5 });
  assert.deepEqual(report.phases.map((p) => p.conflictsPerSecond), [500, null]);
  assert.equal(reportOf({ status: 'FEASIBLE' }), null);
  assert.equal(withSearch({ a: 1 }, { workers: 1 }).search.probes, false);
});

test('compare turns a faster engine into fewer seconds per deterministic second, and says which ladder rung each solved on', async () => {
  const slow = await stub({ conflictsPerSecond: 1000, buildSeconds: 0.4, solvesFrom: 40 });
  const fast = await stub({ conflictsPerSecond: 2000, buildSeconds: 0.2, solvesFrom: 20 });
  try {
    const mac = { weeks: [await measureWeek({ url: slow.url, key: KEY, name: 'w', request: {} })] };
    const other = { weeks: [await measureWeek({ url: fast.url, key: KEY, name: 'w', request: {} })] };
    const result = compare(mac, other, { macSecondsPerWork: 18 });
    assert.equal(result.searchSpeedMedian, 2);
    assert.equal(result.secondsPerWork, 9);
    assert.equal(result.rows[0].buildSpeed, 2);
    assert.deepEqual([result.rows[0].ladderMac, result.rows[0].ladderOther], [40, 20]);
    assert.equal(compare({ weeks: [] }, { weeks: [] }).secondsPerWork, null);
  } finally {
    slow.server.close();
    fast.server.close();
  }
});

test('the engine\'s own statement of its limits is read when there is one, and a refused key reads none', async () => {
  const { server, url } = await stub();
  try {
    assert.deepEqual(await timingOf({ url, key: KEY }), { solverMaxTimeSeconds: 180 });
    assert.equal(await timingOf({ url, key: 'wrong' }), null);
  } finally {
    server.close();
  }
});

test('measure from the command line writes a result that never holds the key or the address, and refuses to run without a key', async () => {
  const { server, url } = await stub({ solvesFrom: 10 });
  const dir = mkdtempSync(join(tmpdir(), 'calib-'));
  try {
    writeFileSync(join(dir, 'one.json'), JSON.stringify({ requestId: 'x' }));
    const out = join(dir, 'out.json');
    const script = new URL('./solve-corpus-calibrate.mjs', import.meta.url).pathname;
    // Asynchronous: the stub answers in THIS process, which a synchronous spawn would block.
    const run = (env) => new Promise((resolve) => {
      const child = spawn(process.execPath, [script, 'measure', '--url', url, '--payloads', dir, '--label', 'test', '--out', out, '--ladder', '10'], { env: { ...process.env, ...env } });
      let stderr = '';
      child.stderr.on('data', (c) => (stderr += c));
      child.on('close', (status) => resolve({ status, stderr }));
    });
    const refused = await run({ ENGINE_API_KEY: '' });
    assert.equal(refused.status, 2);
    const ok = await run({ ENGINE_API_KEY: KEY });
    assert.equal(ok.status, 0, ok.stderr);
    const text = readFileSync(out, 'utf8');
    assert.ok(!text.includes(KEY) && !text.includes('127.0.0.1'));
    const result = JSON.parse(text);
    assert.equal(result.label, 'test');
    assert.equal(result.callerLoad.length, 2);
    assert.equal(result.weeks[0].name, 'one');
    assert.equal(result.weeks[0].ladder.solvedWithin, 10);
    assert.deepEqual(result.timing, { solverMaxTimeSeconds: 180 });
  } finally {
    server.close();
  }
});

const TABLE = [
  { work: 0.5, deterministic: 0.5, conflicts: 100 },
  { work: 1, deterministic: 1, conflicts: 300 },
  { work: 2, deterministic: 2, conflicts: null },
];

test('work is read off the table by straight lines from the origin, and never beyond its last conflict count', () => {
  assert.equal(workAt(TABLE, 50), 0.25);
  assert.equal(workAt(TABLE, 100), 0.5);
  assert.equal(workAt(TABLE, 200), 0.75);
  assert.equal(workAt(TABLE, 300), 1);
  assert.equal(workAt(TABLE, 301), null);
  assert.equal(workAt([], 5), null);
});

test('convert gives seconds per deterministic second from a probe\'s conflicts and seconds, and the median over the weeks', () => {
  const week = (name, seconds, conflicts) => ({ name, probe: { report: { phases: [{ phase: 'CLEAN', seconds, conflicts }] } } });
  const result = convert(
    { label: 'x', cores: 4, weeks: [week('a', 20, 200), week('b', 10, 100), week('c', 20, 9999), { name: 'd', probe: { report: null } }, week('e', 5, 50)] },
    { a: TABLE, b: TABLE, c: TABLE, d: TABLE },
  );
  // a: 200 conflicts = 0.75 work in 20 s; b: 100 = 0.5 in 10 s; c past the table; d has no report; e no table.
  assert.deepEqual(result.rows.map((r) => [r.name, r.work, r.secondsPerWork]), [['a', 0.75, 26.7], ['b', 0.5, 20], ['c', null, null]]);
  assert.equal(result.secondsPerWork, 23.4);
  assert.equal(result.cores, 4);
});
