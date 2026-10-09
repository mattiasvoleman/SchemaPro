import type { PrismaClient } from '@prisma/client';
import type { LastYearTeachers } from './suggest-teachers';

/*
 * "Samma lärare som förra året": who taught a subject for a group's
 * predecessor (StudentGroup.predecessorId, set by the year rollover), as Fas 5
 * defined it — the union of lead and co-teacher over EVERY predecessor row of
 * the subject (split rows, odd/even weeks, term courses alike).
 *
 * ONE FOLD, TWO READS. The picker (StaffingLoadService.suggestTeachers) asks
 * about one row and makes exactly the statement it always made; the staffing
 * proposal asks about every row of a year at once and makes one statement for
 * all of them. Both hand the rows to foldLastYearTeachers, so "taught last
 * year" cannot mean one thing in the picker's badge and another in the
 * proposal's continuity term.
 *
 * LR409 keeps a predecessor group in the predecessor year, so neither read
 * filters on a year. Both read TeachingRequirements — not HR data — and never
 * reach rostersOfYear (the roster-readers inventory's rule 5).
 */

/** What a predecessor row is read with: its teachers, its group's and year's names. */
const LAST_YEAR_SELECT = {
  teacherId: true,
  coTeacherId: true,
  studentGroup: { select: { name: true, academicYear: { select: { name: true } } } },
} as const;

export interface LastYearRow {
  teacherId: string | null;
  coTeacherId: string | null;
  studentGroup: { name: string; academicYear: { name: string } };
}

/** The predecessor's rows of the subject, folded to who taught them; null for none. */
export function foldLastYearTeachers(rows: readonly LastYearRow[]): LastYearTeachers | null {
  const first = rows[0];
  if (!first) return null;
  const teacherIds = new Set<string>();
  for (const row of rows) {
    if (row.teacherId) teacherIds.add(row.teacherId);
    if (row.coTeacherId) teacherIds.add(row.coTeacherId);
  }
  return {
    groupName: first.studentGroup.name,
    yearName: first.studentGroup.academicYear.name,
    teacherIds: [...teacherIds].sort(),
  };
}

/** One (predecessor group, subject): the picker's statement, unchanged. */
export async function readLastYearTeachersOf(
  tx: PrismaClient,
  predecessorId: string,
  subjectId: string,
): Promise<LastYearTeachers | null> {
  return foldLastYearTeachers(
    await tx.teachingRequirement.findMany({
      where: { studentGroupId: predecessorId, subjectId },
      select: LAST_YEAR_SELECT,
      orderBy: { id: 'asc' },
    }),
  );
}

export interface LastYearKey {
  predecessorId: string;
  subjectId: string;
}

/** The map key of one (predecessor group, subject). */
export function lastYearKey(predecessorId: string, subjectId: string): string {
  return `${predecessorId}|${subjectId}`;
}

/**
 * Every asked (predecessor group, subject) in ONE statement: the predecessor
 * groups' rows, folded per key exactly as readLastYearTeachersOf folds one.
 * Rows in id order, as there, so a key's group and year name come from the
 * same first row either way. A key with no rows is absent from the map, as
 * readLastYearTeachersOf answers it null. No keys, no statement.
 */
export async function readLastYearTeachers(
  tx: PrismaClient,
  keys: readonly LastYearKey[],
): Promise<Map<string, LastYearTeachers>> {
  const wanted = new Set(keys.map((key) => lastYearKey(key.predecessorId, key.subjectId)));
  const groupIds = [...new Set(keys.map((key) => key.predecessorId))].sort();
  if (groupIds.length === 0) return new Map();
  const rows = await tx.teachingRequirement.findMany({
    where: { studentGroupId: { in: groupIds } },
    select: { ...LAST_YEAR_SELECT, studentGroupId: true, subjectId: true },
    orderBy: { id: 'asc' },
  });
  const byKey = new Map<string, LastYearRow[]>();
  for (const row of rows) {
    const key = lastYearKey(row.studentGroupId, row.subjectId);
    if (!wanted.has(key)) continue;
    const list = byKey.get(key);
    if (list) list.push(row);
    else byKey.set(key, [row]);
  }
  const out = new Map<string, LastYearTeachers>();
  for (const [key, list] of byKey) {
    const folded = foldLastYearTeachers(list);
    if (folded) out.set(key, folded);
  }
  return out;
}
