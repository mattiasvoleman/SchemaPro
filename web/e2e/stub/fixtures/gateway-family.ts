import { createHash } from "node:crypto";
import type { FamilyLesson, FamilyMeal, FamilyRast, FamilySchedule } from "../../../lib/family-schedule";
import type { NotificationPreference, NotificationTypeName } from "../../../lib/notification-preferences-queries";
import type { GroupMember, RosterPupil } from "../../../lib/queries";
import type { ActivationPreview, ActivationProblem, Person } from "../../../lib/types";
import { Reply, route, type GatewayContext, type GatewayRoute } from "../gateway-routes";
import { KIND, uid, type Persona } from "../sessions";
import { addDays, mondayOf, stockholmInstant, THIS_MONDAY, TODAY, YEAR_END } from "./calendar";
import { ABSENCE_REPORTS, CALENDAR_LUNCHES, CALENDAR_RASTS, GROUP_MEMBERS, LEAVE_REQUESTS, SCHOOL_BREAKS } from "./school-days";
import {
  byId,
  CALENDAR_LESSON_TEACHERS,
  CALENDAR_LESSONS,
  GROUP_LIST,
  GROUPS,
  GUARDIAN_LINKS,
  MASTER_LESSONS,
  NEXT_CLASSES,
  NEXT_YEAR,
  ROOM_LIST,
  STUDENT_LIST,
  SUBJECT_LIST,
  TEACHER_LIST,
  YEAR,
} from "./world";

/**
 * The gateway's answers about pupils and their families: the family week on
 * /guardian, the register on /teacher/attendance/[lessonId], the activation
 * preview on /admin/years, the rollover wizard's refusal, and everybody's
 * notice settings. Everything is computed from world.ts and school-days.ts,
 * so a pupil, a lesson or a date here is the one PostgREST shows.
 */

// --- Who may ask ---------------------------------------------------------------

/** The gateway's guards: no token is a 401, a role the route does not admit a 403. */
function refuse(context: GatewayContext, personas: Persona[]): Reply | null {
  if (!context.person) return new Reply(401, { message: "Unauthorized" });
  if (!personas.includes(context.person.persona)) return new Reply(403, { message: "Forbidden resource" });
  return null;
}

// --- The school's clock ----------------------------------------------------------

const CLOCK = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Stockholm",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** HH:MM of an instant in Stockholm, as the gateway writes the family's times. */
const schoolClock = (instant: string) => CLOCK.format(new Date(instant));

const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

/** "2026-W42" for the week whose Monday is given: the week of its Thursday (src/family/family-schedule.service.ts). */
function isoWeekLabel(monday: string): string {
  const thursday = new Date(`${addDays(monday, 3)}T00:00:00Z`);
  const year = thursday.getUTCFullYear();
  const dayOfYear = Math.round((thursday.getTime() - Date.UTC(year, 0, 1)) / 86_400_000);
  return `${year}-W${String(Math.floor(dayOfYear / 7) + 1).padStart(2, "0")}`;
}

// --- Who is on a lesson ----------------------------------------------------------

type CalendarLesson = (typeof CALENDAR_LESSONS)[number];

/** The groups a pupil sits in: the home class and every teaching group (StudentGroupMembers). */
function groupsOf(student: Person): Set<string> {
  const groups = new Set(GROUP_MEMBERS.filter((row) => row.studentId === student.id).map((row) => row.studentGroupId));
  if (student.studentGroupId) groups.add(student.studentGroupId);
  return groups;
}

/** The roster reader's four sources: the lesson's group, its extra groups, their members, the pupils named on it. */
function attends(student: Person, lesson: CalendarLesson): boolean {
  const master = byId(MASTER_LESSONS, lesson.masterLessonId);
  const groups = groupsOf(student);
  return (
    groups.has(lesson.studentGroupId) ||
    (master?.extraGroupIds ?? []).some((groupId) => groups.has(groupId)) ||
    (master?.studentIds ?? []).includes(student.id)
  );
}

/** The register's pupils: the active ones, in Swedish name order, as the gateway sorts them. */
const rosterOf = (lesson: CalendarLesson) =>
  STUDENT_LIST.filter((student) => student.isActive && attends(student, lesson)).sort(
    (a, b) => a.lastName.localeCompare(b.lastName, "sv") || a.firstName.localeCompare(b.firstName, "sv"),
  );

