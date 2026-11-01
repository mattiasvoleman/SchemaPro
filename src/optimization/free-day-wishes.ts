import type { TeachingLesson } from '../common/teacher-day';
import type { AiEngineConflictDetail } from './interfaces/ai-engine-payload.interface';

/**
 * ÖNSKAD LEDIG DAG: WHICH WISHES A FINISHED RUN DID NOT KEEP.
 *
 * A teacher's work rule may wish one weekday free
 * (TeacherWorkRules.preferredFreeDayOfWeek, 20261123090000). The generator
 * pays for a lesson of theirs on that day and does not refuse a week over it:
 * a wish is soft, so it never reaches the refusals, and a school that is
 * never told which wishes were broken cannot tell a kept wish from one the
 * generator never saw. The engine's answer says nothing about it — only where
 * the lessons went — so the gateway reads the answer itself.
 *
 * KEPT MEANS NO LESSON OF THEIRS ON THAT WEEKDAY: not one they lead and not
 * one they co-teach, generated or kept from the last timetable (a locked or
 * hand-made lesson). A co-taught lesson takes the whole day as surely as one
 * they lead, as the rule counts it everywhere (src/common/teacher-day.ts). A
 * locked lesson on the wished day breaks the wish although the generator could
 * do nothing about it: the teacher is at school that day all the same, and the
 * sentence is the school's to act on — the lock is theirs. A wish on a day the
 * school has no lessons is kept, trivially, and so is the wish of a teacher
 * who teaches nothing.
 *
 * Staff-readable: the wish is on the work rule, beside the lunch and the rest,
 * and not on the post. Nothing here is masked.
 *
 * A SCHEMAFÖRSLAG IS READ THE SAME WAY, before anything is written: each
 * candidate's timetable (timetableWith) and the draft it was solved from,
 * measured when the run stores them (ScheduleCandidatesService), so the
 * comparison says which wishes each candidate breaks beside the draft's.
 *
 * WHOSE WISH IT IS IS THE TEACHER'S NAME, put beside the note when the run is
 * read (OptimizationJobsService, ScheduleCandidatesService, for every reader,
 * through stored-conflicts.ts's notesViewOf) and never into it. The
 * sentence says the day and nothing else: it named the work rule's id once,
 * as the lunch and rest sentences do, and no screen resolves a work rule's id
 * to a person, so a school read which wish broke and not whose. A name stored
 * in the note would outlive a rename and a gallring of the person in a copy
 * nothing updates; the teacher's Users id rides beside the note instead, in
 * the server-only `subjectIds` a days sentence keeps its teacher in.
 */

export const TEACHER_FREE_DAY_WISH_NOT_KEPT = 'TEACHER_FREE_DAY_WISH_NOT_KEPT' as const;

/** One teacher's wish, as their work rule states it. */
export interface FreeDayWish {
  /** The work rule's real id: the row the note is about, and its order among a day's. */
  ruleId: string;
  /** The teacher, whose lessons are looked for and whom the note is about. */
  userId: string;
  /** ISO weekday. */
  day: number;
}

/** A lesson of the finished timetable, by the two adults on it and its weekday. */
export interface TeachersOnDay {
  teacherId: string | null;
  coTeacherId: string | null;
  dayOfWeek: number;
}

/**
 * A lesson of the finished timetable with its hour and weeks: what Sammanhängande
 * undervisning reads (consecutive-wishes.ts) beside the two adults and the
 * weekday the free-day wishes read. Every place that builds the timetable
 * builds this, so a wish about the hour is never read off a row that has none.
 */
export interface TimedLesson extends TeachersOnDay {
  /** The master lesson's id, or for a lesson not written yet a key of its own. */
  id: string;
  /** Minutes since midnight. */
  startMinutes: number;
  endMinutes: number;
  recurrence: NonNullable<TeachingLesson['recurrence']>;
  /** 'YYYY-MM-DD', or null for the open end. */
  startDate: string | null;
  endDate: string | null;
}

/** 'HH:MM' or 'HH:MM:SS' as minutes since midnight. */
export function clockMinutes(value: string): number {
  const [hours, minutes] = value.split(':');
  return Number(hours) * 60 + Number(minutes);
}

/** The wall clock a @db.Time column holds (a Date anchored at 1970-01-01), as minutes since midnight. */
export function timeColumnMinutes(value: Date): number {
  return value.getUTCHours() * 60 + value.getUTCMinutes();
}

