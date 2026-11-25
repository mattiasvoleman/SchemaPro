/**
 * The solver-corpus gate's verdict on hand-built weeks.
 *
 *   node --test scripts/bench/solve-corpus-gate.test.mjs
 *
 * No dependencies: solve-corpus-gate.mjs imports only the Node core, so this
 * runs on a pull request without Python or OR-Tools.
 */

import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import {
  CLEARLY_INSIDE,
  GEOMEAN_MAX,
  LOST_WEEKS_MAX,
  SEARCHES_PER_SOLVE,
  compareWeek,
  exitCodeOf,
  gate,
  invalidReason,
} from './solve-corpus-gate.mjs';

const BUDGET = 4;

const week = (name, work, extra = {}) => ({
  name,
  mode: 'count',
  deterministicBudget: BUDGET,
  facts: { corpusVersion: 1 },
  status: work === null ? 'TIMEOUT' : 'FIRST_SCHEDULE',
  firstScheduleDeterministic: work,
  firstScheduleSeconds: work === null ? null : work * 12,
  conflictCodes: [],
  ...extra,
});

const refused = (name, codes = ['TEACHER_SHARED_BY_PARALLEL_GROUPS']) =>
  week(name, null, { status: 'INFEASIBLE', conflictCodes: codes });

const floorRows = [week('n9-m0', 1), week('n9-m4', 0.5), week('n12-m0', 2), refused('n12-m8')];

test('the same weeks on the same work pass, with a ratio of one', () => {
  const verdict = gate(floorRows, floorRows);
  assert.equal(verdict.failed, false);
  assert.equal(verdict.invalid, false);
  assert.equal(exitCodeOf(verdict), 0);
  assert.equal(verdict.summary.geomean, 1);
  assert.ok(verdict.lines.includes('PASS'));
});

test('the geometric mean above the limit fails, and one slow week alone does not', () => {
  // One week at 3x with the others unchanged: geomean 3^(1/3) = 1.44 over three weeks, so a week is
  // enough only because the corpus here is three weeks; with the twelve of the gate it is 1.10.
  const one = [week('n9-m0', 3), floorRows[1], floorRows[2], floorRows[3]];
  assert.equal(gate(one, floorRows).failed, true);
  const many = Array.from({ length: 12 }, (_, i) => week(`w${i}`, 1));
  const slower = many.map((row, i) => (i === 0 ? week(row.name, 3) : row));
  const verdict = gate(slower, many);
  assert.equal(verdict.failed, false, verdict.lines.join('\n'));
  assert.ok(Math.abs(verdict.summary.geomean - 3 ** (1 / 12)) < 1e-9);
  // Every week 30% slower is a regression whatever one week does.
  const all = many.map((row) => week(row.name, 1.3));
  const failed = gate(all, many);
  assert.equal(failed.failed, true);
  assert.ok(failed.reasons.some((r) => r.includes('on average')));
  assert.ok(1.3 > GEOMEAN_MAX);
});

test('a week the floor solves and this tree refuses fails: a rule got stricter', () => {
  const head = [week('n9-m0', 1), refused('n9-m4'), floorRows[2], floorRows[3]];
  const verdict = gate(head, floorRows);
  assert.equal(verdict.failed, true);
  assert.ok(verdict.reasons.some((r) => r.startsWith('n9-m4') && r.includes('INFEASIBLE')));
});

test('a refusal that the engine raised as an exception is named by its class and not printed as (-)', () => {
  const crash = week('n9-m4', null, {
    status: 'REFUSED', conflictCodes: ['SolverCrashedError', 'cp-sat raised IndexError in phase 1b (a sentence is not a code)'],
  });
  const verdict = gate([floorRows[0], crash, floorRows[2], floorRows[3]], floorRows);
  assert.equal(verdict.failed, true);
  assert.ok(verdict.reasons.some((r) => r.startsWith('n9-m4') && r.includes('REFUSED (SolverCrashedError)')), verdict.reasons.join('\n'));
});

