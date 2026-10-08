import fixture from './__fixtures__/timplan-scheduled-cases.json';
import { isMixed } from './lesson-lengths';
import {
  computeScheduledCoverage,
  type ScheduledCoverage,
  type ScheduledCoverageInput,
} from './timplan-scheduled';

/**
 * Schemalagt mot planerat, implemented twice, checked against one list of
 * cases.
 *
 * web/lib/timplan-scheduled.ts mirrors this module so the timetable's
 * Lektionstid panel recomputes "schemalagt / planerat" the moment a lesson is
 * resized, parked or deleted. If the two drift, the board says MATCH while
 * GET /timplan-coverage?layer=scheduled says short for the same rows. Neither
 * suite can see the other, so both replay
 * src/common/__fixtures__/timplan-scheduled-cases.json — the web importing it
 * across the package boundary, as it does the planned layer's fixture.
 *
 * The fixture was GENERATED from this implementation (the regeneration script
 * is in the commit message): on this side the test pins the arithmetic
 * against its own past. Fix the code and regenerate when a change is
 * intended; never edit the JSON by hand, because the web replays the numbers.
 */

interface FixtureCase {
  name: string;
  input: ScheduledCoverageInput;
  coverage: ScheduledCoverage;
}

const { cases } = fixture as unknown as { cases: FixtureCase[] };

describe('schemalagt mot planerat agrees with the shared fixture', () => {
  it('has cases reaching every verdict code, every line status and every kind of read', () => {
    const codes = new Set(cases.flatMap((c) => c.coverage.verdicts.map((v) => v.code)));
    expect([...codes].sort()).toEqual([
      'TIMPLAN_PUPIL_SCHEDULE_SHORT',
      'TIMPLAN_SCHEDULE_EXTRA',
      'TIMPLAN_SCHEDULE_NONE',
      'TIMPLAN_SCHEDULE_PARKED',
      'TIMPLAN_SCHEDULE_SHORT',
      'TIMPLAN_SCHEDULE_UNPLANNED',
      'TIMPLAN_SCHEDULE_UNSCHEDULED',
    ]);
    const statuses = new Set(cases.flatMap((c) => c.coverage.groups.flatMap((g) => g.lines.map((l) => l.status))));
    expect([...statuses].sort()).toEqual(['EXTRA', 'MATCH', 'SHORT', 'UNPLANNED', 'UNSCHEDULED']);
    // A teacher's read, the board's (no pupils in) and a drill-down.
    expect(cases.some((c) => !c.coverage.pupilLevel && c.input.pupils.length > 0)).toBe(true);
    expect(cases.some((c) => !c.input.includePupils && c.input.pupils.length === 0)).toBe(true);
    expect(cases.some((c) => c.input.drillGroupId)).toBe(true);
    expect(cases.some((c) => c.coverage.groups.length === 0)).toBe(true);
  });

  it('reaches what the panel must agree on: parity, windows, week 53, parking, extras, names, a split post', () => {
    const lessons = cases.flatMap((c) => c.input.lessons);
    const rows = cases.flatMap((c) => c.input.requirements);
    expect(lessons.some((l) => l.recurrence === 'ODD_WEEKS')).toBe(true);
    expect(rows.some((r) => r.recurrence === 'EVEN_WEEKS')).toBe(true);
    expect(lessons.some((l) => l.startDate && l.endDate && l.startDate < '2026-12-28' && l.endDate > '2027-01-04')).toBe(true);
    expect(lessons.some((l) => l.isParked)).toBe(true);
    expect(lessons.some((l) => l.extraGroupIds.length > 0)).toBe(true);
    expect(lessons.some((l) => l.studentIds.length > 0)).toBe(true);
    expect(lessons.some((l) => l.endTime === '08:55:00')).toBe(true);
    expect(rows.some((r) => isMixed(r))).toBe(true);
    expect(cases.some((c) => c.input.closures.some((x) => x.minGradeLevel !== null))).toBe(true);
  });

  it('gives the board, with no pupils, exactly the group lines the server gives with them', () => {
    const read = cases.find((c) => c.name.includes('read by a teacher'))!;
    const board = cases.find((c) => c.name.includes('on the board'))!;
    const strip = (c: FixtureCase) => c.coverage.groups.map((g) => ({ ...g, pupilCount: 0 }));
    expect(strip(board)).toEqual(strip(read));
  });

  it.each(cases.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    expect(computeScheduledCoverage(entry.input)).toEqual(entry.coverage);
  });
});
