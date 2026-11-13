import type { LessonRecurrence } from '@prisma/client';
import { lockCoversDemand, type TaughtLesson } from '../optimization/locked-coverage';
import { demandLeftOf } from '../optimization/post-demand';
import { hasShares, lessonTeachersOf, type LessonShare } from '../common/lesson-shares';
import type { LessonShape } from '../common/lesson-lengths';
import { placedByRowsOf, type PlacementShape } from './placement-fit';
import type { PlacementParams, PlacementRefusalReason } from './placement-judge';
import type { RequirementPlacementView } from './requirement-placements.service';

/*
 * FÖRLAGDA POSTER: THE WEEK OF THEM, AS THE SCHOOL READS IT BEFORE GENERERA.
 * Pure; no clock, no database. The service (requirement-placements.service.ts)
 * reads the year once and hands the facts here.
 *
 * WHAT A POST HAS LEFT IS GENERERA'S OWN COUNT, NOT A SECOND ONE. A post's
 * lessons are counted by (teacher, length), and each is answered by one of
 * three things, in Generera's order: a lesson Generera keeps that covers the
 * post's weeks (`locked`), a förläggning (`placed`), or nothing yet (`left`),
 * which is what Generera asks the engine to place. demandLeftOf
 * (optimization/post-demand.ts) gives the three lists; Generera's fetch reads
 * the same function, so the figure on the screen and the figure sent are one.
 *
 *   count = locked + placed + left       for every (teacher, length)
 *
 * A förläggning that finds no lesson of its length (the post's locks already
 * answer it: OVER_DEMAND, which the judge says by name) takes none, so it adds
 * to nothing here; its row is in the list with its verdict.
 *
 * WHAT CANNOT BE PLACED is said where it stands. A post in a parallel block
 * (`cannotPlace: 'BLOCK'`) is placed with its block, and the table refuses a
 * row of one member. A lesson of a shared post that nobody teaches (a share
 * whose teacher was deleted, a post with no huvudlärare) cannot be given to
 * anybody: the dialog says the school chooses its teacher first
 * (`cannotPlace: 'NO_TEACHER'` on that part).
 *
 * NO PERSON IS NAMED. A part says whose it is by id, as the post does; names
 * are the page's, from the lists it already reads.
 */

/** One (teacher, length) of a post's lessons, and what answers each of them. */
export interface BoardPartView {
  /** Whose lessons these are: the huvudlärare, or a share's teacher; null for lessons nobody teaches. */
  teacherId: string | null;
  minutes: number;
  /** The post's lessons of this teacher and length. */
  count: number;
  /** Answered by a lesson Generera keeps (hand-made, locked, or with a second class or named pupils). */
  locked: number;
  /** Answered by a förläggning. */
  placed: number;
  /** Still to place: what Generera asks the engine for. */
  left: number;
  /** Why none of these can be placed, or null when one can. */
  cannotPlace: 'NO_TEACHER' | null;
}

/** One timplanspost as the week reads it. */
export interface BoardPostView {
  id: string;
  studentGroupId: string;
  subjectId: string;
  /** The huvudlärare; null when nobody teaches the post. */
  teacherId: string | null;
  recurrence: LessonRecurrence;
  /** YYYY-MM-DD, or null: the weeks the post runs, which a förläggning inherits. */
  startDate: string | null;
  endDate: string | null;
  /** Why no lesson of the post can be placed, or null when one can. */
  cannotPlace: 'BLOCK' | null;
  parts: BoardPartView[];
}

/** What the count reads of a post. */
export interface BoardPost extends LessonShape {
  id: string;
  studentGroupId: string;
  subjectId: string;
  teacherId: string | null;
  recurrence: LessonRecurrence;
  blockId: string | null;
  startDate: Date | null;
  endDate: Date | null;
  shares: readonly LessonShare[];
}

