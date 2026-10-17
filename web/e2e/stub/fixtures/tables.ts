import type { Row, Tables } from "../postgrest";
import type { SignedInPerson } from "../sessions";
import { CALENDAR_LESSON_TEACHERS_WITH_COVER, CALENDAR_LESSONS_WITH_COVER } from "./cover-world";
import {
  ABSENCE_REPORTS,
  ATTENDANCE_RECORDS,
  CALENDAR_LUNCHES,
  CALENDAR_RASTS,
  CONSTRAINTS,
  FRAME_TIMES,
  GROUP_MEMBERS,
  LEAVE_REQUESTS,
  LUNCH_SERVINGS,
  LUNCH_SITTINGS,
  NOTIFICATIONS,
  RASTS,
  ROOM_BOOKINGS,
  SCHOOL_BREAKS,
  SUBSTITUTE_POOL,
  TEACHER_WORK_RULES,
} from "./school-days";
import {
  ALL_PEOPLE,
  BLOCKS,
  byId,
  GROUP_LIST,
  GUARDIAN_LINKS,
  HALF_LIST,
  MASTER_LESSONS,
  NEXT_YEAR,
  PROFILE_ROWS,
  REQUIREMENTS,
  ROOM_LIST,
  SCHOOL,
  STUDENT_LIST,
  SUBJECT_LIST,
  YEAR,
} from "./world";

/**
 * The school as PostgREST tables, keyed by the table name the app's
 * `supabase.from(…)` calls use. Rows are plain, as in the database; the stub
 * resolves embeds itself (postgrest.ts). A table the app reads that is not
 * here answers as a stub miss, which fails the signed-in suites.
 */

const withSchool = <T extends object>(rows: T[]) => rows.map((row) => ({ ...row, schoolId: SCHOOL.id }));

/**
 * Users: every person, and on the four signed-in ones the authId getSession
 * looks them up by; and the läsare's own row, which only its session reads
 * (the pages read people through the gateway, not this table).
 */
const users = [
  ...ALL_PEOPLE.map((person) => {
    const profile = PROFILE_ROWS.find((row) => row.id === person.id);
    return { ...person, schoolId: SCHOOL.id, authId: profile?.authId ?? null };
  }),
  ...PROFILE_ROWS.filter((row) => !ALL_PEOPLE.some((person) => person.id === row.id)),
];

export const tables: Tables = {
  Schools: [SCHOOL],
  Users: users,
  AcademicYears: withSchool([YEAR, NEXT_YEAR]),
  StudentGroups: withSchool([...GROUP_LIST, ...HALF_LIST]),
  Subjects: withSchool(SUBJECT_LIST),
  Rooms: withSchool(ROOM_LIST),
  TeachingRequirements: withSchool(REQUIREMENTS),
  TeachingBlocks: withSchool(BLOCKS),
  MasterLessons: withSchool(
    MASTER_LESSONS.map(({ extraGroupIds: _groups, studentIds: _students, ...lesson }) => lesson),
  ),
  MasterLessonGroups: MASTER_LESSONS.flatMap((lesson) =>
    lesson.extraGroupIds.map((studentGroupId) => ({ masterLessonId: lesson.id, studentGroupId })),
  ),
  MasterLessonStudents: MASTER_LESSONS.flatMap((lesson) =>
    lesson.studentIds.map((studentId) => ({ masterLessonId: lesson.id, studentId })),
  ),
  // As this week's cover decisions leave them (cover-world.ts): Bo off his
  // decided lessons, the substitutes on, the självstudier in the note.
  CalendarLessons: withSchool(CALENDAR_LESSONS_WITH_COVER),
  CalendarLessonTeachers: CALENDAR_LESSON_TEACHERS_WITH_COVER,
  GuardianStudents: withSchool(GUARDIAN_LINKS),
  StudentGroupMembers: GROUP_MEMBERS,
  AvailabilityConstraints: withSchool(CONSTRAINTS.map((row, index) => ({ ...row, createdAt: `2026-08-1${index}T08:00:00Z` }))),
  FrameTimes: withSchool(FRAME_TIMES),
  Rasts: withSchool(RASTS),
  LunchServings: withSchool(LUNCH_SERVINGS),
  TeacherWorkRules: withSchool(TEACHER_WORK_RULES),
  SchoolBreaks: withSchool(SCHOOL_BREAKS),
  LunchSittings: withSchool(LUNCH_SITTINGS),
  CalendarLunches: withSchool(CALENDAR_LUNCHES),
  CalendarRasts: withSchool(CALENDAR_RASTS),
  AttendanceRecords: withSchool(ATTENDANCE_RECORDS),
  AbsenceReports: withSchool(ABSENCE_REPORTS),
  LeaveRequests: withSchool(LEAVE_REQUESTS),
  RoomBookings: withSchool(ROOM_BOOKINGS),
  Notifications: withSchool(NOTIFICATIONS),
  SubstitutePoolMembers: withSchool(SUBSTITUTE_POOL),
};

