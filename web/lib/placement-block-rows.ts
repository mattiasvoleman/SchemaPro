import type { TimetableLesson } from "@/components/schedule/timetable-grid";
import { partsOfLengths, type BlockPlacementInput, type PlacementsOfBlock } from "@/lib/block-placements";
import {
  summaryOf,
  type BoardBlock,
  type BoardBlockRow,
  type BoardBlockVerdict,
  type BoardFilters,
  type BoardPost,
  type CardNames,
  type PlacementBoard,
} from "@/lib/placement-board";
import type { Spot } from "@/lib/placement-rows";
import type { PlacementRecurrence, PlacementRefusalReason } from "@/lib/requirement-placements";
import { clockOfMinutes } from "@/lib/requirement-placement-text";
import { timeToMinutes } from "@/lib/utils";

/*
 * Förlägg i veckan, the part of a PARALLEL BLOCK's lessons that is arithmetic on lists: what a lesson of a block on the week
 * is CALLED, how the block's whole list is rebuilt with one lesson moved, added or removed, what is still to lay (the bricks),
 * and the figures. The same job placement-rows.ts does for a post's rows, and the same rules:
 *
 * A LESSON IS NOT ITS ROW. Every save of a block replaces the whole list with new ids and gives the block a new `rowsKey`, so a
 * card, a selection, a focus and an undo step that held a row's id would point at nothing after the very save that made it. A
 * lesson is named by the block, its length and its place (day, start and weeks), and two that are the same on all of these are
 * one lesson twice and get `#2`, `#3` so that each is unique inside a list.
 *
 * THE PUT REPLACES THE WHOLE LIST, so a move of one lesson is a write of every lesson of the block, and every other lesson
 * goes back AS IT IS, with the rooms its posts chose: a rebuilt list that dropped a lesson's rooms would give the block's
 * posts the engine's choice and no word of it.
 *
 * WHAT IS LEFT IS THE BLOCK'S, NOT THE POSTS'. A block lesson is ONE lesson that every post of the block sits. The member posts
 * have `cannotPlace: 'BLOCK'`, so the posts' own bricks skip them (rightly: they must not get a brick each); the bricks of a
 * block are the block's lengths less the lessons it has (`partsOfLengths`), counted once.
 *
 * Pure: no React, no clock, no network.
 */

/** What names a lesson of a block: its length and its place. */
export type BlockKeyed = Pick<BoardBlockRow, "minutes" | "dayOfWeek" | "startTime" | "recurrence">;

/** The name of a lesson before it is made unique inside a list: `blockId|length|day|start|weeks`. */
export const blockKeyOf = (blockId: string, row: BlockKeyed): string => [blockId, row.minutes, row.dayOfWeek, row.startTime, row.recurrence].join("|");

/**
 * One unique key per lesson, in the lessons' own order: `blockKeyOf`, and `#2`, `#3` after the second and third lesson that is the
 * same. The same lessons in the same order get the same keys, and a save that gives them new ids does not change them.
 */
export function keysOfBlockRows(blockId: string, rows: readonly BlockKeyed[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const key = blockKeyOf(blockId, row);
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    return count === 1 ? key : `${key}#${count}`;
  });
}

/** Row id → its key, over every lesson of every block of the board (a filter changes none). */
export function blockKeyByRowId(blocks: readonly Pick<BoardBlock, "id" | "rows">[]): Map<string, string> {
  const keys = new Map<string, string>();
  for (const block of blocks) {
    const names = keysOfBlockRows(block.id, block.rows);
    block.rows.forEach((row, index) => keys.set(row.id, names[index]!));
  }
  return keys;
}

/**
 * The card of a lesson of a block. `blockplacement:`, not `block:`: that prefix is the grundschema's block cards (block-cards.tsx),
 * and not `placement:`, which is a post's card.
 */
export const blockCardId = (key: string): string => `blockplacement:${key}`;

