import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { ChangeEntity, ChangeOp } from './diff';

/**
 * Writes the selected changes of a diff, in one transaction the caller
 * opened (the admin's, or the sync principal's for a scheduled auto-apply),
 * in dependency order:
 *
 *   groups (create, link, rename) -> persons (create, link, relink, names,
 *   email, reactivate) -> class moves -> teaching-group adds -> guardian
 *   links -> duty links -> deactivations
 *
 * so a pupil created in this apply can be moved into a class created in it,
 * and a guardian linked in it can be linked to a child. A change that
 * depends on a person or group (a name, a class move, a group member, a
 * guardian link, a duty link) is resolved ONLY by the SOURCE's id: through
 * a row linked before this apply, or one this apply links, relinks or
 * creates. A local id the diff carries is never trusted for it, so when the
 * admin deselects a LINK ("not the same person"), the row the address
 * matched gets nothing — no name, no class, no guardian. A change whose
 * reference does not resolve is skipped with SS12000_DEPENDENCY_NOT_APPLIED
 * and stays unapplied.
 *
 * Every write follows the column rules today's writers follow:
 *
 *   * A person is created as a catalogue row, exactly as UsersService.create
 *     does without sendInvitation: a placeholder authId (randomUUID) that
 *     matches no Supabase identity and invitedAt NULL. No identity is made
 *     and no mail sent; the person appears on the provisioning list.
 *   * A class is written by the statement that checks the role
 *     (`... WHERE role = 'STUDENT'`, as the v1 import does), so a row that
 *     became a teacher meanwhile is never put in a class; P4's trigger
 *     records the move.
 *   * A deactivation never touches a SCHOOL_ADMIN.
 *   * Writes are batched (createMany; UPDATE … FROM (VALUES …) in chunks of
 *     500) so a first apply of a few thousand rows fits the transaction.
 *   * updatedAt is the apply's own stamp, the same value the source's
 *     lastAppliedAt gets, so the apply's own writes never read as a local
 *     edit made after it.
 *
 * Nothing is deleted: no statement here removes a row.
 */
export interface StoredChange {
  id: string;
  seq: number;
  entity: ChangeEntity;
  op: ChangeOp;
  externalId: string | null;
  localId: string | null;
  after: Record<string, unknown> | null;
}

export interface ApplyOutcome {
  applied: string[];
  skipped: Array<{ id: string; code: string; entity: ChangeEntity; externalId: string | null }>;
}

const CHUNK = 500;

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) ? value : null);

function chunks<T>(rows: T[]): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < rows.length; at += CHUNK) out.push(rows.slice(at, at + CHUNK));
  return out;
}