/**
 * What RLS leaves a pupil or a guardian of the family tables: their own rows,
 * or their children's. Staff read the school's. Without it a guardian's page
 * listed another family's absence under the name "—".
 */
const own = (person: SignedInPerson) => {
  if (person.persona === "student") return new Set([person.userId]);
  return new Set(GUARDIAN_LINKS.filter((link) => link.guardianId === person.userId).map((link) => link.studentId));
};

/** The home classes of `own`: app.current_user_group_id(), app.current_guardian_class_ids(). */
const classesOf = (person: SignedInPerson) =>
  new Set([...own(person)].map((id) => byId(STUDENT_LIST, id)?.studentGroupId).filter((id): id is string => !!id));

/** The classes and the teaching groups (StudentGroupMembers) of `own`. */
const groupsOf = (person: SignedInPerson) =>
  new Set([
    ...classesOf(person),
    ...GROUP_MEMBERS.filter((member) => own(person).has(member.studentId)).map((member) => member.studentGroupId),
  ]);

/**
 * A dated lesson as the pupil's and the guardian's arms on CalendarLessons
 * read it (20260822120000, 20261013090000): the lesson's group is one of
 * theirs, an extra group on it is, or it names the pupil. A pupil's extra
 * group is their class alone (calendar_lessons_participant_select); a
 * guardian's is any of the children's groups. The extra groups and the
 * named pupils are the weekly lesson's, as a publish copies them.
 */
function lessonReaches(row: Row, person: SignedInPerson): boolean {
  if (groupsOf(person).has(row.studentGroupId as string)) return true;
  const weekly = byId(MASTER_LESSONS, row.masterLessonId as string);
  const extraGroups = person.persona === "student" ? classesOf(person) : groupsOf(person);
  return (
    (weekly?.extraGroupIds ?? []).some((id) => extraGroups.has(id)) ||
    (weekly?.studentIds ?? []).some((id) => own(person).has(id))
  );
}

export const rowScopes: Partial<Record<string, (row: Row, person: SignedInPerson) => boolean>> = {
  AbsenceReports: (row, person) => own(person).has(row.studentId as string),
  LeaveRequests: (row, person) => own(person).has(row.studentId as string),
  AttendanceRecords: (row, person) => own(person).has(row.studentId as string),
  GuardianStudents: (row, person) =>
    person.persona === "student" ? row.studentId === person.userId : row.guardianId === person.userId,
  // The week: a pupil's lessons, lunches and raster, or the children's. Without
  // these a 7A pupil's Mitt schema showed 7B's, 8A's and 9A's lessons too.
  CalendarLessons: lessonReaches,
  CalendarLunches: (row, person) => classesOf(person).has(row.studentGroupId as string),
  CalendarRasts: (row, person) => classesOf(person).has(row.studentGroupId as string),
};
