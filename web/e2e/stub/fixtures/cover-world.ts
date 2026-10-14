import type { Absence, AbsenceReason, CoverDecisionKind, CoverSettings, PoolWindow } from "../../../lib/cover-types";
import { KIND, uid } from "../sessions";
import { addDays, stockholmInstant, THIS_MONDAY, thisWeek } from "./calendar";
import { ADMIN, CALENDAR_LESSON_TEACHERS, CALENDAR_LESSONS, MASTER_LESSONS, TEACHERS, YEAR } from "./world";

/**
 * Vikarieplanering at Exempelskolan: who is away, and what the school decided
 * for each lesson they would have taught. gateway-cover.ts derives the board,
 * the register's counts, the counter and the hours from these rows the way
 * the gateway derives them from its tables, so every page tells one story:
 *
 *   - Bo is off sick all week. Eva covers Monday's maths, Wednesday's is
 *     självstudier under tillsyn, Anna covers Thursday's (the co-taught 9A),
 *     and Tuesday's is still open — PASSED once it has ended.
 *   - Anna is on a course on Wednesday, when 7A's Swedish was already
 *     cancelled for the study visit, and away next Monday afternoon: PLANNED
 *     whichever day the suite runs, so her own page always has one.
 *   - Four weeks ago Cecilia was home with a sick child and David took her
 *     Biology: the ended absence, the term's counter and last month's hours.
 */

/** Ids in the misc kind from 0xc000, clear of world.ts's and school-days.ts's. */
const coverId = (n: number) => uid(KIND.misc, 0xc000 + n);

// --- The school's reasons and settings ------------------------------------------

const reason = (n: number, builtin: string | null, label: string | null, sortOrder: number, archived = false): AbsenceReason => ({
  id: coverId(n),
  builtin,
  label,
  sortOrder,
  archived,
});

/** The five the gateway seeds (sortOrder 10–50), one of the school's own and one it archived. */
export const REASONS = {
  sick: reason(1, "SICK", null, 10),
  childCare: reason(2, "CHILD_CARE", null, 20),
  workTravel: reason(3, "WORK_TRAVEL", null, 30),
  course: reason(4, "PROFESSIONAL_DEVELOPMENT", null, 40),
  other: reason(5, "OTHER", null, 50),
  union: reason(6, null, "Facklig verksamhet", 500),
  wellness: reason(7, null, "Friskvårdstimme", 510, true),
};
export const REASON_LIST = Object.values(REASONS);

/** Self-report on, so /teacher/franvaro offers Anmäl, Avsluta and Återkalla too. */
export const COVER_SETTINGS: CoverSettings = { poolPreference: "NEUTRAL", teacherSelfReport: true };

// --- The absences --------------------------------------------------------------

/** An absence as stored; the view's phase, selfReported and counts are derived from it. */
export type StoredAbsence = Omit<Absence, "phase" | "selfReported" | "counts"> & { createdById: string };

type Period = Pick<StoredAbsence, "startsAt" | "endsAt" | "wholeDays">;

/** Whole days end at the midnight after the last one (teacher-absences.service.ts periodOf). */
const wholeDays = (from: string, to: string): Period => ({
  startsAt: stockholmInstant(from, "00:00"),
  endsAt: stockholmInstant(addDays(to, 1), "00:00"),
  wholeDays: true,
});

const absence = (
  n: number,
  userId: string,
  period: Period,
  reasonId: string | null,
  createdById: string,
  createdAt: string,
): StoredAbsence => ({ id: coverId(100 + n), userId, ...period, reasonId, status: "ACTIVE", createdById, createdAt });

const NEXT_MONDAY = addDays(THIS_MONDAY, 7);
const EARLIER_TUESDAY = addDays(THIS_MONDAY, -27);

export const ABSENCES = {
  bo: absence(
    1,
    TEACHERS.bo.id,
    wholeDays(thisWeek(1), thisWeek(5)),
    REASONS.sick.id,
    TEACHERS.bo.id,
    stockholmInstant(thisWeek(1), "06:40"),
  ),
  annaCourse: absence(
    2,
    TEACHERS.anna.id,
    wholeDays(thisWeek(3), thisWeek(3)),
    REASONS.course.id,
    ADMIN.id,
    stockholmInstant(addDays(THIS_MONDAY, -6), "10:00"),
  ),
  annaAfternoon: absence(
    3,
    TEACHERS.anna.id,
    { startsAt: stockholmInstant(NEXT_MONDAY, "12:00"), endsAt: stockholmInstant(NEXT_MONDAY, "16:30"), wholeDays: false },
    REASONS.union.id,
    TEACHERS.anna.id,
    stockholmInstant(addDays(THIS_MONDAY, -3), "15:10"),
  ),
  cecilia: absence(
    4,
    TEACHERS.cecilia.id,
    wholeDays(EARLIER_TUESDAY, EARLIER_TUESDAY),
    REASONS.childCare.id,
    ADMIN.id,
    stockholmInstant(EARLIER_TUESDAY, "07:20"),
  ),
};
export const ABSENCE_LIST = Object.values(ABSENCES);

// --- The lessons the cover reads know ------------------------------------------

/** This week's lesson made from weekly-schedule lesson n. */
const dated = (n: number) => CALENDAR_LESSONS.find((lesson) => lesson.masterLessonId === uid(KIND.masterLesson, n))!;

const tuesdayBiology = MASTER_LESSONS.find((lesson) => lesson.id === uid(KIND.masterLesson, 5))!;

