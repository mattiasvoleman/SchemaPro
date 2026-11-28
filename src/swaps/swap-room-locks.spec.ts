import { lockedRoomsOf, type RoomLockRule } from './swap-room-locks';

/*
 * The school's LOCK rules of rooms as the generator resolves them (scheduler_solver.py resolve_room_locks, tests/test_room_locks*): which rooms a
 * lesson of a subject and some years may stand in. One case for each thing the engine's docstring says.
 */

const ROOMS = [
  { id: 'r1', roomTypeId: 'klass' },
  { id: 'r2', roomTypeId: 'klass' },
  { id: 'r3', roomTypeId: 'labb' },
  { id: 'r4', roomTypeId: 'labb' },
];
const rule = (over: Partial<RoomLockRule> = {}): RoomLockRule => ({ subjectId: 'kemi', minGradeLevel: null, maxGradeLevel: null, roomTypeId: null, roomIds: ['r1'], ...over });
const years = (min: number | null, max: number | null) => ({ minGradeLevel: min, maxGradeLevel: max });

describe('lockedRoomsOf', () => {
  it('is null for a subject no rule names, and for no rules at all', () => {
    expect(lockedRoomsOf([], ROOMS, 'kemi', years(7, 7))).toBeNull();
    expect(lockedRoomsOf([rule({ subjectId: 'matte' })], ROOMS, 'kemi', years(7, 7))).toBeNull();
  });

  it('is the rooms a rule names, or every room of the type it names', () => {
    expect([...lockedRoomsOf([rule({ roomIds: ['r1', 'r4'] })], ROOMS, 'kemi', years(7, 7))!].sort()).toEqual(['r1', 'r4']);
    expect([...lockedRoomsOf([rule({ roomTypeId: 'labb', roomIds: [] })], ROOMS, 'kemi', years(7, 7))!].sort()).toEqual(['r3', 'r4']);
  });

  it('lets a rule with years reach only a lesson whose whole span lies inside them, and one without years reach every lesson', () => {
    const narrow = rule({ ...years(4, 6), roomIds: ['r2'] });
    expect(lockedRoomsOf([narrow], ROOMS, 'kemi', years(4, 6))).toEqual(new Set(['r2']));
    expect(lockedRoomsOf([narrow], ROOMS, 'kemi', years(5, 5))).toEqual(new Set(['r2']));
    // Half outside the years: not reached. A group whose years are unknown is not reached either.
    expect(lockedRoomsOf([narrow], ROOMS, 'kemi', years(6, 7))).toBeNull();
    expect(lockedRoomsOf([narrow], ROOMS, 'kemi', years(null, null))).toBeNull();
    expect(lockedRoomsOf([rule({ roomIds: ['r2'] })], ROOMS, 'kemi', years(null, null))).toEqual(new Set(['r2']));
  });

  it('lets the narrowest span win, and equally narrow rules be alternatives whose rooms are joined', () => {
    const wide = rule({ roomIds: ['r1'] });
    const stage = rule({ ...years(4, 6), roomIds: ['r2'] });
    const year = rule({ ...years(4, 4), roomIds: ['r3'] });
    const alsoYear = rule({ ...years(4, 4), roomIds: ['r4'] });
    expect(lockedRoomsOf([wide, stage, year], ROOMS, 'kemi', years(4, 4))).toEqual(new Set(['r3']));
    expect(lockedRoomsOf([wide, stage, year], ROOMS, 'kemi', years(5, 5))).toEqual(new Set(['r2']));
    expect(lockedRoomsOf([wide, stage, year], ROOMS, 'kemi', years(8, 8))).toEqual(new Set(['r1']));
    // Equally narrow: the rooms are joined, and the order of the rules does not matter.
    expect(lockedRoomsOf([wide, year, alsoYear], ROOMS, 'kemi', years(4, 4))).toEqual(new Set(['r3', 'r4']));
    expect(lockedRoomsOf([alsoYear, wide, year], ROOMS, 'kemi', years(4, 4))).toEqual(new Set(['r3', 'r4']));
  });

  it('is empty, and not null, when the one rule that reaches names rooms that are gone', () => {
    expect(lockedRoomsOf([rule({ roomIds: [] })], ROOMS, 'kemi', years(7, 7))).toEqual(new Set());
  });
});
