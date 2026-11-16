import type { LessonRecurrence } from '@prisma/client';
import { blockLengthsOf, blockShapeOf } from './block-placement-fit';
import {
  blockRowsKeyOf,
  type BlockRowOrigin,
  type LoadedBlock,
  type StoredBlockRow,
} from './block-placement-judge';
import { clockText, type PlacementParams, type PlacementRefusalReason, type PlacementVerdict } from './placement-judge';
import type { PlacementBoardResponse } from './placement-board';

/*
 * FÖRLAGDA BLOCK ON THE WEEK OF FÖRLÄGGNINGAR (GET /teaching-requirements/placements/board, the field `blocks`).
 * Pure; the service (requirement-placements.service.ts) reads the year once and hands the facts here.
 *
 * Every block of the year, placed or not, with its members, what its lessons are, and the lessons it has: each with a
 * verdict for every member (the judge asks about rows of posts, so a lesson of a block is one row per member). A block
 * that cannot be placed says why (`cannotPlace`), as a post in a block does. The posts' own count (`posts[].parts[].placed`)
 * reads a block's lessons as lessons placed for each member, so a post's `left` is still what Generera sends less the
 * pinned lessons (Generera's count = the board's left + the pinned lessons, as for any förläggning with no room).
 */

/** The judge's verdict on one member's row of a block's lesson; `reason` and `params` only when the row does not hold. */
export interface BoardBlockVerdictView {
  requirementId: string;
  ok: boolean;
  reason?: PlacementRefusalReason;
  params?: PlacementParams;
}

/** One lesson of a block. */
export interface BoardBlockRowView {
  id: string;
  dayOfWeek: number;
  /** HH:MM. */
  startTime: string;
  /** HH:MM, the start and the length. */
  endTime: string;
  minutes: number;
  recurrence: LessonRecurrence;
  /** The members that chose a room of their own; a member not named has its room chosen by the engine. */
  rooms: { requirementId: string; roomId: string; roomName: string }[];
  /** ISO instant: when the lesson was last saved (every save replaces the block's list). */
  changedAt: string;
  /** One verdict per member, in the members' id order. */
  verdicts: BoardBlockVerdictView[];
}

/** One block of the year. */
export interface BoardBlockView {
  id: string;
  name: string;
  /** The block's members (timplansposter), in id order. */
  memberIds: string[];
  /** The block's lesson lengths, longest first, one per lesson; empty with no member. */
  lengths: number[];
  /** The block's weeks, which every lesson of it runs; null with no member. */
  recurrence: LessonRecurrence | null;
  /** The block whose times this one takes; a block that follows is placed through the block it follows. */
  followsBlockId: string | null;
  /** Why the block's lessons cannot be placed, or null when they can. */
  cannotPlace: 'FOLLOWER' | 'EMPTY' | 'SHARES' | null;
  rows: BoardBlockRowView[];
  /** The key of `rows`: what a save of the block's lessons carries as `baseKey` to be refused when they have changed. */
  rowsKey: string;
}

/** The board's response with the blocks of the year. */
export type PlacementBoardWithBlocks = PlacementBoardResponse & { blocks: BoardBlockView[] };

const hasSharedMember = (block: Pick<LoadedBlock, 'members'>): boolean => block.members.some((member) => (member.shares ?? []).length > 0);

/** One block as the board states it. `verdicts` are the judge's, in the order of `origins` (the rows judgedRowsOfBlock built). */
export function boardBlockOf(
  block: LoadedBlock,
  verdicts: readonly PlacementVerdict[],
  origins: readonly BlockRowOrigin[],
): BoardBlockView {
  const shape = blockShapeOf(block);
  const byRow = new Map<number, BoardBlockVerdictView[]>();
  origins.forEach((origin, at) => {
    const verdict = verdicts[at] ?? { index: at, ok: true };
    const list = byRow.get(origin.index) ?? [];
    list.push({
      requirementId: origin.requirementId,
      ok: verdict.ok,
      ...(verdict.reason ? { reason: verdict.reason } : {}),
      ...(verdict.params ? { params: verdict.params } : {}),
    });
    byRow.set(origin.index, list);
  });
  const rowView = (row: StoredBlockRow, index: number): BoardBlockRowView => ({
    id: row.id,
    dayOfWeek: row.dayOfWeek,
    startTime: clockText(row.startMinutes),
    endTime: clockText(row.startMinutes + row.minutes),
    minutes: row.minutes,
    recurrence: row.recurrence,
    rooms: row.rooms.map((room, at) => ({ requirementId: room.requirementId, roomId: room.roomId, roomName: row.roomNames[at] ?? '' })),
    changedAt: row.changedAt.toISOString(),
    verdicts: byRow.get(index) ?? [],
  });
  return {
    id: block.id,
    name: block.name,
    memberIds: block.members.map((member) => member.id),
    lengths: blockLengthsOf(block),
    recurrence: shape?.recurrence ?? null,
    followsBlockId: block.sameTimesAsBlockId,
    cannotPlace:
      block.sameTimesAsBlockId !== null ? 'FOLLOWER' : shape === null ? 'EMPTY' : hasSharedMember(block) ? 'SHARES' : null,
    rows: block.rows.map(rowView),
    rowsKey: blockRowsKeyOf(block.rows),
  };
}
