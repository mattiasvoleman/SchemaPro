#!/usr/bin/env node
/**
 * API latency benchmark.
 *
 * Engineering spec §2: "API P99 Latency ≤ 50ms for read queries, ≤ 150ms for
 * updates".
 *
 * Drives autocannon against a *running* API and prints every scenario's p50,
 * p99, max and throughput, with §2's target beside it as information. The run
 * passes or fails on latency-gate.mjs: each authenticated read's throughput as
 * a share of the same run's authenticated-read floor (FLOOR below), and an
 * absolute guard on health and on the floor. Absolute milliseconds on a shared
 * runner move with the runner, and so does health's throughput against a read's
 * (it follows the CPU model the runner drew); that module has the runs, the
 * thresholds and why. Reads and writes are measured separately because they
 * have different cost profiles.
 *
 *   node scripts/bench/api-latency.mjs --url http://localhost:4000 \
 *     --token "$JWT" --academic-year "$YEAR" --write-body body.json --duration 20
 *
 * Exits 0 on PASS, 1 on FAIL and 2 on an invalid run: more than 1% of any row's
 * attempts failed (non-2xx answers, connection errors, timeouts), or health,
 * either read or the floor not measured.
 *
 * `--floor-rounds` (default 3) is the number of rounds of the floor, which run
 * straight after the load scenarios and before the serial write — see FLOOR.
 * `--json` prints the rows and the verdict as JSON instead of the report.
 *
 * Requires a real database behind the API: the numbers are meaningless against
 * a mocked Prisma layer, since the transaction and RLS cost is the thing being
 * measured. In CI this runs against the docker-compose stack.
 *
 * `--token` must be a valid JWT for a seeded principal. Without it every
 * request 401s and the latency measured is the guard's, not the query's — the
 * gate calls that run invalid rather than publish a flattering number.
 */

import { readFileSync } from 'node:fs';
import autocannon from 'autocannon';
import {
  exitCodeOf,
  gate,
  loadRow,
  scenarioLines,
  SPEC_READ_TARGET_MS,
  SPEC_UPDATE_TARGET_MS,
} from './latency-gate.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};

const BASE_URL = flag('--url', process.env.API_BASE_URL ?? 'http://localhost:4000');
const TOKEN = flag('--token', process.env.API_TOKEN ?? '');
const DURATION = Number(flag('--duration', '15'));
const CONNECTIONS = Number(flag('--connections', '25'));
const WRITE_BODY_FILE = flag('--write-body');
const ACADEMIC_YEAR_ID = flag('--academic-year', process.env.ACADEMIC_YEAR_ID);
const asJson = args.includes('--json');
const FLOOR_ROUNDS = Number(flag('--floor-rounds', '3'));

if (!(Number.isInteger(FLOOR_ROUNDS) && FLOOR_ROUNDS > 0)) {
  console.error('--floor-rounds must be a positive integer.');
  process.exit(2);
}

/**
 * Every scenario's row carries an `id`, and the gate matches on it, never on
 * the display name.
 *
 * Note on coverage: the gateway's *read* surface is deliberately small. The
 * web client queries Supabase directly (see web/lib/queries.ts), so this API
 * handles writes, AI proxying and the SS12000 integration feed rather than
 * list endpoints. The benchmark times two of the API's authenticated list
 * reads, not every GET it has — and only paths that exist: an invented one
 * would measure 404s.
 */
