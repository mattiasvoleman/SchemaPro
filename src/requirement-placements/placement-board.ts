import type { PlacementWarningView } from './placement-warnings';
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
  /** The medlärare, who is in the room for every lesson of the post: the page's mirror of the clash rule reads it. */
  coTeacherId: string | null;
  recurrence: LessonRecurrence;
  /** YYYY-MM-DD, or null: the weeks the post runs, which a förläggning inherits. */
  startDate: string | null;
  endDate: string | null;
  /**
   * The pupils' own minutes on either side of the post's lessons (ombyte before idrotten, dusch and ombyte after): the clash
   * rule holds a class's other lessons out of them (master-lessons.service.ts pupilBuffersOf), so the page's mirror of it
   * reads them (review of #326, MEDEL-3). 0 and 0 for nearly every post.
   */
  minutesBefore: number;
  minutesAfter: number;
  /** Why no lesson of the post can be placed, or null when one can. */
  cannotPlace: 'BLOCK' | null;
  parts: BoardPartView[];
  /**
   * The key of the post's rows as they stand (rowsKeyOf): sent back as `baseKey` on the PUT, so that a write made on top
   * of a list somebody has changed since is refused (409 REQUIREMENT_PLACEMENTS_STALE). The same for every post with no rows.
   */
  rowsKey: string;
}

/** What the count reads of a post. */
export interface BoardPost extends LessonShape {
  id: string;
  studentGroupId: string;
  subjectId: string;
  teacherId: string | null;
  coTeacherId: string | null;
  recurrence: LessonRecurrence;
  blockId: string | null;
  startDate: Date | null;
  endDate: Date | null;
  shares: readonly LessonShare[];
  /** The pupils' minutes before and after a lesson of the post; absent reads as none. */
  minutesBefore?: number;
  minutesAfter?: number;
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
export function coveringLocksOf(
  post: Pick<BoardPost, 'studentGroupId' | 'subjectId' | 'recurrence' | 'startDate' | 'endDate'>,
  kept: readonly KeptForCount[],
): TaughtLesson[] {
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
 * `rowsKey` is the key of the rows as stored (placement-rows-key.ts), which a
 * write names to say what it is made on top of.
 */
export function boardPostOf(
  post: BoardPost,
  locks: readonly TaughtLesson[],
  rows: readonly PlacementShape[],
  rowsKey: string,
): BoardPostView {
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
    coTeacherId: post.coTeacherId,
    recurrence: post.recurrence,
    startDate: dayOf(post.startDate),
    endDate: dayOf(post.endDate),
    minutesBefore: post.minutesBefore ?? 0,
    minutesAfter: post.minutesAfter ?? 0,
    cannotPlace: post.blockId !== null ? 'BLOCK' : null,
    parts,
    rowsKey,
  };
}

/**
 * Whether any post of the year still has a lesson for the engine to place: what Generera asks it for, the board's `left`. A year with
 * none is one where Generera does not call the engine at all (every post answered by a lesson it keeps or a förläggning), so no
 * rule of the engine can refuse it; a pin is not counted here, because a pin is a förläggning and the post's `left` is without it.
 */
export const lessonsLeftOf = (posts: readonly BoardPostView[]): boolean => posts.some((post) => post.parts.some((part) => part.left > 0));

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

/**
 * WHAT THE GRUNDSCHEMA HOLDS OF THE FÖRLÄGGNINGAR, as Generera last wrote it (A3): how many of the year's lessons are one
 * (MasterLessons.fromPlacement) and when the newest of them was written. Counted from the grundschema and not from a run's
 * row, since that is the only thing that is true after a run, after a schemaförslag was applied (which writes the grundschema
 * with no Generera) and after a förläggning was REMOVED (which leaves no changedAt behind, while its lesson stands locked
 * until the next Generera). `createdAt` and not `updatedAt`: writeRegeneration deletes the generated lessons and creates
 * them again, and a lock or an unlock only moves `updatedAt`.
 */
export interface BoardTimetableView {
  placedLessons: number;
  writtenAt: string | null;
}

/**
 * GET /teaching-requirements/placements/latest: the lessons the last Generera laid and nobody has taken over, as the week
 * draws them behind its cards ("Visa senaste schemat"). The shape of a kept lesson (ids only, no pupil, no person named), and
 * what the next Generera replaces (generatedMastersWhere). Read on its own, when the school asks: a school's year is some
 * thousands of lessons, which the week of förläggningar does not need to carry for everyone who opens it.
 */
export interface LatestScheduleResponse {
  academicYearId: string;
  lessons: BoardKeptView[];
}

/** GET /teaching-requirements/placements/board: the year's week of förläggningar. */
export interface PlacementBoardResponse {
  academicYearId: string;
  /** What the grundschema holds of them now: Generera's last write (BoardTimetableView). Additive: an older web ignores it. */
  timetable: BoardTimetableView;
  /** Every förläggning of the year, in the order of GET /teaching-requirements/placements, each judged now. */
  placements: BoardPlacementView[];
  /** Every timplanspost of the year, its lessons counted the way Generera counts them. */
  posts: BoardPostView[];
  kept: BoardKeptView[];
  meals: BoardMealView[];
  /**
   * What the week the school has fixed says about each förläggning, post rows and block lessons alike
   * (placement-warnings.ts). Additive: an older web ignores it. A warning never refused a save.
   */
  warnings: PlacementWarningView[];
  /** The other schools' hold on this school's teachers and rooms, which a row is judged against (OTHER_SCHOOL). Additive. */
  holds: BoardHoldView[];
}

/** One hold of another school on a teacher or a room of this one, as a band in the week. */
export interface BoardHoldView {
  kind: 'TEACHER_BUSY' | 'ROOM_LENT' | 'ROOM_BORROWED';
  resourceKind: 'TEACHER' | 'ROOM';
  /** This school's own Users row or room. */
  resourceId: string;
  dayOfWeek: number;
  /** HH:MM. */
  startTime: string;
  endTime: string;
  /** The other schools by name, in name order: the sentence a refusal for it gives names the same. */
  schools: string[];
}

/** What the count reads of a post row, from the service's select. */
export function boardPostShape(post: {
  id: string;
  studentGroupId: string;
  subjectId: string;
  teacherId: string | null;
  coTeacherId: string | null;
  lessonsPerWeek: number;
  minutesPerLesson: number;
  lessonLengths: number[];
  recurrence: LessonRecurrence;
  blockId: string | null;
  startDate: Date | null;
  endDate: Date | null;
  shares: readonly LessonShare[];
  minutesBefore?: number;
  minutesAfter?: number;
}): BoardPost {
  return {
    id: post.id,
    studentGroupId: post.studentGroupId,
    subjectId: post.subjectId,
    teacherId: post.teacherId,
    coTeacherId: post.coTeacherId,
    lessonsPerWeek: post.lessonsPerWeek,
    minutesPerLesson: post.minutesPerLesson,
    lessonLengths: post.lessonLengths,
    recurrence: post.recurrence,
    blockId: post.blockId,
    startDate: post.startDate,
    endDate: post.endDate,
    shares: post.shares,
    ...(post.minutesBefore === undefined ? {} : { minutesBefore: post.minutesBefore }),
    ...(post.minutesAfter === undefined ? {} : { minutesAfter: post.minutesAfter }),
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
