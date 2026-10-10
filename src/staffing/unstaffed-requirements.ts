import type { PrismaClient } from '@prisma/client';

/**
 * The year's timplansposter with no teacher, with the subject and group names
 * the school reads them by ("Matematik för 7B").
 *
 * One query for both askers: the generate pre-flight
 * (OptimizationProxyService.unstaffedRefusal, under the staffing policy's
 * unstaffedGeneration) and the publish gate PUB_UNSTAFFED
 * (src/publication). Two copies of "which rows are unstaffed" would be two
 * answers the day one of them learns about co-teachers.
 */
export function readUnstaffedRequirements(
  tx: PrismaClient,
  academicYearId: string,
): Promise<Array<{ id: string; subject: { name: string }; studentGroup: { name: string } }>> {
  return tx.teachingRequirement.findMany({
    where: { academicYearId, teacherId: null },
    select: {
      id: true,
      subject: { select: { name: true } },
      studentGroup: { select: { name: true } },
    },
  });
}