/** What a card id of a block's lesson names, or null for any other card. */
export const blockKeyOfCard = (card: string): string | null => (card.startsWith("blockplacement:") ? card.slice("blockplacement:".length) : null);

/** The mirror's `Placement` of one member of a block's lesson: the lesson's card and the post. */
export const blockMemberId = (key: string, requirementId: string): string => `${blockCardId(key)}:${requirementId}`;

/**
 * A lesson of a block still to lay: `block:<blockId>|<minutes>#n`. The form differs from a post's brick (`post|teacher|minutes#n`):
 * a post's id is a uuid and never starts with `block:`, so the two cannot be taken for one another.
 */
export interface BlockBrick {
  key: string;
  blockId: string;
  minutes: number;
}

export const blockBrickKey = (blockId: string, minutes: number, n: number): string => `block:${blockId}|${minutes}#${n}`;

/**
 * The lessons left to lay: for every block that can be placed at all (a block that follows another is placed through that one, a
 * block with no post sits nothing, and a post that shares its lessons keeps the block from being placed), one brick per lesson of
 * each length that it has not got a lesson for. The count comes from the block's own lengths and rows, NOT from its posts'
 * `parts[].left`: the posts of a block are all `cannotPlace: 'BLOCK'` and count the block's lessons once each.
 */
export function blockBricksOf(blocks: readonly Pick<BoardBlock, "id" | "cannotPlace" | "lengths" | "rows">[]): BlockBrick[] {
  const bricks: BlockBrick[] = [];
  for (const block of blocks) {
    if (block.cannotPlace !== null) continue;
    for (const part of partsOfLengths(block.lengths)) {
      const placed = block.rows.filter((row) => row.minutes === part.minutes).length;
      for (let n = 1; n <= part.count - placed; n++) bricks.push({ key: blockBrickKey(block.id, part.minutes, n), blockId: block.id, minutes: part.minutes });
    }
  }
  return bricks;
}

/** The lessons of a block that are still to place, counted once (what Generera lays for the block whatever the number of posts). */
export function blockLessonsLeft(block: Pick<BoardBlock, "lengths" | "rows">): number {
  return partsOfLengths(block.lengths).reduce((sum, part) => sum + Math.max(0, part.count - block.rows.filter((row) => row.minutes === part.minutes).length), 0);
}

/** The room a post of the block chose for a lesson. */
export interface BlockRoomChoice {
  requirementId: string;
  roomId: string;
}

/** A stored lesson as the PUT takes it, unchanged: its rooms go back as they were. */
export function blockInputOf(row: Pick<BoardBlockRow, "dayOfWeek" | "startTime" | "minutes" | "rooms">): BlockPlacementInput {
  return {
    dayOfWeek: row.dayOfWeek,
    startTime: row.startTime,
    minutes: row.minutes,
    rooms: row.rooms.map((room) => ({ requirementId: room.requirementId, roomId: room.roomId })),
  };
}

export type BlockEdit =
  | { kind: "add"; input: BlockPlacementInput }
  /** A lesson to another place and, when `rooms` is given (the posts that chose one, and no more), to other rooms; left out, its rooms stay. */
  | { kind: "move"; key: string; to: Spot; rooms?: readonly BlockRoomChoice[] }
  /** One lesson: a block has no pairs, so a removal is never more than one. */
  | { kind: "remove"; key: string };

/**
 * The block's whole list with one change made to it, every other lesson as it stands with its rooms; null for a lesson the list no
 * longer has (the week moved under the reader). `rows` are the block's lessons in the board's order, ALL of them (not the ones a
 * filter shows): the PUT replaces the list.
 */
