import type { LessonRecurrence, PrismaClient } from '@prisma/client';

/*
 * Parallella block in the grundschema: which lessons stand together.
 *
 * A block is a set of timplansposter whose lessons the generator places at the
 * same times (TeachingRequirements."blockId", 20261024090000). A lesson cannot
 * name its post — MasterLessons has no requirement column — so it reaches it
 * the way every other reader does, by the post's own key (läsår, class,
 * subject), and the post's block from there.
 *
 * A BLOCK CARD is what the timetable shows for one slot of a block: the
 * lessons of two or more of its members at the same day, start, end and weeks.
 * Weeks are part of the slot because a lesson only runs beside another in the
 * weeks both run; two members at 09:00 on odd and even weeks are not one card.
 *
 * WHAT A HAND EDIT DOES TO A BLOCK (update, in master-lessons.service.ts):
 * - moving the whole card keeps every member's owner as it was: the engine can
 *   place a block's lessons together, so a card it placed stays its own and
 *   the next generation places it again with the rest of the block;
 * - moving ONE member away from the others splits the block: that lesson is
 *   the school's from then on (isGenerated false), so the next generation
 *   refuses the block as partly locked rather than tearing the school's move
 *   apart without a word, and the save says so (BLOCK_SPLIT);
 * - moving a member onto a slot where other members of its block stand joins
 *   it to that card, owner and lock and all — which is what an undo of the
 *   split, or "flytta tillbaka med blocket", is.
 */

/** The warning a hand edit that splits a block answers with, beside the saved lesson. */
export const BLOCK_SPLIT = 'BLOCK_SPLIT';

/** A slot as the card compares it: the clock as HH:MM, the weeks as dates. */
export interface BlockSlot {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  recurrence: LessonRecurrence;
  /** YYYY-MM-DD, or null. */
  startDate: string | null;
  endDate: string | null;
}

/** A placed lesson of another member of the block. */
export interface BlockSibling extends BlockSlot {
  id: string;
  studentGroupId: string;
  subjectId: string;
  isGenerated: boolean;
  isLocked: boolean;
}

export interface LessonBlock {
  blockId: string;
  name: string;
  /** Every placed (not parked) lesson of the block's OTHER members. */
  siblings: BlockSibling[];
}

interface SiblingRow {
  blockId: string;
  name: string;
  id: string | null;
  studentGroupId: string | null;
  subjectId: string | null;
  dayOfWeek: number | null;
  startTime: string | null;
  endTime: string | null;
  recurrence: LessonRecurrence | null;
  startDate: string | null;
  endDate: string | null;
  isGenerated: boolean | null;
  isLocked: boolean | null;
}

/**
 * The lesson's block and the other members' placed lessons, or null when its
 * post is in none.
 *
 * ONE STATEMENT, on a write path whose statements are counted
 * (projected-rosters.budget.spec.ts): the post by its key, its block, the
 * block's other posts and their lessons, joined. Zero rows is no block; a
 * block whose other members have no placed lesson is one row of nulls.
 * Under the caller's RLS like every read of a hand edit. The clock and the
 * dates come back as text, compared as the card compares them.
 */
export async function readLessonBlock(
  tx: PrismaClient,
  lesson: { id: string; academicYearId: string; studentGroupId: string; subjectId: string },
): Promise<LessonBlock | null> {
  const rows = await tx.$queryRaw<SiblingRow[]>`
    SELECT b."id" AS "blockId", b."name",
           ml."id", ml."studentGroupId", ml."subjectId", ml."dayOfWeek",
           to_char(ml."startTime", 'HH24:MI') AS "startTime",
           to_char(ml."endTime", 'HH24:MI') AS "endTime",
           ml."recurrence",
           to_char(ml."startDate", 'YYYY-MM-DD') AS "startDate",
           to_char(ml."endDate", 'YYYY-MM-DD') AS "endDate",
           ml."isGenerated", ml."isLocked"
      FROM "TeachingRequirements" own
      JOIN "TeachingBlocks" b ON b."id" = own."blockId"
      LEFT JOIN "TeachingRequirements" other
        ON other."blockId" = b."id" AND other."id" <> own."id"
      LEFT JOIN "MasterLessons" ml
        ON ml."academicYearId" = other."academicYearId"
       AND ml."studentGroupId" = other."studentGroupId"
       AND ml."subjectId" = other."subjectId"
       AND ml."isParked" = false
       AND ml."id" <> ${lesson.id}::uuid
     WHERE own."academicYearId" = ${lesson.academicYearId}::uuid
       AND own."studentGroupId" = ${lesson.studentGroupId}::uuid
       AND own."subjectId" = ${lesson.subjectId}::uuid`;
  const first = rows[0];
  if (!first?.blockId) return null;
  return {
    blockId: first.blockId,
    name: first.name,
    siblings: rows
      .filter((row): row is SiblingRow & { id: string } => row.id !== null)
      .map((row) => ({
        id: row.id,
        studentGroupId: row.studentGroupId!,
        subjectId: row.subjectId!,
        dayOfWeek: row.dayOfWeek!,
        startTime: row.startTime!,
        endTime: row.endTime!,
        recurrence: row.recurrence!,
        startDate: row.startDate,
        endDate: row.endDate,
        isGenerated: row.isGenerated === true,
        isLocked: row.isLocked === true,
      })),
  };
}

/** Whether two lessons stand in one slot: the same day, clock and weeks. */
export function sameSlot(a: BlockSlot, b: BlockSlot): boolean {
  return (
    a.dayOfWeek === b.dayOfWeek &&
    a.startTime === b.startTime &&
    a.endTime === b.endTime &&
    a.recurrence === b.recurrence &&
    a.startDate === b.startDate &&
    a.endDate === b.endDate
  );
}

/**
 * What moving ONE member of a block to `landing` does to the lesson: joins the
 * card of the members already there, taking its owner and, when they agree, its
 * lock; or, with no member there, splits it from the block and makes it the
 * school's. Null when the block's other members have no placed lesson to stand
 * beside — then there is nothing to split from, and the edit is any edit.
 */
export function blockMoveOf(
  block: LessonBlock,
  landing: BlockSlot,
): { joins: true; isGenerated: boolean; isLocked: boolean | null } | { joins: false } | null {
  if (block.siblings.length === 0) return null;
  const card = block.siblings.filter((sibling) => sameSlot(sibling, landing));
  if (card.length === 0) return { joins: false };
  const locked = card.every((sibling) => sibling.isLocked)
    ? true
    : card.every((sibling) => !sibling.isLocked)
      ? false
      : null;
  return { joins: true, isGenerated: card.every((sibling) => sibling.isGenerated), isLocked: locked };
}
