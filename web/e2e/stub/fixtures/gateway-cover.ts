import type {
  Absence,
  AbsenceCounts,
  Board,
  BoardItem,
  Candidate,
  Candidates,
  CounterRow,
  CoverDecisionKind,
  CoverPersonKind,
  CoverStatus,
  Hours,
  HoursRow,
  RankReason,
  TeacherRole,
} from "../../../lib/cover-types";
import { Reply, route, type GatewayRoute } from "../gateway-routes";
import { addDays, mondayOf, NOW, stockholmInstant, THIS_MONDAY } from "./calendar";
import {
  ABSENCE_LIST,
  COVER_LESSON_TEACHERS,
  COVER_LESSONS,
  COVER_SETTINGS,
  DECISIONS,
  PLANNED_LESSON_TEACHERS,
  POOL_JOINED,
  POOL_WINDOWS,
  REASON_LIST,
  type StoredAbsence,
} from "./cover-world";
import { SUBSTITUTE_POOL } from "./school-days";
import { byId, GROUP_LIST, MASTER_LESSONS, REQUIREMENTS, SUBJECT_LIST, TEACHER_LIST } from "./world";

/**
 * Vikarieplanering's reads (src/cover/cover.controller.ts): the absence
 * register, the reasons and settings, the board, the counter, the hours, the
 * pool and its windows, and a lesson's candidates.
 *
 * Each is derived from cover-world.ts as the gateway derives it from its
 * tables — an absence paired with every lesson its teacher had inside it, the
 * pair's status from its decision and the clock — so the board, the
 * register's counts, the counter and the hours agree whichever day the suite
 * runs. The clock is the real one, as on the pages.
 */

type CoverLesson = (typeof COVER_LESSONS)[number];
type Span = { startsAt: string; endsAt: string };

const at = (iso: string) => Date.parse(iso);
const overlaps = (a: Span, b: Span) => at(a.startsAt) < at(b.endsAt) && at(a.endsAt) > at(b.startsAt);
const minutesOf = (lesson: Span) => Math.round((at(lesson.endsAt) - at(lesson.startsAt)) / 60_000);
const isAdmin = (person: { role: string } | null) => person?.role === "SCHOOL_ADMIN";

/** Held or holding (cover-context.ts HOLDING): what a substitute is counted for. */
const HOLDING = new Set(["SCHEDULED", "COMPLETED"]);

const teachersOn = (lessonId: string) => COVER_LESSON_TEACHERS.filter((row) => row.calendarLessonId === lessonId);

/** Away then: an ACTIVE absence of theirs overlaps the lesson. */
const awayDuring = (userId: string, span: Span) =>
  ABSENCE_LIST.some((row) => row.status === "ACTIVE" && row.userId === userId && overlaps(row, span));

/** A teacher's own held or holding lessons, as the calendar has them now. */
const lessonsOf = (userId: string) =>
  COVER_LESSON_TEACHERS.filter((row) => row.teacherId === userId)
    .map((row) => byId(COVER_LESSONS, row.calendarLessonId))
    .filter((lesson): lesson is CoverLesson => lesson !== null && HOLDING.has(lesson.status));

// --- The pairs ---------------------------------------------------------------------

/** cover-board.ts deriveStatus. */
function statusOf(
  lesson: CoverLesson,
  decision: CoverDecisionKind | null,
  covered: boolean,
): { status: CoverStatus; stale: boolean } {
  if (lesson.status === "CANCELLED") return { status: "CANCELLED", stale: false };
  if (decision === "SUBSTITUTE") return covered ? { status: "COVERED", stale: false } : { status: "OPEN", stale: true };
  if (decision === "SUPERVISED_STUDY" || decision === "CO_TEACHER") return { status: "HANDLED", stale: false };
  return { status: "OPEN", stale: decision === "CANCELLED" };
}

