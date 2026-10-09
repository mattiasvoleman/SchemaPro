import fixture from './__fixtures__/teacher-load-cases.json';
import { isMixed } from '../common/lesson-lengths';
import {
  buildTeacherLoadReport,
  countedMinutesByTeacher,
  type LoadInput,
  type TeacherLoadReport,
} from './teacher-load';

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

  it('reaches every Fas 2 branch: a percentage off 100, both kinds of uppdrag, both bottleneck verdicts and the uncomputed one', () => {
    const rows = cases.flatMap((c) => c.input.requirements);
    expect(rows.some((r) => r.teacherLoadPercent !== 100)).toBe(true);
    expect(rows.some((r) => r.coTeacherId !== null && r.coTeacherLoadPercent === 0)).toBe(true);
    const duties = cases.flatMap((c) => c.input.duties);
    expect(duties.some((d) => d.countsAsTeaching)).toBe(true);
    expect(duties.some((d) => !d.countsAsTeaching)).toBe(true);
    const bottlenecks = cases.flatMap((c) => c.report.subjectBottlenecks);
    expect(bottlenecks.some((b) => b.short)).toBe(true);
    expect(bottlenecks.some((b) => !b.short)).toBe(true);
    expect(bottlenecks.some((b) => b.qualifiedNoTargetCount > 0)).toBe(true);
    expect(
      cases.some((c) => !c.report.bottlenecksComputed && c.report.unstaffedRequirements.length > 0),
    ).toBe(true);
  });

  it('reaches a split row, every week, odd weeks, co-taught and unstaffed', () => {
    const split = cases.flatMap((c) => c.input.requirements).filter((r) => isMixed(r));
    expect(split.some((r) => r.recurrence === 'ALL_WEEKS' && r.teacherId !== null)).toBe(true);
    expect(split.some((r) => r.recurrence !== 'ALL_WEEKS')).toBe(true);
    expect(split.some((r) => r.coTeacherId !== null && r.coTeacherLoadPercent !== 100)).toBe(true);
    expect(split.some((r) => r.teacherId === null)).toBe(true);
  });

  it('reaches every Fas 3 branch: a weight off 1 under FACTOR, both roles in the assignments, FERIE, SEMESTER and no post', () => {
    expect(cases.some((c) => c.report.loadModel === 'FACTOR')).toBe(true);
    const weights = cases.flatMap((c) => c.input.requirements.map((r) => r.loadWeight ?? 1));
    expect(weights.some((w) => w < 1)).toBe(true);
    expect(weights.some((w) => w > 1)).toBe(true);
    const teachers = cases.flatMap((c) => c.report.teachers);
    const roles = new Set(teachers.flatMap((t) => t.assignments.map((a) => a.role)));
    expect([...roles].sort()).toEqual(['CO_TEACHER', 'TEACHER']);
    expect(teachers.some((t) => t.assignments.some((a) => a.minutesPerWeek !== a.timeMinutesPerWeek))).toBe(true);
    const kinds = new Set(teachers.map((t) => t.annual.contractKind));
    expect(kinds).toEqual(new Set(['FERIE', 'SEMESTER', null]));
    expect(teachers.some((t) => t.annual.semesterHoursPerWeek !== null)).toBe(true);
    expect(teachers.some((t) => t.annual.unregulatedHoursPerYear !== null && t.annual.unregulatedHoursPerYear > 0)).toBe(true);
    expect(teachers.some((t) => t.annual.percentOfRegulated === null && t.annual.regulatedHoursPerYear === 0)).toBe(true);
  });

  it.each(cases.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    expect(buildTeacherLoadReport(entry.input)).toEqual(entry.report);
  });

  it.each(cases.map((entry) => [entry.name, entry] as const))(
    'countedMinutesByTeacher is the report’s counted minutes, unrounded: %s',
    (_name, entry) => {
      const counted = countedMinutesByTeacher(entry.input);
      for (const teacher of entry.report.teachers) {
        expect(Math.round(counted.get(teacher.userId) ?? 0)).toBe(teacher.countedMinutesPerWeek);
      }
    },
  );
});
