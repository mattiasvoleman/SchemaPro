import type { PrismaClient } from '@prisma/client';

/**
 * The school's ACTIVE staff, TEACHER and SCHOOL_ADMIN alike, in id order: who
 * can be given a timplanspost in the läsår asked about. A teaching rektor
 * carries role SCHOOL_ADMIN and is assigned rows like anybody else
 * (staff-lock.ts argues the same).
 *
 * A member of the substitute pool (20261012110000) WITHOUT a post that year
 * is a timvikarie: they cover lessons, they do not take a timplanspost, and
 * they are left out. A teacher with a post who also covers from the pool is
 * staff like any other. One statement still: a relation filter, no second
 * read.
 *
 * One reader for the picker (suggest-teachers) and the staffing proposal, so
 * "who could take this row" has one answer in both. RLS confines Users to the
 * caller's school. Ids only: nothing here reads a name.
 */
export async function readActiveStaffIds(tx: PrismaClient, academicYearId: string): Promise<string[]> {
  const staff = await tx.user.findMany({
    where: {
      role: { in: ['TEACHER', 'SCHOOL_ADMIN'] },
      isActive: true,
      NOT: { substitutePoolMemberships: { some: {} }, employments: { none: { academicYearId } } },
    },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  return staff.map((row) => row.id);
}
