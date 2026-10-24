import type {
  AcademicYear,
  CalendarLessonRow,
  MasterLesson,
  Person,
  Room,
  RoomType,
  School,
  StudentGroup,
  Subject,
  TeachingBlock,
  TeachingRequirement,
} from "../../../lib/types";
import { KIND, MULTI_GUARDIAN, PEOPLE, READER, uid } from "../sessions";
import {
  NEXT_YEAR_END,
  NEXT_YEAR_NAME,
  NEXT_YEAR_START,
  stockholmInstant,
  thisWeek,
  YEAR_END,
  YEAR_NAME,
  YEAR_START,
} from "./calendar";

/**
 * Exempelskolan: a made-up högstadium, small enough to read and big enough
 * that every page has rows to show. Every name is invented and every address
 * is on the reserved .example domain — the repository is public.
 *
 * This file is the school as the database holds it. tables.ts lays it out as
 * PostgREST tables, gateway.ts as the gateway's responses; a page that needs
 * a new kind of row gets it here first, so both doors agree.
 */

export const SCHOOL: School = {
  id: uid(KIND.school, 1),
  name: "Exempelskolan",
  slug: "exempelskolan",
  timezone: "Europe/Stockholm",
};

/**
 * Flera skolor per inloggning: the other school of MULTI_GUARDIAN, which only
 * the gateway's GET /api/v1/me/schools and that guardian's children there name.
 */
export const SECOND_SCHOOL: School = {
  id: uid(KIND.school, 2),
  name: "Granskolan",
  slug: "granskolan",
  timezone: "Europe/Stockholm",
};

export const YEAR: AcademicYear = {
  id: uid(KIND.year, 1),
  name: YEAR_NAME,
  startDate: YEAR_START,
  endDate: YEAR_END,
  isActive: true,
  predecessorId: null,
  graduatingGradeLevel: null,
};

/** The next läsår, rolled but not yet active — what /admin/years shows beside the current one. */
export const NEXT_YEAR: AcademicYear = {
  id: uid(KIND.year, 2),
  name: NEXT_YEAR_NAME,
  startDate: NEXT_YEAR_START,
  endDate: NEXT_YEAR_END,
  isActive: false,
  predecessorId: uid(KIND.year, 1),
  graduatingGradeLevel: 9,
};

// --- Groups ----------------------------------------------------------------

const group = (n: number, name: string, kind: StudentGroup["kind"], gradeLevel: number | null): StudentGroup => ({
  id: uid(KIND.group, n),
  academicYearId: YEAR.id,
  name,
  kind,
  gradeLevel,
});

export const GROUPS = {
  g7A: group(1, "7A", "CLASS", 7),
  g7B: group(2, "7B", "CLASS", 7),
  g8A: group(3, "8A", "CLASS", 8),
  g9A: group(4, "9A", "CLASS", 9),
  ma7: group(11, "Ma7 fördjupning", "TEACHING_GROUP", 7),
  m2: group(12, "Moderna språk spanska 7–9", "TEACHING_GROUP", null),
  m2fr: group(13, "Moderna språk franska 7", "TEACHING_GROUP", 7),
};
export const GROUP_LIST = Object.values(GROUPS);

/**
 * 7A split in halves for slöjd (Halvklasser), as "Dela klassen" leaves it:
 * teaching groups of the class's year and grade with halfOfId on the class.
 * Apart from GROUP_LIST, which the gateway fixtures (publication, sync,
 * staffing) read as the school's groups before anyone split one; the halves
 * have no lessons, so no screen but Klasser shows them.
 */
const half = (n: number, name: string, of: StudentGroup): StudentGroup => ({
  ...group(n, name, "TEACHING_GROUP", of.gradeLevel),
  halfOfId: of.id,
});
export const HALVES = {
  h7A1: half(21, "7A:1", GROUPS.g7A),
  h7A2: half(22, "7A:2", GROUPS.g7A),
};
export const HALF_LIST = Object.values(HALVES);

/**
 * A parallel block (#144): Språkval åk 7, whose two language groups are
 * placed at the same times. Its posts carry its id (REQUIREMENTS 11 and 13),
 * with the same lessons and weeks, as the database requires.
 */
export const BLOCKS: TeachingBlock[] = [{ id: uid(KIND.misc, 6001), academicYearId: uid(KIND.year, 1), name: "Språkval åk 7" }];

