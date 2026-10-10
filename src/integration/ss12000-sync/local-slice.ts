import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { LocalSlice } from './diff';

/**
 * The part of the school a diff compares against, read in one transaction
 * (the sync principal's for a run, the admin's or the sync's for an apply),
 * and the hash that says whether it is still what the diff saw.
 *
 * With `lock`, every row the apply may write or rely on is first locked FOR
 * NO KEY UPDATE (users, groups, guardian links, teaching memberships, duty
 * links of the school) — the lock an UPDATE that changes no unique-indexed
 * column takes anyway, so it queues a concurrent PATCH exactly as the write
 * would and leaves inserts that merely reference these rows alone (see
 * PrismaService, "Which row lock"). Read after the lock, under READ
 * COMMITTED, the slice is what the apply will write against.
 */
export interface SliceReadOptions {
  lock: boolean;
}

export interface SourceBasis {
  modifiedCursor: Date | null;
  deletedCursor: Date | null;
  organisationIds: string[];
}

export interface SchoolSlice extends LocalSlice {
  timezone: string;
}

const day = (value: Date | null): string | null => (value ? value.toISOString().slice(0, 10) : null);

export async function readLocalSlice(tx: PrismaClient, schoolId: string, options: SliceReadOptions): Promise<SchoolSlice> {
  if (options.lock) {
    await tx.$executeRaw(Prisma.sql`SELECT 1 FROM "Users" WHERE "schoolId" = ${schoolId}::uuid FOR NO KEY UPDATE`);
    await tx.$executeRaw(Prisma.sql`SELECT 1 FROM "StudentGroups" WHERE "schoolId" = ${schoolId}::uuid FOR NO KEY UPDATE`);
    await tx.$executeRaw(Prisma.sql`SELECT 1 FROM "GuardianStudents" WHERE "schoolId" = ${schoolId}::uuid FOR NO KEY UPDATE`);
    await tx.$executeRaw(Prisma.sql`SELECT 1 FROM "StudentGroupMembers" WHERE "schoolId" = ${schoolId}::uuid FOR NO KEY UPDATE`);
    await tx.$executeRaw(Prisma.sql`SELECT 1 FROM "Ss12000DutyLinks" WHERE "schoolId" = ${schoolId}::uuid FOR NO KEY UPDATE`);
  }
  const [school, users, groups, members, links, dutyLinks, years, deactivations] = await Promise.all([
    tx.school.findFirst({ where: { id: schoolId }, select: { name: true, timezone: true } }),
    tx.user.findMany({
      where: { schoolId },
      select: {
        id: true,
        role: true,
        firstName: true,
        lastName: true,
        email: true,
        isActive: true,
        studentGroupId: true,
        ss12000Id: true,
        invitedAt: true,
        updatedAt: true,
      },
      orderBy: { id: 'asc' },
    }),
    tx.studentGroup.findMany({
      where: { schoolId },
      select: { id: true, name: true, kind: true, academicYearId: true, gradeLevel: true, ss12000Id: true, updatedAt: true },
      orderBy: { id: 'asc' },
    }),
    tx.studentGroupMember.findMany({ where: { schoolId }, select: { studentGroupId: true, studentId: true } }),
    tx.guardianStudent.findMany({ where: { schoolId }, select: { guardianId: true, studentId: true, origin: true } }),
    tx.ss12000DutyLink.findMany({
      where: { schoolId },
      select: { id: true, userId: true, academicYearId: true, ss12000DutyId: true, dutyRole: true, startDate: true, endDate: true, endedAt: true },
      orderBy: { id: 'asc' },
    }),
    tx.academicYear.findMany({
      where: { schoolId },
      select: { id: true, startDate: true, endDate: true, isActive: true },
      orderBy: { startDate: 'asc' },
    }),
    // When an applied sync change last deactivated each person: a person an
    // admin deactivated (or touched) since is not the sync's to reactivate.
    tx.ss12000SyncChange.findMany({
      where: { schoolId, op: 'DEACTIVATE', applied: true, localId: { not: null } },
      select: { localId: true, runId: true },
    }),
  ]);
  const runIds = [...new Set(deactivations.map((change) => change.runId))];
  const runs = runIds.length
    ? await tx.ss12000SyncRun.findMany({ where: { id: { in: runIds }, schoolId }, select: { id: true, appliedAt: true } })
    : [];
  const appliedAt = new Map(runs.map((run) => [run.id, run.appliedAt]));
  const lastSyncDeactivation = new Map<string, number>();
  for (const change of deactivations) {
    const at = appliedAt.get(change.runId)?.getTime();
    if (at === undefined || !change.localId) continue;
    lastSyncDeactivation.set(change.localId, Math.max(at, lastSyncDeactivation.get(change.localId) ?? 0));
  }

  return {
    schoolName: school?.name ?? '',
    timezone: school?.timezone ?? 'Europe/Stockholm',
    users: users.map((user) => {
      const deactivatedAt = lastSyncDeactivation.get(user.id);
      return {
        id: user.id,
        role: user.role,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        isActive: user.isActive,
        studentGroupId: user.studentGroupId,
        ss12000Id: user.ss12000Id,
        invited: user.invitedAt !== null,
        updatedAt: user.updatedAt,
        deactivatedBySync: !user.isActive && deactivatedAt !== undefined && user.updatedAt.getTime() <= deactivatedAt,
      };
    }),
    groups: groups.map((group) => ({ ...group })),
    teachingMembers: members,
    guardianLinks: links,
    dutyLinks: dutyLinks.map((link) => ({
      id: link.id,
      userId: link.userId,
      academicYearId: link.academicYearId,
      ss12000DutyId: link.ss12000DutyId,
      dutyRole: link.dutyRole,
      startDate: day(link.startDate) ?? '',
      endDate: day(link.endDate),
      ended: link.endedAt !== null,
    })),
    years: years.map((year) => ({
      id: year.id,
      startDate: day(year.startDate) ?? '',
      endDate: day(year.endDate) ?? '',
      isActive: year.isActive,
    })),
    lastAppliedAt: null,
  };
}

