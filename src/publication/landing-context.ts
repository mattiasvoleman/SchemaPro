import type { PrismaClient } from '@prisma/client';
import { breakDaysOf, closuresByDateOf, parseUtcDate, type PublishDaysContext } from '../calendar/publish-days';

/*
 * Which days the school has over a span: what a publication (draft-publish.ts) and a reversal (cancellation-core.ts) both ask of
 * a day before they put a lesson on it. Its own module, with nothing of the publication in its imports, so that the cancellation
 * code can read it without a cycle through the draft publish and the template propagation.
 */

/** The lov, closures and years over [from, to]: what materialise reads, for the landing rules. */
export async function landingContextOf(
  tx: PrismaClient,
  academicYearId: string,
  from: string,
  to: string,
  timezone: string,
): Promise<PublishDaysContext> {
  const closures = await tx.availabilityConstraint.findMany({
    where: { type: 'UNAVAILABLE', date: { not: null, gte: parseUtcDate(from), lte: parseUtcDate(to) } },
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
  const breaks = await tx.schoolBreak.findMany({
    where: { academicYearId, startDate: { lte: parseUtcDate(to) }, endDate: { gte: parseUtcDate(from) } },
    select: { startDate: true, endDate: true, minGradeLevel: true, maxGradeLevel: true },
  });
  const groups = await tx.studentGroup.findMany({
    where: { academicYearId },
    select: { id: true, gradeLevel: true },
  });
  return {
    breakDays: breakDaysOf(breaks, from, to),
    closuresByDate: closuresByDateOf(closures),
    gradeOfGroup: new Map(groups.map((group) => [group.id, group.gradeLevel])),
    timezone,
  };
}
