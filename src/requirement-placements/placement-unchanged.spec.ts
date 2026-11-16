import { sentIndexOf, slotKeyOf, unchangedOf, type SlotLike } from './placement-unchanged';

const slot = (over: Partial<SlotLike> = {}): SlotLike => ({
  dayOfWeek: 2,
  startMinutes: 600,
  minutes: 60,
  roomId: 'room-1',
  recurrence: 'ALL_WEEKS',
  teacherId: null,
  ...over,
});

describe('slotKeyOf', () => {
  it('is the same for the same row and differs in every column', () => {
    const base = slotKeyOf(slot());
    expect(slotKeyOf(slot())).toBe(base);
    for (const over of [
      { dayOfWeek: 3 },
      { startMinutes: 605 },
      { minutes: 55 },
      { roomId: 'room-2' },
      { roomId: null },
      { recurrence: 'ODD_WEEKS' },
      { teacherId: 'teacher-1' },
    ] as Partial<SlotLike>[]) {
      expect(slotKeyOf(slot(over))).not.toBe(base);
    }
  });

  it('does not mix up a room with a teacher of the same text', () => {
    expect(slotKeyOf(slot({ roomId: null, teacherId: 't' }))).not.toBe(slotKeyOf(slot({ roomId: 't', teacherId: null })));
  });
});

describe('unchangedOf', () => {
  it('says which rows of the save the post has already, in the order of the save', () => {
    const stored = [slot({ dayOfWeek: 2 }), slot({ dayOfWeek: 3 })];
    expect(unchangedOf([slot({ dayOfWeek: 3 }), slot({ dayOfWeek: 4 }), slot({ dayOfWeek: 2 })], stored)).toEqual([true, false, true]);
  });

  it('counts rows: equal rows in the save take one stored each', () => {
    expect(unchangedOf([slot(), slot(), slot()], [slot(), slot()])).toEqual([true, true, false]);
    expect(unchangedOf([slot(), slot()], [slot()])).toEqual([true, false]);
  });

  it('finds nothing in an empty list, and nothing to say of an empty save', () => {
    expect(unchangedOf([slot()], [])).toEqual([false]);
    expect(unchangedOf([], [slot()])).toEqual([]);
  });

  it('takes a moved row as new: one column changed is another row', () => {
    expect(unchangedOf([slot({ startMinutes: 605 })], [slot()])).toEqual([false]);
  });
});

describe('sentIndexOf', () => {
  it('gives where each written row was sent from, whatever order the answer has them in', () => {
    const sent = [slot({ dayOfWeek: 4 }), slot({ dayOfWeek: 2 })];
    const written = [slot({ dayOfWeek: 2 }), slot({ dayOfWeek: 4 })];
    expect(sentIndexOf(written, sent)).toEqual([1, 0]);
  });

  it('gives equal rows their places in turn, and -1 for a row that was not sent', () => {
    expect(sentIndexOf([slot(), slot()], [slot(), slot()])).toEqual([0, 1]);
    expect(sentIndexOf([slot({ dayOfWeek: 5 })], [slot()])).toEqual([-1]);
  });
});
