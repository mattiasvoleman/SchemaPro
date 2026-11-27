/**
 * Adds the cases of the helgdagar (Skolans kalender) to the `breaks` block of
 * src/common/__fixtures__/year-rollover-cases.json from the gateway's
 * proposeBreak, which web/lib/year-rollover.ts replays: a lov that holds Good
 * Friday, Ascension Day or Whit Sunday follows Easter, and a single day that
 * is a fixed public holiday keeps its date (or has no proposal on a weekend).
 *
 *   npx ts-node --transpile-only scripts/generate-rollover-holidays-fixture.ts
 *
 * The rows that are already there stay as they are, byte for byte; a row of
 * these cases that is there is rewritten, so the script can be run again.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { proposeBreak, type DayBounds } from '../src/common/year-rollover';

const file = path.join(__dirname, '../src/common/__fixtures__/year-rollover-cases.json');
const fixture = JSON.parse(readFileSync(file, 'utf8')) as { source: DayBounds; breaks: Array<{ lov: DayBounds; target: DayBounds; expected: unknown }> };

const target: DayBounds = { startDate: '2027-08-16', endDate: '2028-06-09' };
const day = (date: string): DayBounds => ({ startDate: date, endDate: date });
const lovs: DayBounds[] = [
  // Good Friday 2027 (26 March) follows Easter to 14 April 2028.
  day('2027-03-26'),
  // Ascension Day 2027 (6 May) to 25 May 2028, and with its klämdag.
  day('2027-05-06'),
  { startDate: '2027-05-06', endDate: '2027-05-07' },
  // Whit Sunday 2027 is a Sunday: a lov that holds it only does so as part of a longer one.
  { startDate: '2027-05-14', endDate: '2027-05-18' },
  // The fixed days, inside the source läsår: 6 January 2027 is a Wednesday (2028's a Thursday), 25 December 2026 a Friday (2027's a
  // Saturday: no proposal), 1 May 2027 a Saturday (2028's a Monday) and 6 June 2027 a Sunday (2028's a Tuesday).
  day('2027-01-06'),
  day('2026-12-25'),
  day('2027-05-01'),
  day('2027-06-06'),
  // Julafton is the 24th (2026's Thursday, 2027's Friday), and midsommarafton the Friday of 19-25 June (25 June 2027, 23 June 2028).
  day('2026-12-24'),
  day('2027-06-25'),
  // A range is not a single day: the same dates as a week keep the ISO-week rule.
  { startDate: '2027-01-04', endDate: '2027-01-08' },
];
const ours = lovs.map((lov) => ({ lov, target, expected: proposeBreak(lov, fixture.source, target) }));
const key = (row: { lov: DayBounds; target: DayBounds }) => `${row.lov.startDate}|${row.lov.endDate}|${row.target.startDate}|${row.target.endDate}`;
const ourKeys = new Set(ours.map(key));
fixture.breaks = [...fixture.breaks.filter((row) => !ourKeys.has(key(row))), ...ours];

writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
console.log('ok');
