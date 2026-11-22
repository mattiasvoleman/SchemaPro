/**
 * The solver-corpus gate's verdict on hand-built weeks.
 *
 *   node --test scripts/bench/solve-corpus-gate.test.mjs
 *
 * No dependencies: solve-corpus-gate.mjs imports only the Node core, so this
 * runs on a pull request without Python or OR-Tools.
 */

import { test } from 'node:test';
import { mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
