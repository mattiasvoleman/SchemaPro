/**
 * The mutation slices: which one runs tonight, how the files are dealt, how a
 * slice is scored.
 *
 *   node --test scripts/mutation-slice.test.mjs
 *
 * No dependencies: the script imports Stryker's instrumenter only when it
 * counts, so this runs on a pull request without Stryker installed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { balance, dayOfYear, filesToMutate, parseSlice, plan, scoreOf, summarise, summaryMarkdown, tonightsSlice } from './mutation-slice.mjs';

test('the day of the year is counted in UTC, from 1 January as day 1', () => {
  assert.equal(dayOfYear(new Date('2026-01-01T00:00:00Z')), 1);
  assert.equal(dayOfYear(new Date('2026-01-01T23:59:59Z')), 1);
  assert.equal(dayOfYear(new Date('2026-02-01T02:30:00Z')), 32);
  assert.equal(dayOfYear(new Date('2026-11-02T02:30:00Z')), 306);
  assert.equal(dayOfYear(new Date('2026-12-31T23:59:59Z')), 365);
  // A leap year has day 366, and 1 March moves from day 60 to day 61.
  assert.equal(dayOfYear(new Date('2028-12-31T12:00:00Z')), 366);
  assert.equal(dayOfYear(new Date('2026-03-01T12:00:00Z')), 60);
  assert.equal(dayOfYear(new Date('2028-03-01T12:00:00Z')), 61);
  // Local time does not move it: 01:30 on 1 November in Stockholm is still 31 October in UTC.
  assert.equal(dayOfYear(new Date('2026-11-01T00:30:00+01:00')), 304);
});

test("tonight's slice is the day of the year modulo the number of slices, so ten nights in a row cover all ten", () => {
  assert.equal(tonightsSlice(new Date('2026-11-02T02:30:00Z'), 10), 6);
  const nights = Array.from({ length: 10 }, (_, i) => tonightsSlice(new Date(Date.UTC(2026, 10, 2 + i, 2, 30)), 10));
  assert.deepEqual([...nights].sort(), ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'].map(Number).sort());
  // The change of year repeats or skips one night, never more.
  assert.equal(tonightsSlice(new Date('2026-12-31T02:30:00Z'), 10), 5);
  assert.equal(tonightsSlice(new Date('2027-01-01T02:30:00Z'), 10), 1);
});

test('a dispatch names a slice, all of them, or leaves it to the date', () => {
  const date = new Date('2026-11-02T02:30:00Z');
  assert.deepEqual(plan({ input: '', date, of: 10 }), [6]);
  assert.deepEqual(plan({ input: undefined, date, of: 10 }), [6]);
  assert.deepEqual(plan({ input: '3', date, of: 10 }), [3]);
  assert.deepEqual(plan({ input: ' 0 ', date, of: 10 }), [0]);
  assert.deepEqual(plan({ input: 'all', date, of: 4 }), [0, 1, 2, 3]);
  for (const bad of ['10', '-1', '1.5', 'x', '3,4']) {
    assert.throws(() => parseSlice(bad, 10), /slice must be a whole number from 0 to 9/, bad);
  }
});

test('every file lands in exactly one slice and the slices differ by less than the largest file', () => {
  const counts = Array.from({ length: 280 }, (_, i) => ({ file: `src/f${String(i).padStart(3, '0')}.ts`, mutants: ((i * 7919) % 997) + (i % 13 === 0 ? 1500 : 0) }));
  const slices = balance(counts, 10);
  const placed = slices.flatMap((s) => s.files.map((f) => f.file)).sort();
  assert.deepEqual(placed, counts.map((c) => c.file).sort());
  for (const s of slices) assert.equal(s.mutants, s.files.reduce((sum, f) => sum + f.mutants, 0));
  const sizes = slices.map((s) => s.mutants);
  const largest = Math.max(...counts.map((c) => c.mutants));
  assert.ok(Math.max(...sizes) - Math.min(...sizes) < largest, sizes.join(' '));
  for (const s of slices) assert.deepEqual(s.files.map((f) => f.file), s.files.map((f) => f.file).sort());
});

test('the dealing is deterministic and does not depend on the order the files arrive in', () => {
  const counts = [
    { file: 'src/b.ts', mutants: 5 }, { file: 'src/a.ts', mutants: 5 }, { file: 'src/c.ts', mutants: 5 },
    { file: 'src/d.ts', mutants: 9 }, { file: 'src/e.ts', mutants: 0 }, { file: 'src/f.ts', mutants: 9 },
  ];
  const once = balance(counts, 3);
  assert.deepEqual(balance([...counts].reverse(), 3), once);
  // Heaviest first, ties by file name: d to slice 0, f to slice 1, a and b to
  // slice 2, c to slice 0 (a tie with slice 1 goes to the lower), e to slice 1.
  assert.deepEqual(once.map((s) => s.files.map((f) => f.file)), [['src/c.ts', 'src/d.ts'], ['src/e.ts', 'src/f.ts'], ['src/a.ts', 'src/b.ts']]);
  assert.deepEqual(once.map((s) => s.mutants), [14, 9, 10]);
});

test('files with no mutants are dealt too, and fewer files than slices leave empty slices', () => {
  const slices = balance([{ file: 'src/a.ts', mutants: 3 }, { file: 'src/types.ts', mutants: 0 }], 4);
  assert.equal(slices.flatMap((s) => s.files).length, 2);
  assert.deepEqual(slices.map((s) => s.mutants), [3, 0, 0, 0]);
});

test("the files are the config's mutate list in order, a ! taking out what the patterns before it put in", () => {
  const tree = {
    'src/**/*.ts': ['src/a.ts', 'src/a.spec.ts', 'src/a.controller.ts', 'src/x/b.ts', 'src/x/b.generated.ts', 'src/x/dto/c.ts', 'src/notes.md'],
    'src/**/*.spec.ts': ['src/a.spec.ts'],
    'src/**/*.controller.ts': ['src/a.controller.ts'],
    'src/**/dto/**': ['src/x/dto', 'src/x/dto/c.ts'],
    'src/**/*.generated.ts': ['src/x/b.generated.ts'],
  };
  const glob = (pattern) => tree[pattern] ?? [];
  assert.deepEqual(
    filesToMutate(['src/**/*.ts', '!src/**/*.spec.ts', '!src/**/*.controller.ts', '!src/**/dto/**', '!src/**/*.generated.ts'], glob),
    ['src/a.ts', 'src/x/b.ts'],
  );
  // A positive pattern after a negated one puts a file back, as in Stryker.
  assert.deepEqual(filesToMutate(['src/**/*.ts', '!src/**/*.spec.ts', 'src/**/*.spec.ts'], glob).includes('src/a.spec.ts'), true);
});

