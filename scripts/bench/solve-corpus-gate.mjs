/**
 * The solver-corpus gate's verdict (omgång 13, M5): this tree against a floor.
 *
 *   node scripts/bench/solve-corpus-gate.mjs --head head.json --floor floor.json [--floor-ref <sha>]
 *   node --test scripts/bench/solve-corpus-gate.test.mjs
 *
 * Pure and import-free but for the Node core, as latency-gate.mjs is, so a test
 * runs on a pull request without Python, OR-Tools or a stack. This module takes
 * what `optimization-engine/benchmarks/corpus_measure.py --mode count --json`
 * wrote for the same corpus on two trees, and returns what to print and how to
 * exit.
 *
 * WHY NOT SECONDS. The ubuntu runner is a mixed-CPU pool (latency-gate.mjs has
 * the numbers: the same tree's health throughput varied 2.6x between machines),
 * and the same search takes a different number of seconds on each. A gate in
 * seconds fails on the machine the job drew, not on the code.
 *
 * WHAT IT COUNTS INSTEAD. CP-SAT's DETERMINISTIC time: operations counted, not
 * seconds. With one worker and a fixed seed (count mode) the same search runs
 * the same operations on every machine, so a week's number is the same on a
 * runner as on a laptop, and two trees compare exactly. The floor is a second
 * tree measured by the same job on the same runner (main as it was seven days
 * ago, or the ref the dispatch input `corpus_floor` names: quality-gates.yml's
 * solver-corpus job), so nothing is stored in the repository; a hardware
 * difference cancels, and the corpus and OR-Tools are the same for both because
 * both ran in one job on this tree's requirements. The last is also a blind spot:
 * a change of OR-Tools' pin changes the search of both trees alike and is NOT seen
 * here.
 *
 * WHAT IT FAILS ON. Only what does not depend on a lucky search:
 *   1. a week the floor gives a timetable and this tree REFUSES (a rule got
 *      stricter: a proof, not a search);
 *   2. weeks that the floor solves and this tree does not (TIMEOUT within the
 *      same deterministic budget): one is a failure when the floor was clearly
 *      inside it (under half of the two searches' budgets; with several seeds: at every
 *      seed, and this tree at none), and two are in any case, since a
 *      week near the edge flips on the smallest change to the model (CP-SAT's
 *      search is chaotic: +-2x on one week is ordinary);
 *   3. the geometric mean of the weeks both solve, this tree / the floor, above
 *      GEOMEAN_MAX. The mean over the corpus is what a change to a rule shows in;
 *      one week is the search's luck.
 * Anything else (a refusal's code changing, a week that gained a timetable,
 * weeks neither solves) is printed and decides nothing.
 *
 * WHAT IT DOES NOT SEE. A regression that shows only with several workers (the
 * portfolio production runs), and the Python time of the build, which is wall
 * time and so cannot be gated on a runner. The wall seconds of both trees are
 * printed beside the verdict, deciding nothing.
 */

