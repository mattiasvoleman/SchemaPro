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
 *
 * THE LINK IS TeacherDutySlots (migration 20261017090000). Every time an
 * uppdrag holds has a link row there; the old one-time column it replaced is
 * retired (20261022090000) and held empty.
 *
 * AN UPPDRAG'S DATES ARE NOT. A time of an uppdrag that runs from January
 * still blocks the teacher in the year's weekly master for the whole year:
 * the master is one week, and the engine has no dated week to hold it in. A
 * dated teaching requirement over-provisions the same way. The vikarietavla,
 * which works on a date, reads the dates (cover-context.ts).
 */
export function constraintsOfYear(academicYearId: string): Prisma.AvailabilityConstraintWhereInput {
  return {
    OR: [
      { teacherDutySlot: { is: null } },
      { teacherDutySlot: { is: { teacherDuty: { is: { academicYearId } } } } },
    ],
  };
}
