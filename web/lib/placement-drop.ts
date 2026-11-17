import { pupilBufferOf, type ConflictHit, type Placement } from "@/lib/conflicts";
import { blockMemberId } from "@/lib/placement-block-rows";
import { mirrorHits, REASON_OF_HIT, type MirrorContext } from "@/lib/placement-mirror";
import { keptCardId, type BoardBlock, type BoardBlockRow, type BoardPlacement, type BoardPost } from "@/lib/placement-board";
import type { RoomPreference } from "@/lib/queries";
import type { PlacementRecurrence, PlacementRefusalReason } from "@/lib/requirement-placements";
import { PLACEMENT_DAY_END, PLACEMENT_DAY_START, PLACEMENT_GRID_MINUTES, clockOfMinutes } from "@/lib/requirement-placement-text";

/*
 * Förlägg i veckan: can a lesson stand here? What the ghost under a drag, the
 * arrow keys and the sentence under the fields say, from the mirror of the judge
 * (placement-mirror.ts). The gateway answers at the drop and its sentence is
 * the one shown; this is what is known before it.
 *
 * Pure.
 */

/** A lesson being laid or moved: what the clash rule needs to know of it besides where it is. */
export interface Mover {
  /** The card's id (a lesson that is moved: its own place is not in its way) or a brick's. */
  id: string;
  post: Pick<BoardPost, "studentGroupId" | "subjectId" | "coTeacherId" | "startDate" | "endDate">;
  teacherId: string | null;
  roomId: string | null;
  recurrence: PlacementRecurrence;
}

/** Where the lesson would stand: a day and a clock span. */
export interface Span {
  dayOfWeek: number;
  startMinutes: number;
  endMinutes: number;
}

/**
 * Why a lesson cannot stand somewhere, or that it can.
 *
 *   KEPT      a lesson Generera keeps: it is changed in the grundschema, not here
 *   LENGTH    a placed lesson's length is the post's; it is not stretched in the week
 *   DAY       outside the school day (Monday to Friday, 08:00 to 18:00, on the five-minute grid)
 *   CLASH     the clash rule's first hit: its reason and the other lesson's figures, as the gateway's sentence takes them;
 *             for a lesson of a BLOCK also `requirementId`, the post of the block that clashes (as the gateway's
 *             BLOCK_PLACEMENT_REFUSED names it)
 */
export type Drop =
  | { kind: "OK" }
  | { kind: "KEPT" }
  | { kind: "LENGTH" }
  | { kind: "DAY" }
  | { kind: "CLASH"; reason: PlacementRefusalReason; params?: Record<string, string | number>; requirementId?: string };

export const OK: Drop = { kind: "OK" };

/** The school day a förläggning must stand inside (placement-fit.ts insideSchoolDay). */
export function insideSchoolDay(span: Span): boolean {
  return (
    Number.isInteger(span.dayOfWeek) &&
    span.dayOfWeek >= 1 &&
    span.dayOfWeek <= 5 &&
    span.startMinutes >= PLACEMENT_DAY_START &&
    span.endMinutes <= PLACEMENT_DAY_END &&
    span.startMinutes % PLACEMENT_GRID_MINUTES === 0 &&
    span.endMinutes % PLACEMENT_GRID_MINUTES === 0 &&
    span.endMinutes > span.startMinutes
  );
}

/** What the other lesson of a hit is called in the gateway's sentence: its class and subject, a weekday and a time; never a person. */
export interface OtherNames {
  group: (id: string) => string | undefined;
  subject: (id: string) => string | undefined;
}

function paramsOfHit(
  context: MirrorContext,
  hit: ConflictHit,
  names: OtherNames,
  /** Lessons that are not in the week yet but are in the way of one another: the other members of a block's lesson. */
  alsoOthers: readonly Placement[] = [],
): Record<string, string | number> | undefined {
  const other = hit.otherLessonId === undefined ? undefined : [...context.others, ...alsoOthers].find((placement) => placement.id === hit.otherLessonId);
  if (!other) return undefined;
  const className = names.group(other.studentGroupId);
  const subjectName = other.subjectId ? names.subject(other.subjectId) : undefined;
  if (className === undefined || subjectName === undefined) return undefined;
  return {
    otherKind: other.id?.startsWith(keptCardId("")) ? "LESSON" : "PLACEMENT",
    className,
    subjectName,
    day: other.dayOfWeek,
    start: clockOfMinutes(other.startMinutes),
    end: clockOfMinutes(other.endMinutes),
  };
}