import { readFileSync, appendFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** The geometric mean of head / floor over the weeks both solve, at most. */
export const GEOMEAN_MAX = 1.25;
/**
 * The deterministic budget is for ONE search, and the solve runs two satisfaction searches in
 * turn when the first finds nothing (phase 1a, then phase 1b), so the most work a week can
 * spend before it is a TIMEOUT is this many budgets.
 *
 * A week of two years or more has the years' road between the two (M8 PR 5, DEPLOYMENT §35.9): each
 * of its steps is a search of the same budget, so a week the road lays can have spent more than this
 * (the gate's two road weeks, `n9-g6-m0-s1` and `n12-g6-m0-s1-e1645`, 4.6 to 6.1 of 8). The ceiling is
 * kept as it was: it only decides when ONE lost week is "clearly inside" (below), and the road's
 * weeks are not, so they fail the gate together (two lost weeks fail whatever the floor was).
 */
export const SEARCHES_PER_SOLVE = 2;
/** A week the floor solves inside this share of the most work it can spend is not near the edge. */
export const CLEARLY_INSIDE = 0.5;
/** Weeks whose work is under this many deterministic seconds in the floor carry no ratio. */
export const MIN_FLOOR_WORK = 0.05;
/** Lost weeks that fail the gate whether or not the floor was near the edge. */
export const LOST_WEEKS_MAX = 1;

export const SOLVED = 'FIRST_SCHEDULE';

export const exitCodeOf = ({ failed, invalid }) => (invalid ? 2 : failed ? 1 : 0);

const solved = (row) => row.status === SOLVED && typeof row.firstScheduleDeterministic === 'number';

/** The work each seed a week was searched at needed (null: no timetable), when the measurement ran several. */
const seedsOf = (row) => (Array.isArray(row.seedWork) && row.seedWork.length > 1 ? row.seedWork : null);

/** Why the two lists cannot be compared at all, or null. */
export function invalidReason(head, floor) {
  if (!Array.isArray(head) || !Array.isArray(floor) || head.length === 0 || floor.length === 0) {
    return 'both files must hold a non-empty list of weeks';
  }
  const names = (rows) => rows.map((row) => row.name);
  const headNames = names(head);
  const floorNames = names(floor);
  if (new Set(headNames).size !== headNames.length || new Set(floorNames).size !== floorNames.length) {
    return 'a week appears twice in one file';
  }
  const missing = floorNames.filter((name) => !headNames.includes(name));
  const extra = headNames.filter((name) => !floorNames.includes(name));
  if (missing.length || extra.length) {
    return `the two trees did not measure the same weeks (only in the floor: ${missing.join(', ') || '-'}; only in this tree: ${extra.join(', ') || '-'})`;
  }
  const versions = new Set([...head, ...floor].map((row) => row.facts?.corpusVersion));
  if (versions.size !== 1 || versions.has(undefined)) {
    return `the weeks come from more than one corpus version (${[...versions].join(', ')})`;
  }
  // The same week must read the same in both trees. A tree that drops a field it does not know (an
  // engine from before the engine planned terms has no `periods`) measures another week under the
  // same name, and a ratio of two different weeks says nothing.
  const floorFacts = new Map(floor.map((row) => [row.name, row]));
  const unlike = head
    .filter((row) => row.status !== 'ERROR' && floorFacts.get(row.name).status !== 'ERROR')
    .filter((row) => JSON.stringify(row.facts) !== JSON.stringify(floorFacts.get(row.name).facts))
    .map((row) => row.name);
  if (unlike.length) {
    return `the two trees did not read the same week for ${unlike.join(', ')} (the weeks' facts differ: a tree that does not know a field of the corpus drops it)`;
  }
  const modes = new Set([...head, ...floor].map((row) => row.mode));
  if (modes.size !== 1 || !modes.has('count')) {
    return `the gate compares count mode only (modes seen: ${[...modes].join(', ')})`;
  }
  const budgets = new Set([...head, ...floor].map((row) => row.deterministicBudget));
  if (budgets.size !== 1 || budgets.has(undefined) || budgets.has(null)) {
    return `the two trees did not run on one deterministic budget (${[...budgets].join(', ')})`;
  }
  // The producer (corpus_measure.py) and this verdict meet in the names of a few fields. A week answered
  // FIRST_SCHEDULE with no number of work is that seam broken (a field renamed on one side): every week
  // would read as unsolved in both trees, "same", and the gate would pass having compared nothing.
  const numberless = [...head, ...floor]
    .filter((row) => row.status === SOLVED && typeof row.firstScheduleDeterministic !== 'number')
    .map((row) => row.name);
  if (numberless.length) {
    return `weeks answered ${SOLVED} without a number of work in firstScheduleDeterministic: ${[...new Set(numberless)].join(', ')} (the measurement and this verdict disagree on a field's name)`;
  }
  // A floor that solves no week has nothing for this tree to be held to: every week would read as
  // gained or the same, and the gate would pass having guarded nothing.
  if (!floor.some(solved)) {
    const seen = [...new Set(floor.map((row) => `${row.status} ${code(row)}`.trim()))].join('; ');
    return `the floor solves no week (${seen}): there is nothing to hold this tree to until the floor does`;
  }
  return null;
}

// A code is a word: ENGINE_CODES_LIKE_THIS or, for a refusal the engine raised as an exception, the class's own
// name (SolverCrashedError). A sentence after it is not one (g394-L-6b: the class name used to print as `(-)`).
const code = (row) => (row.conflictCodes ?? []).filter((c) => /^[A-Z][A-Za-z0-9_]*$/.test(c)).join('+') || '-';

/** One week's verdict: what happened to it between the floor and this tree. */
export function compareWeek(head, floor, budget) {
  const ceiling = budget * SEARCHES_PER_SOLVE;
  const name = head.name;
  // A crash is this tree's whatever the floor did with the week (g394-L-6a: a crash is a week's row and no longer
  // ends the run, so the verdict is the only place it can be read). A week the floor cannot solve was not covered
  // by the 'the floor solves it' rule below: the crash went by as 'recoded' and the job stayed green. The floor
  // having crashed too is the one excuse: a crash both trees have is not this tree's doing.
  if (head.status === 'ERROR' && floor.status !== 'ERROR' && !solved(floor)) {
    return { name, kind: 'refused', note: `the floor answers ${floor.status} (${code(floor)}); this tree answers ERROR (${code(head)}): a crash is this tree's, whatever the floor did` };
  }
  if (solved(floor) && solved(head)) {
    const ratio = head.firstScheduleDeterministic / Math.max(floor.firstScheduleDeterministic, 1e-9);
    const carries = floor.firstScheduleDeterministic >= MIN_FLOOR_WORK;
    return {
      name, kind: 'both', ratio: carries ? ratio : null,
      note: carries ? '' : 'too little work to carry a ratio',
      floorWork: floor.firstScheduleDeterministic, headWork: head.firstScheduleDeterministic,
    };
  }
  if (solved(floor)) {
    if (head.status === 'TIMEOUT') {
      // With several seeds a week is lost for certain only when the floor found it at EVERY seed, each
      // well inside the budget, and this tree at none: a week that times out at some seeds of the floor
      // itself is on the edge, and the edge is where a change that does nothing flips it.
      const floorSeeds = seedsOf(floor) ?? [floor.firstScheduleDeterministic];
      const headSeeds = seedsOf(head);
      const inside = floorSeeds.every((work) => typeof work === 'number' && work < CLEARLY_INSIDE * ceiling)
        && (headSeeds === null || headSeeds.every((work) => work === null));
      return { name, kind: 'lost', clear: inside, floorWork: floor.firstScheduleDeterministic,
        note: `the floor solves it in ${floor.firstScheduleDeterministic} of at most ${ceiling}; this tree times out` };
    }
    return { name, kind: 'refused', note: `the floor solves it; this tree answers ${head.status} (${code(head)})` };
  }
  if (solved(head)) {
    return { name, kind: 'gained', note: `the floor answers ${floor.status} (${code(floor)}); this tree solves it` };
  }
  if (head.status === floor.status && code(head) === code(floor)) {
    return { name, kind: 'same', note: `${head.status} ${code(head) === '-' ? '' : code(head)}`.trim() };
  }
  return { name, kind: 'recoded', note: `${floor.status} (${code(floor)}) -> ${head.status} (${code(head)})` };
}

const fixed = (value, digits = 2) => (value === null || value === undefined ? '-' : Number(value).toFixed(digits));

/** The verdict for two lists of weeks: { failed, invalid, reasons, lines, summary }. */
export function gate(headRows, floorRows, { floorRef = null } = {}) {
  const reason = invalidReason(headRows, floorRows);
  if (reason) {
    return { failed: false, invalid: true, reasons: [reason], lines: [`INVALID: ${reason}`], summary: null };
  }
  const budget = headRows[0].deterministicBudget;
  const floorByName = new Map(floorRows.map((row) => [row.name, row]));
  const weeks = headRows.map((head) => compareWeek(head, floorByName.get(head.name), budget));
  const reasons = [];

  const refused = weeks.filter((w) => w.kind === 'refused');
  for (const week of refused) reasons.push(`${week.name}: ${week.note}`);

  const lost = weeks.filter((w) => w.kind === 'lost');
  const clearLost = lost.filter((w) => w.clear);
  for (const week of clearLost) reasons.push(`${week.name}: ${week.note}, and the floor was well inside the budget`);
  if (lost.length > LOST_WEEKS_MAX && clearLost.length === 0) {
    reasons.push(`${lost.length} weeks the floor solves no longer get a timetable (${lost.map((w) => w.name).join(', ')})`);
  }

  const ratios = weeks.filter((w) => w.kind === 'both' && w.ratio !== null).map((w) => w.ratio);
  const geomean = ratios.length ? Math.exp(ratios.reduce((sum, r) => sum + Math.log(r), 0) / ratios.length) : null;
  if (geomean !== null && geomean > GEOMEAN_MAX) {
    reasons.push(`the weeks both trees solve need ${fixed(geomean)} times the floor's work on average (limit ${GEOMEAN_MAX})`);
  }

  const wall = headRows
    .map((head) => ({ head: head.firstScheduleSeconds, floor: floorByName.get(head.name).firstScheduleSeconds }))
    .filter((pair) => typeof pair.head === 'number' && typeof pair.floor === 'number' && pair.floor > 0);
  const wallGeomean = wall.length
    ? Math.exp(wall.reduce((sum, pair) => sum + Math.log(pair.head / pair.floor), 0) / wall.length)
    : null;

  const lines = [
    `Solver corpus: ${headRows.length} weeks, count mode (one worker, fixed seed), budget ${budget} deterministic s${floorRef ? `, floor ${floorRef}` : ''}`,
    '',
    'week | floor work | this work | ratio | note',
    '--- | ---: | ---: | ---: | ---',
    ...weeks.map((w) => {
      if (w.kind === 'both') return `${w.name} | ${fixed(w.floorWork, 3)} | ${fixed(w.headWork, 3)} | ${fixed(w.ratio)} | ${w.note}`;
      return `${w.name} | | | | ${w.kind}: ${w.note}`;
    }),
    '',
    `weeks both solve: ${ratios.length} of ${weeks.length}, geometric mean of this/floor: ${fixed(geomean)} (limit ${GEOMEAN_MAX}); lost ${lost.length}, refused ${refused.length}, gained ${weeks.filter((w) => w.kind === 'gained').length}`,
    `printed, deciding nothing: wall-clock geometric mean this/floor ${fixed(wallGeomean)} over ${wall.length} weeks (one run each, the runner's load included)`,
    ...(reasons.length ? ['', ...reasons.map((r) => `FAIL: ${r}`)] : ['', 'PASS']),
  ];
  return {
    failed: reasons.length > 0,
    invalid: false,
    reasons,
    lines,
    summary: { weeks: weeks.length, geomean, wallGeomean, lost: lost.length, refused: refused.length },
  };
}

function argOf(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : process.argv[index + 1];
}

function main() {
  const headPath = argOf('--head');
  const floorPath = argOf('--floor');
  if (!headPath || !floorPath) {
    console.error('usage: solve-corpus-gate.mjs --head head.json --floor floor.json [--floor-ref <sha>]');
    return 2;
  }
  const verdict = gate(JSON.parse(readFileSync(headPath, 'utf8')), JSON.parse(readFileSync(floorPath, 'utf8')), {
    floorRef: argOf('--floor-ref'),
  });
  const text = verdict.lines.join('\n');
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  return exitCodeOf(verdict);
}

// The real path: through a symbolic link (macOS's /tmp is one) the two would differ and nothing would run.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exit(main());
}