/** A lesson Generera keeps, as the count reads it. */
export interface KeptForCount {
  studentGroupId: string;
  subjectId: string;
  recurrence: LessonRecurrence;
  startDate: Date | null;
  endDate: Date | null;
  teacherId: string | null;
  /** The lesson's length. */
  minutes: number;
}

const dayOf = (date: Date | null): string | null => (date ? date.toISOString().slice(0, 10) : null);
const pad = (value: number): string => String(value).padStart(2, '0');
/** A @db.Time column (midnight-anchored UTC) as HH:MM. */
const clockOfTime = (time: Date): string => `${pad(time.getUTCHours())}:${pad(time.getUTCMinutes())}`;

const keyOf = (lesson: TaughtLesson): string => `${lesson.teacherId ?? ''}|${lesson.minutes}`;

/** How many of each (teacher, length) a list holds. */
function tally(lessons: readonly TaughtLesson[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const lesson of lessons) counts.set(keyOf(lesson), (counts.get(keyOf(lesson)) ?? 0) + 1);
  return counts;
}

/**
 * The lessons of `kept` that cover the post's weeks, each its length and
 * teacher: the post's locks as Generera reads them (lockCoversDemand over the
 * lessons it keeps of the post's class and subject).
 */
export function coveringLocksOf(post: BoardPost, kept: readonly KeptForCount[]): TaughtLesson[] {
  return kept
    .filter(
      (lesson) =>
        lesson.studentGroupId === post.studentGroupId && lesson.subjectId === post.subjectId && lockCoversDemand(lesson, post),
    )
    .map((lesson) => ({ minutes: lesson.minutes, teacherId: lesson.teacherId }));
}

/**
 * One post's lessons, counted. `locks` are the covering locks (coveringLocksOf),
 * `rows` the post's förläggningar; the post is read as Generera reads it.
 */
export function boardPostOf(post: BoardPost, locks: readonly TaughtLesson[], rows: readonly PlacementShape[]): BoardPostView {
  const shared = hasShares(post);
  const demand = demandLeftOf(post, locks, placedByRowsOf(post, rows));
  const all = lessonTeachersOf(post);
  const afterLocks = tally(demand.afterLocks);
  const left = tally(demand.left);
  const total = tally(all);
  const parts: BoardPartView[] = [];
  for (const key of new Set(all.map(keyOf))) {
    const first = all.find((lesson) => keyOf(lesson) === key)!;
    const count = total.get(key) ?? 0;
    const afterLock = afterLocks.get(key) ?? 0;
    const remaining = left.get(key) ?? 0;
    parts.push({
      teacherId: first.teacherId,
      minutes: first.minutes,
      count,
      locked: count - afterLock,
      placed: afterLock - remaining,
      left: remaining,
      cannotPlace: shared && first.teacherId === null ? 'NO_TEACHER' : null,
    });
  }
  return {
    id: post.id,
    studentGroupId: post.studentGroupId,
    subjectId: post.subjectId,
    teacherId: post.teacherId,
    recurrence: post.recurrence,
    startDate: dayOf(post.startDate),
    endDate: dayOf(post.endDate),
    cannotPlace: post.blockId !== null ? 'BLOCK' : null,
    parts,
  };
}

/** The judge's verdict on one row; `reason` and `params` only when the row does not hold. */
export interface BoardVerdictView {
  ok: boolean;
  reason?: PlacementRefusalReason;
  params?: PlacementParams;
}

/** One förläggning of the year, with its verdict and when its post's list was last saved. */
export interface BoardPlacementView extends RequirementPlacementView {
  /** ISO instant. Every save replaces a post's whole list, so this is the post's last save. */
  changedAt: string;
  verdict: BoardVerdictView;
}

/**
 * A lesson the next Generera keeps, which the rows are held against: hand-made,
 * locked, or given a second class or named pupils (PRESERVED_FROM_REGENERATION,
 * not parked). Ids only: no pupil is read and no person named.
 */
