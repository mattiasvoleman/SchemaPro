import { layoutClusters } from "@/lib/day-clusters";

/*
 * SKOLANS DAG: what the gateway answers (src/school-day/school-day.types.ts,
 * the contract of the phase) and how the page turns it into rows.
 *
 * THE WEB ONLY DRAWS. What a lesson is on a day, who is free, what a lov
 * closes and who is left out for a protected identity are the gateway's to
 * say (src/school-day/school-day.service.ts, built on the publication's lov
 * and the Vikarietavla's rules for "occupied"); nothing here decides them
 * again. A lesson arrives with its minutes since the school's local midnight,
 * so the clock change never reaches this module: 08:15 is 495 on both sides
 * of it.
 */

/** What a TEACHER has of the page, the school's decision (SchoolDaySettings.teacherView). */
export type TeacherView = "NONE" | "ROOMS" | "ALL";
export const TEACHER_VIEWS: readonly TeacherView[] = ["NONE", "ROOMS", "ALL"];

export interface SchoolDaySettings {
  teacherView: TeacherView;
}

export interface SchoolDayAccess {
  admin: boolean;
  /** Classes and teachers as rows. */
  grids: boolean;
  /** The free teachers, and why a teacher is not free. */
  freeTeachers: boolean;
}

export interface BreakView {
  name: string;
  kind: "HOLIDAY" | "STAFF_DAY";
  /** null: the whole school. */
  groupIds: string[] | null;
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
}

export interface GridDay {
  date: string;
  /** ISO weekday, 1 = Monday. */
  weekday: number;
  breaks: BreakView[];
}

export interface GridGroup {
  id: string;
  name: string;
  kind: "CLASS" | "TEACHING_GROUP";
  gradeLevel: number | null;
  halfOfId: string | null;
}

export interface GridTeacher {
  id: string;
  name: string;
}

export interface GridRoom {
  id: string;
  name: string;
  code: string | null;
}

export interface GridSubject {
  id: string;
  name: string;
}

export type LessonState = "SCHEDULED" | "CANCELLED" | "COMPLETED" | "RESCHEDULED";
export type CancelCause = "TEACHER_UNAVAILABLE" | "ROOM_UNAVAILABLE" | "MANUAL" | "EVENT";

export interface GridLesson {
  id: string;
  date: string;
  start: number;
  end: number;
  status: LessonState;
  cancelCause: CancelCause | null;
  subjectId: string;
  groupId: string;
  extraGroupIds: string[];
  roomId: string | null;
  teachers: Array<{ id: string; role: "LEAD" | "ASSISTANT" | "SUBSTITUTE" }>;
  hiddenTeachers: number;
  activity: boolean;
}

/**
 * CLOSED is a room that cannot be used then: a closure, or a borrowed room outside what its loan gives.
 * LOAN is a room lent to another school of the huvudman in an approved window of the loan.
 */
export type BlockKind = "BOOKING" | "CLOSED" | "LOAN" | "PASS" | "DUTY" | "UNAVAILABLE" | "ABSENT";

export interface GridBlock {
  resource: "TEACHER" | "ROOM";
  resourceId: string;
  date: string;
  start: number;
  end: number;
  kind: BlockKind;
  label: string | null;
}

export interface SchoolDayView {
  from: string;
  to: string;
  timezone: string;
  access: SchoolDayAccess;
  days: GridDay[];
  groups: GridGroup[];
  teachers: GridTeacher[];
  rooms: GridRoom[];
  subjects: GridSubject[];
  lessons: GridLesson[];
  blocks: GridBlock[];
  heldOut: { teachers: number };
}

export type TeacherBusyCode =
  | "ABSENT"
  | "BUSY_LESSON"
  | "BUSY_SUPERVISION"
  | "BUSY_DUTY"
  | "UNAVAILABLE"
  | "BOOKED_ROOM"
  | "POOL_NOT_DECLARED";

export type RoomBusyCode = "ROOM_IN_USE" | "ROOM_BOOKED" | "ROOM_CLOSED" | "ROOM_LENT" | "ROOM_BORROWED_OUTSIDE_LOAN";

export interface FreeRoom {
  id: string;
  name: string;
  code: string | null;
}

export interface FreeTeacher {
  id: string;
  name: string;
}

export interface FreeView {
  date: string;
  from: string;
  to: string;
  access: SchoolDayAccess;
  breaks: BreakView[];
  teachers: FreeTeacher[] | null;
  rooms: FreeRoom[];
  busyTeachers: Array<FreeTeacher & { reasons: TeacherBusyCode[] }> | null;
  busyRooms: Array<FreeRoom & { reasons: RoomBusyCode[] }> | null;
  poolLeftOut: number;
  heldOut: { teachers: number };
  rules: { teachers: TeacherBusyCode[]; rooms: RoomBusyCode[] };
}

