import { createHash } from 'node:crypto';
import type { LessonRecurrence, PrismaClient } from '@prisma/client';
import { toWallClock } from '../common/utils/time';
import { judgeDemandOf } from '../optimization/post-demand';
import type { TaughtLesson } from '../optimization/locked-coverage';
import { blockFitOf, blockLengthsOf, type PlacementBlock, type PlacementBlockMember } from './block-placement-fit';
import { placedByRowsOf } from './placement-fit';
import {
  clockText,
  judgedRowOf,
  type JudgedPlacement,
  type JudgedPost,
  type PlacementDemand,
  type PlacementParams,
  type PlacementRefusalReason,
  type PlacementVerdict,
} from './placement-judge';
import type { PlacementSlot } from './requirement-placements.service';

/*
 * FÖRLAGDA BLOCK, THE JUDGE'S SIDE: A BLOCK'S LESSON IS ONE ROW PER MEMBER.
 *
 * A block's förläggning is one fact about the block, and the judge asks about rows of posts (a class, a subject,
 * teachers, a room), so each lesson of the block is read as one JudgedPlacement per member, in ONE call to
 * judgePlacements so that the members are judged against each other too. They are different teaching groups, so
 * nothing in one member stands in the way of another in the same lesson (the class and the subject are the post's
 * own); a teacher, a room or a pupil two members share is a real clash and is refused, by the member it is found
 * on. Rows of ordinary posts are judged against a block's rows as neighbours (`beside`), and a post's OVER_DEMAND
 * counts a block's rows as lessons of each member the block places.
 *
 * The rows are put together HERE, once, for every caller (the block's save and read, the week's board, an ordinary
 * post's save, Generera's pre-flight), so that the verdict on a lesson is the same wherever it is asked (review of
 * #315, MEDEL-1: the judge's input is built in one place).
 *
 * A member is read as a post that is in no block (`blockId: null`): the judge's own BLOCK rule refuses a row of a
 * post in a block, and a block's lesson is exactly what a block is placed by.
 */

/** What the judge reads of a member post, from a select of the post. */
export interface BlockMemberPost extends JudgedPost, PlacementBlockMember {
  lessonsPerWeek: number;
  minutesPerLesson: number;
  lessonLengths: number[];
  recurrence: LessonRecurrence;
}

/** One lesson of a block: where it stands, and the rooms the members chose for it. */
export interface BlockSlot {
  dayOfWeek: number;
  startMinutes: number;
  minutes: number;
  recurrence: LessonRecurrence;
  rooms: readonly { requirementId: string; roomId: string }[];
}

/** A stored lesson of a block. */
export interface StoredBlockRow extends BlockSlot {
  id: string;
  changedAt: Date;
  /** The names of the rooms, in `rooms`' order. */
  roomNames: readonly string[];
}

/** A block of the year as the judge and the board read it. */
export interface LoadedBlock extends PlacementBlock {
  name: string;
  members: readonly BlockMemberPost[];
  rows: readonly StoredBlockRow[];
}

const minutesOfClock = (time: Date): number => time.getUTCHours() * 60 + time.getUTCMinutes();

/** The same order for every list of a block's lessons, so a verdict's index is a row's place in the answer. */
export const BLOCK_ROW_ORDER = [{ dayOfWeek: 'asc' }, { startTime: 'asc' }, { id: 'asc' }] as const;

const MEMBER_SELECT = {
  id: true,
  studentGroupId: true,
  subjectId: true,
  teacherId: true,
  coTeacherId: true,
  lessonsPerWeek: true,
  minutesPerLesson: true,
  lessonLengths: true,
  recurrence: true,
  blockId: true,
  startDate: true,
  endDate: true,
  shares: { select: { teacherId: true, lessons: true, minutes: true } },
} as const;

const ROW_SELECT = {
  id: true,
  dayOfWeek: true,
  startTime: true,
  minutes: true,
  recurrence: true,
  updatedAt: true,
  rooms: { select: { requirementId: true, roomId: true, room: { select: { name: true } } }, orderBy: { requirementId: 'asc' } },
} as const;

type RowSelected = {
  id: string;
  dayOfWeek: number;
  startTime: Date;
  minutes: number;
  recurrence: LessonRecurrence;
  updatedAt: Date;
  rooms: { requirementId: string; roomId: string; room: { name: string } }[];
};

const storedRowOf = (row: RowSelected): StoredBlockRow => ({
  id: row.id,
  dayOfWeek: row.dayOfWeek,
  startMinutes: minutesOfClock(row.startTime),
  minutes: row.minutes,
  recurrence: row.recurrence,
  rooms: row.rooms.map((room) => ({ requirementId: room.requirementId, roomId: room.roomId })),
  roomNames: row.rooms.map((room) => room.room.name),
  changedAt: row.updatedAt,
});

