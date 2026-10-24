/**
 * A PASS DURING THE TEACHER'S OWN LESSON (Rastvaktsschema, 20261207090000):
 * the lessons of the grundschema a pass shares a minute with, on its weekday
 * and on a date both run. Nothing outside the rastvaktsschema reads the
 * passes yet — the generator places lessons over them and the vikarieförslag
 * offers the teacher during them — so the gateway says it when a pass is
 * written and when the schedule is read, and saves the pass all the same: a
 * school may move the lesson rather than the pass.
 *
 * A lesson is the teacher's when they teach it or co-teach it (teacherId,
 * coTeacherId). A parked lesson is on no week and clashes with nothing. A
 * lesson every other week clashes all the same: some week it is there.
 *
 * PURE. The service reads the rows and hands them in.
 */

export interface ClashShift {
  userId: string;
  dayOfWeek: number;
  /** Minutes from midnight, [start, end). */
  start: number;
  end: number;
  /** Inclusive yyyy-mm-dd, or null for the year's own bound. */
  validFrom: string | null;
  validTo: string | null;
}

export interface ClashLesson {
  teacherIds: readonly (string | null)[];
  dayOfWeek: number;
  start: number;
  end: number;
  /** Inclusive yyyy-mm-dd, or null for the year's own bound. */
  startDate: string | null;
  endDate: string | null;
  subject: string;
  group: string;
}

/** A lesson as the pass's warning names it. */
export interface LessonClash {
  subject: string;
  group: string;
  dayOfWeek: number;
  /** HH:MM */
  startTime: string;
  endTime: string;
}

const clock = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** Two inclusive date spans, null for an open end, that share a day. */
const datesMeet = (aFrom: string | null, aTo: string | null, bFrom: string | null, bTo: string | null) =>
  (aTo === null || bFrom === null || bFrom <= aTo) && (bTo === null || aFrom === null || aFrom <= bTo);

/** The lessons of `lessons` the pass runs during, in the order of the day. */
export function lessonClashesOf(shift: ClashShift, lessons: readonly ClashLesson[]): LessonClash[] {
  return lessons
    .filter(
      (lesson) =>
        lesson.teacherIds.includes(shift.userId) &&
        lesson.dayOfWeek === shift.dayOfWeek &&
        lesson.start < shift.end &&
        lesson.end > shift.start &&
        datesMeet(shift.validFrom, shift.validTo, lesson.startDate, lesson.endDate),
    )
    .sort((a, b) => a.start - b.start || a.end - b.end || a.subject.localeCompare(b.subject, 'sv'))
    .map((lesson) => ({
      subject: lesson.subject,
      group: lesson.group,
      dayOfWeek: lesson.dayOfWeek,
      startTime: clock(lesson.start),
      endTime: clock(lesson.end),
    }));
}