test("a slice is scored as Stryker scores it: killed and timed out against survived and uncovered, the rest not counted", () => {
  const { detected, undetected, valid, score } = scoreOf(['Killed', 'Killed', 'Timeout', 'Survived', 'NoCoverage', 'CompileError', 'RuntimeError', 'Ignored', 'Pending']);
  assert.deepEqual({ detected, undetected, valid }, { detected: 3, undetected: 2, valid: 5 });
  assert.equal(score, 60);
  assert.equal(scoreOf(['Ignored']).score, null);
});

test("the summary names the slice, the score against the break, and the weakest file first", () => {
  const report = {
    files: {
      'src/strong.ts': { mutants: Array.from({ length: 9 }, () => ({ status: 'Killed' })).concat([{ status: 'Survived' }]) },
      'src/weak.ts': { mutants: [{ status: 'Killed' }, { status: 'Survived' }, { status: 'NoCoverage' }, { status: 'NoCoverage' }] },
      'src/none.ts': { mutants: [{ status: 'Ignored' }] },
    },
  };
  const summary = summarise(report);
  assert.equal(summary.total.detected, 10);
  assert.equal(summary.total.valid, 14);
  assert.deepEqual(summary.files.map((f) => f.file), ['src/weak.ts', 'src/strong.ts', 'src/none.ts']);
  const markdown = summaryMarkdown({ slice: 3, of: 10, mutants: 15, files: [{}, {}, {}] }, summary, 85);
  assert.match(markdown, /^## Mutation slice 3 of 10/);
  assert.match(markdown, /\*\*Score 71\.43 %\*\* \(break at 85 %\): 10 of 14 mutants detected, 4 not, in 3 files\./);
  assert.ok(markdown.indexOf('src/weak.ts') < markdown.indexOf('src/strong.ts'));
  assert.match(markdown, /\| src\/weak\.ts \| 25\.00 % \| 1 \| 1 \| 2 \|/);
  // A run that did not finish has no report, and says so instead of a score.
  assert.match(summaryMarkdown({ slice: 3, of: 10, mutants: 7000, files: [{}] }, null, 85), /No report: Stryker did not finish \(7000 mutants in 1 files\)/);
});
