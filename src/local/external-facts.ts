import type { PrismaClient } from '@prisma/client';
import type { LoanRow } from '../room-bookings/loan-holds';
import type { ClosureLike, HeldSpan } from './external-conflicts';
import type { BreakLike, FrameLike } from './school-time';
import { minutesOfClock } from './school-time';

/*
 * WHAT A SERIES IS CHECKED AGAINST, READ IN TWO STATEMENTS.
 *
 * The conflict rules are pure (external-conflicts.ts); what they need is read here. A school
 * registers its associations one series at a time, and a term for forty rooms is forty of them in
 * a row, each a transaction of its own, so what a series costs is mostly round trips: the nineteen
 * statements the Prisma models would take (the school, its frames, its lov, the room, the lessons
 * with their subjects and groups, the bookings, the closures, the activities, the loans ...) were
 * 300 ms a series on a loaded machine, the two below are a tenth of that.
 *
 *   statics  the school's zone, ramtider and lov, the room or resource, and the loans of the room:
 *            small, whatever the size of the school;
 *   facts    what holds the room or the resource inside the days of the series and nowhere else:
 *            the lessons, bookings, closures and activity lessons (a room), or the bookings (a
 *            resource), found by joining the days to the room's own index, so a term of a full
 *            school reads a handful of rows and not the room's whole schedule.
 *
 * Both are read under the administrator's row security, as the Prisma models were.
 */

export interface Statics {
  timeZone: string;
  frames: FrameLike[];
  breaks: BreakLike[];
  room: { id: string; name: string; years: { min: number | null; max: number | null } } | null;
  resource: { id: string; name: string; quantity: number } | null;
  loans: LoanRow[];
}

interface StaticsRow {
  timezone: string | null;
  frames: Array<{ min: number; max: number; day: number | null; start: string; end: string }>;
  breaks: Array<{ kind: 'HOLIDAY' | 'STAFF_DAY'; from: string; to: string; min: number | null; max: number | null }>;
  room: { id: string; name: string; min: number | null; max: number | null } | null;
  resource: { id: string; name: string; quantity: number } | null;
  loans: LoanRow[];
}

export async function readStatics(
  tx: PrismaClient,
  target: { roomId: string | null; resourceId: string | null },
  from: string,
  to: string,
): Promise<Statics> {
  const [row] = await tx.$queryRaw<StaticsRow[]>`
    SELECT
      (SELECT s."timezone" FROM "Schools" s LIMIT 1) AS "timezone",
      (SELECT coalesce(json_agg(json_build_object('min', f."minGradeLevel", 'max', f."maxGradeLevel", 'day', f."dayOfWeek",
                                                  'start', to_char(f."startTime", 'HH24:MI'), 'end', to_char(f."endTime", 'HH24:MI'))), '[]'::json)
         FROM "FrameTimes" f) AS "frames",
      (SELECT coalesce(json_agg(json_build_object('kind', b."kind", 'from', to_char(b."startDate", 'YYYY-MM-DD'), 'to', to_char(b."endDate", 'YYYY-MM-DD'),
                                                  'min', b."minGradeLevel", 'max', b."maxGradeLevel")), '[]'::json)
         FROM "SchoolBreaks" b WHERE b."startDate" <= ${to}::date AND b."endDate" >= ${from}::date) AS "breaks",
      (SELECT row_to_json(r) FROM (SELECT x."id", x."name", x."minGradeLevel" AS "min", x."maxGradeLevel" AS "max"
                                     FROM "Rooms" x WHERE x."id" = ${target.roomId}::uuid) r) AS "room",
      (SELECT row_to_json(r) FROM (SELECT x."id", x."name", x."quantity" FROM "Resources" x WHERE x."id" = ${target.resourceId}::uuid) r) AS "resource",
      (SELECT coalesce(json_agg(json_build_object('status', l."status", 'roomId', l."roomId", 'localRoomId', l."localRoomId", 'dayOfWeek', l."dayOfWeek",
                                                  'startTime', to_char(l."startTime", 'HH24:MI'), 'endTime', to_char(l."endTime", 'HH24:MI'),
                                                  'startDate', to_char(l."startDate", 'YYYY-MM-DD'), 'endDate', to_char(l."endDate", 'YYYY-MM-DD'))), '[]'::json)
         FROM "RoomLoans" l WHERE l."roomId" = ${target.roomId}::uuid OR l."localRoomId" = ${target.roomId}::uuid) AS "loans"`;
  return {
    timeZone: row?.timezone ?? 'Europe/Stockholm',
    frames: (row?.frames ?? []).map((frame) => ({
      minGradeLevel: frame.min,
      maxGradeLevel: frame.max,
      dayOfWeek: frame.day,
      start: minutesOfClock(frame.start),
      end: minutesOfClock(frame.end),
    })),
    breaks: (row?.breaks ?? []).map((entry) => ({ kind: entry.kind, startDate: entry.from, endDate: entry.to, minGradeLevel: entry.min, maxGradeLevel: entry.max })),
    room: row?.room ? { id: row.room.id, name: row.room.name, years: { min: row.room.min, max: row.room.max } } : null,
    resource: row?.resource ?? null,
    loans: row?.loans ?? [],
  };
}