test('a week lost well inside the budget fails; one lost near the edge does not on its own', () => {
  const clear = [week('n9-m0', null), ...floorRows.slice(1)];
  assert.equal(gate(clear, floorRows).failed, true);
  const nearFloor = [week('n9-m0', 1), week('n9-m4', 0.5), week('n12-m0', 6.5), refused('n12-m8')];
  const nearHead = [week('n9-m0', 1), week('n9-m4', 0.5), week('n12-m0', null), refused('n12-m8')];
  // Two searches of the budget each: 8 deterministic seconds is the most a week can spend, so 6.5 is near the edge.
  assert.ok(6.5 >= CLEARLY_INSIDE * BUDGET * SEARCHES_PER_SOLVE);
  const verdict = gate(nearHead, nearFloor);
  assert.equal(verdict.failed, false, verdict.lines.join('\n'));
  // Two such weeks lost is a failure whatever the floor's distance.
  const twoLost = [week('n9-m0', null), week('n9-m4', null), week('n12-m0', 2), refused('n12-m8')];
  const twoFloor = [week('n9-m0', 5), week('n9-m4', 5), week('n12-m0', 2), refused('n12-m8')];
  assert.ok(5 >= CLEARLY_INSIDE * BUDGET * SEARCHES_PER_SOLVE && LOST_WEEKS_MAX === 1);
  const failed = gate(twoLost, twoFloor);
  assert.equal(failed.failed, true);
  assert.ok(failed.reasons.some((r) => r.startsWith('2 weeks the floor solves')));
});

test('a week that gains a timetable, a refusal that changes its code, and weeks neither solves decide nothing', () => {
  const floor = [week('a', null), refused('b', ['X_ONE']), week('c', null), week('d', 1)];
  const head = [week('a', 2), refused('b', ['X_TWO']), week('c', null), week('d', 1)];
  const verdict = gate(head, floor);
  assert.equal(verdict.failed, false, verdict.lines.join('\n'));
  assert.equal(compareWeek(head[0], floor[0], BUDGET).kind, 'gained');
  assert.equal(compareWeek(head[1], floor[1], BUDGET).kind, 'recoded');
  assert.equal(compareWeek(head[2], floor[2], BUDGET).kind, 'same');
});

test('a week with too little work in the floor carries no ratio', () => {
  const floor = [week('tiny', 0.01), week('big', 1)];
  const head = [week('tiny', 0.5), week('big', 1)];
  const verdict = gate(head, floor);
  assert.equal(verdict.failed, false, verdict.lines.join('\n'));
  assert.equal(verdict.summary.geomean, 1);
});

test('what cannot be compared is invalid (exit 2), never a pass', () => {
  assert.match(invalidReason([], floorRows), /non-empty/);
  assert.match(invalidReason(floorRows.slice(1), floorRows), /did not measure the same weeks/);
  assert.match(invalidReason([...floorRows, floorRows[0]], floorRows), /twice/);
  const otherCorpus = floorRows.map((row) => ({ ...row, facts: { corpusVersion: 2 } }));
  assert.match(invalidReason(otherCorpus, floorRows), /corpus version/);
  const clock = floorRows.map((row) => ({ ...row, mode: 'clock' }));
  assert.match(invalidReason(clock, clock), /count mode only/);
  const budget = floorRows.map((row) => ({ ...row, deterministicBudget: 9 }));
  assert.match(invalidReason(budget, floorRows), /deterministic budget/);
  const verdict = gate(floorRows.slice(1), floorRows);
  assert.equal(verdict.invalid, true);
  assert.equal(exitCodeOf(verdict), 2);
});

test('the wall-clock ratio is printed and decides nothing', () => {
  const slow = floorRows.map((row) => ({ ...row, firstScheduleSeconds: row.firstScheduleSeconds === null ? null : row.firstScheduleSeconds * 5 }));
  const verdict = gate(slow, floorRows);
  assert.equal(verdict.failed, false);
  assert.ok(verdict.lines.some((line) => line.startsWith('printed, deciding nothing: wall-clock geometric mean this/floor 5.00')));
});

test('a tree that cannot be handed a week answers ERROR: a failure when it is this tree, a gain when it is the floor', () => {
  const error = (name) => week(name, null, { status: 'ERROR', conflictCodes: ['ValidationError', 'periods: extra fields not permitted'] });
  const lost = gate([error('n9-m0'), ...floorRows.slice(1)], floorRows);
  assert.equal(lost.failed, true);
  assert.ok(lost.reasons.some((r) => r.startsWith('n9-m0') && r.includes('ERROR')));
  const gained = gate(floorRows, [error('n9-m0'), ...floorRows.slice(1)]);
  assert.equal(gained.failed, false, gained.lines.join('\n'));
});