/**
 * A block's stored lessons with the rooms of its members only. A post that left the block at the very moment a room row was being
 * written for it leaves a row for a post that is not a member (the migration's preamble: nothing refuses it, and nothing may
 * depend on it): it is no member's room, so it is not read, and the next save of the block replaces every row.
 */
function membersRoomsOnly(rows: readonly StoredBlockRow[], members: readonly { id: string }[]): StoredBlockRow[] {
  const ids = new Set(members.map((member) => member.id));
  return rows.map((row) => {
    if (row.rooms.every((room) => ids.has(room.requirementId))) return row;
    const keep = row.rooms.map((room) => ids.has(room.requirementId));
    return { ...row, rooms: row.rooms.filter((_, at) => keep[at]), roomNames: row.roomNames.filter((_, at) => keep[at]) };
  });
}

/**
 * The year's blocks with their members and their lessons: one read. `onlyPlaced` leaves out the blocks with no lesson
 * (what an ordinary post is judged beside), `except` one block (the block being written, whose rows are the request's).
 */
export async function loadBlocksOfYear(
  tx: PrismaClient,
  academicYearId: string,
  options: { onlyPlaced?: boolean; except?: string } = {},
): Promise<LoadedBlock[]> {
  const blocks = await tx.teachingBlock.findMany({
    where: {
      academicYearId,
      ...(options.onlyPlaced ? { placements: { some: {} } } : {}),
      ...(options.except ? { id: { not: options.except } } : {}),
    },
    select: {
      id: true,
      name: true,
      sameTimesAsBlockId: true,
      requirements: { select: MEMBER_SELECT, orderBy: { id: 'asc' } },
      placements: { select: ROW_SELECT, orderBy: [...BLOCK_ROW_ORDER] },
    },
    orderBy: { id: 'asc' },
  });
  return blocks.map((block) => ({
    id: block.id,
    name: block.name,
    sameTimesAsBlockId: block.sameTimesAsBlockId,
    members: block.requirements,
    rows: membersRoomsOnly(block.placements.map(storedRowOf), block.requirements),
  }));
}

/** One block with its members and lessons, or null when it is not there (row-level security hides another school's). */
export async function loadBlock(tx: PrismaClient, id: string): Promise<(LoadedBlock & { academicYearId: string; schoolId: string }) | null> {
  const block = await tx.teachingBlock.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      academicYearId: true,
      schoolId: true,
      sameTimesAsBlockId: true,
      requirements: { select: MEMBER_SELECT, orderBy: { id: 'asc' } },
      placements: { select: ROW_SELECT, orderBy: [...BLOCK_ROW_ORDER] },
    },
  });
  if (!block) return null;
  return {
    id: block.id,
    name: block.name,
    academicYearId: block.academicYearId,
    schoolId: block.schoolId,
    sameTimesAsBlockId: block.sameTimesAsBlockId,
    members: block.requirements,
    rows: membersRoomsOnly(block.placements.map(storedRowOf), block.requirements),
  };
}

/** The member's own room for a lesson, or null: the engine chooses it. */
const roomOf = (slot: Pick<BlockSlot, 'rooms'>, requirementId: string): string | null =>
  slot.rooms.find((room) => room.requirementId === requirementId)?.roomId ?? null;

/** What the members' rows are given for a lesson of the block with this id (a draft row has none). */
const memberRowId = (placementId: string | null, requirementId: string): string | null =>
  placementId === null ? null : `${placementId}:${requirementId}`;

/** One lesson of the block as a PlacementSlot of one member (what the count and the demand read). */
export const memberSlotOf = (slot: BlockSlot, requirementId: string): PlacementSlot => ({
  dayOfWeek: slot.dayOfWeek,
  startMinutes: slot.startMinutes,
  minutes: slot.minutes,
  roomId: roomOf(slot, requirementId),
  recurrence: slot.recurrence,
  teacherId: null,
});

/** Where a judged row came from: the lesson of the block (its place in the list it was built from) and the member. */
export interface BlockRowOrigin {
  blockId: string;
  /** The lesson's place in `rows`. */
  index: number;
  requirementId: string;
}

/**
 * Every lesson of the block as one row per member, in lesson order and, within a lesson, in the members' id order: the
 * judge's rows, and where each came from. A row of a block that does not fit it (blockFitOf) carries the rule, so that a
 * set another writer stored, or a membership change that left it wrong, is said by name instead of judged as clean.
 */
export function judgedRowsOfBlock(
  block: PlacementBlock & { members: readonly BlockMemberPost[] },
  rows: readonly (BlockSlot & { id?: string | null })[],
): { judged: JudgedPlacement[]; origins: BlockRowOrigin[] } {
  const members = [...block.members].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const misfit = blockFitOf(block, rows)?.reason ?? null;
  const judged: JudgedPlacement[] = [];
  const origins: BlockRowOrigin[] = [];
  rows.forEach((row, index) => {
    for (const member of members) {
      judged.push({
        ...judgedRowOf(
          { ...member, blockId: null },
          {
            dayOfWeek: row.dayOfWeek,
            startMinutes: row.startMinutes,
            minutes: row.minutes,
            roomId: roomOf(row, member.id),
            recurrence: row.recurrence,
            teacherId: null,
          },
          memberRowId(row.id ?? null, member.id),
        ),
        blockFit: misfit,
      });
      origins.push({ blockId: block.id, index, requirementId: member.id });
    }
  });
  return { judged, origins };
}

