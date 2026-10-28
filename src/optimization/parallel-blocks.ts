import type { AiEngineConflictAnalysis, AiEngineConflictDetail } from './interfaces/ai-engine-payload.interface';
import type { SameTimesLink } from './same-times';

/*
 * Parallella block, as the generate payload is built: which blocks the engine
 * is asked to hold together, and which are refused before it is called.
 *
 * A block's members are the timplansposter of one läsår whose lessons are
 * placed at the same times (TeachingRequirements."blockId"). The engine holds
 * the k-th lesson of each member to the k-th of the others, so it has to be
 * sent members that each have the same lessons left to place. Locks are what
 * can break that: a lesson placed by hand reaches the engine as a fixed
 * lesson with no requirement id, and it cancels demand row by row
 * (locked-coverage.ts), so a block with one member's Monday locked would ask
 * the engine to hold Tyska's two lessons beside Franska's one — or, with both
 * locked on different days, to place nothing and call it a block.
 *
 * ONLY THE GATEWAY KNOWS WHICH LOCK BELONGS TO WHICH ROW, so this is where a
 * partly locked block is refused, by name (BLOCK_PARTLY_LOCKED), before the
 * engine is woken. A block with every lesson locked has nothing left to place
 * and is not a refusal: the school placed it, and it stays where it is.
 *
 * TWO BLOCKS ON THE SAME TIMES (same-times.ts) are one for the locks: the
 * follower's lessons are written at the leader's times, so either both have
 * all their lessons to place, and the leader is sent and the follower
 * mirrored, or neither has any. One placed and the other not would put the
 * follower beside lessons the engine never placed, or the leader away from a
 * follower the school put somewhere: refused by name, as a partly locked
 * block is (BLOCK_SAME_TIMES_PARTLY_LOCKED).
 */

export interface BlockRow {
  id: string;
  /** Null or absent: a row in no block. */
  blockId?: string | null;
}

export interface PartlyLockedBlock {
  blockId: string;
  /** Every member, in payload order. */
  memberIds: string[];
  /** The lessons of the block's members the school locked or placed by hand. */
  locked: number;
}

/** Two blocks on the same times, one placed (locked or by hand) and the other with its lessons to place. */
export interface LockedApartBlocks {
  /** The block placed. */
  blockId: string;
  /** The block with its lessons to place. */
  otherBlockId: string;
  /** Every member of both, the placed block's first. */
  memberIds: string[];
  /** The placed block's lessons the school locked or placed by hand. */
  locked: number;
}

export interface BlockJudgement {
  /** Blocks whose members are sent with their blockId: two or more, all to place, none locked. */
  sent: Set<string>;
  partlyLocked: PartlyLockedBlock[];
  /** Linked blocks the school placed one of: refused with the partly locked. */
  lockedApart: LockedApartBlocks[];
  /**
   * Follower blocks whose posts are written at their leader's times: not
   * sent, and with the leader in the links the caller plans (same-times.ts).
   */
  mirrored: Map<string, SameTimesLink>;
}

/**
 * Judge every block of the year over all its members.
 *
 *  - One member: no block. Nothing is held to it, so a lock on it is any
 *    post's lock (it cancels demand as it always did), and it is neither
 *    sent nor refused — the payload is the one a school without blocks sends.
 *  - Nothing left to place in any member: not sent, not refused.
 *  - A lesson locked anywhere in the block while a member has lessons left:
 *    refused as partly locked. EVERY preserved lesson of a member counts, not
 *    only those that cancel demand, for the reason lockedDays gives (one
 *    locked odd weeks is still on its Monday in the weeks it runs, and the
 *    engine, which has no weeks, would place the block beside it).
 *  - Otherwise every member has its whole demand, which the database holds
 *    equal across the block (TB409), and a block of two or more members with
 *    lessons to place is sent.
 *
 * A linked pair (`links`, both blocks with members) is judged together, and
 * each of the two by the rules above whatever its size — a block of one is a
 * block here, because its lessons decide the other's times:
 *
 *  - Either partly locked: refused as partly locked, by its own name.
 *  - Both with nothing to place: neither sent, nothing refused.
 *  - Both with every lesson to place and none locked: the leader sent (with
 *    its blockId when it has two members or more), the follower mirrored.
 *  - One with nothing to place and the other all: refused, the two named
 *    (lockedApart).
 */