export interface RoomFactRows {
  lessons: HeldSpan[];
  bookings: HeldSpan[];
  activities: HeldSpan[];
  closures: ClosureLike[];
}

interface FactRow {
  kind: 'LESSON' | 'BOOKING' | 'ACTIVITY' | 'CLOSED';
  startsAt: Date | null;
  endsAt: Date | null;
  label: string | null;
  date: string | null;
  dow: number | null;
  smin: number | null;
  emin: number | null;
}

/** What holds a room at any of the given spans: lessons that hold their time, active bookings, closures, and activity lessons. */
export async function readRoomFacts(
  tx: PrismaClient,
  roomId: string,
  spans: ReadonlyArray<{ startsAt: Date; endsAt: Date }>,
  from: string,
  to: string,
): Promise<RoomFactRows> {
  const starts = spans.map((span) => span.startsAt.toISOString());
  const ends = spans.map((span) => span.endsAt.toISOString());
  const rows = await tx.$queryRaw<FactRow[]>`
    WITH occ AS (SELECT t.s, t.e FROM unnest(${starts}::timestamptz[], ${ends}::timestamptz[]) AS t(s, e))
    SELECT 'LESSON' AS "kind", l."startsAt", l."endsAt", btrim(coalesce(sub."name", '') || ' ' || coalesce(g."name", '')) AS "label",
           NULL::text AS "date", NULL::int AS "dow", NULL::int AS "smin", NULL::int AS "emin"
      FROM occ
      CROSS JOIN LATERAL (
        SELECT x."startsAt", x."endsAt", x."subjectId", x."studentGroupId", x."schoolId" FROM "CalendarLessons" x
         WHERE x."roomId" = ${roomId}::uuid AND x."startsAt" >= occ.s - interval '2 days' AND x."startsAt" < occ.e AND x."endsAt" > occ.s
           AND x."status" IN ('SCHEDULED', 'COMPLETED')
         LIMIT 1000) l
      LEFT JOIN "Subjects" sub ON sub."id" = l."subjectId" AND sub."schoolId" = l."schoolId"
      LEFT JOIN "StudentGroups" g ON g."id" = l."studentGroupId" AND g."schoolId" = l."schoolId"
    UNION ALL
    SELECT 'BOOKING', b."startsAt", b."endsAt", b."title", NULL, NULL, NULL, NULL
      FROM occ
      JOIN "RoomBookings" b ON b."roomId" = ${roomId}::uuid AND b."startsAt" < occ.e AND b."endsAt" > occ.s AND b."status" IN ('PENDING', 'APPROVED')
    UNION ALL
    SELECT 'ACTIVITY', l."startsAt", l."endsAt", coalesce(cb."name", ''), NULL, NULL, NULL, NULL
      FROM "ScheduleActivityLessons" al
      JOIN "ScheduleActivities" a ON a."id" = al."activityId" AND a."schoolId" = al."schoolId" AND a."removedAt" IS NULL
      JOIN "CancellationBatches" cb ON cb."id" = a."batchId" AND cb."schoolId" = a."schoolId"
      JOIN "CalendarLessons" l ON l."id" = al."calendarLessonId" AND l."schoolId" = al."schoolId" AND l."status" = 'SCHEDULED'
      JOIN occ ON l."startsAt" < occ.e AND l."endsAt" > occ.s
    UNION ALL
    SELECT 'CLOSED', NULL, NULL, coalesce(c."reason", ''), to_char(c."date", 'YYYY-MM-DD'), c."dayOfWeek",
           (extract(hour FROM c."startTime") * 60 + extract(minute FROM c."startTime"))::int,
           (extract(hour FROM c."endTime") * 60 + extract(minute FROM c."endTime"))::int
      FROM "AvailabilityConstraints" c
     WHERE c."resourceType" = 'ROOM' AND c."roomId" = ${roomId}::uuid AND c."type" = 'UNAVAILABLE'
       AND (c."date" IS NULL OR (c."date" >= ${from}::date AND c."date" <= ${to}::date))`;
  const held = (kind: FactRow['kind']): HeldSpan[] =>
    rows
      .filter((row) => row.kind === kind)
      .map((row) => ({ start: (row.startsAt as Date).getTime(), end: (row.endsAt as Date).getTime(), label: row.label ?? '' }));
  return {
    lessons: held('LESSON'),
    bookings: held('BOOKING'),
    activities: held('ACTIVITY'),
    closures: rows
      .filter((row) => row.kind === 'CLOSED')
      .map((row) => ({ date: row.date, dayOfWeek: row.dow, start: row.smin ?? 0, end: row.emin ?? 0, reason: row.label ?? '' })),
  };
}

