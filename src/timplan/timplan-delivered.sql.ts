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

/**
 * What a caller other than the timplan coverage needs from the ONE
 * classification. The default — every field absent — is P3's statement byte
 * for byte (pinned in timplan-delivered.sql.spec.ts), so the coverage is
 * unchanged by the options existing. They decide only WHICH rows the CASE is
 * asked about and which audience columns come back; the CASE itself, rules
 * 1–3, has no option:
 *
 *   subjects  'timplan' (rule 5: Subjects.countsTowardTimplan) or 'all'. The
 *             staffing reconciliation takes every subject, because a
 *             teacher's mentorstid or läxhjälp is their teaching even when it
 *             counts toward no pupil's timplan, and the planned load has
 *             always included every subject. Rules 4–5 decide whose timplan a
 *             lesson counts toward; they are no part of whether it was HELD.
 *   audience  'full' (both arrays, for rule 4), 'groups' (the extra groups
 *             only: who the lesson was for, as staffing credits a samläst
 *             lesson, without a subquery per lesson for its named pupils) or
 *             'none'.
 *   range     [from, to] inside the year instead of the whole year.
 */
export interface DeliveredOptions {
  subjects?: 'timplan' | 'all';
  audience?: 'full' | 'groups' | 'none';
  range?: { from: string; to: string };
}

