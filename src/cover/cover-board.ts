import { Prisma, type CoverDecisionKind, type LessonCancelCause, type TeacherAssignmentRole } from '@prisma/client';
import { parseRemoved, type RemovedTeacher } from './cover-decisions';

/**
 * THE COVER BOARD: every (absence, lesson) pair and what has been decided
 * about it, derived when asked.
 *
 * A pair is on the board when the lesson is LIVE for the absence — the
 * absent person still has a row on it, it is SCHEDULED, CANCELLED or
 * COMPLETED (RESCHEDULED is never affected), and it overlaps the ACTIVE
 * absence — or when a decision exists for the pair (the absent row is gone
 * once a decision removed it; a decision of a WITHDRAWN absence is not
 * read).
 *
 * Its status comes from the DECISION, per pair, never from "a SUBSTITUTE row
 * exists": a substitute who is themself absent would otherwise read their
 * own absence as covered, and of two absent co-teachers the second would
 * read as covered by the first's substitute.
 *
 *   CANCELLED  the lesson is cancelled, whatever the cause (the row carries
 *              cancelCause, so the board tells "Inställd (prao)" from its own)
 *   COVERED    a SUBSTITUTE decision, and a SUBSTITUTE row whose holder is
 *              not the absent person and has no ACTIVE absence overlapping
 *   HANDLED    a SUPERVISED_STUDY or CO_TEACHER decision
 *   OPEN       no decision — or a decision whose effect is gone (a SUBSTITUTE
 *              decision without a qualifying row, a CANCELLED decision on a
 *              lesson reinstated since): `decisionStale`, and a new decision
 *              replaces it in place
 *   passed     overlaid when the lesson has ended: nothing can be decided
 *
 * substituteId is read from the calendar, never from the decision (which is
 * audit). No row carries a reason, a reasonId or a note.
 */

export type CoverStatus = 'OPEN' | 'COVERED' | 'CANCELLED' | 'HANDLED';

export interface PairFacts {
  lessonStatus: 'SCHEDULED' | 'CANCELLED' | 'COMPLETED' | 'RESCHEDULED';
  endsAt: Date;
  decision: CoverDecisionKind | null;
  /** SUBSTITUTE rows whose holder is neither the absent person nor absent. */
  coveringSubstituteIds: readonly string[];
}

export interface DerivedStatus {
  status: CoverStatus;
  decisionStale: boolean;
  passed: boolean;
}

export function deriveStatus(facts: PairFacts, now: Date): DerivedStatus {
  const passed = facts.endsAt.getTime() <= now.getTime();
  if (facts.lessonStatus === 'CANCELLED') return { status: 'CANCELLED', decisionStale: false, passed };
  switch (facts.decision) {
    case 'SUBSTITUTE':
      return facts.coveringSubstituteIds.length > 0
        ? { status: 'COVERED', decisionStale: false, passed }
        : { status: 'OPEN', decisionStale: true, passed };
    case 'SUPERVISED_STUDY':
    case 'CO_TEACHER':
      return { status: 'HANDLED', decisionStale: false, passed };
    case 'CANCELLED':
      return { status: 'OPEN', decisionStale: true, passed };
    default:
      return { status: 'OPEN', decisionStale: false, passed };
  }
}

/** One pair as the SQL returns it. */
export interface PairRow {
  absenceId: string;
  absentTeacherId: string;
  lessonId: string;
  isLive: boolean;
  decisionId: string | null;
  decision: CoverDecisionKind | null;
  decidedAt: Date | null;
  removedTeachers: unknown;
  date: string;
  startsAt: Date;
  endsAt: Date;
  subjectId: string;
  studentGroupId: string;
  roomId: string | null;
  lessonStatus: PairFacts['lessonStatus'];
  cancelCause: LessonCancelCause | null;
  absenceStartsAt: Date;
  absenceEndsAt: Date;
  absenceStatus: 'ACTIVE' | 'WITHDRAWN';
  teachers: { teacherId: string; role: TeacherAssignmentRole }[] | null;
  extraGroupIds: string[] | null;
  coveringSubstituteIds: string[] | null;
}