export interface BoardKeptView {
  id: string;
  dayOfWeek: number;
  /** HH:MM. */
  startTime: string;
  endTime: string;
  studentGroupId: string;
  /** The classes the lesson also has, besides its own. */
  extraGroupIds: string[];
  subjectId: string;
  teacherId: string | null;
  coTeacherId: string | null;
  roomId: string | null;
  recurrence: LessonRecurrence;
  startDate: string | null;
  endDate: string | null;
  locked: boolean;
  /** Written by a run and kept since (locked, or opened to a class or to pupils); false for a lesson made by hand. */
  generated: boolean;
}

/** A meal the school placed by hand: the only meals a row is held to. */
export interface BoardMealView {
  id: string;
  studentGroupId: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  startDate: string | null;
  endDate: string | null;
}

/** GET /teaching-requirements/placements/board: the year's week of förläggningar. */
export interface PlacementBoardResponse {
  academicYearId: string;
  /** Every förläggning of the year, in the order of GET /teaching-requirements/placements, each judged now. */
  placements: BoardPlacementView[];
  /** Every timplanspost of the year, its lessons counted the way Generera counts them. */
  posts: BoardPostView[];
  kept: BoardKeptView[];
  meals: BoardMealView[];
}

/** What the count reads of a post row, from the service's select. */
export function boardPostShape(post: {
  id: string;
  studentGroupId: string;
  subjectId: string;
  teacherId: string | null;
  lessonsPerWeek: number;
  minutesPerLesson: number;
  lessonLengths: number[];
  recurrence: LessonRecurrence;
  blockId: string | null;
  startDate: Date | null;
  endDate: Date | null;
  shares: readonly LessonShare[];
}): BoardPost {
  return {
    id: post.id,
    studentGroupId: post.studentGroupId,
    subjectId: post.subjectId,
    teacherId: post.teacherId,
    lessonsPerWeek: post.lessonsPerWeek,
    minutesPerLesson: post.minutesPerLesson,
    lessonLengths: post.lessonLengths,
    recurrence: post.recurrence,
    blockId: post.blockId,
    startDate: post.startDate,
    endDate: post.endDate,
    shares: post.shares,
  };
}

export function keptViewOf(lesson: {
  id: string;
  dayOfWeek: number;
  startTime: Date;
  endTime: Date;
  studentGroupId: string;
  extraGroups: { studentGroupId: string }[];
  subjectId: string;
  teacherId: string | null;
  coTeacherId: string | null;
  roomId: string | null;
  recurrence: LessonRecurrence;
  startDate: Date | null;
  endDate: Date | null;
  isLocked: boolean;
  isGenerated: boolean;
}): BoardKeptView {
  return {
    id: lesson.id,
    dayOfWeek: lesson.dayOfWeek,
    startTime: clockOfTime(lesson.startTime),
    endTime: clockOfTime(lesson.endTime),
    studentGroupId: lesson.studentGroupId,
    extraGroupIds: lesson.extraGroups.map((entry) => entry.studentGroupId),
    subjectId: lesson.subjectId,
    teacherId: lesson.teacherId,
    coTeacherId: lesson.coTeacherId,
    roomId: lesson.roomId,
    recurrence: lesson.recurrence,
    startDate: dayOf(lesson.startDate),
    endDate: dayOf(lesson.endDate),
    locked: lesson.isLocked,
    generated: lesson.isGenerated,
  };
}

export function mealViewOf(meal: {
  id: string;
  studentGroupId: string;
  dayOfWeek: number;
  startTime: Date;
  endTime: Date;
  startDate: Date | null;
  endDate: Date | null;
}): BoardMealView {
  return {
    id: meal.id,
    studentGroupId: meal.studentGroupId,
    dayOfWeek: meal.dayOfWeek,
    startTime: clockOfTime(meal.startTime),
    endTime: clockOfTime(meal.endTime),
    startDate: dayOf(meal.startDate),
    endDate: dayOf(meal.endDate),
  };
}