/** Cecilia's Biology with 7A four weeks ago: before this week's calendar, so only the cover reads have it. */
const earlierBiology: (typeof CALENDAR_LESSONS)[number] = {
  id: uid(KIND.calendarLesson, 0x105),
  masterLessonId: tuesdayBiology.id,
  academicYearId: YEAR.id,
  subjectId: tuesdayBiology.subjectId,
  studentGroupId: tuesdayBiology.studentGroupId,
  roomId: tuesdayBiology.roomId,
  date: EARLIER_TUESDAY,
  startsAt: stockholmInstant(EARLIER_TUESDAY, tuesdayBiology.startTime),
  endsAt: stockholmInstant(EARLIER_TUESDAY, tuesdayBiology.endTime),
  status: "SCHEDULED",
  note: null,
};

type LessonTeacherRow = (typeof CALENDAR_LESSON_TEACHERS)[number];

const EARLIER_LESSON_TEACHERS: LessonTeacherRow[] = [
  { id: coverId(0x205), calendarLessonId: earlierBiology.id, teacherId: TEACHERS.cecilia.id, role: "LEAD" },
];

// --- The decisions ---------------------------------------------------------------

export interface CoverDecision {
  absenceId: string;
  lessonId: string;
  decision: CoverDecisionKind;
  substituteId: string | null;
  decidedAt: string;
}

const decided = (
  absenceId: string,
  lessonId: string,
  decision: CoverDecisionKind,
  substituteId: string | null,
  decidedAt: string,
): CoverDecision => ({ absenceId, lessonId, decision, substituteId, decidedAt });

/** Bo's Tuesday maths with 7B has none: the board's one open lesson. */
export const DECISIONS: CoverDecision[] = [
  decided(ABSENCES.bo.id, dated(2).id, "SUBSTITUTE", TEACHERS.eva.id, stockholmInstant(thisWeek(1), "07:05")),
  decided(ABSENCES.bo.id, dated(7).id, "SUPERVISED_STUDY", null, stockholmInstant(thisWeek(1), "07:10")),
  decided(ABSENCES.bo.id, dated(12).id, "SUBSTITUTE", TEACHERS.anna.id, stockholmInstant(thisWeek(1), "07:15")),
  decided(ABSENCES.cecilia.id, earlierBiology.id, "SUBSTITUTE", TEACHERS.david.id, stockholmInstant(EARLIER_TUESDAY, "07:35")),
];

// --- The calendar as the decisions left it ---------------------------------------

/** cover-decisions.ts SUPERVISED_STUDY_NOTE: the decision writes it into the lesson's note. */
const SUPERVISED_STUDY_NOTE = "Självstudier under tillsyn";

const absentTeacherOf = new Map(ABSENCE_LIST.map((row) => [row.id, row.userId]));

/**
 * Lesson teachers after cover (cover.service.ts decide): every decision but a
 * cancel takes the absent teacher off the lesson, and a substitute is put on
 * it as SUBSTITUTE.
 */
function afterCover(rows: LessonTeacherRow[]): LessonTeacherRow[] {
  const lessons = new Set(rows.map((row) => row.calendarLessonId));
  const removed = (row: LessonTeacherRow) =>
    DECISIONS.some(
      (decision) =>
        decision.decision !== "CANCELLED" &&
        decision.lessonId === row.calendarLessonId &&
        absentTeacherOf.get(decision.absenceId) === row.teacherId,
    );
  const substitutes = DECISIONS.flatMap((decision, index) =>
    decision.substituteId && lessons.has(decision.lessonId)
      ? [
          {
            id: coverId(0x300 + index),
            calendarLessonId: decision.lessonId,
            teacherId: decision.substituteId,
            role: "SUBSTITUTE",
          },
        ]
      : [],
  );
  return [...rows.filter((row) => !removed(row)), ...substitutes];
}

/**
 * This week's CalendarLessonTeachers and CalendarLessons as the decisions left
 * them — what tables.ts serves for the two tables, so Anna's week (and "Mina
 * vikariepass") has her Thursday cover and the day planner the substitutes.
 */
export const CALENDAR_LESSON_TEACHERS_WITH_COVER = afterCover(CALENDAR_LESSON_TEACHERS);

const supervised = new Set(DECISIONS.filter((row) => row.decision === "SUPERVISED_STUDY").map((row) => row.lessonId));

export const CALENDAR_LESSONS_WITH_COVER = CALENDAR_LESSONS.map((lesson) =>
  supervised.has(lesson.id) ? { ...lesson, note: SUPERVISED_STUDY_NOTE } : lesson,
);

/** Every dated lesson the cover reads know, and who is on each now and was before any decision. */
export const COVER_LESSONS = [...CALENDAR_LESSONS_WITH_COVER, earlierBiology];
export const COVER_LESSON_TEACHERS = afterCover([...CALENDAR_LESSON_TEACHERS, ...EARLIER_LESSON_TEACHERS]);
export const PLANNED_LESSON_TEACHERS = [...CALENDAR_LESSON_TEACHERS, ...EARLIER_LESSON_TEACHERS];

// --- The pool --------------------------------------------------------------------

/** Eva, the pool's one member (school-days.ts), joined when the läsår began. */
export const POOL_JOINED = stockholmInstant(YEAR.startDate, "09:00");

/** Eva's windows: Mondays, and Wednesday mornings. */
export const POOL_WINDOWS: PoolWindow[] = [
  { id: coverId(0x401), userId: TEACHERS.eva.id, date: null, dayOfWeek: 1, startTime: "08:00", endTime: "16:00" },
  { id: coverId(0x402), userId: TEACHERS.eva.id, date: null, dayOfWeek: 3, startTime: "08:00", endTime: "12:00" },
];
