import fixture from './__fixtures__/teacher-load-cases.json';
import { buildTeacherLoadReport, type LoadInput, type TeacherLoadReport } from './teacher-load';

/**
 * One load report, implemented twice, checked against one list of cases.
 *
 * web/lib/teacher-load.ts mirrors this module so the browser can state a
 * figure before a round trip — the riktmärke a draft would derive to, the
 * "kvar" per candidate in the requirements dialog. If the two drift, the
 * Anställning card promises one target and the matrix shows another for the
 * same post. Neither suite can see the other, so both replay
 * src/staffing/__fixtures__/teacher-load-cases.json: the web in
 * teacher-load.contract.test.ts, importing the fixture across the package
 * boundary.
 *
 * The fixture was GENERATED from this implementation (the script is in the
 * commit message), so on this side the test pins the arithmetic against its
 * own past: a change to a rounding or a sort order shows up here as a diff to
 * read rather than as a web page quietly disagreeing with the API. Fix the
 * code and regenerate when the change is intended; never edit the JSON by
 * hand, because the web replays the same numbers.
 */

interface FixtureCase {
  name: string;
  input: LoadInput;
  report: TeacherLoadReport;
}

const { cases } = fixture as unknown as { cases: FixtureCase[] };

describe('the load report agrees with the shared fixture', () => {
  it('has cases to replay, covering every status and both list kinds', () => {
    expect(cases.length).toBeGreaterThan(10);
    const statuses = new Set(cases.flatMap((c) => c.report.teachers.map((t) => t.status)));
    expect([...statuses].sort()).toEqual(['NO_TARGET', 'OK', 'OVER', 'UNDER']);
    expect(cases.some((c) => c.report.unstaffedRequirements.length > 0)).toBe(true);
    expect(cases.some((c) => c.report.unqualifiedAssignments.length > 0)).toBe(true);
    expect(cases.some((c) => c.input.closures.length > 0)).toBe(true);
  });

  it.each(cases.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    expect(buildTeacherLoadReport(entry.input)).toEqual(entry.report);
  });
});
