import {
  crowdedWith,
  sharedSeatsByRoom,
  sharedSeatsOf,
  type RoomOccupant,
  type SharedRoomWeeks,
} from './shared-rooms';

/**
 * Delade salar (Placeringsregel 3): the decision, named case by case. The
 * fixture replayed by shared-rooms.contract.spec.ts holds the same rule for
 * the browser's copy; these are the sentences a school would say.
 */

const HOUR = 60;
const at = (hour: number, minute = 0) => hour * HOUR + minute;

/** `count` pupils, named so two prefixes never collide. */
const pupils = (prefix: string, count: number): Set<string> =>
  new Set(Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`));

const lesson = (
  start: number,
  end: number,
  who: Set<string>,
  recurrence?: SharedRoomWeeks,
): RoomOccupant => ({ start, end, pupils: who, ...(recurrence ? { recurrence } : {}) });

/** The ids crowded with the candidate, sorted. */
const crowded = (seats: number, candidate: RoomOccupant, others: RoomOccupant[]) =>
  [...crowdedWith(seats, candidate, others)].sort();

describe('sharedSeatsOf: which rooms can be shared at all', () => {
  const hall = { canBeShared: true, capacity: 40 };

  it('gives the capacity of a marked room while the rule is on, soft or hard', () => {
    expect(sharedSeatsOf('SOFT', hall)).toBe(40);
    expect(sharedSeatsOf('HARD', hall)).toBe(40);
  });

  it('keeps every room exclusive while the rule is off or was never written', () => {
    expect(sharedSeatsOf('OFF', hall)).toBeNull();
    expect(sharedSeatsOf(null, hall)).toBeNull();
    expect(sharedSeatsOf(undefined, hall)).toBeNull();
  });

  it('keeps a room that is not marked exclusive, whatever its capacity', () => {
    expect(sharedSeatsOf('HARD', { canBeShared: false, capacity: 40 })).toBeNull();
    expect(sharedSeatsOf('HARD', { capacity: 40 })).toBeNull();
    expect(sharedSeatsOf('HARD', { canBeShared: null, capacity: 40 })).toBeNull();
    expect(sharedSeatsOf('HARD', null)).toBeNull();
  });

  it('keeps a room without a capacity exclusive: there is no limit to share under', () => {
    expect(sharedSeatsOf('HARD', { canBeShared: true, capacity: null })).toBeNull();
    expect(sharedSeatsOf('HARD', { canBeShared: true })).toBeNull();
    expect(sharedSeatsOf('HARD', { canBeShared: true, capacity: 0 })).toBeNull();
    expect(sharedSeatsOf('HARD', { canBeShared: true, capacity: 12.5 })).toBeNull();
  });

  it('lists a school’s qualifying rooms by id, and none with the rule off', () => {
    const rooms = [
      { id: 'hall', canBeShared: true, capacity: 40 },
      { id: 'lab', canBeShared: false, capacity: 30 },
      { id: 'aula', canBeShared: true, capacity: null },
    ];
    expect([...sharedSeatsByRoom('SOFT', rooms)]).toEqual([['hall', 40]]);
    expect(sharedSeatsByRoom('OFF', rooms).size).toBe(0);
  });
});

describe('crowdedWith: who the candidate cannot stay in the room with', () => {
  it('shared hall, pupils fit: no clash', () => {
    expect(crowded(40, lesson(at(8), at(9), pupils('a', 20)), [lesson(at(8), at(9), pupils('b', 20))])).toEqual([]);
  });

  it('shared hall, pupils do not fit: a clash with that lesson', () => {
    expect(crowded(40, lesson(at(8), at(9), pupils('a', 21)), [lesson(at(8), at(9), pupils('b', 20))])).toEqual([0]);
  });

  it('three lessons whose pairs fit but not all three: a clash with both', () => {
    const a = lesson(at(8), at(9), pupils('a', 20));
    const b = lesson(at(8), at(9), pupils('b', 20));
    const c = lesson(at(8), at(9), pupils('c', 20));
    // Each pair is forty, which fits; the three are sixty, which does not.
    expect(crowded(40, a, [b])).toEqual([]);
    expect(crowded(40, a, [c])).toEqual([]);
    expect(crowded(40, a, [b, c])).toEqual([0, 1]);
    // And the same from the other lessons' side: the publish gate asks from every one.
    expect(crowded(40, b, [a, c])).toEqual([0, 1]);
    expect(crowded(40, c, [a, b])).toEqual([0, 1]);
  });

  it('counts the pupils of an extra group and a named pupil once, never twice', () => {
    const shared = pupils('x', 10);
    const a = lesson(at(8), at(9), new Set([...pupils('a', 10), ...shared]));
    const b = lesson(at(8), at(9), new Set([...pupils('b', 10), ...shared]));
    expect(crowded(30, a, [b])).toEqual([]);
    expect(crowded(29, a, [b])).toEqual([0]);
  });

  it('does not count a lesson that stands in the room at another hour', () => {
    const a = lesson(at(8), at(9), pupils('a', 20));
    expect(crowded(40, a, [lesson(at(8), at(9), pupils('b', 20)), lesson(at(13), at(14), pupils('c', 30))])).toEqual([]);
    // Back to back is not together either.
    expect(crowded(1, a, [lesson(at(9), at(10), pupils('b', 20))])).toEqual([]);
  });

  it('counts only what runs at once: a long lesson beside two that follow each other fits', () => {
    const long = lesson(at(8), at(10), pupils('a', 20));
    const first = lesson(at(8), at(9), pupils('b', 20));
    const second = lesson(at(9), at(10), pupils('c', 20));
    expect(crowded(40, long, [first, second])).toEqual([]);
    expect(crowded(40, first, [long, second])).toEqual([]);
  });

  it('names only the lessons that stand in the overfull stretch', () => {
    const long = lesson(at(8), at(10), pupils('a', 1));
    const early = lesson(at(8), at(9), pupils('b', 3));
    const late = lesson(at(9), at(10), pupils('c', 1));
    expect(crowded(3, long, [early, late])).toEqual([0]);
  });

  it('lets odd and even weeks share the room without counting each other', () => {
    const everyWeek = lesson(at(8), at(9), pupils('a', 20), 'ALL_WEEKS');
    const odd = lesson(at(8), at(9), pupils('b', 20), 'ODD_WEEKS');
    const even = lesson(at(8), at(9), pupils('c', 20), 'EVEN_WEEKS');
    expect(crowded(40, everyWeek, [odd, even])).toEqual([]);
    // An odd-week lesson and an even-week one never meet, whatever they hold.
    expect(crowded(1, lesson(at(8), at(9), pupils('a', 20), 'ODD_WEEKS'), [even])).toEqual([]);
    // But two odd-week lessons beside an every-week one are three in the odd weeks.
    expect(crowded(40, everyWeek, [odd, lesson(at(8), at(9), pupils('d', 20), 'ODD_WEEKS')])).toEqual([0, 1]);
  });

  it('stays a clash when a lesson’s pupils are unknown, however many seats there are', () => {
    const known = lesson(at(8), at(9), pupils('a', 1));
    const unknown = lesson(at(8), at(9), new Set());
    expect(crowded(1000, known, [unknown])).toEqual([0]);
    expect(crowded(1000, unknown, [known])).toEqual([0]);
    // A lesson that never meets it does not make it unknown.
    expect(crowded(1000, known, [lesson(at(13), at(14), new Set())])).toEqual([]);
  });

  it('has nothing to clash with when nobody else is in the room', () => {
    expect(crowded(1, lesson(at(8), at(9), pupils('a', 30)), [])).toEqual([]);
  });
});
