#!/usr/bin/env node
/**
 * API latency gate.
 *
 * Engineering spec §2: "API P99 Latency ≤ 50ms for read queries, ≤ 150ms for
 * updates".
 *
 * Drives autocannon against a *running* API and asserts the per-scenario P99.
 * Reads and writes are measured separately because they have different budgets
 * and different cost profiles (writes open a serializable transaction).
 *
 *   node scripts/bench/api-latency.mjs --url http://localhost:4000 \
 *     --token "$JWT" --duration 20
 *
 * Requires a real database behind the API: the numbers are meaningless against
 * a mocked Prisma layer, since the transaction and RLS cost is the thing being
 * measured. In CI this runs against the docker-compose stack.
 *
 * `--token` must be a valid JWT for a seeded principal. Without it every
 * request 401s and the latency measured is the guard's, not the query's — the
 * script refuses to report in that case rather than publish a flattering number.
 */

import { readFileSync } from 'node:fs';
import autocannon from 'autocannon';

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

/**
 * Budgets come straight from §2. `kind` selects which one applies.
 *
 * Note on coverage: the gateway's *read* surface is deliberately small. The
 * web client queries Supabase directly (see web/lib/queries.ts), so this API
 * handles writes, AI proxying and the SS12000 integration feed rather than
 * list endpoints. These are the JWT-authenticated GETs that actually exist —
 * do not add invented paths here, they would measure 404s.
 */
const SCENARIOS = [
  {
    name: 'GET /health/ready',
    kind: 'read',
    budgetMs: 50,
    // Public, and one `SELECT 1` round trip. This is the floor: whatever it
    // costs is pure framework + connection overhead, so a read endpoint that
    // is much slower is slow in its own query, not in the stack.
    request: { method: 'GET', path: '/health/ready' },
  },
  {
    name: 'GET /api/v1/schedule-versions',
    kind: 'read',
    budgetMs: 50,
    needsAcademicYear: true,
    request: { method: 'GET', path: '/api/v1/schedule-versions' },
  },
  {
    name: 'GET /api/v1/optimization/jobs',
    kind: 'read',
    budgetMs: 50,
    needsAcademicYear: true,
    request: { method: 'GET', path: '/api/v1/optimization/jobs' },
  },
  {
    name: 'POST /api/v1/attendance/report',
    kind: 'update',
    budgetMs: 150,
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
    // timed individually. Far fewer samples than a flood, so treat the p99
    // as indicative; every sample is a real upsert rather than a rejection.
    serialSamples: 24,
    serialIntervalMs: 3200,
    request: {
      method: 'POST',
      path: '/api/v1/attendance/report',
      headers: { 'content-type': 'application/json' },
      body: null,
    },
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const percentile = (sorted, p) =>
  sorted.length === 0
    ? 0
    : sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];

/**
 * Serial sampler for endpoints whose own rate limit is below autocannon's
 * minimum. Shaped to look like an autocannon result so the reporting below
 * does not have to special-case it.
 */
async function runSerial(scenario) {
  const timings = [];
  let non2xx = 0;

  for (let i = 0; i < scenario.serialSamples; i++) {
    const started = process.hrtime.bigint();
    let status = 0;
    try {
      const response = await fetch(`${BASE_URL}${scenario.request.path}`, {
        method: scenario.request.method,
        headers: {
          ...(scenario.request.headers ?? {}),
          ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
        },
        body: scenario.request.body,
      });
      status = response.status;
      await response.arrayBuffer();
    } catch {
      status = 0;
    }
    timings.push(Number(process.hrtime.bigint() - started) / 1e6);
    if (status < 200 || status >= 300) non2xx++;
    if (i < scenario.serialSamples - 1) await sleep(scenario.serialIntervalMs);
  }

  const sorted = [...timings].sort((a, b) => a - b);
  return {
    latency: {
      p50: Math.round(percentile(sorted, 50)),
      p99: Math.round(percentile(sorted, 99)),
      max: Math.round(sorted[sorted.length - 1] ?? 0),
    },
    requests: { total: timings.length, average: 1000 / scenario.serialIntervalMs },
    non2xx,
  };
}

function run(scenario) {
  if (scenario.serialSamples) return runSerial(scenario);
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
// skip the scenario and say so — a silently-omitted write budget would let the
// gate report green while never having exercised a write.
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
let failed = false;
let unauthorized = 0;

for (const scenario of runnable) {
  const result = await run(scenario);
  const non2xx = result.non2xx ?? 0;
  const total = result.requests?.total ?? 0;
  unauthorized += non2xx;

  const row = {
    scenario: scenario.name,
    kind: scenario.kind,
    budgetMs: scenario.budgetMs,
    p50Ms: result.latency.p50,
    p99Ms: result.latency.p99,
    maxMs: result.latency.max,
    requestsPerSecond: Math.round(result.requests.average),
    totalRequests: total,
    non2xx,
  };
  results.push(row);

  if (row.p99Ms > scenario.budgetMs) failed = true;
}

if (asJson) {
  console.log(JSON.stringify({ baseUrl: BASE_URL, results, skipped }, null, 2));
} else {
  console.log(`Target: ${BASE_URL}  (${CONNECTIONS} connections, ${DURATION}s each)\n`);
  for (const r of results) {
    const mark = r.p99Ms > r.budgetMs ? '✗' : '✓';
    console.log(
      `  ${mark} ${r.scenario}\n` +
        `      p50 ${r.p50Ms}ms   p99 ${r.p99Ms}ms   max ${r.maxMs}ms   ` +
        `budget ${r.budgetMs}ms   ${r.requestsPerSecond} req/s   ` +
        `non-2xx ${r.non2xx}/${r.totalRequests}`,
    );
  }
  for (const s of skipped) console.log(`  – SKIPPED ${s}`);
}

// Latency measured over error responses is not latency. Rejections are cheap —
// a 429 from the throttler never reaches a controller, and a 401 never reaches
// a query — so a run that is mostly non-2xx reports a flatteringly low P99 for
// work that never happened.
//
// The threshold is deliberately tight rather than "all failed": the first
// version of this check only fired at 100%, and a real run came back 99.3%
// rate-limited and still printed PASS.
const MAX_NON_2XX_RATIO = 0.01;
const polluted = results.filter(
  (r) => r.totalRequests > 0 && r.non2xx / r.totalRequests > MAX_NON_2XX_RATIO,
);

if (polluted.length > 0) {
  console.error(
    `\nFAIL: ${polluted.length} scenario(s) exceeded ${MAX_NON_2XX_RATIO * 100}% ` +
      'non-2xx responses, so their latencies are not measurements of real work:',
  );
  for (const r of polluted) {
    const pct = ((r.non2xx / r.totalRequests) * 100).toFixed(1);
    console.error(`  ${r.scenario} — ${pct}% non-2xx (${r.non2xx}/${r.totalRequests})`);
  }
  console.error(
    '\nUsual causes: an invalid --token (401), or the rate limiter rejecting ' +
      'the load (429). The benchmark drives far more traffic than THROTTLE_LIMIT ' +
      'allows by design, so raise THROTTLE_LIMIT on the target for the run — ' +
      'the throttler is not what this gate is measuring.',
  );
  process.exit(2);
}

if (failed) {
  console.error('\nFAIL: at least one scenario exceeded its P99 budget.');
  process.exit(1);
}
console.log('\nPASS: every scenario within its P99 budget.');