/** cover-board.ts pairsStatement and toBoardItem: each ACTIVE absence with every lesson its teacher had in it. */
function pairsOf(absences: StoredAbsence[], now: number): BoardItem[] {
  const items: BoardItem[] = [];
  for (const absence of absences) {
    if (absence.status !== "ACTIVE") continue;
    for (const lesson of COVER_LESSONS) {
      const planned = PLANNED_LESSON_TEACHERS.find(
        (row) => row.calendarLessonId === lesson.id && row.teacherId === absence.userId,
      );
      if (!planned || lesson.status === "RESCHEDULED" || !overlaps(lesson, absence)) continue;
      const decision = DECISIONS.find((row) => row.absenceId === absence.id && row.lessonId === lesson.id) ?? null;
      const teachers = teachersOn(lesson.id).map((row) => ({ teacherId: row.teacherId, role: row.role as TeacherRole }));
      // A substitute who is away themself does not cover (the pair is OPEN again).
      const covering = teachers
        .filter((row) => row.role === "SUBSTITUTE" && row.teacherId !== absence.userId && !awayDuring(row.teacherId, lesson))
        .map((row) => row.teacherId)
        .sort();
      const derived = statusOf(lesson, decision?.decision ?? null, covering.length > 0);
      items.push({
        absenceId: absence.id,
        absentTeacherId: absence.userId,
        absentRole: planned.role as TeacherRole,
        lessonId: lesson.id,
        date: lesson.date,
        startsAt: lesson.startsAt,
        endsAt: lesson.endsAt,
        subjectId: lesson.subjectId,
        studentGroupId: lesson.studentGroupId,
        extraGroupIds: byId(MASTER_LESSONS, lesson.masterLessonId)?.extraGroupIds ?? [],
        roomId: lesson.roomId,
        lessonStatus: lesson.status,
        // world.ts's one cancellation is 7A's study visit: an activity the school names.
        cancelCause: lesson.status === "CANCELLED" ? "EVENT" : null,
        teachers,
        substituteId: covering[0] ?? null,
        decision: decision?.decision ?? null,
        decidedAt: decision?.decidedAt ?? null,
        status: derived.status,
        decisionStale: derived.stale,
        passed: at(lesson.endsAt) <= now,
        // Every decision in cover-world.ts is on a lesson inside its absence.
        outsideAbsence: false,
      });
    }
  }
  return items.sort(
    (a, b) =>
      a.startsAt.localeCompare(b.startsAt) ||
      a.lessonId.localeCompare(b.lessonId) ||
      a.absentTeacherId.localeCompare(b.absentTeacherId),
  );
}

/** cover-board.ts summaryOf, which is also an absence's counts. */
function summaryOf(items: BoardItem[]): AbsenceCounts {
  const summary: AbsenceCounts = { open: 0, covered: 0, cancelled: 0, handled: 0, passedOpen: 0 };
  for (const item of items) {
    if (item.status === "OPEN") {
      if (item.passed) summary.passedOpen++;
      else summary.open++;
    } else if (item.status === "COVERED") summary.covered++;
    else if (item.status === "CANCELLED") summary.cancelled++;
    else summary.handled++;
  }
  return summary;
}

// --- The register --------------------------------------------------------------------

/** teacher-absences.service.ts viewOf. */
function viewOf(absence: StoredAbsence, now: number): Absence {
  const { createdById, ...stored } = absence;
  const phase =
    absence.status === "WITHDRAWN"
      ? "WITHDRAWN"
      : at(absence.endsAt) <= now
        ? "ENDED"
        : at(absence.startsAt) <= now
          ? "ONGOING"
          : "PLANNED";
  return { ...stored, phase, selfReported: createdById === absence.userId, counts: summaryOf(pairsOf([absence], now)) };
}

/**
 * teacher-absences.service.ts list: current and coming by default, ended and
 * withdrawn too with includeEnded; `from`/`to` narrow to absences touching
 * those days. RLS gives a teacher their own only.
 */
