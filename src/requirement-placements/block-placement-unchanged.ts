import { memberSlotOf, type BlockSlot } from './block-placement-judge';
import { sentIndexOf, unchangedOf, type SlotLike } from './placement-unchanged';

/*
 * WHICH ROWS OF A BLOCK'S SAVE ARE THE ONES THE BLOCK ALREADY HAS (review of #326 in #328: the same dead end as a
 * post's, placement-unchanged.ts).
 *
 * A save replaces the block's whole list and the judge judges every lesson of it for every member. A block with two
 * lessons that both stopped holding (a teacher made unavailable that day, a frame cut short) could then not be mended
 * one lesson at a time: each change left the other red lesson in the list, and the judge refused the change for it. So
 * the save is refused for the rows it NEW or CHANGED, and a row the block has already is let stand when it still does
 * not hold: it is named in the answer as a verdict that is not ok, as the block's read names it, and Generera refuses
 * it by name as before.
 *
 * The row is a lesson for ONE member, as the judge judges it: the member's own slot (day, start, length, weeks and the
 * room that member chose) is the same row when the block has an equal one, counted and not looked up
 * (placement-unchanged.ts). A lesson whose room changed for one member is a changed row for that member and an
 * unchanged one for the others.
 */

/** The key of a row in a set of verdicts: the lesson's place in the list and the member. */
export const blockRowKeyOf = (index: number, requirementId: string): string => `${index}|${requirementId}`;

/** The rows (blockRowKeyOf) of `wanted`, lesson by lesson and member by member, that an equal row of `stored` already is. */
export function unchangedRowsOfBlock(
  members: readonly { id: string }[],
  wanted: readonly BlockSlot[],
  stored: readonly BlockSlot[],
): Set<string> {
  const unchanged = new Set<string>();
  for (const member of members) {
    const same = unchangedOf(
      wanted.map((row) => memberSlotOf(row, member.id)),
      stored.map((row) => memberSlotOf(row, member.id)),
    );
    same.forEach((is, index) => {
      if (is) unchanged.add(blockRowKeyOf(index, member.id));
    });
  }
  return unchanged;
}

/** A lesson as one slot, its rooms said as one text: two lessons are equal when they stand at the same time with the same rooms. */
const lessonSlotOf = (lesson: BlockSlot): SlotLike => ({
  dayOfWeek: lesson.dayOfWeek,
  startMinutes: lesson.startMinutes,
  minutes: lesson.minutes,
  recurrence: lesson.recurrence,
  teacherId: null,
  roomId:
    lesson.rooms.length === 0
      ? null
      : lesson.rooms
          .map((room) => `${room.requirementId}=${room.roomId}`)
          .sort()
          .join(','),
});

/**
 * The place in `wanted` of each lesson of `written`, in the order of `written`: the lessons come back in the order the
 * block reads them (day, start), not the order they were sent, so a verdict is carried from where the lesson was sent
 * to where it comes back. -1 for a lesson that is none of the sent ones (the database wrote what was not sent).
 */
export function sentLessonsOf(written: readonly BlockSlot[], wanted: readonly BlockSlot[]): number[] {
  return sentIndexOf(written.map(lessonSlotOf), wanted.map(lessonSlotOf));
}
