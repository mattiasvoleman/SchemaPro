import type { LessonRecurrence } from '@prisma/client';
import { LESSON_GRID_MINUTES, lengthPartsOf, lessonMinutesOf, type LessonShape } from '../common/lesson-lengths';
import { hasShares, lessonTeachersOf, type LessonShare } from '../common/lesson-shares';
import { coverLockedLessons, coverLockedSharedLessons, type TaughtLesson } from '../optimization/locked-coverage';

/*
 * FÖRLAGDA POSTER: WHICH OF A POST'S LESSONS ITS FÖRLÄGGNINGAR PLACE, AND
 * WHETHER THEY FIT THE POST AT ALL. Pure; no clock, no database.
 *
 * A förläggning (TeachingRequirementPlacement) is one lesson of the post at a
 * day, a start, one of the post's lengths, a room and the weeks it runs. The
 * engine has no weeks of its own beyond the ones it is told — a parity
 * (AnonymousRequirement.recurrence) and, for a dated post, the periods of
 * the läsår — so what a row places is said in its terms:
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
 *
 * DELADE LEKTIONER (migration 20270208090000). A post that shares its lessons
 * between teachers (TeachingRequirementShares) has a teacher per lesson, so a
 * förläggning there names whose lesson it is: `teacherId`, the huvudlärare or
 * a share's teacher, and its length is one of THAT teacher's. It is tied to
 * the teacher and the length and never to a share row, because every writer
 * of shares replaces the rows whole (deleteMany + createMany, new ids) — the
 * reason MasterLessons.fromPlacement is a flag and not a key. The rules above
 * then hold per teacher as well (teacherFitOf):
 *
 *   - NO_TEACHER      a förläggning written on a shared post names nobody:
 *                     a lesson nobody teaches is not placed (the school
 *                     chooses its teacher first). Only of a row being
 *                     written: a teacher removed later leaves the row on
 *                     the unstaffed lesson it is (ON DELETE SET NULL).
 *   - TEACHER         the row names somebody with no lesson of the post, or
 *                     anybody at all on a post that shares nothing;
 *   - TEACHER_LENGTH  the teacher has lessons of the post, none of that length;
 *   - TEACHER_PAIRS   one teacher's odd and even rows of a length do not pair:
 *                     a pair is ONE lesson in two places, so it is one
 *                     teacher's;
 *   - TEACHER_COUNT   more of a teacher's lessons of a length are placed than
 *                     their part of the post has.
 *
 * On a post that shares nothing every row names nobody (`teacherId` null), and
 * the post's teacher is the lesson's, as it always was: such a post fits
 * exactly as before this file knew of shares.
 *
 * THE SAME RULES THREE TIMES, ON PURPOSE. The triggers on the tables
 * (migrations 20270207090000 and 20270208090000, SQLSTATE FP409) refuse a
 * row, and a change of the post or its shares, that breaks them, whoever
 * writes; this copy says which rule before the write so the 409 can name it;
 * Generera reads the lessons placed from `placedLessonsOf` and
 * `placedTaughtOf` and takes them off the post's demand. The per-teacher
 * rules are judged by a DEFERRED trigger in the database (a share's teacher is
 * replaced by a delete and an insert, and the förläggning follows in a third
 * statement), and the gateway asks for them at the end of its own write
 * (placement-teachers.ts) so that a refusal is a statement, not a commit.
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
  | TeacherFitReason;

/** The rules a shared post's rows are held to per teacher (see the file's first paragraphs). */
export type TeacherFitReason = 'NO_TEACHER' | 'TEACHER' | 'TEACHER_LENGTH' | 'TEACHER_PAIRS' | 'TEACHER_COUNT';

/** What the fit reads of a post: its shape and weeks, its block, and who teaches which of its lessons. */
export interface PlacementPost extends LessonShape {
  recurrence: LessonRecurrence;
  blockId: string | null;
  /** The huvudlärare, who takes every lesson no share takes; null when nobody does. */
  teacherId: string | null;
  /** The post's shares (TeachingRequirementShares); empty or absent on a post that shares nothing. */
  shares?: readonly LessonShare[] | null;
}

/** What the fit reads of a row. */
export interface PlacementShape {
  minutes: number;
  recurrence: LessonRecurrence;
  /**
   * Whose lesson it is, on a shared post; always null on a post that shares
   * nothing (the post's teacher is the lesson's). Absent reads as null.
   */
  teacherId?: string | null;
}

