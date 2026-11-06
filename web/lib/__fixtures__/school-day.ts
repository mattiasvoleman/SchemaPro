import type {
  BreakView,
  FreeView,
  GridBlock,
  GridDay,
  GridGroup,
  GridLesson,
  GridRoom,
  GridSubject,
  GridTeacher,
  SchoolDayAccess,
  SchoolDayView,
} from "@/lib/school-day";

/*
 * A school's Tuesday, as the gateway answers it (src/school-day), for the
 * view-model's and the pages' tests. 2026-11-03: a class with a lesson
 * overlapping another, a replacement lesson of an aktivitet over a class's
 * cancelled lessons, a språkval across two classes, a lesson with a teacher
 * the gateway left out, a booking, a closure, a rastvakt and an absence.
 */

export const ADMIN: SchoolDayAccess = { admin: true, grids: true, freeTeachers: true };
export const TEACHER_ALL: SchoolDayAccess = { admin: false, grids: true, freeTeachers: false };
export const TEACHER_ROOMS: SchoolDayAccess = { admin: false, grids: false, freeTeachers: false };

export const TUESDAY = "2026-11-03";

export const GROUPS: GridGroup[] = [
  { id: "g-7a", name: "7A", kind: "CLASS", gradeLevel: 7, halfOfId: null },
  { id: "g-9b", name: "9B", kind: "CLASS", gradeLevel: 9, halfOfId: null },
  { id: "g-7a-1", name: "7A-1", kind: "CLASS", gradeLevel: 7, halfOfId: "g-7a" },
  { id: "g-en7", name: "En7", kind: "TEACHING_GROUP", gradeLevel: null, halfOfId: null },
  { id: "g-ma9", name: "Ma9", kind: "TEACHING_GROUP", gradeLevel: null, halfOfId: null },
];

export const TEACHERS: GridTeacher[] = [
  { id: "t-1", name: "Anna Svensson" },
  { id: "t-2", name: "Bo Ek" },
  { id: "t-3", name: "Cecilia Ås" },
];

export const ROOMS: GridRoom[] = [
  { id: "r-12", name: "Sal 12", code: null },
  { id: "r-gym", name: "Gymnastiksalen", code: "G1" },
];

export const SUBJECTS: GridSubject[] = [
  { id: "s-ma", name: "Matematik" },
  { id: "s-en", name: "Engelska" },
  { id: "s-id", name: "Idrott" },
  { id: "s-fr", name: "Friluftsdag" },
];

export const lesson = (over: Partial<GridLesson> & Pick<GridLesson, "id" | "start" | "end" | "subjectId" | "groupId">): GridLesson => ({
  date: TUESDAY,
  status: "SCHEDULED",
  cancelCause: null,
  extraGroupIds: [],
  roomId: null,
  teachers: [],
  hiddenTeachers: 0,
  activity: false,
  ...over,
});

export const LESSONS: GridLesson[] = [
  lesson({ id: "l-1", start: 495, end: 540, subjectId: "s-ma", groupId: "g-7a", roomId: "r-12", teachers: [{ id: "t-1", role: "LEAD" }] }),
  // Overlaps l-1 in the same class: a double booking the grid must show, not hide.
  lesson({ id: "l-2", start: 510, end: 555, subjectId: "s-en", groupId: "g-7a", extraGroupIds: ["g-en7"], roomId: "r-12", teachers: [{ id: "t-2", role: "SUBSTITUTE" }] }),
  // Cancelled by an aktivitet, with the replacement lesson across it.
  lesson({ id: "l-3", start: 495, end: 540, subjectId: "s-id", groupId: "g-9b", roomId: "r-gym", status: "CANCELLED", cancelCause: "EVENT", teachers: [{ id: "t-3", role: "LEAD" }] }),
  lesson({ id: "l-4", start: 480, end: 900, subjectId: "s-fr", groupId: "g-9b", activity: true, teachers: [{ id: "t-3", role: "LEAD" }] }),
  // A teacher the gateway left out for a protected identity: a count, never a name.
  lesson({ id: "l-5", start: 600, end: 645, subjectId: "s-ma", groupId: "g-9b", roomId: "r-12", teachers: [], hiddenTeachers: 1 }),
  lesson({ id: "l-6", start: 660, end: 705, subjectId: "s-en", groupId: "g-7a", status: "RESCHEDULED", teachers: [{ id: "t-1", role: "LEAD" }] }),
];

