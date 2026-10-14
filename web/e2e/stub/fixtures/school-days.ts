import type {
  AbsenceReport,
  AttendanceRecordRow,
  AvailabilityConstraint,
  CalendarLunch,
  CalendarRast,
  FrameTime,
  LeaveRequest,
  LunchServing,
  LunchSitting,
  Rast,
  RoomBooking,
  SchoolBreak,
  TeacherWorkRule,
} from "../../../lib/types";
import { KIND, uid } from "../sessions";
import { addDays, stockholmInstant, THIS_MONDAY, thisWeek, TODAY } from "./calendar";
import {
  ADMIN,
  CALENDAR_LESSONS,
  GROUP_LIST,
  GROUPS,
  GUARDIANS,
  ROOMS,
  STUDENT_LIST,
  STUDENTS,
  TEACHERS,
  YEAR,
} from "./world";

/**
 * The school's days, as the PostgREST tables the pages read directly: the
 * shape of a day (ramtider, raster, lunch), the dated meals and rasts of this
 * week, attendance, absence and leave, bookings, notices. world.ts holds the
 * people and the schedule these rows point at.
 */

// --- The shape of the day ----------------------------------------------------

export const FRAME_TIMES: FrameTime[] = [
  { id: uid(KIND.misc, 1001), minGradeLevel: 7, maxGradeLevel: 9, dayOfWeek: null, startTime: "08:10:00", endTime: "15:30:00", changeoverMinutes: 5 },
  { id: uid(KIND.misc, 1002), minGradeLevel: 7, maxGradeLevel: 9, dayOfWeek: 5, startTime: "08:10:00", endTime: "13:00:00", changeoverMinutes: 5 },
];

export const RASTS: Rast[] = [
  {
    id: uid(KIND.misc, 1011),
    name: "Förmiddagsrast",
    minGradeLevel: 7,
    maxGradeLevel: 9,
    dayOfWeek: null,
    startTime: "09:10:00",
    endTime: "09:25:00",
    requiresLessonBefore: false,
  },
  {
    id: uid(KIND.misc, 1012),
    name: "Eftermiddagsrast",
    minGradeLevel: 7,
    maxGradeLevel: 9,
    dayOfWeek: null,
    startTime: "14:00:00",
    endTime: "14:15:00",
    requiresLessonBefore: true,
  },
];

export const LUNCH_SERVINGS: LunchServing[] = [
  { id: uid(KIND.misc, 1021), minGradeLevel: 7, maxGradeLevel: 7, dayOfWeek: null, startTime: "11:40:00", endTime: "12:20:00", seats: 60 },
  { id: uid(KIND.misc, 1022), minGradeLevel: 8, maxGradeLevel: 9, dayOfWeek: null, startTime: "12:10:00", endTime: "12:50:00", seats: null },
];

export const TEACHER_WORK_RULES: TeacherWorkRule[] = [
  {
    id: uid(KIND.misc, 1031),
    userId: TEACHERS.anna.id,
    lunchMinutes: 30,
    lunchStartTime: "11:00:00",
    lunchEndTime: "13:00:00",
    minDailyRestMinutes: 660,
  },
];

export const CONSTRAINTS: AvailabilityConstraint[] = [
  {
    id: uid(KIND.constraint, 1),
    resourceType: "TEACHER",
    userId: TEACHERS.eva.id,
    roomId: null,
    studentGroupId: null,
    minGradeLevel: null,
    maxGradeLevel: null,
    dayOfWeek: 5,
    date: null,
    startTime: "08:00:00",
    endTime: "17:00:00",
    type: "UNAVAILABLE",
    reason: "Arbetar 80 %, ledig fredagar",
  },
  {
    id: uid(KIND.constraint, 2),
    resourceType: "ROOM",
    userId: null,
    roomId: ROOMS.gym.id,
    studentGroupId: null,
    minGradeLevel: null,
    maxGradeLevel: null,
    dayOfWeek: 3,
    date: null,
    startTime: "15:00:00",
    endTime: "17:00:00",
    type: "UNAVAILABLE",
    reason: "Uthyrd till föreningen",
  },
  {
    id: uid(KIND.constraint, 3),
    resourceType: "GRADE_LEVEL",
    userId: null,
    roomId: null,
    studentGroupId: null,
    minGradeLevel: 7,
    maxGradeLevel: 7,
    dayOfWeek: 1,
    date: null,
    startTime: "08:10:00",
    endTime: "09:10:00",
    type: "PREFERRED_BUSY",
    reason: null,
  },
];

