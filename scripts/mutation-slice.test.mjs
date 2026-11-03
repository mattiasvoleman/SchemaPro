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
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  balance,
  baseOf,
  dayOfYear,
  deal,
  dealingNotes,
  exitCodeFor,
  expectedMutants,
  filesOf,
  filesToMutate,
  floorOf,
  placeNew,
  plan,
  planRanges,
  rangeOf,
  remeasure,
  scoreOf,
  scoreOfCounts,
  shiftLimit,
  sliceLines,
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
  // The change of year breaks the rotation: 31 December is slice 5 and 1 January slice 1, so
  // slices 1 to 5 run twice in a row, and every other slice waits 25 or 26 nights over the turn
  // of the year. Within one year the wait is 20.
  assert.equal(tonightsSlice(new Date('2026-12-31T02:30:00Z'), 20), 5);
  assert.equal(tonightsSlice(new Date('2027-01-01T02:30:00Z'), 20), 1);
  const longestWait = (from, to) => {
    const wait = new Map();
    const last = new Map();
    for (let i = from; i < to; i++) {
      const slice = tonightsSlice(new Date(Date.UTC(2026, 0, 1 + i, 2, 30)), 20);
      if (last.has(slice)) wait.set(slice, Math.max(wait.get(slice) ?? 0, i - last.get(slice)));
      last.set(slice, i);
    }
    return Math.max(...wait.values());
  };
  assert.equal(longestWait(0, 365), 20);
  const overTheYears = longestWait(0, 3 * 366);
  assert.ok(overTheYears >= 25 && overTheYears <= 26, String(overTheYears));
});

test('the day and the slice are the UTC ones wherever the machine is: a night that is still the day before in Los Angeles', () => {
  const was = process.env.TZ;
  try {
    for (const zone of ['America/Los_Angeles', 'Pacific/Auckland', 'UTC']) {
      process.env.TZ = zone;
      // 02:30 UTC on 2 November is 19:30 on 1 November in Los Angeles and 15:30 on 2 November in Auckland.
      assert.equal(dayOfYear(new Date('2026-11-02T02:30:00Z')), 306, zone);
      assert.equal(dayOfYear(new Date('2026-01-01T00:00:00Z')), 1, zone);
      assert.equal(dayOfYear(new Date('2026-12-31T23:59:59Z')), 365, zone);
      assert.equal(tonightsSlice(new Date('2026-11-02T02:30:00Z'), 20), 6, zone);
    }
  } finally {
    if (was === undefined) delete process.env.TZ;
    else process.env.TZ = was;
  }
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

test("a slice measured again takes the run's figures and a floor of its score minus a point, rounded down; it never lowers a floor unless told to", () => {
  const dealing = {
    comment: 'x',
    slices: [
      { slice: 0, seconds: 50, mutants: 12, detected: 6, valid: 10, score: 60, floor: 58, files: { 'src/a.ts': { seconds: 30, mutants: 8, detected: 4, valid: 6 }, 'src/b.ts': { seconds: 20, mutants: 4, detected: 2, valid: 4 } } },
      { slice: 1, seconds: 9, mutants: 1, detected: 1, valid: 1, score: 100, floor: 98, files: { 'src/c.ts': { seconds: 9, mutants: 1, detected: 1, valid: 1 } } },
    ],
  };
  const killed = (n) => Array.from({ length: n }, () => ({ status: 'Killed' }));
  const survived = (n) => Array.from({ length: n }, () => ({ status: 'Survived' }));
  const better = { report: { files: { 'src/a.ts': { mutants: [...killed(6), ...survived(1), { status: 'Ignored' }] }, 'src/b.ts': { mutants: [...killed(3), ...survived(1)] } } }, times: { files: { 'src/a.ts': { ms: 28_040 }, 'src/b.ts': { ms: 19_000 } } } };
  const after = remeasure(dealing, 0, better, { date: '2026-12-01' });
  // 9 of 11 detected = 81.82 %: floor 80. Slice 1 is as it was.
  assert.deepEqual(after.slices[0], {
    slice: 0, seconds: 47, mutants: 12, detected: 9, valid: 11, score: 81.82, floor: 80, measured: '2026-12-01',
    files: { 'src/a.ts': { seconds: 28, mutants: 8, detected: 6, valid: 7 }, 'src/b.ts': { seconds: 19, mutants: 4, detected: 3, valid: 4 } },
  });
  assert.equal(after.slices[1], dealing.slices[1]);
  assert.equal(dealing.slices[0].floor, 58, 'the dealing given is not changed');
  // Worse than the floor it has: refused, unless it is meant.
  const worse = { ...better, report: { files: { 'src/a.ts': { mutants: [...killed(3), ...survived(4)] }, 'src/b.ts': { mutants: [...killed(1), ...survived(3)] } } } };
  assert.throws(() => remeasure(dealing, 0, worse), /would lower its floor from 58 % to 35 %: pass --lower/);
  assert.equal(remeasure(dealing, 0, worse, { lower: true }).slices[0].floor, 35);
  // A run of other files is not a measurement of this slice.
  assert.throws(() => remeasure(dealing, 0, { ...better, report: { files: { 'src/a.ts': better.report.files['src/a.ts'], 'src/c.ts': { mutants: killed(1) } } } }), /not run on its own files \(ran src\/c\.ts; did not run src\/b\.ts\)/);
  // A range key reads the file's figures: only that range ran.
  const ranged = { slices: [{ slice: 0, seconds: 5, mutants: 2, detected: 1, valid: 2, score: 50, floor: 49, files: { 'src/big.ts:1-30': { seconds: 5, mutants: 2, detected: 1, valid: 2 } } }] };
  const reranged = remeasure(ranged, 0, { report: { files: { 'src/big.ts': { mutants: [...killed(2), ...survived(1)] } } }, times: { files: { 'src/big.ts': { ms: 6000 } } } });
  assert.deepEqual(reranged.slices[0].files['src/big.ts:1-30'], { seconds: 6, mutants: 3, detected: 2, valid: 3 });
  assert.equal(reranged.slices[0].floor, 65);
});

// ---- A run of the script itself, with a Stryker that behaves like Stryker's exit code: it
// writes the report it is told to and exits 1 when the score is under `thresholds.break`
// of the config it was given, and 0 when the score is NaN (nothing valid to score). It can also
// ignore `break` (`ignoreBreak`), be killed after it has written the report (`dieAfterReport`),
// and exit with a code of its own after it (`exit`).
// The project has the script's own copy and a stand-in for Stryker's instrumenter, which makes
// the mutants a source file names on its first line, so that a file the dealing does not know,
// or a file dealt in line ranges, can be run without Stryker installed.

const SCRIPT = fileURLToPath(new URL('./mutation-slice.mjs', import.meta.url));

const FAKE_STRYKER = `#!/usr/bin/env node
const fs = require('node:fs');
const config = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const spec = JSON.parse(process.env.FAKE_STRYKER);
if (spec.die) process.kill(process.pid, 'SIGKILL');
const files = {};
for (const file of config.mutate) files[file] = { mutants: (spec.statuses[file] ?? []).map((status) => ({ status })) };
if (!spec.noReport) fs.writeFileSync(config.jsonReporter.fileName, JSON.stringify({ files }));
if (spec.dieAfterReport) process.kill(process.pid, 'SIGKILL');
if (spec.exit !== undefined) process.exit(spec.exit);
let detected = 0;
let undetected = 0;
for (const { mutants } of Object.values(files)) for (const { status } of mutants) {
  if (status === 'Killed' || status === 'Timeout') detected++;
  else if (status === 'Survived' || status === 'NoCoverage') undetected++;
}
const score = detected + undetected === 0 ? NaN : (100 * detected) / (detected + undetected);
process.exit(!spec.ignoreBreak && score < config.thresholds.break ? 1 : 0);
`;

// Stryker's instrumenter, API and typed-inject as the script imports them. A source file's first
// line is `// [[from, to, startColumn?, endColumn?], ...]`: the mutants it has, by the lines they
// span (from 1) and, if given, their columns. `mutate` is true or mutation ranges, lines from 0, and
// a mutant is made when a range holds it wholly, columns included, as Stryker's instrumenter has it.
const FAKE_INSTRUMENTER = `
export function createInstrumenter() {
  return {
    async instrument(files) {
      const mutants = [];
      for (const { name, content, mutate } of files) {
        for (const [from, to, startColumn = 0, endColumn = 8] of JSON.parse(content.split('\\n')[0].slice(3))) {
          const location = { start: { line: from - 1, column: startColumn }, end: { line: to - 1, column: endColumn } };
          const inside = mutate === true || mutate.some((r) => (r.start.line < location.start.line || (r.start.line === location.start.line && r.start.column <= location.start.column)) && (r.end.line > location.end.line || (r.end.line === location.end.line && r.end.column >= location.end.column)));
          if (inside) mutants.push({ fileName: name, location, mutatorName: 'Fake', replacement: 'x' });
        }
      }
      return { files, mutants };
    },
  };
}
`;

/** A source file of these mutants, each [from, to] lines from 1. */
const source = (...mutants) => `// ${JSON.stringify(mutants)}\n`;
/** `n` mutants on a line each. */
const lines = (n) => Array.from({ length: n }, (_, i) => [i + 1, i + 1]);

const repeat = (status, n) => Array.from({ length: n }, () => status);

function writeModule(dir, name, files) {
  mkdirSync(join(dir, 'node_modules', name), { recursive: true });
  for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, 'node_modules', name, file), content);
}

