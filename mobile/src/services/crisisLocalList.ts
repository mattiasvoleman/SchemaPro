import { LOCAL_CALL_PREFIX, countPupils, type CallBasis, type MyCall, type PupilView } from './crisis';
import { localDate } from '../i18n/format';
import { compareSwedish } from '../utils/sorting';
import type { CalendarLesson } from '../types';

/**
 * THE LIST THE PHONE BUILDS WHEN NO LIST CAME (Krisläge, F2).
 *
 * The alarm's push reached the phone but the list did not: no coverage when it
 * started. The teacher still has to count, so the screen builds a list from
 * what the phone already holds of the day (the lessons and pupils cached when
 * the register was opened, services/roster.ts), by the SAME RULE the gateway
 * takes its snapshot by (src/crisis/crisis-calls.ts, callsAt):
 *
 *   * the lesson that is going on at the moment answers for its pupils (LESSON);
 *   * in a break the group goes with the lesson the pupil is going to
 *     (NEXT_LESSON), so the teacher who will meet them answers for them, but only
 *     when there is a lesson earlier the same day and another later the same
 *     day with no more than MAX_BREAK_GAP_MS between them;
 *   * a pupil with no lesson around the moment (before the first, after the
 *     last, a gap longer than a break) is on no list.
 *
 * A group split across lessons is two calls, and a pupil is on exactly one.
 *
 * What this cannot know, it leaves empty rather than guess: the group's name
 * (the cache holds subject and room), the colleagues, the kind of alarm, and
 * who was absent before it except from the register this teacher took
 * themselves (`absent`). A lesson the school cancelled after it was cached is
 * not known to be cancelled. The marks made on this list name the LESSON, and
 * the gateway finds its call; a pupil the gateway does not have on that call
 * is refused and the mark dropped (services/crisisQueue.ts).
 *
 * "Found with me" (a pupil on no list of the teacher's) is not offered on this
 * list: the picker asks the gateway about the alarm, and this list has no alarm
 * of the gateway's to ask about.
 *
 * Pure: the caller reads the cache and hands it here.
 */

/** The longest gap between two lessons of a pupil that still counts as a break (lunch included). */
export const MAX_BREAK_GAP_MS = 120 * 60_000;

/** A pupil of the cache. */
export interface CachedPupil {
  readonly id: string;
  readonly displayName: string;
}

interface Placed {
  readonly lesson: CalendarLesson;
  readonly basis: CallBasis;
}

const startOf = (lesson: CalendarLesson): number => Date.parse(lesson.startTime);
const endOf = (lesson: CalendarLesson): number => Date.parse(lesson.endTime);

const byStart = (a: CalendarLesson, b: CalendarLesson): number =>
  startOf(a) - startOf(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The calls at `now`, from the lessons the phone holds. `names` is the cache's
 * pupils, `absent` the pupils this teacher marked absent in the register of a
 * lesson (by lesson id), who are shown as absent since before.
 */
export function localCalls(
  now: Date,
  lessons: readonly CalendarLesson[],
  names: ReadonlyMap<string, string>,
  absent: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
  maxGapMs: number = MAX_BREAK_GAP_MS,
): MyCall[] {
  const at = now.getTime();
  const today = localDate(now);
  // The gateway takes the lessons of the school's day; the phone's own day is
  // the nearest thing it knows.
  const held = lessons
    .filter((lesson) => !Number.isNaN(startOf(lesson)) && !Number.isNaN(endOf(lesson)) && localDate(new Date(startOf(lesson))) === today)
    .sort(byStart);

  const lessonsOf = new Map<string, CalendarLesson[]>();
  for (const lesson of held) {
    for (const pupilId of lesson.studentIds) {
      const list = lessonsOf.get(pupilId);
      if (list) list.push(lesson);
      else lessonsOf.set(pupilId, [lesson]);
    }
  }

  const placed = new Map<string, Placed>();
  for (const [pupilId, own] of lessonsOf) {
    const going = own.find((lesson) => startOf(lesson) <= at && at < endOf(lesson));
    if (going) {
      placed.set(pupilId, { lesson: going, basis: 'LESSON' });
      continue;
    }
    let previous: CalendarLesson | undefined;
    let next: CalendarLesson | undefined;
    for (const lesson of own) {
      if (endOf(lesson) <= at) previous = !previous || endOf(lesson) >= endOf(previous) ? lesson : previous;
      else if (startOf(lesson) > at && !next) next = lesson;
    }
    if (previous && next && startOf(next) - endOf(previous) <= maxGapMs) placed.set(pupilId, { lesson: next, basis: 'NEXT_LESSON' });
  }

  const groups = new Map<string, { lesson: CalendarLesson; basis: CallBasis; pupilIds: string[] }>();
  for (const [pupilId, { lesson, basis }] of placed) {
    const key = `${lesson.id}:${basis}`;
    const group = groups.get(key);
    if (group) group.pupilIds.push(pupilId);
    else groups.set(key, { lesson, basis, pupilIds: [pupilId] });
  }

  return [...groups.values()]
    .sort((a, b) => byStart(a.lesson, b.lesson) || (a.basis < b.basis ? -1 : a.basis > b.basis ? 1 : 0))
    .map(({ lesson, basis, pupilIds }): MyCall => {
      const absentHere = absent.get(lesson.id) ?? new Set<string>();
      const pupils = pupilIds
        .map((id) => ({ id, name: names.get(id) ?? '' }))
        .sort((a, b) => compareSwedish(a.name, b.name))
        .map(({ id, name }): PupilView => {
          const prior = absentHere.has(id);
          return {
            studentId: id,
            // The cache keeps one display name ("Förnamn Efternamn"), not the two.
            firstName: name,
            lastName: '',
            status: prior ? 'ABSENT_BEFORE' : 'UNREPORTED',
            priorAbsentSource: prior ? 'ATTENDANCE' : null,
            markedAt: null,
          };
        });
      const room = lesson.roomName.trim();
      return {
        id: `${LOCAL_CALL_PREFIX}${lesson.id}`,
        lessonId: lesson.id,
        basis,
        groupName: '',
        subjectName: lesson.subjectName,
        roomName: room === '' || room === '—' ? null : room,
        lessonStartsAt: lesson.startTime,
        lessonEndsAt: lesson.endTime,
        completedAt: null,
        colleagues: [],
        counts: countPupils(pupils.map((pupil) => pupil.status)),
        pupils,
        // Nobody has been found "with me" on a list the phone built, and the cache cannot name a pupil who is on none.
        foundHere: [],
      };
    });
}
