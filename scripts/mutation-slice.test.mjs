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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  filesOf,
  filesToMutate,
  floorOf,
  placeNew,
  plan,
  remeasure,
  scoreOf,
  scoreOfCounts,
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
// of the config it was given, and 0 when the score is NaN (nothing valid to score).

const SCRIPT = fileURLToPath(new URL('./mutation-slice.mjs', import.meta.url));

const FAKE_STRYKER = `#!/usr/bin/env node
const fs = require('node:fs');
const config = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const spec = JSON.parse(process.env.FAKE_STRYKER);
if (spec.die) process.kill(process.pid, 'SIGKILL');
const files = {};
for (const file of config.mutate) files[file] = { mutants: (spec.statuses[file] ?? []).map((status) => ({ status })) };
if (!spec.noReport) fs.writeFileSync(config.jsonReporter.fileName, JSON.stringify({ files }));
let detected = 0;
let undetected = 0;
for (const { mutants } of Object.values(files)) for (const { status } of mutants) {
  if (status === 'Killed' || status === 'Timeout') detected++;
  else if (status === 'Survived' || status === 'NoCoverage') undetected++;
}
const score = detected + undetected === 0 ? NaN : (100 * detected) / (detected + undetected);
process.exit(score < config.thresholds.break ? 1 : 0);
`;

const repeat = (status, n) => Array.from({ length: n }, () => status);

/** A project of two source files and a dealing with slice 0 holding both; returns a function that runs the script in it. */
function project({ floor = 70, mutants = 20, withFiles = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mutation-slice-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
  if (withFiles) for (const name of ['a.js', 'b.js']) writeFileSync(join(dir, 'src', name), '// source\n');
  writeFileSync(join(dir, 'stryker.conf.json'), JSON.stringify({ mutate: ['src/*.js'], thresholds: { high: 95, low: 85, break: 85 }, reporters: ['clear-text'] }));
  const half = mutants / 2;
  const entry = { seconds: 10, mutants: half, detected: 0, valid: half };
  writeFileSync(
    join(dir, 'scripts', 'mutation-slices.json'),
    JSON.stringify({
      measured: '2026-11-02',
      slices: [
        { slice: 0, seconds: 20, mutants, detected: 0, valid: mutants, score: 0, floor, files: { 'src/a.js': entry, 'src/b.js': entry } },
        { slice: 1, seconds: 0, mutants: 0, detected: 0, valid: 0, score: null, floor: 0, files: {} },
      ],
    }),
  );
  writeFileSync(join(dir, 'node_modules', '.bin', 'stryker'), FAKE_STRYKER);
  chmodSync(join(dir, 'node_modules', '.bin', 'stryker'), 0o755);
  return {
    dir,
    run: (spec) => {
      const result = spawnSync(process.execPath, [SCRIPT], {
        cwd: dir,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, MUTATION_SLICE: '0', FAKE_STRYKER: JSON.stringify(spec) },
      });
      const summaryPath = join(dir, 'reports', 'mutation', 'slice-0', 'summary.md');
      return {
        code: result.status,
        out: result.stdout + result.stderr,
        summary: existsSync(summaryPath) ? readFileSync(summaryPath, 'utf8') : null,
        config: JSON.parse(readFileSync(join(dir, 'reports', 'mutation', 'slice-0', 'stryker.conf.json'), 'utf8')),
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
  const measured = { total: { valid: 20 } };
  assert.deepEqual(exitCodeFor({ status: 0, summary: measured, ran: 20, expected: 20 }), { code: 0, reason: null });
  assert.deepEqual(exitCodeFor({ status: 1, summary: measured, ran: 20, expected: 20 }), { code: 1, reason: null });
  assert.equal(exitCodeFor({ status: null, summary: measured, ran: 20, expected: 20 }).code, 1);
  assert.equal(exitCodeFor({ status: 0, summary: null, ran: 0, expected: 20 }).code, 1);
  assert.equal(exitCodeFor({ status: 0, summary: { total: { valid: 0 } }, ran: 20, expected: 20 }).code, 1);
  // 90 % of the expected mutants pass, 89 % do not.
  assert.equal(exitCodeFor({ status: 0, summary: measured, ran: 90, expected: 100 }).code, 0);
  assert.equal(exitCodeFor({ status: 0, summary: measured, ran: 89, expected: 100 }).code, 1);
  // Stryker's own failure code is kept.
  assert.equal(exitCodeFor({ status: 2, summary: null, ran: 0, expected: 20 }).code, 2);
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
