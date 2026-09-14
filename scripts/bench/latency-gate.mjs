/**
 * The latency gate's verdict, apart from the measurement.
 *
 * Pure and import-free on purpose. api-latency.mjs imports autocannon, which
 * the nightly job installs --no-save and nothing else has, so a test that
 * imported the script could not run on a pull request. This module takes the
 * rows the script measured and returns what to print and how to exit, and
 * latency-gate.test.mjs proves it on the rows of real CI runs.
 *
 * WHY NOT MILLISECONDS. §2's targets (p99 ≤ 50 ms read, ≤ 150 ms update) are
 * printed for every row, and none of them decides the run. On the shared
 * 2-vCPU ubuntu-latest runner the same commit, 849858c, failed two of three
 * runs on absolute budgets — the write's p99 at 167 ms in one, a read's at
 * 181 ms in another — while GET /health/ready moved from 2708 to 1722 req/s
 * between them. The runner's speed moved the numbers, not the code.
 *
 * WHAT IS GATED. Each authenticated read's throughput as a share of the same
 * run's health throughput, both the unrounded req/s autocannon counted. At 25
 * closed-loop connections req/s is 25 ÷ mean latency, so the share is the
 * inverse ratio of mean latencies: it covers the whole distribution, rests on
 * thousands of counted requests rather than whole-millisecond percentiles, and
 * cancels the runner's speed. Over five runs, ten route shares, it ranged
 * 0.2259–0.2648 (median 0.2474) while health itself ranged 1722–2708 req/s.
 *
 * READ_SHARE_MIN = 0.20; exactly 0.20 passes. Three rules land there: min −
 * (median − min) = 0.2043, mean − 4σ = 0.2061, median × 0.8 = 0.1979. The
 * lowest share seen is 13% above it. A read whose per-request cost grows by x
 * fails when share ÷ (1 + x) < 0.20: from +12.9% in the slowest runner state
 * seen, +23.7% at the median, and in every state seen from +32.4%.
 *
 * WHAT IT CANNOT SEE. A regression on the path health shares — the framework,
 * the pool, a global interceptor — slows health too, and the share rises. Only
 * the absolute health guard below catches that, and only when it is large.
 *
 * THE HEALTH GUARD keeps the denominator honest: p99 ≤ 50 ms (§2's read
 * target, the one row that meets it, 22–32 ms seen) and ≥ 1000 req/s (1722–2708
 * seen). Passing both proves every read ≥ 200 req/s, a mean ≤ 125 ms at 25
 * connections, so a collapsed health window cannot turn a regression into a
 * pass.
 *
 * THE WRITE is measured against a serial GET of the floor interleaved with it,
 * and printed as write ÷ baseline at p50, p95 and p99 — not gated. Every p99
 * ratio against the load rows spread 2.9–3.4× over four runs; the interleaved
 * baseline needs ten runs of calibration before it has a threshold, and until
 * then a missing write is SKIPPED rather than invalid.
 *
 * The thresholds are calibrated for ubuntu-latest, 2 vCPU, 25 connections,
 * 20 s per read. A local Docker Desktop run is not comparable: its health p50
 * is a tenth of a read's, not a quarter, and it can fail the share.
 *
 * STILL INVALID, exit 2: more than 1% non-2xx in any row — latency over 401s
 * and 429s is not latency — and a required row that was not measured, since a
 * share without its numerator or denominator has no verdict.
 */

export const READ_SHARE_MIN = 0.2;
export const HEALTH_P99_MAX_MS = 50;
export const HEALTH_RPS_MIN = 1000;
export const MAX_NON_2XX_RATIO = 0.01;
export const SPEC_READ_TARGET_MS = 50;
export const SPEC_UPDATE_TARGET_MS = 150;

export const HEALTH = 'health';
export const READS = ['read:schedule-versions', 'read:optimization-jobs'];
export const WRITE = 'write';
export const WRITE_BASELINE = 'write-baseline';
const FLOOR_PREFIX = 'floor:';
const REQUIRED = [HEALTH, ...READS];

const SPEC_TARGET_MS = { read: SPEC_READ_TARGET_MS, update: SPEC_UPDATE_TARGET_MS };

/** 2 for an invalid run, 1 for a failed one, 0 for a pass. */
export const exitCodeOf = ({ failed, invalid }) => (invalid ? 2 : failed ? 1 : 0);

