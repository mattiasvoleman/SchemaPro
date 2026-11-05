import { Prisma, type PrismaClient } from '@prisma/client';

/*
 * ONE ORDER FOR A SCHOOL'S GROUPS AND PUPILS. The writes that hold rows of
 * StudentGroups and Users (klasser, undervisningsgrupper, halvklasser,
 * elever), one row or many, take them in this order (the list at the end
 * says which writes, and which steps of it each takes):
 *
 *   1. the school's people lock, shared (holdTheSchoolsPeople);
 *   2. every group row it will write or lock, in one statement, in id order
 *      (lockGroups): the groups it names, and the rows their writes reach,
 *      a class's halves, next year's successors, and a half's class when
 *      the write wakes the trigger that holds it;
 *   3. the pupils, in id order.
 *
 * Two writes that take what they share in one order queue; two that take it
 * in opposite orders can each hold the row the other waits for, and Postgres
 * then aborts one (40P01, answered 409 WRITE_CONFLICT "försök igen").
 *
 * EVERY ROW IT WILL WRITE OR LOCK, FIRST. A bulk write that locked the
 * groups it named but reached their halves only through its UPDATE, or a
 * single update or delete that took a class and then its halves as the
 * statement and its cascade reached them, took a class before its half
 * whatever their ids, against a write that held the half because its id was
 * the lower. The other way round, a half's own edit that names its kind or
 * läsår wakes StudentGroups_half_is_of_a_class, which holds the half's class
 * FOR SHARE after the half: against a write over the class whose id is the
 * lower, each held what the other waited for. Held in one statement before
 * anything is written, the order is the statement's.
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
 * (20261112091000). A write that takes the lock first runs wholly before or
 * wholly after an apply: no apply runs between its row locks. Without it, a
 * write that holds rows in an order of its own while an apply holds them in
 * the tables' order deadlocks against it, and did in every forced overlap
 * measured: the year's activation, the rollover and the carry of tjänster
 * (80 of 80 each), the CSV import of the members of halves and the legacy
 * roster import (20 of 20 each, in two layouts).
 *
 * WHO TAKES WHAT, as the code stands.
 *   Steps 1 to 3: student-groups.service (update, remove, bulkUpdate,
 *   bulkRemove, split, placeHalves, setMembers), users.service (update when
 *   the class changes, bulkUpdateStudents, bulkRemoveStudents) and
 *   ImportService.importMemberships, whose pupils placed in a half are held
 *   in id order before the members are inserted, as the member trigger would
 *   otherwise hold them in the order of the file.
 *   Step 1, and a year's groups FOR SHARE in id order as their own step 2: the
 *   rollover, the year's activation and the carry of tjänster. Each holds a
 *   year's groups and then rows of Users (the activation's pupils, a half's
 *   members the member trigger holds FOR SHARE, the staff of a carry), which
 *   an apply holds while it waits for those groups.
 *   Step 1 alone: Ss12000Service.importPersons, the legacy roster import. It
 *   writes the pupils in the order of the roster it was sent, so it queues
 *   behind an apply but is not ordered against a write that holds pupils in
 *   id order.
 *   None: the term halves' split, which holds the year and one class and no
 *   Users row beyond the keys it references, so it waits on nothing an apply
 *   holds; and the apply, which takes step 1 exclusively (local-slice.ts).
 * A new write that holds rows of both tables belongs on this list.
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
 * delete writes (SET NULL). With `classes`, also the class of those that
 * are halves (StudentGroups.halfOfId, which never changes): a half's write
 * that names its halfOfId, kind or academicYearId wakes the trigger
 * StudentGroups_half_is_of_a_class, which holds the class FOR SHARE.
 */
export async function lockGroups(
  tx: PrismaClient,
  ids: readonly string[],
  lock: RowLock,
  options: { halves?: boolean; successors?: boolean; classes?: boolean } = {},
): Promise<void> {
  if (ids.length === 0) return;
  const named = [...ids];
  const halves = options.halves ? Prisma.sql` OR g."halfOfId" = ANY(${named}::uuid[])` : Prisma.empty;
  const successors = options.successors
    ? Prisma.sql` OR g."predecessorId" = ANY(${named}::uuid[])
        OR g."predecessorId" IN (SELECT h."id" FROM "StudentGroups" h WHERE h."halfOfId" = ANY(${named}::uuid[]))`
    : Prisma.empty;
  const classes = options.classes
    ? Prisma.sql` OR g."id" IN (SELECT h."halfOfId" FROM "StudentGroups" h WHERE h."id" = ANY(${named}::uuid[]) AND h."halfOfId" IS NOT NULL)`
    : Prisma.empty;
  await tx.$executeRaw(Prisma.sql`
    SELECT 1 FROM "StudentGroups" g
     WHERE g."id" = ANY(${named}::uuid[])${halves}${successors}${classes}
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

/**
 * Step 3 for pupils named by id: their rows FOR SHARE, in id order, in one
 * statement, before a write touches a membership row. A class change takes the
 * pupil's row first and the memberships after (the Users trigger leaves the
 * old class's halves); a placement that deleted a pupil's half row and only
 * then met the pupil's row (the member trigger reads it FOR SHARE) would take
 * them the other way round, and the two could deadlock. Held first, a class
 * change waits for the placement or the placement for it, and either sees the
 * other's commit. The member trigger takes its pupils in the order the rows
 * are inserted: a write that inserts members in the order of a file held
 * them in the file's order, against a bulk write that holds pupils in id order.
 */
export async function holdPupils(tx: PrismaClient, pupils: Iterable<string>): Promise<void> {
  const ids = [...pupils].sort();
  if (ids.length === 0) return;
  await tx.$queryRaw`SELECT 1 FROM "Users" WHERE "id" = ANY(${ids}::uuid[]) ORDER BY "id" FOR SHARE`;
}
