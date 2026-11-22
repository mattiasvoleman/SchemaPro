/**
 * Calibrating a running engine against the corpus: how fast is THIS engine's processor?
 * (omgång 13, M5; docs/DEPLOYMENT.md §35.5, roadmap decision 8)
 *
 *   ENGINE_API_KEY=… node scripts/bench/solve-corpus-calibrate.mjs measure \
 *       --url https://<engine> --payloads <dir of week JSON> --label production-plan --out prod.json
 *   node scripts/bench/solve-corpus-calibrate.mjs convert prod.json trajectory.json
 *   node scripts/bench/solve-corpus-calibrate.mjs compare mac.json prod.json
 *   node --test scripts/bench/solve-corpus-calibrate.test.mjs
 *
 * WHY THIS AND NOT corpus_measure.py. The engine's image copies only `app/`, so the measuring stick
 * (benchmarks/) is not on an instance made from it, and the engine's own HTTP route is what an
 * instance has. That route does not say deterministic time. What it does say is enough to compare
 * the processor with the one the corpus was timed on:
 *
 *   check-week  the quick checks of a week (Python and a little CP-SAT), as wall seconds: the same
 *               work on every machine, so the ratio of two machines is their speed.
 *   probe       one worker and a fixed seed on a week the search gives up on, with a short budget:
 *               the TIMEOUT answer carries the engine's own account (M2): the seconds of each step
 *               (PRECHECKS, BUILD) and, for each search, how many conflicts CP-SAT had made in how
 *               many seconds. The search is the same on every machine, so conflicts per second is
 *               the search's speed.
 *   ladder      the same week with every core and growing budgets (10, 20, 40 … s): the smallest
 *               budget that gets a timetable. This is the clock table of §35.2 for this engine's
 *               cores, at the resolution of the ladder (a solved request runs its phase 2 to the end
 *               of its budget, so the wall time of a solved request says nothing about when the
 *               timetable was found).
 *
 * `convert` is the method: it reads each probe's conflicts and seconds against the table that
 * optimization-engine/benchmarks/corpus_trajectory.py wrote (conflicts at each deterministic second of
 * the same week's first search, the same on every machine) and gives the seconds per deterministic
 * second of the engine's processor: the number that replaces 18 in §35.2. It needs no baseline run on a
 * quiet machine, and it gives the same answer for the local engine under load as the table's own
 * conflicts say, which is how the method is checked. `compare` is the older way, the ratio of two runs'
 * paces, and needs the baseline to be quiet.
 *
 * NEVER A SECRET IN THE OUTPUT. The key is read from the environment, sent as X-API-Key and never
 * printed or written; the output names the run by its label, not by the URL. The weeks are the
 * corpus's own, built from no school's data.
 */

import { readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { pathToFileURL } from 'node:url';

/** Budgets, in seconds, of the all-cores ladder (the engine takes 5–600). */
export const LADDER = [10, 20, 40, 80, 160];
export const PROBE_SECONDS = 20;
/** Seconds per deterministic second of one worker on the dev Mac when it was quiet (docs §35.2). */
export const MAC_SECONDS_PER_WORK = 18;

const SOLVED = new Set(['OPTIMAL', 'FEASIBLE']);
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const round = (value, digits = 3) => (value === null || value === undefined ? null : Number(value.toFixed(digits)));

/** The request with a `search` block: one worker and a seed, or every core. */
export const withSearch = (request, search) => ({ ...request, search: { probes: false, ...search } });

/** What a TIMEOUT answer says of the engine's own clock: stage seconds and each search's pace. */
export function reportOf(answer) {
  const report = answer?.report;
  if (!report) return null;
  const stages = Object.fromEntries((report.stages ?? []).map((s) => [s.stage, s.seconds]));
  const phases = (report.search?.phases ?? []).map((p) => ({
    phase: p.phase,
    seconds: p.seconds,
    conflicts: p.conflicts,
    conflictsPerSecond: p.seconds > 0 && typeof p.conflicts === 'number' ? round(p.conflicts / p.seconds, 1) : null,
  }));
  return { totalSeconds: report.totalSeconds, stages, phases };
}

async function post(fetchFn, base, key, path, body, seconds) {
  const started = performance.now();
  const response = await fetchFn(new URL(path, base), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout((seconds + 90) * 1000),
  });
  const wall = (performance.now() - started) / 1000;
  const answer = response.ok ? await response.json() : null;
  return { httpStatus: response.status, wall: round(wall, 2), answer };
}