// Whole milliseconds as autocannon reports them; a serial sample's unrounded
// value to one decimal below 10 ms, where a whole millisecond is 10% or more.
const ms = (v) =>
  typeof v !== 'number' || !Number.isFinite(v)
    ? 'n/a'
    : Number.isInteger(v)
      ? `${v}ms`
      : v < 10
        ? `${v.toFixed(1)}ms`
        : `${Math.round(v)}ms`;

const reqs = (v) => (Number.isFinite(v) ? `${Math.round(v)}` : 'n/a');

const ratio = (a, b) =>
  typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && b > 0
    ? (a / b).toFixed(2)
    : 'n/a';

/**
 * A figure printed beside its threshold, rounded, unless rounding would put it
 * on the other side of the comparison made on the unrounded value: 354 ÷ 1771
 * = 0.19989 fails, and "0.200 < 0.20" would read as a bug in the gate. Then it
 * is cut away from the threshold instead.
 */
function beside(value, threshold, decimals, passed) {
  if (!Number.isFinite(value)) return 'n/a';
  const f = 10 ** decimals;
  let shown = Math.round(value * f) / f;
  if (!passed && value < threshold && shown >= threshold) shown = Math.floor(value * f) / f;
  if (!passed && value > threshold && shown <= threshold) shown = Math.ceil(value * f) / f;
  return shown.toFixed(decimals);
}

const label = (text) => text.padEnd(Math.max(20, text.length + 3));
const mark = (passed) => (passed ? '✓' : '✗');

/** Each measured row as two lines, with §2's target as information. */
export function scenarioLines(results) {
  const lines = [];
  for (const r of results) {
    const parts = [`p50 ${ms(r.p50Ms)}`];
    if (r.p95Ms !== undefined) parts.push(`p95 ${ms(r.p95Ms)}`);
    parts.push(`p99 ${ms(r.p99Ms)}`, `max ${ms(r.maxMs)}`);
    parts.push(r.rps == null ? `${r.totalRequests} serial samples` : `${reqs(r.rps)} req/s`);
    parts.push(`non-2xx ${r.non2xx}/${r.totalRequests}`);
    const target = SPEC_TARGET_MS[r.kind];
    if (target !== undefined) {
      parts.push(`§2 ${target}ms: ${r.p99Ms <= target ? 'met' : 'not met'}`);
    }
    lines.push(`  ${r.scenario}`, `      ${parts.join('   ')}`);
  }
  return lines;
}

/**
 * @param results rows of { id, scenario, kind, p50Ms, p95Ms?, p99Ms, maxMs,
 *   rps, totalRequests, non2xx }; `rps` is null for a serial row. Matched on
 *   `id`, never on the display name.
 * @returns {{ failed: boolean, invalid: boolean, lines: string[] }} — invalid
 *   implies failed; the caller exits 2, 1 or 0.
 */
