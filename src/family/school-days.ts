import type { PrismaClient } from '@prisma/client';
import { breakCoversGroup, isoWeekday, iterateDates, parseUtcDate, toDateString } from '../calendar/publish-days';

/*
 * A pupil's skoldagar in a period: the days a leave request takes from
 * school. Mentorns ledighetsbeslut counts them twice over, and both counts
 * must agree:
 *
 *   * in SQL, app.leave_school_days (20261023091000), which says whether a
 *     request is short enough for the mentor (the limit in skoldagar is the
 *     school's delegation) and so who may read and decide it under RLS;
 *   * here, for the absence an approval writes: one full-day AbsenceReport
 *     per skoldag, never on a weekend or a lov (decideLeaveRequest).
 *
 * A day counts when it is a weekday, lies in one of the school's läsår (or
 * after the last one recorded, whose year is not set up yet), and no
 * SchoolBreak of the school covers the pupil on it. Whether a break covers
 * the pupil is the calendar's own rule, breakCoversGroup, asked with the
 * årskurs of the pupil's class that day (StudentEnrollments): a lov covers
 * everybody, prao för åk 9 the pupils of åk 9, and a pupil whose class has
 * no årskurs only the lov.
 *
 * school-days.cases.json is the table both are held to: jest runs it here
 * (school-days.spec.ts) and the adapter probe runs it against the SQL in CI
 * (scripts/test/probe-leave.ts).
 *
 * Dates are yyyy-mm-dd strings in the pure half and midnight-UTC Dates in
 * the Prisma half, as every @db.Date column here is read.
 */

export interface SchoolDayYear {
  startDate: string;
  endDate: string;
}

export interface SchoolDayBreak {
  startDate: string;
  endDate: string;
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
}

/** A StudentEnrollments segment: validFrom inclusive, validTo exclusive (null is open). */
export interface SchoolDayEnrollment {
  validFrom: string;
  validTo: string | null;
  gradeLevel: number | null;
}

export interface SchoolDayBasis {
  years: readonly SchoolDayYear[];
  breaks: readonly SchoolDayBreak[];
  enrollments: readonly SchoolDayEnrollment[];
}

/** The årskurs of the pupil's class on `day`; the latest segment when two years overlap. */
export function gradeOn(enrollments: readonly SchoolDayEnrollment[], day: string): number | null {
  let found: SchoolDayEnrollment | null = null;
  for (const segment of enrollments) {
    if (segment.validFrom > day) continue;
    if (segment.validTo !== null && day >= segment.validTo) continue;
    if (found === null || segment.validFrom > found.validFrom) found = segment;
  }
  return found?.gradeLevel ?? null;
}

/** Whether `day` is a skoldag of the pupil. */
export function isSchoolDay(basis: SchoolDayBasis, day: string): boolean {
  if (isoWeekday(day) > 5) return false;
  const inYear = basis.years.some((year) => year.startDate <= day && day <= year.endDate);
  if (!inYear && basis.years.some((year) => year.endDate >= day)) return false;
  const grade = gradeOn(basis.enrollments, day);
  return !basis.breaks.some(
    (entry) => entry.startDate <= day && day <= entry.endDate && breakCoversGroup(entry, grade),
  );
}

/** The pupil's skoldagar in [from, to], both inclusive, in order. */
export function schoolDaysOf(basis: SchoolDayBasis, from: string, to: string): string[] {
  const days: string[] = [];
  for (const day of iterateDates(from, to)) if (isSchoolDay(basis, day)) days.push(day);
  return days;
}

/**
 * What schoolDaysOf needs about one pupil over [from, to], read in the
 * caller's transaction: the school's läsår (all of them: "after the last
 * one" asks for every year), the breaks over the period and the pupil's class
 * segments over it. An admin and the deciding mentor read all three under
 * their own RLS (members read years and breaks, staff the enrolments).
 */
export async function readSchoolDayBasis(
  tx: Pick<PrismaClient, 'academicYear' | 'schoolBreak' | 'studentEnrollment'>,
  schoolId: string,
  studentId: string,
  from: string,
  to: string,
): Promise<SchoolDayBasis> {
  const fromDate = parseUtcDate(from);
  const toDate = parseUtcDate(to);
  const [years, breaks, enrollments] = await Promise.all([
    tx.academicYear.findMany({ where: { schoolId }, select: { startDate: true, endDate: true } }),
    tx.schoolBreak.findMany({
      where: { schoolId, startDate: { lte: toDate }, endDate: { gte: fromDate } },
      select: { startDate: true, endDate: true, minGradeLevel: true, maxGradeLevel: true },
    }),
    tx.studentEnrollment.findMany({
      where: { schoolId, studentId, validFrom: { lte: toDate }, OR: [{ validTo: null }, { validTo: { gt: fromDate } }] },
      select: { validFrom: true, validTo: true, gradeLevel: true },
    }),
  ]);
  return {
    years: years.map((year) => ({ startDate: toDateString(year.startDate), endDate: toDateString(year.endDate) })),
    breaks: breaks.map((entry) => ({
      startDate: toDateString(entry.startDate),
      endDate: toDateString(entry.endDate),
      minGradeLevel: entry.minGradeLevel,
      maxGradeLevel: entry.maxGradeLevel,
    })),
    enrollments: enrollments.map((segment) => ({
      validFrom: toDateString(segment.validFrom),
      validTo: segment.validTo === null ? null : toDateString(segment.validTo),
      gradeLevel: segment.gradeLevel,
    })),
  };
}
