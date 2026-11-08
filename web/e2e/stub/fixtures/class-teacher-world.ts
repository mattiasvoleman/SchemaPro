import type {
  AppointmentView,
  ChangeView,
  CheckRow,
  DraftRowView,
  MineView,
  OccasionView,
  OpenTimeView,
  TemplateLessonView,
  Verdict,
  WeekView,
} from "../../../lib/class-teacher";
import { KIND, uid } from "../sessions";
import { addDays, mondayOf, NOW, THIS_MONDAY, TODAY } from "./calendar";
import {
  ADMIN,
  CALENDAR_LESSON_TEACHERS,
  CALENDAR_LESSONS,
  GROUPS,
  MASTER_LESSONS,
  ROOM_LIST,
  ROOMS,
  SUBJECT_LIST,
  TEACHERS,
  YEAR,
  byId,
} from "./world";

/**
 * Klasslärarens schema (G5) as the gateway holds it, for the two gateway
 * files that answer it: gateway-class-teacher.ts (the klasslärare's own week,
 * /api/v1/class-teacher) and gateway-class-teachers.ts (the administrators'
 * four lists, /api/v1/class-teachers).
 *
 * Anna is klasslärare of 7A, so she has lessons of her own to move (Thursday's
 * mentor hour) and lessons that are not hers (every colleague's), and Wednesday's
 * cancelled Swedish and the two days already gone show the other ways a lesson
 * is shut. Eva's appointment to 8A has lapsed, the administrator who made it
 * having left. 7A has two drafts: the Tuesday English moved in the weekly
 * template, which the check passes but says would take two future lessons out
 * of the calendar (one of them with a homework on it), and the Thursday mentor
 * hour moved on its date, which the check finds a clash for. A clash is named by class, subject
 * and time, never by a teacher.
 *
 * Times are HH:MM, as the gateway sends them.
 */

const hhmm = (time: string) => time.slice(0, 5);
/** A 32-character hex digest, the shape of a lesson's `version`: one per lesson, the same wherever it is read. */
const versionOf = (id: string) => id.replace(/-/g, "");

const CLASS_7A = GROUPS.g7A;
const CLASS_8A = GROUPS.g8A;
const CLASS_9A = GROUPS.g9A;

export const APPOINTMENTS: AppointmentView[] = [
  {
    id: uid(KIND.misc, 9901),
    academicYearId: YEAR.id,
    studentGroupId: CLASS_7A.id,
    className: CLASS_7A.name,
    userId: TEACHERS.anna.id,
    teacherName: `${TEACHERS.anna.firstName} ${TEACHERS.anna.lastName}`,
    appointedByUserId: ADMIN.id,
    runs: true,
  },
  {
    id: uid(KIND.misc, 9902),
    academicYearId: YEAR.id,
    studentGroupId: CLASS_9A.id,
    className: CLASS_9A.name,
    userId: TEACHERS.bo.id,
    teacherName: `${TEACHERS.bo.firstName} ${TEACHERS.bo.lastName}`,
    appointedByUserId: ADMIN.id,
    runs: true,
  },
  {
    id: uid(KIND.misc, 9903),
    academicYearId: YEAR.id,
    studentGroupId: CLASS_8A.id,
    className: CLASS_8A.name,
    userId: TEACHERS.eva.id,
    teacherName: `${TEACHERS.eva.firstName} ${TEACHERS.eva.lastName}`,
    appointedByUserId: null,
    runs: false,
  },
];

/** Every class's hours (studentGroupId null) and, for 7A alone, Thursday afternoon. */
export const OPEN_TIMES: OpenTimeView[] = [
  ...[1, 2, 3, 4, 5].map(
    (dayOfWeek): OpenTimeView => ({
      id: uid(KIND.misc, 9910 + dayOfWeek),
      academicYearId: YEAR.id,
      studentGroupId: null,
      dayOfWeek,
      startTime: "08:00",
      endTime: "12:00",
    }),
  ),
  {
    id: uid(KIND.misc, 9920),
    academicYearId: YEAR.id,
    studentGroupId: CLASS_7A.id,
    dayOfWeek: 4,
    startTime: "13:00",
    endTime: "14:30",
  },
];