/**
 * A project of source files and a dealing; returns a function that runs the script in it, with
 * the script's own copy so that it finds the stand-ins for Stryker's modules. By default two files
 * and a slice 0 that holds both (each half of `mutants`) and an empty slice 1. `sources` is the
 * files by name (their first line says their mutants) and `slices` replaces the dealing's slices.
 */
function project({ floor = 70, mutants = 20, withFiles = true, sources, slices } = {}) {
  // The real path: the script runs only when it is the module node started, and node names it by its real path.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mutation-slice-')));
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
  const present = sources ?? (withFiles ? { 'src/a.js': '// source\n', 'src/b.js': '// source\n' } : {});
  for (const [name, content] of Object.entries(present)) writeFileSync(join(dir, name), content);
  writeFileSync(join(dir, 'stryker.conf.json'), JSON.stringify({ mutate: ['src/*.js'], thresholds: { high: 95, low: 85, break: 85 }, reporters: ['clear-text'] }));
  const half = mutants / 2;
  const entry = { seconds: 10, mutants: half, detected: 0, valid: half };
  writeFileSync(
    join(dir, 'scripts', 'mutation-slices.json'),
    JSON.stringify({
      measured: '2026-11-02',
      slices: slices ?? [
        { slice: 0, seconds: 20, mutants, detected: 0, valid: mutants, score: 0, floor, files: { 'src/a.js': entry, 'src/b.js': entry } },
        { slice: 1, seconds: 0, mutants: 0, detected: 0, valid: 0, score: null, floor: 0, files: {} },
      ],
    }),
  );
  writeFileSync(join(dir, 'node_modules', '.bin', 'stryker'), FAKE_STRYKER);
  chmodSync(join(dir, 'node_modules', '.bin', 'stryker'), 0o755);
  copyFileSync(SCRIPT, join(dir, 'scripts', 'mutation-slice.mjs'));
  const esm = (name, exports) => ({ 'package.json': JSON.stringify({ name, type: 'module', exports }) });
  writeModule(dir, '@stryker-mutator/instrumenter', { ...esm('@stryker-mutator/instrumenter', './index.js'), 'index.js': FAKE_INSTRUMENTER });
  writeModule(dir, '@stryker-mutator/api', { ...esm('@stryker-mutator/api', { './plugin': './plugin.js' }), 'plugin.js': "export const commonTokens = { logger: 'logger' };\n" });
  writeModule(dir, 'typed-inject', { ...esm('typed-inject', './index.js'), 'index.js': 'export function createInjector() { const injector = { provideValue: () => injector }; return injector; }\n' });
  const spawn = (args, env) => spawnSync(process.execPath, [join(dir, 'scripts', 'mutation-slice.mjs'), ...args], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  return {
    dir,
    spawn,
    remove: (name) => unlinkSync(join(dir, name)),
    run: (spec, { slice = 0, args = [] } = {}) => {
      const result = spawn(args, { MUTATION_SLICE: String(slice), FAKE_STRYKER: JSON.stringify(spec) });
      const read = (name) => (existsSync(join(dir, 'reports', 'mutation', `slice-${slice}`, name)) ? readFileSync(join(dir, 'reports', 'mutation', `slice-${slice}`, name), 'utf8') : null);
      return {
        code: result.status,
        out: result.stdout + result.stderr,
        summary: read('summary.md'),
        config: read('stryker.conf.json') === null ? null : JSON.parse(read('stryker.conf.json')),
      };
    },
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const statusesFor = (killed, survived) => ({ 'src/a.js': [...repeat('Killed', killed / 2), ...repeat('Survived', survived / 2)], 'src/b.js': [...repeat('Killed', killed / 2), ...repeat('Survived', survived / 2)] });

test("the night fails under the slice's floor and only then: break is the floor, not the floor minus one and not 85", () => {
  const p = project({ floor: 70, mutants: 20 });
  try {
    // 80 % against a floor of 70: passes, though 80 is under the target of 85.
    const above = p.run({ statuses: statusesFor(16, 4) });
    assert.equal(above.code, 0, above.out);
    assert.equal(above.config.thresholds.break, 70);
    assert.deepEqual(above.config.mutate, ['src/a.js', 'src/b.js']);
    assert.match(above.summary, /\*\*Score 80\.00 %\*\* against this slice's floor of 70 % \(at or above its floor\)/);
    // Exactly the floor passes.
    const exact = p.run({ statuses: statusesFor(14, 6) });
    assert.equal(exact.code, 0, exact.out);
    assert.match(exact.summary, /\*\*Score 70\.00 %\*\*.*\(at or above its floor\)/);
    // Under it fails.
    const under = p.run({ statuses: statusesFor(12, 8) });
    assert.equal(under.code, 1, under.out);
    assert.match(under.summary, /\*\*Score 60\.00 %\*\*.*\(UNDER ITS FLOOR\)/);
  } finally {
    p.done();
  }
});

test('a score a hair under the floor fails: the floor is not softened by a point', () => {
  const p = project({ floor: 70, mutants: 200 });
  try {
    // 139 of 200 = 69.5 %: under 70, over 69.
    const under = p.run({ statuses: { 'src/a.js': [...repeat('Killed', 70), ...repeat('Survived', 30)], 'src/b.js': [...repeat('Killed', 69), ...repeat('Survived', 31)] } });
    assert.equal(under.code, 1, under.out);
    assert.equal(under.config.thresholds.break, 70);
  } finally {
    p.done();
  }
});

test('a night that measured nothing is never a pass, whatever Stryker says: no files, nothing valid, no report, too few mutants, a killed Stryker', () => {
  // Every file of the slice is gone: Stryker would be given mutate: [] and score NaN.
  const gone = project({ withFiles: false });
  try {
    const result = spawnSync(process.execPath, [SCRIPT], { cwd: gone.dir, encoding: 'utf8', env: { PATH: process.env.PATH, MUTATION_SLICE: '0', FAKE_STRYKER: '{"statuses":{}}' } });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /Slice 0 has no file to mutate: every file in the dealing is gone/);
  } finally {
    gone.done();
  }

  const p = project({ floor: 70, mutants: 20 });
  try {
    // Files, a report, and nothing valid in it: NaN, which Stryker lets through with 0.
    const nothing = p.run({ statuses: { 'src/a.js': repeat('Ignored', 10), 'src/b.js': repeat('Ignored', 10) } });
    assert.equal(nothing.code, 1, nothing.out);
    assert.match(nothing.out, /the report holds no valid mutant, and a score of n\/a is not a pass/);
    // Stryker leaves no report and exits 0.
    const none = p.run({ statuses: statusesFor(20, 0), noReport: true });
    assert.equal(none.code, 1, none.out);
    assert.match(none.summary, /No report: Stryker did not finish/);
    assert.match(none.out, /Stryker left no report/);
    // A report with a third of the mutants the slice was dealt: the range matched less than it should.
    const few = p.run({ statuses: { 'src/a.js': repeat('Killed', 3), 'src/b.js': repeat('Killed', 3) } });
    assert.equal(few.code, 1, few.out);
    assert.match(few.out, /only 6 of the slice's 20 mutants were in the report/);
    assert.match(few.out, /run --remeasure on this run's artifact/);
    assert.doesNotMatch(few.out, /did not run/);
    // Stryker killed by a signal has no exit status, which is a failure.
    const killed = p.run({ statuses: {}, die: true });
    assert.equal(killed.code, 1, killed.out);
    assert.match(killed.summary, /No report/);
  } finally {
    p.done();
  }
});

test('the exit code keeps Stryker\'s when the run measured something, and is never 0 when it did not', () => {
  const measured = { total: { valid: 20, score: 80 } };
  const night = (over) => exitCodeFor({ status: 0, summary: measured, ran: 20, expected: 20, floor: 70, ...over });
  assert.deepEqual(night({}), { code: 0, reason: null });
  assert.deepEqual(night({ status: 1 }), { code: 1, reason: null });
  assert.equal(night({ status: null }).code, 1);
  assert.equal(night({ summary: null, ran: 0 }).code, 1);
  assert.equal(night({ summary: { total: { valid: 0, score: null } } }).code, 1);
  // 90 % of the expected mutants pass, 89 % do not.
  assert.equal(night({ ran: 90, expected: 100 }).code, 0);
  assert.equal(night({ ran: 89, expected: 100 }).code, 1);
  // Stryker's own failure code is kept.
  assert.equal(night({ status: 2, summary: null, ran: 0 }).code, 2);
  assert.equal(night({ status: 2, summary: { total: { valid: 20, score: 10 } } }).code, 2);
});

test('a score under the floor is red whatever Stryker\'s exit code says, and the floor itself passes', () => {
  const at = (score) => ({ total: { valid: 20, score } });
  const night = (over) => exitCodeFor({ status: 0, summary: at(80), ran: 20, expected: 20, floor: 70, ...over });
  assert.equal(night({ summary: at(70) }).code, 0);
  assert.equal(night({ summary: at(70.0001) }).code, 0);
  const under = night({ summary: at(69.9999) });
  assert.equal(under.code, 1);
  assert.match(under.reason, /the score 70\.00 % is under the slice's floor of 70 %, whatever Stryker's own exit code says/);
  assert.equal(night({ summary: at(0), floor: 1 }).code, 1);
  // The floor is the slice's own: a run is judged against it and not against the target.
  assert.equal(night({ summary: at(80), floor: 79 }).code, 0);
  assert.equal(night({ summary: at(80), floor: 81 }).code, 1);
  // A floor of 0 lets every score through, and its absence is a mistake in the caller, not a pass.
  assert.equal(night({ summary: at(0.5), floor: 0 }).code, 0);
  for (const floor of [undefined, null, NaN, '70']) assert.throws(() => night({ floor }), /needs the slice's floor/);
  // Stryker's failure code is kept when it is not 0.
  assert.equal(night({ status: 3, summary: at(10) }).code, 3);
});

test('a Stryker stopped by a signal after it wrote a perfect report is red, and says so', () => {
  const stopped = exitCodeFor({ status: null, summary: { total: { valid: 20, score: 100 } }, ran: 20, expected: 20, floor: 70 });
  assert.equal(stopped.code, 1);
  assert.match(stopped.reason, /stopped by a signal/);
  assert.equal(exitCodeFor({ status: undefined, summary: { total: { valid: 20, score: 100 } }, ran: 20, expected: 20, floor: 70 }).code, 1);
});

test('the summary calls a score exactly at the floor "at or above its floor"', () => {
  const summary = summarise({ files: { 'src/a.ts': { mutants: [...repeat('Killed', 7), ...repeat('Survived', 3)].map((status) => ({ status })) } } });
  assert.equal(summary.total.score, 70);
  const base = { slice: 3, of: 20, mutants: 10, files: [{}], measured: '2026-11-02' };
  assert.match(summaryMarkdown({ ...base, floor: 70 }, summary), /\(at or above its floor\)/);
  assert.match(summaryMarkdown({ ...base, floor: 71 }, summary), /\(UNDER ITS FLOOR\)/);
  assert.match(summaryMarkdown({ ...base, floor: 70 }, summarise({ files: { 'src/a.ts': { mutants: [{ status: 'Ignored' }] } } })), /\(no valid mutants\)/);
});

test('a slice with nothing valid in it has a floor of 0 and no score, and is still dealt', () => {
  const dealing = deal(new Map([['src/types.ts', { ms: 0, mutants: 3, statuses: { Ignored: 3 } }]]), 1, { date: '2026-11-02' });
  assert.deepEqual({ score: dealing.slices[0].score, floor: dealing.slices[0].floor, valid: dealing.slices[0].valid }, { score: null, floor: 0, valid: 0 });
});

test('--list shows a new file with the mutants counted for it, and `new` where the seconds would be', () => {
  const slice = { mutants: 30, seconds: 120, floor: 70, files: { 'src/a.ts': { seconds: 120, mutants: 30 } } };
  const lines = sliceLines(slice, 2, 20, 70, ['src/a.ts', 'src/fresh.ts'], ['Not in the dealing: fresh.'], [{ file: 'src/fresh.ts', mutants: 15, slice: 2, seconds: 40 }]);
  assert.equal(lines[0], 'Slice 2 of 20: 30 mutants in 2 files, about 2 min of mutation testing, floor 70 %');
  assert.equal(lines[1], '    30    120 s  src/a.ts');
  assert.equal(lines[2], '    15    new    src/fresh.ts');
  assert.equal(lines[3], 'Not in the dealing: fresh.');
});

test('--remeasure refuses a run that is not of the slice\'s own files, and accepts one that is: each guard on its own', () => {
  const dealing = {
    slices: [
      { slice: 0, seconds: 10, mutants: 3, detected: 2, valid: 3, score: 66.67, floor: 65, files: { 'src/a.ts': { seconds: 5, mutants: 2, detected: 1, valid: 2 }, 'src/types.ts': { seconds: 0, mutants: 0, detected: 0, valid: 0 }, 'src/b.ts': { seconds: 5, mutants: 1, detected: 1, valid: 1 } } },
      { slice: 1, seconds: 4, mutants: 2, detected: 1, valid: 2, score: 50, floor: 49, files: { 'src/big.ts:1-30': { seconds: 2, mutants: 1, detected: 1, valid: 1 }, 'src/big.ts:31-99999': { seconds: 2, mutants: 1, detected: 0, valid: 1 } } },
    ],
  };
  const ok = (n) => Array.from({ length: n }, () => ({ status: 'Killed' }));
  const run = (files) => ({ report: { files }, times: { files: {} } });
  const same = { 'src/a.ts': { mutants: ok(2) }, 'src/b.ts': { mutants: ok(1) } };
  // A file with no mutants is not run and not missed; exactly the same floor is accepted.
  const accepted = remeasure(dealing, 0, run(same));
  assert.equal(accepted.slices[0].floor, 99);
  assert.throws(() => remeasure(dealing, 0, run({ ...same, 'src/extra.ts': { mutants: ok(1) } })), /ran src\/extra\.ts; did not run none/);
  assert.throws(() => remeasure(dealing, 0, run({ 'src/a.ts': same['src/a.ts'] })), /ran no other file; did not run src\/b\.ts/);
  assert.throws(() => remeasure(dealing, 0, run({ 'src/a.ts': same['src/a.ts'], 'src/extra.ts': { mutants: ok(1) } })), /ran src\/extra\.ts; did not run src\/b\.ts/);
  // Two parts of one file in a slice cannot be told apart in a run of the file.
  assert.throws(() => remeasure(dealing, 1, run({ 'src/big.ts': { mutants: ok(2) } })), /holds two parts of one file/);
  // The floor is compared, not the score: a lower score with the same floor is accepted, a lower floor is not.
  const sameFloor = { slices: [{ slice: 0, seconds: 1, mutants: 10, detected: 7, valid: 10, score: 70.9, floor: 69, files: { 'src/a.ts': { seconds: 1, mutants: 10, detected: 7, valid: 10 } } }] };
  const lowerScore = { 'src/a.ts': { mutants: [...ok(7), ...Array.from({ length: 3 }, () => ({ status: 'Survived' }))] } };
  assert.equal(remeasure(sameFloor, 0, run({ 'src/a.ts': { mutants: [...ok(70), ...Array.from({ length: 30 }, () => ({ status: 'Survived' }))] } })).slices[0].floor, 69);
  assert.equal(remeasure(sameFloor, 0, run(lowerScore)).slices[0].floor, 69);
  assert.throws(() => remeasure(sameFloor, 0, run({ 'src/a.ts': { mutants: [...ok(6), ...Array.from({ length: 4 }, () => ({ status: 'Survived' }))] } })), /would lower its floor from 69 % to 59 %/);
});

test('the mutants a slice is expected to run are those of its dealt files that are still there and of the new files placed in it', () => {
  const dealt = { 'src/a.js': { mutants: 10 }, 'src/b.js': { mutants: 10 }, 'src/big.js:1-50': { mutants: 4 }, 'src/types.js': { mutants: 0 } };
  const placed = [{ file: 'src/new.js', mutants: 40, slice: 1, seconds: 3 }];
  assert.equal(expectedMutants(dealt, ['src/a.js', 'src/b.js'], []), 20);
  // A file that is gone is not among the slice's files, so it is not expected.
  assert.equal(expectedMutants(dealt, ['src/a.js'], []), 10);
  // A new file is expected to run the mutants counted for it.
  assert.equal(expectedMutants(dealt, ['src/a.js', 'src/new.js'], placed), 50);
  assert.equal(expectedMutants(dealt, ['src/new.js'], placed), 40);
  // A part of a file is read by its key, a file with no mutants adds none.
  assert.equal(expectedMutants(dealt, ['src/big.js:1-50', 'src/types.js'], placed), 4);
  assert.equal(expectedMutants(dealt, ['src/other.js'], placed), 0);
  assert.equal(expectedMutants({}, [], []), 0);
});

test('a new file the dealing does not know is expected to run all the mutants counted for it, so a run of a fraction of them is red', () => {
  // c.js is in no slice. It goes to slice 1, the one with the fewest seconds, and the instrumenter counts 40 mutants in it.
  const p = project({ sources: { 'src/a.js': source(), 'src/b.js': source(), 'src/c.js': source(...lines(40)) } });
  try {
    const whole = p.run({ statuses: { 'src/c.js': repeat('Killed', 40) } }, { slice: 1 });
    assert.equal(whole.code, 0, whole.out);
    assert.match(whole.out, /Not in the dealing, placed in this slice by the rule \(least seconds so far\): src\/c\.js \(40 mutants\)/);
    // 36 of the 40 is the 90 % that is enough; 10 is a file that has lost its code, or a range that matches little.
    assert.equal(p.run({ statuses: { 'src/c.js': repeat('Killed', 36) } }, { slice: 1 }).code, 0);
    const few = p.run({ statuses: { 'src/c.js': repeat('Killed', 10) } }, { slice: 1 });
    assert.equal(few.code, 1, few.out);
    assert.match(few.out, /only 10 of the slice's 40 mutants were in the report/);
  } finally {
    p.done();
  }
});

test('a file of the slice that is gone is not expected: the rest of the slice, whole, is a pass, and short is not', () => {
  const p = project({ floor: 70, mutants: 20 });
  try {
    p.remove('src/b.js');
    const rest = p.run({ statuses: { 'src/a.js': repeat('Killed', 10) } });
    assert.equal(rest.code, 0, rest.out);
    assert.match(rest.out, /In the dealing and gone: src\/b\.js\./);
    assert.deepEqual(rest.config.mutate, ['src/a.js']);
    // What is left ran half of what it was dealt: that is short, whatever became of the other file.
    const half = p.run({ statuses: { 'src/a.js': repeat('Killed', 5) } });
    assert.equal(half.code, 1, half.out);
    assert.match(half.out, /only 5 of the slice's 10 mutants were in the report/);
  } finally {
    p.done();
  }
});

test('a Stryker killed by a signal after it wrote its report is red, though the report is perfect', () => {
  const p = project({ floor: 70, mutants: 20 });
  try {
    const killed = p.run({ statuses: statusesFor(20, 0), dieAfterReport: true });
    assert.equal(killed.code, 1, killed.out);
    assert.match(killed.out, /stopped by a signal after it wrote its report/);
    assert.match(killed.summary, /\*\*Score 100\.00 %\*\*/);
    assert.equal(p.run({ statuses: statusesFor(20, 0) }).code, 0);
  } finally {
    p.done();
  }
});

test('the script compares the floor itself: a Stryker that lets a score under the floor through does not make the night green', () => {
  const p = project({ floor: 70, mutants: 200 });
  try {
    const half = (killed, survived) => ({ 'src/a.js': [...repeat('Killed', killed / 2), ...repeat('Survived', survived / 2)], 'src/b.js': [...repeat('Killed', killed / 2), ...repeat('Survived', survived / 2)] });
    const under = p.run({ statuses: half(120, 80), ignoreBreak: true });
    assert.equal(under.code, 1, under.out);
    assert.match(under.out, /the score 60\.00 % is under the slice's floor of 70 %, whatever Stryker's own exit code says/);
    // A hair under (139 of 200 is 69.5 %) and exactly the floor (140 of 200), and above it.
    const hair = p.run({ statuses: { 'src/a.js': [...repeat('Killed', 70), ...repeat('Survived', 30)], 'src/b.js': [...repeat('Killed', 69), ...repeat('Survived', 31)] }, ignoreBreak: true });
    assert.equal(hair.code, 1, hair.out);
    assert.equal(p.run({ statuses: half(140, 60), ignoreBreak: true }).code, 0);
    assert.equal(p.run({ statuses: half(160, 40), ignoreBreak: true }).code, 0);
  } finally {
    p.done();
  }
});

test('a range key names its lines, and a whole file names none', () => {
  assert.deepEqual(rangeOf('src/big.ts:1-2092'), { from: 1, to: 2092 });
  assert.deepEqual(rangeOf('src/big.ts:2093-99999'), { from: 2093, to: 99999 });
  assert.equal(rangeOf('src/big.ts'), null);
  assert.equal(rangeOf('src/a:b.ts'), null);
});

// ---- A file dealt in line ranges: the cuts as they are tonight, and every mutant in exactly one range.

/** Stryker's own test of whether a range holds a location wholly, columns included. */
const holds = (r, location) =>
  (r.start.line < location.start.line || (r.start.line === location.start.line && r.start.column <= location.start.column)) &&
  (r.end.line > location.end.line || (r.end.line === location.end.line && r.end.column >= location.end.column));

/** The instrumenter's mutants by the lines they span (from 1, columns optional), as it gives them (lines from 0), for `true` or ranges. */
const mutantsStub = (files, calls = []) => async (file, mutate) => {
  calls.push([file, mutate]);
  return (files[file] ?? [])
    .map(([from, to, startColumn = 0, endColumn = 8]) => ({ location: { start: { line: from - 1, column: startColumn }, end: { line: to - 1, column: endColumn } } }))
    .filter((m) => mutate === true || mutate.some((r) => holds(r, m.location)));
};

/** A dealing of the given slices, each a list of keys, each key with this many dealt mutants. */
const dealtAs = (...slices) => ({ slices: slices.map((keys, slice) => ({ slice, files: Object.fromEntries(keys.map((key) => [key, { mutants: 100 }])) })) });

/** Plan the cuts of `src/x.ts` dealt as these ranges (each a slice of its own) over these mutants. */
const planOf = (ranges, mutants, options) => planRanges(dealtAs(...ranges.map((r) => [`src/x.ts:${r}`])), ['src/x.ts'], mutantsStub({ 'src/x.ts': mutants }), options);
/** What the plan runs, as the keys with the file taken off. */
const runs = (plan) => [...plan.effective.values()].map((key) => key.replace('src/x.ts', ''));

test('a limit on a move is a tenth of the smaller part, as the 90 % guard lets a part lose', () => {
  assert.equal(shiftLimit(848), 84);
  assert.equal(shiftLimit(1425), 142);
  assert.equal(shiftLimit(100), 10);
  assert.equal(shiftLimit(9), 0);
  assert.equal(shiftLimit(0), 0);
});

test('cuts that no mutant crosses stay where the dealing has them, in one slice or two, in order or not, and nothing is said', async () => {
  const stub = mutantsStub({ 'src/big.ts': [[1, 1], [10, 12], [49, 50], [51, 51], [60, 70]] });
  const dealt = dealtAs(['src/big.ts:1-50', 'src/a.ts'], ['src/big.ts:51-99999']);
  const plan = await planRanges(dealt, ['src/big.ts', 'src/a.ts'], stub);
  assert.deepEqual([...plan.effective], [['src/big.ts:1-50', 'src/big.ts:1-50'], ['src/big.ts:51-99999', 'src/big.ts:51-99999']]);
  assert.deepEqual({ notes: plan.notes, moves: plan.moves, problems: plan.problems }, { notes: [], moves: [], problems: [] });
  assert.deepEqual([...(await planRanges(dealtAs(['src/big.ts:51-99999'], ['src/big.ts:1-50']), ['src/big.ts'], stub)).effective.values()], ['src/big.ts:1-50', 'src/big.ts:51-99999']);
  // Three parts; a whole file in the dealing is not a range and is not asked for.
  const three = mutantsStub({ 'src/big.ts': [[1, 1], [3, 9], [20, 30], [60, 70]] });
  const parts = await planRanges(dealtAs(['src/big.ts:1-10', 'src/whole.ts'], ['src/big.ts:11-50'], ['src/big.ts:51-99999']), ['src/big.ts', 'src/whole.ts'], three);
  assert.deepEqual([parts.notes, parts.problems], [[], []]);
  assert.equal(parts.effective.size, 3);
  // A file that is gone has nothing to lose, and no range keys is nothing to ask.
  const gone = await planRanges(dealtAs(['src/big.ts:1-50'], ['src/big.ts:51-99999']), [], async () => assert.fail('asked for a file that is gone'));
  assert.deepEqual([gone.effective.size, gone.problems], [0, []]);
  assert.equal((await planRanges(dealtAs(['src/a.ts']), ['src/a.ts'], async () => assert.fail('asked for a file with no ranges'))).effective.size, 0);
});

test('a slice asks about the files it holds and no others: a file it has no part of is not asked for, and cannot make it red', async () => {
  const calls = [];
  const stub = mutantsStub({ 'src/big.ts': [[1, 10]], 'src/other.ts': [[1, 1], [60, 70]] }, calls);
  const dealt = dealtAs(['src/big.ts:1-3', 'src/other.ts:1-50'], ['src/big.ts:4-5', 'src/other.ts:51-99999']);
  // big.ts cannot be cut (one mutant spans it all); other.ts can.
  const held = await planRanges(dealt, ['src/big.ts', 'src/other.ts'], stub, { only: new Set(['src/other.ts']) });
  assert.deepEqual([held.problems, [...held.effective.keys()]], [[], ['src/other.ts:1-50', 'src/other.ts:51-99999']]);
  assert.ok(calls.every(([file]) => file === 'src/other.ts'), JSON.stringify(calls));
  // Asked about all of them, as --check-ranges does, it is a problem.
  const every = await planRanges(dealt, ['src/big.ts', 'src/other.ts'], stub);
  assert.equal(every.problems.length, 1);
  assert.match(every.problems[0], /^src\/big\.ts is dealt in the line ranges :1-3, :4-5/);
  // A slice that holds nothing of them asks for nothing.
  assert.equal((await planRanges(dealt, ['src/big.ts'], async () => assert.fail('asked'), { only: new Set(['src/c.ts']) })).effective.size, 0);
});

test('a cut a mutant crosses is moved to the nearest line none crosses; the dealing keeps its line as a hint, and the move is said', async () => {
  // [45, 55] starts before the cut at line 50 and ends after it.
  const plan = await planOf(['1-50', '51-99999'], [[1, 1], [10, 12], [45, 55], [60, 70]]);
  assert.deepEqual(plan.problems, []);
  // The nearest line no mutant crosses is 55 (the mutant ends there); 44 is further off.
  assert.deepEqual(runs(plan), [':1-55', ':56-99999']);
  assert.deepEqual([...plan.effective], [['src/x.ts:1-50', 'src/x.ts:1-55'], ['src/x.ts:51-99999', 'src/x.ts:56-99999']]);
  assert.deepEqual(plan.moves, [{ file: 'src/x.ts', hint: 50, line: 55, handed: 0 }]);
  assert.equal(plan.notes.length, 1);
  assert.match(plan.notes[0], /^src\/x\.ts: a mutant crosses the cut at line 50, so tonight the parts are :1-55 and :56-99999 \(the nearest line none crosses; 0 mutants change part\)\. scripts\/mutation-slices\.json keeps :1-50, :51-99999 as its hint\.$/);
  // With these keys the parts hold the file, so nothing is moved.
  assert.deepEqual((await planOf(['1-55', '56-99999'], [[1, 1], [10, 12], [45, 55], [60, 70]])).moves, []);
});

test('the move goes to the nearer side, the lower of two equally near, and stays between the parts it divides', async () => {
  // A mutant on the cut line, running past it: line 49 is free and one step away.
  assert.deepEqual(runs(await planOf(['1-50', '51-99999'], [[50, 60], [70, 70]])), [':1-49', ':50-99999']);
  // A mutant that ends on the cut line is wholly in the part before it, and does not cross it.
  const ends = await planOf(['1-50', '51-60'], [[45, 50], [70, 70]]);
  assert.deepEqual(ends.moves, []);
  // As near below as above: the one below.
  assert.deepEqual(runs(await planOf(['1-50', '51-99999'], [[49, 52]])), [':1-48', ':49-99999']);
  // The first line of the part before the cut is the lowest it may go to, and the last line of the part after it is not allowed.
  const lowest = await planOf(['5-10', '11-12'], [[6, 12]]);
  assert.deepEqual(runs(lowest), [':5-5', ':6-12']);
  // Line 4 is free and nearer than anything else, but it is before the part that starts at line 5: not a place for the cut.
  const below = await planOf(['5-10', '11-12'], [[5, 12]]);
  assert.match(below.problems[0], /a mutant crosses the cut at line 10 with no line near it/);
  const highest = await planOf(['1-50', '51-60'], [[40, 49], [49, 60]]);
  assert.deepEqual(runs(highest), [':1-39', ':40-60']);
  assert.equal(highest.moves[0].handed, 1, 'the mutant on lines 40-49 changes part');
  assert.match(highest.notes[0], /\(the nearest line none crosses; 1 mutant changes part\)/);
  // The ranges are read in line order whichever slice holds them first.
  const unsorted = await planOf(['51-99999', '1-50'], [[1, 1], [45, 55], [60, 70]]);
  assert.deepEqual(runs(unsorted), [':1-55', ':56-99999']);
});

test('every cut a mutant crosses is moved, one that none crosses stays, and the keys that result follow on from one another', async () => {
  const three = ['1-50', '51-100', '101-99999'];
  assert.deepEqual(runs(await planOf(three, [[45, 55], [95, 105], [200, 200]])), [':1-55', ':56-105', ':106-99999']);
  assert.deepEqual(runs(await planOf(three, [[45, 55], [200, 200]])), [':1-55', ':56-100', ':101-99999']);
  const both = await planOf(three, [[45, 55], [95, 105], [200, 200]]);
  assert.deepEqual(both.moves.map((m) => [m.hint, m.line]), [[50, 55], [100, 105]]);
  assert.equal(both.notes.length, 2);
  // Two cuts that would land on the same line leave no parts that follow on: said, not run.
  const collide = await planOf(['1-50', '51-60', '61-99999'], [[40, 49], [49, 56], [57, 62], [62, 70]]);
  assert.equal(collide.problems.length, 1);
  assert.match(collide.problems[0], /a mutant crosses the cut at line 50 and 60 with no line near it, between the parts, that none crosses/);
  assert.match(collide.problems[0], /Cut src\/x\.ts somewhere else in scripts\/mutation-slices\.json, or make a new dealing with --deal\./);
});

test('a move that hands over more than a part may lose is a dealing too old to go on with; one within the limit is not', async () => {
  // A block over lines 30-70 crosses the cut at 50. The nearest free line is 70, and the 30 mutants on lines 52-66 change part.
  const inside = Array.from({ length: 30 }, (_, i) => [52 + (i % 15), 52 + (i % 15)]);
  const mutants = [[30, 70], ...inside];
  // Each part was dealt 100 mutants: a part may lose ten.
  const red = await planOf(['1-50', '51-99999'], mutants);
  assert.equal(red.problems.length, 1);
  assert.match(red.problems[0], /^src\/x\.ts is dealt in the line ranges :1-50, :51-99999, and the cut at line 50 would move to line 70 and hand 30 mutants to the other part, more than the 10 that a move may: the dealing is out of date, so make a new dealing with --deal\.$/);
  assert.deepEqual([red.moves, runs(red)], [[], [':1-50', ':51-99999']], 'nothing is moved when the move is too far');
  // The limit is a tenth of the smaller part: 30 is within it when the smaller part was dealt 300 mutants.
  const roomy = planRanges({ slices: [{ files: { 'src/x.ts:1-50': { mutants: 300 } } }, { files: { 'src/x.ts:51-99999': { mutants: 900 } } }] }, ['src/x.ts'], mutantsStub({ 'src/x.ts': mutants }));
  assert.deepEqual(runs(await roomy), [':1-70', ':71-99999']);
  // What changes part is what lies wholly in the lines between the hint and the new cut, the new cut's line included
  // and the hint's line not: [50, 50] is on the hint's line and stays, [70, 70] is on the new cut's line and moves.
  const edges = await planOf(['1-50', '51-99999'], [[30, 70], [50, 50], [70, 70], [55, 55], [60, 62]], { maxShift: 99 });
  assert.deepEqual([edges.moves[0].line, edges.moves[0].handed], [70, 3]);
  // The smaller of the two parts sets the limit and not the larger: 50 mutants handed to a part dealt 300 is more than a tenth of it.
  const fifty = Array.from({ length: 50 }, (_, i) => [52 + (i % 15), 52 + (i % 15)]);
  const lopsided = await planRanges({ slices: [{ files: { 'src/x.ts:1-50': { mutants: 300 } } }, { files: { 'src/x.ts:51-99999': { mutants: 900 } } }] }, ['src/x.ts'], mutantsStub({ 'src/x.ts': [[30, 70], ...fifty] }));
  assert.match(lopsided.problems[0], /hand 50 mutants to the other part, more than the 30 that a move may/);
  const lopsided2 = await planRanges({ slices: [{ files: { 'src/x.ts:1-50': { mutants: 900 } } }, { files: { 'src/x.ts:51-99999': { mutants: 300 } } }] }, ['src/x.ts'], mutantsStub({ 'src/x.ts': [[30, 70], ...fifty] }));
  assert.match(lopsided2.problems[0], /more than the 30 that a move may/);
  // Exactly the limit passes, one over does not; a limit can also be given.
  assert.equal((await planOf(['1-50', '51-99999'], mutants, { maxShift: 30 })).problems.length, 0);
  assert.equal((await planOf(['1-50', '51-99999'], mutants, { maxShift: 29 })).problems.length, 1);
  // A part the dealing gives no mutants for may hand over none.
  const none = await planRanges({ slices: [{ files: { 'src/x.ts:1-50': {} } }, { files: { 'src/x.ts:51-99999': {} } }] }, ['src/x.ts'], mutantsStub({ 'src/x.ts': [[45, 55]] }));
  assert.equal(none.problems.length, 0, 'a move of no mutants is within a limit of none');
  const none2 = await planRanges({ slices: [{ files: { 'src/x.ts:1-50': {} } }, { files: { 'src/x.ts:51-99999': {} } }] }, ['src/x.ts'], mutantsStub({ 'src/x.ts': [[30, 70], [60, 60]] }));
  assert.equal(none2.problems.length, 1);
});

test('ranges that overlap run a mutant twice, ranges that stop short or start late lose mutants: these are for the dealing, not for a cut to move', async () => {
  // Two ranges that share lines 40-50: a mutant there is run by both slices.
  const overlap = await planOf(['1-50', '40-99999'], [[42, 44], [60, 61]]);
  assert.match(overlap.problems[0], /hold 3 mutants, and the file has 2: 1 mutant is in two ranges, so two slices run it\./);
  assert.match(overlap.problems[0], /make the keys of src\/x\.ts in scripts\/mutation-slices\.json follow on from one another, the first from line 1 and the last to line 99999/);
  // The last range stops at 60 and a mutant is on line 70; the first starts at 10 and a mutant is on line 2.
  const short = await planOf(['1-50', '51-60'], [[70, 70]]);
  assert.match(short.problems[0], /hold 0 mutants, and the file has 1: 1 mutant lies outside the ranges, so no slice runs it/);
  const late = await planOf(['10-50', '51-99999'], [[2, 2], [60, 60]]);
  assert.match(late.problems[0], /hold 1 mutants, and the file has 2/);
  // One range alone is a file cut short, not a cut: nothing to move.
  assert.match((await planOf(['1-2000'], [[3000, 3000]])).problems[0], /follow on from one another/);
  // One mutant lost and another run twice give the same totals as a file with nothing wrong: 2 held, 2 in the file.
  const balanced = await planOf(['1-50', '40-60'], [[42, 44], [70, 70]]);
  assert.equal(balanced.problems.length, 1);
  assert.match(balanced.problems[0], /which hold 2 mutants, and the file has 2: 1 mutant lies outside the ranges, so no slice runs it; and 1 mutant is in two ranges, so two slices run it\./);
  // Two identical mutants (one place, one mutation) are two, so a range that holds only one of them is a loss.
  const at = (startLine, endLine, endColumn) => ({ location: { start: { line: startLine, column: 0 }, end: { line: endLine, column: endColumn } } });
  const twins = await planRanges(dealtAs(['src/x.ts:1-50'], ['src/x.ts:51-99999']), ['src/x.ts'], async (file, mutate) => (mutate === true ? [at(5, 5, 4), at(5, 5, 4), at(5, 5, 4)] : mutate[0].start.line === 0 ? [at(5, 5, 4)] : []));
  assert.match(twins.problems[0], /hold 1 mutants, and the file has 3: 2 mutants lie outside the ranges/);
  // Each file is its own problem, in name order.
  const two = await planRanges(dealtAs(['src/y.ts:1-5', 'src/x.ts:1-5'], ['src/y.ts:7-99999', 'src/x.ts:7-99999']), ['src/x.ts', 'src/y.ts'], mutantsStub({ 'src/x.ts': [[4, 8]], 'src/y.ts': [[4, 8]] }));
  assert.equal(two.problems.length, 2);
  assert.deepEqual(two.problems.map((text) => text.split(' ')[0]), ['src/x.ts', 'src/y.ts']);
});

test("a range is asked for the way Stryker's own reader reads file:from-to: whole lines, from column 0 to the last column, lines from 0", async () => {
  const calls = [];
  // A mutant that starts in column 0 of the first line of its range and one that ends in a column far out on the last line of its range.
  const stub = mutantsStub({ 'src/x.ts': [[1, 1, 0, 20], [5, 5, 0, 99], [6, 6, 0, 3], [9, 9, 0, 120]] }, calls);
  const plan = await planRanges(dealtAs(['src/x.ts:1-5'], ['src/x.ts:6-99999']), ['src/x.ts'], stub);
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(calls, [
    ['src/x.ts', true],
    ['src/x.ts', [{ start: { line: 0, column: 0 }, end: { line: 4, column: Number.MAX_SAFE_INTEGER } }]],
    ['src/x.ts', [{ start: { line: 5, column: 0 }, end: { line: 99998, column: Number.MAX_SAFE_INTEGER } }]],
  ]);
});

test('with the real instrumenter a mutant in column 0 and one far out on the last line of a range are in the range', async (t) => {
  let real;
  try {
    await import('@stryker-mutator/instrumenter');
    await import('@stryker-mutator/api/plugin');
    await import('typed-inject');
    real = (await import('./mutation-slice.mjs')).mutantsOf;
  } catch {
    t.skip('Stryker is not installed here (npm run test:mutation installs it)');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'mutation-slice-real-'));
  try {
    const file = join(dir, 'x.ts');
    // A statement that starts in column 0 on its first line; the file's last line ends in a column far out.
    writeFileSync(file, '[1, 2].forEach((x) => x + 1);\nconst y = 1 + 2;\nexport const z = y > 0 ? "long enough to end far out on the line" : "other";\n');
    const everything = await real(file, true);
    assert.ok(everything.length >= 5, String(everything.length));
    const plan = await planRanges({ slices: [{ files: { [`${file}:1-3`]: { mutants: everything.length } } }] }, [file], real);
    assert.deepEqual(plan.problems, []);
    // Cut in two, at a line no mutant crosses: the parts hold the file, each mutant once.
    const cut = await planRanges({ slices: [{ files: { [`${file}:1-1`]: { mutants: 10 } } }, { files: { [`${file}:2-99999`]: { mutants: 10 } } }] }, [file], real);
    assert.deepEqual(cut.problems, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Slices over a file dealt in two ranges. `big.js` is cut at line 50 and has a mutant over lines 45-55 when it is CROSSED.
const CROSSED = { 'src/big.js': source([1, 1], [10, 12], [45, 55], [60, 70]), 'src/a.js': source() };
const CLEAN = { 'src/big.js': source([1, 1], [10, 12], [60, 70]), 'src/a.js': source() };
const RANGED = [
  { slice: 0, seconds: 20, mutants: 2, detected: 2, valid: 2, score: 100, floor: 98, files: { 'src/a.js': { seconds: 5, mutants: 0, detected: 0, valid: 0 }, 'src/big.js:1-50': { seconds: 10, mutants: 2, detected: 2, valid: 2 } } },
  { slice: 1, seconds: 10, mutants: 1, detected: 1, valid: 1, score: 100, floor: 98, files: { 'src/big.js:51-99999': { seconds: 10, mutants: 1, detected: 1, valid: 1 } } },
  { slice: 2, seconds: 0, mutants: 0, detected: 0, valid: 0, score: null, floor: 0, files: {} },
];

test('--check-ranges asks Stryker\'s instrumenter and says where each cut is tonight: green when a cut can move, red when it cannot', () => {
  const crossed = project({ sources: CROSSED, slices: RANGED });
  const clean = project({ sources: CLEAN, slices: RANGED });
  // One mutant over the whole of both parts: no line between them is free.
  const stuck = project({ sources: { 'src/big.js': source([1, 10]), 'src/a.js': source() }, slices: RANGED.map((s) => ({ ...s, files: Object.fromEntries(Object.entries(s.files).map(([key, f]) => [key.replace(':1-50', ':1-3').replace(':51-99999', ':4-5'), f])) })) });
  try {
    const moved = crossed.spawn(['--check-ranges'], {});
    assert.equal(moved.status, 0, moved.stdout + moved.stderr);
    assert.match(moved.stdout, /src\/big\.js: a mutant crosses the cut at line 50, so tonight the parts are :1-55 and :56-99999 \(the nearest line none crosses; 0 mutants change part\)\./);
    assert.match(moved.stdout, /Every file dealt in line ranges has each of its mutants in exactly one range, with the cuts above moved\./);
    const good = clean.spawn(['--check-ranges'], {});
    assert.equal(good.status, 0, good.stdout + good.stderr);
    assert.equal(good.stdout, 'Every file dealt in line ranges has each of its mutants in exactly one range.\n');
    const bad = stuck.spawn(['--check-ranges'], {});
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    assert.match(bad.stderr, /src\/big\.js is dealt in the line ranges :1-3, :4-5, and a mutant crosses the cut at line 3 with no line near it/);
    // The check is of the files as they are: the file gone, nothing to lose.
    stuck.remove('src/big.js');
    assert.equal(stuck.spawn(['--check-ranges'], {}).status, 0);
  } finally {
    crossed.done();
    clean.done();
    stuck.done();
  }
});

test('a slice runs the parts as they are tonight, says so, and is green: nothing in the dealing is renamed, and Stryker\'s own failure code is kept', () => {
  const crossed = project({ sources: CROSSED, slices: RANGED });
  try {
    // Stryker's report is by the keys it was given: tonight's, `src/big.js:1-55`, which holds 3 mutants.
    const statuses = { 'src/a.js': [], 'src/big.js:1-55': repeat('Killed', 3) };
    const green = crossed.run({ statuses }, { slice: 0 });
    assert.equal(green.code, 0, green.out);
    assert.deepEqual(green.config.mutate, ['src/a.js', 'src/big.js:1-55']);
    assert.match(green.out, /src\/big\.js: a mutant crosses the cut at line 50, so tonight the parts are :1-55 and :56-99999/);
    assert.match(green.summary, /\*\*Score 100\.00 %\*\* against this slice's floor of 98 %/);
    assert.match(green.summary, /src\/big\.js: a mutant crosses the cut at line 50/);
    const manifest = JSON.parse(readFileSync(join(crossed.dir, 'reports', 'mutation', 'slice-0', 'slice.json'), 'utf8'));
    assert.deepEqual(manifest.files, ['src/a.js', 'src/big.js:1-55']);
    assert.ok(manifest.notes.some((note) => /tonight the parts are :1-55 and :56-99999/.test(note)));
    assert.equal(readFileSync(join(crossed.dir, 'scripts', 'mutation-slices.json'), 'utf8').includes('src/big.js:1-50'), true, 'the dealing is as it was');
    // The other part is run as :56-99999.
    const other = crossed.run({ statuses: { 'src/big.js:56-99999': repeat('Killed', 1) } }, { slice: 1 });
    assert.equal(other.code, 0, other.out);
    assert.deepEqual(other.config.mutate, ['src/big.js:56-99999']);
    // On Actions the note is in the group of the slice's files; Stryker's own failure code is kept.
    assert.equal(crossed.run({ statuses, exit: 2 }, { slice: 0 }).code, 2);
    // A slice that is short of mutants is short whether or not a cut moved.
    assert.equal(crossed.run({ statuses: { 'src/a.js': [], 'src/big.js:1-55': [] } }, { slice: 0 }).code, 1);
  } finally {
    crossed.done();
  }
});

test('a slice is red for a file it holds that cannot be run in parts, with a message on Actions, and a slice that holds none of it is green', () => {
  // One mutant over lines 1-10 crosses every line a cut could go to between the two parts.
  const slices = [
    { slice: 0, seconds: 20, mutants: 1, detected: 1, valid: 1, score: 100, floor: 98, files: { 'src/big.js:1-3': { seconds: 10, mutants: 1, detected: 1, valid: 1 } } },
    { slice: 1, seconds: 10, mutants: 0, detected: 0, valid: 0, score: null, floor: 0, files: { 'src/big.js:4-5': { seconds: 10, mutants: 0, detected: 0, valid: 0 } } },
    { slice: 2, seconds: 5, mutants: 2, detected: 2, valid: 2, score: 100, floor: 98, files: { 'src/a.js': { seconds: 5, mutants: 2, detected: 2, valid: 2 } } },
  ];
  const p = project({ sources: { 'src/big.js': source([1, 10]), 'src/a.js': source() }, slices });
  try {
    const statuses = { 'src/big.js:1-3': repeat('Killed', 1), 'src/a.js': repeat('Killed', 2) };
    const red = p.run({ statuses }, { slice: 0 });
    assert.equal(red.code, 1, red.out);
    assert.match(red.out, /src\/big\.js is dealt in the line ranges :1-3, :4-5, and a mutant crosses the cut at line 3 with no line near it/);
    assert.match(red.out, /the line ranges of a file it holds cannot be run as dealt \(above\), so the night is red until the dealing is made again/);
    // It ran as dealt, and the score is true: the summary has it, and the problem under it.
    assert.deepEqual(red.config.mutate, ['src/big.js:1-3']);
    assert.match(red.summary, /\*\*Score 100\.00 %\*\*.*\n\nsrc\/big\.js is dealt in the line ranges/);
    // On Actions it is an annotation, outside the collapsed group of the slice's files.
    const onActions = p.spawn([], { MUTATION_SLICE: '0', FAKE_STRYKER: JSON.stringify({ statuses }), GITHUB_ACTIONS: 'true' });
    assert.match(onActions.stderr, /^::error::src\/big\.js is dealt in the line ranges/m);
    // Stryker's own failure code is kept.
    assert.equal(p.run({ statuses, exit: 2 }, { slice: 0 }).code, 2);
    assert.equal(p.run({ statuses: { 'src/big.js:4-5': [] } }, { slice: 1 }).code, 1);
    // A slice with none of the file is green, and is not asked: nothing is said about it.
    const green = p.run({ statuses: { 'src/a.js': repeat('Killed', 2) } }, { slice: 2 });
    assert.equal(green.code, 0, green.out);
    assert.doesNotMatch(green.out, /line ranges|cut at line/);
  } finally {
    p.done();
  }
});

test('the script runs when node was given a path through a symlink, which node resolves differently from how it was typed, and not when it is imported', () => {
  const p = project();
  const links = [];
  try {
    const script = join(p.dir, 'scripts', 'mutation-slice.mjs');
    const plan = (path) => spawnSync(process.execPath, [path, '--plan'], { cwd: p.dir, encoding: 'utf8', env: { PATH: process.env.PATH, MUTATION_SLICE: '' } });
    const ran = /^slices=\[\d+\]\nof=2\n$/;
    // As CI calls it (relative to the checkout), and by its real absolute path.
    const relative = spawnSync(process.execPath, ['scripts/mutation-slice.mjs', '--plan'], { cwd: p.dir, encoding: 'utf8', env: { PATH: process.env.PATH, MUTATION_SLICE: '' } });
    assert.match(relative.stdout, ran, relative.stdout + relative.stderr);
    assert.match(plan(script).stdout, ran);
    // Through a symlinked directory: the path as typed is not the path node resolves.
    const linkedDir = join(tmpdir(), `mutation-slice-link-${process.pid}-${Date.now()}`);
    symlinkSync(p.dir, linkedDir, 'dir');
    links.push(linkedDir);
    const viaDir = plan(join(linkedDir, 'scripts', 'mutation-slice.mjs'));
    assert.match(viaDir.stdout, ran, `through a symlinked directory: ${JSON.stringify(viaDir.stdout)} ${viaDir.stderr}`);
    assert.equal(viaDir.status, 0);
    // With --preserve-symlinks-main node keeps the symlink in import.meta.url too: both sides are made real.
    const preserved = spawnSync(process.execPath, ['--preserve-symlinks-main', join(linkedDir, 'scripts', 'mutation-slice.mjs'), '--plan'], { cwd: p.dir, encoding: 'utf8', env: { PATH: process.env.PATH, MUTATION_SLICE: '' } });
    assert.match(preserved.stdout, ran, `with --preserve-symlinks-main: ${JSON.stringify(preserved.stdout)} ${preserved.stderr}`);
    // Through a symlink to the file itself.
    const linkedFile = join(p.dir, 'linked.mjs');
    symlinkSync(script, linkedFile);
    const viaFile = plan(linkedFile);
    assert.match(viaFile.stdout, ran, `through a symlinked file: ${JSON.stringify(viaFile.stdout)} ${viaFile.stderr}`);
    // A command that does not run the script as the program (an import) runs nothing.
    const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(script)}); console.log('imported');`], { cwd: p.dir, encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(imported.stdout, 'imported\n', imported.stdout + imported.stderr);
    assert.equal(imported.status, 0);
  } finally {
    for (const link of links) rmSync(link, { force: true });
    p.done();
  }
});

test('an instrumenter that fails makes the night of a slice that holds a part of a ranged file red with exit 2 and its error in the log, and a slice that holds none is not asked', () => {
  const slices = [
    { slice: 0, seconds: 20, mutants: 1, detected: 1, valid: 1, score: 100, floor: 98, files: { 'src/big.js:1-3': { seconds: 10, mutants: 1, detected: 1, valid: 1 } } },
    { slice: 1, seconds: 10, mutants: 0, detected: 0, valid: 0, score: null, floor: 0, files: { 'src/big.js:4-5': { seconds: 10, mutants: 0, detected: 0, valid: 0 } } },
    { slice: 2, seconds: 5, mutants: 2, detected: 2, valid: 2, score: 100, floor: 98, files: { 'src/a.js': { seconds: 5, mutants: 2, detected: 2, valid: 2 } } },
  ];
  const p = project({ sources: { 'src/big.js': source([1, 1]), 'src/a.js': source() }, slices });
  try {
    writeFileSync(join(p.dir, 'node_modules', '@stryker-mutator', 'instrumenter', 'index.js'), "export function createInstrumenter() { return { async instrument() { throw new Error('instrumenter broke'); } }; }\n");
    const statuses = { 'src/big.js:1-3': repeat('Killed', 1), 'src/a.js': repeat('Killed', 2) };
    // The slices that hold a part: red, and not a pass that measured nothing, whatever Stryker would have said.
    for (const slice of [0, 1]) {
      const red = p.run({ statuses }, { slice });
      assert.equal(red.code, 2, red.out);
      assert.match(red.out, /instrumenter broke/);
      assert.equal(red.summary, null, 'Stryker was not run');
    }
    const check = p.spawn(['--check-ranges'], {});
    assert.equal(check.status, 2, check.stdout + check.stderr);
    assert.match(check.stderr, /instrumenter broke/);
    // A slice with none of the file never asks the instrumenter, so it cannot fail on it.
    const green = p.run({ statuses: { 'src/a.js': repeat('Killed', 2) } }, { slice: 2 });
    assert.equal(green.code, 0, green.out);
  } finally {
    p.done();
  }
});