export const BLOCKS: GridBlock[] = [
  { resource: "ROOM", resourceId: "r-12", date: TUESDAY, start: 780, end: 840, kind: "BOOKING", label: "Föräldramöte" },
  { resource: "TEACHER", resourceId: "t-1", date: TUESDAY, start: 780, end: 840, kind: "BOOKING", label: "Föräldramöte" },
  { resource: "ROOM", resourceId: "r-gym", date: TUESDAY, start: 720, end: 780, kind: "CLOSED", label: null },
  // Lent to another school of the huvudman in an approved window of a loan.
  { resource: "ROOM", resourceId: "r-gym", date: TUESDAY, start: 900, end: 960, kind: "LOAN", label: null },
  { resource: "TEACHER", resourceId: "t-2", date: TUESDAY, start: 595, end: 615, kind: "PASS", label: null },
  { resource: "TEACHER", resourceId: "t-3", date: TUESDAY, start: 0, end: 1440, kind: "ABSENT", label: null },
];

export const day = (date: string, breaks: BreakView[] = []): GridDay => ({
  date,
  weekday: new Date(`${date}T00:00:00.000Z`).getUTCDay() || 7,
  breaks,
});

export const HOLIDAY: BreakView = { name: "Höstlov", kind: "HOLIDAY", groupIds: null, minGradeLevel: null, maxGradeLevel: null };
export const STAFF_DAY: BreakView = { name: "Planering", kind: "STAFF_DAY", groupIds: null, minGradeLevel: null, maxGradeLevel: null };
export const PRAO: BreakView = { name: "Prao", kind: "HOLIDAY", groupIds: ["g-9b"], minGradeLevel: 9, maxGradeLevel: 9 };

export function view(over: Partial<SchoolDayView> = {}): SchoolDayView {
  return {
    from: TUESDAY,
    to: TUESDAY,
    timezone: "Europe/Stockholm",
    access: ADMIN,
    days: [day(TUESDAY)],
    groups: GROUPS,
    teachers: TEACHERS,
    rooms: ROOMS,
    subjects: SUBJECTS,
    lessons: LESSONS,
    blocks: BLOCKS,
    heldOut: { teachers: 0 },
    ...over,
  };
}

/** The week of the Tuesday: Monday to Sunday as the gateway is asked for it. */
export const WEEK_DAYS: GridDay[] = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"].map((date) => day(date));

export function free(over: Partial<FreeView> = {}): FreeView {
  return {
    date: TUESDAY,
    from: "10:00",
    to: "11:00",
    access: ADMIN,
    breaks: [],
    teachers: [
      { id: "t-1", name: "Anna Svensson" },
      { id: "t-2", name: "Bo Ek" },
    ],
    rooms: [{ id: "r-gym", name: "Gymnastiksalen", code: "G1" }],
    busyTeachers: [{ id: "t-3", name: "Cecilia Ås", reasons: ["ABSENT", "BUSY_LESSON"] }],
    busyRooms: [{ id: "r-12", name: "Sal 12", code: null, reasons: ["ROOM_IN_USE", "ROOM_BOOKED"] }],
    poolLeftOut: 0,
    heldOut: { teachers: 0 },
    rules: {
      teachers: ["ABSENT", "BUSY_LESSON", "BUSY_SUPERVISION", "BUSY_DUTY", "UNAVAILABLE", "BOOKED_ROOM", "POOL_NOT_DECLARED"],
      rooms: ["ROOM_IN_USE", "ROOM_BOOKED", "ROOM_CLOSED", "ROOM_LENT", "ROOM_BORROWED_OUTSIDE_LOAN"],
    },
    ...over,
  };
}