/**
 * The Monday `weeks` weeks from this one, inside the läsår: ahead if a break
 * of `span` weeks fits before it ends, behind otherwise. The breaks never
 * fall in the current week, which every page shows, so a run in what would
 * be höstlov does not turn the week's lessons into a lov; and their weekdays
 * are always the same count.
 */
function breakMonday(weeks: number, span = 1): string {
  const ahead = addDays(THIS_MONDAY, 7 * weeks);
  return addDays(ahead, 7 * span) <= YEAR.endDate ? ahead : addDays(THIS_MONDAY, -7 * weeks);
}

const autumnBreak = breakMonday(3);
const winterBreak = breakMonday(7, 3);
const staffDay = addDays(breakMonday(11), 4);

export const SCHOOL_BREAKS: SchoolBreak[] = [
  {
    id: uid(KIND.misc, 1041),
    academicYearId: YEAR.id,
    name: "Höstlov",
    kind: "HOLIDAY",
    startDate: autumnBreak,
    endDate: addDays(autumnBreak, 4),
    minGradeLevel: null,
    maxGradeLevel: null,
  },
  {
    id: uid(KIND.misc, 1042),
    academicYearId: YEAR.id,
    name: "Jullov",
    kind: "HOLIDAY",
    startDate: winterBreak,
    endDate: addDays(winterBreak, 18),
    minGradeLevel: null,
    maxGradeLevel: null,
  },
  {
    id: uid(KIND.misc, 1043),
    academicYearId: YEAR.id,
    name: "Studiedag",
    kind: "STAFF_DAY",
    startDate: staffDay,
    endDate: staffDay,
    minGradeLevel: null,
    maxGradeLevel: null,
  },
];

// --- This week's meals and rasts, per class ------------------------------------

const CLASSES = GROUP_LIST.filter((group) => group.kind === "CLASS");

export const LUNCH_SITTINGS: LunchSitting[] = CLASSES.flatMap((group, groupIndex) =>
  [1, 2, 3, 4, 5].map((dayOfWeek) => ({
    id: uid(KIND.misc, 1100 + groupIndex * 10 + dayOfWeek),
    studentGroupId: group.id,
    dayOfWeek,
    startTime: group.gradeLevel === 7 ? "11:40:00" : "12:10:00",
    endTime: group.gradeLevel === 7 ? "12:10:00" : "12:40:00",
    headcount: 25,
    isGenerated: true,
  })),
);

export const CALENDAR_LUNCHES: CalendarLunch[] = LUNCH_SITTINGS.map((sitting) => {
  const date = thisWeek(sitting.dayOfWeek);
  return {
    id: uid(KIND.misc, 1200 + Number.parseInt(sitting.id.slice(-4), 16) % 1000),
    studentGroupId: sitting.studentGroupId,
    date,
    startsAt: stockholmInstant(date, sitting.startTime),
    endsAt: stockholmInstant(date, sitting.endTime),
  };
});

export const CALENDAR_RASTS: CalendarRast[] = CLASSES.flatMap((group, groupIndex) =>
  [1, 2, 3, 4, 5].map((dayOfWeek) => {
    const date = thisWeek(dayOfWeek);
    return {
      id: uid(KIND.misc, 1300 + groupIndex * 10 + dayOfWeek),
      studentGroupId: group.id,
      name: "Förmiddagsrast",
      date,
      startsAt: stockholmInstant(date, "09:10"),
      endsAt: stockholmInstant(date, "09:25"),
    };
  }),
);

// --- Who is in which group -----------------------------------------------------

export const GROUP_MEMBERS = [
  ...STUDENT_LIST.map((student) => ({ studentId: student.id, studentGroupId: student.studentGroupId! })),
  { studentId: STUDENTS.ella.id, studentGroupId: GROUPS.ma7.id },
  { studentId: STUDENTS.ines.id, studentGroupId: GROUPS.ma7.id },
  { studentId: STUDENTS.ella.id, studentGroupId: GROUPS.m2.id },
  { studentId: STUDENTS.maja.id, studentGroupId: GROUPS.m2.id },
  { studentId: STUDENTS.olivia.id, studentGroupId: GROUPS.m2.id },
];