/** A @db.Date column as 'YYYY-MM-DD'. */
export function dateColumnDay(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

/**
 * The timetable a schemaförslag would leave, by teacher and weekday: the
 * lessons every candidate keeps (`kept`, the fetch's preserved, non-parked
 * lessons) and the candidate's own, each with its timplanspost's two adults —
 * exactly as the apply stamps a lesson it writes (writeRegeneration), so the
 * wishes a candidate is said to break are the ones its apply would. A lesson
 * whose post is not among `rows` is left out: the demand guard refuses an
 * answer with one before it is stored.
 */
export function timetableWith(
  kept: readonly TimedLesson[],
  rows: readonly {
    id: string;
    teacherId: string | null;
    coTeacherId: string | null;
    /** The window the apply stamps on a lesson it writes: the post's, never the engine's. */
    recurrence: TimedLesson['recurrence'];
    startDate: Date | null;
    endDate: Date | null;
  }[],
  /** A lesson of a shared post carries its own teacher (delade lektioner), as the apply writes it. */
  lessons: readonly {
    requirementId: string;
    dayOfWeek: number;
    startTime: string;
    endTime: string;
    teacherId?: string | null;
  }[],
): TimedLesson[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return [
    ...kept,
    ...lessons.flatMap((lesson): TimedLesson[] => {
      const row = byId.get(lesson.requirementId);
      return row === undefined
        ? []
        : [
            {
              id: `${lesson.requirementId}@${lesson.dayOfWeek}@${lesson.startTime}`,
              teacherId: lesson.teacherId !== undefined ? lesson.teacherId : row.teacherId,
              coTeacherId: row.coTeacherId,
              dayOfWeek: lesson.dayOfWeek,
              startMinutes: clockMinutes(lesson.startTime),
              endMinutes: clockMinutes(lesson.endTime),
              recurrence: row.recurrence,
              startDate: dateColumnDay(row.startDate),
              endDate: dateColumnDay(row.endDate),
            },
          ];
    }),
  ];
}

const WEEKDAYS: Record<number, string> = {
  1: 'Mondays',
  2: 'Tuesdays',
  3: 'Wednesdays',
  4: 'Thursdays',
  5: 'Fridays',
  6: 'Saturdays',
  7: 'Sundays',
};

/**
 * The catalogue's English for TEACHER_FREE_DAY_WISH_NOT_KEPT
 * (optimization-engine/app/messages.py), rendered here because the engine
 * never says it. The web renders the Swedish from the code and params; this is
 * what a screen falls back to.
 */
export function freeDayWishMessage(day: number): string {
  return (
    `A teacher wishes ${WEEKDAYS[day] ?? `day ${day}`} free, and the new timetable gives them ` +
    `lessons that day. A wish is weighed against the rest of the week and gives way where ` +
    `keeping it would cost more.`
  );
}

/**
 * Every wish the finished timetable breaks, as a conflict-shaped note: the
 * category of a teacher's own time (AVAILABILITY), the work rule as the one
 * resource, the teacher in `subjectIds` and nobody named yet. In weekday
 * order, then by rule, so two reads of one run say it in one order.
 */
export function unkeptFreeDayWishes(
  wishes: readonly FreeDayWish[],
  lessons: readonly TeachersOnDay[],
): AiEngineConflictDetail[] {
  // A lesson without a co-teacher adds "null" for the day, which no wish's
  // teacher (a Users id) ever is.
  const busy = new Set<string>();
  for (const lesson of lessons) {
    busy.add(`${lesson.teacherId}:${lesson.dayOfWeek}`);
    busy.add(`${lesson.coTeacherId}:${lesson.dayOfWeek}`);
  }
  return wishes
    .filter((wish) => busy.has(`${wish.userId}:${wish.day}`))
    .sort((a, b) => a.day - b.day || a.ruleId.localeCompare(b.ruleId))
    .map((wish) => ({
      category: 'AVAILABILITY',
      code: TEACHER_FREE_DAY_WISH_NOT_KEPT,
      params: { day: wish.day },
      message: freeDayWishMessage(wish.day),
      requirementIds: [],
      roomIds: [],
      constraintIds: [],
      resourceIds: [wish.ruleId],
      resourceNames: [],
      subjectIds: [wish.userId],
    }));
}