test('the same week read differently by the two trees is invalid: a ratio of two weeks says nothing', () => {
  const dropped = floorRows.map((row) => (row.name === 'n9-m0' ? { ...row, facts: { corpusVersion: 1, termRequirements: 0 } } : { ...row, facts: { corpusVersion: 1, termRequirements: 0 } }));
  const head = floorRows.map((row) => ({ ...row, facts: { corpusVersion: 1, termRequirements: row.name === 'n9-m0' ? 36 : 0 } }));
  assert.match(invalidReason(head, dropped), /did not read the same week for n9-m0/);
  assert.equal(invalidReason(dropped, dropped), null);
  // A week a tree answers ERROR for has no facts to compare, and is the verdict's own business.
  const error = head.map((row) => (row.name === 'n9-m0' ? { ...row, status: 'ERROR', facts: { corpusVersion: 1 } } : row));
  assert.equal(invalidReason(error, head), null);
});

test('run through a symbolic link the script still runs (it said nothing and exited 0 when its guard compared the link with the real path)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'link-'));
  const link = join(dir, 'solve-corpus-gate.mjs');
  symlinkSync(new URL('./solve-corpus-gate.mjs', import.meta.url).pathname, link);
  const run = spawnSync(process.execPath, [link], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /usage/);
});

// ---- the edges the constants stand for, written in numbers and not in the constants ----------------
// (a test that multiplies the constants together passes whatever they are set to)

test('the edge of "clearly inside": under half of the 8 deterministic seconds two searches can spend is, 4 and over is not', () => {
  const lost = (floorWork) => {
    const floor = [week('a', floorWork), week('b', 1), week('c', 1)];
    const head = [week('a', null), week('b', 1), week('c', 1)];
    return gate(head, floor);
  };
  assert.equal(lost(3.9).failed, true, 'a floor of 3.9 is well inside 8');
  assert.ok(lost(3.9).reasons.some((r) => r.includes('well inside')));
  assert.equal(lost(4).failed, false, 'a floor of exactly half is not clearly inside');
  assert.equal(lost(4.1).failed, false);
});

test('the edge of the geometric mean: every week 24 % slower passes, 26 % fails', () => {
  const many = Array.from({ length: 12 }, (_, i) => week(`w${i}`, 1));
  const times = (factor) => many.map((row) => week(row.name, factor));
  assert.equal(gate(times(1.24), many).failed, false);
  assert.equal(gate(times(1.26), many).failed, true);
});

test('a week of the least work the gate has (0.17) carries a ratio: 3.5 times its floor fails', () => {
  const floor = [week('small', 0.17), week('big', 1)];
  const head = [week('small', 0.6), week('big', 1)];
  const verdict = gate(head, floor);
  assert.equal(verdict.failed, true, verdict.lines.join('\n'));
  assert.ok(verdict.summary.geomean > 1.8);
});

// ---- the process: what Actions sees is the exit code and the step summary ----------------------

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'solve-corpus-gate.mjs');

function run(head, floor, extra = []) {
  const dir = mkdtempSync(join(tmpdir(), 'corpus-gate-'));
  try {
    writeFileSync(join(dir, 'head.json'), JSON.stringify(head));
    writeFileSync(join(dir, 'floor.json'), JSON.stringify(floor));
    const summary = join(dir, 'summary.md');
    const done = spawnSync(
      process.execPath,
      [GATE, '--head', join(dir, 'head.json'), '--floor', join(dir, 'floor.json'), ...extra],
      { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: summary } },
    );
    let written = '';
    try { written = readFileSync(summary, 'utf8'); } catch { /* no summary written */ }
    return { status: done.status, stdout: done.stdout, written };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the process exits 0 on a pass, 1 on a failed verdict and 2 on weeks that cannot be compared', () => {
  assert.equal(exitCodeOf({ failed: true, invalid: false }), 1);
  assert.equal(exitCodeOf({ failed: false, invalid: false }), 0);
  assert.equal(exitCodeOf({ failed: true, invalid: true }), 2);
  const passed = run(floorRows, floorRows, ['--floor-ref', 'abc1234']);
  assert.equal(passed.status, 0, passed.stdout);
  assert.ok(passed.stdout.includes('floor abc1234') && passed.stdout.trimEnd().endsWith('PASS'));
  assert.equal(passed.written.trimEnd(), passed.stdout.trimEnd(), 'the verdict is also the step summary');
  const slower = floorRows.map((row) => (row.firstScheduleDeterministic === null ? row : week(row.name, row.firstScheduleDeterministic * 1.5)));
  const failed = run(slower, floorRows);
  assert.equal(failed.status, 1, failed.stdout);
  assert.ok(failed.stdout.includes('FAIL: '));
  const invalid = run(floorRows.slice(1), floorRows);
  assert.equal(invalid.status, 2, invalid.stdout);
  assert.ok(invalid.stdout.startsWith('INVALID: '));
  const usage = spawnSync(process.execPath, [GATE, '--head', 'x.json'], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
});