const teacherName = (id: string) => {
  const teacher = byId(TEACHER_LIST, id);
  return teacher ? `${teacher.firstName} ${teacher.lastName}` : null;
};

/** The lesson's teachers as the school names them to families: full names, lead first. */
const teachersOf = (lesson: CalendarLesson) =>
  CALENDAR_LESSON_TEACHERS.filter((row) => row.calendarLessonId === lesson.id)
    .sort((a, b) => (a.role === b.role ? 0 : a.role === "LEAD" ? -1 : 1))
    .map((row) => teacherName(row.teacherId))
    .filter((name): name is string => name !== null);

// --- The family's week -----------------------------------------------------------

/**
 * Wednesday's mathematics in 7A has a substitute, beside the same day's
 * cancelled Swedish (world.ts), so Ella's week shows both states and a
 * Wednesday's "I dag" does too. A family hears that there is a substitute,
 * never who, so it names nobody.
 */
const SUBSTITUTED = CALENDAR_LESSONS.find((lesson) => lesson.masterLessonId === uid(KIND.masterLesson, 7))!.id;

/** The gateway's bounds: from last week to the week the läsår ends in. */
const lastWeek = mondayOf(addDays(TODAY, -7));
const yearsLastWeek = mondayOf(YEAR_END);
const BOUNDS: FamilySchedule["bounds"] = {
  earliest: lastWeek > YEAR_END ? THIS_MONDAY : lastWeek,
  latest: yearsLastWeek < THIS_MONDAY ? THIS_MONDAY : yearsLastWeek,
};

const onBreak = (date: string) => SCHOOL_BREAKS.some((entry) => entry.startDate <= date && date <= entry.endDate);

/** An id for a row of another week than this one, which world.ts does not date: unique per week and row. */
const weekRowId = (kind: number, weeks: number, index: number) => uid(kind, 0x100000 + (weeks + 100) * 0x100 + index);

/**
 * One child's week. This week is CALENDAR_LESSONS as they stand, so the
 * family sees what /student and the teachers see; another week (the arrows)
 * is the same weekly pattern published again, without this week's
 * cancellation and substitute, and with nothing on a lov or studiedag.
 */
function familyWeek(student: Person, monday: string): FamilySchedule {
  const shift = daysBetween(THIS_MONDAY, monday);
  const weeks = shift / 7;
  const shown = (date: string) => shift === 0 || !onBreak(date);

  // A moved lesson is shown where it went, not where it was.
  const lessons: FamilyLesson[] = CALENDAR_LESSONS.filter(
    (lesson) => lesson.status !== "RESCHEDULED" && attends(student, lesson),
  )
    .map((lesson, index) => {
      const date = addDays(lesson.date, shift);
      const start = schoolClock(lesson.startsAt);
      const end = schoolClock(lesson.endsAt);
      const subject = byId(SUBJECT_LIST, lesson.subjectId)!;
      const status = shift === 0 ? lesson.status : "SCHEDULED";
      const substitute = shift === 0 && lesson.id === SUBSTITUTED;
      return {
        id: shift === 0 ? lesson.id : weekRowId(KIND.calendarLesson, weeks, index),
        date,
        start,
        end,
        startsAt: stockholmInstant(date, start),
        endsAt: stockholmInstant(date, end),
        subjectId: subject.id,
        subject: subject.name,
        subjectColor: subject.color,
        room: byId(ROOM_LIST, lesson.roomId)?.name ?? null,
        // A cancelled or substituted lesson names nobody.
        teachers: status === "CANCELLED" || substitute ? [] : teachersOf(lesson),
        status: status as FamilyLesson["status"],
        substitute,
      };
    })
    .filter((lesson) => shown(lesson.date))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));

  // Lunch and rasts are the home class's.
  const home = student.studentGroupId;
  const lunches: FamilyMeal[] = CALENDAR_LUNCHES.filter((meal) => meal.studentGroupId === home)
    .map((meal, index) => ({
      id: shift === 0 ? meal.id : weekRowId(KIND.misc, weeks, index),
      date: addDays(meal.date, shift),
      start: schoolClock(meal.startsAt),
      end: schoolClock(meal.endsAt),
    }))
    .filter((meal) => shown(meal.date));
  const rasts: FamilyRast[] = CALENDAR_RASTS.filter((rast) => rast.studentGroupId === home)
    .map((rast, index) => ({
      id: shift === 0 ? rast.id : weekRowId(KIND.misc, weeks, 0x80 + index),
      date: addDays(rast.date, shift),
      start: schoolClock(rast.startsAt),
      end: schoolClock(rast.endsAt),
      name: rast.name,
    }))
    .filter((rast) => shown(rast.date));

  return {
    student: { id: student.id, firstName: student.firstName },
    week: { from: monday, to: addDays(monday, 6), isoWeek: isoWeekLabel(monday) },
    today: TODAY,
    bounds: BOUNDS,
    timezone: "Europe/Stockholm",
    lessons,
    lunches,
    rasts,
  };
}

