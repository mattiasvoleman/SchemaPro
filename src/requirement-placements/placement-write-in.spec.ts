import type { PlacedPost, PlacementRead } from '../optimization/placed-lessons';
import type { PlacementVerdict } from './placement-judge';
import { planWriteIn, type ExistingPlacedLesson } from './placement-write-in';

/*
 * SKRIV IN FÖRLÄGGNINGARNA (E4b): what the bridge writes, what it leaves, what it replaces.
 *
 *   - a förläggning that holds and names a room is written as Generera writes it (placedLessonWritesOf: the post's lesson at the row's day,
 *     clock, room and weeks, locked and the run's own); one the week does not hold, or one that leaves the room to the engine, is not written
 *     and is named, with its reason;
 *   - the lessons an earlier run wrote from förläggningar for a post the bridge writes for are replaced, except those that answer a row the
 *     bridge does not write (their room was the engine's, or the row stopped holding): they stay, or the bridge would take away what only the
 *     engine can put back;
 *   - a post the bridge writes nothing for is not touched, and a block's förläggningar are named and left to Generera.
 */

const SCHOOL = '33333333-3333-4333-8333-333333333333';
const YEAR = '99999999-9999-4999-8999-999999999999';
const G7A = '66666666-6666-4666-8666-666666666666';
const G7B = '77777777-7777-4777-8777-777777777777';
const MATH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SWE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ANNA = '44444444-4444-4444-8444-444444444444';
const CIA = '55555555-5555-4555-8555-555555555555';
const ROOM = '11111111-1111-4111-8111-111111111111';
const OLD_ROOM = '12121212-1212-4212-8212-121212121212';
const POST_MATH = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const POST_SWE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const POST_G7B = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const time = (value: string): Date => new Date(`1970-01-01T${value}:00.000Z`);

type Post = PlacedPost & { blockId: string | null };
const post = (over: Partial<Post> = {}): Post => ({
  id: POST_MATH,
  subjectId: MATH,
  studentGroupId: G7A,
  teacherId: ANNA,
  coTeacherId: CIA,
  recurrence: 'ALL_WEEKS',
  startDate: new Date('2026-08-17T00:00:00.000Z'),
  endDate: null,
  shares: [],
  blockId: null,
  ...over,
});

const row = (over: Partial<PlacementRead> = {}): PlacementRead => ({
  id: 'row-1',
  requirementId: POST_MATH,
  dayOfWeek: 1,
  startTime: time('09:00'),
  minutes: 60,
  roomId: ROOM,
  recurrence: 'ALL_WEEKS',
  teacherId: null,
  ...over,
});

const ok = (index: number): PlacementVerdict => ({ index, ok: true });
const refused = (index: number, reason = 'GROUP'): PlacementVerdict => ({ index, ok: false, reason, params: { other: 'Svenska 7A' } } as PlacementVerdict);

/** A lesson an earlier run wrote from a förläggning: in the old room, so that the row's lesson is another lesson unless the test says otherwise. */
const lesson = (over: Partial<ExistingPlacedLesson> = {}): ExistingPlacedLesson => ({
  id: 'old-1',
  studentGroupId: G7A,
  subjectId: MATH,
  teacherId: ANNA,
  coTeacherId: CIA,
  roomId: OLD_ROOM,
  dayOfWeek: 1,
  startTime: time('09:00'),
  endTime: time('10:00'),
  recurrence: 'ALL_WEEKS',
  startDate: new Date('2026-08-17T00:00:00.000Z'),
  endDate: null,
  ...over,
});

const posts = (...list: Post[]): ReadonlyMap<string, Post> => new Map(list.map((entry) => [entry.id, entry]));
const input = (over: Partial<Parameters<typeof planWriteIn>[0]> = {}): Parameters<typeof planWriteIn>[0] => ({
  schoolId: SCHOOL,
  academicYearId: YEAR,
  rows: [row()],
  verdicts: [ok(0)],
  posts: posts(post()),
  blockRows: [],
  existing: [],
  ...over,
});

