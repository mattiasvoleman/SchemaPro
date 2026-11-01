import { NO_TEACHER_DAY_RULE, teacherDayBreaches, type TeachingLesson } from '../common/teacher-day';
import type { AiEngineConflictDetail } from './interfaces/ai-engine-payload.interface';
import type { TimedLesson } from './free-day-wishes';

/**
 * SAMMANHÄNGANDE UNDERVISNING: WHICH TEACHERS A FINISHED RUN LEFT OVER THEIR
 * LIMIT.
 *
 * A teacher's work rule may limit their teaching in a row to X minutes before
 * Y free (TeacherWorkRules.maxConsecutiveTeachingMinutes and
 * consecutiveBreakMinutes, 20261218090000). The generator TRIES: it pays for a
 * lesson whose stretch is not ended in time and refuses no week over it, only
 * where the school has turned that on (LunchSettings
 * .generatorKeepsConsecutiveTeaching). A wish is soft, so it never reaches the
 * refusals, and a school that is never told which teachers it did not manage
 * cannot tell a kept limit from one the generator never saw. The engine's
 * answer says nothing about it — only where the lessons went — so the gateway
 * reads the answer itself, exactly as it does the free-day wishes
 * (free-day-wishes.ts).
 *
 * KEPT MEANS NO STRETCH OF THEIRS LONGER THAN THE LIMIT, in any week the
 * timetable runs, by the one definition (src/common/stretch.ts) the hand edit
 * and the Vikarietavla count with: every lesson they are on, lead or
 * medlärare, generated or kept from the last timetable. A stretch made of
 * locked or hand-made lessons alone breaks the limit although the generator
 * could do nothing about it, and the sentence is the school's to act on — the
 * lock is theirs — as a locked lesson on a wished free day breaks the wish.
 * A teacher who teaches nothing keeps it trivially.
 *
 * ONE NOTE PER TEACHER, about their LONGEST stretch: the weekday it falls on
 * (the lowest when several are as long), its length, the limit and the pause.
 * A school wants to know that Eva still has four hours in a row on Tuesdays,
 * not every stretch of every week.
 *
 * Whose limit it is the teacher's name, put beside the note when the run is
 * read (OptimizationJobsService, ScheduleCandidatesService, through
 * stored-conflicts.ts's notesViewOf) and never into it, the way the free-day
 * wish is named: the sentence carries the figures and nothing that identifies
 * a person, and the teacher's Users id rides in the server-only `subjectIds`.
 * Staff-readable: the limit is on the work rule, beside the lunch and the
 * rest, and not on the post. Nothing here is masked.
 */

export const TEACHER_CONSECUTIVE_TEACHING_NOT_KEPT = 'TEACHER_CONSECUTIVE_TEACHING_NOT_KEPT' as const;

/** One teacher's limit, as their work rule states it. */
export interface ConsecutiveWish {
  /** The work rule's real id: the row the note is about, and its order among a day's. */
  ruleId: string;
  /** The teacher, whose lessons are looked for and whom the note is about. */
  userId: string;
  /** The most minutes of teaching in a row. */
  maxMinutes: number;
  /** The free time that ends a stretch. */
  breakMinutes: number;
}

/** The weekday names the catalogue's English uses. */
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
 * The catalogue's English for TEACHER_CONSECUTIVE_TEACHING_NOT_KEPT
 * (optimization-engine/app/messages.py), rendered here because the engine
 * never says it. The web renders the Swedish from the code and params; this is
 * what a screen falls back to.
 */
export function consecutiveWishMessage(params: {
  day: number;
  minutes: number;
  max: number;
  breakMinutes: number;
}): string {
  return (
    `A teacher should teach at most ${params.max} minutes in a row before ${params.breakMinutes} minutes ` +
    `free, and the new timetable gives them ${params.minutes} minutes in a row on ` +
    `${WEEKDAYS[params.day] ?? `day ${params.day}`}. The generator tries to keep the limit but weighs ` +
    `it against the rest of the week, and gives way where keeping it would cost more.`
  );
}

/** A lesson of the timetable as the day arithmetic reads it. */
const teaching = (lesson: TimedLesson): TeachingLesson => ({
  id: lesson.id,
  dayOfWeek: lesson.dayOfWeek,
  startMinutes: lesson.startMinutes,
  endMinutes: lesson.endMinutes,
  recurrence: lesson.recurrence,
  startDate: lesson.startDate,
  endDate: lesson.endDate,
});

/**
 * Every limit the finished timetable breaks, as a conflict-shaped note: the
 * category of a teacher's own time (AVAILABILITY), the work rule as the one
 * resource, the teacher in `subjectIds` and nobody named yet. In weekday
 * order, then by rule, so two reads of one run say it in one order.
 */
export function unkeptConsecutiveWishes(
  wishes: readonly ConsecutiveWish[],
  lessons: readonly TimedLesson[],
): AiEngineConflictDetail[] {
  const notes: Array<{ ruleId: string; day: number; note: AiEngineConflictDetail }> = [];
  for (const wish of wishes) {
    const mine = lessons
      .filter((lesson) => lesson.teacherId === wish.userId || lesson.coTeacherId === wish.userId)
      .map(teaching);
    const longest = teacherDayBreaches(
      {
        ...NO_TEACHER_DAY_RULE,
        maxConsecutiveTeachingMinutes: wish.maxMinutes,
        consecutiveBreakMinutes: wish.breakMinutes,
      },
      mine,
    )
      .flatMap((breach) => (breach.kind === 'CONSECUTIVE' ? [breach] : []))
      .sort((a, b) => b.minutes - a.minutes || a.dayOfWeek - b.dayOfWeek)[0];
    if (longest === undefined) continue;
    const params = {
      day: longest.dayOfWeek,
      minutes: longest.minutes,
      max: wish.maxMinutes,
      breakMinutes: wish.breakMinutes,
    };
    notes.push({
      ruleId: wish.ruleId,
      day: longest.dayOfWeek,
      note: {
        category: 'AVAILABILITY',
        code: TEACHER_CONSECUTIVE_TEACHING_NOT_KEPT,
        params,
        message: consecutiveWishMessage(params),
        requirementIds: [],
        roomIds: [],
        constraintIds: [],
        resourceIds: [wish.ruleId],
        resourceNames: [],
        subjectIds: [wish.userId],
      },
    });
  }
  return notes.sort((a, b) => a.day - b.day || a.ruleId.localeCompare(b.ruleId)).map((entry) => entry.note);
}