/**
 * NEXT_YEAR's classes, as the rollover made them, keyed by the class they
 * come from: each promoted a grade, 9A graduating. Not PostgREST rows yet;
 * the activation preview and the projected rosters name them.
 */
const nextClass = (n: number, name: string, gradeLevel: number) => ({ id: uid(KIND.group, 200 + n), name, gradeLevel });
export const NEXT_CLASSES: Record<string, { id: string; name: string; gradeLevel: number }> = {
  [GROUPS.g7A.id]: nextClass(1, "8A", 8),
  [GROUPS.g7B.id]: nextClass(2, "8B", 8),
  [GROUPS.g8A.id]: nextClass(3, "9A", 9),
};

// --- Rooms -------------------------------------------------------------------

export const ROOM_TYPES: RoomType[] = [
  { id: uid(KIND.roomType, 1), name: "Klassrum", legacyKey: "CLASSROOM", _count: { rooms: 3, subjects: 0 } },
  { id: uid(KIND.roomType, 2), name: "Idrottshall", legacyKey: "GYM", _count: { rooms: 1, subjects: 1 } },
  { id: uid(KIND.roomType, 3), name: "NO-sal", legacyKey: "LAB", _count: { rooms: 1, subjects: 1 } },
  { id: uid(KIND.roomType, 4), name: "Bildsal", legacyKey: null, _count: { rooms: 1, subjects: 1 } },
];

const room = (n: number, name: string, code: string, capacity: number, type: number, extra: Partial<Room> = {}): Room => ({
  id: uid(KIND.room, n),
  name,
  code,
  capacity,
  roomTypeId: uid(KIND.roomType, type),
  minGradeLevel: null,
  maxGradeLevel: null,
  requiresApproval: false,
  building: "Hus A",
  floor: 1,
  siteId: null,
  ...extra,
});

export const ROOMS = {
  r101: room(1, "Sal 101", "101", 30, 1),
  r102: room(2, "Sal 102", "102", 30, 1),
  r201: room(3, "Sal 201", "201", 28, 1, { floor: 2 }),
  gym: room(4, "Idrottshallen", "IH", 60, 2, { building: "Hus B", floor: 0 }),
  lab: room(5, "NO-salen", "NO1", 28, 3, { floor: 2 }),
  art: room(6, "Bildsalen", "BL", 24, 4, { requiresApproval: true }),
};
export const ROOM_LIST = Object.values(ROOMS);

// --- Subjects ----------------------------------------------------------------

const subject = (
  n: number,
  name: string,
  code: string,
  color: string,
  nationalCode: string | null,
  extra: Partial<Subject> = {},
): Subject => ({
  id: uid(KIND.subject, n),
  name,
  code,
  color,
  requiredRoomTypeId: null,
  nationalCode,
  countsTowardTimplan: true,
  loadFactor: 1,
  maxLessonsPerDay: null,
  minDaysBetween: null,
  ...extra,
});

export const SUBJECTS = {
  sv: subject(1, "Svenska", "SV", "#2563eb", "SV_SVA"),
  ma: subject(2, "Matematik", "MA", "#dc2626", "MA", { maxLessonsPerDay: 1 }),
  en: subject(3, "Engelska", "EN", "#16a34a", "EN"),
  no: subject(4, "Biologi", "BI", "#0d9488", "BI", { requiredRoomTypeId: uid(KIND.roomType, 3) }),
  so: subject(5, "Historia", "HI", "#9333ea", "HI"),
  idh: subject(6, "Idrott och hälsa", "IDH", "#ea580c", "IDH", { requiredRoomTypeId: uid(KIND.roomType, 2) }),
  bl: subject(7, "Bild", "BL", "#db2777", "BL", { requiredRoomTypeId: uid(KIND.roomType, 4) }),
  m2: subject(8, "Moderna språk", "M2", "#ca8a04", "M2"),
  mentor: subject(9, "Mentorstid", "MEN", "#64748b", null, { countsTowardTimplan: false }),
};
export const SUBJECT_LIST = Object.values(SUBJECTS);

// --- People ------------------------------------------------------------------

const person = (
  id: string,
  role: Person["role"],
  firstName: string,
  lastName: string,
  email: string,
  extra: Partial<Person> = {},
): Person => ({
  id,
  role,
  firstName,
  lastName,
  email,
  phone: null,
  isActive: true,
  invitedAt: "2026-08-10T09:00:00.000Z",
  studentGroupId: null,
  ...extra,
});

