import type {
  AppointmentView,
  ChangeView,
  DraftRowView,
  MineView,
  OccasionView,
  OpenTimeView,
  TemplateLessonView,
  WeekView,
} from "@/lib/class-teacher";

/*
 * A klasslärare's week as the gateway answers it (src/class-teacher), for the
 * helpers', the hooks' and the pages' tests. The week of Monday 2026-11-02:
 * a Tuesday lesson of the klasslärare's own that can be changed, a Monday
 * lesson with another teacher (locked), a Wednesday lesson already cancelled,
 * and the same Tuesday lesson in the weekly template, 90 minutes long.
 */

export const CLASS_ID = "c-3a";
export const YEAR_ID = "y-2026";
export const MONDAY = "2026-11-02";
export const DAYS = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"];
export const VERSION = "a".repeat(32);
export const NEWER_VERSION = "b".repeat(32);

export const ROOMS: WeekView["rooms"] = [
  { id: "r-12", name: "Sal 12", refusal: null },
  { id: "r-14", name: "Sal 14", refusal: null },
  { id: "r-gym", name: "Gymnastiksalen", refusal: "SHARED_ROOM" },
];

export const MINE: MineView = { classes: [{ id: CLASS_ID, name: "3A", academicYearId: YEAR_ID }], selfPublish: false };

export function occasion(patch: Partial<OccasionView> = {}): OccasionView {
  return {
    id: "o-ma",
    date: "2026-11-03",
    start: "09:00",
    end: "10:00",
    status: "SCHEDULED",
    subjectId: "s-ma",
    subjectName: "Matematik",
    className: "3A",
    roomId: "r-12",
    mine: true,
    version: VERSION,
    refusal: null,
    draftId: null,
    ...patch,
  };
}

export const OTHER_TEACHER = occasion({
  id: "o-sv",
  date: "2026-11-02",
  start: "08:00",
  end: "09:00",
  subjectId: "s-sv",
  subjectName: "Svenska",
  mine: false,
  refusal: "OTHER_TEACHER",
});

export const CANCELLED = occasion({
  id: "o-en",
  date: "2026-11-04",
  subjectId: "s-en",
  subjectName: "Engelska",
  status: "CANCELLED",
  refusal: "NOT_SCHEDULED",
});

export function templateLesson(patch: Partial<TemplateLessonView> = {}): TemplateLessonView {
  return {
    id: "m-ma",
    dayOfWeek: 2,
    start: "09:00",
    end: "10:30",
    subjectId: "s-ma",
    subjectName: "Matematik",
    className: "3A",
    roomId: "r-12",
    recurrence: "ALL_WEEKS",
    mine: true,
    version: VERSION,
    refusal: null,
    draftId: null,
    ...patch,
  };
}

export function draft(patch: Partial<ChangeView> = {}): ChangeView {
  return {
    id: "d-1",
    studentGroupId: CLASS_ID,
    kind: "OCCASION_MOVE",
    status: "DRAFT",
    masterLessonId: null,
    calendarLessonId: "o-ma",
    date: "2026-11-03",
    targetDate: "2026-11-04",
    targetDayOfWeek: null,
    targetStart: "10:00",
    targetEnd: "11:00",
    targetRoomId: null,
    keepEnd: null,
    note: null,
    baseVersion: VERSION,
    rev: 2,
    authorId: "u-me",
    createdAt: "2026-11-01T08:00:00.000Z",
    updatedAt: "2026-11-01T08:00:00.000Z",
    publishedAt: null,
    ...patch,
  };
}

export function week(patch: Partial<WeekView> = {}): WeekView {
  return {
    classId: CLASS_ID,
    className: "3A",
    academicYearId: YEAR_ID,
    weekStart: MONDAY,
    days: DAYS,
    openTimes: [1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, start: "08:00", end: "12:00" })),
    occasions: [OTHER_TEACHER, occasion(), CANCELLED],
    template: [templateLesson()],
    drafts: [],
    rooms: ROOMS,
    selfPublish: false,
    ...patch,
  };
}

// ---- the administrators' side ----

export function appointment(patch: Partial<AppointmentView> = {}): AppointmentView {
  return {
    id: "ap-1",
    academicYearId: YEAR_ID,
    studentGroupId: CLASS_ID,
    className: "3A",
    userId: "t-anna",
    teacherName: "Anna Svensson",
    appointedByUserId: "u-admin",
    runs: true,
    ...patch,
  };
}

export function openTime(patch: Partial<OpenTimeView> = {}): OpenTimeView {
  return {
    id: "ot-1",
    academicYearId: YEAR_ID,
    studentGroupId: null,
    dayOfWeek: 1,
    startTime: "08:00",
    endTime: "12:00",
    ...patch,
  };
}

export function draftRow(patch: Partial<DraftRowView> = {}): DraftRowView {
  return {
    change: draft(),
    className: "3A",
    authorName: "Anna Svensson",
    subjectName: "Matematik",
    verdict: { state: "OK" },
    ...patch,
  };
}