/** The school has not let a klasslärare publish; the schemaläggare does. */
export const SELF_PUBLISH = false;

const subjectName = (id: string) => byId(SUBJECT_LIST, id)?.name ?? "";
const MENTOR = MASTER_LESSONS.find((lesson) => lesson.studentGroupId === CLASS_7A.id && lesson.dayOfWeek === 4)!;
const ENGLISH = MASTER_LESSONS.find((lesson) => lesson.studentGroupId === CLASS_7A.id && lesson.dayOfWeek === 2 && lesson.teacherId === TEACHERS.anna.id)!;
const MENTOR_DATED = CALENDAR_LESSONS.find((lesson) => lesson.masterLessonId === MENTOR.id)!;

const author = TEACHERS.anna;

/** The Tuesday English moved a quarter of an hour later in the weekly template: nothing in its way. */
export const TEMPLATE_DRAFT: ChangeView = {
  id: uid(KIND.misc, 9930),
  studentGroupId: CLASS_7A.id,
  kind: "TEMPLATE_MOVE",
  status: "DRAFT",
  masterLessonId: ENGLISH.id,
  calendarLessonId: null,
  date: null,
  targetDate: null,
  targetDayOfWeek: 2,
  targetStart: "08:25",
  targetEnd: "09:25",
  targetRoomId: null,
  keepEnd: null,
  note: "Eleverna kommer från gymnastiken",
  baseVersion: versionOf(ENGLISH.id),
  rev: 1,
  authorId: author.id,
  createdAt: NOW,
  updatedAt: NOW,
  publishedAt: null,
};

/** Thursday's mentor hour moved to the afternoon of its own date, where the check finds a clash. */
export const OCCASION_DRAFT: ChangeView = {
  id: uid(KIND.misc, 9931),
  studentGroupId: CLASS_7A.id,
  kind: "OCCASION_MOVE",
  status: "DRAFT",
  masterLessonId: null,
  calendarLessonId: MENTOR_DATED.id,
  date: MENTOR_DATED.date,
  targetDate: MENTOR_DATED.date,
  targetDayOfWeek: null,
  targetStart: "13:00",
  targetEnd: "13:30",
  targetRoomId: null,
  keepEnd: null,
  note: null,
  baseVersion: versionOf(MENTOR_DATED.id),
  rev: 2,
  authorId: author.id,
  createdAt: NOW,
  updatedAt: NOW,
  publishedAt: null,
};

export const DRAFTS: ChangeView[] = [TEMPLATE_DRAFT, OCCASION_DRAFT];

const CLASH: Verdict = {
  state: "CONFLICT",
  conflicts: [
    {
      kind: "ROOM",
      other: {
        className: GROUPS.g7B.name,
        subjectName: "Matematik",
        date: MENTOR_DATED.date,
        start: "13:00",
        end: "14:00",
      },
    },
  ],
};

/** A move of the weekly template that takes lessons out of the published calendar: said before it is published. */
const REMOVES: Verdict = { state: "OK", removes: { lessons: 2, withLog: 1 } };

export const CHECK: CheckRow[] = [
  { change: TEMPLATE_DRAFT, verdict: REMOVES },
  { change: OCCASION_DRAFT, verdict: CLASH },
];

export const DRAFT_ROWS: DraftRowView[] = [
  {
    change: TEMPLATE_DRAFT,
    className: CLASS_7A.name,
    authorName: `${author.firstName} ${author.lastName}`,
    subjectName: subjectName(ENGLISH.subjectId),
    verdict: REMOVES,
  },
  {
    change: OCCASION_DRAFT,
    className: CLASS_7A.name,
    authorName: `${author.firstName} ${author.lastName}`,
    subjectName: subjectName(MENTOR.subjectId),
    verdict: CLASH,
  },
];

