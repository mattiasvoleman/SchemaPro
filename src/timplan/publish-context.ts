import type { Prisma } from '@prisma/client';
import type { PublishBreak, PublishClosure } from '../calendar/publish-days';
import type { ClosedRange } from '../staffing/teaching-weeks';

/**
 * What publish skips a grundschema lesson by, besides its own recurrence and
 * window: the year's lov (SchoolBreaks) and the dated UNAVAILABLE closures of
 * a class or an årskurs (AvailabilityConstraints). Read here once for every
 * caller that walks the grundschema as publish would — P3's genomförd tid
 * (the master lessons ahead of the calendar) and the staffing reconciliation
 * (the lessons scheduled in a range) — so "the days publish would write" has
 * one definition of its inputs as well as of its walk
 * (src/common/timplan-delivered.ts masterWalk).
 *
 * Runs in the caller's transaction, under the caller's RLS. One statement.
 */
export async function readPublishClosures(
  tx: Prisma.TransactionClient,
  window: { yearStart: string; yearEnd: string },
): Promise<PublishClosure[]> {
  const closures = await tx.availabilityConstraint.findMany({
    where: {
      type: 'UNAVAILABLE',
      resourceType: { in: ['STUDENT_GROUP', 'GRADE_LEVEL'] },
      date: { not: null, gte: new Date(`${window.yearStart}T00:00:00.000Z`), lte: new Date(`${window.yearEnd}T00:00:00.000Z`) },
    },
    select: {
      resourceType: true,
      userId: true,
      roomId: true,
      studentGroupId: true,
      minGradeLevel: true,
      maxGradeLevel: true,
      date: true,
      startTime: true,
      endTime: true,
    },
  });
  return closures.map((row) => ({ ...row, resourceType: String(row.resourceType) }));
}

/** The year's lov as publish reads them, from the day ranges the load and timplan modules hold. */
export function publishBreaksOf(closures: readonly ClosedRange[]): PublishBreak[] {
  return closures.map((row) => ({
    startDate: new Date(`${row.startDate}T00:00:00.000Z`),
    endDate: new Date(`${row.endDate}T00:00:00.000Z`),
    minGradeLevel: row.minGradeLevel ?? null,
    maxGradeLevel: row.maxGradeLevel ?? null,
  }));
}