export function blockListAfter(blockId: string, rows: readonly BoardBlockRow[], edit: BlockEdit): BlockPlacementInput[] | null {
  const list = rows.map(blockInputOf);
  if (edit.kind === "add") return [...list, edit.input];
  const index = keysOfBlockRows(blockId, rows).indexOf(edit.key);
  if (index === -1) return null;
  if (edit.kind === "remove") return list.filter((_, at) => at !== index);
  return list.map((entry, at) =>
    at !== index
      ? entry
      : {
          ...entry,
          dayOfWeek: edit.to.dayOfWeek,
          startTime: clockOfMinutes(edit.to.startMinutes),
          ...(edit.rooms !== undefined ? { rooms: edit.rooms.map((room) => ({ requirementId: room.requirementId, roomId: room.roomId })) } : {}),
        },
  );
}

/** The block's brick at a spot as the lesson the PUT takes: the posts' rooms given, and a post not named has the engine's choice. */
export function blockInputOfBrick(brick: BlockBrick, spot: Spot, rooms: readonly BlockRoomChoice[]): BlockPlacementInput {
  return {
    dayOfWeek: spot.dayOfWeek,
    startTime: clockOfMinutes(spot.startMinutes),
    minutes: brick.minutes,
    rooms: rooms.map((room) => ({ requirementId: room.requirementId, roomId: room.roomId })),
  };
}

/** The block's lessons in the board's order. */
export const rowsOfBlock = (board: Pick<PlacementBoard, "blocks">, blockId: string): BoardBlockRow[] => board.blocks.find((block) => block.id === blockId)?.rows ?? [];

/** The key the next write of a block must say it is made on top of: the board's, which a write's answer replaces. */
export const baseKeyOfBlock = (board: Pick<PlacementBoard, "blocks">, blockId: string): string | undefined => board.blocks.find((block) => block.id === blockId)?.rowsKey;

/**
 * The verdicts the gateway gave ONE lesson in an answer. `index` is the lesson's place in the ANSWER's list, which the gateway keeps
 * in (day, start, id) order, and not its place in the list that was sent: a lesson added before another changes the numbering.
 * (A refusal's `index` is the other way round: a place in the list that was SENT, which `WriteFailure.list` holds.)
 */
export const verdictsOfAnswerRow = (answer: Pick<PlacementsOfBlock, "verdicts">, index: number): PlacementsOfBlock["verdicts"] =>
  answer.verdicts.filter((verdict) => verdict.index === index);

const lessonsByLength = (rows: readonly Pick<BoardBlockRow, "minutes">[]): Map<number, number> => {
  const counts = new Map<number, number>();
  for (const row of rows) counts.set(row.minutes, (counts.get(row.minutes) ?? 0) + 1);
  return counts;
};

/**
 * The week with one block's lessons and key replaced by what a write answered, and the counts of the block's posts moved by the
 * lessons the write placed or took away: a member sits every lesson of the block and has the block's lengths (TB409), so each
 * lesson placed is one more `placed` and one less `left` in the member's part of that length (a brick is gone, or is back, as the
 * write lands). The counts are an estimate until the week's own read, which is made at once.
 */
export function patchBoardBlock(board: PlacementBoard, blockId: string, answer: PlacementsOfBlock, now: string): PlacementBoard {
  const block = board.blocks.find((entry) => entry.id === blockId);
  if (!block) return board;
  const written: BoardBlockRow[] = answer.placements.map((lesson, index) => ({
    id: lesson.id,
    dayOfWeek: lesson.dayOfWeek,
    startTime: lesson.startTime,
    endTime: lesson.endTime,
    minutes: lesson.minutes,
    recurrence: lesson.recurrence,
    rooms: lesson.rooms,
    changedAt: now,
    verdicts: verdictsOfAnswerRow(answer, index).map((verdict) => ({
      requirementId: verdict.requirementId,
      ok: verdict.ok,
      ...(verdict.reason ? { reason: verdict.reason as PlacementRefusalReason } : {}),
      ...(verdict.params ? { params: verdict.params } : {}),
    })),
  }));
  const was = lessonsByLength(block.rows);
  const now_ = lessonsByLength(written);
  const members = new Set(block.memberIds);
  return {
    ...board,
    blocks: board.blocks.map((entry) => (entry.id === blockId ? { ...entry, rows: written, rowsKey: answer.rowsKey } : entry)),
    posts: board.posts.map((post) => {
      if (!members.has(post.id)) return post;
      return {
        ...post,
        parts: post.parts.map((part) => {
          const delta = (now_.get(part.minutes) ?? 0) - (was.get(part.minutes) ?? 0);
          return delta === 0 ? part : { ...part, placed: Math.max(0, part.placed + delta), left: Math.max(0, part.left - delta) };
        }),
      };
    }),
  };
}