function absences(query: URLSearchParams, person: { role: string; userId: string } | null): Absence[] {
  const now = Date.parse(NOW);
  const includeEnded = query.get("includeEnded") === "true";
  const from = query.get("from");
  const to = query.get("to");
  const userId = query.get("userId");
  const after = Math.max(includeEnded ? -Infinity : now, from ? at(stockholmInstant(from, "00:00")) : -Infinity);
  const before = to ? at(stockholmInstant(addDays(to, 1), "00:00")) : Infinity;
  return ABSENCE_LIST.filter(
    (row) =>
      (isAdmin(person) || row.userId === person?.userId) &&
      (!userId || row.userId === userId) &&
      (includeEnded || row.status === "ACTIVE") &&
      at(row.endsAt) > after &&
      at(row.startsAt) < before,
  )
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id))
    .map((row) => viewOf(row, now));
}

// --- The board -------------------------------------------------------------------------

/** cover.service.ts board: the pairs of the window's days, and the ACTIVE absences touching it. */
function boardOf(from: string, to: string): Board {
  const now = Date.parse(NOW);
  const days = { startsAt: stockholmInstant(from, "00:00"), endsAt: stockholmInstant(addDays(to, 1), "00:00") };
  const active = ABSENCE_LIST.filter((row) => row.status === "ACTIVE" && overlaps(row, days));
  const items = pairsOf(active, now).filter((item) => item.date >= from && item.date <= to);
  return {
    from,
    to,
    items,
    summary: summaryOf(items),
    absences: active.map(({ id, userId, startsAt, endsAt }) => ({ id, userId, startsAt, endsAt })),
  };
}

// --- The counter and the hours -------------------------------------------------------

/** Every substitute on a held or holding lesson: what the counter and the hours count. */
const COVERS = COVER_LESSON_TEACHERS.filter((row) => row.role === "SUBSTITUTE").flatMap((row) => {
  const lesson = byId(COVER_LESSONS, row.calendarLessonId);
  return lesson && HOLDING.has(lesson.status) ? [{ userId: row.teacherId, lesson }] : [];
});

/**
 * POOL is a pool member without a post (cover-reports.service.ts kinds), a
 * teaching requirement standing in for the post. Eva, the one member, teaches
 * 8A history, so everybody here is STAFF.
 */
const kindOf = (userId: string): CoverPersonKind =>
  SUBSTITUTE_POOL.some((member) => member.userId === userId) &&
  !REQUIREMENTS.some((row) => row.teacherId === userId || row.coTeacherId === userId)
    ? "POOL"
    : "STAFF";

/**
 * The term the counter counts, for the fixture school: begun six weeks
 * before this week and running past it, whatever the date. The gateway's
 * termOf (cover-context.ts) takes the autumn or spring half of the läsår,
 * which in a term's first weeks and in January left Cecilia's cover from
 * four weeks back out of "Termin" — and the cover board's accessibility-tree
 * baseline with it. The school is always mid-term here, as it is always
 * eight weeks into the läsår (timplan-coverage.ts).
 */
function termOf(_date: string): { from: string; to: string } {
  return { from: addDays(THIS_MONDAY, -42), to: addDays(THIS_MONDAY, 84) };
}

/** cover-reports.service.ts counter: covers in the date's ISO week and term, the pool listed with none. */
function counterOn(date: string, now: number): { date: string; rows: CounterRow[] } {
  const week = { from: mondayOf(date), to: addDays(mondayOf(date), 6) };
  const term = termOf(date);
  const rows = new Map<string, CounterRow>();
  const rowOf = (userId: string): CounterRow =>
    rows.get(userId) ?? {
      userId,
      kind: kindOf(userId),
      weekLessons: 0,
      weekMinutes: 0,
      termLessons: 0,
      termMinutes: 0,
      heldTermMinutes: 0,
    };
  for (const { userId, lesson } of COVERS) {
    const inWeek = lesson.date >= week.from && lesson.date <= week.to;
    const inTerm = lesson.date >= term.from && lesson.date <= term.to;
    if (!inWeek && !inTerm) continue;
    const row = rowOf(userId);
    const minutes = minutesOf(lesson);
    if (inWeek) {
      row.weekLessons++;
      row.weekMinutes += minutes;
    }
    if (inTerm) {
      row.termLessons++;
      row.termMinutes += minutes;
      if (at(lesson.endsAt) <= now) row.heldTermMinutes += minutes;
    }
    rows.set(userId, row);
  }
  for (const member of SUBSTITUTE_POOL) rows.set(member.userId, rowOf(member.userId));
  const sorted = [...rows.values()].sort(
    (a, b) => b.weekLessons - a.weekLessons || b.termLessons - a.termLessons || a.userId.localeCompare(b.userId),
  );
  return { date, rows: sorted };
}