function familySchedule(context: GatewayContext): FamilySchedule | Reply {
  const refused = refuse(context, ["guardian", "admin"]);
  if (refused) return refused;
  const studentId = context.query.get("studentId");
  const week = context.query.get("week");
  if (!studentId) return new Reply(400, { message: "studentId must be a UUID" });
  if (week !== null && !/^\d{4}-\d{2}-\d{2}$/.test(week)) {
    return new Reply(400, { message: "week: ett datum som finns, ÅÅÅÅ-MM-DD." });
  }
  // Another family's child is the same 404 as an unknown id.
  const linked =
    context.person!.persona === "admin" ||
    GUARDIAN_LINKS.some((link) => link.guardianId === context.person!.userId && link.studentId === studentId);
  const student = linked ? STUDENT_LIST.find((candidate) => candidate.id === studentId && candidate.isActive) : null;
  if (!student) return new Reply(404, { message: "Eleven finns inte.", code: "STUDENT_NOT_FOUND" });
  const monday = mondayOf(week ?? TODAY);
  if (monday !== THIS_MONDAY && (monday < BOUNDS.earliest || (BOUNDS.latest !== null && monday > BOUNDS.latest))) {
    return new Reply(400, { message: "Veckan ligger utanför det som går att visa.", code: "WEEK_OUT_OF_RANGE" });
  }
  return familyWeek(student, monday);
}

// --- The register ----------------------------------------------------------------

/** The lesson asked about, if this caller may take its register: an admin, or a teacher on it. */
function registerLesson(context: GatewayContext): CalendarLesson | Reply {
  const refused = refuse(context, ["teacher", "admin"]);
  if (refused) return refused;
  const id = context.params.calendarLessonId!;
  const lesson = byId(CALENDAR_LESSONS, id);
  if (!lesson) return new Reply(404, { message: `Calendar lesson not found: ${id}` });
  const assigned = CALENDAR_LESSON_TEACHERS.some(
    (row) => row.calendarLessonId === lesson.id && row.teacherId === context.person!.userId,
  );
  if (context.person!.persona === "teacher" && !assigned) {
    return new Reply(403, { message: "You are not assigned to this lesson and cannot record attendance for it." });
  }
  return lesson;
}

/**
 * Who on the lesson's roster is away in advance: a report on its day that is
 * whole-day or overlaps its time on the school's clock, or a granted leave
 * spanning the day. Ids only — a teacher learns that a pupil is away, never why.
 */
function reportedAbsent(lesson: CalendarLesson): string[] {
  const start = schoolClock(lesson.startsAt);
  const end = schoolClock(lesson.endsAt);
  const reported = ABSENCE_REPORTS.filter(
    (report) =>
      report.date.slice(0, 10) === lesson.date &&
      (report.startTime === null || (report.startTime.slice(0, 5) < end && (report.endTime ?? "24:00").slice(0, 5) > start)),
  ).map((report) => report.studentId);
  const onLeave = LEAVE_REQUESTS.filter(
    (leave) => leave.status === "APPROVED" && leave.startDate <= lesson.date && lesson.date <= leave.endDate,
  ).map((leave) => leave.studentId);
  const roster = new Set(rosterOf(lesson).map((student) => student.id));
  return [...new Set([...reported, ...onLeave])].filter((id) => roster.has(id)).sort();
}

// --- Next läsår: its classes and the activation's plan -----------------------------

const sortedIds = (pupils: Person[]) => pupils.map((pupil) => pupil.id).sort();
const activePupils = STUDENT_LIST.filter((pupil) => pupil.isActive);

/** Who moves where when NEXT_YEAR is activated, by today's home classes. */
const MOVES: ActivationPreview["moves"] = Object.entries(NEXT_CLASSES)
  .map(([fromGroupId, to]) => {
    const pupils = activePupils.filter((pupil) => pupil.studentGroupId === fromGroupId);
    return {
      fromGroupId,
      fromGroupName: byId(GROUP_LIST, fromGroupId)!.name,
      toGroupId: to.id,
      toGroupName: to.name,
      count: pupils.length,
      studentIds: sortedIds(pupils),
    };
  })
  .filter((move) => move.count > 0);
