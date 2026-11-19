import type { PrismaClient, TeacherQualificationKind } from '@prisma/client';

/*
 * BEHÖRIGHET SOM I ETT ANNAT ÄMNE (migration 20270225090000).
 *
 * A subject may name another whose behörighet it uses, Subjects."qualification
 * SubjectId": "SO WS" -> "SO". A teacher who holds SO is then qualified for
 * SO WS with the SO row's årskurser, kind (LEGITIMATION, BEHORIG, TILLATEN) and
 * validity — wherever behörighet is counted. Nothing is stored twice: the
 * database holds the one pointer, and this file derives the rest.
 *
 * ONE PLACE EXPANDS. Every reader of the behörighet table that ASKS WHO IS
 * QUALIFIED reads it here (readHeldQualifications), and what comes back is the
 * stored rows plus, for every subject that points at a subject somebody holds,
 * a copy of that row with the pointing subject's id. After that the rule needs
 * no new case anywhere: `qualificationCovers` compares `subjectId`, and the
 * derived row has the subject the requirement is for. The readers that LIST
 * the table (the register extract, the school export, the CSV, the person
 * page's own form) read the stored rows and nothing else on purpose, so a
 * derived row is never written back as if a teacher held it twice
 * (qualification-readers.inventory.spec.ts holds every reader to one of the
 * two lists).
 *
 * ONE LEVEL. A subject that others inherit from inherits from nobody, and none
 * points at itself (a CHECK and a trigger in the database, and the service's
 * own sentences). So the expansion is one lookup, not a walk: there is no
 * chain to follow and no cycle to break.
 *
 * UNION, NEVER REPLACEMENT. A teacher who holds both SO and a row of their own
 * on SO WS holds both: the derived row is added beside the stored one. Two
 * rows of one teacher and one subject is therefore possible in what these
 * readers return (never in the table, which has one per teacher and subject),
 * and every consumer asks "does any row cover this" or "which kind is
 * strongest", both of which are the same for a duplicate.
 */

/** The columns every reader of behörighet needs, as the table holds them. */
export const QUALIFICATION_SELECT = {
  userId: true,
  subjectId: true,
  minGradeLevel: true,
  maxGradeLevel: true,
  kind: true,
  validFrom: true,
  validTo: true,
} as const;

/** One behörighet as a reader gets it, the two DATE columns still Dates. */
export interface HeldQualification {
  userId: string;
  subjectId: string;
  minGradeLevel: number;
  maxGradeLevel: number;
  kind: TeacherQualificationKind;
  validFrom: Date | null;
  validTo: Date | null;
  /**
   * Set on a derived row, and only on one: the subject whose row it is a copy
   * of. `subjectId` is then the subject that uses it. Absent on a stored row.
   */
  viaSubjectId?: string;
}

/** Subject id -> the subject whose behörighet it uses. Only the subjects that use one are in it. */
export type QualificationLinks = ReadonlyMap<string, string>;

/**
 * The stored rows, and a copy of every row of a source subject for each
 * subject that uses it, in the order the links list them (by subject id).
 * Pure: the links come from readQualificationLinks.
 */
export function expandInheritedQualifications<T extends { subjectId: string }>(
  rows: readonly T[],
  links: QualificationLinks,
): (T & { viaSubjectId?: string })[] {
  if (links.size === 0) return [...rows];
  const usersOf = new Map<string, string[]>();
  for (const [subjectId, sourceId] of [...links.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    const list = usersOf.get(sourceId);
    if (list) list.push(subjectId);
    else usersOf.set(sourceId, [subjectId]);
  }
  const out: (T & { viaSubjectId?: string })[] = [...rows];
  for (const row of rows) {
    for (const subjectId of usersOf.get(row.subjectId) ?? []) {
      out.push({ ...row, subjectId, viaSubjectId: row.subjectId });
    }
  }
  return out;
}

/**
 * The pointers of the school's subjects (RLS confines the read to the
 * school): all of them, or those of `subjectIds` alone.
 */
export async function readQualificationLinks(
  tx: Pick<PrismaClient, 'subject'>,
  subjectIds?: readonly string[],
): Promise<Map<string, string>> {
  const rows =
    (await tx.subject.findMany({
      where: {
        qualificationSubjectId: { not: null },
        ...(subjectIds ? { id: { in: [...subjectIds] } } : {}),
      },
      select: { id: true, qualificationSubjectId: true },
      orderBy: { id: 'asc' },
    })) ?? [];
  const links = new Map<string, string>();
  for (const row of rows) {
    if (row.qualificationSubjectId) links.set(row.id, row.qualificationSubjectId);
  }
  return links;
}

/**
 * Who is qualified, in which subject, with the derived rows in: the stored
 * rows of the school, or, with `subjectIds`, those that count for exactly
 * those subjects (the rows of a subject's source included, under the
 * subject's own id).
 *
 * THE COST, said once. The pointers are one more read beside the rows, and
 * only when there is something to expand: a school with no stored row has
 * nothing recorded, a derived row needs a stored one, and an unscoped read
 * that finds none stops there. So a school that records no behörighet pays
 * nothing, and one that does pays one small read of its subjects' pointers per
 * judgement — the statement budgets of the writes that judge behörighet
 * (projected-rosters.budget.spec.ts) name it. Reading the pointers through the
 * rows' subject would be one call and two statements, which is no cheaper.
 */
export async function readHeldQualifications(
  tx: Pick<PrismaClient, 'subject' | 'teacherSubjectQualification'>,
  scope?: { subjectIds: readonly string[] },
): Promise<HeldQualification[]> {
  if (!scope) {
    const stored = ((await tx.teacherSubjectQualification.findMany({ select: QUALIFICATION_SELECT })) ??
      []) as HeldQualification[];
    if (stored.length === 0) return stored;
    return expandInheritedQualifications(stored, await readQualificationLinks(tx));
  }
  if (scope.subjectIds.length === 0) return [];
  // The source's rows are read under the using subject's id, so both ends of
  // each pointer are asked for, and only the asked-for subjects are returned.
  const wanted = new Set(scope.subjectIds);
  const links = await readQualificationLinks(tx, scope.subjectIds);
  const stored = ((await tx.teacherSubjectQualification.findMany({
    where: { subjectId: { in: [...new Set([...wanted, ...links.values()])] } },
    select: QUALIFICATION_SELECT,
  })) ?? []) as HeldQualification[];
  return expandInheritedQualifications(stored, links).filter((row) => wanted.has(row.subjectId));
}
