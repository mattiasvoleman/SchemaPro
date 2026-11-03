/**
 * The mutation slices: which one runs tonight, how the files are dealt, what a
 * floor is, where a new file goes, how a slice is scored.
 *
 *   node --test scripts/mutation-slice.test.mjs
 *
 * No dependencies: the script imports Stryker's instrumenter only when it
 * counts, so this runs on a pull request without Stryker installed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  balance,
  baseOf,
  dayOfYear,
  deal,
  dealingNotes,
  filesOf,
  filesToMutate,
  floorOf,
  placeNew,
  plan,
  scoreOf,
  scoreOfCounts,
  splitEntry,
  summarise,
  summaryMarkdown,
  tonightsSlice,
} from './mutation-slice.mjs';

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

test("tonight's slice is the day of the year modulo the number of slices, so that many nights in a row cover all of them", () => {
  assert.equal(tonightsSlice(new Date('2026-11-02T02:30:00Z'), 10), 6);
  assert.equal(tonightsSlice(new Date('2026-11-02T02:30:00Z'), 20), 6);
  const nights = Array.from({ length: 20 }, (_, i) => tonightsSlice(new Date(Date.UTC(2026, 10, 2 + i, 2, 30)), 20));
  assert.deepEqual([...nights].sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i));
  // The change of year repeats or skips one night, never more.
  assert.equal(tonightsSlice(new Date('2026-12-31T02:30:00Z'), 20), 5);
  assert.equal(tonightsSlice(new Date('2027-01-01T02:30:00Z'), 20), 1);
});

test('a dispatch names one slice, a few, all of them, or leaves it to the date', () => {
  const date = new Date('2026-11-02T02:30:00Z');
  assert.deepEqual(plan({ input: '', date, of: 10 }), [6]);
  assert.deepEqual(plan({ input: undefined, date, of: 10 }), [6]);
  assert.deepEqual(plan({ input: '3', date, of: 10 }), [3]);
  assert.deepEqual(plan({ input: ' 0 ', date, of: 10 }), [0]);
  assert.deepEqual(plan({ input: '7, 3,3,12', date, of: 20 }), [3, 7, 12]);
  assert.deepEqual(plan({ input: 'all', date, of: 4 }), [0, 1, 2, 3]);
  for (const bad of ['10', '-1', '1.5', 'x', '3,', ',3', '3,10']) {
    assert.throws(() => plan({ input: bad, date, of: 10 }), /slice must be whole numbers from 0 to 9/, bad);
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

test('the dealing follows measured seconds: many cheap files do not outweigh one dear one', () => {
  const items = [
    { file: 'src/dear.ts', mutants: 100, weight: 3000 },
    ...Array.from({ length: 10 }, (_, i) => ({ file: `src/cheap${i}.ts`, mutants: 900, weight: 60 })),
  ];
  const slices = balance(items, 2);
  // By mutants the dear file would sit with one or two others; by seconds it sits with none.
  assert.deepEqual(slices.map((s) => s.files.length), [1, 10]);
  assert.deepEqual(slices.map((s) => s.weight), [3000, 600]);
  assert.deepEqual(slices.map((s) => s.mutants), [100, 9000]);
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
  assert.deepEqual(scoreOfCounts({ Killed: 2, Timeout: 1, Survived: 1, NoCoverage: 1, Ignored: 9, CompileError: 4 }), scoreOf(['Killed', 'Killed', 'Timeout', 'Survived', 'NoCoverage']));
});

test("a floor is the measured score minus one point, rounded down: 72.5 → 71, 72.0 → 71, 72.01 → 71, 71.99 → 70", () => {
  assert.equal(floorOf(72.5), 71);
  assert.equal(floorOf(72), 71);
  assert.equal(floorOf(72.01), 71);
  assert.equal(floorOf(71.99), 70);
  assert.equal(floorOf(54.89), 53);
});

// Two files a slice, measured: a.ts 80 of 100 detected in 30 s, b.ts 40 of 50 in 10 s, ...
const MEASURED = new Map([
  ['src/a.ts', { ms: 30_000, mutants: 120, statuses: { Killed: 75, Timeout: 5, Survived: 15, NoCoverage: 5, Ignored: 20 } }],
  ['src/b.ts', { ms: 10_040, mutants: 50, statuses: { Killed: 40, Survived: 10 } }],
  ['src/c.ts', { ms: 20_000, mutants: 60, statuses: { Killed: 30, Survived: 20, NoCoverage: 10 } }],
  ['src/d.ts', { ms: 0, mutants: 3, statuses: { Ignored: 3 } }],
]);

test('a dealing holds each slice\'s seconds, score and floor and each file\'s measured figures, made from the files measured', () => {
  const dealing = deal(MEASURED, 2, { run: '41519740264', date: '2026-11-03' });
  assert.equal(dealing.measured, '2026-11-03');
  assert.equal(dealing.run, '41519740264');
  assert.equal(dealing.ignoreStatic, true);
  // Longest first: a (30 s) to slice 0, c (20 s) to slice 1, b (10 s) to slice 1, and d (0 s) to
  // slice 0 because slice 0 and slice 1 are tied at 30 s and a tie goes to the lower.
  assert.deepEqual(dealing.slices.map((s) => Object.keys(s.files)), [['src/a.ts', 'src/d.ts'], ['src/b.ts', 'src/c.ts']]);
  const [first, second] = dealing.slices;
  assert.deepEqual(first.files['src/a.ts'], { seconds: 30, mutants: 120, detected: 80, valid: 100 });
  assert.deepEqual(first.files['src/d.ts'], { seconds: 0, mutants: 3, detected: 0, valid: 0 });
  assert.deepEqual(
    { seconds: first.seconds, mutants: first.mutants, detected: first.detected, valid: first.valid, score: first.score, floor: first.floor },
    { seconds: 30, mutants: 123, detected: 80, valid: 100, score: 80, floor: 79 },
  );
  // b: 40 of 50, c: 30 of 60. 70 of 110 = 63.64 %.
  assert.deepEqual(second.files['src/b.ts'], { seconds: 10, mutants: 50, detected: 40, valid: 50 });
  assert.deepEqual(
    { seconds: second.seconds, mutants: second.mutants, detected: second.detected, valid: second.valid, score: second.score, floor: second.floor },
    { seconds: 30, mutants: 110, detected: 70, valid: 110, score: 63.64, floor: 62 },
  );
});

test('a dealing cannot be made from a file that was cut off', () => {
  const cut = new Map(MEASURED).set('src/e.ts', { ms: 5000, mutants: 40, statuses: { Killed: 10 } });
  assert.throws(() => deal(cut, 2), /not measured to the end: src\/e\.ts/);
});

test('the checked-in dealing covers files, slices and floors that agree with each other', () => {
  const dealing = JSON.parse(readFileSync(new URL('./mutation-slices.json', import.meta.url), 'utf8'));
  assert.ok(dealing.slices.length >= 1);
  const seen = new Set();
  dealing.slices.forEach((s, i) => {
    assert.equal(s.slice, i);
    const files = Object.entries(s.files);
    assert.equal(s.mutants, files.reduce((sum, [, f]) => sum + f.mutants, 0), `slice ${i} mutants`);
    assert.equal(s.detected, files.reduce((sum, [, f]) => sum + f.detected, 0), `slice ${i} detected`);
    assert.equal(s.valid, files.reduce((sum, [, f]) => sum + f.valid, 0), `slice ${i} valid`);
    assert.ok(Math.abs(s.seconds - files.reduce((sum, [, f]) => sum + f.seconds, 0)) < 0.5, `slice ${i} seconds`);
    assert.equal(s.floor, s.valid === 0 ? 0 : floorOf((s.detected / s.valid) * 100), `slice ${i} floor`);
    assert.ok(Math.abs(s.score - (s.detected / s.valid) * 100) < 0.01, `slice ${i} score`);
    for (const [file] of files) {
      assert.ok(!seen.has(file), `${file} is in two slices`);
      seen.add(file);
    }
  });
});

const DEALT = {
  slices: [
    { seconds: 100, files: { 'src/a.ts': { seconds: 60, mutants: 60 }, 'src/b.ts': { seconds: 40, mutants: 20 } } },
    { seconds: 90, files: { 'src/c.ts': { seconds: 90, mutants: 90 } } },
    { seconds: 200, files: { 'src/d.ts': { seconds: 200, mutants: 100 } } },
  ],
};

test("a new file goes to the slice with the least seconds so far, at its mutants times the dealing's median seconds a mutant", () => {
  const files = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/new1.ts', 'src/new2.ts'];
  // Seconds a mutant: a 1, b 2, c 1, d 2: the median is the upper middle, 2.
  const { placed, gone } = placeNew(DEALT, files, [{ file: 'src/new2.ts', mutants: 20 }, { file: 'src/new1.ts', mutants: 30 }]);
  // Name order: new1 first, to slice 1 (90 s, the least) at 60 s, which makes it 150;
  // new2 then to slice 0 (100 s) at 40 s.
  assert.deepEqual(placed, [
    { file: 'src/new1.ts', mutants: 30, slice: 1, seconds: 60 },
    { file: 'src/new2.ts', mutants: 20, slice: 0, seconds: 40 },
  ]);
  assert.deepEqual(gone, []);
  // A tie goes to the lower slice.
  const tie = placeNew({ slices: [{ seconds: 50, files: { 'src/x.ts': { seconds: 50, mutants: 50 } } }, { seconds: 50, files: { 'src/y.ts': { seconds: 50, mutants: 50 } } }] }, ['src/x.ts', 'src/y.ts', 'src/z.ts'], [{ file: 'src/z.ts', mutants: 1 }]);
  assert.equal(tie.placed[0].slice, 0);
});

test('a file the dealing knows is not placed again, a file that is gone is named and skipped, and a slice runs its files and the new ones placed in it', () => {
  const files = ['src/a.ts', 'src/c.ts', 'src/d.ts', 'src/new.ts'];
  const placement = placeNew(DEALT, files, [{ file: 'src/new.ts', mutants: 10 }, { file: 'src/a.ts', mutants: 60 }]);
  assert.deepEqual(placement.placed.map((p) => p.file), ['src/new.ts']);
  assert.deepEqual(placement.gone, ['src/b.ts']);
  assert.deepEqual(filesOf(DEALT, 0, files, placement.placed), ['src/a.ts']);
  assert.deepEqual(filesOf(DEALT, 1, files, placement.placed), ['src/c.ts', 'src/new.ts']);
  assert.deepEqual(filesOf(DEALT, 2, files, placement.placed), ['src/d.ts']);
});

test("the report says which new files landed in tonight's slice, and which in others, and which are gone", () => {
  const placement = { placed: [{ file: 'src/new1.ts', mutants: 30, slice: 1, seconds: 60 }, { file: 'src/new2.ts', mutants: 20, slice: 0, seconds: 40 }], gone: ['src/b.ts'] };
  const notes = dealingNotes(placement, 1);
  assert.equal(notes.length, 3);
  assert.match(notes[0], /Not in the dealing, placed in this slice by the rule \(least seconds so far\): src\/new1\.ts \(30 mutants\)\. The floor was measured without them\./);
  assert.match(notes[1], /placed in other slices: src\/new2\.ts → slice 0/);
  assert.match(notes[2], /In the dealing and gone: src\/b\.ts\./);
  assert.deepEqual(dealingNotes({ placed: [], gone: [] }, 1), []);
});

test("the summary names the slice, the score against its floor and the target, and the weakest file first", () => {
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
  const base = { slice: 3, of: 20, mutants: 15, files: [{}, {}, {}], measured: '2026-11-03' };
  const markdown = summaryMarkdown({ ...base, floor: 70, notes: ['Not in the dealing: x.'] }, summary);
  assert.match(markdown, /^## Mutation slice 3 of 20/);
  assert.match(markdown, /\*\*Score 71\.43 %\*\* against this slice's floor of 70 % \(at or above its floor\) and the target of 85 %: 10 of 14 mutants detected, 4 not, in 3 files\. Dealing measured 2026-11-03\./);
  assert.match(markdown, /\nNot in the dealing: x\.\n/);
  assert.match(summaryMarkdown({ ...base, floor: 72 }, summary), /\(UNDER ITS FLOOR\)/);
  assert.match(summaryMarkdown({ ...base, floor: 71 }, summary), /\(at or above its floor\)/);
  assert.ok(markdown.indexOf('src/weak.ts') < markdown.indexOf('src/strong.ts'));
  assert.match(markdown, /\| src\/weak\.ts \| 25\.00 % \| 1 \| 1 \| 2 \|/);
  // A run that did not finish has no report, and says so instead of a score.
  assert.match(summaryMarkdown({ ...base, floor: 70, mutants: 7000, files: [{}] }, null), /No report: Stryker did not finish \(7000 mutants in 1 files\)/);
});

test("a dear file is cut in line ranges at a line no mutant straddles, near where the mutants that cost time split evenly", () => {
  // Lines from 1. 8 mutants that are run, two that are not; the method on lines 31–50 holds three mutants and one that spans it.
  const at = (start, status, end = start) => ({ status, location: { start: { line: start }, end: { line: end } } });
  const mutants = [at(10, 'Killed'), at(10, 'Survived'), at(20, 'Killed'), at(32, 'Killed'), at(40, 'Timeout'), at(45, 'Survived'), at(60, 'Killed'), at(70, 'Killed'), at(15, 'NoCoverage'), at(65, 'Ignored'), at(31, 'Killed', 50)];
  const parts = splitEntry('src/big.ts', { ms: 90_000, mutants: 11, statuses: {} }, mutants, 2);
  // Half of the nine that cost time falls on line 31, which the method's own mutant (31–50) straddles:
  // the cut moves to 30, the nearest line nothing straddles.
  assert.deepEqual(parts.map(([key]) => key), ['src/big.ts:1-30', 'src/big.ts:31-99999']);
  assert.deepEqual(parts.map(([, e]) => e.mutants), [4, 7]);
  assert.deepEqual(parts[0][1].statuses, { Killed: 2, Survived: 1, NoCoverage: 1 });
  assert.deepEqual(parts[1][1].statuses, { Killed: 4, Timeout: 1, Survived: 1, Ignored: 1 });
  // Each part's share of the seconds is its share of the mutants that cost time (3 of 9, 6 of 9)...
  assert.deepEqual(parts.map(([, e]) => Math.round(e.ms)), [30_000, 60_000]);
  // ...and together the parts are the file, by Stryker's own rule: a mutant is run in the range that wholly holds it.
  const wholly = (from, to) => mutants.filter((m) => m.location.start.line >= from && m.location.end.line <= to).length;
  assert.equal(wholly(1, 30) + wholly(31, 99999), mutants.length);
  assert.equal(parts.reduce((sum, [, e]) => sum + scoreOfCounts(e.statuses).detected, 0), scoreOf(mutants.map((m) => m.status)).detected);
  assert.throws(() => splitEntry('src/big.ts', { ms: 1, mutants: 1, statuses: {} }, [at(1, 'Killed')], 2), /cannot be cut in 2 parts/);
  // A file one mutant covers from top to bottom has no line to cut at.
  assert.throws(() => splitEntry('src/one.ts', { ms: 1, mutants: 3, statuses: {} }, [at(1, 'Killed', 9), at(2, 'Killed'), at(3, 'Killed')], 2), /no line between its mutants/);
  // Three parts of a file whose mutants all sit on one line each: the cuts follow the lines.
  const flat = [at(5, 'Killed'), at(5, 'Killed'), at(8, 'Killed'), at(8, 'Killed'), at(12, 'Killed'), at(12, 'Killed')];
  assert.deepEqual(splitEntry('src/flat.ts', { ms: 6000, mutants: 6, statuses: {} }, flat, 3).map(([key]) => key), ['src/flat.ts:1-5', 'src/flat.ts:6-8', 'src/flat.ts:9-99999']);
});

test("a file's range key is the file as far as presence, newness and being gone go", () => {
  assert.equal(baseOf('src/big.ts:1-812'), 'src/big.ts');
  assert.equal(baseOf('src/big.ts:813-99999'), 'src/big.ts');
  assert.equal(baseOf('src/big.ts'), 'src/big.ts');
  assert.equal(baseOf('src/a:b.ts'), 'src/a:b.ts');
  const dealing = { slices: [{ seconds: 40, files: { 'src/big.ts:1-812': { seconds: 20, mutants: 10 }, 'src/a.ts': { seconds: 20, mutants: 10 } } }, { seconds: 20, files: { 'src/big.ts:813-99999': { seconds: 20, mutants: 10 } } }] };
  const files = ['src/a.ts', 'src/big.ts', 'src/new.ts'];
  const placement = placeNew(dealing, files, [{ file: 'src/new.ts', mutants: 5 }, { file: 'src/big.ts', mutants: 20 }]);
  // big.ts is known by its parts and is not placed again; new.ts is.
  assert.deepEqual(placement.placed.map((p) => p.file), ['src/new.ts']);
  assert.deepEqual(placement.gone, []);
  assert.deepEqual(filesOf(dealing, 0, files, placement.placed), ['src/a.ts', 'src/big.ts:1-812']);
  assert.deepEqual(filesOf(dealing, 1, files, placement.placed), ['src/big.ts:813-99999', 'src/new.ts']);
  // With the file gone, both its parts go.
  assert.deepEqual(filesOf(dealing, 1, ['src/a.ts'], []), []);
  assert.deepEqual(placeNew(dealing, ['src/a.ts'], []).gone, ['src/big.ts']);
});