const picks = (list: readonly string[], id: string | null): boolean => list.length === 0 || (id !== null && list.includes(id));

/**
 * The blocks narrowed by class, teacher and room: a block belongs to every class and every teacher of any of its posts (the
 * post's teacher, the teachers of its parts and its medlärare), and a lesson of it to the rooms its posts chose for it. A lesson
 * with no room (the engine chooses it) stands in no room: it is shown while no room is picked, and matches none that is. A block is
 * shown when its class and a teacher are picked and, when a room is picked, when one of its lessons stands in it; it is then given
 * the lessons that do. The posts' own filter (visibleBoard) is not changed.
 */
export function visibleBlocks(board: Pick<PlacementBoard, "posts" | "blocks">, filters: BoardFilters): BoardBlock[] {
  const postById = new Map(board.posts.map((post) => [post.id, post]));
  return board.blocks.flatMap((block) => {
    const members = block.memberIds.flatMap((id) => (postById.has(id) ? [postById.get(id)!] : []));
    const classOk = filters.groups.length === 0 || members.some((post) => filters.groups.includes(post.studentGroupId));
    const teacherOk =
      filters.teachers.length === 0 ||
      members.some((post) => [post.teacherId, post.coTeacherId, ...post.parts.map((part) => part.teacherId)].some((id) => picks(filters.teachers, id)));
    if (!classOk || !teacherOk) return [];
    if (filters.rooms.length === 0) return [block];
    const rows = block.rows.filter((row) => row.rooms.some((room) => filters.rooms.includes(room.roomId)));
    return rows.length > 0 ? [{ ...block, rows }] : [];
  });
}

/** What the lessons of a block say of the week: they are förläggningar, and one that does not hold counts once, however many posts it fails for. */
export function blockSummaryOf(blocks: readonly Pick<BoardBlock, "cannotPlace" | "lengths" | "rows">[]): { rows: number; failing: number; left: number } {
  return {
    rows: blocks.reduce((sum, block) => sum + block.rows.length, 0),
    failing: blocks.reduce((sum, block) => sum + block.rows.filter((row) => row.verdicts.some((verdict) => !verdict.ok)).length, 0),
    // A block that follows another is placed through it and has nothing of its own to lay.
    left: blocks.reduce((sum, block) => sum + (block.cannotPlace === "FOLLOWER" ? 0 : blockLessonsLeft(block)), 0),
  };
}

/**
 * The year's figures with the blocks in them. A post of a block has no lessons of its own (`cannotPlace: 'BLOCK'`) and its `left`
 * counts the block's lessons once for every post, so the figure "left" is the other posts' plus the blocks' own, each lesson of a
 * block once: the number of bricks the reader can lay, and the number Generera would place as lessons, not as rows of posts.
 */
export function summaryWithBlocks(board: Pick<PlacementBoard, "placements" | "posts" | "blocks">): { rows: number; failing: number; left: number } {
  const own = summaryOf({ placements: board.placements, posts: board.posts.filter((post) => post.cannotPlace !== "BLOCK") });
  const blocks = blockSummaryOf(board.blocks);
  return { rows: own.rows + blocks.rows, failing: own.failing + blocks.failing, left: own.left + blocks.left };
}

