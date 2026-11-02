import { NO_TEACHER_DAY_RULE, teacherDayBreaches, type TeachingLesson } from '../common/teacher-day';
import type { AiEngineConflictDetail } from './interfaces/ai-engine-payload.interface';
import type { TimedLesson } from './free-day-wishes';
import {
  CONSECUTIVE_TEACHING_HIDDEN_MESSAGE,
  TEACHER_CONSECUTIVE_TEACHING_HIDDEN,
  TEACHER_CONSECUTIVE_TEACHING_NOT_KEPT,
  isStretchBearing,
} from './work-days';

/**
 * SAMMANHÄNGANDE UNDERVISNING: WHICH TEACHERS A FINISHED RUN LEFT OVER THEIR
 * LIMIT.
 *
 * A teacher's post may limit their teaching in a row to X minutes before Y
 * free (TeacherEmployments.maxConsecutiveTeachingMinutes and
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
 * (the lowest when several are as long) and its length. A school wants to
 * know that Eva still has four hours in a row on Tuesdays, not every stretch
 * of every week.
 *
 * THE LIMIT IS HR DATA, AND THE NOTE CARRIES NONE OF IT (work-days.ts). It is
 * the post's, beside the days, because it may be an arbetsanpassning after
 * sick leave. So the note keeps the weekday and the length of the longest
 * stretch — what the timetable itself shows — and the teacher's Users id in
 * the server-only `subjectIds`; not the limit, not the pause, not a post id,
 * and no name: the figures are read back from the post, and the teacher named,
 * when the run is read by someone with HR-läs, and everyone else is shown
 * TEACHER_CONSECUTIVE_TEACHING_HIDDEN (OptimizationJobsService). A schemaförslag
 * stores the hidden note itself (hideConsecutiveNotes), as it does a days
 * sentence.
 */

export { TEACHER_CONSECUTIVE_TEACHING_NOT_KEPT };

/** One teacher's limit, as their post states it. */
export interface ConsecutiveWish {
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
 * The English a note falls back to (optimization-engine/app/messages.py has
 * the catalogue's, with the limit in it; this one is what is STORED, so it
 * names the stretch and the weekday and not the limit). The web renders the
 * Swedish from the code and the params the reader is shown.
 */
export function consecutiveNoteMessage(params: { day: number; minutes: number }): string {
  return (
    `A teacher with a limit on teaching in a row has ${params.minutes} minutes in a row on ` +
    `${WEEKDAYS[params.day] ?? `day ${params.day}`} in the new timetable, over the limit. The generator tries ` +
    `to keep the limit but weighs it against the rest of the week, and gives way where keeping it would cost more.`
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
 * category of a teacher's own time (AVAILABILITY), the weekday and the length
 * of the longest stretch as the params, and the teacher in `subjectIds` and
 * nowhere else. In weekday order, then by teacher, so two reads of one run say
 * it in one order.
 */
export function unkeptConsecutiveWishes(
  wishes: readonly ConsecutiveWish[],
  lessons: readonly TimedLesson[],
): AiEngineConflictDetail[] {
  const notes: Array<{ userId: string; day: number; note: AiEngineConflictDetail }> = [];
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
    const params = { day: longest.dayOfWeek, minutes: longest.minutes };
    notes.push({
      userId: wish.userId,
      day: longest.dayOfWeek,
      note: {
        category: 'AVAILABILITY',
        code: TEACHER_CONSECUTIVE_TEACHING_NOT_KEPT,
        params,
        message: consecutiveNoteMessage(params),
        requirementIds: [],
        roomIds: [],
        constraintIds: [],
        resourceIds: [],
        resourceNames: [],
        subjectIds: [wish.userId],
      },
    });
  }
  return notes.sort((a, b) => a.day - b.day || a.userId.localeCompare(b.userId)).map((entry) => entry.note);
}

/**
 * The notes a schemaförslag stores: every note about a limit replaced by ONE
 * hidden note (TEACHER_CONSECUTIVE_TEACHING_HIDDEN), in the place of the first,
 * with no params, no teacher and no figure, for every reader — the candidate
 * page reads no post back (work-days.ts). No such note, no change.
 */
export function hideConsecutiveNotes(notes: readonly AiEngineConflictDetail[]): AiEngineConflictDetail[] {
  const out: AiEngineConflictDetail[] = [];
  let said = false;
  for (const note of notes) {
    if (!isStretchBearing(note.code)) {
      out.push(note);
    } else if (!said) {
      said = true;
      out.push({
        category: note.category,
        code: TEACHER_CONSECUTIVE_TEACHING_HIDDEN,
        params: {},
        message: CONSECUTIVE_TEACHING_HIDDEN_MESSAGE,
        requirementIds: [],
        roomIds: [],
        constraintIds: [],
        resourceIds: [],
        resourceNames: [],
      });
    }
  }
  return out;
}
