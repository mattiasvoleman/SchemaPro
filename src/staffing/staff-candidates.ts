import type { PrismaClient } from '@prisma/client';

/**
 * The school's ACTIVE staff, TEACHER and SCHOOL_ADMIN alike, in id order: who
 * can be given a timplanspost. A teaching rektor carries role SCHOOL_ADMIN and
 * is assigned rows like anybody else (staff-lock.ts argues the same).
 *
 * One reader for the picker (suggest-teachers) and the staffing proposal, so
 * "who could take this row" has one answer in both. RLS confines Users to the
 * caller's school. Ids only: nothing here reads a name.
 */
export async function readActiveStaffIds(tx: PrismaClient): Promise<string[]> {
  const staff = await tx.user.findMany({
    where: { role: { in: ['TEACHER', 'SCHOOL_ADMIN'] }, isActive: true },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  return staff.map((row) => row.id);
}
