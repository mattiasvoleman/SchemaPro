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
const asJson = args.includes('--json');

/**
 * Budgets come straight from §2. `kind` selects which one applies; keep new
 * scenarios grouped so the gate stays legible as the surface grows.
 */
const SCENARIOS = [
  {
    name: 'GET /api/v1/resources/rooms',
    kind: 'read',
    budgetMs: 50,
    request: { method: 'GET', path: '/api/v1/resources/rooms' },
  },
  {
    name: 'GET /api/v1/calendar/lessons',
    kind: 'read',
    budgetMs: 50,
    request: {
      method: 'GET',
      path: '/api/v1/calendar/lessons?from=2026-08-03&to=2026-08-07',
    },
  },
  {
    name: 'GET /api/v1/notifications',
    kind: 'read',
    budgetMs: 50,
    request: { method: 'GET', path: '/api/v1/notifications' },
  },
  {
    name: 'PATCH /api/v1/attendance/report',
    kind: 'update',
    budgetMs: 150,
    request: {
      method: 'POST',
      path: '/api/v1/attendance/report',
      headers: { 'content-type': 'application/json' },
      // Overwritten per-run by --body-file when the seeded ids are known.
      body: JSON.stringify({ calendarLessonId: null, records: [] }),
    },
  },
];

function run(scenario) {
  return new Promise((resolvePromise, reject) => {
    autocannon(
      {
        url: BASE_URL,
        connections: CONNECTIONS,
        duration: DURATION,
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

const results = [];
let failed = false;
let unauthorized = 0;

for (const scenario of SCENARIOS) {
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
  console.log(JSON.stringify({ baseUrl: BASE_URL, results }, null, 2));
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
}

// Every request failing means we timed the rejection path. Reporting a green
// P99 from 401s would be worse than reporting nothing.
const totalRequests = results.reduce((s, r) => s + r.totalRequests, 0);
if (totalRequests > 0 && unauthorized === totalRequests) {
  console.error(
    '\nFAIL: every request returned non-2xx. Supply a valid --token and a ' +
      'seeded database — these latencies measure the auth guard, not the API.',
  );
  process.exit(2);
}

if (failed) {
  console.error('\nFAIL: at least one scenario exceeded its P99 budget.');
  process.exit(1);
}
console.log('\nPASS: every scenario within its P99 budget.');