const placementOf = (mover: Mover, span: Span, context: MirrorContext): Placement => ({
  // The lesson's own pupils' minutes: the class's buffer for the subject, as the gateway holds the candidate to it.
  ...(pupilBufferOf(context.buffers, mover.post) ?? {}),
  id: mover.id,
  dayOfWeek: span.dayOfWeek,
  startMinutes: span.startMinutes,
  endMinutes: span.endMinutes,
  teacherId: mover.teacherId,
  coTeacherId: mover.post.coTeacherId,
  roomId: mover.roomId,
  studentGroupId: mover.post.studentGroupId,
  subjectId: mover.post.subjectId,
  recurrence: mover.recurrence,
  startDate: mover.post.startDate,
  endDate: mover.post.endDate,
});

/** The first thing in the way of the lesson at this span, in the order the grundschema reports (the booking first, the ramtid and the meal after). */
export function dropOf(context: MirrorContext, mover: Mover, span: Span, names: OtherNames): Drop {
  if (!insideSchoolDay(span)) return { kind: "DAY" };
  const hit = mirrorHits(context, placementOf(mover, span, context)).find((candidate) => REASON_OF_HIT[candidate.kind] !== null);
  if (!hit) return OK;
  const params = paramsOfHit(context, hit, names);
  return { kind: "CLASH", reason: REASON_OF_HIT[hit.kind]!, ...(params ? { params } : {}) };
}

/**
 * The next time after `from` on which the lesson stands free: forward in the
 * week by `stepMinutes` (a quarter of an hour by default) to the end of the day,
 * then on the next weekday from the start of the day, round to the start. The
 * spot `from` itself is not offered. Null when the whole week is taken.
 *
 * The grundschema's own search of free times (placement-search.ts) is not used:
 * it holds a lesson against lessons and the teacher's constraints only, and
 * offers a time the ghost shows red for a ramtid, a meal or a class that shares
 * pupils. This one asks the same mirror the ghost does.
 */
export function nextFreeSpot(
  context: MirrorContext,
  mover: Mover,
  minutes: number,
  from: { dayOfWeek: number; startMinutes: number },
  names: OtherNames,
  stepMinutes = 15,
): { dayOfWeek: number; startMinutes: number } | null {
  return freeSpotAfter((spot) => dropOf(context, mover, spot, names).kind === "OK", minutes, from, stepMinutes);
}

/** The search itself: forward from `from` by `stepMinutes`, day by day, once round the week, to the first span `free` accepts. */
function freeSpotAfter(
  free: (spot: Span) => boolean,
  minutes: number,
  from: { dayOfWeek: number; startMinutes: number },
  stepMinutes: number,
): { dayOfWeek: number; startMinutes: number } | null {
  const slotsPerDay = Math.floor((PLACEMENT_DAY_END - PLACEMENT_DAY_START - minutes) / stepMinutes) + 1;
  if (slotsPerDay <= 0) return null;
  // Positions in the week: day by day, from the start of the day, on the step.
  const slots = 5 * slotsPerDay;
  const first = (from.dayOfWeek - 1) * slotsPerDay + Math.floor((from.startMinutes - PLACEMENT_DAY_START) / stepMinutes) + 1;
  // Once round the week, not including `from` itself.
  for (let step = 0; step < slots - 1; step++) {
    const index = (((first + step) % slots) + slots) % slots;
    const dayOfWeek = Math.floor(index / slotsPerDay) + 1;
    const startMinutes = PLACEMENT_DAY_START + (index % slotsPerDay) * stepMinutes;
    if (free({ dayOfWeek, startMinutes, endMinutes: startMinutes + minutes })) return { dayOfWeek, startMinutes };
  }
  return null;
}

