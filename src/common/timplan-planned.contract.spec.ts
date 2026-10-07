import fixture from './__fixtures__/timplan-planned-cases.json';
import {
  computePlannedCoverage,
  type PlannedCoverage,
  type PlannedCoverageInput,
} from './timplan-planned';

/**
 * Planerat mot timplan, implemented twice, checked against one list of cases.
 *
 * web/lib/timplan-planned.ts mirrors this module so the Timplansposter matrix
 * can repaint "planerat / mål" while a requirement is edited. If the two
 * drift, a cell turns green in the browser while GET /timplan-coverage says
 * "under mål" for the same rows. Neither suite can see the other, so both
 * replay src/common/__fixtures__/timplan-planned-cases.json — the web importing
 * it across the package boundary, as it does the timplan-coverage fixture.
 *
 * The fixture was GENERATED from this implementation (the regeneration script
 * is in the commit message): on this side the test pins the arithmetic
 * against its own past. Fix the code and regenerate when a change is
 * intended; never edit the JSON by hand, because the web replays the numbers.
 */

interface FixtureCase {
  name: string;
  input: PlannedCoverageInput;
  coverage: PlannedCoverage;
}

const { cases } = fixture as unknown as { cases: FixtureCase[] };

describe('planerat mot timplan agrees with the shared fixture', () => {
  it('has cases reaching every verdict code, every class status and both kinds of read', () => {
    expect(cases.length).toBeGreaterThanOrEqual(9);
    const codes = new Set(cases.flatMap((c) => c.coverage.verdicts.map((v) => v.code)));
    expect([...codes].sort()).toEqual([
      'TIMPLAN_ATTACHED_DRAFT',
      'TIMPLAN_GROUP_OVERPLANNED',
      'TIMPLAN_GROUP_UNDERPLANNED',
      'TIMPLAN_GROUP_UNPLANNED',
      'TIMPLAN_PUPIL_DOUBLE_PLANNED',
      'TIMPLAN_PUPIL_UNDERPLANNED',
      'TIMPLAN_YEAR_GRADE_UNATTACHED',
    ]);
    const statuses = new Set(
      cases.flatMap((c) => c.coverage.groups.flatMap((g) => g.lines.map((l) => l.status))),
    );
    expect([...statuses].sort()).toEqual(['MET', 'NO_TARGET', 'OVER', 'PUPILS', 'UNDER', 'UNPLANNED']);
    expect(cases.some((c) => !c.coverage.pupilLevel)).toBe(true);
    expect(cases.some((c) => c.coverage.verdicts.length === 0 && c.coverage.groups.length > 0)).toBe(true);
  });

  it.each(cases.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    expect(computePlannedCoverage(entry.input)).toEqual(entry.coverage);
  });
});
