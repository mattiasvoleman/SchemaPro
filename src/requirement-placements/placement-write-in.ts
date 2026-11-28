import type { LessonRecurrence } from '@prisma/client';
import { placedLessonRowsOf, placedLessonWritesOf, type PlacedPost, type PlacementRead } from '../optimization/placed-lessons';
import type { PlacementParams, PlacementVerdict } from './placement-judge';

/*
 * SKRIV IN FÖRLÄGGNINGARNA (E4b), the part that decides: which of the year's förläggningar become lessons, and which lessons an earlier run
 * wrote from förläggningar the write replaces.
 *
 * A school that has placed lessons and cannot get Generera to finish needs a week to work in. The bridge writes what Generera would have written from
 * the same rows and asks the engine nothing:
 *
 *   - A förläggning that the week holds (the verdict the board gives it, judged as Generera's pre-flight judges it) and that names a room is
 *     written by placedLessonWritesOf, the one place outside the fetch that turns a förläggning into a master lesson: the post's lesson at the
 *     row's day, clock, room and weeks, locked and marked as the run's own, so that the next Generera writes it again from the row as it then stands.
 *   - One the week does not hold is not written, and is named with its verdict. (Generera refuses the whole run for it; the bridge writes the
 *     rest and says which it left.)
 *   - One whose room the generator would not take (fewer seats than the pupils, another kind than the subject needs, years the room is fenced from)
 *     is not written either, and is named with the reason (BOARD_ROOM_NOT_ALLOWED, the code a lay in that room is refused with): a lock names its room
 *     and the engine asks nothing of it, but a lesson made by hand here is held to the rule a lay is held to.
 *   - One that leaves the room to the engine is not written: a lesson has to name its room here, and only the engine chooses one. It is named.
 *   - A parallel block's förläggningar are pinned lessons of every member and are the engine's too (a lock inside a block is a partly locked
 *     block). They are named and left to Generera.
 *
 * WHAT IT REPLACES. The lessons an earlier run wrote from förläggningar (fromPlacement) of a post the bridge writes for, as Generera deletes them
 * before it writes its own, so that a row moved since is not written beside the lesson it was. A lesson that answers a row the bridge does not
 * write (its room was the engine's choice, or the row has stopped holding) stays: the bridge would take away what only the engine can put back.
 * It is told apart from the rest by what a row says of it, time by time and in which weeks (a row has no id on its lesson). A post the bridge writes nothing for is not
 * touched at all. A lesson that is exactly what a row would write (the same teachers, room, clock and weeks) is left where it is and its row writes
 * no copy, so that a second write over the same rows changes nothing: no new ids, nothing in the calendar swept.
 */

export type NotWrittenReason = 'REFUSED' | 'NO_ROOM' | 'BLOCK';

/** A förläggning the bridge left, and why. */
export interface NotWrittenRow {
  /** The förläggning's id (a block's lesson: the block placement's). */
  rowId: string;
  /** The post; absent on a block's lesson, which belongs to the block. */
  requirementId?: string;
  blockId?: string;
  reason: NotWrittenReason;
  /** REFUSED: the week's verdict, as the board gives it. */
  verdict?: { reason?: string; params?: PlacementParams };
}

/** A lesson an earlier run wrote from a förläggning, as the bridge reads it. */
export interface ExistingPlacedLesson {
  id: string;
  studentGroupId: string;
  subjectId: string;
  teacherId: string | null;
  coTeacherId: string | null;
  roomId: string | null;
  dayOfWeek: number;
  startTime: Date;
  endTime: Date;
  recurrence: LessonRecurrence;
  startDate: Date | null;
  endDate: Date | null;
}

/** Why the generator would not put a lesson of the row's class and subject in its room (placement-room-refusal.ts). */
export type RoomRefusalReason = 'SEATS' | 'TYPE' | 'YEARS';

export interface WriteInInput {
  schoolId: string;
  academicYearId: string;
  /** The posts' förläggningar in the order the verdicts were asked in. */
  rows: readonly PlacementRead[];
  /** The week's verdict for each row (the first `rows.length` of the judged list); a row with none is read as holding. */
  verdicts: readonly PlacementVerdict[];
  posts: ReadonlyMap<string, PlacedPost>;
  /** The blocks' förläggningar, which are not written here. */
  blockRows: readonly { id: string; blockId: string }[];
  /** The lessons an earlier run wrote from förläggningar (fromPlacement). */
  existing: readonly ExistingPlacedLesson[];
  /** The rows (by id) whose room the generator would not take: left and named, as a lay in that room is refused. A row with no room has none. */
  roomRefusals?: ReadonlyMap<string, { roomId: string; reason: RoomRefusalReason }>;
}

export interface WriteInPlan {
  /** The lessons to create: MasterLesson rows, as Generera writes them from the same förläggningar. */
  creates: NonNullable<ReturnType<typeof placedLessonWritesOf>>;
  /** The lessons an earlier run wrote that this write replaces. */
  deleteIds: string[];
  notWritten: NotWrittenRow[];
  /** The posts that got a lesson. */
  postsWritten: number;
}

const minutesOf = (time: Date): number => time.getUTCHours() * 60 + time.getUTCMinutes();

const dayOf = (value: Date | null): string => (value === null ? '' : value.toISOString().slice(0, 10));