/** One week through the three steps. `fetchFn` is injectable for the tests. */
export async function measureWeek({ fetchFn = fetch, url, key, name, request, ladder = LADDER, probeSeconds = PROBE_SECONDS }) {
  const check = await post(fetchFn, url, key, '/api/v1/check-week', request, 30);
  const probe = await post(fetchFn, url, key, '/api/v1/optimize', withSearch(request, { workers: 1, seed: 1, maxSeconds: probeSeconds }), probeSeconds);
  const rungs = [];
  let solvedWithin = null;
  for (const budget of ladder) {
    const step = await post(fetchFn, url, key, '/api/v1/optimize', withSearch(request, { seed: 1, maxSeconds: budget }), budget);
    const status = step.answer?.status ?? `HTTP ${step.httpStatus}`;
    rungs.push({ budget, status, wall: step.wall });
    if (SOLVED.has(status)) {
      solvedWithin = budget;
      break;
    }
  }
  return {
    name,
    checkWeek: { httpStatus: check.httpStatus, wall: check.wall, verdict: check.answer?.verdict ?? null },
    probe: {
      httpStatus: probe.httpStatus,
      status: probe.answer?.status ?? null,
      wall: probe.wall,
      report: reportOf(probe.answer),
    },
    ladder: { rungs, solvedWithin },
  };
}