/**
 * The first rule the rows break on this post, or null when they fit. Rows in
 * any order. Asked of the post's whole set, because a pair is two rows.
 */
export function placementFitOf(post: PlacementPost, rows: readonly PlacementShape[]): PlacementFitReason | null {
  if (rows.length === 0) return null;
  if (post.blockId !== null) return 'BLOCK';
  const shape = postShapeFitOf(post, rows);
  if (shape !== null) return shape;
  // Delade lektioner: a row written on a shared post names its teacher.
  if (hasShares(post) && rows.some((row) => (row.teacherId ?? null) === null)) return 'NO_TEACHER';
  return teacherFitOf(post, rows);
}

/** The post's own rules, which a post that shares nothing is held to alone: lengths, weeks, pairs, count. */
function postShapeFitOf(post: PlacementPost, rows: readonly PlacementShape[]): PlacementFitReason | null {
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

/** A teacher's own lessons of a post, by length: who (null for the lessons nobody teaches) and how many. */
export type TeacherParts = Map<string | null, Map<number, number>>;

/**
 * Who teaches which of the post's lessons, by length: lessonTeachersOf
 * counted per (teacher, length). The huvudlärare's part is every lesson no
 * share takes; a deleted teacher's share and a post with no huvudlärare are
 * one part with no teacher (null), as the readers of shares sum them. A post
 * that shares nothing is one part: its teacher's, every lesson.
 */
export function teacherPartsOf(post: LessonShape & { teacherId: string | null; shares?: readonly LessonShare[] | null }): TeacherParts {
  const parts: TeacherParts = new Map();
  for (const lesson of lessonTeachersOf(post)) {
    const byLength = parts.get(lesson.teacherId) ?? new Map<number, number>();
    byLength.set(lesson.minutes, (byLength.get(lesson.minutes) ?? 0) + 1);
    parts.set(lesson.teacherId, byLength);
  }
  return parts;
}

/** The teacher a row's lesson is: its own on a shared post, else the post's. */
export function teacherOfRow(post: { teacherId: string | null; shares?: readonly LessonShare[] | null }, row: PlacementShape): string | null {
  return (post.shares ?? []).length > 0 ? (row.teacherId ?? null) : post.teacherId;
}

/**
 * The per-teacher rules alone (TEACHER, TEACHER_LENGTH, TEACHER_PAIRS,
 * TEACHER_COUNT) on a post's whole set of rows: the database's deferred
 * trigger, rule for rule, and what a change of the post or its shares must
 * leave its förläggningar fitting (placement-teachers.ts). A row naming
 * nobody on a shared post is held to the lessons nobody teaches, which a
 * deleted teacher leaves; NO_TEACHER, a question about a row being written,
 * is placementFitOf's. Null when they fit.
 */
export function teacherFitOf(post: PlacementPost, rows: readonly PlacementShape[]): TeacherFitReason | null {
  return teacherMisfitOf(post, rows)?.reason ?? null;
}

/** teacherFitOf's rule, and the row it is said of: the first of its kind in `rows`' order (the last of a count). */
export function teacherMisfitOf(
  post: PlacementPost,
  rows: readonly PlacementShape[],
): { reason: TeacherFitReason; index: number } | null {
  if (rows.length === 0) return null;
  if (!hasShares(post)) {
    const index = rows.findIndex((row) => (row.teacherId ?? null) !== null);
    return index >= 0 ? { reason: 'TEACHER', index } : null;
  }
  const parts = teacherPartsOf(post);
  const who = (row: PlacementShape): string | null => row.teacherId ?? null;
  let index = rows.findIndex((row) => !parts.has(who(row)));
  if (index >= 0) return { reason: 'TEACHER', index };
  index = rows.findIndex((row) => !parts.get(who(row))!.has(row.minutes));
  if (index >= 0) return { reason: 'TEACHER_LENGTH', index };
  // The rows of one teacher and one length, in `rows`' order.
  const groups = new Map<string, number[]>();
  rows.forEach((row, at) => {
    const key = `${who(row) ?? ''}:${row.minutes}`;
    const list = groups.get(key);
    if (list) list.push(at);
    else groups.set(key, [at]);
  });
  if (post.recurrence === 'ALL_WEEKS') {
    for (const list of groups.values()) {
      const odd = list.filter((at) => rows[at]!.recurrence === 'ODD_WEEKS');
      const even = list.filter((at) => rows[at]!.recurrence === 'EVEN_WEEKS');
      if (odd.length !== even.length) {
        const longer = odd.length > even.length ? odd : even;
        return { reason: 'TEACHER_PAIRS', index: longer[longer.length - 1]! };
      }
    }
  }
  for (const list of groups.values()) {
    const first = rows[list[0]!]!;
    const placed = placedLessonsOf(post, list.map((at) => rows[at]!)).length;
    if (placed > parts.get(who(first))!.get(first.minutes)!) {
      return { reason: 'TEACHER_COUNT', index: list[list.length - 1]! };
    }
  }
  return null;
}

/**
 * The post's lessons the rows place, each with its teacher: placedLessonsOf
 * per teacher, so a pair is one lesson of the teacher both rows name. Longest
 * first, and within a length by teacher (null last). On a post that shares
 * nothing every lesson is the post's teacher's.
 */
export function placedTaughtOf(
  post: Pick<PlacementPost, 'recurrence' | 'teacherId' | 'shares'>,
  rows: readonly PlacementShape[],
): TaughtLesson[] {
  const byTeacher = new Map<string | null, PlacementShape[]>();
  for (const row of rows) {
    const teacher = teacherOfRow(post, row);
    const list = byTeacher.get(teacher);
    if (list) list.push(row);
    else byTeacher.set(teacher, [row]);
  }
  const taught: TaughtLesson[] = [];
  for (const [teacherId, list] of byTeacher) {
    for (const minutes of placedLessonsOf(post, list)) taught.push({ minutes, teacherId });
  }
  return taught.sort(
    (a, b) =>
      b.minutes - a.minutes ||
      (a.teacherId === b.teacherId ? 0 : a.teacherId === null ? 1 : b.teacherId === null ? -1 : a.teacherId < b.teacherId ? -1 : 1),
  );
}

/**
 * What a post's rows place, as the count (demandLeftOf) and the judge
 * (judgeDemandOf) read it: the lengths of the lessons, and on a post that
 * shares its lessons each with its teacher. Nothing at all for a post with no
 * row, which is not the same as an empty answer from a pair that matches
 * nothing (the post then has rows for the count to read).
 */
export function placedByRowsOf(
  post: Pick<PlacementPost, 'recurrence' | 'teacherId' | 'shares'>,
  rows: readonly PlacementShape[],
): { minutes?: number[]; taught?: TaughtLesson[] } {
  if (rows.length === 0) return {};
  return { minutes: placedLessonsOf(post, rows), ...((post.shares ?? []).length > 0 ? { taught: placedTaughtOf(post, rows) } : {}) };
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

/**
 * placementsFitBesideLocks on a SHARED post: the post's lessons with their
 * teachers less the ones its covering locks cancel (coverLockedSharedLessons,
 * Generera's own rule: a lock of Bo's answers Bo's lesson first), and then
 * each placed lesson must take one still left of its own teacher and length.
 * Bo's lock of 60 on a post where Bo has one 60 leaves Bo's förläggning none:
 * OVER_DEMAND, as on a post that shares nothing.
 */
export function sharedPlacementsFitBesideLocks(
  post: LessonShape & { teacherId: string | null; shares?: readonly LessonShare[] | null },
  locked: readonly TaughtLesson[],
  placed: readonly TaughtLesson[],
): boolean {
  const remaining = coverLockedSharedLessons(lessonTeachersOf(post), locked);
  for (const lesson of placed) {
    const at = remaining.findIndex((left) => left.minutes === lesson.minutes && left.teacherId === lesson.teacherId);
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

/** A stored förläggning as a change of its post's teachers reads it. */
export interface FollowedRow extends PlacementShape {
  id: string;
  /** As stored: the lesson's teacher on a shared post, null on one that shares nothing. */
  teacherId: string | null;
}

/** What a change of a post's teachers does to its förläggningar (followPlacements). */
export type PlacementsFollow =
  | {
      ok: true;
      /** The rows whose stored teacher changes, and to whom (null on a post that no longer shares). */
      moves: { id: string; teacherId: string | null }[];
    }
  | {
      ok: false;
      reason: TeacherFitReason;
      /** The förläggning that has to be changed (or removed) before the post can be. */
      row: FollowedRow;
      /**
       * The förläggning names nobody on a post that shares its lessons: its
       * teacher was removed, so no teacher can be chosen for it while the
       * change waits for it, and it can only be removed. Never on a post that
       * shares nothing, whose rows all name nobody because the post's teacher
       * is theirs (review of #298, MEDEL-3).
       */
      unstaffed: boolean;
      /**
       * The post starts to share its lessons in this very change and the förläggning belongs to a huvudlärare who is replaced in it
       * (TEACHER): with a new huvudlärare AND shares at once there is no saying whose lesson the förläggning is, so the change is
       * done in two steps. Only on a post that shared nothing before (review of #298, LÅG-3 of the second round).
       */
      startsSharing: boolean;
    };

const sameParts = (a: ReadonlyMap<number, number>, b: ReadonlyMap<number, number>): boolean =>
  a.size === b.size && [...a].every(([minutes, count]) => b.get(minutes) === count);

/**
 * THE TEACHER OF A FÖRLÄGGNING FOLLOWS A CHANGE WHEN THE CHANGE SAYS WHERE TO,
 * AND STOPS IT OTHERWISE (the user's choice, 2026-11-09).
 *
 * `before` and `after` are the post as stored and as the write leaves it:
 * its huvudlärare, its shares and its lessons. Each teacher who stays keeps
 * their förläggningar. When exactly one teacher leaves and exactly one comes
 * in with the same lessons — the same lengths, as many of each — that is a
 * change of teacher and nothing else, and the leaving teacher's förläggningar
 * become the new one's: the way a förläggning on a post that shares nothing
 * follows the post's teacher, and the way a share nobody teaches (a deleted
 * teacher's) is given one. Anything else that leaves a förläggning with a
 * teacher who no longer has a lesson of its length is not for this function
 * to settle; it answers which förläggning, and why, and the write is refused
 * with it:
 *
 *   TEACHER         its teacher teaches none of the post's lessons any more
 *                   (a share removed, or two teachers changed at once);
 *   NO_TEACHER      its lesson would be nobody's (a share's teacher taken
 *                   away, the huvudlärare cleared);
 *   TEACHER_LENGTH  its teacher stays, without a lesson of that length;
 *   TEACHER_COUNT   its teacher stays, with fewer lessons of that length than
 *                   are placed.
 *
 * A post that shares nothing before and after is not this function's: its
 * rows name nobody and its teacher is the post's, so nothing moves and
 * nothing is refused (the post's own rules are the trigger's, as before).
 * Rows on a post that stops sharing name nobody again; rows on a post that
 * starts sharing name its huvudlärare, whose lessons they were. A row that
 * names nobody on a shared post stays on the lessons nobody teaches while
 * there are any.
 */
export function followPlacements(
  before: PlacementPost,
  after: PlacementPost,
  rows: readonly FollowedRow[],
): PlacementsFollow {
  if (rows.length === 0 || (!hasShares(before) && !hasShares(after))) return { ok: true, moves: [] };
  const was = teacherPartsOf(before);
  const now = teacherPartsOf(after);
  const to = new Map<string | null, string | null>();
  for (const teacher of was.keys()) if (now.has(teacher)) to.set(teacher, teacher);
  const left = [...was.keys()].filter((teacher) => !now.has(teacher));
  const came = [...now.keys()].filter((teacher) => !was.has(teacher));
  if (left.length === 1 && came.length === 1 && sameParts(was.get(left[0]!)!, now.get(came[0]!)!)) {
    to.set(left[0]!, came[0]!);
  }

  const shared = hasShares(after);
  // A row is nobody's because its teacher was removed only on a post that shared its lessons already.
  const unstaffed = (row: FollowedRow): boolean => hasShares(before) && (row.teacherId ?? null) === null;
  // A refusal on a post that shared nothing and now shares: TEACHER is the huvudlärare changed together with the shares.
  const startsSharing = !hasShares(before) && shared;
  const placed: FollowedRow[] = [];
  for (const row of rows) {
    const from = teacherOfRow(before, row);
    if (!to.has(from)) return { ok: false, reason: 'TEACHER', row, unstaffed: unstaffed(row), startsSharing };
    const teacher = to.get(from)!;
    // A lesson that was somebody's is never made nobody's by a change of the post.
    if (shared && teacher === null && from !== null) return { ok: false, reason: 'NO_TEACHER', row, unstaffed: false, startsSharing: false };
    placed.push({ ...row, teacherId: shared ? teacher : null });
  }
  const misfit = teacherMisfitOf(after, placed);
  if (misfit !== null) {
    const row = rows[misfit.index]!;
    return { ok: false, reason: misfit.reason, row, unstaffed: unstaffed(row), startsSharing: startsSharing && misfit.reason === 'TEACHER' };
  }
  return {
    ok: true,
    moves: placed.flatMap((row, at) => (row.teacherId !== rows[at]!.teacherId ? [{ id: row.id, teacherId: row.teacherId }] : [])),
  };
}
