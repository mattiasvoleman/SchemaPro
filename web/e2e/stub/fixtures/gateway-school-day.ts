import type {
  FreeView,
  GridBlock,
  GridDay,
  GridLesson,
  SchoolDayAccess,
  SchoolDaySettings,
  SchoolDayView,
} from "../../../lib/school-day";
import { Reply, route, type GatewayContext, type GatewayRoute } from "../gateway-routes";
import { addDays, isoWeekday, TODAY } from "./calendar";
import { CALENDAR_LESSON_TEACHERS, CALENDAR_LESSONS, GROUP_LIST, HALF_LIST, ROOM_LIST, ROOMS, SUBJECT_LIST, TEACHER_LIST } from "./world";

/**
 * Skolans dag as the gateway answers it (src/school-day/): the day or the week
 * of the whole school from the fixture world's dated lessons, a booking and a
 * closure on today, the search for who and what is free, and the school's
 * decision about its teachers. Bildsalen is lent to another school for two hours today.
 *
 * The school has chosen the whole schedule for its teachers (ALL), so the
 * teacher persona sees the class and teacher rows and the free rooms, and never
 * who is free; the administrator has everything. Wednesday's cancelled Swedish
 * (world.ts) is the cancelled lesson. The stub keeps nothing between requests,
 * so a save cannot leave a choice for the next suite.
 */

const SETTINGS: SchoolDaySettings = { teacherView: "ALL" };

const ADMIN_ACCESS: SchoolDayAccess = { admin: true, grids: true, freeTeachers: true };
const TEACHER_ACCESS: SchoolDayAccess = { admin: false, grids: true, freeTeachers: false };

const isDate = (value: string | null): value is string => value !== null && /^\d{4}-\d{2}-\d{2}$/.test(value);
const isClock = (value: string | null): value is string => value !== null && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

const clock = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Stockholm", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** Minutes since Stockholm's midnight of an instant: what the gateway sends instead of an instant. */
function minutesOf(instant: string): number {
  const [hours, minutes] = clock.format(new Date(instant)).split(":").map(Number);
  return hours! * 60 + minutes!;
}

const minutes = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

function reader(context: GatewayContext): SchoolDayAccess | Reply {
  if (!context.person) return new Reply(401, { message: "Not authenticated." });
  if (context.person.persona === "admin") return ADMIN_ACCESS;
  if (context.person.persona === "teacher") return TEACHER_ACCESS;
  return new Reply(403, { message: "Forbidden." });
}

function lessonsOn(from: string, to: string, access: SchoolDayAccess): GridLesson[] {
  return CALENDAR_LESSONS.filter((lesson) => lesson.date >= from && lesson.date <= to).map((lesson) => ({
    id: lesson.id,
    date: lesson.date,
    start: minutesOf(lesson.startsAt),
    end: minutesOf(lesson.endsAt),
    status: lesson.status,
    cancelCause: lesson.status === "CANCELLED" ? ("MANUAL" as const) : null,
    subjectId: lesson.subjectId,
    groupId: lesson.studentGroupId,
    extraGroupIds: [],
    roomId: lesson.roomId,
    teachers: access.grids
      ? CALENDAR_LESSON_TEACHERS.filter((row) => row.calendarLessonId === lesson.id).map((row) => ({
          id: row.teacherId,
          role: row.role as "LEAD" | "ASSISTANT" | "SUBSTITUTE",
        }))
      : [],
    hiddenTeachers: 0,
    activity: false,
  }));
}

function grid(context: GatewayContext): SchoolDayView | Reply {
  const access = reader(context);
  if (access instanceof Reply) return access;
  const from = context.query.get("from");
  const to = context.query.get("to") ?? from;
  if (!isDate(from) || !isDate(to)) return new Reply(400, { message: "from: ett datum som finns, ÅÅÅÅ-MM-DD." });
  const days: GridDay[] = [];
  for (let date = from; date <= to && days.length < 8; date = addDays(date, 1)) {
    days.push({ date, weekday: isoWeekday(date), breaks: [] });
  }
  if (days.length === 0 || days.length > 7) return new Reply(400, { message: "to: högst 7 dagar från from." });
  const booking = (resource: GridBlock["resource"], resourceId: string): GridBlock => ({
    resource,
    resourceId,
    date: TODAY,
    start: 13 * 60,
    end: 14 * 60,
    kind: "BOOKING",
    label: "Föräldramöte",
  });
  const blocks: GridBlock[] = [
    booking("ROOM", ROOMS.r201.id),
    { resource: "ROOM" as const, resourceId: ROOMS.lab.id, date: TODAY, start: 12 * 60, end: 13 * 60, kind: "CLOSED" as const, label: null },
    // A room lent to another school of the huvudman in an approved window of a loan (Delade lokaler).
    { resource: "ROOM" as const, resourceId: ROOMS.art.id, date: TODAY, start: 14 * 60, end: 16 * 60, kind: "LOAN" as const, label: null },
    ...(access.grids ? [booking("TEACHER", TEACHER_LIST[0]!.id)] : []),
  ].filter((block) => block.date >= from && block.date <= to);
  const lessons = lessonsOn(from, to, access);
  const used = new Set(lessons.map((lesson) => lesson.groupId));
  return {
    from,
    to,
    timezone: "Europe/Stockholm",
    access,
    days,
    groups: [...GROUP_LIST, ...HALF_LIST]
      .filter((group) => group.kind === "CLASS" || used.has(group.id))
      .map((group) => ({ id: group.id, name: group.name, kind: group.kind, gradeLevel: group.gradeLevel, halfOfId: group.halfOfId ?? null })),
    teachers: access.grids ? TEACHER_LIST.map((teacher) => ({ id: teacher.id, name: `${teacher.firstName} ${teacher.lastName}` })) : [],
    rooms: ROOM_LIST.map((room) => ({ id: room.id, name: room.name, code: room.code ?? null })),
    subjects: SUBJECT_LIST.filter((subject) => lessons.some((lesson) => lesson.subjectId === subject.id)).map((subject) => ({ id: subject.id, name: subject.name })),
    lessons,
    blocks,
    heldOut: { teachers: 0 },
  };
}

