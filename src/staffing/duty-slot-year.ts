import type { Prisma } from '@prisma/client';

/**
 * The AvailabilityConstraints a timetable of `academicYearId` must honour:
 * every row no uppdrag holds, and the rows uppdrag OF THAT YEAR hold.
 *
 * An uppdrag is per läsår (it is negotiated with the post, every spring, for
 * the year), but the weekly UNAVAILABLE row its blocked time becomes has no
 * year — AvailabilityConstraints are the school's, and the generator reads
 * them by school. Without this filter, next year's APT recorded in May keeps
 * the teacher out of Tuesday afternoon in this year's re-generation, and last
 * year's rastvakt keeps blocking every year after it until somebody deletes
 * a duty they can no longer see in the year they are looking at.
 *
 * A filter on the read rather than a year column on the constraint: the
 * engine's contract stays as it is (a constraint is weekly), and the link
 * that decides the year is the one the database already guards.
 */
export function constraintsOfYear(academicYearId: string): Prisma.AvailabilityConstraintWhereInput {
  return {
    OR: [{ teacherDuty: { is: null } }, { teacherDuty: { is: { academicYearId } } }],
  };
}
