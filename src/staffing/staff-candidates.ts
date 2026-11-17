import type { PrismaClient } from '@prisma/client';
import { teachesLike } from './teaching-staff';

/**
 * The school's active staff in a läsår, in id order, in the two senses the
 * staffing proposal and the per-row picker need apart:
 *
 *   staffIds      who can LEAD a timplanspost that year: TEACHER and
 *                 SCHOOL_ADMIN alike. A row whose lead is not in this list is
 *                 one whose teacher has left, and the proposal re-staffs it
 *                 (vacated), so an administrator who already leads a post
 *                 must stay in it.
 *   candidateIds  of them, who may be OFFERED a post: a TEACHER, and an
 *                 administrator who teaches (Users.teaches, `teachesLike`).
 *                 An administrator without the mark keeps what she leads and
 *                 is offered nothing new: a pick of who teaches takes the
 *                 mark (lib/teaching-staff.ts), and a rektor who has not been
 *                 marked is not on the list of people the school staffs
 *                 with. Production holds no marked person yet, so the step
 *                 from "every administrator" to "the marked ones" leaves
 *                 every post as it is, and only what is offered changes.
 *
 * A member of the substitute pool (20261012110000) WITHOUT a post that year
 * is a timvikarie: they cover lessons, they do not take a timplanspost, and
 * they are left out of both. A teacher with a post who also covers from the
 * pool is staff like any other. One statement still: a relation filter, no
 * second read.
 *
 * One reader for the picker (suggest-teachers) and the staffing proposal, so
 * "who could take this row" has one answer in both. RLS confines Users to the
 * caller's school. Ids only: nothing here reads a name. The mark is selected
 * on purpose: a row read without it is not a teaching administrator
 * (teaching-staff.ts), and staff-candidates.spec.ts holds the select.
 */
export interface ActiveStaff {
  staffIds: string[];
  candidateIds: string[];
}

export async function readActiveStaff(tx: PrismaClient, academicYearId: string): Promise<ActiveStaff> {
  const staff = await tx.user.findMany({
    where: {
      role: { in: ['TEACHER', 'SCHOOL_ADMIN'] },
      isActive: true,
      NOT: { substitutePoolMemberships: { some: {} }, employments: { none: { academicYearId } } },
    },
    select: { id: true, role: true, teaches: true },
    orderBy: { id: 'asc' },
  });
  return {
    staffIds: staff.map((row) => row.id),
    candidateIds: staff.filter(teachesLike).map((row) => row.id),
  };
}
