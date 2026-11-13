import type { LessonShape } from '../common/lesson-lengths';
import { lessonMinutesOf } from '../common/lesson-lengths';
import { hasShares, lessonTeachersOf, type LessonShare } from '../common/lesson-shares';
import type { PlacementDemand } from '../requirement-placements/placement-judge';
import { coverLockedLessons, coverLockedSharedLessons, type TaughtLesson } from './locked-coverage';
import { withoutPlaced, withoutPlacedShared } from './placed-lessons';

/*
 * WHAT A TIMPLANSPOST STILL ASKS OF THE ENGINE: ITS LESSONS, LESS THE ONES THE
 * SCHOOL HAS ALREADY ANSWERED, IN THE ORDER GENERERA ANSWERS THEM.
 *
 * Two things answer a lesson of a post before the engine is asked. First the
 * lessons Generera keeps (a hand-made lesson, a locked one, one with a second
 * class or named pupils) that cover the post's weeks: each cancels the lesson
 * of its own length first and the nearest otherwise (coverLockedLessons), or on
 * a post that shares its lessons the lesson of its own teacher first
 * (coverLockedSharedLessons). Then the förläggningar: each takes exactly the
 * lesson it places, after the locks, never another's (withoutPlaced, and per
 * teacher withoutPlacedShared).
 *
 * This was written out inline in the fetch of Generera (optimization-proxy
 * .service.ts) and is the one place the answer is given. The week of
 * förläggningar on the timetable page (requirement-placements, "tavlan") shows
 * the same figure to the school before a run, so it asks here and does not
 * count a second time: the figure on the screen is the figure Generera sends.
 */

/** The post as the count reads it: its lessons, and who teaches which. */
export interface DemandPost extends LessonShape {
  teacherId: string | null;
  shares?: readonly LessonShare[] | null;
}

/** What the post's förläggningar place: their lengths, and on a shared post each with its teacher. */
export interface DemandPlaced {
  /** Absent when the post has no förläggning at all (placedMinutesOf has no entry for it). */
  minutes?: readonly number[];
  /** Delade lektioner: only on a post that shares its lessons (placedTaughtByPost). */
  taught?: readonly TaughtLesson[];
}

export interface DemandLeft {
  /** The post shares its lessons between teachers: every list below then carries the teacher of each lesson. */
  shared: boolean;
  /** The covering locks, each its length and (as the lock has it) its teacher. */
  locks: TaughtLesson[];
  /** The post's lessons once the locks are off, longest first. */
  afterLocks: TaughtLesson[];
  /** The lessons once the förläggningar are off too: what Generera asks the engine to place. */
  left: TaughtLesson[];
  /** The post has förläggningar for the count to read (an empty list from a pair that matches nothing is still one). */
  placed: boolean;
}

/**
 * The post's lessons after the locks that cover it and the förläggningar that
 * place it. `covering` is the length and teacher of each lesson Generera keeps
 * that runs the post's weeks (lockCoversDemand), in the order the fetch reads
 * them. A length with no lesson left takes nothing from a förläggning: the
 * judge has refused that förläggning by name (OVER_DEMAND) before the count is
 * used for a run.
 */
export function demandLeftOf(
  post: DemandPost,
  covering: readonly TaughtLesson[],
  placed: DemandPlaced,
): DemandLeft {
  const shares = post.shares ?? [];
  if (hasShares({ ...post, shares })) {
    const locks = covering.map((lock) => ({ minutes: lock.minutes, teacherId: lock.teacherId ?? null }));
    const afterLocks = coverLockedSharedLessons(lessonTeachersOf({ ...post, shares }), locks);
    // Then each förläggning, off its own teacher's lessons of its length, never another's.
    const taught = placed.taught;
    return {
      shared: true,
      locks,
      afterLocks,
      left: taught ? withoutPlacedShared(afterLocks, taught) : afterLocks,
      placed: taught !== undefined,
    };
  }
  const locked = covering.map((lock) => lock.minutes);
  const afterLocks = coverLockedLessons(lessonMinutesOf(post), locked);
  // Then the post's förläggningar, each the exact length it places, after the locks.
  const minutes = placed.minutes;
  const teacherId = post.teacherId ?? null;
  const tagged = (lengths: readonly number[]): TaughtLesson[] => lengths.map((length) => ({ minutes: length, teacherId }));
  return {
    shared: false,
    locks: covering.map((lock) => ({ minutes: lock.minutes, teacherId: lock.teacherId ?? null })),
    afterLocks: tagged(afterLocks),
    left: tagged(minutes ? withoutPlaced(afterLocks, minutes) : afterLocks),
    placed: minutes !== undefined,
  };
}

/**
 * What the judge asks of a post for OVER_DEMAND (JudgePlacementsInput.demand):
 * the locks that cover it, and the lessons its förläggningar place, each with
 * its teacher on a post that shares its lessons (Bo's lock answers Bo's lesson,
 * and Bo's förläggning takes one of his). The one place that map entry is made,
 * for Generera's pre-flight, the week of förläggningar and the dialog's own
 * save and read, so a lock or a förläggning counts the same wherever the row is
 * judged (review of #315, MEDEL-1). The locks are read as `demandLeftOf` reads
 * them, which is how the post's own count answers them first.
 */
export function judgeDemandOf(post: DemandPost, covering: readonly TaughtLesson[], placed: DemandPlaced): PlacementDemand {
  const demand = demandLeftOf(post, covering, placed);
  return {
    post,
    lockedMinutes: demand.locks.map((lock) => lock.minutes),
    placed: [...(placed.minutes ?? [])],
    ...(demand.shared ? { taught: { locked: demand.locks, placed: [...(placed.taught ?? [])] } } : {}),
  };
}
