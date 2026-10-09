import { Prisma } from '@prisma/client';
import type {
  DeliveredAudienceRow,
  DeliveredBucket,
  DeliveredDateRow,
  DeliveredHorizonRow,
} from '../common/timplan-delivered';

/*
 * GENOMFÖRD TID, DEFINED ONCE.
 *
 * A CalendarLesson counts as DELIVERED for a pupil if and only if
 *
 *   1. it lies in the past — it has ENDED (endsAt ≤ asOf);
 *   2. it is SCHEDULED or COMPLETED (COMPLETED is nobody's to write today; it
 *      is the stronger statement, and a future "lesson held" mark must not
 *      make delivered minutes vanish);
 *   3. it has at least one CalendarLessonTeachers row — a substitute counts;
 *   4. the pupil is on its roster: its own group, an extra group, or named;
 *   5. its subject counts toward the timplan (Subjects.countsTowardTimplan).
 *
 * Plus the school's credits in scope dated before the school's today
 * (TimplanCredits; src/common/timplan-delivered.ts). Attendance is NEVER
 * subtracted: frånvaro is the pupil's, undervisningstid is the school's offer.
 *
 * The CASE below IS that definition, every other bucket is what the rest of a
 * published lesson became, and no TypeScript re-classifies a row. Rule 4 is
 * the one rule not in SQL: the statements return each lesson's audience, and
 * the pure module puts a pupil on it (home class and teaching groups).
 *
 *   DELIVERED                  past, SCHEDULED/COMPLETED, a teacher row
 *   TEACHERLESS                past, SCHEDULED/COMPLETED, no teacher row — lost
 *   CANCELLED_<cause>          past, CANCELLED, by CalendarLessons.cancelCause
 *                              (TEACHER_UNAVAILABLE, ROOM_UNAVAILABLE, MANUAL;
 *                              UNKNOWN when none was recorded) — lost
 *   CANCELLED_ON_BREAK         past, CANCELLED, on a day a SchoolBreak covers
 *                              for its group (a lov entered after publish left
 *                              publish's cancelled rows standing) — NOT lost
 *   OTHER                      past, RESCHEDULED (nothing writes it) — lost
 *   AHEAD / AHEAD_TEACHERLESS / AHEAD_CANCELLED / AHEAD_CANCELLED_ON_BREAK /
 *   AHEAD_OTHER                not yet ended, by the same tests — the break test
 *                              too, so a cancelled row on a lov reads the same
 *                              (not lost, not projected) before its day and
 *                              after it
 *
 * The break test is publish's breakCoversGroup in SQL: a whole-school break
 * covers every group, a spanned one a group whose gradeLevel is inside it.
 *
 * THE TEACHER TEST is a correlated EXISTS on CalendarLessonTeachers' unique
 * index led by calendarLessonId: one index probe per row. The alternative,
 * cl."id" IN (SELECT "calendarLessonId" …), plans as a hashed SubPlan over the
 * school's whole teacher table; scripts/bench/timplan-delivered.ts measures
 * both (the commit records which won and by how much).
 *
 * THE STATEMENTS, in the order readDeliveredRows runs them: C (each master
 * lesson's horizon, and the year's published range — when nothing is
 * published, nothing else is asked), A+B (minutes per owner, subject, bucket
 * and audience) and D (delivered minutes on credit and break days).
 *
 * Every statement runs in the caller's withRls transaction: a teacher's
 * figures come from the rows the staff arms show a teacher, which are the
 * admin's. No new index: StudentGroups(academicYearId) → CalendarLessons
 * (studentGroupId, date) → the unique indexes led by calendarLessonId.
 */

export interface DeliveredWindow {
  academicYearId: string;
  yearStart: string;
  yearEnd: string;
  /** The instant "past" is measured at. */
  asOf: Date;
}