// --- Attendance, absence, leave ------------------------------------------------

/** Every 7A lesson already held this week has a register: Jamal absent once, Ines late once. */
const heldFor7A = CALENDAR_LESSONS.filter(
  (lesson) => lesson.studentGroupId === GROUPS.g7A.id && lesson.status === "SCHEDULED" && lesson.date <= TODAY,
);
const pupilsOf7A = STUDENT_LIST.filter((student) => student.studentGroupId === GROUPS.g7A.id);

export const ATTENDANCE_RECORDS: AttendanceRecordRow[] = heldFor7A.flatMap((lesson, lessonIndex) =>
  pupilsOf7A.map((student, studentIndex) => ({
    id: uid(KIND.attendance, lessonIndex * 10 + studentIndex + 1),
    calendarLessonId: lesson.id,
    studentId: student.id,
    status:
      student.id === STUDENTS.jamal.id && lessonIndex === 0
        ? "ABSENT"
        : student.id === STUDENTS.ines.id && lessonIndex === 1
          ? "LATE"
          : "PRESENT",
    recordedAt: lesson.endsAt,
    note: student.id === STUDENTS.ines.id && lessonIndex === 1 ? "Kom tio minuter sent" : null,
  })),
);

export const ABSENCE_REPORTS: AbsenceReport[] = [
  // The office took Jamal's call on Monday: the register shows him ABSENT on
  // a lesson he was reported for, and the roster says so to the teacher.
  {
    id: uid(KIND.misc, 4001),
    studentId: STUDENTS.jamal.id,
    reportedById: ADMIN.id,
    date: thisWeek(1),
    startTime: null,
    endTime: null,
    type: "SICK",
    note: "Sjukanmäld per telefon",
    createdAt: stockholmInstant(thisWeek(1), "07:10"),
  },
  {
    id: uid(KIND.misc, 1401),
    studentId: STUDENTS.hugo.id,
    reportedById: GUARDIANS.sara.id,
    date: TODAY,
    startTime: null,
    endTime: null,
    type: "SICK",
    note: "Feber",
    createdAt: stockholmInstant(TODAY, "07:05"),
  },
  {
    id: uid(KIND.misc, 1402),
    studentId: STUDENTS.ella.id,
    reportedById: GUARDIANS.sara.id,
    date: addDays(TODAY, 2),
    startTime: "13:00:00",
    endTime: "15:00:00",
    type: "APPOINTMENT",
    note: "Tandläkare",
    createdAt: stockholmInstant(addDays(TODAY, -1), "18:30"),
  },
];

export const LEAVE_REQUESTS: LeaveRequest[] = [
  {
    id: uid(KIND.misc, 1501),
    studentId: STUDENTS.ella.id,
    requestedById: GUARDIANS.sara.id,
    startDate: addDays(TODAY, 21),
    endDate: addDays(TODAY, 23),
    reason: "Familjeresa till mormor",
    status: "PENDING",
    decidedById: null,
    decidedAt: null,
    decisionNote: null,
    createdAt: stockholmInstant(addDays(TODAY, -3), "20:00"),
  },
  {
    id: uid(KIND.misc, 1502),
    studentId: STUDENTS.hugo.id,
    requestedById: GUARDIANS.sara.id,
    startDate: addDays(TODAY, -30),
    endDate: addDays(TODAY, -30),
    reason: "Uppkörning för moped",
    status: "APPROVED",
    decidedById: ADMIN.id,
    decidedAt: stockholmInstant(addDays(TODAY, -35), "10:00"),
    decisionNote: null,
    createdAt: stockholmInstant(addDays(TODAY, -40), "19:00"),
  },
  {
    id: uid(KIND.misc, 1503),
    studentId: STUDENTS.ines.id,
    requestedById: GUARDIANS.tom.id,
    startDate: addDays(TODAY, 7),
    endDate: addDays(TODAY, 11),
    reason: "Resa",
    status: "PENDING",
    decidedById: null,
    decidedAt: null,
    decisionNote: null,
    createdAt: stockholmInstant(addDays(TODAY, -1), "21:15"),
  },
];