export const ADMIN = person(PEOPLE.admin.userId, "SCHOOL_ADMIN", "Rut", "Rektorsson", PEOPLE.admin.email);

export const TEACHERS = {
  anna: person(PEOPLE.teacher.userId, "TEACHER", "Anna", "Lind", PEOPLE.teacher.email, { phone: "070-000 00 01" }),
  bo: person(uid(KIND.user, 102), "TEACHER", "Bo", "Ek", "bo.ek@exempelskolan.example"),
  cecilia: person(uid(KIND.user, 103), "TEACHER", "Cecilia", "Ås", "cecilia.as@exempelskolan.example"),
  david: person(uid(KIND.user, 104), "TEACHER", "David", "Berg", "david.berg@exempelskolan.example"),
  eva: person(uid(KIND.user, 105), "TEACHER", "Eva", "Holm", "eva.holm@exempelskolan.example", { invitedAt: null }),
  filip: person(uid(KIND.user, 106), "TEACHER", "Filip", "Strand", "filip.strand@exempelskolan.example", {
    isActive: false,
  }),
};
export const TEACHER_LIST = Object.values(TEACHERS);

const pupil = (n: number, firstName: string, lastName: string, groupId: string, id = uid(KIND.user, 300 + n)) =>
  person(id, "STUDENT", firstName, lastName, `${firstName.toLowerCase()}.${n}@elev.exempelskolan.example`, {
    studentGroupId: groupId,
  });

export const STUDENTS = {
  ella: { ...pupil(1, "Ella", "Nord", GROUPS.g7A.id, PEOPLE.student.userId), email: PEOPLE.student.email },
  hugo: pupil(2, "Hugo", "Nord", GROUPS.g9A.id),
  ines: pupil(3, "Ines", "Vik", GROUPS.g7A.id),
  jamal: pupil(4, "Jamal", "Sjö", GROUPS.g7A.id),
  klara: pupil(5, "Klara", "Dal", GROUPS.g7B.id),
  leo: pupil(6, "Leo", "Mo", GROUPS.g7B.id),
  maja: pupil(7, "Maja", "Lund", GROUPS.g8A.id),
  noah: pupil(8, "Noah", "Ström", GROUPS.g8A.id),
  olivia: pupil(9, "Olivia", "Fors", GROUPS.g9A.id),
};
export const STUDENT_LIST = Object.values(STUDENTS);

export const GUARDIANS = {
  sara: person(PEOPLE.guardian.userId, "GUARDIAN", "Sara", "Nord", PEOPLE.guardian.email, { phone: "070-000 00 09" }),
  tom: person(uid(KIND.user, 502), "GUARDIAN", "Tom", "Vik", "tom.vik@exempelskolan.example"),
};
export const GUARDIAN_LIST = Object.values(GUARDIANS);

/** Sara has two children at the school, in different years. */
export const GUARDIAN_LINKS = [
  { id: uid(KIND.misc, 1), guardianId: GUARDIANS.sara.id, studentId: STUDENTS.ella.id },
  { id: uid(KIND.misc, 2), guardianId: GUARDIANS.sara.id, studentId: STUDENTS.hugo.id },
  { id: uid(KIND.misc, 3), guardianId: GUARDIANS.tom.id, studentId: STUDENTS.ines.id },
];

export const ALL_PEOPLE: Person[] = [ADMIN, ...TEACHER_LIST, ...STUDENT_LIST, ...GUARDIAN_LIST];

/** The profile row getSession reads: Users plus the authId the session is keyed by. */
export const PROFILE_ROWS = [
  { ...ADMIN, authId: PEOPLE.admin.authId, schoolId: SCHOOL.id },
  { ...TEACHERS.anna, authId: PEOPLE.teacher.authId, schoolId: SCHOOL.id },
  { ...STUDENTS.ella, authId: PEOPLE.student.authId, schoolId: SCHOOL.id },
  { ...GUARDIANS.sara, authId: PEOPLE.guardian.authId, schoolId: SCHOOL.id },
  // The guardian with a second school: Sara's row at this one.
  { ...GUARDIANS.sara, authId: MULTI_GUARDIAN.authId, schoolId: SCHOOL.id },
  // The läsare: read-only, and only here, so no page lists it.
  {
    ...person(READER.userId, "SCHOOL_ADMIN", "Lisa", "Läsare", READER.email),
    authId: READER.authId,
    schoolId: SCHOOL.id,
    adminProfile: "LASARE" as const,
    hrRead: false,
  },
];

