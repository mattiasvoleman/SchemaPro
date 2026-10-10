import { ConflictException } from '@nestjs/common';
import { Prisma, type CoverDecisionKind, type PrismaClient, type TeacherAssignmentRole } from '@prisma/client';

/**
 * THE COVER DECISIONS, AS PLAIN FUNCTIONS OVER A TRANSACTION.
 *
 * CalendarLessonsService writes a decision when an assignment replaces an
 * absent teacher (so the old page and the day planner land on the board),
 * and CoverService writes and undoes them from the board. Both import these
 * helpers; neither is a Nest provider, so CoverModule can import
 * CalendarModule without a cycle.
 *
 * "cover" here is vikarie cover, never the timplan's Täckning (coverage):
 * nothing named coverage is touched.
 */

/** The note "självstudier under tillsyn" writes, as publish writes its own constant notes. */
export const SUPERVISED_STUDY_NOTE = 'Självstudier under tillsyn';

export const SUBSTITUTE_IS_ABSENT = 'SUBSTITUTE_IS_ABSENT';
export const SUBSTITUTE_ON_LESSON = 'SUBSTITUTE_ON_LESSON';
export const SUBSTITUTE_HAS_LESSON = 'SUBSTITUTE_HAS_LESSON';
export const REPLACED_TEACHER_NOT_ON_LESSON = 'REPLACED_TEACHER_NOT_ON_LESSON';

export interface RemovedTeacher {
  teacherId: string;
  role: TeacherAssignmentRole;
}

/** A notice to send once the transaction has committed (never inside it). */
export interface PendingNotice {
  kind: 'COVER' | 'WITHDRAWN';
  userId: string;
  lessonId: string;
}

export interface DecisionRow {
  id: string;
  absenceId: string;
  calendarLessonId: string;
  absentTeacherId: string;
  removedTeachers: RemovedTeacher[];
  decision: CoverDecisionKind;
  substituteId: string | null;
  previousNote: string | null;
  decidedAt: Date;
}

const ROLES: readonly TeacherAssignmentRole[] = ['LEAD', 'ASSISTANT', 'SUBSTITUTE'];

/** The jsonb column back as the list it is; anything else is read as nothing. */
export function parseRemoved(value: unknown): RemovedTeacher[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const row = entry as { teacherId?: unknown; role?: unknown };
    return typeof row?.teacherId === 'string' && ROLES.includes(row.role as TeacherAssignmentRole)
      ? [{ teacherId: row.teacherId, role: row.role as TeacherAssignmentRole }]
      : [];
  });
}

/** removedTeachers, deduplicated by person, in a stable order. */
export function mergeRemoved(...lists: RemovedTeacher[][]): RemovedTeacher[] {
  const byTeacher = new Map<string, RemovedTeacher>();
  for (const list of lists) for (const entry of list) if (!byTeacher.has(entry.teacherId)) byTeacher.set(entry.teacherId, entry);
  return [...byTeacher.values()];
}

const DECISION_SELECT = {
  id: true,
  absenceId: true,
  calendarLessonId: true,
  absentTeacherId: true,
  removedTeachers: true,
  decision: true,
  substituteId: true,
  previousNote: true,
  decidedAt: true,
} as const;

function toRow(row: {
  id: string;
  absenceId: string;
  calendarLessonId: string;
  absentTeacherId: string;
  removedTeachers: unknown;
  decision: CoverDecisionKind;
  substituteId: string | null;
  previousNote: string | null;
  decidedAt: Date;
}): DecisionRow {
  return { ...row, removedTeachers: parseRemoved(row.removedTeachers) };
}

/** Every decision on the lessons, oldest first (the undo order). */
export async function decisionsOn(tx: PrismaClient, lessonIds: readonly string[]): Promise<DecisionRow[]> {
  if (lessonIds.length === 0) return [];
  const rows =
    (await tx.teacherAbsenceCover.findMany({
      where: { calendarLessonId: { in: [...lessonIds] } },
      select: DECISION_SELECT,
      orderBy: [{ decidedAt: 'asc' }, { id: 'asc' }],
    })) ?? [];
  return rows.filter((row) => row?.id).map(toRow);
}

/**
 * Writes the decision for (absence, lesson): a new row, or the stale one
 * replaced in place (UNIQUE (absenceId, calendarLessonId)) with the rows it
 * already removed kept, so an undo still puts them back.
 */
export async function writeDecision(
  tx: PrismaClient,
  args: {
    schoolId: string;
    absenceId: string;
    lessonId: string;
    absentTeacherId: string;
    decision: CoverDecisionKind;
    removed: RemovedTeacher[];
    substituteId: string | null;
    previousNote?: string | null;
    decidedByUserId: string | null;
    existing: DecisionRow | undefined;
  },
): Promise<void> {
  const removedTeachers = mergeRemoved(args.existing?.removedTeachers ?? [], args.removed) as unknown as Prisma.InputJsonValue;
  if (args.existing) {
    await tx.teacherAbsenceCover.update({
      where: { id: args.existing.id },
      data: {
        decision: args.decision,
        removedTeachers,
        substituteId: args.substituteId,
        previousNote: args.decision === 'SUPERVISED_STUDY' ? (args.previousNote ?? null) : null,
        decidedByUserId: args.decidedByUserId,
        decidedAt: new Date(),
      },
    });
    return;
  }
  await tx.teacherAbsenceCover.create({
    data: {
      schoolId: args.schoolId,
      absenceId: args.absenceId,
      calendarLessonId: args.lessonId,
      absentTeacherId: args.absentTeacherId,
      decision: args.decision,
      removedTeachers,
      substituteId: args.substituteId,
      previousNote: args.decision === 'SUPERVISED_STUDY' ? (args.previousNote ?? null) : null,
      decidedByUserId: args.decidedByUserId,
    },
  });
}

/**
 * The row lock of each lesson, in id order (two writers taking several never
 * deadlock on each other). $executeRaw, not $queryRaw: nothing is read back.
 */
export async function lockLessons(tx: PrismaClient, lessonIds: readonly string[]): Promise<void> {
  for (const id of [...new Set(lessonIds)].sort()) {
    await tx.$executeRaw(Prisma.sql`SELECT 1 FROM "CalendarLessons" WHERE "id" = ${id}::uuid FOR UPDATE`);
  }
}

/**
 * THE PER-TEACHER COVER LOCK, in sorted id order: every write that puts a
 * person on a lesson (an assignment, a restore) or registers their absence
 * takes it for that person, after the lesson locks. Two admins putting one
 * substitute on two lessons at 10:00 then serialise, and the second's clash
 * check — a statement that starts after the first has committed — sees the
 * first's row; an absence registered meanwhile is seen the same way.
 */
export async function lockTeachers(tx: PrismaClient, teacherIds: readonly string[]): Promise<void> {
  for (const id of [...new Set(teacherIds)].sort()) {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended('cover-teacher:' || ${id}, 0))`);
  }
}

/** One day's apply serialises with itself (the proposal's basis is the day's). */
export async function lockCoverDay(tx: PrismaClient, schoolId: string, date: string): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended('cover:' || ${schoolId} || ':' || ${date}, 0))`);
}

export function substituteIsAbsent(): ConflictException {
  return new ConflictException({
    message: 'Vikarien är själv frånvarande då.',
    code: SUBSTITUTE_IS_ABSENT,
  });
}
