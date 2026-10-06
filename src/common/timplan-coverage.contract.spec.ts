import fixture from './__fixtures__/timplan-coverage-cases.json';
import {
  checkLocalTimplan,
  type CoverageEntry,
  type CoverageNationalSubject,
  type CoverageSubject,
  type CoverageVersion,
  type TimplanCheck,
} from './timplan-coverage';

/**
 * One verdict document, implemented twice, checked against one list of cases.
 *
 * web/lib/timplan-coverage.ts mirrors this module so the timplan grid can
 * repaint a stage sum and its colour while the admin is still typing, before
 * the PUT answers. If the two drift, the cell turns green in the browser and
 * the server's list says "under mål" for the same minutes. Neither suite can
 * see the other, so both replay src/common/__fixtures__/timplan-coverage-cases.json
 * — the web importing it across the package boundary, as it does the
 * teacher-load and teaching-hours fixtures.
 *
 * The fixture was GENERATED from this implementation (the script is in the
 * commit message), with the statute read out of P0's migration, so on this
 * side the test pins the arithmetic against its own past. Fix the code and
 * regenerate when a change is intended; never edit the JSON by hand, because
 * the web replays the same numbers.
 */

interface FixtureCase {
  name: string;
  versionCode: string;
  planningWeeksTenths: number;
  subjects: CoverageSubject[];
  entries: CoverageEntry[];
  check: TimplanCheck;
}

const { statute, cases } = fixture as unknown as {
  statute: { versions: CoverageVersion[]; nationalSubjects: CoverageNationalSubject[] };
  cases: FixtureCase[];
};

const versionByCode = new Map(statute.versions.map((v) => [v.code, v]));

describe('the timplan check agrees with the shared fixture', () => {
  it('has cases to replay, reaching every verdict code and both severities', () => {
    expect(cases.length).toBeGreaterThanOrEqual(12);
    const seen = new Set(cases.flatMap((c) => c.check.verdicts.map((v) => v.code)));
    expect([...seen].sort()).toEqual([
      'TIMPLAN_GROUP_MINIMUM_UNMET',
      'TIMPLAN_NATIONAL_DISTRIBUTION_UNPUBLISHED',
      'TIMPLAN_PROTECTED_SUBJECT_REDUCED',
      'TIMPLAN_REDUCTION_OVER_CAP',
      'TIMPLAN_SKOLANS_VAL_OVERSPENT',
      'TIMPLAN_STAGE_BELOW_NATIONAL',
      'TIMPLAN_SUBJECT_UNMAPPED',
      'TIMPLAN_TOTAL_BELOW_GUARANTEE',
    ]);
    expect(cases.some((c) => c.check.verdicts.length === 0)).toBe(true);
    expect(cases.some((c) => c.check.gradesOutsideStages.length > 0)).toBe(true);
    expect(new Set(cases.map((c) => c.versionCode)).size).toBe(statute.versions.length);
  });

  it.each(cases.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    expect(
      checkLocalTimplan({
        planningWeeksTenths: entry.planningWeeksTenths,
        version: versionByCode.get(entry.versionCode)!,
        nationalSubjects: statute.nationalSubjects,
        subjects: entry.subjects,
        entries: entry.entries,
      }),
    ).toEqual(entry.check);
  });
});