/**
 * cover-reports.service.ts hours: the covers held in the range, those whose
 * substitute was away themself set aside to check, and the ones still ahead.
 */
function hoursOf(from: string, to: string): Hours {
  const now = Date.parse(NOW);
  const inRange = COVERS.filter(({ lesson }) => lesson.date >= from && lesson.date <= to);
  const held: HoursRow[] = inRange
    .filter(({ lesson }) => at(lesson.endsAt) <= now)
    .map(({ userId, lesson }) => ({
      lessonId: lesson.id,
      userId,
      kind: kindOf(userId),
      date: lesson.date,
      startsAt: lesson.startsAt,
      endsAt: lesson.endsAt,
      minutes: minutesOf(lesson),
      subjectId: lesson.subjectId,
      studentGroupId: lesson.studentGroupId,
      roomId: lesson.roomId,
    }));
  const wasAway = (row: HoursRow) => awayDuring(row.userId, row);
  const rows = held.filter((row) => !wasAway(row));
  const summary = new Map<string, Hours["summary"][number]>();
  for (const row of rows) {
    const entry = summary.get(row.userId) ?? { userId: row.userId, kind: row.kind, lessons: 0, minutes: 0 };
    entry.lessons++;
    entry.minutes += row.minutes;
    summary.set(row.userId, entry);
  }
  const planned = new Map<string, Hours["planned"][number]>();
  for (const { userId, lesson } of inRange) {
    if (lesson.status !== "SCHEDULED" || at(lesson.endsAt) <= now) continue;
    const entry = planned.get(userId) ?? { userId, lessons: 0, minutes: 0 };
    entry.lessons++;
    entry.minutes += minutesOf(lesson);
    planned.set(userId, entry);
  }
  const byUser = <T extends { userId: string }>(a: T, b: T) => a.userId.localeCompare(b.userId);
  return {
    from,
    to,
    rows,
    toCheck: held.filter(wasAway),
    summary: [...summary.values()].sort(byUser),
    planned: [...planned.values()].sort(byUser),
  };
}

// --- The candidates ----------------------------------------------------------------------

/**
 * cover-suggestions.service.ts in brief: everyone free is a candidate, ranked
 * by cover-rank.ts's weights for the subject and the class, being in school
 * that day and the counter; the rest are excluded with the hard rule's code.
 * No behörighet is recorded at Exempelskolan, so qualificationKind is null.
 */
