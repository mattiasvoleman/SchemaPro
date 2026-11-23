import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * The year's timplansposter with lessons nobody teaches — no lead, or a share
 * whose teacher was deleted (delade lektioner) — with the subject and group names
 * the school reads them by ("Matematik för 7B").
 *
 * One query for both askers: the generate pre-flight
 * (OptimizationProxyService.unstaffedRefusal, under the staffing policy's
 * unstaffedGeneration) and the publish gate PUB_UNSTAFFED
 * (src/publication). Two copies of "which rows are unstaffed" would be two
 * answers the day one of them learns about co-teachers.
 *
 * The predicate is exported on its own (`unstaffedRequirementsWhere`) for the
 * third asker, Vad kom in (src/intake), which only COUNTS the rows: a count
 * that left out the shares would say "nothing stops Generera" under Vägra
 * while the pre-flight refuses.
 */
export function unstaffedRequirementsWhere(academicYearId: string): Prisma.TeachingRequirementWhereInput {
  // Delade lektioner: a post with a lead but a share whose teacher was
  // deleted has lessons nobody teaches too, and the generator would place
  // them teacherless. One statement either way.
  return { academicYearId, OR: [{ teacherId: null }, { shares: { some: { teacherId: null } } }] };
}

export function readUnstaffedRequirements(
  tx: PrismaClient,
  academicYearId: string,
): Promise<Array<{ id: string; subject: { name: string }; studentGroup: { name: string } }>> {
  return tx.teachingRequirement.findMany({
    where: unstaffedRequirementsWhere(academicYearId),
    select: {
      id: true,
      subject: { select: { name: true } },
      studentGroup: { select: { name: true } },
    },
  });
}
