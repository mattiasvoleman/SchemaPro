import type { LessonRecurrence } from '@prisma/client';
import { lessonMinutesOf, type LessonShape } from '../common/lesson-lengths';
import type { LessonShare } from '../common/lesson-shares';
import type { BlockPlacementsRule } from '../common/utils/prisma-errors';

/*
 * FÖRLAGDA BLOCK: WHETHER A PARALLEL BLOCK'S FÖRLÄGGNINGAR FIT THE BLOCK. Pure; no clock, no database.
 *
 * A block's förläggning (TeachingBlockPlacement) is ONE lesson of the block at a day and a start, a length that is
 * one of the block's, and the block's weeks. Every member sits it, and a member that has a room of its own for it
 * is named in `rooms` (TeachingBlockPlacementRooms); a member that is not named has its room chosen by the engine.
 *
 * THE BLOCK'S LESSONS ARE ANY MEMBER'S. TB409 (20261024090000) makes every member agree on lessonsPerWeek,
 * minutesPerLesson, lessonLengths and recurrence, so the rules read the member with the lowest id and no more, as
 * the trigger does. The rules are the trigger's (BP409, migration 20270218090000), in its order, so that this copy
 * says which rule before the write and the 409 can name the row:
 *
 *   FOLLOWER  the block follows another block's times (sameTimesAsBlockId): it is placed through the block it follows;
 *   EMPTY     the block has no members to sit the lesson;
 *   SHARES    a member shares its lessons between teachers (decision 9 of the plan: not in the first version);
 *   LENGTH    a row's length is not one of the block's;
 *   WEEKS     a row runs other weeks than the block's. Pairs (odd and even weeks in different places) are not
 *             supported for a block, so on an every-week block a row of odd or even weeks is refused too;
 *   COUNT     more lessons of a length are placed than the block has;
 *   MEMBER    a room is named for a post that is not a member of the block.
 *
 * Nothing here reads a room's existence, the week's clashes or the school day: those are the service's and the judge's.
 */

/** What the fit reads of a member of a block. */
export interface PlacementBlockMember extends LessonShape {
  id: string;
  recurrence: LessonRecurrence;
  /** The member's shares (TeachingRequirementShares); empty or absent on a post that shares nothing. */
  shares?: readonly LessonShare[] | null;
}

/** What the fit reads of a block. */
export interface PlacementBlock {
  id: string;
  /** The block whose times this one takes (sameTimesAsBlockId); null on a block placed on its own. */
  sameTimesAsBlockId: string | null;
  members: readonly PlacementBlockMember[];
}

/** What the fit reads of one of a block's lessons, as a request states it or a stored row has it. */
export interface BlockRowShape {
  minutes: number;
  recurrence: LessonRecurrence;
  /** The members that chose a room of their own for this lesson. */
  rooms?: readonly { requirementId: string; roomId: string }[];
}

/** The member the block's lessons are read from: the lowest id, as the trigger reads it. */
export function blockShapeOf(block: Pick<PlacementBlock, 'members'>): PlacementBlockMember | null {
  let first: PlacementBlockMember | null = null;
  for (const member of block.members) if (first === null || member.id < first.id) first = member;
  return first;
}

/** The block's lesson lengths, longest first, one per lesson; empty with no member. */
export function blockLengthsOf(block: Pick<PlacementBlock, 'members'>): number[] {
  const shape = blockShapeOf(block);
  return shape === null ? [] : [...lessonMinutesOf(shape)].sort((a, b) => b - a);
}

/**
 * The first rule the rows break on this block, and the row it is said of (null for a rule that is about the block), or
 * null when they fit. Rows in any order. A block with no row fits.
 */
export function blockFitOf(
  block: PlacementBlock,
  rows: readonly BlockRowShape[],
): { reason: BlockPlacementsRule; index: number | null } | null {
  if (rows.length === 0) return null;
  if (block.sameTimesAsBlockId !== null) return { reason: 'FOLLOWER', index: null };
  const shape = blockShapeOf(block);
  if (shape === null) return { reason: 'EMPTY', index: null };
  if (block.members.some((member) => (member.shares ?? []).length > 0)) return { reason: 'SHARES', index: null };
  const lengths = lessonMinutesOf(shape);
  const length = rows.findIndex((row) => !lengths.includes(row.minutes));
  if (length >= 0) return { reason: 'LENGTH', index: length };
  const weeks = rows.findIndex((row) => row.recurrence !== shape.recurrence);
  if (weeks >= 0) return { reason: 'WEEKS', index: weeks };
  for (const minutes of new Set(lengths)) {
    const has = lengths.filter((one) => one === minutes).length;
    const placed = rows.flatMap((row, index) => (row.minutes === minutes ? [index] : []));
    // The last of the lessons of a length is the one over the count.
    if (placed.length > has) return { reason: 'COUNT', index: placed[placed.length - 1]! };
  }
  const memberIds = new Set(block.members.map((member) => member.id));
  const stranger = rows.findIndex((row) => (row.rooms ?? []).some((room) => !memberIds.has(room.requirementId)));
  if (stranger >= 0) return { reason: 'MEMBER', index: stranger };
  return null;
}

/** Whether the rows name one member twice for one lesson, which the table's unique key refuses: the first such row. */
export function firstRowWithTwoRoomsForOneMember(rows: readonly Pick<BlockRowShape, 'rooms'>[]): number {
  return rows.findIndex((row) => {
    const ids = (row.rooms ?? []).map((room) => room.requirementId);
    return new Set(ids).size !== ids.length;
  });
}