/** What a resource's active bookings hold at any of the given spans. */
export async function readResourceFacts(
  tx: PrismaClient,
  resourceId: string,
  spans: ReadonlyArray<{ startsAt: Date; endsAt: Date }>,
): Promise<Array<{ start: number; end: number; quantity: number }>> {
  const starts = spans.map((span) => span.startsAt.toISOString());
  const ends = spans.map((span) => span.endsAt.toISOString());
  const rows = await tx.$queryRaw<Array<{ startsAt: Date; endsAt: Date; quantity: number }>>`
    WITH occ AS (SELECT t.s, t.e FROM unnest(${starts}::timestamptz[], ${ends}::timestamptz[]) AS t(s, e))
    SELECT DISTINCT b."id", b."startsAt", b."endsAt", b."quantity"
      FROM occ
      JOIN "ResourceBookings" b ON b."resourceId" = ${resourceId}::uuid AND b."startsAt" < occ.e AND b."endsAt" > occ.s AND b."status" IN ('PENDING', 'APPROVED')`;
  return rows.map((row) => ({ start: row.startsAt.getTime(), end: row.endsAt.getTime(), quantity: row.quantity }));
}

export interface LateLesson {
  startsAt: Date;
  endsAt: Date;
  lesson: string;
}

/**
 * The lessons that hold a room at any of the given spans, read after the days of a series are written: the room is
 * held by us until we commit, so what is found here landed (a publication) between the plan and the writes. Only
 * lessons, and only the room's own index: the check runs once for every series, and the broader read of the clash
 * list (a join to the series and the room) was the largest single cost of registering one. The index is asked from
 * two days before each day: a lesson that began earlier than that and still runs is not found. That holds because
 * the schedule writers make lessons of a few hours (CalendarLessons itself has no CHECK on the length).
 */
export async function readLateLessons(
  tx: PrismaClient,
  roomId: string,
  spans: ReadonlyArray<{ startsAt: Date; endsAt: Date }>,
  limit: number,
): Promise<LateLesson[]> {
  const starts = spans.map((span) => span.startsAt.toISOString());
  const ends = spans.map((span) => span.endsAt.toISOString());
  // One probe of the room's index for each day (a LIMIT keeps the planner from folding the subquery back into a join
  // that reads every lesson of the room and tests it against every day), and nothing but the lessons' own columns:
  // what they are called is asked for only if there is one to name.
  const found = await tx.$queryRaw<Array<{ startsAt: Date; endsAt: Date; subjectId: string | null; studentGroupId: string | null }>>`
    /* late lessons */
    SELECT l."startsAt", l."endsAt", l."subjectId", l."studentGroupId"
      FROM unnest(${starts}::timestamptz[], ${ends}::timestamptz[]) AS t(s, e)
     CROSS JOIN LATERAL (
       SELECT x."startsAt", x."endsAt", x."subjectId", x."studentGroupId" FROM "CalendarLessons" x
        WHERE x."roomId" = ${roomId}::uuid AND x."startsAt" >= t.s - interval '2 days' AND x."startsAt" < t.e AND x."endsAt" > t.s
          AND x."status" IN ('SCHEDULED', 'COMPLETED')
        ORDER BY x."startsAt"
        LIMIT ${limit}) l
     ORDER BY l."startsAt"
     LIMIT ${limit}`;
  if (found.length === 0) return [];
  const subjectIds = [...new Set(found.map((row) => row.subjectId).filter((id): id is string => id !== null))];
  const groupIds = [...new Set(found.map((row) => row.studentGroupId).filter((id): id is string => id !== null))];
  const names = await tx.$queryRaw<Array<{ kind: 'S' | 'G'; id: string; name: string }>>`
    /* late lesson names */
    SELECT 'S' AS "kind", "id", "name" FROM "Subjects" WHERE "id" = ANY(${subjectIds}::uuid[])
    UNION ALL
    SELECT 'G', "id", "name" FROM "StudentGroups" WHERE "id" = ANY(${groupIds}::uuid[])`;
  const nameOf = (kind: 'S' | 'G', id: string | null) => names.find((row) => row.kind === kind && row.id === id)?.name ?? '';
  return found.map((row) => ({
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    lesson: `${nameOf('S', row.subjectId)} ${nameOf('G', row.studentGroupId)}`.trim(),
  }));
}