// ---- the seam with the measurement: a gate that compares nothing must not pass -------------------

test('weeks answered FIRST_SCHEDULE without a number of work are invalid, not "the same"', () => {
  // corpus_measure.py names the number firstScheduleDeterministic; a rename on either side leaves every week "solved" without one.
  const renamed = floorRows.map(({ firstScheduleDeterministic, ...row }) => ({ ...row, firstScheduleDet: firstScheduleDeterministic }));
  assert.match(invalidReason(renamed, renamed) ?? '', /without a number of work/);
  const verdict = gate(renamed, renamed);
  assert.equal(verdict.invalid, true);
  assert.equal(exitCodeOf(verdict), 2);
});

test('a null deterministic budget is invalid: a ceiling of zero would make no lost week "clear"', () => {
  const nulled = floorRows.map((row) => ({ ...row, deterministicBudget: null }));
  assert.match(invalidReason(nulled, nulled) ?? '', /deterministic budget/);
});

test('a floor that solves no week guards nothing and is invalid', () => {
  const none = [week('a', null), refused('b'), week('c', null)];
  const head = [week('a', 1), week('b', 2), week('c', 3)];
  assert.match(invalidReason(head, none) ?? '', /floor solves no week/);
  assert.equal(gate(head, none).invalid, true);
  // One solved week is enough to hold this tree to.
  assert.equal(invalidReason(head, [week('a', 1), refused('b'), week('c', null)]), null);
});

// ---- several seeds (corpus_measure.py --seeds): a week on the edge is not a lost week -------------------
// A row measured at several seeds is the middle one, with `seedWork`: what each seed needed (null: no timetable).

const seeded = (name, work, seedWork) => ({
  ...week(name, work),
  seedWork,
  seeds: seedWork.length,
});

test('a week the floor found at some seeds only and this tree misses is on the edge: one such week does not fail the gate', () => {
  // The floor's middle seed found it at 1.9, but one of three seeds found nothing: the week is on the edge,
  // where a change that does nothing flips it. (Measured: this week finds nothing at 4 seeds of 7.)
  const floor = [seeded('edge', 1.9, [1.9, null, 4.7]), week('b', 1), week('c', 1)];
  const head = [seeded('edge', null, [null, null, null]), week('b', 1), week('c', 1)];
  assert.equal(gate(head, floor).failed, false, gate(head, floor).lines.join('\n'));
});

test('a week the floor found at every seed, well inside, and this tree at none is lost for certain', () => {
  const floor = [seeded('steady', 0.5, [0.4, 0.5, 0.9]), week('b', 1), week('c', 1)];
  const head = [seeded('steady', null, [null, null, null]), week('b', 1), week('c', 1)];
  const verdict = gate(head, floor);
  assert.equal(verdict.failed, true);
  assert.ok(verdict.reasons.some((r) => r.startsWith('steady') && r.includes('well inside')));
});

test('a week this tree finds at one seed of three is not lost, whatever its middle seed says', () => {
  const floor = [seeded('steady', 0.5, [0.4, 0.5, 0.9]), week('b', 1), week('c', 1)];
  const head = [seeded('steady', null, [null, null, 0.8]), week('b', 1), week('c', 1)];
  assert.equal(gate(head, floor).failed, false);
});

test('rows of one seed keep the rule they had: the floor under half of the most work, well inside', () => {
  const floor = [week('a', 1), week('b', 1), week('c', 1)];
  const head = [week('a', null), week('b', 1), week('c', 1)];
  assert.equal(gate(head, floor).failed, true);
  assert.equal(gate([seeded('a', null, [null, null, null]), week('b', 1), week('c', 1)], floor).failed, true);
});
