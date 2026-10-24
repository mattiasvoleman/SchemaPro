import fixture from './__fixtures__/teacher-load-cases.json';
import { isMixed } from '../common/lesson-lengths';
import {
  buildTeacherLoadReport,
  countedMinutesByTeacher,
  yearTargetMinutesPerWeek,
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

  it('reaches delade lektioner: a shared row with a medlärare, a split one, an unstaffed lead and a deleted teacher’s share', () => {
    const rows = cases.flatMap((c) => c.input.requirements);
    const shared = rows.filter((r) => (r.shares ?? []).length > 0);
    expect(shared.some((r) => r.coTeacherId !== null && r.teacherLoadPercent !== 100)).toBe(true);
    expect(shared.some((r) => isMixed(r))).toBe(true);
    expect(shared.some((r) => r.teacherId === null)).toBe(true);
    expect(shared.some((r) => (r.shares ?? []).some((share) => share.teacherId === null))).toBe(true);
    const assignments = cases.flatMap((c) => c.report.teachers.flatMap((t) => t.assignments));
    expect(assignments.some((a) => a.ownLessonsPerWeek !== undefined && a.ownLessonsPerWeek < a.rowLessonsPerWeek!)).toBe(true);
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

  it('reaches every dated-uppdrag branch (20261017090000): Från only, Till only, both, counted and not, and an uppdrag’s peak above its standardvecka', () => {
    const duties = cases.flatMap((c) => c.input.duties);
    expect(duties.some((d) => d.validFrom && !d.validTo)).toBe(true);
    expect(duties.some((d) => !d.validFrom && d.validTo)).toBe(true);
    expect(duties.some((d) => d.validFrom && d.validTo)).toBe(true);
    expect(duties.some((d) => (d.validFrom || d.validTo) && d.countsAsTeaching)).toBe(true);
    expect(duties.some((d) => (d.validFrom || d.validTo) && !d.countsAsTeaching)).toBe(true);
    const teachers = cases.flatMap((c) => c.report.teachers);
    expect(teachers.some((t) => t.dutyPeakMinutesPerWeek > t.dutyMinutesPerWeek)).toBe(true);
    // Undated only: the peak IS the standardvecka, as every Fas 2 case shows.
    for (const c of cases) {
      if (c.input.duties.some((d) => d.validFrom || d.validTo)) continue;
      for (const t of c.report.teachers) {
        expect(t.dutyPeakMinutesPerWeek).toBe(t.dutyMinutesPerWeek);
        expect(t.countedDutyPeakMinutesPerWeek).toBe(t.countedDutyMinutesPerWeek);
      }
    }
  });

  it('reaches every branch of the counted uppdrag’s toppvecka: above its standardvecka, below the uppdrag’s own peak, and never above it', () => {
    const teachers = cases.flatMap((c) => c.report.teachers);
    expect(teachers.some((t) => t.countedDutyPeakMinutesPerWeek > t.countedDutyMinutesPerWeek)).toBe(true);
    expect(
      teachers.some((t) => t.countedDutyPeakMinutesPerWeek > 0 && t.countedDutyPeakMinutesPerWeek < t.dutyPeakMinutesPerWeek),
    ).toBe(true);
    // Counted and uncounted uppdrag in different terms: the uncounted ones'
    // own weeks hold something although the all-uppdrag peak is the counted one.
    expect(
      cases.some((c) =>
        c.report.teachers.some(
          (t) =>
            t.countedDutyPeakMinutesPerWeek === t.dutyPeakMinutesPerWeek &&
            c.input.duties.some((d) => d.userId === t.userId && !d.countsAsTeaching && (d.validFrom || d.validTo)),
        ),
      ),
    ).toBe(true);
    for (const t of teachers) expect(t.countedDutyPeakMinutesPerWeek).toBeLessThanOrEqual(t.dutyPeakMinutesPerWeek);
  });

  it('reaches every branch of a post that changes during the year (20261022120000): a period from a Sunday and from mid-week, one ending before the year, one with no Monday, a status set by the worst stretch, and a year without a target', () => {
    const employments = cases.flatMap((c) => c.input.employments);
    const periods = employments.flatMap((e) => e.periods ?? []);
    expect(periods.some((p) => p.validTo === null)).toBe(true);
    expect(periods.some((p) => p.validTo !== null)).toBe(true);
    expect(periods.some((p) => p.teachingTargetMinutesPerWeek !== null)).toBe(true);
    expect(periods.some((p) => p.reductionPercent > 0)).toBe(true);
    const teachers = cases.flatMap((c) => c.report.teachers);
    const stretches = teachers.flatMap((t) => t.periods);
    expect(stretches.some((p) => p.effectiveFrom === null)).toBe(true);
    expect(stretches.some((p) => p.effectiveFrom !== null && p.effectiveFrom > p.from)).toBe(true);
    expect(stretches.filter((p) => p.kind === 'BASE').length).toBeGreaterThan(0);
    // The worst stretch sets the status, against a year whose saldo is positive.
    expect(teachers.some((t) => t.status === 'OVER' && (t.balanceMinutesPerWeek ?? 0) > 0)).toBe(true);
    expect(teachers.some((t) => t.periods.length > 0 && t.targetMinutesPerWeek === null)).toBe(true);
    expect(teachers.some((t) => t.periods.length > 0 && t.annual.semesterHoursPerWeek !== null)).toBe(true);
    // A post without periods reads as it always did: no stretch, the base row's target.
    for (const c of cases) {
      for (const t of c.report.teachers) {
        const employment = c.input.employments.find((e) => e.userId === t.userId);
        if ((employment?.periods ?? []).length === 0) expect(t.periods).toEqual([]);
      }
    }
  });

  it("states each post's year target as the report does (yearTargetMinutesPerWeek, which a reader without HR-läs is given)", () => {
    let changing = 0;
    for (const c of cases) {
      const report = buildTeacherLoadReport(c.input);
      for (const t of report.teachers) {
        const employment = c.input.employments.find((e) => e.userId === t.userId);
        if (!employment) continue;
        if ((employment.periods ?? []).length > 0) changing += 1;
        expect({ case: c.name, userId: t.userId, target: yearTargetMinutesPerWeek(c.input, employment) }).toEqual({
          case: c.name,
          userId: t.userId,
          target: t.targetMinutesPerWeek,
        });
      }
    }
    expect(changing).toBeGreaterThan(0);
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