/** The lessons of the block each member sits, as that member's slots: what the member's count and demand read. */
export function memberSlotsOfBlock(block: Pick<LoadedBlock, 'members'>, rows: readonly BlockSlot[]): Map<string, PlacementSlot[]> {
  const slots = new Map<string, PlacementSlot[]>();
  if (rows.length === 0) return slots;
  for (const member of block.members) slots.set(member.id, rows.map((row) => memberSlotOf(row, member.id)));
  return slots;
}

/**
 * What OVER_DEMAND reads of each member of the blocks given: the member's lessons, its covering locks and the lessons
 * the block's rows place for it. `locksOf` is the caller's read of a post's covering locks (the one function every
 * caller already asks).
 */
export function demandOfBlockMembers(
  blocks: readonly { block: Pick<LoadedBlock, 'members'>; rows: readonly BlockSlot[] }[],
  locksOf: (member: BlockMemberPost) => readonly TaughtLesson[],
): Map<string, PlacementDemand> {
  const demand = new Map<string, PlacementDemand>();
  for (const { block, rows } of blocks) {
    if (rows.length === 0) continue;
    for (const member of block.members) {
      const slots = rows.map((row) => memberSlotOf(row, member.id));
      demand.set(member.id, judgeDemandOf(member, [...locksOf(member)], placedByRowsOf(member, slots)));
    }
  }
  return demand;
}

/** The stored lessons of the blocks as rows an ordinary post's lessons are judged beside. */
export function besideRowsOfBlocks(blocks: readonly LoadedBlock[]): JudgedPlacement[] {
  return blocks.flatMap((block) => judgedRowsOfBlock(block, block.rows).judged);
}

/**
 * The key of a block's lessons as a reader saw them: the rows' own ids, where and how long, the weeks and the rooms
 * the members chose. Every save replaces the rows with new ids, so any change of the lessons changes the key. Built from
 * the rows, never from the members' derived rows (BLOCK_PLACEMENTS_STALE, and the staleness of a Generera run).
 */
export function blockRowsKeyOf(
  rows: readonly (BlockSlot & { id: string })[],
): string {
  const text = rows
    .map((row) =>
      [
        row.id,
        row.dayOfWeek,
        row.startMinutes,
        row.minutes,
        row.recurrence,
        ...[...row.rooms].sort((a, b) => (a.requirementId < b.requirementId ? -1 : 1)).map((room) => `${room.requirementId}=${room.roomId}`),
      ].join('|'),
    )
    .sort()
    .join('\n');
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

/** A verdict on one lesson of a block for one member. */
export interface BlockVerdictView {
  /** The lesson's place in the list of the block's lessons. */
  index: number;
  requirementId: string;
  ok: boolean;
  reason?: PlacementRefusalReason;
  params?: PlacementParams;
}

/** The judge's verdicts, said by lesson and member: `origins` say which row of the call is which. */
export function blockVerdictsOf(verdicts: readonly PlacementVerdict[], origins: readonly BlockRowOrigin[]): BlockVerdictView[] {
  return origins.map((origin, at) => {
    const verdict = verdicts[at] ?? { index: at, ok: true };
    return {
      index: origin.index,
      requirementId: origin.requirementId,
      ok: verdict.ok,
      ...(verdict.reason ? { reason: verdict.reason } : {}),
      ...(verdict.params ? { params: verdict.params } : {}),
    };
  });
}

/** A lesson of a block as the API states it. */
export interface BlockPlacementView {
  id: string;
  blockId: string;
  dayOfWeek: number;
  /** HH:MM. */
  startTime: string;
  /** HH:MM, the start and the length. */
  endTime: string;
  minutes: number;
  recurrence: LessonRecurrence;
  /** The members that chose a room of their own; a member not named has its room chosen by the engine. */
  rooms: { requirementId: string; roomId: string; roomName: string }[];
}

export function blockPlacementViewOf(blockId: string, row: StoredBlockRow): BlockPlacementView {
  return {
    id: row.id,
    blockId,
    dayOfWeek: row.dayOfWeek,
    startTime: toWallClock(new Date(Date.UTC(1970, 0, 1, Math.floor(row.startMinutes / 60), row.startMinutes % 60))),
    endTime: clockText(row.startMinutes + row.minutes),
    minutes: row.minutes,
    recurrence: row.recurrence,
    rooms: row.rooms.map((room, at) => ({ requirementId: room.requirementId, roomId: room.roomId, roomName: row.roomNames[at] ?? '' })),
  };
}

/** The lengths of the block's lessons, longest first (the dialog offers these). */
export { blockLengthsOf };
