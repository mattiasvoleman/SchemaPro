import type { PrismaClient } from '@prisma/client';

/**
 * Släppt för motorn: what a person's own choice of teacher does to a release.
 *
 * Föreslå bemanning never moves a teacher the school chose, and a release is the school saying that it may. When somebody then
 * chooses a teacher for the post by hand (a PATCH of the post, a row of the requirements import), that is the school choosing again:
 * the release is taken back, in the same transaction as the change, and one ScheduleChangeLogs row says which posts and why, the way
 * taking a release back on the card does (engine-release.service.ts). Without it a release outlives the choice it was made before, and
 * the next proposal may move the teacher the school has just picked.
 *
 * NOT FOR THE STAFFING APPLY. A teacher given by an applied proposal is the engine's answer approved by the school, and the release
 * stays (DEPLOYMENT §31.3): the apply writes its own teachers and never calls this. Nor for a rollover or a term split, whose new
 * posts have no release to begin with (TeachingRequirementRelease is SKIPPED in the rollover registry, and a split post's release
 * goes with the post it is made from).
 *
 * `requirementIds` are posts whose lead has just been changed in `tx`. Reads before it deletes, so only the posts that were released
 * are logged, and a change of a post nobody released costs one read and writes nothing. The caller is an administrator who writes
 * PLANERING (a post is written under the same area), so the table's delete arm admits it, and SCHEMALAGGNING too, which the insert policy
 * of ScheduleChangeLogs asks for the log row: every profile that writes the one writes the other today (PROFILE_WRITES, pinned in
 * engine-release-handover.spec.ts), and a profile that did not would be told AREA_NOT_YOURS when it chose a teacher for a released post.
 *
 * Returns the posts whose release was taken back, in id order.
 */
export async function takeBackReleasesAfterHandChange(
  tx: PrismaClient,
  input: { schoolId: string; academicYearId: string; actorId: string | null; requirementIds: readonly string[] },
): Promise<string[]> {
  const ids = [...new Set(input.requirementIds)].sort();
  if (ids.length === 0) return [];
  const released = (
    await tx.teachingRequirementRelease.findMany({ where: { requirementId: { in: ids } }, select: { requirementId: true } })
  )
    .map((row) => row.requirementId)
    .sort();
  if (released.length === 0) return [];
  await tx.teachingRequirementRelease.deleteMany({ where: { requirementId: { in: released } } });
  await tx.scheduleChangeLog.create({
    data: {
      schoolId: input.schoolId,
      academicYearId: input.academicYearId,
      masterLessonId: null,
      actorId: input.actorId,
      action: 'UPDATE',
      before: { kind: 'ENGINE_RELEASE', released: true, requirementIds: released },
      after: { kind: 'ENGINE_RELEASE', released: false, requirementIds: released, because: 'TEACHER_CHANGED_BY_HAND' },
    },
    select: { id: true },
  });
  return released;
}
