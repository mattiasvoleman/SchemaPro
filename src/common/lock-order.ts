import { Prisma, type PrismaClient } from '@prisma/client';

/*
 * ONE ORDER FOR A SCHOOL'S GROUPS AND PUPILS. Every write that holds rows of
 * StudentGroups and Users (klasser, undervisningsgrupper, halvklasser,
 * elever), one row or many, takes them in this order:
 *
 *   1. the school's people lock, shared (holdTheSchoolsPeople);
 *   2. every group row it will write, in one statement, in id order
 *      (lockGroups): the groups it names, and the rows their writes reach,
 *      a class's halves and next year's successors;
 *   3. the pupils, in id order.
 *
 * Two writes that take what they share in one order queue; two that take it
 * in opposite orders can each hold the row the other waits for, and Postgres
 * then aborts one (40P01, answered 409 WRITE_CONFLICT "försök igen").
 *
 * EVERY ROW IT WILL WRITE, FIRST. A bulk write that locked the groups it
 * named but reached their halves only through its UPDATE, or a single
 * update or delete that took a class and then its halves as the statement
 * and its cascade reached them, took a class before its half whatever their
 * ids, against a write that held the half because its id was the lower. Held
 * in one statement before anything is written, the order is the statement's.
 *
 * ID ORDER, because it is the order the writes that hold many groups and do
 * not come through here already take: the rollover and the year's activation
 * hold the year's groups FOR SHARE in id order and then move the pupils
 * (year-rollover.service.ts, staffing-rollover.service.ts). A class before
 * its halves, the order a cascade takes, would hold a class whose half the
 * rollover already holds and wait for it, while the rollover waited for the
 * class.
 *
 * GROUPS BEFORE PUPILS, as a class's delete empties its pupils' class
 * (Users.studentGroupId, SET NULL) after it holds the class, a placement in
 * halves holds the class and then its pupils (holdPupils), and the rollover
 * holds the groups and then moves the pupils. A pupil's own write meets a
 * group through its key only (KEY SHARE), which waits on nothing but the
 * group's delete; a move into a class therefore holds the class first (FOR
 * SHARE), and only then the pupils: else a move from one class to another,
 * both being deleted, would hold the pupil and wait for the class, while the
 * delete held the class and waited for the pupil it empties. FOR SHARE also
 * keeps the class a class (no kind change) while the move is judged.
 *
 * The SS12000 apply locks every pupil of the school and then every group,
 * in the tables' order, under the same school lock held alone
 * (local-slice.ts), as a guardian's calendar feed holds it shared
 * (20261112091000). So does every write here: no apply runs between their
 * row locks.
 */

/** Step 1: the school's people lock, shared. First in its transaction, before any row lock. */
export async function holdTheSchoolsPeople(tx: PrismaClient, schoolId: string): Promise<void> {
  await tx.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${`Users:${schoolId}`}, 0))`,
  );
}

/** A row lock's strength, as written after FOR. */
export type RowLock = 'UPDATE' | 'NO KEY UPDATE' | 'SHARE' | 'KEY SHARE';


/**
 * Step 2: the groups `ids` FOR `lock`, in id order, in one statement.
 * With `halves`, also the halves of those that are classes: a class's
 * årskurs is written to its halves, and a class's delete takes them. With
 * `successors`, also the groups whose predecessor is one of those (next
 * year's class after the rollover, StudentGroups.predecessorId), which a
 * delete writes (SET NULL).
 */
export async function lockGroups(
  tx: PrismaClient,
  ids: readonly string[],
  lock: RowLock,
  options: { halves?: boolean; successors?: boolean } = {},
): Promise<void> {
  if (ids.length === 0) return;
  const named = [...ids];
  const halves = options.halves ? Prisma.sql` OR g."halfOfId" = ANY(${named}::uuid[])` : Prisma.empty;
  const successors = options.successors
    ? Prisma.sql` OR g."predecessorId" = ANY(${named}::uuid[])
        OR g."predecessorId" IN (SELECT h."id" FROM "StudentGroups" h WHERE h."halfOfId" = ANY(${named}::uuid[]))`
    : Prisma.empty;
  await tx.$executeRaw(Prisma.sql`
    SELECT 1 FROM "StudentGroups" g
     WHERE g."id" = ANY(${named}::uuid[])${halves}${successors}
     ORDER BY g."id"
     FOR ${Prisma.raw(lock)}`);
}

/**
 * Step 3 for a class's own pupils (Users.studentGroupId), FOR `lock` in id
 * order: a class's new årskurs rewrites its pupils' class history
 * (StudentEnrollments_enrollment_grade), whose open segment a pupil's move
 * rewrites after holding the pupil's row. Held first, the two queue on the
 * pupil instead of each holding a segment the other waits for.
 */
export async function lockHomePupils(tx: PrismaClient, groupIds: readonly string[], lock: RowLock): Promise<void> {
  if (groupIds.length === 0) return;
  await tx.$executeRaw(Prisma.sql`
    SELECT 1 FROM "Users" WHERE "studentGroupId" = ANY(${[...groupIds]}::uuid[]) ORDER BY "id" FOR ${Prisma.raw(lock)}`);
}