/** One sentence said of some of a lesson's posts, in the order the posts have in the block. */
export interface VerdictLine {
  requirementIds: string[];
  text: string;
}

/**
 * The verdicts that do not hold, said by sentence: posts that fail for the same sentence are said together, the posts in the order
 * `order` gives them (the block's), a post it does not know last. `sentence` writes one verdict in the reader's language.
 */
export function verdictLines(
  verdicts: readonly Pick<BoardBlockVerdict, "requirementId" | "ok" | "reason" | "params">[],
  order: readonly string[],
  sentence: (verdict: Pick<BoardBlockVerdict, "reason" | "params">) => string,
): VerdictLine[] {
  const place = (id: string): number => {
    const at = order.indexOf(id);
    return at === -1 ? Infinity : at;
  };
  const byText = new Map<string, string[]>();
  for (const verdict of [...verdicts].filter((entry) => !entry.ok).sort((a, b) => place(a.requirementId) - place(b.requirementId))) {
    const text = sentence(verdict);
    byText.set(text, [...(byText.get(text) ?? []), verdict.requirementId]);
  }
  return [...byText].map(([text, requirementIds]) => ({ requirementIds, text }));
}

/** The weeks window the lessons of a block run, as its posts have it: shared by all, else none is said. */
export function windowOfBlock(posts: readonly Pick<BoardPost, "startDate" | "endDate">[]): { startDate: string | null; endDate: string | null } {
  const first = posts[0];
  if (!first) return { startDate: null, endDate: null };
  return posts.every((post) => post.startDate === first.startDate && post.endDate === first.endDate)
    ? { startDate: first.startDate, endDate: first.endDate }
    : { startDate: null, endDate: null };
}

/** The words a block's card needs besides the page's own lookups. */
export interface BlockCardText {
  /** "Motorn väljer sal", or "Sal på 2 av 3 poster": how many of the block's posts chose a room for the lesson. */
  rooms: (chosen: number, total: number) => string;
}

/**
 * The lessons of the blocks as cards: the block's name for the title, the posts' subjects for the subtitle, the rooms said as a count,
 * the weeks as a post's card says them, and a red ring on a lesson any of whose posts does not hold. `keys` is each lesson's key
 * (blockKeyByRowId), which the card is named by.
 */
export function blockCards(
  blocks: readonly BoardBlock[],
  posts: ReadonlyMap<string, BoardPost>,
  names: Pick<CardNames, "subject" | "weeks" | "color">,
  text: BlockCardText,
  keys: ReadonlyMap<string, string>,
): TimetableLesson[] {
  return blocks.flatMap((block) => {
    const members = block.memberIds.flatMap((id) => (posts.has(id) ? [posts.get(id)!] : []));
    const window = windowOfBlock(members);
    const subjects = members.map((post) => names.subject(post.subjectId)?.name).filter((name): name is string => Boolean(name));
    return block.rows.map((row): TimetableLesson => {
      const note = names.weeks({ recurrence: row.recurrence, startDate: window.startDate, endDate: window.endDate });
      return {
        id: blockCardId(keys.get(row.id) ?? row.id),
        dayOfWeek: row.dayOfWeek,
        startMinutes: timeToMinutes(row.startTime),
        endMinutes: timeToMinutes(row.endTime),
        title: block.name,
        subtitle: subjects.join(" · "),
        room: text.rooms(row.rooms.length, block.memberIds.length),
        // A block has no subject of its own: a colour from its id, the same each time.
        color: names.color(block.id, null),
        conflicted: row.verdicts.some((verdict) => !verdict.ok),
        ...(note ? { recurrenceNote: note } : {}),
      };
    });
  });
}

/** What a block's lessons say as weeks: `ODD_WEEKS`, `EVEN_WEEKS`, or every week when the block runs none of its own (no member). */
export const weeksOfBlock = (block: Pick<BoardBlock, "recurrence">): PlacementRecurrence => block.recurrence ?? "ALL_WEEKS";