/** The engine's own statement of its limits, to read the run by (GET /api/v1/timing); null when it has none. */
export async function timingOf({ fetchFn = fetch, url, key }) {
  try {
    const response = await fetchFn(new URL('/api/v1/timing', url), { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(15000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

/** Two runs side by side: what each machine did, the ratios, and the factor for the second. */
export function compare(mac, other, { macSecondsPerWork = MAC_SECONDS_PER_WORK } = {}) {
  const byName = new Map(other.weeks.map((w) => [w.name, w]));
  const rows = [];
  for (const a of mac.weeks) {
    const b = byName.get(a.name);
    if (!b) continue;
    const ratio = (x, y) => (typeof x === 'number' && typeof y === 'number' && y > 0 ? round(x / y, 3) : null);
    const pace = (w) => w.probe?.report?.phases?.[0]?.conflictsPerSecond ?? null;
    rows.push({
      name: a.name,
      // > 1 means the second machine is FASTER (it did more in the same time, or the same in less).
      checkWeekSpeed: ratio(a.checkWeek.wall, b.checkWeek.wall),
      buildSpeed: ratio(a.probe?.report?.stages?.BUILD, b.probe?.report?.stages?.BUILD),
      searchSpeed: ratio(pace(b), pace(a)),
      ladderMac: a.ladder.solvedWithin,
      ladderOther: b.ladder.solvedWithin,
    });
  }
  const searchSpeeds = rows.map((r) => r.searchSpeed).filter((v) => v !== null);
  const speed = median(searchSpeeds);
  return {
    rows,
    searchSpeedMedian: round(speed),
    // One worker's seconds per deterministic second on the second machine: the Mac's, divided by how
    // much faster the second machine searches. Null when no week gave a pace.
    secondsPerWork: speed ? round(macSecondsPerWork / speed, 1) : null,
    note: 'searchSpeed = conflicts per second of the second run over the first (one worker, a TIMEOUT answer\'s own account); '
      + 'the ladder columns are the smallest budget, in seconds, that got a timetable with every core (null: none).',
  };
}

/**
 * The deterministic seconds at which a search had made `conflicts` conflicts, by straight lines between the
 * table's points (and from the origin). Null beyond the table: nothing is extrapolated.
 */
export function workAt(points, conflicts) {
  const usable = points.filter((p) => typeof p.conflicts === 'number').sort((a, b) => a.deterministic - b.deterministic);
  let before = { deterministic: 0, conflicts: 0 };
  for (const point of usable) {
    if (conflicts <= point.conflicts) {
      const span = point.conflicts - before.conflicts;
      return span > 0 ? before.deterministic + ((conflicts - before.conflicts) / span) * (point.deterministic - before.deterministic) : before.deterministic;
    }
    before = point;
  }
  return null;
}

/** Seconds per deterministic second for each probe that has a table, and their median. */
export function convert(result, trajectories) {
  const rows = [];
  for (const week of result.weeks) {
    const phase = week.probe?.report?.phases?.[0];
    const points = trajectories[week.name];
    if (!phase || !points || typeof phase.conflicts !== 'number') continue;
    const work = workAt(points, phase.conflicts);
    rows.push({
      name: week.name,
      conflicts: phase.conflicts,
      phaseSeconds: phase.seconds,
      work: round(work),
      secondsPerWork: work ? round(phase.seconds / work, 1) : null,
    });
  }
  const values = rows.map((r) => r.secondsPerWork).filter((v) => v !== null);
  return {
    label: result.label,
    cores: result.cores,
    callerLoad: result.callerLoad ?? null,
    rows,
    secondsPerWork: round(median(values), 1),
    note: 'secondsPerWork = the first search\'s seconds over the deterministic work the table says its conflicts took; '
      + 'null where the conflicts passed the end of the table.',
  };
}

function argOf(flag, argv = process.argv) {
  const index = argv.indexOf(flag);
  return index === -1 ? null : argv[index + 1];
}

async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (command === 'compare') {
    const [macPath, otherPath] = rest;
    if (!macPath || !otherPath) {
      console.error('usage: solve-corpus-calibrate.mjs compare mac.json other.json');
      return 2;
    }
    console.log(JSON.stringify(compare(JSON.parse(readFileSync(macPath, 'utf8')), JSON.parse(readFileSync(otherPath, 'utf8'))), null, 2));
    return 0;
  }
  if (command === 'convert') {
    const [resultPath, tablePath] = rest;
    if (!resultPath || !tablePath) {
      console.error('usage: solve-corpus-calibrate.mjs convert result.json trajectory.json');
      return 2;
    }
    console.log(JSON.stringify(convert(JSON.parse(readFileSync(resultPath, 'utf8')), JSON.parse(readFileSync(tablePath, 'utf8'))), null, 2));
    return 0;
  }
  if (command !== 'measure') {
    console.error('usage: solve-corpus-calibrate.mjs measure --url <engine> --payloads <dir> --label <text> --out <file> | convert result.json trajectory.json | compare a.json b.json');
    return 2;
  }
  const key = process.env.ENGINE_API_KEY;
  const url = argOf('--url', rest);
  const dir = argOf('--payloads', rest);
  const out = argOf('--out', rest);
  if (!key || !url || !dir || !out) {
    console.error('measure needs ENGINE_API_KEY in the environment, and --url, --payloads and --out');
    return 2;
  }
  const only = argOf('--only', rest)?.split(',');
  const ladder = argOf('--ladder', rest)?.split(',').map(Number) ?? LADDER;
  const probeSeconds = Number(argOf('--probe-seconds', rest) ?? PROBE_SECONDS);
  const loadBefore = loadavg()[0];
  const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'manifest.json').sort();
  const weeks = [];
  for (const file of files) {
    const name = file.replace(/\.json$/, '');
    if (only && !only.includes(name)) continue;
    console.error(`measuring ${name} …`);
    weeks.push(await measureWeek({ url, key, name, request: JSON.parse(readFileSync(`${dir}/${file}`, 'utf8')), ladder, probeSeconds }));
  }
  const result = {
    label: argOf('--label', rest) ?? 'unlabelled',
    cores: argOf('--cores', rest) ? Number(argOf('--cores', rest)) : null,
    startedAt: new Date().toISOString(),
    // The load average of the machine THIS script runs on, before and after: the engine's own only
    // when the two share a machine, as in the Mac's baseline. A pace measured at a high load is the
    // load's, and a baseline wants a quiet machine (the one-minute load under about 8 on 8 cores).
    callerLoad: [round(loadBefore, 1), round(loadavg()[0], 1)],
    timing: await timingOf({ url, key }),
    weeks,
  };
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.error(`wrote ${out}`);
  return 0;
}

// The real path: through a symbolic link (macOS's /tmp is one) the two would differ and nothing would run.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exit(await main());
}
