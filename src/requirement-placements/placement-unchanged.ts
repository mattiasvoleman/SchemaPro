/*
 * WHICH ROWS OF A SAVE ARE THE ONES THE POST ALREADY HAS.
 *
 * A save replaces the post's whole list, and the judge judges every row of it. A post whose two lessons both stopped
 * holding (a teacher made unavailable that day, a frame cut short) could then not be mended one row at a time: each
 * change left the other red row in the list, and the judge refused the change for it (review of #326, MEDEL-2). So the
 * save is refused for the rows it NEW or CHANGED, and a row that is in the list already is let stand when it still does
 * not hold: it is named in the answer as a verdict that is not ok, as the week's read names it, and Generera refuses it
 * by name as before.
 *
 * A row is unchanged when an equal row is in the list the post has: the same teacher, length, day, start, weeks and
 * room (the post is the same by being the post's list). Rows are counted, not looked up: two equal rows in the save
 * with one in the list are one unchanged and one new.
 */

/** What makes a row the same row: where and when it stands, for whom, in which room. */
export interface SlotLike {
  dayOfWeek: number;
  startMinutes: number;
  minutes: number;
  roomId: string | null;
  recurrence: string;
  teacherId: string | null;
}

export const slotKeyOf = (slot: SlotLike): string =>
  [slot.dayOfWeek, slot.startMinutes, slot.minutes, slot.roomId ?? '', slot.recurrence, slot.teacherId ?? ''].join('|');

/**
 * For each of `wanted`, in order: whether the list the post has holds an equal row that no earlier row of `wanted`
 * has taken.
 */
export function unchangedOf(wanted: readonly SlotLike[], stored: readonly SlotLike[]): boolean[] {
  const left = new Map<string, number>();
  for (const slot of stored) {
    const key = slotKeyOf(slot);
    left.set(key, (left.get(key) ?? 0) + 1);
  }
  return wanted.map((slot) => {
    const key = slotKeyOf(slot);
    const count = left.get(key) ?? 0;
    if (count === 0) return false;
    left.set(key, count - 1);
    return true;
  });
}

/**
 * The index in `wanted` of each of `written`, in the order of `written`: a written row is the first equal row of
 * `wanted` that no earlier written row has taken. The written list is the save's list in the order the answer gives
 * (day, start, weeks), so a verdict is carried from where the row was sent to where it comes back.
 */
export function sentIndexOf(written: readonly SlotLike[], wanted: readonly SlotLike[]): number[] {
  const places = new Map<string, number[]>();
  wanted.forEach((slot, index) => {
    const key = slotKeyOf(slot);
    const list = places.get(key);
    if (list) list.push(index);
    else places.set(key, [index]);
  });
  return written.map((slot) => places.get(slotKeyOf(slot))?.shift() ?? -1);
}