export function gate(results) {
  const byId = new Map(results.map((r) => [r.id, r]));
  const health = byId.get(HEALTH);
  const lines = [
    `Gate, relative to this run's ${health?.scenario ?? 'GET /health/ready'} ` +
      '(calibrated on ubuntu-latest 2 vCPU, 25 connections):',
  ];

  // 1. Latency measured over error responses is not latency. Rejections are
  // cheap — a 429 never reaches a controller, a 401 never reaches a query — so
  // a run that is mostly non-2xx reports flattering numbers for work that
  // never happened. Tight rather than "all failed": the first version fired
  // only at 100%, and a real run came back 99.3% rate-limited and passed.
  const polluted = results.filter(
    (r) => r.totalRequests > 0 && r.non2xx / r.totalRequests > MAX_NON_2XX_RATIO,
  );
  for (const r of polluted) {
    const pct = ((r.non2xx / r.totalRequests) * 100).toFixed(1);
    lines.push(`  ✗ ${label('non-2xx')}${r.scenario}   ${pct}% (${r.non2xx}/${r.totalRequests})`);
  }

  // 2. A share with no numerator or no denominator has no verdict. Before the
  // gate was relative, a missing --academic-year skipped both reads and the
  // run printed PASS having measured only health.
  const missing = REQUIRED.filter((id) => !byId.has(id));
  for (const id of missing) lines.push(`  ✗ ${label('missing')}${id}`);

  const invalid = polluted.length > 0 || missing.length > 0;
  let failures = 0;

  if (health) {
    // 3. The absolute guard on the denominator.
    const p99Ok = health.p99Ms <= HEALTH_P99_MAX_MS;
    lines.push(
      `  ${mark(p99Ok)} ${label('health p99')}` +
        `${beside(health.p99Ms, HEALTH_P99_MAX_MS, 0, p99Ok)}ms ${p99Ok ? '≤' : '>'} ${HEALTH_P99_MAX_MS}ms`,
    );
    const rpsOk = health.rps >= HEALTH_RPS_MIN;
    lines.push(
      `  ${mark(rpsOk)} ${label('health throughput')}` +
        `${beside(health.rps, HEALTH_RPS_MIN, 0, rpsOk)} req/s ${rpsOk ? '≥' : '<'} ${HEALTH_RPS_MIN} req/s`,
    );
    if (!p99Ok) failures++;
    if (!rpsOk) failures++;

    // 4. The gate itself, compared unrounded. A share that is not a finite
    // number — health counted no request — is not a pass.
    const reads = READS.map((id) => byId.get(id)).filter(Boolean);
    const width = Math.max(0, ...reads.map((r) => r.scenario.length));
    for (const r of reads) {
      const share = r.rps / health.rps;
      const ok = Number.isFinite(share) && share >= READ_SHARE_MIN;
      if (!ok) failures++;
      lines.push(
        `  ${mark(ok)} ${label('read share')}${r.scenario.padEnd(width)}   ` +
          `${beside(share, READ_SHARE_MIN, 3, ok)} ${ok ? '≥' : '<'} ${READ_SHARE_MIN.toFixed(2)}   ` +
          `(${reqs(r.rps)} ÷ ${reqs(health.rps)} req/s)`,
      );
    }

    // 5. Information. Nothing below sets failed or invalid.
    const floors = results.filter((r) => r.id.startsWith(FLOOR_PREFIX));
    for (const r of floors) {
      const share = r.rps / health.rps;
      lines.push(
        `  · ${label('floor share')}round ${r.id.slice(FLOOR_PREFIX.length)}/${floors.length}   ` +
          `${Number.isFinite(share) ? share.toFixed(3) : 'n/a'}   ` +
          `(${reqs(r.rps)} ÷ ${reqs(health.rps)} req/s, not gated)`,
      );
    }

    const write = byId.get(WRITE);
    const baseline = byId.get(WRITE_BASELINE);
    lines.push(
      `  · ${label('write ÷ baseline')}` +
        (write && baseline
          ? `p50 ${ratio(write.p50Ms, baseline.p50Ms)}   p95 ${ratio(write.p95Ms, baseline.p95Ms)}   ` +
            `p99 ${ratio(write.p99Ms, baseline.p99Ms)}`
          : 'not measured') +
        '   (not gated until calibrated over 10 runs)',
    );
    lines.push(
      `  · ${label('write p50 ÷ health p50')}` +
        `${write ? ratio(write.p50Ms, health.p50Ms) : 'not measured'}   (not gated, fallback candidate)`,
    );
  }

  lines.push('');
  if (polluted.length > 0) {
    lines.push(
      `INVALID: ${polluted.length} scenario(s) exceeded ${MAX_NON_2XX_RATIO * 100}% non-2xx ` +
        'responses, so their latencies are not measurements of real work.',
      'Usual causes: an invalid --token (401), or the rate limiter rejecting the load (429). ' +
        'The benchmark drives far more traffic than THROTTLE_LIMIT allows by design, so raise ' +
        'THROTTLE_LIMIT on the target for the run — the throttler is not what this gate is measuring.',
    );
  }
  if (missing.length > 0) {
    lines.push(
      `INVALID: ${missing.length} required scenario(s) not measured (${missing.join(', ')}), ` +
        'and a share has no verdict without its numerator and its denominator.',
      'Usual cause: no --academic-year supplied, which skips both reads.',
    );
  }
  if (!invalid) {
    lines.push(
      failures > 0
        ? `FAIL: ${failures} gate(s) failed.`
        : 'PASS: health within its absolute guard and every authenticated read at least ' +
            `${READ_SHARE_MIN.toFixed(2)} of its throughput.`,
    );
  }

  return { failed: invalid || failures > 0, invalid, lines };
}