describe('planWriteIn', () => {
  it('writes a förläggning that holds and names a room as Generera writes it: the post\'s lesson at the row\'s day, clock, room and weeks, locked, the run\'s own, marked from a förläggning', () => {
    const plan = planWriteIn(input());
    expect(plan.creates).toEqual([
      {
        schoolId: SCHOOL,
        academicYearId: YEAR,
        subjectId: MATH,
        studentGroupId: G7A,
        teacherId: ANNA,
        coTeacherId: CIA,
        roomId: ROOM,
        dayOfWeek: 1,
        startTime: time('09:00'),
        endTime: time('10:00'),
        recurrence: 'ALL_WEEKS',
        startDate: new Date('2026-08-17T00:00:00.000Z'),
        endDate: null,
        isGenerated: true,
        isLocked: true,
        fromPlacement: true,
      },
    ]);
    expect(plan.notWritten).toEqual([]);
    expect(plan.deleteIds).toEqual([]);
    expect(plan.postsWritten).toBe(1);
  });

  it('writes a shared post\'s förläggning as its own teacher\'s lesson', () => {
    const shared = post({ shares: [{ teacherId: ANNA, lessons: 1, minutes: 60 }, { teacherId: CIA, lessons: 1, minutes: 60 }], coTeacherId: null });
    const plan = planWriteIn(input({ rows: [row({ teacherId: CIA })], posts: posts(shared) }));
    expect(plan.creates[0]).toMatchObject({ teacherId: CIA, coTeacherId: null });
  });

  it('names a row the week does not hold, with its verdict, and does not write it; the rows that hold are written', () => {
    const plan = planWriteIn(
      input({
        rows: [row({ id: 'a' }), row({ id: 'b', dayOfWeek: 2 }), row({ id: 'c', dayOfWeek: 3 })],
        verdicts: [ok(0), refused(1), ok(2)],
      }),
    );
    expect(plan.creates.map((create) => create.dayOfWeek)).toEqual([1, 3]);
    expect(plan.notWritten).toEqual([{ rowId: 'b', requirementId: POST_MATH, reason: 'REFUSED', verdict: { reason: 'GROUP', params: { other: 'Svenska 7A' } } }]);
  });

  it('names a row that leaves the room to the engine and does not write it: only the engine can choose it', () => {
    const plan = planWriteIn(input({ rows: [row({ id: 'a', roomId: null })] }));
    expect(plan.creates).toEqual([]);
    expect(plan.notWritten).toEqual([{ rowId: 'a', requirementId: POST_MATH, reason: 'NO_ROOM' }]);
    expect(plan.postsWritten).toBe(0);
  });

  it('names a block\'s förläggningar and leaves them to Generera', () => {
    const plan = planWriteIn(input({ rows: [], verdicts: [], blockRows: [{ id: 'br-1', blockId: 'block-1' }, { id: 'br-2', blockId: 'block-1' }] }));
    expect(plan.creates).toEqual([]);
    expect(plan.notWritten).toEqual([
      { rowId: 'br-1', blockId: 'block-1', reason: 'BLOCK' },
      { rowId: 'br-2', blockId: 'block-1', reason: 'BLOCK' },
    ]);
  });

  describe('what an earlier run wrote from förläggningar', () => {
    it('replaces the lessons of a post it writes for: the old lesson goes and the new one is written', () => {
      const plan = planWriteIn(input({ existing: [lesson({ id: 'old-1' }), lesson({ id: 'old-2', dayOfWeek: 4 })] }));
      expect([...plan.deleteIds].sort()).toEqual(['old-1', 'old-2']);
      expect(plan.creates).toHaveLength(1);
    });

    it('leaves a lesson that is exactly what the row would write, and writes no copy of it: a second write over the same rows changes nothing', () => {
      const plan = planWriteIn(input({ existing: [lesson({ id: 'same', roomId: ROOM }), lesson({ id: 'other-room', dayOfWeek: 4 })] }));
      expect(plan.creates).toEqual([]);
      expect(plan.deleteIds).toEqual(['other-room']);
      expect(plan.postsWritten).toBe(1);
      // Another teacher, window or weeks is another lesson: replaced.
      for (const changed of [{ teacherId: CIA }, { coTeacherId: null }, { recurrence: 'ODD_WEEKS' as const }, { startDate: null }, { endTime: time('10:30') }]) {
        const replaced = planWriteIn(input({ existing: [lesson({ id: 'was', roomId: ROOM, ...changed })] }));
        expect(replaced.creates).toHaveLength(1);
        expect(replaced.deleteIds).toEqual(['was']);
      }
    });

    it('keeps the lesson that answers a row the bridge does not write: the engine\'s room is not the bridge\'s to take away', () => {
      const plan = planWriteIn(
        input({
          rows: [row({ id: 'a' }), row({ id: 'b', dayOfWeek: 2, roomId: null }), row({ id: 'c', dayOfWeek: 3 })],
          verdicts: [ok(0), ok(1), refused(2)],
          existing: [
            lesson({ id: 'old-a' }),
            // Written from the row without a room, with the room the engine chose: stays.
            lesson({ id: 'old-b', dayOfWeek: 2 }),
            // Written from a row that held when it was written and does not now: stays.
            lesson({ id: 'old-c', dayOfWeek: 3 }),
            // Written from a row that is gone: replaced, as the next Generera would.
            lesson({ id: 'old-gone', dayOfWeek: 5 }),
          ],
        }),
      );
      expect([...plan.deleteIds].sort()).toEqual(['old-a', 'old-gone']);
    });

    it('counts a lesson once for each row: two rows at one hour keep one old lesson each, and a third old lesson there goes', () => {
      const twice = input({
        rows: [row({ id: 'a', roomId: null }), row({ id: 'b', roomId: null }), row({ id: 'w', dayOfWeek: 3 })],
        verdicts: [ok(0), ok(1), ok(2)],
        existing: [lesson({ id: 'one' }), lesson({ id: 'two' }), lesson({ id: 'three' })],
      });
      const plan = planWriteIn(twice);
      expect(plan.deleteIds).toHaveLength(1);
    });

    it('leaves the lessons of a post it writes nothing for, and of a class no row of the year names', () => {
      const other = post({ id: POST_SWE, subjectId: SWE });
      const plan = planWriteIn(
        input({
          rows: [row({ id: 'a' }), row({ id: 's', requirementId: POST_SWE, roomId: null })],
          verdicts: [ok(0), ok(1)],
          posts: posts(post(), other),
          existing: [lesson({ id: 'math-old' }), lesson({ id: 'swe-old', subjectId: SWE, dayOfWeek: 1 }), lesson({ id: 'block-old', studentGroupId: G7B, subjectId: MATH })],
        }),
      );
      expect(plan.deleteIds).toEqual(['math-old']);
    });

    it('keeps a lesson only for the row of its own class: another class\'s row at the same hour answers none of it', () => {
      const plan = planWriteIn(
        input({
          rows: [row({ id: 'mine' }), row({ id: 'theirs', requirementId: POST_G7B, roomId: null })],
          verdicts: [ok(0), ok(1)],
          posts: posts(post(), post({ id: POST_G7B, studentGroupId: G7B })),
          // 7A's old lesson at the hour 7B's row (without a room) stands at: it is 7A's own row that is written anew, so the old one goes.
          existing: [lesson({ id: 'mine-old' })],
        }),
      );
      expect(plan.deleteIds).toEqual(['mine-old']);
      expect(plan.creates).toHaveLength(1);
    });

    it('does not take the lesson of another class in the same subject', () => {
      const plan = planWriteIn(
        input({
          posts: posts(post(), post({ id: POST_G7B, studentGroupId: G7B })),
          existing: [lesson({ id: 'mine' }), lesson({ id: 'other-class', studentGroupId: G7B })],
        }),
      );
      expect(plan.deleteIds).toEqual(['mine']);
    });
  });

  it('writes nothing and replaces nothing for a year with no förläggning', () => {
    const plan = planWriteIn(input({ rows: [], verdicts: [] }));
    expect(plan).toEqual({ creates: [], deleteIds: [], notWritten: [], postsWritten: 0 });
  });
});