function candidatesFor(lesson: CoverLesson): Candidates {
  const now = Date.parse(NOW);
  const on = new Set(teachersOn(lesson.id).map((row) => row.teacherId));
  const counter = new Map(counterOn(lesson.date, now).rows.map((row) => [row.userId, row]));
  const subject = byId(SUBJECT_LIST, lesson.subjectId)?.name ?? "";
  const group = byId(GROUP_LIST, lesson.studentGroupId)?.name ?? "";
  const candidates: Candidate[] = [];
  const excluded: Candidates["excluded"] = [];
  for (const teacher of TEACHER_LIST) {
    const own = lessonsOf(teacher.id);
    const refused = !teacher.isActive
      ? "INACTIVE"
      : on.has(teacher.id)
        ? "ON_LESSON"
        : awayDuring(teacher.id, lesson)
          ? "ABSENT"
          : own.some((other) => overlaps(other, lesson))
            ? "BUSY_LESSON"
            : null;
    if (refused) {
      excluded.push({ userId: teacher.id, codes: [{ code: refused, params: {} }] });
      continue;
    }
    const reasons: RankReason[] = [];
    const add = (code: string, points: number, params: Record<string, string | number> = {}) =>
      reasons.push({ code, params, points });
    const taught = MASTER_LESSONS.filter((row) => row.teacherId === teacher.id || row.coTeacherId === teacher.id);
    const teachesSubject = taught.some((row) => row.subjectId === lesson.subjectId);
    const teachesGroup = taught.some((row) => row.studentGroupId === lesson.studentGroupId);
    if (teachesSubject && teachesGroup) add("TEACHES_GROUP_SUBJECT", 25, { group, subject });
    else if (teachesSubject) add("TEACHES_SUBJECT", 10, { subject });
    else if (teachesGroup) add("TEACHES_GROUP", 12, { group });
    if (own.some((other) => other.date === lesson.date)) add("ON_SITE", 6);
    else add("NOT_ON_SITE", -15);
    const count = counter.get(teacher.id);
    const weekLessons = count?.weekLessons ?? 0;
    const termLessons = count?.termLessons ?? 0;
    if (weekLessons > 0) add("COUNTER_WEEK", -Math.min(25, 5 * weekLessons), { count: weekLessons });
    if (termLessons > 0) add("COUNTER_TERM", -Math.min(15, termLessons), { count: termLessons });
    candidates.push({
      userId: teacher.id,
      kind: kindOf(teacher.id),
      score: reasons.reduce((sum, row) => sum + row.points, 0),
      qualificationKind: null,
      reasons,
      counter: { weekLessons, termLessons },
      load: {
        weekMinutes: own
          .filter((other) => mondayOf(other.date) === mondayOf(lesson.date))
          .reduce((sum, other) => sum + minutesOf(other), 0),
        targetMinutes: null,
      },
    });
  }
  candidates.sort((a, b) => b.score - a.score || a.userId.localeCompare(b.userId));
  return { lessonId: lesson.id, candidates, excluded };
}

// --- The routes ----------------------------------------------------------------------------

const missing = (names: string) => new Reply(400, { message: `${names}: YYYY-MM-DD.` });

export const coverRoutes: GatewayRoute[] = [
  route("GET", "/api/v1/teacher-absences", ({ person, query }) => absences(query, person)),
  route("GET", "/api/v1/teacher-absence-reasons", () => REASON_LIST),
  route("GET", "/api/v1/cover/settings", () => COVER_SETTINGS),
  route("GET", "/api/v1/cover/board", ({ query }) => {
    const from = query.get("from");
    const to = query.get("to");
    return from && to ? boardOf(from, to) : missing("from, to");
  }),
  route("GET", "/api/v1/cover/counter", ({ query }) => {
    const date = query.get("date");
    return date ? counterOn(date, Date.parse(NOW)) : missing("date");
  }),
  route("GET", "/api/v1/cover/hours", ({ query }) => {
    const from = query.get("from");
    const to = query.get("to");
    return from && to ? hoursOf(from, to) : missing("from, to");
  }),
  route("GET", "/api/v1/cover/lessons/:lessonId/candidates", ({ params }) => {
    const lesson = byId(COVER_LESSONS, params.lessonId);
    return lesson ? candidatesFor(lesson) : new Reply(404, { message: "Lektionen finns inte." });
  }),
  route("GET", "/api/v1/cover/pool", () =>
    SUBSTITUTE_POOL.map((member) => ({ userId: member.userId, createdAt: POOL_JOINED })),
  ),
  // A teacher reads their own windows only; an admin everybody's, or one member's.
  route("GET", "/api/v1/cover/availability", ({ person, query }) => {
    const userId = isAdmin(person) ? query.get("userId") : (person?.userId ?? "");
    return POOL_WINDOWS.filter((slot) => userId === null || slot.userId === userId);
  }),
];
