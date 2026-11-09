import type { LessonRecurrence } from '@prisma/client';
import { LESSON_GRID_MINUTES, lengthPartsOf, lessonMinutesOf, type LessonShape } from '../common/lesson-lengths';
import { coverLockedLessons } from '../optimization/locked-coverage';

/*
 * FÖRLAGDA POSTER: WHICH OF A POST'S LESSONS ITS FÖRLÄGGNINGAR PLACE, AND
 * WHETHER THEY FIT THE POST AT ALL. Pure; no clock, no database.
 *
 * A förläggning (TeachingRequirementPlacement) is one lesson of the post at a
 * day, a start, one of the post's lengths, a room and the weeks it runs. The
 * engine has no weeks of its own beyond one odd and one even
 * (AnonymousRequirement.recurrence), so what a row places is said in its
 * terms:
 *
 *   - On a post of odd weeks (or even), every row runs the post's weeks, and
 *     each row is one of its lessons.
 *   - On an every-week post a row is every week, and is one lesson; or it is
 *     odd weeks or even weeks, and then an odd row and an even row of one
 *     length TOGETHER are one lesson, in two places: "udda veckor tisdag i
 *     simhallen, jämna veckor torsdag". A lone odd row would leave the even
 *     weeks' lesson nowhere — the engine cannot place half a lesson of an
 *     every-week post (locked-coverage.ts says why a lock of one parity
 *     covers nothing) — so the rows must pair up.
 *   - No more rows of a length than the post has lessons of it.
 *   - A post in a parallel block is placed with its block, at one start for
 *     every member (parallel-blocks.ts), and a förläggning of one member would
 *     be a partly locked block, which Generera refuses. Not supported.
 *   - A post with delade lektioner names a teacher per lesson, and which of
 *     them a förläggning would be is a choice nobody has made. Not supported
 *     either, until it is asked for.
 *
 * THE SAME RULES THREE TIMES, ON PURPOSE. The trigger on the table
 * (migration 20270207090000, SQLSTATE FP409) refuses a row, and a change of
 * the post, that breaks them, whoever writes; this copy says which rule before
 * the write so the 409 can name it; Generera reads the lessons placed from
 * `placedLessonsOf` and takes them off the post's demand.
 */

export type PlacementFitReason =
  /** A row's length is not one of the post's. */
  | 'LENGTH'
  /** More rows of a length than the post has lessons of it. */
  | 'COUNT'
  /** A row runs other weeks than the post's (an odd row on an even post). */
  | 'WEEKS'
  /** On an every-week post, odd and even rows of a length do not pair up. */
  | 'PAIRS'
  /** The post is in a parallel block. */
  | 'BLOCK'
  /** The post shares its lessons between teachers. */
  | 'SHARES';

/** What the fit reads of a post. */
export interface PlacementPost extends LessonShape {
  recurrence: LessonRecurrence;
  blockId: string | null;
  /** How many share rows the post has (TeachingRequirementShares). */
  shareCount: number;
}

/** What the fit reads of a row. */
export interface PlacementShape {
  minutes: number;
  recurrence: LessonRecurrence;
}

/**
 * The first rule the rows break on this post, or null when they fit. Rows in
 * any order. Asked of the post's whole set, because a pair is two rows.
 */
export function placementFitOf(post: PlacementPost, rows: readonly PlacementShape[]): PlacementFitReason | null {
  if (rows.length === 0) return null;
  if (post.blockId !== null) return 'BLOCK';
  if (post.shareCount > 0) return 'SHARES';
  const lengths = new Set(lessonMinutesOf(post));
  if (rows.some((row) => !lengths.has(row.minutes))) return 'LENGTH';
  if (post.recurrence !== 'ALL_WEEKS') {
    if (rows.some((row) => row.recurrence !== post.recurrence)) return 'WEEKS';
  } else {
    for (const minutes of lengths) {
      const odd = rows.filter((row) => row.minutes === minutes && row.recurrence === 'ODD_WEEKS').length;
      const even = rows.filter((row) => row.minutes === minutes && row.recurrence === 'EVEN_WEEKS').length;
      if (odd !== even) return 'PAIRS';
    }
  }
  const placed = placedLessonsOf(post, rows);
  for (const part of lengthPartsOf(post)) {
    if (placed.filter((minutes) => minutes === part.minutes).length > part.count) return 'COUNT';
  }
  return null;
}

/**
 * The post's lessons the rows place, one length each, longest first: a row of
 * the post's own weeks is one, an odd and an even row of one length on an
 * every-week post are one together. Rows that pair with nothing (which the
 * fit refuses) place nothing.
 */
export function placedLessonsOf(post: Pick<PlacementPost, 'recurrence'>, rows: readonly PlacementShape[]): number[] {
  const placed: number[] = [];
  if (post.recurrence !== 'ALL_WEEKS') {
    for (const row of rows) if (row.recurrence === post.recurrence) placed.push(row.minutes);
  } else {
    const odd = new Map<number, number>();
    const even = new Map<number, number>();
    for (const row of rows) {
      if (row.recurrence === 'ALL_WEEKS') placed.push(row.minutes);
      else {
        const side = row.recurrence === 'ODD_WEEKS' ? odd : even;
        side.set(row.minutes, (side.get(row.minutes) ?? 0) + 1);
      }
    }
    for (const [minutes, count] of odd) {
      const pairs = Math.min(count, even.get(minutes) ?? 0);
      for (let i = 0; i < pairs; i += 1) placed.push(minutes);
    }
  }
  return placed.sort((a, b) => b - a);
}

/**
 * Whether the post's locks leave room for what its förläggningar place: the
 * post's lengths less the ones the covering locks cancel (coverLockedLessons,
 * Generera's own rule), and then each placed lesson must take a length still
 * left, exactly. A lock of 60 on a post of 80 + 40 cancels the 40 (the nearest,
 * a tie toward the shorter), and a förläggning of 40 then finds none: the
 * school has already placed that lesson by hand. False is refused by name
 * (OVER_DEMAND), at save and at Generera.
 */
export function placementsFitBesideLocks(
  post: LessonShape,
  lockedMinutes: readonly number[],
  placed: readonly number[],
): boolean {
  const remaining = coverLockedLessons(lessonMinutesOf(post), lockedMinutes);
  for (const minutes of placed) {
    const at = remaining.indexOf(minutes);
    if (at < 0) return false;
    remaining.splice(at, 1);
  }
  return true;
}

/** The engine's day and week (src/common/solver-grid.ts, config.py SCHEDULE_DAYS). */
export const PLACEMENT_DAYS = [1, 2, 3, 4, 5] as const;
export const PLACEMENT_DAY_START = 8 * 60;
export const PLACEMENT_DAY_END = 18 * 60;

/**
 * Whether a row stands inside the engine's school week: Monday to Friday,
 * 08:00 to 18:00, on the five-minute grid. A lock outside it reaches the
 * engine as a window nothing meets (scheduler_solver._fixed_window answers
 * None), so it would block nothing and still be written: refused instead.
 * The CHECKs on the table say the same.
 */
export function insideSchoolDay(row: { dayOfWeek: number; startMinutes: number; minutes: number }): boolean {
  return (
    (PLACEMENT_DAYS as readonly number[]).includes(row.dayOfWeek) &&
    row.startMinutes % LESSON_GRID_MINUTES === 0 &&
    row.startMinutes >= PLACEMENT_DAY_START &&
    row.startMinutes + row.minutes <= PLACEMENT_DAY_END
  );
}