export const MINE: MineView = {
  classes: [{ id: CLASS_7A.id, name: CLASS_7A.name, academicYearId: YEAR.id }],
  selfPublish: SELF_PUBLISH,
};

/** Who teaches a dated lesson: Anna's are the only ones the klasslärare may touch. */
const teachesIt = (calendarLessonId: string) =>
  CALENDAR_LESSON_TEACHERS.some(
    (row) => row.calendarLessonId === calendarLessonId && row.teacherId === TEACHERS.anna.id && row.role === "LEAD",
  );

/** One week of 7A as the klasslärare reads it (src/class-teacher): the dated lessons only in the fixture school's own week. */
export function weekOf(from: string | null): WeekView {
  const weekStart = mondayOf(from ?? TODAY);
  const days = [0, 1, 2, 3, 4].map((offset) => addDays(weekStart, offset));

  const occasions: OccasionView[] =
    weekStart === THIS_MONDAY
      ? CALENDAR_LESSONS.filter((lesson) => lesson.studentGroupId === CLASS_7A.id).map((lesson) => {
          const source = MASTER_LESSONS.find((candidate) => candidate.id === lesson.masterLessonId)!;
          const mine = teachesIt(lesson.id);
          const draft = DRAFTS.find((one) => one.calendarLessonId === lesson.id);
          const refusal = !mine
            ? ("OTHER_TEACHER" as const)
            : lesson.status !== "SCHEDULED"
              ? ("NOT_SCHEDULED" as const)
              : lesson.date < TODAY
                ? ("PAST" as const)
                : null;
          return {
            id: lesson.id,
            date: lesson.date,
            start: hhmm(source.startTime),
            end: hhmm(source.endTime),
            status: lesson.status,
            subjectId: lesson.subjectId,
            subjectName: subjectName(lesson.subjectId),
            className: CLASS_7A.name,
            roomId: lesson.roomId,
            mine,
            version: versionOf(lesson.id),
            refusal,
            draftId: draft?.id ?? null,
          };
        })
      : [];

  const template: TemplateLessonView[] = MASTER_LESSONS.filter(
    (lesson) => lesson.studentGroupId === CLASS_7A.id && !lesson.isParked,
  ).map((lesson) => {
    const mine = lesson.teacherId === TEACHERS.anna.id && lesson.coTeacherId === null;
    const draft = DRAFTS.find((one) => one.masterLessonId === lesson.id);
    return {
      id: lesson.id,
      dayOfWeek: lesson.dayOfWeek,
      start: hhmm(lesson.startTime),
      end: hhmm(lesson.endTime),
      subjectId: lesson.subjectId,
      subjectName: subjectName(lesson.subjectId),
      className: CLASS_7A.name,
      roomId: lesson.roomId,
      recurrence: lesson.recurrence,
      mine,
      version: versionOf(lesson.id),
      refusal: mine ? null : ("OTHER_TEACHER" as const),
      draftId: draft?.id ?? null,
    };
  });

  return {
    classId: CLASS_7A.id,
    className: CLASS_7A.name,
    academicYearId: YEAR.id,
    weekStart,
    days,
    openTimes: OPEN_TIMES.filter((one) => one.studentGroupId === null || one.studentGroupId === CLASS_7A.id).map((one) => ({
      dayOfWeek: one.dayOfWeek,
      start: one.startTime,
      end: one.endTime,
    })),
    occasions,
    template,
    drafts: DRAFTS,
    rooms: ROOM_LIST.map((room) => ({
      id: room.id,
      name: room.name,
      refusal: room.id === ROOMS.art.id ? ("ROOM_NEEDS_APPROVAL" as const) : null,
    })),
    selfPublish: SELF_PUBLISH,
  };
}
