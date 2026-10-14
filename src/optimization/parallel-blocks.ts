import type { AiEngineConflictAnalysis } from './interfaces/ai-engine-payload.interface';

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

export interface BlockJudgement {
  /** Blocks whose members are sent with their blockId: two or more, all to place, none locked. */
  sent: Set<string>;
  partlyLocked: PartlyLockedBlock[];
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
 */
export function judgeBlocks(
  rows: readonly BlockRow[],
  remainingOf: (rowId: string) => number,
  lockedOf: (rowId: string) => number,
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
  for (const [blockId, memberIds] of membersOf) {
    if (memberIds.length < 2) continue;
    const toPlace = memberIds.filter((id) => remainingOf(id) > 0);
    if (toPlace.length === 0) continue;
    const locked = memberIds.reduce((sum, id) => sum + lockedOf(id), 0);
    if (locked > 0) {
      partlyLocked.push({ blockId, memberIds, locked });
    } else if (toPlace.length >= 2) {
      sent.add(blockId);
    }
  }
  return { sent, partlyLocked };
}

/** The problem codes of the refusal, which the engine's catalogue renders. */
export const BLOCK_PARTLY_LOCKED_SUMMARY = 'BLOCK_PARTLY_LOCKED_SUMMARY';
export const BLOCK_PARTLY_LOCKED = 'BLOCK_PARTLY_LOCKED';

/**
 * The refusal, in the anonymous ids the payload was built with, so it goes
 * back to the school through realiseConflicts exactly as an engine refusal
 * does: the block named by its name, the members as "Tyska för Ty7". The
 * English is the catalogue's (optimization-engine/app/messages.py), rendered
 * here because the engine never sees this refusal; the web renders the
 * Swedish from the codes and params.
 */
export function partlyLockedRefusal(
  blocks: readonly { block: string; members: string[]; locked: number }[],
): AiEngineConflictAnalysis {
  const count = blocks.length;
  return {
    summary:
      `${count === 1 ? '1 block has' : `${count} blocks have`} lessons locked or placed by hand ` +
      "while the rest of the block is still to be placed, and a block's lessons are placed together.",
    summaryCode: BLOCK_PARTLY_LOCKED_SUMMARY,
    summaryParams: { count },
    conflicts: blocks.map(({ block, members, locked }) => {
      const message =
        `${block} has ${locked === 1 ? '1 lesson' : `${locked} lessons`} locked or placed by hand ` +
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
