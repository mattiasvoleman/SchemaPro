import type { AcademicYear, Prisma } from '@prisma/client';

/** The two dates every dated period in a year is measured against. */
export type YearBounds = Pick<AcademicYear, 'startDate' | 'endDate'>;

/**
 * The academic year's bounds, read so that the year cannot move until the
 * transaction that read them ends. For every writer of a dated period:
 * SchoolBreaksService, TeachingRequirementsService and the timplan import.
 *
 * WHY A LOCK. A period has to lie inside its year, and the rule is checked
 * from both ends: a period writer measures its dates against the bounds it
 * reads, and AcademicYearsService.update counts the periods outside the bounds
 * it is about to store. Neither sees the other's uncommitted write, and
 * `withRls` runs READ COMMITTED, where a plain read holds nothing still. So
 * without a lock here the two pass each other — a PATCH moving the year's end
 * to 1 June counts no lov outside it, a lov ending 10 June is measured against
 * the end that PATCH has not committed yet, and both commit. The lov then sits
 * outside its year, where it stops holding lessons out of the week it closes
 * and no write path can edit it back in. No CHECK can say this: the bounds
 * live in another table.
 *
 * The year PATCH reads this row FOR NO KEY UPDATE. A lock that conflicts with
 * it puts one of the two behind the other, whichever reads first:
 *
 *  - the year first: this read waits for the PATCH to commit and returns the
 *    bounds it stored, and the period is measured against those;
 *  - the period first: the PATCH's read waits for the period to commit, and
 *    its counts, each a statement with a snapshot of its own, then see it.
 *
 * WHY FOR SHARE. It is the weakest lock that conflicts with FOR NO KEY UPDATE.
 * It conflicts neither with itself, so periods saved into one year at once do
 * not queue behind each other, nor with the FOR KEY SHARE the period's own
 * insert takes on this row through its foreign key. Either UPDATE lock would
 * queue periods behind each other, and a timplan upload holding one would
 * stall every lov saved into the year for its whole run, for nothing the year
 * PATCH needs.
 *
 * UNDER RLS a locking read has to pass the table's UPDATE policy as well as
 * its SELECT policy, and on AcademicYears only SCHOOL_ADMIN has one
 * (academic_years_admin_all). Every caller sits behind a SCHOOL_ADMIN-only
 * route. For any other role this reads no row, which the callers take to mean
 * a year that is not theirs, and they skip the containment check without a
 * word; opening one of those routes to another role needs a read that role's
 * policies admit.
 *
 * `null` when no row came back. A raw `date` column comes back as the same
 * midnight-UTC Date the model API returns.
 */
export async function readYearBoundsForShare(
  tx: Prisma.TransactionClient,
  academicYearId: string,
): Promise<YearBounds | null> {
  const [year] = await tx.$queryRaw<YearBounds[]>`
    SELECT "startDate", "endDate"
    FROM "AcademicYears"
    WHERE "id" = ${academicYearId}::uuid
    FOR SHARE
  `;
  return year ?? null;
}