/** The mover of a förläggning that is moved: its own card id, its post and its row's room, teacher and weeks. */
export function moverOfRow(id: string, row: Pick<BoardPlacement, "roomId" | "teacherId" | "recurrence">, post: BoardPost): Mover {
  return { id, post, teacherId: row.teacherId ?? post.teacherId, roomId: row.roomId, recurrence: row.recurrence };
}

/**
 * A lesson of a parallel block being laid or moved: every post of the block sits it, so the lesson is one `Placement` for each post, at
 * the same place, with the room THAT post chose for it (none: the engine chooses). The posts are in the id order the gateway judges them
 * in, which decides which post a refusal names.
 */
export interface BlockMover {
  /** The lesson's card id (a lesson that is moved) or a brick's key. */
  id: string;
  blockId: string;
  recurrence: PlacementRecurrence;
  members: { post: BoardPost; roomId: string | null }[];
  /**
   * The ids, among the week's `others`, of the posts' placements the lesson has now: a lesson that is moved is not in its own way, so
   * these are held out of the week while the new place is tried (a quarter of an hour's move would otherwise clash with itself). Empty
   * for a lesson that is laid for the first time. Only this lesson's: the block's other lessons stay in the way.
   */
  ownIds: ReadonlySet<string>;
}

/** The mover of a lesson of a block that is laid for the first time: its posts with the rooms chosen (a post not named has none). */
export function moverOfBlockBrick(id: string, block: Pick<BoardBlock, "id" | "memberIds" | "recurrence">, posts: ReadonlyMap<string, BoardPost>, rooms: ReadonlyMap<string, string | null>): BlockMover {
  return {
    id,
    blockId: block.id,
    recurrence: block.recurrence ?? "ALL_WEEKS",
    members: block.memberIds.flatMap((requirementId) => (posts.has(requirementId) ? [{ post: posts.get(requirementId)!, roomId: rooms.get(requirementId) ?? null }] : [])),
    ownIds: new Set(),
  };
}

/** The mover of a lesson that is moved: its card, its posts and the rooms the row has (or the ones given), and the ids it has in the week. */
export function moverOfBlockRow(
  id: string,
  key: string,
  block: Pick<BoardBlock, "id" | "memberIds" | "recurrence">,
  row: Pick<BoardBlockRow, "rooms" | "recurrence">,
  posts: ReadonlyMap<string, BoardPost>,
  rooms: ReadonlyMap<string, string | null> = new Map(row.rooms.map((room) => [room.requirementId, room.roomId])),
): BlockMover {
  return {
    ...moverOfBlockBrick(id, block, posts, rooms),
    recurrence: row.recurrence,
    ownIds: new Set(block.memberIds.map((requirementId) => blockMemberId(key, requirementId))),
  };
}

/**
 * Every post of a block that something is in the way of at this span, in the order the gateway judges them, each with the first thing in
 * the way of it. Each post's lesson is held against the week (the lesson's own old place left out) AND against the other posts' lessons at
 * the same place: posts of a block are different teaching groups and stand in no one's way by being the same lesson, but a teacher, a room
 * or pupils two of them share is a real clash, and so is a class that sits one of them. None when nothing is in the way. The school day is the
 * whole lesson's and not a post's, and is asked first by dropOfBlock (and by the contract test, which calls this for the posts).
 */
export function blockClashes(context: MirrorContext, mover: BlockMover, span: Span, names: OtherNames): Extract<Drop, { kind: "CLASH" }>[] {
  const week = mover.ownIds.size === 0 ? context.others : context.others.filter((placement) => placement.id === null || !mover.ownIds.has(placement.id));
  const candidates = mover.members.map((member) =>
    placementOf({ id: `${mover.id}:${member.post.id}`, post: member.post, teacherId: member.post.teacherId, roomId: member.roomId, recurrence: mover.recurrence }, span, context),
  );
  return mover.members.flatMap((member, at): Extract<Drop, { kind: "CLASH" }>[] => {
    const beside = candidates.filter((_, other) => other !== at);
    const hit = mirrorHits(context, candidates[at]!, [...week, ...beside]).find((candidate) => REASON_OF_HIT[candidate.kind] !== null);
    if (!hit) return [];
    const params = paramsOfHit(context, hit, names, beside);
    return [{ kind: "CLASH", reason: REASON_OF_HIT[hit.kind]!, ...(params ? { params } : {}), requirementId: member.post.id }];
  });
}