export function judgeBlocks(
  rows: readonly BlockRow[],
  remainingOf: (rowId: string) => number,
  lockedOf: (rowId: string) => number,
  links: readonly SameTimesLink[] = [],
): BlockJudgement {
  const membersOf = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.blockId) continue;
    const members = membersOf.get(row.blockId);
    if (members) members.push(row.id);
    else membersOf.set(row.blockId, [row.id]);
  }
  const sent = new Set<string>();
  const partlyLocked: PartlyLockedBlock[] = [];
  const lockedApart: LockedApartBlocks[] = [];
  const mirrored = new Map<string, SameTimesLink>();
  const paired = links.filter((link) => membersOf.has(link.leaderBlockId) && membersOf.has(link.followerBlockId));
  const linked = new Set(paired.flatMap((link) => [link.leaderBlockId, link.followerBlockId]));
  const lockedIn = (memberIds: readonly string[]) => memberIds.reduce((sum, id) => sum + lockedOf(id), 0);
  for (const [blockId, memberIds] of membersOf) {
    if (memberIds.length < 2 || linked.has(blockId)) continue;
    const toPlace = memberIds.filter((id) => remainingOf(id) > 0);
    if (toPlace.length === 0) continue;
    const locked = lockedIn(memberIds);
    if (locked > 0) {
      partlyLocked.push({ blockId, memberIds, locked });
    } else if (toPlace.length >= 2) {
      sent.add(blockId);
    }
  }
  for (const link of paired) {
    const ends = [link.leaderBlockId, link.followerBlockId].map((blockId) => {
      const memberIds = membersOf.get(blockId)!;
      const locked = lockedIn(memberIds);
      const toPlace = memberIds.filter((id) => remainingOf(id) > 0).length;
      const state = toPlace === 0 ? 'placed' : locked > 0 ? 'partly' : 'open';
      return { blockId, memberIds, locked, state };
    });
    const [leader, follower] = ends as [(typeof ends)[number], (typeof ends)[number]];
    const partly = ends.filter((end) => end.state === 'partly');
    if (partly.length > 0) {
      partlyLocked.push(...partly.map(({ blockId, memberIds, locked }) => ({ blockId, memberIds, locked })));
    } else if (leader.state === 'open' && follower.state === 'open') {
      if (leader.memberIds.length >= 2) sent.add(leader.blockId);
      mirrored.set(follower.blockId, link);
    } else if (leader.state !== follower.state) {
      const [placed, open] = leader.state === 'placed' ? [leader, follower] : [follower, leader];
      lockedApart.push({
        blockId: placed.blockId,
        otherBlockId: open.blockId,
        memberIds: [...placed.memberIds, ...open.memberIds],
        locked: placed.locked,
      });
    }
  }
  return { sent, partlyLocked, lockedApart, mirrored };
}

/** The problem codes of the refusal, which the engine's catalogue renders. */
export const BLOCK_PARTLY_LOCKED_SUMMARY = 'BLOCK_PARTLY_LOCKED_SUMMARY';
export const BLOCK_PARTLY_LOCKED = 'BLOCK_PARTLY_LOCKED';
export const BLOCK_SAME_TIMES_PARTLY_LOCKED = 'BLOCK_SAME_TIMES_PARTLY_LOCKED';

/**
 * The refusal, in the anonymous ids the payload was built with, so it goes
 * back to the school through realiseConflicts exactly as an engine refusal
 * does: the block named by its name, the members as "Tyska för Ty7". The
 * English is the catalogue's (optimization-engine/app/messages.py), rendered
 * here because the engine never sees this refusal; the web renders the
 * Swedish from the codes and params.
 */
export function partlyLockedRefusal(
  /**
   * `other`: a block on the same times as `block` that has all its lessons
   * to place while `block` has none (LockedApartBlocks), said as such; the
   * summary counts the two as one, the block whose rest is still to place.
   */
  blocks: readonly { block: string; members: string[]; locked: number; other?: string }[],
): AiEngineConflictAnalysis {
  const count = blocks.length;
  const lessons = (locked: number) => (locked === 1 ? '1 lesson' : `${locked} lessons`);
  return {
    summary:
      `${count === 1 ? '1 block has' : `${count} blocks have`} lessons locked or placed by hand ` +
      "while the rest of the block is still to be placed, and a block's lessons are placed together.",
    summaryCode: BLOCK_PARTLY_LOCKED_SUMMARY,
    summaryParams: { count },
    conflicts: blocks.map(({ block, members, locked, other }): AiEngineConflictDetail => {
      if (other !== undefined) {
        return {
          category: 'TEACHING_BLOCK',
          code: BLOCK_SAME_TIMES_PARTLY_LOCKED,
          params: { block, other, locked },
          message:
            `${block} has ${lessons(locked)} locked or placed by hand, while ${other}, which takes the same ` +
            `times in other weeks, still has all of its lessons to place. Lock the two blocks together, or unlock ${block}. ` +
            'Blocks of one entry each have no block card: select the lessons of both with shift-click and lock them together.',
          requirementIds: members,
          roomIds: [],
          constraintIds: [],
          resourceIds: [block, other],
        };
      }
      const message =
        `${block} has ${lessons(locked)} locked or placed by hand ` +
        "while the rest of it is still to be placed. Unlock the block's lessons, or lock all of them.";
      return {
        category: 'TEACHING_BLOCK',
        code: BLOCK_PARTLY_LOCKED,
        params: { block, locked },
        message,
        requirementIds: members,
        roomIds: [],
        constraintIds: [],
        resourceIds: [block],
      };
    }),
  };
}