/**
 * sha256 over the canonical JSON of every compared column of the slice, the
 * active year and the source's cursors and organisations. Order-independent:
 * every list is sorted before hashing. The apply recomputes it against the
 * rows it has locked and refuses a diff whose basis moved (409
 * SS12000_DIFF_STALE).
 */
export function basisHash(slice: LocalSlice, source: SourceBasis): string {
  const sortBy = <T>(rows: T[], key: (row: T) => string) => [...rows].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const canonical = {
    users: sortBy(slice.users, (u) => u.id).map((u) => [
      u.id, u.role, u.firstName, u.lastName, u.email.toLowerCase(), u.isActive, u.studentGroupId, u.ss12000Id, u.invited,
    ]),
    groups: sortBy(slice.groups, (g) => g.id).map((g) => [g.id, g.name, g.kind, g.academicYearId, g.gradeLevel, g.ss12000Id]),
    members: slice.teachingMembers.map((m) => `${m.studentGroupId}|${m.studentId}`).sort(),
    links: slice.guardianLinks.map((l) => `${l.guardianId}|${l.studentId}|${l.origin}`).sort(),
    duties: sortBy(slice.dutyLinks, (d) => d.id).map((d) => [
      d.id, d.userId, d.academicYearId, d.ss12000DutyId, d.dutyRole, d.startDate, d.endDate, d.ended,
    ]),
    activeYear: slice.years.find((year) => year.isActive)?.id ?? null,
    source: {
      modifiedCursor: source.modifiedCursor?.toISOString() ?? null,
      deletedCursor: source.deletedCursor?.toISOString() ?? null,
      organisationIds: [...source.organisationIds].sort(),
    },
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
