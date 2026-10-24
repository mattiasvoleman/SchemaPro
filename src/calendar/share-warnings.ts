/*
 * DELADE LEKTIONER ON A HAND EDIT: whether the grundschema still gives each
 * teacher of a shared timplanspost the lessons its shares say.
 *
 * The generator writes a shared post's lessons each with its own teacher
 * (optimization-proxy.service.ts), so a generated week is in line with the
 * shares by construction. A hand edit is not: a lesson created by hand, put
 * on another teacher, or moved to other weeks can leave Bo with two of 9A's
 * matematik where his share is one — and his tjänst charged for one. That is
 * allowed and warned about, as the ämnesfördelning is (subject-distribution.ts):
 * the school may mean it for a while, and the next generation lays the shares
 * again.
 *
 * IN THE WEEKS THE EDITED LESSON RUNS, ISO week by ISO week (teacher-day.ts's
 * weeksOf), for the reason distributionBreaches gives: the even weeks beside
 * an odd-week lesson, or the spring beside an autumn one, are not the edit's
 * to repeat. A teacher is off their share in a week that gives them MORE of
 * the post's lessons than the share does — always the edit's doing when it is
 * the edited lesson's teacher — or FEWER in a week that holds every lesson the
 * post has: a week short of a lesson (one on the tray, one that ends in the
 * autumn) leaves somebody short by construction, and the tray already says so.
 *
 * ABOUT THE LESSON'S TEACHER, AND THE ONE IT HAD. An edit changes the count of
 * at most those two, so they are what it is asked about (`asked`), in that
 * order: the teacher on the lesson after the edit (LESSON), and the one a
 * teacher change took it from (PREVIOUS). A teacher with no part of the post
 * — a substitute put on one lesson — has a share of 0. Nobody (null) is
 * nobody's share and is not asked about.
 *
 * NEVER A NAME. The params say which of the lesson's two teachers it is, as
 * Lärarens dag's role does (master-lessons.service.ts): the page shows the
 * sentence beside the lesson it saved, which says who that is.
 */

import { teacherPartsOf, type SharedRow } from '../common/lesson-shares';
import { weeksOf, type WeekLesson } from '../common/teacher-day';

/** The warning's code, which the engine catalogue renders (messages.py). */
export const SHARE_LESSONS_DIFFER = 'SHARE_LESSONS_DIFFER';

/** Which of the edited lesson's teachers a breach is about. */
export type ShareRole = 'LESSON' | 'PREVIOUS';

/** One of the post's placed lessons, with the teacher who leads it. */
export type ShareWeekLesson = WeekLesson & { id: string; teacherId: string | null };

export interface ShareBreach {
  role: ShareRole;
  /** The teacher's lessons of the post in the week furthest from the share. */
  lessons: number;
  /** The lessons the shares give the teacher: the lead's rest, a share, or 0. */
  share: number;
}

export interface ShareWarning {
  code: typeof SHARE_LESSONS_DIFFER;
  params: { requirement: string; role: ShareRole; lessons: number; share: number };
}

/**
 * The breaches of the post's shares that `edited` is part of, for the teachers
 * `asked` about, in their order. `lessons` are the post's placed lessons and
 * nobody else's, the edited one among them, as the caller reads them by the
 * post's own key (läsår, class, subject).
 */
export function shareBreaches(
  row: SharedRow,
  lessons: readonly ShareWeekLesson[],
  edited: string,
  asked: readonly { role: ShareRole; teacherId: string | null }[],
): ShareBreach[] {
  const shareOf = new Map<string, number>();
  for (const part of teacherPartsOf(row)) {
    if (part.teacherId !== null) shareOf.set(part.teacherId, (shareOf.get(part.teacherId) ?? 0) + part.lessons);
  }
  const weeks = weeksOf(lessons).filter((week) => week.some((lesson) => lesson.id === edited));
  const breaches: ShareBreach[] = [];
  const seen = new Set<string>();
  for (const { role, teacherId } of asked) {
    if (teacherId === null || seen.has(teacherId)) continue;
    seen.add(teacherId);
    const share = shareOf.get(teacherId) ?? 0;
    let furthest: number | null = null;
    for (const week of weeks) {
      const own = week.filter((lesson) => lesson.teacherId === teacherId).length;
      const off = own > share || (own < share && week.length >= row.lessonsPerWeek);
      if (off && (furthest === null || Math.abs(own - share) > Math.abs(furthest - share))) furthest = own;
    }
    if (furthest !== null) breaches.push({ role, lessons: furthest, share });
  }
  return breaches;
}

/** A breach as the warning a hand edit gets back; `requirement` is the post's name ("Matematik för 9A"). */
export function shareWarning(breach: ShareBreach, requirement: string): ShareWarning {
  return {
    code: SHARE_LESSONS_DIFFER,
    params: { requirement, role: breach.role, lessons: breach.lessons, share: breach.share },
  };
}