/**
 * The first thing in the way of a lesson of a block at this span: the school day, else the first post (in the order the gateway judges them)
 * that something is in the way of, named by `requirementId`.
 */
export function dropOfBlock(context: MirrorContext, mover: BlockMover, span: Span, names: OtherNames): Drop {
  if (!insideSchoolDay(span)) return { kind: "DAY" };
  return blockClashes(context, mover, span, names)[0] ?? OK;
}

/** The next time after `from` on which a lesson of the block stands free for all its posts (as nextFreeSpot, for one post). */
export function nextFreeSpotOfBlock(
  context: MirrorContext,
  mover: BlockMover,
  minutes: number,
  from: { dayOfWeek: number; startMinutes: number },
  names: OtherNames,
  stepMinutes = 15,
): { dayOfWeek: number; startMinutes: number } | null {
  return freeSpotAfter((spot) => dropOfBlock(context, mover, spot, names).kind === "OK", minutes, from, stepMinutes);
}

/**
 * The room to offer each post of a block for a lesson: the room the post's own lessons of the block already stand in, else a room its
 * subject's rule names, else none (the engine chooses it). NEVER the room filter's: that one is a single room, which as every post's
 * suggestion would be one room for all of them, and a clash between them.
 */
export function suggestedBlockRooms(input: {
  block: Pick<BoardBlock, "memberIds" | "rows">;
  posts: ReadonlyMap<string, Pick<BoardPost, "subjectId" | "studentGroupId">>;
  rules: readonly RoomPreference[];
  /** A class's year, for a rule that holds for some years only. */
  gradeLevelOf: (studentGroupId: string) => number | null;
}): Map<string, string | null> {
  const rooms = new Map<string, string | null>();
  for (const requirementId of input.block.memberIds) {
    const post = input.posts.get(requirementId);
    if (!post) continue;
    rooms.set(
      requirementId,
      suggestedRoom({
        postRows: input.block.rows.flatMap((row) => row.rooms.filter((room) => room.requirementId === requirementId).map((room) => ({ roomId: room.roomId }))),
        rules: input.rules,
        subjectId: post.subjectId,
        gradeLevel: input.gradeLevelOf(post.studentGroupId),
        filterRooms: [],
      }),
    );
  }
  return rooms;
}

// Read by the fields, which are fetched apart from this module and must not pull it in: lib/placement-field.ts.
export { minutesOfField } from "@/lib/placement-field";

/**
 * The room to offer for a lesson: the room the post's other förläggningar stand in,
 * else a room its subject's rule names, else the room the filter picked, else none
 * (the engine chooses it).
 */
export function suggestedRoom(input: {
  postRows: readonly Pick<BoardPlacement, "roomId">[];
  rules: readonly RoomPreference[];
  subjectId: string;
  /** The class's year, for a rule that holds for some years only. */
  gradeLevel: number | null;
  filterRooms: readonly string[];
}): string | null {
  const counts = new Map<string, number>();
  for (const row of input.postRows) if (row.roomId) counts.set(row.roomId, (counts.get(row.roomId) ?? 0) + 1);
  const common = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (common) return common[0];
  const rule = input.rules.find(
    (candidate) =>
      candidate.subjectId === input.subjectId &&
      candidate.rooms.length > 0 &&
      (candidate.minGradeLevel === null || (input.gradeLevel !== null && input.gradeLevel >= candidate.minGradeLevel)) &&
      (candidate.maxGradeLevel === null || (input.gradeLevel !== null && input.gradeLevel <= candidate.maxGradeLevel)),
  );
  if (rule) return rule.rooms[0]!.roomId;
  return input.filterRooms.length === 1 ? input.filterRooms[0]! : null;
}