export async function applyChanges(
  tx: PrismaClient,
  schoolId: string,
  selected: StoredChange[],
  stamp: Date,
): Promise<ApplyOutcome> {
  const outcome: ApplyOutcome = { applied: [], skipped: [] };
  const done = (change: StoredChange) => outcome.applied.push(change.id);
  const skip = (change: StoredChange, code: string) =>
    outcome.skipped.push({ id: change.id, code, entity: change.entity, externalId: change.externalId });
  const of = (entity: ChangeEntity, op: ChangeOp) =>
    selected.filter((change) => change.entity === entity && change.op === op).sort((a, b) => a.seq - b.seq);

  // Source id -> local id, for every row linked before this apply.
  const userByExt = new Map<string, string>();
  const groupByExt = new Map<string, string>();
  for (const user of await tx.user.findMany({ where: { schoolId, ss12000Id: { not: null } }, select: { id: true, ss12000Id: true } })) {
    if (user.ss12000Id) userByExt.set(user.ss12000Id, user.id);
  }
  for (const group of await tx.studentGroup.findMany({ where: { schoolId, ss12000Id: { not: null } }, select: { id: true, ss12000Id: true } })) {
    if (group.ss12000Id) groupByExt.set(group.ss12000Id, group.id);
  }
  const userOf = (change: StoredChange): string | null => (change.externalId ? userByExt.get(change.externalId) ?? null : null);
  const groupOf = (change: StoredChange): string | null => {
    const groupExt = str(change.after?.['groupExternalId']);
    return groupExt ? groupByExt.get(groupExt) ?? null : null;
  };
  const personOf = (key: string) => (change: StoredChange): string | null => {
    const id = str(change.after?.[key]);
    return id ? userByExt.get(id) ?? null : null;
  };

  // --- groups ---------------------------------------------------------------
  const groupCreates = of('GROUP', 'CREATE').filter((change) => change.externalId && change.after);
  const groupRows = groupCreates.map((change) => {
    const id = randomUUID();
    groupByExt.set(change.externalId!, id);
    done(change);
    return {
      id,
      schoolId,
      academicYearId: str(change.after!['academicYearId'])!,
      name: str(change.after!['name'])!,
      kind: change.after!['kind'] === 'TEACHING_GROUP' ? ('TEACHING_GROUP' as const) : ('CLASS' as const),
      gradeLevel: num(change.after!['gradeLevel']),
      ss12000Id: change.externalId!,
      updatedAt: stamp,
    };
  });
  for (const rows of chunks(groupRows)) await tx.studentGroup.createMany({ data: rows });

  for (const change of of('GROUP', 'LINK')) {
    if (!change.localId || !change.externalId) continue;
    const { count } = await tx.studentGroup.updateMany({
      where: { id: change.localId, schoolId, ss12000Id: null },
      data: { ss12000Id: change.externalId, updatedAt: stamp },
    });
    if (count !== 1) {
      skip(change, 'SS12000_TARGET_CHANGED');
      continue;
    }
    groupByExt.set(change.externalId, change.localId);
    done(change);
  }
  for (const change of of('GROUP', 'UPDATE')) {
    const name = str(change.after?.['name']);
    if (!change.localId || !name) continue;
    await tx.studentGroup.updateMany({ where: { id: change.localId, schoolId }, data: { name, updatedAt: stamp } });
    done(change);
  }

  // --- persons --------------------------------------------------------------
  const personCreates = of('PERSON', 'CREATE').filter((change) => change.externalId && change.after);
  const personRows = personCreates.map((change) => {
    const id = randomUUID();
    userByExt.set(change.externalId!, id);
    done(change);
    const raw = change.after!['role'];
    const role: 'STUDENT' | 'TEACHER' | 'GUARDIAN' = raw === 'STUDENT' || raw === 'TEACHER' ? raw : 'GUARDIAN';
    return {
      id,
      schoolId,
      // A catalogue row: no Supabase identity, no mail (UsersService.create's rule).
      authId: randomUUID(),
      invitedAt: null,
      role,
      firstName: str(change.after!['firstName'])!,
      lastName: str(change.after!['lastName'])!,
      email: str(change.after!['email'])!,
      ss12000Id: change.externalId!,
      updatedAt: stamp,
    };
  });
  for (const rows of chunks(personRows)) await tx.user.createMany({ data: rows });

  for (const change of of('PERSON', 'LINK')) {
    if (!change.localId || !change.externalId) continue;
    const { count } = await tx.user.updateMany({
      where: { id: change.localId, schoolId, ss12000Id: null, isActive: true },
      data: { ss12000Id: change.externalId, updatedAt: stamp },
    });
    if (count !== 1) {
      skip(change, 'SS12000_TARGET_CHANGED');
      continue;
    }
    userByExt.set(change.externalId, change.localId);
    done(change);
  }
  for (const change of of('PERSON', 'RELINK')) {
    if (!change.localId || !change.externalId) continue;
    const { count } = await tx.user.updateMany({
      where: { id: change.localId, schoolId, ss12000Id: null, role: { not: 'SCHOOL_ADMIN' } },
      data: { ss12000Id: change.externalId, isActive: true, updatedAt: stamp },
    });
    if (count !== 1) {
      skip(change, 'SS12000_TARGET_CHANGED');
      continue;
    }
    userByExt.set(change.externalId, change.localId);
    done(change);
  }

  const names: Array<{ change: StoredChange; userId: string }> = [];
  for (const change of of('PERSON', 'UPDATE').filter((c) => typeof c.after?.['firstName'] === 'string')) {
    const userId = userOf(change);
    if (!userId) {
      skip(change, 'SS12000_DEPENDENCY_NOT_APPLIED');
      continue;
    }
    names.push({ change, userId });
  }
  for (const rows of chunks(names)) {
    const values = rows.map(
      ({ change, userId }) => Prisma.sql`(${userId}::uuid, ${str(change.after!['firstName'])}, ${str(change.after!['lastName'])})`,
    );
    await tx.$executeRaw(Prisma.sql`
      UPDATE "Users" u
         SET "firstName" = v.first_name, "lastName" = v.last_name, "updatedAt" = ${stamp}
        FROM (VALUES ${Prisma.join(values)}) AS v(id, first_name, last_name)
       WHERE u."id" = v.id AND u."schoolId" = ${schoolId}::uuid AND u."role" <> 'SCHOOL_ADMIN'`);
    rows.forEach(({ change }) => done(change));
  }
  for (const change of of('PERSON', 'UPDATE').filter((c) => typeof c.after?.['email'] === 'string')) {
    if (!change.localId) continue;
    await tx.user.updateMany({
      where: { id: change.localId, schoolId, role: { not: 'SCHOOL_ADMIN' } },
      data: { email: str(change.after!['email'])!, updatedAt: stamp },
    });
    done(change);
  }
  for (const change of of('PERSON', 'REACTIVATE')) {
    if (!change.localId) continue;
    await tx.user.updateMany({
      where: { id: change.localId, schoolId, isActive: false, role: { not: 'SCHOOL_ADMIN' } },
      data: { isActive: true, updatedAt: stamp },
    });
    done(change);
  }

  // --- class moves (role-guarded; P4's trigger records each) -----------------
  const moves: Array<{ change: StoredChange; userId: string; groupId: string }> = [];
  for (const change of of('CLASS_MEMBERSHIP', 'MOVE')) {
    const userId = userOf(change);
    const groupId = groupOf(change);
    if (!userId || !groupId) {
      skip(change, 'SS12000_DEPENDENCY_NOT_APPLIED');
      continue;
    }
    moves.push({ change, userId, groupId });
  }
  for (const rows of chunks(moves)) {
    await tx.$executeRaw(Prisma.sql`
      UPDATE "Users" u
         SET "studentGroupId" = v.group_id, "updatedAt" = ${stamp}
        FROM (VALUES ${Prisma.join(rows.map((row) => Prisma.sql`(${row.userId}::uuid, ${row.groupId}::uuid)`))}) AS v(id, group_id)
       WHERE u."id" = v.id AND u."schoolId" = ${schoolId}::uuid AND u."role" = 'STUDENT'
         AND u."studentGroupId" IS DISTINCT FROM v.group_id`);
    rows.forEach((row) => done(row.change));
  }

  // --- teaching-group members -------------------------------------------------
  const memberRows: Array<{ schoolId: string; studentGroupId: string; studentId: string }> = [];
  for (const change of of('GROUP_MEMBERSHIP', 'ADD')) {
    const userId = userOf(change);
    const groupId = groupOf(change);
    if (!userId || !groupId) {
      skip(change, 'SS12000_DEPENDENCY_NOT_APPLIED');
      continue;
    }
    memberRows.push({ schoolId, studentGroupId: groupId, studentId: userId });
    done(change);
  }
  for (const rows of chunks(memberRows)) await tx.studentGroupMember.createMany({ data: rows, skipDuplicates: true });

  // --- guardian links -----------------------------------------------------------
  const linkRows: Array<{ schoolId: string; guardianId: string; studentId: string; origin: 'SS12000' }> = [];
  for (const change of of('RESPONSIBLE', 'ADD')) {
    const studentId = userOf(change);
    const guardianId = personOf('guardianExternalId')(change);
    if (!studentId || !guardianId) {
      skip(change, 'SS12000_DEPENDENCY_NOT_APPLIED');
      continue;
    }
    linkRows.push({ schoolId, guardianId, studentId, origin: 'SS12000' });
    done(change);
  }
  for (const rows of chunks(linkRows)) await tx.guardianStudent.createMany({ data: rows, skipDuplicates: true });

  // --- duty links -----------------------------------------------------------------
  const dutyRows: Prisma.Ss12000DutyLinkCreateManyInput[] = [];
  for (const change of of('DUTY_LINK', 'ADD')) {
    const userId = personOf('personExternalId')(change);
    const academicYearId = str(change.after?.['academicYearId']);
    const startDate = str(change.after?.['startDate']);
    if (!userId || !academicYearId || !startDate || !change.externalId) {
      skip(change, 'SS12000_DEPENDENCY_NOT_APPLIED');
      continue;
    }
    const endDate = str(change.after?.['endDate']);
    dutyRows.push({
      schoolId,
      userId,
      academicYearId,
      ss12000DutyId: change.externalId,
      dutyRole: str(change.after?.['dutyRole']) ?? 'Lärare',
      startDate: new Date(`${startDate}T00:00:00Z`),
      endDate: endDate ? new Date(`${endDate}T00:00:00Z`) : null,
      updatedAt: stamp,
    });
    done(change);
  }
  for (const rows of chunks(dutyRows)) await tx.ss12000DutyLink.createMany({ data: rows, skipDuplicates: true });
  for (const change of of('DUTY_LINK', 'UPDATE')) {
    const userId = personOf('personExternalId')(change);
    const startDate = str(change.after?.['startDate']);
    if (!change.localId || !userId || !startDate) {
      skip(change, 'SS12000_DEPENDENCY_NOT_APPLIED');
      continue;
    }
    const endDate = str(change.after?.['endDate']);
    await tx.ss12000DutyLink.updateMany({
      where: { id: change.localId, schoolId },
      data: {
        userId,
        dutyRole: str(change.after?.['dutyRole']) ?? 'Lärare',
        startDate: new Date(`${startDate}T00:00:00Z`),
        endDate: endDate ? new Date(`${endDate}T00:00:00Z`) : null,
        endedAt: null,
        updatedAt: stamp,
      },
    });
    done(change);
  }
  const ended = of('DUTY_LINK', 'END').filter((change) => change.localId);
  if (ended.length > 0) {
    await tx.ss12000DutyLink.updateMany({
      where: { id: { in: ended.map((change) => change.localId!) }, schoolId, endedAt: null },
      data: { endedAt: stamp, updatedAt: stamp },
    });
    ended.forEach(done);
  }

  // --- deactivations (never an admin; P4's trigger closes the class segment) ---------
  const deactivations = of('PERSON', 'DEACTIVATE').filter((change) => change.localId);
  for (const rows of chunks(deactivations)) {
    await tx.$executeRaw(Prisma.sql`
      UPDATE "Users"
         SET "isActive" = false, "updatedAt" = ${stamp}
       WHERE "schoolId" = ${schoolId}::uuid
         AND "id" IN (${Prisma.join(rows.map((change) => Prisma.sql`${change.localId}::uuid`))})
         AND "role" <> 'SCHOOL_ADMIN' AND "isActive"`);
    rows.forEach(done);
  }

  return outcome;
}