// --- Room bookings -------------------------------------------------------------

export const ROOM_BOOKINGS: RoomBooking[] = [
  {
    id: uid(KIND.misc, 1601),
    roomId: ROOMS.art.id,
    bookedById: TEACHERS.anna.id,
    title: "Temadag med 7A",
    startsAt: stockholmInstant(thisWeek(4), "13:00"),
    endsAt: stockholmInstant(thisWeek(4), "15:00"),
    status: "PENDING",
    decidedById: null,
    decidedAt: null,
    decisionNote: null,
    createdAt: stockholmInstant(addDays(TODAY, -2), "15:30"),
  },
  {
    id: uid(KIND.misc, 1602),
    roomId: ROOMS.r201.id,
    bookedById: TEACHERS.anna.id,
    title: "Föräldramöte 7A",
    startsAt: stockholmInstant(thisWeek(2), "18:00"),
    endsAt: stockholmInstant(thisWeek(2), "19:30"),
    status: "APPROVED",
    decidedById: ADMIN.id,
    decidedAt: stockholmInstant(addDays(TODAY, -6), "09:00"),
    decisionNote: null,
    createdAt: stockholmInstant(addDays(TODAY, -7), "16:00"),
  },
  {
    id: uid(KIND.misc, 1603),
    roomId: ROOMS.lab.id,
    bookedById: TEACHERS.cecilia.id,
    title: "Extra labb 9A",
    startsAt: stockholmInstant(thisWeek(5), "13:00"),
    endsAt: stockholmInstant(thisWeek(5), "14:30"),
    status: "REJECTED",
    decidedById: ADMIN.id,
    decidedAt: stockholmInstant(addDays(TODAY, -1), "08:30"),
    decisionNote: "Salen saneras den dagen",
    createdAt: stockholmInstant(addDays(TODAY, -4), "11:00"),
  },
];

// --- Notices -------------------------------------------------------------------

const notice = (n: number, userId: string, type: string, meta: Record<string, unknown>, readAt: string | null, daysAgo: number) => ({
  id: uid(KIND.misc, 1700 + n),
  userId,
  type,
  meta,
  readAt,
  createdAt: stockholmInstant(addDays(TODAY, -daysAgo), "07:30"),
});

const cancelled = CALENDAR_LESSONS.find((lesson) => lesson.status === "CANCELLED")!;

export const NOTIFICATIONS = [
  notice(1, GUARDIANS.sara.id, "LESSON_CANCELLED", { subjectName: "Svenska", startsAt: cancelled.startsAt }, null, 1),
  notice(2, GUARDIANS.sara.id, "LEAVE_DECIDED", { status: "APPROVED", studentName: "Hugo Nord", startDate: addDays(TODAY, -30), endDate: addDays(TODAY, -30) }, stockholmInstant(addDays(TODAY, -34), "20:00"), 35),
  notice(3, STUDENTS.ella.id, "LESSON_CANCELLED", { subjectName: "Svenska", startsAt: cancelled.startsAt }, null, 1),
  notice(4, TEACHERS.anna.id, "ROOM_BOOKING_DECIDED", { status: "APPROVED", roomName: ROOMS.r201.name, startsAt: stockholmInstant(thisWeek(2), "18:00") }, null, 6),
  notice(5, TEACHERS.anna.id, "TEACHER_ABSENCE_REPORTED", { teacherName: "Bo Ek", startsAt: stockholmInstant(thisWeek(1), "00:00"), endsAt: stockholmInstant(thisWeek(6), "00:00"), wholeDays: true }, null, 0),
  notice(6, ADMIN.id, "TEACHER_ABSENCE_REPORTED", { teacherName: "Bo Ek", startsAt: stockholmInstant(thisWeek(1), "00:00"), endsAt: stockholmInstant(thisWeek(6), "00:00"), wholeDays: true }, null, 0),
];

/** Who may take cover lessons: Eva, who has free hours. */
export const SUBSTITUTE_POOL = [{ id: uid(KIND.misc, 1801), userId: TEACHERS.eva.id }];