const SCENARIOS = [
  {
    id: 'health',
    name: 'GET /health/ready',
    kind: 'read',
    // `@Public()` and `@SkipThrottle()`: no bearer token, no identity lookup,
    // no transaction, no RLS — one bare `SELECT 1` on the pool. It is what the
    // framework and a pooled connection cost, NOT the floor of an authenticated
    // read, which also pays token verification, the identity lookup's
    // transaction, the guards and the RLS transaction its handler runs in.
    //
    // A read much slower than this is therefore not slow "in its own query".
    // On CI's seed the two lists below return [] — the seed creates no schedule
    // versions or optimization jobs — so their query matches no row, and their
    // distance above this row is that authenticated path.
    //
    // It was the gate's denominator until 2026-11-02 and is not now: how fast
    // it runs against an authenticated read depends on the CPU the runner drew
    // (a read's share of it was 0.12 on one model and 0.20 on another, same
    // code), so it keeps an absolute guard and a printed share, and decides
    // nothing else. latency-gate.mjs has the runs.
    request: { method: 'GET', path: '/health/ready' },
  },
  // The two authenticated reads are gated on their throughput as a share of
  // the floor's (FLOOR below); latency-gate.mjs has the runs that set it.
  // Their p99 is printed against §2's 50 ms and does not decide the run: on
  // the runner that target lies below the floor of every authenticated read,
  // which pays JWT verification, the identity lookup's transaction, the
  // guards, the RLS batch and serialisation around a query that here matches
  // no row.
  {
    id: 'read:schedule-versions',
    name: 'GET /api/v1/schedule-versions',
    kind: 'read',
    needsAcademicYear: true,
    request: { method: 'GET', path: '/api/v1/schedule-versions' },
  },
  {
    id: 'read:optimization-jobs',
    name: 'GET /api/v1/optimization/jobs',
    kind: 'read',
    needsAcademicYear: true,
    request: { method: 'GET', path: '/api/v1/optimization/jobs' },
  },
  {
    id: 'write',
    name: 'POST /api/v1/attendance/report',
    kind: 'update',
    // Attendance reporting is an upsert, so repeated identical calls converge
    // on the same rows instead of tripping a unique constraint or leaving
    // tens of thousands of records behind.
    //
    // It also carries its own `@Throttle({ limit: 10, ttl: 30_000 })`, far
    // stricter than the global limit. That is deliberate and correct for this
    // route, and it means the endpoint cannot be flood-tested: at full tilt
    // 99.9% of responses are 429 and the "latency" is the throttler's.
    //
    // 10 per 30s is 0.33 req/s, and autocannon's overallRate is an integer
    // ≥1 req/s — the allowance cannot be expressed to it at all. So this
    // scenario is sampled serially instead: spaced single requests, each
    // timed individually, every one a real upsert rather than a rejection.
    //
    // 300 samples, so p99 is rank 297. With 24 it was the slowest single
    // write, roughly their p96, and on a fresh database only the first sample
    // inserts. At one bucket's pace of 3.2 s, 300 would take 16 minutes, so
    // the samples rotate across trackers. ThrottlerGuard keys a bucket on
    // controller, handler, throttler name and tracker, and the tracker is
    // `req.ip` (@nestjs/throttler 6.5.0's default getTracker; nothing in src
    // replaces it). main.ts trusts one proxy hop, so `req.ip` is the single
    // X-Forwarded-For entry runSerial sends. Twelve of them in rotation at
    // 300 ms apart keep each bucket's hits ≥ 3.6 s apart — at most 9 inside
    // any 30 s, under the limit of 10. Were that wrong, the samples would be
    // 429s and the non-2xx check would fail the run instead.
    //
    // THE BASELINE. Halfway between two writes each sample also times one
    // serial GET of FLOOR's path, with the same token and X-Forwarded-For:
    // write, 150 ms, baseline, 150 ms. The two are adjacent in time and each
    // follows the other after the same idle, so the runner's CPU speed, the
    // authenticated path, the network stack and short disturbances cancel in
    // write ÷ baseline, and what remains is the write's own cost — WAL flush
    // and checkpoints included. The writes stay 300 ms plus latencies apart,
    // so the throttler arithmetic above is unchanged, and the GET counts in
    // its own handler's bucket. The ratio is printed at p50, p95 and p99 and
    // not gated until ten runs have calibrated it.
    serialSamples: 300,
    serialIntervalMs: 300,
    trackers: 12,
    baseline: {
      id: 'write-baseline',
      name: 'write baseline: GET floor, interleaved with the write',
      kind: 'baseline',
    },
    request: {
      method: 'POST',
      path: '/api/v1/attendance/report',
      headers: { 'content-type': 'application/json' },
      body: null,
    },
  },
];

/**
 * The gate's denominator, measured in rounds straight after the load scenarios
 * and before the serial write, so the reads and the floor they are divided by
 * run in the same stretch of the same machine's afternoon: 2026-11-02's
 * calibration put the floor after the write, and a runner that sped up during
 * the write's 100 s showed a read at 0.75 of it where the other eleven showed
 * 0.89–0.97. The gate takes the median of the rounds. Its rows count in the
 * non-2xx check — a floor made of 401s would be a flattering number. Its path
 * is also what the write's baseline samples serially, on every run.
 *
 * FLOOR is the cheapest request that pays everything a real authenticated read
 * pays: token verification, the identity lookup's transaction, the guards and
 * the throttler, ParseUUIDPipe, and the RLS transaction the handler's query
 * runs in under its policy. The year id is a valid v4 UUID naming no academic
 * year, so the answer is 200 [] rather than a 400 or a 404. It is an existing
 * route on purpose: the stack runs the production image, which should neither
 * ship a benchmark-only route nor be measured with a module graph production
 * does not have. Several rounds, because their spread beside the two list rows
 * is the run's own noise, and the first of them, which follows a read, still
 * ran 2–8% below the next two in all four older runs that measured them.
 */