const GRADUATES = sortedIds(activePupils.filter((pupil) => pupil.studentGroupId === GROUPS.g9A.id));
const PENDING = MOVES.reduce((sum, move) => sum + move.count, 0) + GRADUATES.length;

const planHash = (yearId: string, pairs: unknown) =>
  createHash("sha256").update(JSON.stringify({ yearId, pairs })).digest("hex");

/**
 * NEXT_YEAR's activation: refused until this year has ended, and a notice
 * that one pupil's teaching groups for next year were set before they
 * changed class, so the admin has two problems to read.
 */
function nextYearActivation(): ActivationPreview {
  const problems: ActivationProblem[] = [];
  if (TODAY <= YEAR_END) {
    problems.push({ code: "YEAR_ACTIVATION_TOO_EARLY", blocking: true, params: { year: YEAR.name, endDate: YEAR_END } });
  }
  problems.push({ code: "MEMBERSHIPS_OUT_OF_DATE", blocking: false, params: { missing: 1, stale: 0 } });
  return {
    year: { id: NEXT_YEAR.id, name: NEXT_YEAR.name, isActive: false },
    currentlyActive: { id: YEAR.id, name: YEAR.name },
    chain: [{ id: YEAR.id, name: YEAR.name, endDate: YEAR_END }],
    moves: MOVES,
    graduates: { count: GRADUATES.length, studentIds: GRADUATES },
    unplaced: { count: 0, studentIds: [], pupils: [] },
    alreadyInYear: 0,
    inLaterYear: 0,
    otherOrNone: 0,
    inactiveUntouched: 0,
    problems,
    blocking: problems.some((problem) => problem.blocking),
    planHash: planHash(NEXT_YEAR.id, MOVES.map((move) => [move.fromGroupId, move.toGroupId, move.studentIds])),
  };
}

/** The active year has no predecessor, so its activation has nothing to move. */
function activeYearActivation(): ActivationPreview {
  return {
    year: { id: YEAR.id, name: YEAR.name, isActive: true },
    currentlyActive: { id: YEAR.id, name: YEAR.name },
    chain: [],
    moves: [],
    graduates: { count: 0, studentIds: [] },
    unplaced: { count: 0, studentIds: [], pupils: [] },
    alreadyInYear: activePupils.length,
    inLaterYear: 0,
    otherOrNone: 0,
    inactiveUntouched: 0,
    problems: [],
    blocking: false,
    planHash: planHash(YEAR.id, []),
  };
}

function activationPreview(context: GatewayContext): ActivationPreview | Reply {
  const refused = refuse(context, ["admin"]);
  if (refused) return refused;
  if (context.params.id === NEXT_YEAR.id) return nextYearActivation();
  if (context.params.id === YEAR.id) return activeYearActivation();
  return new Reply(404, { message: "Läsåret finns inte." });
}

/**
 * Neither year can be rolled in this world, and the wizard says why: this
 * year already has its successor, and next year waits for its activation.
 */
function rolloverPreview(context: GatewayContext): Reply {
  const refused = refuse(context, ["admin"]);
  if (refused) return refused;
  if (context.params.id === YEAR.id) {
    return new Reply(409, {
      message: `Läsåret ${YEAR.name} har redan rullats vidare till ${NEXT_YEAR.name}.`,
      code: "YEAR_HAS_SUCCESSOR",
      params: { successorId: NEXT_YEAR.id, successor: NEXT_YEAR.name },
    });
  }
  if (context.params.id === NEXT_YEAR.id) {
    return new Reply(409, {
      message:
        `Läsåret ${NEXT_YEAR.name} är inte aktiverat: ${PENDING} elever väntar fortfarande på att flyttas in i dess klasser. ` +
        "Aktivera det innan det rullas vidare, så räknas klasserna på sina egna elever.",
      code: "ROLLOVER_SOURCE_NOT_ACTIVATED",
      params: { year: NEXT_YEAR.name, pupils: PENDING },
    });
  }
  return new Reply(404, { message: "Läsåret finns inte." });
}

// --- Notice settings ---------------------------------------------------------------

