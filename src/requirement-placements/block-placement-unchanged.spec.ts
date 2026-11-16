import type { BlockSlot } from './block-placement-judge';
import { blockRowKeyOf, sentLessonsOf, unchangedRowsOfBlock } from './block-placement-unchanged';

const A = 'member-a';
const B = 'member-b';
const MEMBERS = [{ id: A }, { id: B }];

/** A lesson of the block: an hour every week, Tuesday 10:00 unless the test says otherwise. */
const lesson = (over: Partial<BlockSlot> = {}): BlockSlot => ({
  dayOfWeek: 2,
  startMinutes: 600,
  minutes: 60,
  recurrence: 'ALL_WEEKS',
  rooms: [],
  ...over,
});

describe('unchangedRowsOfBlock', () => {
  it('says an equal lesson the block has is unchanged for every member', () => {
    const rows = unchangedRowsOfBlock(MEMBERS, [lesson()], [lesson()]);

    expect([...rows].sort()).toEqual([blockRowKeyOf(0, A), blockRowKeyOf(0, B)]);
  });

  it('says nothing is unchanged in a block with no lesson', () => {
    expect(unchangedRowsOfBlock(MEMBERS, [lesson()], []).size).toBe(0);
  });

  it('says a lesson moved by a day, a start, a length or its weeks is a new row for everyone', () => {
    for (const moved of [{ dayOfWeek: 3 }, { startMinutes: 630 }, { minutes: 45 }, { recurrence: 'ODD_WEEKS' as const }]) {
      expect(unchangedRowsOfBlock(MEMBERS, [lesson(moved)], [lesson()]).size).toBe(0);
    }
  });

  it('holds the room a member chose as part of that member\'s row only', () => {
    const stored = lesson({ rooms: [{ requirementId: A, roomId: 'r1' }] });

    // B is given a room, A keeps its own: B's row is a new one and A's is not.
    const withRoomForB = lesson({ rooms: [{ requirementId: A, roomId: 'r1' }, { requirementId: B, roomId: 'r2' }] });
    expect([...unchangedRowsOfBlock(MEMBERS, [withRoomForB], [stored])]).toEqual([blockRowKeyOf(0, A)]);

    // A's room changes, B has none either way: B's row is the one that stands.
    const otherRoomForA = lesson({ rooms: [{ requirementId: A, roomId: 'r9' }] });
    expect([...unchangedRowsOfBlock(MEMBERS, [otherRoomForA], [stored])]).toEqual([blockRowKeyOf(0, B)]);

    // A room taken away is a change too.
    expect([...unchangedRowsOfBlock(MEMBERS, [lesson()], [stored])]).toEqual([blockRowKeyOf(0, B)]);
  });

  it('says the rooms in any order are the same rows', () => {
    const stored = lesson({ rooms: [{ requirementId: A, roomId: 'r1' }, { requirementId: B, roomId: 'r2' }] });
    const wanted = lesson({ rooms: [{ requirementId: B, roomId: 'r2' }, { requirementId: A, roomId: 'r1' }] });

    expect(unchangedRowsOfBlock(MEMBERS, [wanted], [stored]).size).toBe(2);
  });

  it('counts rows: one equal lesson the block has covers the first equal lesson of the save only', () => {
    const rows = unchangedRowsOfBlock(MEMBERS, [lesson(), lesson()], [lesson()]);

    expect([...rows].sort()).toEqual([blockRowKeyOf(0, A), blockRowKeyOf(0, B)]);
  });

  it('keys each lesson by its place in the save, so a verdict is found by the place it was judged at', () => {
    const rows = unchangedRowsOfBlock(MEMBERS, [lesson({ dayOfWeek: 4 }), lesson()], [lesson()]);

    expect([...rows].sort()).toEqual([blockRowKeyOf(1, A), blockRowKeyOf(1, B)]);
  });

  it('says nothing is unchanged for a block with no member', () => {
    expect(unchangedRowsOfBlock([], [lesson()], [lesson()]).size).toBe(0);
  });
});

describe('sentLessonsOf', () => {
  it('finds where in the save each written lesson was sent, though the block reads them in another order', () => {
    const thursday = lesson({ dayOfWeek: 4 });
    const tuesday = lesson();
    const wednesday = lesson({ dayOfWeek: 3 });

    // Sent Thursday, Tuesday, Wednesday; read back by day.
    expect(sentLessonsOf([tuesday, wednesday, thursday], [thursday, tuesday, wednesday])).toEqual([1, 2, 0]);
  });

  it('takes equal lessons in the order they were sent, once each', () => {
    expect(sentLessonsOf([lesson(), lesson()], [lesson(), lesson()])).toEqual([0, 1]);
  });

  it('tells lessons that differ by a room apart, and reads the rooms in any order', () => {
    const inR1 = lesson({ rooms: [{ requirementId: A, roomId: 'r1' }] });
    const inR2 = lesson({ rooms: [{ requirementId: A, roomId: 'r2' }] });
    const both = lesson({ rooms: [{ requirementId: A, roomId: 'r1' }, { requirementId: B, roomId: 'r2' }] });
    const bothReversed = lesson({ rooms: [{ requirementId: B, roomId: 'r2' }, { requirementId: A, roomId: 'r1' }] });

    expect(sentLessonsOf([inR2, inR1], [inR1, inR2])).toEqual([1, 0]);
    expect(sentLessonsOf([bothReversed], [both])).toEqual([0]);
  });

  it('says -1 for a written lesson that was not sent, and for every lesson when nothing was', () => {
    expect(sentLessonsOf([lesson({ dayOfWeek: 5 })], [lesson()])).toEqual([-1]);
    expect(sentLessonsOf([lesson()], [])).toEqual([-1]);
    expect(sentLessonsOf([], [lesson()])).toEqual([]);
  });
});
