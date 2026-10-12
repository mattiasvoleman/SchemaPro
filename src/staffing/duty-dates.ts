import type { Prisma, PrismaClient } from '@prisma/client';

/*
 * When an uppdrag runs: its Från and Till (TeacherDuties.validFrom, validTo,
 * migration 20261017090000), both inclusive, null meaning the läsår's own
 * bound. Every existing uppdrag is undated, and an undated uppdrag runs the
 * whole läsår, exactly as before the columns existed.
 *
 * ONE DEFINITION for the three readers that ask it of a date or a period:
 *
 *   * the vikarietavla (cover-context.ts): a duty's time keeps the teacher
 *     busy on a day only when the duty runs that day;
 *   * the mentor question the next Skoldagen phase asks — which teacher
 *     holds MENTORSKAP for this pupil's class on these dates — answered by
 *     mentorsOf below, so the leave decision and the report read the same
 *     rule;
 *   * the load report reads the same bounds as a TeachingPeriod
 *     (teaching-weeks.ts), where null is the year's bound for the same reason.
 *
 * Dates are yyyy-mm-dd strings in the pure half and midnight-UTC Dates in
 * the Prisma half, as every @db.Date column here is read.
 */

/** An uppdrag's own bounds as yyyy-mm-dd, null for the year's. */
export interface DutyDates {
  validFrom: string | null;
  validTo: string | null;
}

/** Whether the uppdrag runs on `day` (yyyy-mm-dd). Strings compare as dates. */
export function dutyRunsOn(duty: DutyDates, day: string): boolean {
  if (duty.validFrom !== null && day < duty.validFrom) return false;
  if (duty.validTo !== null && day > duty.validTo) return false;
  return true;
}

/** Whether the uppdrag runs on some day of [from, to], both inclusive. */
export function dutyRunsDuring(duty: DutyDates, from: string, to: string): boolean {
  if (duty.validFrom !== null && duty.validFrom > to) return false;
  if (duty.validTo !== null && duty.validTo < from) return false;
  return true;
}

/** A @db.Date back to yyyy-mm-dd; null stays null. */
export function dayOf(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

/**
 * The Prisma filter for uppdrag running on some day of [from, to]: its own
 * bounds overlap the period, and so do its läsår's — a null bound IS the
 * year's, so an undated uppdrag of another year must not answer for this one.
 */
export function dutiesRunningDuring(from: Date, to: Date): Prisma.TeacherDutyWhereInput {
  return {
    AND: [
      { OR: [{ validFrom: null }, { validFrom: { lte: to } }] },
      { OR: [{ validTo: null }, { validTo: { gte: from } }] },
      { academicYear: { is: { startDate: { lte: to }, endDate: { gte: from } } } },
    ],
  };
}

/** One mentorship of a class over a period. */
export interface Mentorship {
  dutyId: string;
  userId: string;
  validFrom: string | null;
  validTo: string | null;
}

/**
 * Who holds MENTORSKAP for `studentGroupId` on some day of [from, to] —
 * "who is 7B's mentor during this leave request". More than one when the
 * period spans a mentor change (Anna until the jullov, Bertil from January)
 * or the class has two mentors; none when nobody does. Ordered by Från, the
 * undated first, then by teacher, so a caller can read the first as "the
 * mentor on `from`" only after checking dutyRunsOn itself.
 *
 * Under RLS, as every staffing read: an admin is answered for the school, a
 * TEACHER only about themselves (teacher_duties_teacher_own_select), which is
 * the question a teacher deciding a leave request asks — "am I this pupil's
 * mentor on these dates". The (schoolId, studentGroupId, kind) index serves it.
 */
export async function mentorsOf(
  tx: Pick<PrismaClient, 'teacherDuty'>,
  studentGroupId: string,
  from: Date,
  to: Date,
): Promise<Mentorship[]> {
  const rows = await tx.teacherDuty.findMany({
    where: { studentGroupId, kind: 'MENTORSKAP', ...dutiesRunningDuring(from, to) },
    select: { id: true, userId: true, validFrom: true, validTo: true },
  });
  return rows
    .map((row) => ({
      dutyId: row.id,
      userId: row.userId,
      validFrom: dayOf(row.validFrom),
      validTo: dayOf(row.validTo),
    }))
    .sort(
      (a, b) =>
        (a.validFrom ?? '') < (b.validFrom ?? '') ? -1
        : (a.validFrom ?? '') > (b.validFrom ?? '') ? 1
        : a.userId < b.userId ? -1
        : a.userId > b.userId ? 1
        : a.dutyId < b.dutyId ? -1
        : 1,
    );
}