// --- Requirements and the weekly schedule ------------------------------------

const requirement = (
  n: number,
  subjectId: string,
  studentGroupId: string,
  teacherId: string | null,
  lessonsPerWeek: number,
  minutesPerLesson: number,
  extra: Partial<TeachingRequirement> = {},
): TeachingRequirement => ({
  id: uid(KIND.requirement, n),
  academicYearId: YEAR.id,
  subjectId,
  studentGroupId,
  teacherId,
  coTeacherId: null,
  lessonsPerWeek,
  minutesPerLesson,
  lessonLengths: [],
  minutesBefore: 0,
  minutesAfter: 0,
  teacherLoadPercent: 100,
  coTeacherLoadPercent: 100,
  ownDistribution: false,
  maxLessonsPerDay: null,
  minDaysBetween: null,
  recurrence: "ALL_WEEKS",
  startDate: null,
  endDate: null,
  ...extra,
});

export const REQUIREMENTS: TeachingRequirement[] = [
  requirement(1, SUBJECTS.sv.id, GROUPS.g7A.id, TEACHERS.anna.id, 3, 60),
  requirement(2, SUBJECTS.ma.id, GROUPS.g7A.id, TEACHERS.bo.id, 3, 60),
  requirement(3, SUBJECTS.en.id, GROUPS.g7A.id, TEACHERS.anna.id, 2, 60),
  requirement(4, SUBJECTS.idh.id, GROUPS.g7A.id, TEACHERS.david.id, 2, 60, { minutesBefore: 10, minutesAfter: 15 }),
  requirement(5, SUBJECTS.no.id, GROUPS.g7A.id, TEACHERS.cecilia.id, 2, 60),
  requirement(6, SUBJECTS.sv.id, GROUPS.g7B.id, TEACHERS.anna.id, 3, 60),
  requirement(7, SUBJECTS.ma.id, GROUPS.g7B.id, TEACHERS.bo.id, 3, 60),
  requirement(8, SUBJECTS.so.id, GROUPS.g8A.id, TEACHERS.eva.id, 2, 60),
  requirement(9, SUBJECTS.bl.id, GROUPS.g8A.id, null, 1, 80),
  requirement(10, SUBJECTS.ma.id, GROUPS.g9A.id, TEACHERS.bo.id, 3, 60, { coTeacherId: TEACHERS.cecilia.id, coTeacherLoadPercent: 50 }),
  requirement(11, SUBJECTS.m2.id, GROUPS.m2.id, TEACHERS.cecilia.id, 2, 50, {
    lessonLengths: [60, 40],
    minutesPerLesson: 60,
    blockId: BLOCKS[0]!.id,
  }),
  requirement(12, SUBJECTS.mentor.id, GROUPS.g7A.id, TEACHERS.anna.id, 1, 30),
  requirement(13, SUBJECTS.m2.id, GROUPS.m2fr.id, TEACHERS.eva.id, 2, 50, {
    lessonLengths: [60, 40],
    minutesPerLesson: 60,
    blockId: BLOCKS[0]!.id,
  }),
];

const master = (
  n: number,
  subjectId: string,
  studentGroupId: string,
  teacherId: string | null,
  roomId: string | null,
  dayOfWeek: number,
  startTime: string,
  endTime: string,
  extra: Partial<MasterLesson> = {},
): MasterLesson => ({
  id: uid(KIND.masterLesson, n),
  academicYearId: YEAR.id,
  subjectId,
  studentGroupId,
  teacherId,
  coTeacherId: null,
  roomId,
  dayOfWeek,
  startTime,
  endTime,
  isLocked: false,
  isParked: false,
  recurrence: "ALL_WEEKS",
  startDate: null,
  endDate: null,
  extraGroupIds: [],
  studentIds: [],
  ...extra,
});

const { g7A, g7B, g8A, g9A } = GROUPS;
const { anna, bo, cecilia, david, eva } = TEACHERS;