/** The classification, as a CTE body; see the header. */
export function deliveredLessons(window: DeliveredWindow): Prisma.Sql {
  const { academicYearId, yearStart, yearEnd, asOf } = window;
  // Asked only of a CANCELLED row, past or ahead: one test, written once.
  const onBreak = Prisma.sql`EXISTS (
                      SELECT 1 FROM "SchoolBreaks" b
                       WHERE b."academicYearId" = ${academicYearId}::uuid
                         AND cl."date" BETWEEN b."startDate" AND b."endDate"
                         AND ((b."minGradeLevel" IS NULL AND b."maxGradeLevel" IS NULL)
                              OR (g."gradeLevel" IS NOT NULL
                                  AND (b."minGradeLevel" IS NULL OR g."gradeLevel" >= b."minGradeLevel")
                                  AND (b."maxGradeLevel" IS NULL OR g."gradeLevel" <= b."maxGradeLevel"))))`;
  return Prisma.sql`
    SELECT cl."id", cl."studentGroupId", cl."subjectId", cl."date", cl."masterLessonId",
           round(EXTRACT(EPOCH FROM (cl."endsAt" - cl."startsAt")) / 60)::int AS "minutes",
           CASE
             WHEN cl."endsAt" > ${asOf}::timestamptz THEN
               CASE WHEN cl."status" IN ('SCHEDULED', 'COMPLETED') THEN
                      CASE WHEN EXISTS (SELECT 1 FROM "CalendarLessonTeachers" t WHERE t."calendarLessonId" = cl."id")
                           THEN 'AHEAD' ELSE 'AHEAD_TEACHERLESS' END
                    WHEN cl."status" = 'CANCELLED' THEN
                      CASE WHEN ${onBreak} THEN 'AHEAD_CANCELLED_ON_BREAK' ELSE 'AHEAD_CANCELLED' END
                    ELSE 'AHEAD_OTHER' END
             WHEN cl."status" IN ('SCHEDULED', 'COMPLETED') THEN
               CASE WHEN EXISTS (SELECT 1 FROM "CalendarLessonTeachers" t WHERE t."calendarLessonId" = cl."id")
                    THEN 'DELIVERED' ELSE 'TEACHERLESS' END
             WHEN cl."status" = 'CANCELLED' THEN
               CASE WHEN ${onBreak}
                    THEN 'CANCELLED_ON_BREAK'
                    ELSE 'CANCELLED_' || COALESCE(cl."cancelCause"::text, 'UNKNOWN') END
             ELSE 'OTHER'
           END AS "bucket",
           ARRAY(SELECT x."studentGroupId" FROM "CalendarLessonGroups" x
                  WHERE x."calendarLessonId" = cl."id" ORDER BY 1) AS "extraGroupIds",
           ARRAY(SELECT p."studentId" FROM "CalendarLessonStudents" p
                  WHERE p."calendarLessonId" = cl."id" ORDER BY 1) AS "studentIds"
      FROM "CalendarLessons" cl
      JOIN "StudentGroups" g ON g."id" = cl."studentGroupId"
      JOIN "Subjects" s ON s."id" = cl."subjectId"
     WHERE g."academicYearId" = ${academicYearId}::uuid
       AND s."countsTowardTimplan"
       AND cl."date" BETWEEN ${yearStart}::date AND ${yearEnd}::date
  `;
}

/**
 * A + B: minutes and lessons per (owner, subject, bucket, audience). An
 * unshared lesson's audience is two empty arrays, so every unshared lesson of
 * a group, subject and bucket is ONE row (statement A of the spec); a shared
 * one is one row per distinct audience whatever the share (statement B, R5):
 * a weekly combined lesson repeats its audience some 38 times and collapses to
 * one row here. One scan of the classification serves both.
 */
export function audienceStatement(window: DeliveredWindow): Prisma.Sql {
  return Prisma.sql`
    WITH l AS (${deliveredLessons(window)})
    SELECT "studentGroupId", "subjectId", "bucket", "extraGroupIds", "studentIds",
           SUM("minutes")::int AS "minutes", COUNT(*)::int AS "lessons"
      FROM l
     GROUP BY 1, 2, 3, 4, 5
  `;
}

