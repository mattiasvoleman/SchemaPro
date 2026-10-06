import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Prisma, UserRole } from '@prisma/client';

/**
 * Whose post, behörighet or uppdrag may exist at all: a TEACHER's or a
 * SCHOOL_ADMIN's.
 *
 * STAFF, not TEACHER, for the reason TeacherWorkRulesService gives: a teaching
 * rektor carries role SCHOOL_ADMIN here, and TeachingRequirements.teacherId will
 * name them, so a post for them is a real post. A pupil's or a guardian's is
 * meaningless — they teach nothing, so there is nothing for a percentage to be
 * a share of — and the database cannot say so: `role` lives on Users, and a
 * CHECK cannot read another table.
 *
 * READ UNDER THE LOCK THE USER PATCH TAKES, FOR NO KEY UPDATE, in the
 * transaction that writes. `withRls` runs READ COMMITTED, where a plain read
 * holds nothing still: a PATCH demoting the person to STUDENT and a PUT writing
 * their post would each pass against the row the other has not changed yet, and
 * together store a pupil with a tjänstgöringsgrad. UsersService.update reads the
 * same row FOR NO KEY UPDATE before it writes the role, so whichever of the two
 * reads second waits for the first to commit and is judged against what it
 * wrote. FOR NO KEY UPDATE rather than FOR UPDATE because the post's own insert
 * takes FOR KEY SHARE on this row through its foreign key, and FOR UPDATE would
 * queue behind every such insert school-wide — see the Isolation section of
 * PrismaService.
 *
 * Under RLS a locking read has to pass the table's UPDATE policy as well as
 * SELECT, and on Users only users_admin_all does. Every caller sits behind a
 * SCHOOL_ADMIN-only route, so a user in another school reads as missing and
 * gets the same 404 a nonexistent id gets — and the composite (userId,
 * schoolId) foreign key is what makes that a guarantee rather than this read.
 */
/** The sentence's subject, with the article Swedish gives each noun. */
const WHAT: Record<'tjänst' | 'behörighet' | 'uppdrag', string> = {
  tjänst: 'En tjänst',
  behörighet: 'En behörighet',
  uppdrag: 'Ett uppdrag',
};

export async function lockStaffRow(
  tx: Prisma.TransactionClient,
  userId: string,
  what: 'tjänst' | 'behörighet' | 'uppdrag',
): Promise<void> {
  const [row] = await tx.$queryRaw<{ role: UserRole }[]>`
    SELECT "role"
    FROM "Users"
    WHERE "id" = ${userId}::uuid
    FOR NO KEY UPDATE
  `;
  if (!row) {
    throw new NotFoundException(`Teacher ${userId} not found.`);
  }
  if (row.role !== 'TEACHER' && row.role !== 'SCHOOL_ADMIN') {
    throw new BadRequestException(
      `${WHAT[what]} hör till en lärare. Elever och vårdnadshavare undervisar inte.`,
    );
  }
}