/** src/notifications/notification-types.ts: what each role may choose about, in its order. */
const LESSON_NOTICES: NotificationTypeName[] = [
  "LESSON_CANCELLED",
  "CANCELLATION_DIGEST",
  "LESSON_REINSTATED",
  "LESSON_SUBSTITUTE",
  "LESSON_SUPERVISED_STUDY",
  "LESSON_ROOM_CHANGED",
  "SCHEDULE_CHANGED",
];
const STAFF_NOTICES: NotificationTypeName[] = [
  "LESSON_CANCELLED",
  "CANCELLATION_DIGEST",
  "LESSON_REINSTATED",
  "LESSON_SUBSTITUTE",
  "LESSON_SUPERVISED_STUDY",
  "LESSON_COVER_WITHDRAWN",
  "LESSON_ROOM_CHANGED",
  "ROOM_BOOKING_DECIDED",
];
const OFFERED: Record<Persona, NotificationTypeName[]> = {
  guardian: [...LESSON_NOTICES, "LEAVE_DECIDED", "ABSENCE_UNREPORTED"],
  student: [...LESSON_NOTICES, "LEAVE_DECIDED"],
  teacher: STAFF_NOTICES,
  admin: STAFF_NOTICES,
};
/** Sent whatever is chosen: the unreported absence to a guardian, a cover lesson's withdrawal to staff. */
const REQUIRED: Record<Persona, NotificationTypeName[]> = {
  guardian: ["ABSENCE_UNREPORTED"],
  student: [],
  teacher: ["LESSON_COVER_WITHDRAWN"],
  admin: ["LESSON_COVER_WITHDRAWN"],
};
/** What each signed-in person has already switched off, so every list shows a switch in both positions. */
const OPTED_OUT: Record<Persona, NotificationTypeName[]> = {
  guardian: ["CANCELLATION_DIGEST"],
  student: ["SCHEDULE_CHANGED"],
  teacher: ["ROOM_BOOKING_DECIDED"],
  admin: ["LESSON_REINSTATED", "LESSON_ROOM_CHANGED"],
};

function notificationPreferences(context: GatewayContext): { types: NotificationPreference[] } | Reply {
  const refused = refuse(context, ["guardian", "student", "teacher", "admin"]);
  if (refused) return refused;
  const persona = context.person!.persona;
  return {
    types: OFFERED[persona].map((type) => {
      const required = REQUIRED[persona].includes(type);
      return { type, enabled: required || !OPTED_OUT[persona].includes(type), required };
    }),
  };
}

// --- Routes ------------------------------------------------------------------------

export const familyRoutes: GatewayRoute[] = [
  route("GET", "/api/v1/family/schedule", familySchedule),
  route("GET", "/api/v1/attendance/lessons/:calendarLessonId/roster", (context): { students: RosterPupil[] } | Reply => {
    const lesson = registerLesson(context);
    if (lesson instanceof Reply) return lesson;
    return {
      students: rosterOf(lesson).map(({ id, firstName, lastName }) => ({ id, firstName, lastName })),
    };
  }),
  route(
    "GET",
    "/api/v1/attendance/lessons/:calendarLessonId/reported-absences",
    // Not exported by lib/queries.ts: useLessonReportedAbsences reads `{ studentIds: string[] }`.
    (context): { studentIds: string[] } | Reply => {
      const lesson = registerLesson(context);
      if (lesson instanceof Reply) return lesson;
      return { studentIds: reportedAbsent(lesson) };
    },
  ),
  route("POST", "/api/v1/academic-years/:id/activation/preview", activationPreview),
  route("POST", "/api/v1/academic-years/:id/rollover/preview", rolloverPreview),
  // /admin/groups' member dialog (opened by a click): the group's members with their home class.
  route("GET", "/api/v1/student-groups/:id/members", (context): GroupMember[] | Reply => {
    const refused = refuse(context, ["admin"]);
    if (refused) return refused;
    const memberIds = new Set(
      GROUP_MEMBERS.filter((row) => row.studentGroupId === context.params.id).map((row) => row.studentId),
    );
    return STUDENT_LIST.filter((student) => memberIds.has(student.id))
      .sort((a, b) => a.lastName.localeCompare(b.lastName, "sv") || a.firstName.localeCompare(b.firstName, "sv"))
      .map((student) => ({
        id: student.id,
        firstName: student.firstName,
        lastName: student.lastName,
        homeGroupId: student.studentGroupId,
      }));
  }),
  route("GET", "/api/v1/notification-preferences", notificationPreferences),
];
