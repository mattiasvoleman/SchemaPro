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
 * WHY NOT A SHARE OF HEALTH. The gate that replaced them was each read's
 * throughput as a share of the same run's health, ≥ 0.20, on the premise that
 * the runner's speed cancels. Five runs on the private repository's 2-vCPU
 * runners gave 0.2259–0.2648. The repository went public on 2026-09-30 and
 * the runs since are on 4-vCPU runners (lscpu: 4 on all 35 below), a mixed
 * pool. Run 41443397511 drew 35 of them for one tree: 19 AMD EPYC 7763, 9
 * EPYC 9V74, 6 EPYC 9V45 and one Xeon 8573C. On the sixteen that ran the
 * tree unchanged health ranged 2051–5341 req/s (2.6×) and the reads 403–689
 * (1.7×), so the share fell with the CPU: 0.188–0.199 on the nine 7763s,
 * 0.175–0.187 on the four 9V74s, 0.120–0.129 on the three 9V45s. Health is
 * one `SELECT 1` on the pool; a read is token verification, two transactions
 * and an RLS policy, and the two do not scale alike with the CPU. Of the 35
 * runs whose logs survive (2026-09-30 to 11-02) 32 had a read under 0.20, 31 of
 * the 34 scheduled ones, at shares of 0.121–0.205; the three scheduled runs
 * that passed, 10-03, 10-04 and 10-08, were 0.201–0.204.
 *
 * WHAT IS GATED. Each authenticated read's throughput as a share of the same
 * run's authenticated-read FLOOR — GET /api/v1/schedule-versions for a year
 * that does not exist, 200 [] after everything a real read pays — both the
 * unrounded req/s autocannon counted, the floor as the median of its three
 * rounds, which run straight after the reads (api-latency.mjs). The floor
 * moves with the CPU exactly as the reads do. Over the sixteen runs the 32
 * shares ranged 0.871–0.962, median 0.928, σ 0.018 (CV 2.1% on
 * schedule-versions and 1.5% on optimization/jobs), on all three models.
 *
 * READ_SHARE_MIN = 0.80; exactly 0.80 passes. The rules that bound it do not
 * agree this time: min − (median − min) = 0.8137, median × (1 − max(20%,
 * range ÷ min = 10.5%)) = 0.7426, and a one-sided 99%/95% tolerance bound
 * over the 16 runs' mean shares, 0.9275 − 3.464 × 0.0157 = 0.8730 — which
 * bounds a mean of two shares and lies on the lowest single share seen, so it
 * is not a threshold for one. 0.80 is the round number under the middle one.
 * It sits 8.2% below the lowest of the 32 shares. A read that becomes x more
 * expensive than the floor fails when share ÷ (1 + x) < 0.80: from +8.9% at
 * the lowest share seen, +16.0% at the median (0.928), +20.3% at the highest.
 *
 * ITS NOISE. A read's 20 s window sometimes runs slow beside its neighbours.
 * Of 93 windows that no injected change touched, 2 fell under 0.80: 0.792
 * (schedule-versions at 453 req/s against floor rounds of 563, 572 and 575,
 * in a run whose jobs carried twelve extra statements) and 0.748 (jobs, in
 * the first calibration, run 41441911608, where the floor rounds came after
 * the 100 s write instead of straight after the reads). The 93 are the final
 * calibration's 57 (the sixteen healthy runs' 32, schedule-versions in the 13
 * handler runs, both reads in the six path runs), the first's 24 and the
 * older private runs' 12, whose lowest is 0.833 (34839849296's jobs, the
 * window whose p99 was 181 ms). About one night in twenty is red on a
 * tree that has not changed: rerun it.
 *
 * WHAT THAT REACHES, ON A HANDLER. The same tree with K extra statements
 * compiled into optimization/jobs only, on 13 further runners of the same
 * three models (run 41443397511). What was measured is K: two statements
 * passed 3 of 3 (0.828–0.853), four failed 4 of 4 (0.752–0.787), eight 3 of 3
 * (0.647–0.682) and twelve 3 of 3 (0.567–0.648); three was never run. The
 * cost of the read is derived from the share (the healthy median 0.932 ÷ the
 * variant's mean): about +10%, +22%, +40% and +53%, some 5% a statement, so the
 * line between pass and fail lies between about +11% and +22%. The old gate saw
 * the same thirteen runs at 0.094–0.174 on jobs against its 0.20: it failed
 * all of them, and the healthy tree with them.
 *
 * WHAT EACH READ CATCHES. Only optimization/jobs is a handler the floor does not
 * share. The floor is the schedule-versions route for a year that does not
 * exist, and the schedule-versions read is the same route, controller and
 * handler for the benchmark's year; only the UUID differs. A regression in
 * that handler slows the read and the floor alike, so that share moves only
 * with what grows with the year's rows (the seed has none) and otherwise
 * measures noise and a constant level difference of 7–8% (the floor ran that
 * far above both reads; the order, floor last, and the year that exists
 * against the one that does not cannot be told apart in the runs). It stayed
 * at 0.79–1.03 beside the changed handler, and below 0.80 once (the 0.792
 * above). In effect the gate checks one handler; a second needs a floor none of
 * the gated reads shares, and a new denominator needs new history.
 *
 * WHAT IT CANNOT SEE. A regression on the path every authenticated request
 * shares — the token, the identity lookup, the guards, the RLS transaction —
 * slows the floor as much as the read, so no share moves: with four extra
 * statements in each of a request's two transactions the shares stayed at
 * 0.92–0.95 while the floor fell from 455 to 338 req/s (+35% a request).
 * That is what the share of health used to see, and it saw it only on the one
 * CPU it was calibrated on. What is left is two absolute guards, and they
 * are coarse:
 *
 * THE FLOOR GUARD, ≥ 300 req/s: the lowest healthy floor seen is 414 (433 on
 * the sixteen), so 300 sits 28% below it. It bounds the denominator, as
 * health's guard does, and passes every read ≥ 240 req/s whatever the floor
 * did. It fires at about +50% on a request on the slowest model and later on
 * the faster ones: 338 req/s passed it, 205 (twelve extra statements,
 * +120%) failed. Within one CPU model the floor ÷ health ratio is steady
 * (0.206–0.215 on the nine 7763s) and fell to 0.154 and 0.097 in those two
 * runs, so a comparison against the same model's nights would see what the
 * guard does not; the workflow prints the model for that, and nothing here
 * gates on it, since a model nobody has calibrated has no baseline.
 *
 * THE HEALTH GUARD bounds the other end: p99 ≤ 50 ms (§2's read target, the
 * one row that meets it, 12–32 ms seen) and ≥ 1000 req/s (1722–5715 seen). A
 * regression on the path health shares — the framework, the pool, a global
 * interceptor — slows the floor too, so no share sees it either; only this
 * guard can, and only when it is large.
 *
 * THE SHARE OF HEALTH is still printed for every read and for the floor, and
 * decides nothing, so that a night can be set beside the old ones.
 *
 * THE WRITE is measured against a serial GET of the floor interleaved with it,
 * and printed as write ÷ baseline at p50, p95 and p99 — not gated. Every p99
 * ratio against the load rows spread 2.9–3.4× over four runs; the interleaved
 * baseline needs ten runs of calibration before it has a threshold, and until
 * then a missing write is SKIPPED rather than invalid.
 *
 * The thresholds are calibrated for ubuntu-latest, 25 connections, 20 s per
 * read, on the 4-vCPU runners of a public repository. A local Docker Desktop
 * run is not comparable: its health p50 is a tenth of a read's, not a quarter.
 *
 * STILL INVALID, exit 2: more than 1% non-2xx in any row — latency over 401s
 * and 429s is not latency — and a required row that was not measured, since a
 * share without its numerator or denominator has no verdict. A run without
 * floor rounds is such a run.
 */

export const READ_SHARE_MIN = 0.8;
export const FLOOR_RPS_MIN = 300;
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
const FLOOR_ROUNDS_ROW = 'floor rounds';
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

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

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
  const floors = results.filter((r) => r.id.startsWith(FLOOR_PREFIX));
  const floor = floors.length > 0 ? median(floors.map((r) => r.rps)) : undefined;
  const lines = [
    `Gate, relative to this run's authenticated-read floor, the median of its ${floors.length} round(s) ` +
      '(calibrated on ubuntu-latest, 25 connections):',
  ];

  // 1. Latency measured over error responses is not latency. Rejections are
  // cheap — a 429 never reaches a controller, a 401 never reaches a query — so
  // a run that is mostly non-2xx reports flattering numbers for work that
  // never happened. Tight rather than "all failed": the first version fired
  // only at 100%, and a real run came back 99.3% rate-limited and passed.
  const failedOf = (r) => r.non2xx + (r.errors ?? 0) + (r.timeouts ?? 0);
  const attemptsOf = (r) => r.totalRequests + (r.errors ?? 0) + (r.timeouts ?? 0);
  const polluted = results.filter((r) => attemptsOf(r) > 0 && failedOf(r) / attemptsOf(r) > MAX_NON_2XX_RATIO);
  for (const r of polluted) {
    const pct = ((failedOf(r) / attemptsOf(r)) * 100).toFixed(1);
    const detail =
      (r.errors ?? 0) + (r.timeouts ?? 0) > 0 ? `; non-2xx ${r.non2xx}, errors ${r.errors ?? 0}, timeouts ${r.timeouts ?? 0}` : '';
    lines.push(`  ✗ ${label('non-2xx')}${r.scenario}   ${pct}% (${failedOf(r)}/${attemptsOf(r)}${detail})`);
  }

  // 2. A share with no numerator or no denominator has no verdict. Before the
  // gate was relative, a missing --academic-year skipped both reads and the
  // run printed PASS having measured only health.
  const missing = REQUIRED.filter((id) => !byId.has(id));
  if (floors.length === 0) missing.push(FLOOR_ROUNDS_ROW);
  for (const id of missing) lines.push(`  ✗ ${label('missing')}${id}`);

  const invalid = polluted.length > 0 || missing.length > 0;
  let failures = 0;

  if (health) {
    // 3. The absolute guard on health.
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
  }

  if (floor !== undefined) {
    // 4. The absolute guard on the floor: the one place a regression on the
    // path every authenticated request shares can show, since the reads are
    // divided by that path.
    // Every round, not the median: a round that counted nothing is a floor that did not hold,
    // and two good rounds beside it must not hide it (430, 430, 0 is a median of 430).
    const lowest = Math.min(...floors.map((r) => r.rps));
    const floorOk = lowest >= FLOOR_RPS_MIN;
    lines.push(
      `  ${mark(floorOk)} ${label('floor throughput')}` +
        `${beside(floorOk ? floor : lowest, FLOOR_RPS_MIN, 0, floorOk)} req/s ${floorOk ? '≥' : '<'} ${FLOOR_RPS_MIN} req/s   ` +
        `(${floorOk ? 'median' : `its lowest round; median ${reqs(floor)}`} of ${floors.map((r) => reqs(r.rps)).join(', ')})`,
    );
    if (!floorOk) failures++;

    // 5. The gate itself, compared unrounded. A share that is not a finite
    // number — the floor counted no request — is not a pass.
    const reads = READS.map((id) => byId.get(id)).filter(Boolean);
    const width = Math.max(0, ...reads.map((r) => r.scenario.length));
    for (const r of reads) {
      const share = r.rps / floor;
      const ok = Number.isFinite(share) && share >= READ_SHARE_MIN;
      if (!ok) failures++;
      lines.push(
        `  ${mark(ok)} ${label('read share')}${r.scenario.padEnd(width)}   ` +
          `${beside(share, READ_SHARE_MIN, 3, ok)} ${ok ? '≥' : '<'} ${READ_SHARE_MIN.toFixed(2)}   ` +
          `(${reqs(r.rps)} ÷ ${reqs(floor)} req/s)`,
      );
    }
  }

  if (health) {
    // 6. Information. Nothing below sets failed or invalid. The reads' and the
    // floor's share of health was the gate until it failed every night on a
    // healthy tree; it is kept printed so that a night's number can still be
    // set beside the old ones.
    for (const r of READS.map((id) => byId.get(id)).filter(Boolean)) {
      lines.push(
        `  · ${label('read ÷ health')}${r.scenario}   ` +
          `${ratio(r.rps, health.rps)}   (${reqs(r.rps)} ÷ ${reqs(health.rps)} req/s, not gated)`,
      );
    }
    if (floor !== undefined) {
      lines.push(
        `  · ${label('floor ÷ health')}${ratio(floor, health.rps)}   ` +
          `(${reqs(floor)} ÷ ${reqs(health.rps)} req/s, not gated)`,
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
        : 'PASS: health and the floor within their absolute guards and every authenticated read at least ' +
            `${READ_SHARE_MIN.toFixed(2)} of the floor's throughput.`,
    );
  }

  return { failed: invalid || failures > 0, invalid, lines };
}