/** One pair as the board answers it. */
export interface BoardItem {
  absenceId: string;
  absentTeacherId: string;
  /** The row the absent person holds, or held before a decision removed it. */
  absentRole: TeacherAssignmentRole | null;
  lessonId: string;
  date: string;
  startsAt: string;
  endsAt: string;
  subjectId: string;
  studentGroupId: string;
  extraGroupIds: string[];
  roomId: string | null;
  lessonStatus: PairFacts['lessonStatus'];
  cancelCause: LessonCancelCause | null;
  teachers: { teacherId: string; role: TeacherAssignmentRole }[];
  substituteId: string | null;
  decision: CoverDecisionKind | null;
  decidedAt: string | null;
  status: CoverStatus;
  decisionStale: boolean;
  passed: boolean;
  /** The decision's lesson no longer overlaps the absence (moved, or the period shortened). */
  outsideAbsence: boolean;
}

export interface BoardSummary {
  open: number;
  covered: number;
  cancelled: number;
  handled: number;
  passedOpen: number;
}

export function toBoardItem(row: PairRow, now: Date): BoardItem {
  const teachers = row.teachers ?? [];
  const covering = row.coveringSubstituteIds ?? [];
  const derived = deriveStatus(
    { lessonStatus: row.lessonStatus, endsAt: row.endsAt, decision: row.decision, coveringSubstituteIds: covering },
    now,
  );
  const removed: RemovedTeacher[] = parseRemoved(row.removedTeachers);
  const absentRole =
    teachers.find((t) => t.teacherId === row.absentTeacherId)?.role ??
    removed.find((r) => r.teacherId === row.absentTeacherId)?.role ??
    null;
  return {
    absenceId: row.absenceId,
    absentTeacherId: row.absentTeacherId,
    absentRole,
    lessonId: row.lessonId,
    date: row.date,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    subjectId: row.subjectId,
    studentGroupId: row.studentGroupId,
    extraGroupIds: row.extraGroupIds ?? [],
    roomId: row.roomId,
    lessonStatus: row.lessonStatus,
    cancelCause: row.cancelCause,
    teachers,
    substituteId: covering[0] ?? null,
    decision: row.decision,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    status: derived.status,
    decisionStale: derived.decisionStale,
    passed: derived.passed,
    outsideAbsence:
      row.decision !== null &&
      !(row.startsAt.getTime() < row.absenceEndsAt.getTime() && row.endsAt.getTime() > row.absenceStartsAt.getTime()),
  };
}

export function summaryOf(items: readonly BoardItem[]): BoardSummary {
  const summary: BoardSummary = { open: 0, covered: 0, cancelled: 0, handled: 0, passedOpen: 0 };
  for (const item of items) {
    if (item.status === 'OPEN') {
      if (item.passed) summary.passedOpen++;
      else summary.open++;
    } else if (item.status === 'COVERED') summary.covered++;
    else if (item.status === 'CANCELLED') summary.cancelled++;
    else summary.handled++;
  }
  return summary;
}

export type PairScope =
  | { kind: 'window'; from: string; to: string; winFrom: Date; winTo: Date }
  | { kind: 'absences'; ids: readonly string[] };

/**
 * The pairs, in one statement, run as the caller under RLS: an admin reads
 * every absence; a teacher their own (and the board query is admin-only, so
 * a teacher reaches this only for the counts of their own register).
 */