/**
 * C: per master lesson, how many of its rows have not ended, and its first and
 * last dated row (every status and subject — a row occupies its date whatever
 * became of it): the per-lesson horizon the projection walks from (R1). The
 * same scan's grand total (GROUPING SETS' empty set, "total" = 1 and no
 * "day") is the year's published range — its first and last dated row of any
 * kind, rows without a master lesson included — and its (date) set ("total" =
 * 1 and a "day") is every date holding a row, from which the module finds the
 * gaps two publishes left; so one statement answers all three. A year with no
 * row at all answers the total row with nulls.
 */
export function horizonStatement(window: DeliveredWindow): Prisma.Sql {
  const { academicYearId, yearStart, yearEnd, asOf } = window;
  return Prisma.sql`
    SELECT cl."masterLessonId",
           GROUPING(cl."masterLessonId")::int AS "total",
           (CASE WHEN GROUPING(cl."date") = 0 THEN cl."date"::text END) AS "day",
           (COUNT(*) FILTER (WHERE cl."endsAt" > ${asOf}::timestamptz))::int AS "aheadRows",
           MIN(cl."date")::text AS "firstDate",
           MAX(cl."date")::text AS "lastDate"
      FROM "CalendarLessons" cl
      JOIN "StudentGroups" g ON g."id" = cl."studentGroupId"
     WHERE g."academicYearId" = ${academicYearId}::uuid
       AND cl."date" BETWEEN ${yearStart}::date AND ${yearEnd}::date
     GROUP BY GROUPING SETS ((cl."masterLessonId"), (cl."date"), ())
  `;
}

/**
 * D: DELIVERED minutes per (owner group, date), for the given dates only —
 * credit dates (a credit on a day that still has delivered lessons, R6) and
 * break days (a delivered row on a lov, R13). Skipped when there are none.
 */
export function datesStatement(window: DeliveredWindow, dates: string[]): Prisma.Sql {
  return Prisma.sql`
    WITH l AS (${deliveredLessons(window)})
    SELECT "studentGroupId", "date"::text AS "date", SUM("minutes")::int AS "minutes"
      FROM l
     WHERE "bucket" = 'DELIVERED' AND "date" = ANY(${dates}::date[])
     GROUP BY 1, 2
  `;
}

/** What the statements read back, typed for the pure module. */
export interface DeliveredRows {
  audiences: DeliveredAudienceRow[];
  horizon: DeliveredHorizonRow[];
  published: { from: string; through: string } | null;
  /** Every date holding a row, sorted. */
  publishedDays: string[];
  dates: DeliveredDateRow[];
}

/** Runs the statements one after another in the caller's transaction. */
export async function readDeliveredRows(
  tx: Prisma.TransactionClient,
  window: DeliveredWindow,
  dates: string[],
): Promise<DeliveredRows> {
  const spans = await tx.$queryRaw<
    { masterLessonId: string | null; total: number; day?: string | null; aheadRows: number; firstDate: string | null; lastDate: string | null }[]
  >(horizonStatement(window));
  const total = spans.find((row) => row.total === 1 && (row.day ?? null) === null);
  if (!total || total.firstDate === null || total.lastDate === null) {
    return { audiences: [], horizon: [], published: null, publishedDays: [], dates: [] };
  }
  const publishedDays = spans
    .filter((row) => row.total === 1 && (row.day ?? null) !== null)
    .map((row) => row.day!)
    .sort();
  const horizon: DeliveredHorizonRow[] = spans
    .filter((row) => row.total === 0 && row.masterLessonId !== null)
    .map((row) => ({
      masterLessonId: row.masterLessonId!,
      aheadRows: row.aheadRows,
      firstDate: row.firstDate!,
      lastDate: row.lastDate!,
    }));
  const audiences = await tx.$queryRaw<
    { studentGroupId: string; subjectId: string; bucket: string; extraGroupIds: string[]; studentIds: string[]; minutes: number; lessons: number }[]
  >(audienceStatement(window));
  const byDate =
    dates.length === 0 ? [] : await tx.$queryRaw<DeliveredDateRow[]>(datesStatement(window, dates));
  return {
    audiences: audiences.map((row) => ({ ...row, bucket: row.bucket as DeliveredBucket })),
    horizon,
    published: { from: total.firstDate, through: total.lastDate },
    publishedDays,
    dates: byDate,
  };
}
