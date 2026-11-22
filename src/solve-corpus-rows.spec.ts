import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * Every limit the manual (5.2) and DEPLOYMENT.md section 35.2 print is a count over weeks of the measurement in
 * docs/solve-corpus-measurement.json (and, for the eight-core columns, ...-clock.json). The review of #395
 * recomputed them and found the rows where the label does not say which weeks were counted: a row that said "four"
 * and "eight" shared teachers over weeks of three and five at nine classes, a row that said "no shared teacher"
 * over weeks with three, a row that said "9 classes" over weeks of 6 and 9. This holds each row to its weeks:
 *
 *   - the cells (seconds, "N av M"), recomputed as the tables are made: the slowest week of the row that got a
 *     timetable, in work times 18 s a work, rounded up; "tiden tar slut" when none did;
 *   - what the label must say, taken from the weeks and not from the author: the range of shared teachers the
 *     weeks have, the classes they have.
 *
 * The 18 s is the one figure of the tables that is not data (DEPLOYMENT 35.2, "what one worker took when the machine
 * was quiet"); it is written here once, so that a re-measurement that changes it changes it in one place.
 */

interface Week {
  name: string;
  status: string;
  facts: { sharedTeachers: number };
  firstScheduleDeterministic: number | null;
  firstScheduleSeconds: number | null;
}

const ROOT = join(__dirname, '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const COUNT = JSON.parse(read('docs/solve-corpus-measurement.json')) as Week[];
const CLOCK = JSON.parse(read('docs/solve-corpus-measurement-clock.json')) as Week[];
const SECONDS_PER_WORK = 18;

const weeksOf = (pattern: RegExp, from: Week[] = COUNT): Week[] => from.filter((week) => pattern.test(week.name));
const solvedOf = (weeks: Week[]): Week[] => weeks.filter((week) => week.status === 'FIRST_SCHEDULE');

/** The slowest solved week of the row, in estimated seconds, rounded up; null when none solved. */
const within = (weeks: Week[]): number | null => {
  const solved = solvedOf(weeks);
  if (solved.length === 0) return null;
  return Math.ceil(Math.max(...solved.map((week) => week.firstScheduleDeterministic ?? 0)) * SECONDS_PER_WORK);
};

/** The words for a number of teachers, as the Swedish manual writes them. */
const WORD = ['inga', 'en', 'två', 'tre', 'fyra', 'fem', 'sex', 'sju', 'åtta'];
const range = (weeks: Week[], word: (n: number) => string): string => {
  const shared = weeks.map((week) => week.facts.sharedTeachers);
  const low = Math.min(...shared);
  const high = Math.max(...shared);
  return low === high ? word(low) : `${word(low)} till ${word(high)}`;
};

/** The weeks of each row of the first table, in the order of the table (the same in the manual and DEPLOYMENT). */
const ROWS: ReadonlyArray<{ weeks: Week[]; sharedSays?: 'range' }> = [
  { weeks: weeksOf(/^n(?:6|9|12|18|24)-g0-m0-s\d$/) },
  { weeks: weeksOf(/^n(?:6|9|12)-g3-m0-s\d$/) },
  { weeks: weeksOf(/^n(?:15|18)-g3-m0-s\d$/), sharedSays: 'range' },
  { weeks: weeksOf(/^n9-g(?:0|2|3|4)-m0-s\d$/) },
  { weeks: weeksOf(/^n9-g5-m0-s\d$/) },
  { weeks: weeksOf(/^n9-g(?:6|8|10)-m0-s\d$/) },
  { weeks: weeksOf(/^n12-g(?:0|2|3)-m0-s\d$/) },
  { weeks: weeksOf(/^n12-g4-m0-s\d$/) },
  { weeks: weeksOf(/^n12-g(?:5|6|8|10)-m0-s\d$/) },
  { weeks: weeksOf(/^n(?:9|12)-g3-m0-s\d$/) },
  { weeks: weeksOf(/^n(?:9|12)-g3-m1-s\d$/) },
  { weeks: weeksOf(/^n(?:9|12)-g3-m2-s\d$/) },
  { weeks: weeksOf(/^n(?:9|12)-g3-m4-s\d-p2$/), sharedSays: 'range' },
  { weeks: weeksOf(/^n(?:9|12)-g3-m8-s\d-p2$/), sharedSays: 'range' },
  { weeks: weeksOf(/^n12-g3-m0-s\d$/) },
  { weeks: weeksOf(/^n12-g3-m0-s\d-t3$/) },
  { weeks: weeksOf(/^n12-g3-m0-s\d-t5$/) },
  { weeks: weeksOf(/^n(?:6|9)-g10-m0-s\d-t5-h$/) },
  { weeks: weeksOf(/^n(?:6|9)-g10-m0-s\d-t5p6-h$/) },
  { weeks: weeksOf(/^n9-g10-m0-s\d-t5-q\d-h$/) },
  { weeks: weeksOf(/^n30-g10-/) },
];

// ---- the manual, 5.2 ----------------------------------------------------------------------------------------------

const manual = read('docs/manual/anvandarmanual.html');
const section = manual.slice(manual.indexOf('id="hur-lang-tid"'), manual.indexOf('<h3 id="s53">'));
const manualRows = [...section.matchAll(/<tr><td class="k">(.*?)<\/td><td>(.*?)<\/td><td>(.*?)<\/td><\/tr>/g)].map((match) => ({
  label: match[1] ?? '',
  second: match[2] ?? '',
  third: match[3] ?? '',
}));
// The manual's first table has sixteen of DEPLOYMENT's twenty-one rows: it leaves out the two rows with one
// subject in groups more than the next row's limit has room for (9 classes with five, 12 with four: the eight-core
// table carries them) and folds the production form's three variants into the one row.
const MANUAL_ROWS = [0, 1, 2, 3, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17].map((index) => ROWS[index]!);

describe('the manual, 5.2: the first table', () => {
  it('has the rows it is held to', () => {
    expect(manualRows.length).toBe(MANUAL_ROWS.length + 9);
  });

  MANUAL_ROWS.forEach((row, index) => {
    it(`row ${index + 1}: ${(manualRows[index]?.label ?? '').replace(/<[^>]+>/g, '').slice(0, 60)}`, () => {
      const shown = manualRows[index];
      expect(shown).toBeDefined();
      const seconds = within(row.weeks);
      expect(shown!.second).toBe(seconds === null ? 'tiden tar slut' : `${seconds} s`);
      expect(shown!.third).toBe(`${solvedOf(row.weeks).length} av ${row.weeks.length}`);
      if (row.sharedSays === 'range') {
        expect(shown!.label).toContain(`${range(row.weeks, (n) => WORD[n] ?? String(n))}</em> delade lärare`);
      }
    });
  });

  it('says 6 or 9 classes of the production form it counts over 6 and 9', () => {
    expect(manualRows[15]!.label).toContain('6 eller 9 klasser');
  });
});

describe('the manual, 5.2: the eight-core table', () => {
  const second = manualRows.slice(MANUAL_ROWS.length);
  const TABLE: ReadonlyArray<{ clock: RegExp; count: RegExp }> = [
    { clock: /^n15-g3-m0-s\d$/, count: /^n15-g3-m0-s\d$/ },
    { clock: /^n18-g3-m0-s1$/, count: /^n18-g3-m0-s\d$/ },
    { clock: /^n9-g5-m0-s\d$/, count: /^n9-g5-m0-s\d$/ },
    { clock: /^n9-g6-m0-s\d$/, count: /^n9-g6-m0-s\d$/ },
    { clock: /^n12-g4-m0-s\d$/, count: /^n12-g4-m0-s\d$/ },
    { clock: /^n12-g5-m0-s1$/, count: /^n12-g5-m0-s\d$/ },
    { clock: /^n12-g3-m0-s\d-t3$/, count: /^n12-g3-m0-s\d-t3$/ },
    { clock: /^n12-g3-m2-s\d$/, count: /^n12-g3-m2-s\d$/ },
    { clock: /^(?:n9-g10-m0-s1-t5-h|n9-g10-m0-s1-t5-q1-h|n30-g10-m0-s1-t5-y0\.0\.0\.3\.10\.10-h)$/, count: /^(?:n9-g10-m0-s1-t5-h|n9-g10-m0-s1-t5-q1-h|n30-g10-m0-s1-t5-y0\.0\.0\.3\.10\.10-h)$/ },
  ];

  TABLE.forEach(({ clock, count }, index) => {
    it(`row ${index + 1}: ${(second[index]?.label ?? '').slice(0, 60)}`, () => {
      const shown = second[index];
      expect(shown).toBeDefined();
      const counted = weeksOf(count);
      const solved = solvedOf(counted).length;
      expect(shown!.second).toBe(solved === 0 ? 'tiden tar slut' : `${solved} av ${counted.length}`);
      const cell = weeksOf(clock, CLOCK)
        .map((week) => (week.status === 'FIRST_SCHEDULE' ? `${Math.round(week.firstScheduleSeconds ?? 0)} s` : 'tiden tar slut'))
        .join(' och ');
      // "41 s (en vecka)": the row that has one clock week out of the two says so.
      expect(shown!.third.startsWith(cell)).toBe(true);
    });
  });
});

// ---- DEPLOYMENT.md, 35.2 ------------------------------------------------------------------------------------------

const deployment = read('docs/DEPLOYMENT.md');
const from = deployment.indexOf('| A school with … | gets a timetable within | in |');
const table = deployment
  .slice(from, deployment.indexOf('\n\n', from))
  .split('\n')
  .slice(2)
  .map((line) => line.split('|').map((cell) => cell.trim()).slice(1, 4));

describe('DEPLOYMENT.md 35.2: the table', () => {
  it('has a row for each of the weeks it counts', () => {
    expect(table.length).toBe(ROWS.length);
    // Four weeks are in no row: the språkval in a block and the half groups, two seeds each (the block is the only
    // measurement of a block, and the manual's advice about blocks says so).
    const counted = new Set(ROWS.flatMap((row) => row.weeks.map((week) => week.name)));
    const left = COUNT.map((week) => week.name).filter((name) => !counted.has(name));
    expect([...left].sort()).toEqual(['n12-g3-m0-s1-b', 'n12-g3-m0-s2-b', 'n12-g6-m0-s1-h', 'n12-g6-m0-s2-h']);
  });

  ROWS.forEach((row, index) => {
    it(`row ${index + 1}: ${(table[index]?.[0] ?? '').replace(/\*/g, '').slice(0, 60)}`, () => {
      const [label, second, third] = table[index] ?? ['', '', ''];
      const seconds = within(row.weeks);
      expect(second).toBe(seconds === null ? 'none (timeout)' : `${seconds} s`);
      expect(third).toBe(`${solvedOf(row.weeks).length} of ${row.weeks.length} week${row.weeks.length === 1 ? '' : 's'}`);
      if (row.sharedSays === 'range') {
        expect(label).toContain(`**${range(row.weeks, String)} shared teachers**`.replace(' till ', ' to '));
      }
    });
  });
});