export function pairsStatement(scope: PairScope): Prisma.Sql {
  const absences =
    scope.kind === 'window'
      ? Prisma.sql`SELECT "id", "userId", "startsAt", "endsAt" FROM "TeacherAbsences"
                    WHERE "status" = 'ACTIVE'
                      AND tstzrange("startsAt", "endsAt") && tstzrange(${scope.winFrom}::timestamptz, ${scope.winTo}::timestamptz)`
      : Prisma.sql`SELECT "id", "userId", "startsAt", "endsAt" FROM "TeacherAbsences"
                    WHERE "status" = 'ACTIVE' AND "id" = ANY(${[...scope.ids]}::uuid[])`;
  const liveDates =
    scope.kind === 'window' ? Prisma.sql`AND cl."date" BETWEEN ${scope.from}::date AND ${scope.to}::date` : Prisma.empty;
  const decisionScope =
    scope.kind === 'window'
      ? Prisma.sql`cl."date" BETWEEN ${scope.from}::date AND ${scope.to}::date`
      : Prisma.sql`d."absenceId" = ANY(${[...scope.ids]}::uuid[])`;
  return Prisma.sql`
    WITH a AS (${absences}),
    live AS (
      SELECT a."id" AS "absenceId", a."userId" AS "absentTeacherId", cl."id" AS "lessonId"
        FROM a
        JOIN "CalendarLessonTeachers" t ON t."teacherId" = a."userId"
        JOIN "CalendarLessons" cl ON cl."id" = t."calendarLessonId"
       WHERE cl."status" IN ('SCHEDULED', 'CANCELLED', 'COMPLETED')
         AND cl."startsAt" < a."endsAt" AND cl."endsAt" > a."startsAt"
         ${liveDates}
    ),
    dec AS (
      SELECT d."id" AS "decisionId", d."absenceId", d."absentTeacherId", d."calendarLessonId" AS "lessonId",
             d."decision", d."decidedAt", d."removedTeachers"
        FROM "TeacherAbsenceCovers" d
        JOIN "TeacherAbsences" ta ON ta."id" = d."absenceId" AND ta."status" = 'ACTIVE'
        JOIN "CalendarLessons" cl ON cl."id" = d."calendarLessonId"
       WHERE ${decisionScope}
    ),
    k AS (
      SELECT COALESCE(live."absenceId", dec."absenceId") AS "absenceId",
             COALESCE(live."absentTeacherId", dec."absentTeacherId") AS "absentTeacherId",
             COALESCE(live."lessonId", dec."lessonId") AS "lessonId",
             (live."lessonId" IS NOT NULL) AS "isLive",
             dec."decisionId", dec."decision", dec."decidedAt", dec."removedTeachers"
        FROM live FULL JOIN dec ON dec."absenceId" = live."absenceId" AND dec."lessonId" = live."lessonId"
    )
    SELECT k."absenceId", k."absentTeacherId", k."lessonId", k."isLive", k."decisionId", k."decision", k."decidedAt",
           k."removedTeachers",
           to_char(cl."date", 'YYYY-MM-DD') AS "date", cl."startsAt", cl."endsAt", cl."subjectId", cl."studentGroupId",
           cl."roomId", cl."status" AS "lessonStatus", cl."cancelCause",
           ta."startsAt" AS "absenceStartsAt", ta."endsAt" AS "absenceEndsAt", ta."status" AS "absenceStatus",
           (SELECT json_agg(json_build_object('teacherId', t."teacherId", 'role', t."role") ORDER BY t."role", t."teacherId")
              FROM "CalendarLessonTeachers" t WHERE t."calendarLessonId" = cl."id") AS "teachers",
           ARRAY(SELECT x."studentGroupId" FROM "CalendarLessonGroups" x WHERE x."calendarLessonId" = cl."id" ORDER BY 1)
             AS "extraGroupIds",
           ARRAY(SELECT t."teacherId" FROM "CalendarLessonTeachers" t
                  WHERE t."calendarLessonId" = cl."id" AND t."role" = 'SUBSTITUTE' AND t."teacherId" <> k."absentTeacherId"
                    AND NOT EXISTS (SELECT 1 FROM "TeacherAbsences" o
                                     WHERE o."userId" = t."teacherId" AND o."status" = 'ACTIVE'
                                       AND o."startsAt" < cl."endsAt" AND o."endsAt" > cl."startsAt")
                  ORDER BY 1) AS "coveringSubstituteIds"
      FROM k
      JOIN "CalendarLessons" cl ON cl."id" = k."lessonId"
      JOIN "TeacherAbsences" ta ON ta."id" = k."absenceId"
     ORDER BY cl."startsAt", cl."id", k."absentTeacherId"
  `;
}
