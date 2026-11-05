/**
 * WHO STANDS BEFORE WHICH GROUP RIGHT NOW (Krisläge, F2).
 *
 * The roll call of an alarm starts from the timetable as the calendar holds it
 * at the moment the alarm is started, and the answers are the calendar's own:
 *
 *   * a lesson that is held (SCHEDULED or COMPLETED; a CANCELLED one, such as a
 *     lesson a schemabrytande aktivitet (D3) set off, is not) answers for the
 *     pupils on it while it is going on: its start is not after the moment and
 *     its end is after it;
 *   * the pupils are those lesson-roster.ts says attend it (one reader, as for
 *     the register and the notices), so a teaching group, a half class, a pupil
 *     named on the lesson and a replacing group (Ersättande grupper) are all as
 *     they are everywhere else, and the replacement lesson of an activity is a
 *     lesson like any other;
 *   * the teachers are the lesson's CalendarLessonTeachers rows, which are the
 *     truth: a vikarie that the cover board (or D4's first yes) put on the
 *     lesson has taken the absent teacher's row. A teacher who is away right
 *     now (an active absence) is left out, so a lesson whose teacher is away
 *     and which nobody covers has no teacher on the list and the administration
 *     answers for it;
 *   * in a break there is no lesson. A pupil who has a held lesson earlier the
 *     same day and another later the same day, with no more than MAX_BREAK_GAP_MS
 *     between them, is between the two: the group goes with the lesson it is
 *     going to (NEXT_LESSON), so the teacher who will meet them answers for
 *     them. A pupil with no lesson around the moment (before the first, after
 *     the last, or a gap longer than a break) is not on any list: the school
 *     does not know that they are in the building.
 *
 * The answer is per pupil, then gathered per lesson, so a group split across
 * lessons (half of 7A at slöjd, the other half at idrott) is two calls, each
 * with its own teacher, and a pupil is on exactly one call.
 *
 * Pure: the service reads the lessons, the rosters and the absences and hands
 * them here; nothing here reads a database.
 */

/** The longest gap between two lessons of a pupil that still counts as a break (lunch included). */
export const MAX_BREAK_GAP_MS = 120 * 60_000;

export type CallBasis = 'LESSON' | 'NEXT_LESSON';

/** A held lesson of the day as the service reads it. */
export interface DayLesson {
  id: string;
  startsAt: Date;
  endsAt: Date;
  /** The pupils on it (lesson-roster.ts). */
  roster: ReadonlySet<string>;
  teachers: readonly { teacherId: string; role: 'LEAD' | 'ASSISTANT' | 'SUBSTITUTE' }[];
}

export interface Call {
  lessonId: string;
  basis: CallBasis;
  /** The teachers who are not away at this moment. */
  teachers: readonly { teacherId: string; role: 'LEAD' | 'ASSISTANT' | 'SUBSTITUTE' }[];
  /** The pupils, sorted by id so that the snapshot is the same every time. */
  pupilIds: readonly string[];
}

const byStart = (a: DayLesson, b: DayLesson): number =>
  a.startsAt.getTime() - b.startsAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The calls at `now`. `away` are the teachers with an absence that covers the
 * moment. The calls come in lesson order (start, then id).
 */
export function callsAt(now: Date, lessons: readonly DayLesson[], away: ReadonlySet<string>, maxGapMs = MAX_BREAK_GAP_MS): Call[] {
  const at = now.getTime();
  const ordered = [...lessons].sort(byStart);
  const lessonsOf = new Map<string, DayLesson[]>();
  for (const lesson of ordered) {
    for (const pupilId of lesson.roster) {
      const list = lessonsOf.get(pupilId);
      if (list) list.push(lesson);
      else lessonsOf.set(pupilId, [lesson]);
    }
  }

  const assigned = new Map<string, { lesson: DayLesson; basis: CallBasis }>();
  for (const [pupilId, own] of lessonsOf) {
    const going = own.find((lesson) => lesson.startsAt.getTime() <= at && at < lesson.endsAt.getTime());
    if (going) {
      assigned.set(pupilId, { lesson: going, basis: 'LESSON' });
      continue;
    }
    let previous: DayLesson | undefined;
    let next: DayLesson | undefined;
    for (const lesson of own) {
      if (lesson.endsAt.getTime() <= at) previous = !previous || lesson.endsAt.getTime() >= previous.endsAt.getTime() ? lesson : previous;
      else if (lesson.startsAt.getTime() > at && !next) next = lesson;
    }
    if (previous && next && next.startsAt.getTime() - previous.endsAt.getTime() <= maxGapMs) {
      assigned.set(pupilId, { lesson: next, basis: 'NEXT_LESSON' });
    }
  }

  const calls = new Map<string, { lesson: DayLesson; basis: CallBasis; pupilIds: string[] }>();
  for (const [pupilId, { lesson, basis }] of assigned) {
    const key = `${lesson.id}:${basis}`;
    const call = calls.get(key);
    if (call) call.pupilIds.push(pupilId);
    else calls.set(key, { lesson, basis, pupilIds: [pupilId] });
  }
  return [...calls.values()]
    .sort((a, b) => byStart(a.lesson, b.lesson) || (a.basis < b.basis ? -1 : a.basis > b.basis ? 1 : 0))
    .map(({ lesson, basis, pupilIds }) => ({
      lessonId: lesson.id,
      basis,
      teachers: lesson.teachers.filter((teacher) => !away.has(teacher.teacherId)),
      pupilIds: pupilIds.sort(),
    }));
}

/** What the register of the day says of a pupil: the status of the latest lesson that has one. */
export type DayMark = 'PRESENT' | 'LATE' | 'ABSENT' | 'EXCUSED';

/** A mark made on a lesson that has started, with the lesson's start. */
export interface StartedMark {
  studentId: string;
  status: DayMark;
  lessonStartsAt: Date;
}

/** An absence a guardian reported, or a leave: a whole day, or a span of the day on the school's clock. */
export interface ReportedSpan {
  studentId: string;
  /** Null both: the whole day. */
  startsAt: Date | null;
  endsAt: Date | null;
}

export type PriorSource = 'ATTENDANCE' | 'REPORTED';

/**
 * Who was absent before the alarm. The register of the day wins where it
 * speaks: the latest mark (by the lesson's start) says present or late, and the
 * pupil is expected, whatever a report says; says absent or excused, and they
 * are absent since before (ATTENDANCE). Where it says nothing, a report or a
 * leave that covers the moment makes them absent (REPORTED).
 */
export function priorAbsences(now: Date, marks: readonly StartedMark[], reports: readonly ReportedSpan[]): Map<string, PriorSource> {
  const latest = new Map<string, StartedMark>();
  for (const mark of marks) {
    const seen = latest.get(mark.studentId);
    if (!seen || mark.lessonStartsAt.getTime() >= seen.lessonStartsAt.getTime()) latest.set(mark.studentId, mark);
  }
  const result = new Map<string, PriorSource>();
  for (const [studentId, mark] of latest) {
    if (mark.status === 'ABSENT' || mark.status === 'EXCUSED') result.set(studentId, 'ATTENDANCE');
  }
  const at = now.getTime();
  for (const report of reports) {
    if (latest.has(report.studentId) || result.has(report.studentId)) continue;
    const covers = report.startsAt === null || report.endsAt === null || (report.startsAt.getTime() <= at && at < report.endsAt.getTime());
    if (covers) result.set(report.studentId, 'REPORTED');
  }
  return result;
}