/** The classification, as a CTE body; see the header. */
export function deliveredLessons(window: DeliveredWindow, options: DeliveredOptions = {}): Prisma.Sql {
  const { academicYearId, yearStart, yearEnd, asOf } = window;
  const from = options.range?.from ?? yearStart;
  const to = options.range?.to ?? yearEnd;
  const audience = options.audience ?? 'full';
  const extraGroups =
    audience === 'none'
      ? Prisma.sql`'{}'::uuid[] AS "extraGroupIds"`
      : Prisma.sql`ARRAY(SELECT x."studentGroupId" FROM "CalendarLessonGroups" x
                  WHERE x."calendarLessonId" = cl."id" ORDER BY 1) AS "extraGroupIds"`;
  const students =
    audience === 'full'
      ? Prisma.sql`ARRAY(SELECT p."studentId" FROM "CalendarLessonStudents" p
                  WHERE p."calendarLessonId" = cl."id" ORDER BY 1) AS "studentIds"`
      : Prisma.sql`'{}'::uuid[] AS "studentIds"`;
  // Rule 5, or every subject. The default spells the line P3 wrote.
  const counted = options.subjects === 'all' ? Prisma.sql`AND TRUE` : Prisma.sql`AND s."countsTowardTimplan"`;
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
           ${extraGroups},
           ${students}
      FROM "CalendarLessons" cl
      JOIN "StudentGroups" g ON g."id" = cl."studentGroupId"
      JOIN "Subjects" s ON s."id" = cl."subjectId"
     WHERE g."academicYearId" = ${academicYearId}::uuid
       ${counted}
       AND cl."date" BETWEEN ${from}::date AND ${to}::date
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
 * A + B cut at the dates a pupil changed class (timplan P4's stage totals):
 * the same CTE, byte for byte, and one more grouping column, "segment" — the
 * number of `boundaries` (sorted, distinct) on or before the lesson's date,
 * width_bucket's answer. A pupil who moved 7A → 7B on 2 November reads 7A's
 * rows of segment 0 and 7B's of segment 1, from one scan of the year,
 * whatever the number of moves. With no boundary every row is segment 0 and
 * the statement is audienceStatement's plus a constant.
 */
export function segmentedAudienceStatement(window: DeliveredWindow, boundaries: string[]): Prisma.Sql {
  const segment =
    boundaries.length === 0
      ? Prisma.sql`0`
      : Prisma.sql`width_bucket("date", ${boundaries}::date[])`;
  return Prisma.sql`
    WITH l AS (${deliveredLessons(window)})
    SELECT "studentGroupId", "subjectId", "bucket", "extraGroupIds", "studentIds",
           ${segment}::int AS "segment",
           SUM("minutes")::int AS "minutes", COUNT(*)::int AS "lessons"
      FROM l
     GROUP BY 1, 2, 3, 4, 5, 6
  `;
}

/** An A + B row with the segment its lessons fall in. */
export type SegmentedAudienceRow = DeliveredAudienceRow & { segment: number };

/**
 * readDeliveredRows with the audiences cut at `boundaries`
 * (segmentedAudienceStatement). The same statements in the same order; C
 * first, and nothing else when nothing is published.
 */
export async function readSegmentedDeliveredRows(
  tx: Prisma.TransactionClient,
  window: DeliveredWindow,
  dates: string[],
  boundaries: string[],
  key: PublishedKey | null = null,
): Promise<Omit<DeliveredRows, 'audiences'> & { audiences: SegmentedAudienceRow[] }> {
  const { horizon, published, publishedDays } = await readPublishedSpans(tx, window, key);
  if (published === null) {
    return { audiences: [], horizon: [], published: null, publishedDays: [], dates: [] };
  }
  const audiences = await tx.$queryRaw<
    { studentGroupId: string; subjectId: string; bucket: string; extraGroupIds: string[]; studentIds: string[]; segment: number; minutes: number; lessons: number }[]
  >(segmentedAudienceStatement(window, boundaries));
  const byDate =
    dates.length === 0 ? [] : await tx.$queryRaw<DeliveredDateRow[]>(datesStatement(window, dates));
  return {
    audiences: audiences.map((row) => ({ ...row, bucket: row.bucket as DeliveredBucket })),
    horizon,
    published,
    publishedDays,
    dates: byDate,
  };
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
export function horizonStatement(window: DeliveredWindow, published: PublishedKey | null = null): Prisma.Sql {
  const { academicYearId, yearStart, yearEnd, asOf } = window;
  if (published !== null) return publishedHorizonStatement(window);
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
 * READ IN A DRAFT SCHOOL BY SOMEBODY WHO MUST NOT SEE THE DRAFT (Publicering,
 * 20261011100000): the statements keyed on a lesson's master lesson key it on
 * the PUBLISHED key, coalesce(cl."masterLessonId", ppr."masterLessonId"). A
 * lesson deleted in the draft has had its key set to null by the foreign key,
 * and PublicationPendingRemovals remembers whose it was until a publish
 * settles it; without the coalesce the deleted master — still in the
 * published snapshot a teacher reads — would have no horizon row and its
 * orphaned rows would count twice, so a draft delete would move a teacher's
 * figure before anything was published. `publicationId` is the snapshot the
 * reader was shown (published-grundschema.ts). Null — every DIRECT school,
 * and every admin — is the default statement, byte for byte.
 */
export interface PublishedKey {
  publicationId: string | null;
}

/** C, keyed on the published key. */
function publishedHorizonStatement(window: DeliveredWindow): Prisma.Sql {
  const { academicYearId, yearStart, yearEnd, asOf } = window;
  return Prisma.sql`
    WITH k AS (
      SELECT coalesce(cl."masterLessonId", ppr."masterLessonId") AS "masterLessonId", cl."date", cl."endsAt"
        FROM "CalendarLessons" cl
        JOIN "StudentGroups" g ON g."id" = cl."studentGroupId"
        LEFT JOIN "PublicationPendingRemovals" ppr ON ppr."calendarLessonId" = cl."id"
       WHERE g."academicYearId" = ${academicYearId}::uuid
         AND cl."date" BETWEEN ${yearStart}::date AND ${yearEnd}::date
    )
    SELECT k."masterLessonId",
           GROUPING(k."masterLessonId")::int AS "total",
           (CASE WHEN GROUPING(k."date") = 0 THEN k."date"::text END) AS "day",
           (COUNT(*) FILTER (WHERE k."endsAt" > ${asOf}::timestamptz))::int AS "aheadRows",
           MIN(k."date")::text AS "firstDate",
           MAX(k."date")::text AS "lastDate"
      FROM k
     GROUP BY GROUPING SETS ((k."masterLessonId"), (k."date"), ())
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

/**
 * E: the staffing reconciliation's crediting statement — who taught the held
 * lessons of a range, read off the ONE classification above with every
 * subject and the extra groups (deliveredLessons' options), never re-deciding
 * what "held" means. Three parts over one MATERIALIZED scan:
 *
 *   'T'  per teacher row of a lesson: (teacher, role, subject, owner group,
 *        extra groups, bucket) with minutes and lessons. On a lesson that
 *        carries a SUBSTITUTE row, a LEAD or ASSISTANT row beside it is
 *        DISPLACED rather than DELIVERED: the vikarie stood in front of the
 *        class, and the other row is what a master lesson's teacher change
 *        re-created on top of an assigned vikarie (calendar data written before
 *        master-lessons.service stopped doing so). Nobody is credited for it;
 *        the reconciliation counts it for the admin's notice. The same row on
 *        a lesson NOT held — cancelled, ahead, on a lov — is
 *        DISPLACED_NOT_HELD: the vikarie carries that lesson's lost or coming
 *        minutes, and the row beside them must not carry them a second time
 *        (the bortfall per teacher would otherwise be twice the group's).
 *   'C'  covered by others: per grundschema slot (the master lesson's CURRENT
 *        lead and co-teacher) the DELIVERED minutes of its lessons that a
 *        substitute other than that person took.
 *   'G'  admin only: every lesson once, per owner group, subject and lost
 *        bucket — the bortfall per group, whoever was or was not there.
 *
 * `own` narrows T and C to one teacher (a TEACHER's own row) and drops G. The
 * teacher test of the CASE stays its correlated EXISTS; the rows here are
 * found by the (calendarLessonId, teacherId) unique index.
 */
export function staffingCreditStatement(
  window: DeliveredWindow,
  range: { from: string; to: string },
  own: string | null,
  published: PublishedKey | null = null,
): Prisma.Sql {
  const lessons = deliveredLessons(window, { subjects: 'all', audience: 'groups', range });
  const ownTeacher = own === null ? Prisma.empty : Prisma.sql`WHERE t."teacherId" = ${own}::uuid`;
  const ownSlot = own === null ? Prisma.empty : Prisma.sql`AND s."person" = ${own}::uuid`;
  const groups =
    own === null
      ? Prisma.sql`
    UNION ALL
    SELECT 'G' AS "kind", NULL::uuid, NULL::text, l."subjectId", l."studentGroupId", NULL::uuid[], l."bucket",
           SUM(l."minutes")::int, COUNT(*)::int
      FROM l
     WHERE l."bucket" IN ('TEACHERLESS', 'CANCELLED_TEACHER_UNAVAILABLE', 'CANCELLED_ROOM_UNAVAILABLE',
                          'CANCELLED_MANUAL', 'CANCELLED_EVENT', 'CANCELLED_UNKNOWN', 'OTHER')
     GROUP BY 4, 5, 7`
      : Prisma.empty;
  // The grundschema slot a substitute covered: the master lesson's, or — read
  // by a teacher in a DRAFT school — the published snapshot's, on the
  // published key (see PublishedKey).
  const slotSource =
    published === null
      ? Prisma.sql`JOIN "MasterLessons" m ON m."id" = l."masterLessonId"`
      : Prisma.sql`LEFT JOIN "PublicationPendingRemovals" ppr ON ppr."calendarLessonId" = l."id"
      JOIN "PublishedLessons" m ON m."publicationId" = ${published.publicationId}::uuid
                               AND m."masterLessonId" = coalesce(l."masterLessonId", ppr."masterLessonId")`;
  return Prisma.sql`
    WITH l AS MATERIALIZED (${lessons})
    SELECT 'T' AS "kind", t."teacherId" AS "personId", t."role"::text AS "role", l."subjectId", l."studentGroupId",
           l."extraGroupIds",
           CASE WHEN t."role" <> 'SUBSTITUTE'
                     AND EXISTS (SELECT 1 FROM "CalendarLessonTeachers" x
                                  WHERE x."calendarLessonId" = l."id" AND x."role" = 'SUBSTITUTE')
                THEN CASE WHEN l."bucket" = 'DELIVERED' THEN 'DISPLACED' ELSE 'DISPLACED_NOT_HELD' END
                ELSE l."bucket" END AS "bucket",
           SUM(l."minutes")::int AS "minutes", COUNT(*)::int AS "lessons"
      FROM l JOIN "CalendarLessonTeachers" t ON t."calendarLessonId" = l."id"
     ${ownTeacher}
     GROUP BY 2, 3, 4, 5, 6, 7
    UNION ALL
    SELECT 'C', s."person", s."slot", l."subjectId", l."studentGroupId", l."extraGroupIds", l."bucket",
           SUM(l."minutes")::int, COUNT(*)::int
      FROM l ${slotSource}
     CROSS JOIN LATERAL (VALUES (m."teacherId", 'LEAD'), (m."coTeacherId", 'ASSISTANT')) AS s("person", "slot")
     WHERE l."bucket" = 'DELIVERED' AND s."person" IS NOT NULL
       AND EXISTS (SELECT 1 FROM "CalendarLessonTeachers" x
                    WHERE x."calendarLessonId" = l."id" AND x."role" = 'SUBSTITUTE' AND x."teacherId" <> s."person")
       ${ownSlot}
     GROUP BY 2, 3, 4, 5, 6, 7${groups}
  `;
}

/** One row of statement E, as the pure reconciliation reads it. */
export interface StaffingCreditRow {
  kind: 'T' | 'C' | 'G';
  /** The teacher (T), the grundschema slot's person (C), null (G). */
  personId: string | null;
  /** LEAD / ASSISTANT / SUBSTITUTE (T), LEAD / ASSISTANT (C), null (G). */
  role: string | null;
  subjectId: string;
  studentGroupId: string;
  extraGroupIds: string[] | null;
  /** A DeliveredBucket, or DISPLACED / DISPLACED_NOT_HELD (T only). */
  bucket: string;
  minutes: number;
  lessons: number;
}

/**
 * C alone: the year's published range (its first and last dated row of any
 * kind), every date holding a row, and each master lesson's horizon. What
 * readDeliveredRows asks first, and all the staffing reconciliation needs of
 * it. Null `published` = nothing published.
 */
export async function readPublishedSpans(
  tx: Prisma.TransactionClient,
  window: DeliveredWindow,
  published: PublishedKey | null = null,
): Promise<Pick<DeliveredRows, 'horizon' | 'published' | 'publishedDays'>> {
  const spans = await tx.$queryRaw<
    { masterLessonId: string | null; total: number; day?: string | null; aheadRows: number; firstDate: string | null; lastDate: string | null }[]
  >(horizonStatement(window, published));
  const total = spans.find((row) => row.total === 1 && (row.day ?? null) === null);
  if (!total || total.firstDate === null || total.lastDate === null) {
    return { horizon: [], published: null, publishedDays: [] };
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
  return { horizon, published: { from: total.firstDate, through: total.lastDate }, publishedDays };
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
  key: PublishedKey | null = null,
): Promise<DeliveredRows> {
  const { horizon, published, publishedDays } = await readPublishedSpans(tx, window, key);
  if (published === null) {
    return { audiences: [], horizon: [], published: null, publishedDays: [], dates: [] };
  }
  const audiences = await tx.$queryRaw<
    { studentGroupId: string; subjectId: string; bucket: string; extraGroupIds: string[]; studentIds: string[]; minutes: number; lessons: number }[]
  >(audienceStatement(window));
  const byDate =
    dates.length === 0 ? [] : await tx.$queryRaw<DeliveredDateRow[]>(datesStatement(window, dates));
  return {
    audiences: audiences.map((row) => ({ ...row, bucket: row.bucket as DeliveredBucket })),
    horizon,
    published,
    publishedDays,
    dates: byDate,
  };
}