const FLOOR = {
  name: 'floor: GET /api/v1/schedule-versions (no matching row)',
  kind: 'floor',
  request: {
    method: 'GET',
    path: '/api/v1/schedule-versions?academicYearId=00000000-0000-4000-8000-000000000000',
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const percentile = (sorted, p) =>
  sorted.length === 0
    ? 0
    : sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];

/** One request, timed from before fetch to the last byte of its body. */
async function timed(request, trackers, i) {
  const started = process.hrtime.bigint();
  let status = 0;
  try {
    const response = await fetch(`${BASE_URL}${request.path}`, {
      method: request.method,
      headers: {
        ...(request.headers ?? {}),
        ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
        // One throttler bucket per address; see the attendance scenario.
        ...(trackers ? { 'x-forwarded-for': `198.51.100.${(i % trackers) + 1}` } : {}),
      },
      body: request.body,
    });
    status = response.status;
    await response.arrayBuffer();
  } catch {
    status = 0;
  }
  return {
    ms: Number(process.hrtime.bigint() - started) / 1e6,
    ok: status >= 200 && status < 300,
  };
}

/**
 * A serial row. Its percentiles stay unrounded, and `rps` is null: the
 * baseline GET takes a few milliseconds, where a whole millisecond is 10% or
 * more, and a paced sampler has no throughput to speak of.
 */
function serialRow(scenario, { timings, non2xx }) {
  const sorted = [...timings].sort((a, b) => a - b);
  return {
    id: scenario.id,
    scenario: scenario.name,
    kind: scenario.kind,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    maxMs: sorted[sorted.length - 1] ?? 0,
    rps: null,
    totalRequests: timings.length,
    non2xx,
  };
}

/**
 * Serial sampler for endpoints whose own rate limit is below autocannon's
 * minimum. Returns the scenario's row and, with `baseline`, the row of the
 * GET interleaved with it.
 */
async function runSerial(scenario) {
  const n = scenario.serialSamples;
  const pause = scenario.baseline ? scenario.serialIntervalMs / 2 : scenario.serialIntervalMs;
  const own = { timings: [], non2xx: 0 };
  const base = { timings: [], non2xx: 0 };
  const record = (into, { ms, ok }) => {
    into.timings.push(ms);
    if (!ok) into.non2xx++;
  };

  for (let i = 0; i < n; i++) {
    record(own, await timed(scenario.request, scenario.trackers, i));
    if (scenario.baseline) {
      await sleep(pause);
      record(base, await timed(FLOOR.request, scenario.trackers, i));
    }
    if (i < n - 1) await sleep(pause);
  }

  const rows = [serialRow(scenario, own)];
  if (scenario.baseline) rows.push(serialRow(scenario.baseline, base));
  return rows;
}

function load(scenario) {
  return new Promise((resolvePromise, reject) => {
    autocannon(
      {
        url: BASE_URL,
        connections: scenario.connections ?? CONNECTIONS,
        duration: scenario.duration ?? DURATION,
        // A steady arrival rate is what P99 is meaningful against; pipelining
        // would measure throughput under queueing instead.
        pipelining: 1,
        headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {},
        requests: [scenario.request],
      },
      (err, result) => (err ? reject(err) : resolvePromise(result)),
    );
  });
}

// Write scenarios need ids from a seeded database. Rather than invent them,
// skip the scenario and say so. A skipped write prints SKIPPED and, while the
// write is not gated, does not fail the run; a skipped read leaves the gate
// without a numerator, and the run is invalid.
const writeBody = WRITE_BODY_FILE
  ? readFileSync(WRITE_BODY_FILE, 'utf8').trim()
  : null;

const skipped = [];
const runnable = SCENARIOS.filter((s) => {
  if (s.request.body === null) {
    if (!writeBody) {
      skipped.push(`${s.name} (no --write-body supplied)`);
      return false;
    }
    s.request.body = writeBody;
  }
  // These list endpoints scope by academic year and 400 without it; a run
  // that measured the validation-pipe rejection would be meaningless.
  if (s.needsAcademicYear) {
    if (!ACADEMIC_YEAR_ID) {
      skipped.push(`${s.name} (no --academic-year supplied)`);
      return false;
    }
    s.request.path += `?academicYearId=${ACADEMIC_YEAR_ID}`;
  }
  return true;
});

const results = [];

for (const scenario of runnable.filter((s) => !s.serialSamples)) {
  results.push(loadRow(scenario, await load(scenario)));
}

for (let round = 1; round <= FLOOR_ROUNDS; round++) {
  const scenario = {
    ...FLOOR,
    id: `floor:${round}`,
    name: `${FLOOR.name}, round ${round}/${FLOOR_ROUNDS}`,
    request: { ...FLOOR.request },
  };
  results.push(loadRow(scenario, await load(scenario)));
}

for (const scenario of runnable.filter((s) => s.serialSamples)) {
  results.push(...(await runSerial(scenario)));
}

const verdict = gate(results);

if (asJson) {
  console.log(JSON.stringify({ baseUrl: BASE_URL, results, skipped, gate: verdict }, null, 2));
} else {
  console.log(`Target: ${BASE_URL}  (${CONNECTIONS} connections, ${DURATION}s each)`);
  console.log(
    `§2 targets (p99 ≤ ${SPEC_READ_TARGET_MS}ms read, ≤ ${SPEC_UPDATE_TARGET_MS}ms update) ` +
      'are printed as information, not gated.\n',
  );
  for (const line of scenarioLines(results)) console.log(line);
  for (const s of skipped) console.log(`  – SKIPPED ${s}`);
  console.log('');
  for (const line of verdict.lines) console.log(line);
}

// exitCode rather than exit(): a piped stdout may still be flushing the report.
process.exitCode = exitCodeOf(verdict);