export interface FreeQuery {
  date: string;
  from: string;
  to: string;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type RowKind = "GROUP" | "TEACHER" | "ROOM";
export const ROW_KINDS: readonly RowKind[] = ["GROUP", "TEACHER", "ROOM"];

/** The rows a reader may choose between: a teacher with ROOMS has only the rooms'. */
export function rowKindsOf(access: SchoolDayAccess): RowKind[] {
  return access.grids ? [...ROW_KINDS] : ["ROOM"];
}

/** A teacher on a drawn lesson. A null name is a person left out of a printout (skyddad identitet). */
export interface DrawnTeacher {
  id: string;
  name: string | null;
}

/**
 * One thing drawn in a row on a date: a lesson, or a block (a booking, a
 * closure, a rastvakt, an uppdrag, an absence). The lanes are the day's
 * overlap layout (lib/day-clusters.ts), the same as Schemavisaren's printed
 * week: a lesson that overlaps nothing is full width.
 */
export interface Drawn {
  key: string;
  type: "LESSON" | BlockKind;
  date: string;
  startMinutes: number;
  endMinutes: number;
  lane: number;
  laneCount: number;
  /** A lesson that does not hold its time: CANCELLED or RESCHEDULED. Drawn, struck through, and it frees everyone. */
  cancelled: boolean;
  status: LessonState | null;
  cancelCause: CancelCause | null;
  /** The replacement lesson of a schemabrytande aktivitet. */
  activity: boolean;
  subject: string | null;
  /** The lesson's groups other than the row's own. */
  groups: string[];
  room: string | null;
  teachers: DrawnTeacher[];
  /** Teachers the gateway left out of the answer; a count, never a name. */
  hiddenTeachers: number;
  /** A booking's title or an uppdrag's name. */
  label: string | null;
}

export interface Row {
  id: string;
  kind: RowKind;
  /** null: a teacher left out of a printout, said by the page ("Skyddad identitet"). */
  name: string | null;
  /** A room's code, for the small line under the name; a class and a teacher have none. */
  detail: string | null;
  byDate: Map<string, Drawn[]>;
}

const byStart = (a: Drawn, b: Drawn) => a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes || a.key.localeCompare(b.key);

function lanes(items: Drawn[]): Drawn[] {
  return layoutClusters(items).sort(byStart);
}

/**
 * The rows of a kind, with what is drawn in each by date.
 *
 *   GROUP    the classes (kind CLASS, not a half) first, each one even with no
 *            lesson (a class on a lov is a row); then the halves and teaching
 *            groups that have a lesson in the range. A lesson is in the row of
 *            its group and of each of its extra groups.
 *   TEACHER  the teachers the gateway named, with the lessons they hold and
 *            the blocks of their day.
 *   ROOM     the rooms, with the lessons held in them, their bookings and
 *            closures.
 *
 * `held` are the persons not to be named, for a printout (skyddad identitet,
 * HOLDS_OUT); the screen passes none.
 */
export function buildRows(view: SchoolDayView, kind: RowKind, held: ReadonlySet<string> = new Set()): Row[] {
  const subject = new Map(view.subjects.map((one) => [one.id, one.name]));
  const group = new Map(view.groups.map((one) => [one.id, one.name]));
  const room = new Map(view.rooms.map((one) => [one.id, one.name]));
  const teacher = new Map(view.teachers.map((one) => [one.id, one.name]));

  const drawLesson = (lesson: GridLesson, own: string | null, ownRoom: string | null = null): Drawn => ({
    key: `l:${lesson.id}`,
    type: "LESSON",
    date: lesson.date,
    startMinutes: lesson.start,
    endMinutes: lesson.end,
    lane: 0,
    laneCount: 1,
    cancelled: lesson.status === "CANCELLED" || lesson.status === "RESCHEDULED",
    status: lesson.status,
    cancelCause: lesson.cancelCause,
    activity: lesson.activity,
    subject: subject.get(lesson.subjectId) ?? null,
    groups: [lesson.groupId, ...lesson.extraGroupIds]
      .filter((id) => id !== own)
      .map((id) => group.get(id))
      .filter((name): name is string => typeof name === "string"),
    // The row's own room is not said again on its lessons.
    room: lesson.roomId && lesson.roomId !== ownRoom ? (room.get(lesson.roomId) ?? null) : null,
    teachers: lesson.teachers
      .filter((one) => teacher.has(one.id))
      .map((one) => ({ id: one.id, name: held.has(one.id) ? null : teacher.get(one.id)! })),
    hiddenTeachers: lesson.hiddenTeachers,
    label: null,
  });

  const drawBlock = (block: GridBlock, index: number): Drawn => ({
    key: `b:${block.resource}:${block.resourceId}:${block.date}:${block.kind}:${index}`,
    type: block.kind,
    date: block.date,
    startMinutes: block.start,
    endMinutes: block.end,
    lane: 0,
    laneCount: 1,
    cancelled: false,
    status: null,
    cancelCause: null,
    activity: false,
    subject: null,
    groups: [],
    room: null,
    teachers: [],
    hiddenTeachers: 0,
    label: block.label,
  });

  const rows = (
    entries: Array<{ id: string; name: string | null; detail: string | null }>,
    items: (id: string) => Drawn[],
  ): Row[] =>
    entries.map((entry) => {
      const byDate = new Map<string, Drawn[]>();
      for (const item of items(entry.id)) byDate.set(item.date, [...(byDate.get(item.date) ?? []), item]);
      for (const [date, list] of byDate) byDate.set(date, lanes(list));
      return { ...entry, kind, byDate };
    });

  if (kind === "GROUP") {
    const used = new Set(view.lessons.flatMap((lesson) => [lesson.groupId, ...lesson.extraGroupIds]));
    const classes = view.groups.filter((one) => one.kind === "CLASS" && one.halfOfId === null);
    const others = view.groups.filter((one) => !(one.kind === "CLASS" && one.halfOfId === null) && used.has(one.id));
    return rows(
      [...classes, ...others].map((one) => ({ id: one.id, name: one.name, detail: null })),
      (id) => view.lessons.filter((lesson) => lesson.groupId === id || lesson.extraGroupIds.includes(id)).map((lesson) => drawLesson(lesson, id)),
    );
  }
  if (kind === "TEACHER") {
    return rows(
      view.teachers.map((one) => ({ id: one.id, name: held.has(one.id) ? null : one.name, detail: null })),
      (id) => [
        ...view.lessons.filter((lesson) => lesson.teachers.some((one) => one.id === id)).map((lesson) => drawLesson(lesson, null)),
        ...view.blocks.filter((block) => block.resource === "TEACHER" && block.resourceId === id).map(drawBlock),
      ],
    );
  }
  return rows(
    view.rooms.map((one) => ({ id: one.id, name: one.name, detail: one.code })),
    (id) => [
      ...view.lessons.filter((lesson) => lesson.roomId === id).map((lesson) => drawLesson(lesson, null, id)),
      ...view.blocks.filter((block) => block.resource === "ROOM" && block.resourceId === id).map(drawBlock),
    ],
  );
}

/** Every teacher the answer names, as a row or on a lesson. */
export function namedTeacherIds(view: SchoolDayView): Set<string> {
  return new Set([...view.teachers.map((one) => one.id), ...view.lessons.flatMap((lesson) => lesson.teachers.map((one) => one.id))]);
}

/** The teachers the answer names that are among the marked: what a printout leaves out, and says how many. */
export function protectedAmong(view: SchoolDayView, marks: ReadonlySet<string>): Set<string> {
  return new Set([...namedTeacherIds(view)].filter((id) => marks.has(id)));
}

// ---------------------------------------------------------------------------
// Time axis
// ---------------------------------------------------------------------------

export interface Axis {
  start: number;
  end: number;
}

const MIN_AXIS: Axis = { start: 7 * 60, end: 16 * 60 };

/**
 * The day grid's time axis: whole hours around the lessons and the blocks
 * that are a stretch of the working day (a booking, a loan, a rastvakt, an uppdrag),
 * and never narrower than 07:00–16:00. An absence, a closure or an
 * unavailability is often the whole day (00:00–24:00) and would stretch the
 * axis over the night, so those are clipped to it instead.
 */
export function axisOf(view: SchoolDayView): Axis {
  let start = MIN_AXIS.start;
  let end = MIN_AXIS.end;
  const widen = (from: number, to: number) => {
    start = Math.min(start, Math.floor(from / 60) * 60);
    end = Math.max(end, Math.ceil(to / 60) * 60);
  };
  for (const lesson of view.lessons) widen(lesson.start, lesson.end);
  for (const block of view.blocks) {
    // A loan is a window of the working day, as a booking is; a closure is often the whole day.
    if (block.kind === "BOOKING" || block.kind === "LOAN" || block.kind === "PASS" || block.kind === "DUTY") widen(block.start, block.end);
  }
  return { start: Math.max(0, start), end: Math.min(24 * 60, end) };
}

/** Where an item sits on the axis, in percent of its width; null when it lies outside. */
export function placeOnAxis(item: { startMinutes: number; endMinutes: number }, axis: Axis): { left: number; width: number } | null {
  const from = Math.max(item.startMinutes, axis.start);
  const to = Math.min(item.endMinutes, axis.end);
  if (to <= from) return null;
  const span = axis.end - axis.start;
  return { left: ((from - axis.start) / span) * 100, width: ((to - from) / span) * 100 };
}

/** The whole hours on the axis, for its labels and lines. */
export function hoursOf(axis: Axis): number[] {
  const hours: number[] = [];
  for (let minute = axis.start; minute <= axis.end; minute += 60) hours.push(minute);
  return hours;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** A calendar date moved by whole days, in UTC so the clock change never moves it. */
export function shiftDay(date: string, days: number): string {
  const day = new Date(`${date}T00:00:00.000Z`);
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
}

/** ISO weekday of a date, 1 = Monday. */
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay() || 7;
}

/** Monday and Sunday of the ISO week of a date: the range a week is asked for. */
export function weekRange(date: string): { from: string; to: string } {
  const monday = shiftDay(date, 1 - weekdayOf(date));
  return { from: monday, to: shiftDay(monday, 6) };
}

/**
 * The days a week grid has a column for: Monday to Friday always, and a
 * Saturday or Sunday only when something is on it (a lesson, a block, a lov).
 */
export function weekColumns(view: SchoolDayView): GridDay[] {
  const busy = new Set<string>([...view.lessons.map((one) => one.date), ...view.blocks.map((one) => one.date)]);
  return view.days.filter((day) => day.weekday <= 5 || busy.has(day.date) || day.breaks.length > 0);
}

// ---------------------------------------------------------------------------
// Lov
// ---------------------------------------------------------------------------

/**
 * The lov that closes a row on a day, or null. A class is off school in a
 * HOLIDAY or a STAFF_DAY (the pupils are off in both) that covers it, the
 * whole school's or one narrowed to its årskurs; a teacher and a room are
 * closed only by a HOLIDAY of the whole school. A studiedag is the staff's
 * working day: no lesson, and no closure for them.
 */
export function breakOf(day: GridDay, row: Pick<Row, "id" | "kind">): BreakView | null {
  const found = day.breaks.filter((entry) => {
    if (row.kind === "GROUP") return entry.groupIds === null || entry.groupIds.includes(row.id);
    return entry.kind === "HOLIDAY" && entry.groupIds === null;
  });
  return found.find((entry) => entry.kind === "HOLIDAY") ?? found[0] ?? null;
}

/** The lov that closes the whole school on a day (a HOLIDAY with no årskurs span), or null. */
export function schoolClosure(day: GridDay): BreakView | null {
  return day.breaks.find((entry) => entry.kind === "HOLIDAY" && entry.groupIds === null) ?? null;
}

// ---------------------------------------------------------------------------
// The free finder
// ---------------------------------------------------------------------------

const pad = (value: number) => String(value).padStart(2, "0");

/** The finder's first interval: the hour that is on, and the hour after it (to 23:59 at the end of the day). */
export function defaultInterval(now: Date): { from: string; to: string } {
  const hour = now.getHours();
  return { from: `${pad(hour)}:00`, to: hour >= 23 ? "23:59" : `${pad(hour + 1)}:00` };
}

export const PRESETS = [
  { key: "morning", from: "08:00", to: "12:00" },
  { key: "lunch", from: "11:00", to: "13:00" },
  { key: "afternoon", from: "12:00", to: "17:00" },
] as const;

/** An interval is asked for when it is real: both times written and the end after the start. */
export function intervalError(from: string, to: string): "TIMES" | "ORDER" | null {
  const clock = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!clock.test(from) || !clock.test(to)) return "TIMES";
  return from < to ? null : "ORDER";
}

/** Whether the answer says nobody is free because the whole school is on lov. */
export function closedFor(free: Pick<FreeView, "breaks">): BreakView | null {
  return free.breaks.find((entry) => entry.kind === "HOLIDAY" && entry.groupIds === null) ?? null;
}

/** A studiedag of the whole school: a notice, the lists still stand. */
export function staffDayOf(free: Pick<FreeView, "breaks">): BreakView | null {
  return free.breaks.find((entry) => entry.kind === "STAFF_DAY" && entry.groupIds === null) ?? null;
}