function free(context: GatewayContext): FreeView | Reply {
  const access = reader(context);
  if (access instanceof Reply) return access;
  const date = context.query.get("date");
  const from = context.query.get("from");
  const to = context.query.get("to");
  if (!isDate(date)) return new Reply(400, { message: "date: ett datum som finns, ÅÅÅÅ-MM-DD." });
  if (!isClock(from) || !isClock(to)) return new Reply(400, { message: "from: en tid TT:MM." });
  if (from >= to) return new Reply(400, { message: "from: före to." });
  const start = minutes(from);
  const end = minutes(to);
  const holding = lessonsOn(date, date, { ...access, grids: true }).filter(
    (lesson) => (lesson.status === "SCHEDULED" || lesson.status === "COMPLETED") && lesson.start < end && start < lesson.end,
  );
  const busyTeachers = new Set(holding.flatMap((lesson) => lesson.teachers.map((teacher) => teacher.id)));
  const busyRooms = new Set(holding.flatMap((lesson) => (lesson.roomId ? [lesson.roomId] : [])));
  const teachers = TEACHER_LIST.map((teacher) => ({ id: teacher.id, name: `${teacher.firstName} ${teacher.lastName}` }));
  const rooms = ROOM_LIST.map((room) => ({ id: room.id, name: room.name, code: room.code ?? null }));
  return {
    date,
    from,
    to,
    access,
    breaks: [],
    teachers: access.freeTeachers ? teachers.filter((teacher) => !busyTeachers.has(teacher.id)) : null,
    rooms: rooms.filter((room) => !busyRooms.has(room.id)),
    busyTeachers: access.admin ? teachers.filter((teacher) => busyTeachers.has(teacher.id)).map((teacher) => ({ ...teacher, reasons: ["BUSY_LESSON" as const] })) : null,
    busyRooms: access.admin ? rooms.filter((room) => busyRooms.has(room.id)).map((room) => ({ ...room, reasons: ["ROOM_IN_USE" as const] })) : null,
    poolLeftOut: 0,
    heldOut: { teachers: 0 },
    rules: {
      teachers: access.freeTeachers
        ? ["ABSENT", "BUSY_LESSON", "BUSY_SUPERVISION", "BUSY_DUTY", "UNAVAILABLE", "BOOKED_ROOM", "POOL_NOT_DECLARED"]
        : [],
      rooms: ["ROOM_IN_USE", "ROOM_BOOKED", "ROOM_CLOSED", "ROOM_LENT", "ROOM_BORROWED_OUTSIDE_LOAN"],
    },
  };
}

function settings(context: GatewayContext): SchoolDaySettings | Reply {
  if (!context.person) return new Reply(401, { message: "Not authenticated." });
  return context.person.persona === "admin" || context.person.persona === "teacher" ? SETTINGS : new Reply(403, { message: "Forbidden." });
}

function saveSettings(context: GatewayContext): SchoolDaySettings | Reply {
  if (!context.person) return new Reply(401, { message: "Not authenticated." });
  if (context.person.persona !== "admin") return new Reply(403, { message: "Forbidden." });
  const body = (context.body ?? {}) as Partial<SchoolDaySettings>;
  if (body.teacherView !== "NONE" && body.teacherView !== "ROOMS" && body.teacherView !== "ALL") {
    return new Reply(400, { message: "teacherView: NONE, ROOMS eller ALL." });
  }
  return { teacherView: body.teacherView };
}

export const schoolDayRoutes: GatewayRoute[] = [
  route("GET", "/api/v1/school-day", grid),
  route("GET", "/api/v1/school-day/free", free),
  route("GET", "/api/v1/school-day/settings", settings),
  route("PUT", "/api/v1/school-day/settings", saveSettings),
];