/**
 * A lesson or a row by what time by time says of it: class, subject, day, start and length, AND the weeks it runs in (odd or even, the post's
 * window). The weeks are in the key because a pair is one post's two rows at one slot, odd weeks and even weeks: without them the two halves
 * are one key, and a half left (its row no longer holds) keeps whichever old lesson comes first by id, which may be the half the write rewrites
 * (granskaren g505, M-1 of #508): that half is then written twice and the half left is deleted.
 */
const slotKey = (
  studentGroupId: string,
  subjectId: string,
  dayOfWeek: number,
  startMinutes: number,
  minutes: number,
  recurrence: LessonRecurrence,
  startDate: Date | null,
  endDate: Date | null,
): string => `${studentGroupId}|${subjectId}|${dayOfWeek}|${startMinutes}|${minutes}|${recurrence}|${dayOf(startDate)}|${dayOf(endDate)}`;

export function planWriteIn(input: WriteInInput): WriteInPlan {
  const written: PlacementRead[] = [];
  const notWritten: NotWrittenRow[] = [];
  // The slots of the rows the bridge leaves in the posts it does write for, with how many of an old lesson each can keep.
  const leftSlots = new Map<string, number>();
  const leave = (row: PlacementRead): void => {
    const post = input.posts.get(row.requirementId);
    if (!post) return;
    const key = slotKey(post.studentGroupId, post.subjectId, row.dayOfWeek, minutesOf(row.startTime), row.minutes, row.recurrence, post.startDate, post.endDate);
    leftSlots.set(key, (leftSlots.get(key) ?? 0) + 1);
  };

  input.rows.forEach((row, index) => {
    const verdict = input.verdicts[index];
    if (!input.posts.has(row.requirementId)) return;
    if (verdict !== undefined && !verdict.ok) {
      leave(row);
      notWritten.push({
        rowId: row.id,
        requirementId: row.requirementId,
        reason: 'REFUSED',
        verdict: { ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}), ...(verdict.params !== undefined ? { params: verdict.params } : {}) },
      });
    } else if (row.roomId === null) {
      leave(row);
      notWritten.push({ rowId: row.id, requirementId: row.requirementId, reason: 'NO_ROOM' });
    } else if (input.roomRefusals?.has(row.id)) {
      // The generator would not put the lesson in that room (a lay there is BOARD_ROOM_NOT_ALLOWED): left and named, as a row the week does not hold.
      leave(row);
      notWritten.push({
        rowId: row.id,
        requirementId: row.requirementId,
        reason: 'REFUSED',
        verdict: { reason: 'BOARD_ROOM_NOT_ALLOWED', params: input.roomRefusals.get(row.id)! },
      });
    } else {
      written.push(row);
    }
  });
  for (const blockRow of input.blockRows) notWritten.push({ rowId: blockRow.id, blockId: blockRow.blockId, reason: 'BLOCK' });

  const placed = placedLessonRowsOf(written, input.posts);
  const creates = placedLessonWritesOf(placed, input.posts, { schoolId: input.schoolId, academicYearId: input.academicYearId });
  if (creates === null) throw new Error('A förläggning names a post the year does not have.');

  const writtenPosts = new Set<string>();
  for (const row of placed) writtenPosts.add(`${row.studentGroupId}|${row.subjectId}`);
  const deleteIds: string[] = [];
  for (const lesson of input.existing) {
    if (!writtenPosts.has(`${lesson.studentGroupId}|${lesson.subjectId}`)) continue;
    const key = slotKey(
      lesson.studentGroupId,
      lesson.subjectId,
      lesson.dayOfWeek,
      minutesOf(lesson.startTime),
      minutesOf(lesson.endTime) - minutesOf(lesson.startTime),
      lesson.recurrence,
      lesson.startDate,
      lesson.endDate,
    );
    const kept = leftSlots.get(key) ?? 0;
    if (kept > 0) {
      leftSlots.set(key, kept - 1);
      continue;
    }
    deleteIds.push(lesson.id);
  }

  // A lesson that is exactly what a row writes stays, and the row writes no copy.
  const remaining = new Map(input.existing.filter((lesson) => deleteIds.includes(lesson.id)).map((lesson) => [lesson.id, lesson]));
  const fresh: typeof creates = [];
  for (const create of creates) {
    const same = [...remaining.values()].find((lesson) => isTheSame(lesson, create));
    if (same) remaining.delete(same.id);
    else fresh.push(create);
  }
  return { creates: fresh, deleteIds: [...remaining.keys()], notWritten, postsWritten: writtenPosts.size };
}

const sameDay = (a: Date | null, b: Date | null): boolean => (a === null || b === null ? a === b : a.getTime() === b.getTime());

/** A lesson as a write would make it: whose it is, where it stands and in which weeks. */
function isTheSame(lesson: ExistingPlacedLesson, create: WriteInPlan['creates'][number]): boolean {
  return (
    lesson.studentGroupId === create.studentGroupId &&
    lesson.subjectId === create.subjectId &&
    lesson.teacherId === create.teacherId &&
    lesson.coTeacherId === create.coTeacherId &&
    lesson.roomId === create.roomId &&
    lesson.dayOfWeek === create.dayOfWeek &&
    lesson.startTime.getTime() === create.startTime.getTime() &&
    lesson.endTime.getTime() === create.endTime.getTime() &&
    lesson.recurrence === create.recurrence &&
    sameDay(lesson.startDate, create.startDate) &&
    sameDay(lesson.endDate, create.endDate)
  );
}