export const MASTER_LESSONS: MasterLesson[] = [
  master(1, SUBJECTS.sv.id, g7A.id, anna.id, ROOMS.r101.id, 1, "08:10:00", "09:10:00", { isLocked: true }),
  master(2, SUBJECTS.ma.id, g7A.id, bo.id, ROOMS.r101.id, 1, "09:25:00", "10:25:00"),
  master(3, SUBJECTS.idh.id, g7A.id, david.id, ROOMS.gym.id, 1, "13:00:00", "14:00:00"),
  master(4, SUBJECTS.en.id, g7A.id, anna.id, ROOMS.r101.id, 2, "08:10:00", "09:10:00"),
  master(5, SUBJECTS.no.id, g7A.id, cecilia.id, ROOMS.lab.id, 2, "09:25:00", "10:25:00"),
  master(6, SUBJECTS.sv.id, g7A.id, anna.id, ROOMS.r101.id, 3, "10:40:00", "11:40:00"),
  master(7, SUBJECTS.ma.id, g7A.id, bo.id, ROOMS.r101.id, 3, "13:00:00", "14:00:00"),
  master(8, SUBJECTS.mentor.id, g7A.id, anna.id, ROOMS.r101.id, 4, "08:10:00", "08:40:00"),
  master(9, SUBJECTS.sv.id, g7B.id, anna.id, ROOMS.r102.id, 1, "10:40:00", "11:40:00"),
  master(10, SUBJECTS.ma.id, g7B.id, bo.id, ROOMS.r102.id, 2, "13:00:00", "14:00:00"),
  master(11, SUBJECTS.so.id, g8A.id, eva.id, ROOMS.r201.id, 2, "08:10:00", "09:10:00"),
  master(12, SUBJECTS.ma.id, g9A.id, bo.id, ROOMS.r201.id, 4, "09:25:00", "10:25:00", { coTeacherId: cecilia.id }),
  master(13, SUBJECTS.bl.id, g8A.id, null, ROOMS.art.id, 5, "10:40:00", "12:00:00", { isParked: true }),
  // Språkval åk 7's hour, both groups at once (Block i schemat): one card on
  // the grundschema. Laid after the last publication, so the draft has them
  // and no dated lesson does (UNPUBLISHED).
  master(14, SUBJECTS.m2.id, GROUPS.m2.id, cecilia.id, ROOMS.r102.id, 4, "10:40:00", "11:40:00"),
  master(15, SUBJECTS.m2.id, GROUPS.m2fr.id, eva.id, ROOMS.r201.id, 4, "10:40:00", "11:40:00"),
];

/** Grundschema lessons the draft adds and no publication has dated yet (misc-publication.ts). */
export const UNPUBLISHED = new Set([uid(KIND.masterLesson, 14), uid(KIND.masterLesson, 15)]);

/** This week's dated lessons, published from the weekly schedule (the parked and the unpublished never are). */
export const CALENDAR_LESSONS: Array<CalendarLessonRow & { masterLessonId: string; academicYearId: string }> =
  MASTER_LESSONS.filter((lesson) => !lesson.isParked && !UNPUBLISHED.has(lesson.id)).map((lesson, index) => {
    const date = thisWeek(lesson.dayOfWeek);
    return {
      id: uid(KIND.calendarLesson, index + 1),
      masterLessonId: lesson.id,
      academicYearId: YEAR.id,
      subjectId: lesson.subjectId,
      studentGroupId: lesson.studentGroupId,
      roomId: lesson.roomId,
      date,
      startsAt: stockholmInstant(date, lesson.startTime),
      endsAt: stockholmInstant(date, lesson.endTime),
      // Wednesday's Swedish is cancelled, so every page has one of those too.
      status: lesson.id === uid(KIND.masterLesson, 6) ? "CANCELLED" : "SCHEDULED",
      note: lesson.id === uid(KIND.masterLesson, 6) ? "Studiebesök på stadsbiblioteket" : null,
    };
  });

/** Who teaches each dated lesson: the lead, and the co-teacher as ASSISTANT. */
export const CALENDAR_LESSON_TEACHERS = CALENDAR_LESSONS.flatMap((lesson, index) => {
  const source = MASTER_LESSONS.find((candidate) => candidate.id === lesson.masterLessonId)!;
  const rows = [];
  if (source.teacherId) {
    rows.push({ id: uid(KIND.misc, 100 + index), calendarLessonId: lesson.id, teacherId: source.teacherId, role: "LEAD" });
  }
  if (source.coTeacherId) {
    rows.push({ id: uid(KIND.misc, 200 + index), calendarLessonId: lesson.id, teacherId: source.coTeacherId, role: "ASSISTANT" });
  }
  return rows;
});

export const byId = <T extends { id: string }>(rows: T[], id: string | null | undefined) =>
  rows.find((row) => row.id === id) ?? null;
