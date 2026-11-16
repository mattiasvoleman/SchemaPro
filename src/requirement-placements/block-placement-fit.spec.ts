import type { LessonRecurrence } from '@prisma/client';
import {
  blockFitOf,
  blockLengthsOf,
  blockShapeOf,
  firstRowWithTwoRoomsForOneMember,
  type BlockRowShape,
  type PlacementBlock,
  type PlacementBlockMember,
} from './block-placement-fit';

/** A member of a block: two lessons of 60 every week unless the test says otherwise. */
const member = (id: string, over: Partial<PlacementBlockMember> = {}): PlacementBlockMember => ({
  id,
  lessonsPerWeek: 2,
  minutesPerLesson: 60,
  lessonLengths: [],
  recurrence: 'ALL_WEEKS',
  shares: [],
  ...over,
});

const block = (members: PlacementBlockMember[], over: Partial<PlacementBlock> = {}): PlacementBlock => ({
  id: 'block-1',
  sameTimesAsBlockId: null,
  members,
  ...over,
});

const row = (
  minutes: number,
  recurrence: LessonRecurrence = 'ALL_WEEKS',
  rooms: { requirementId: string; roomId: string }[] = [],
): BlockRowShape => ({ minutes, recurrence, rooms });

/** Idrott 1 × 80 + 1 × 40. */
const split = (id: string, over: Partial<PlacementBlockMember> = {}): PlacementBlockMember =>
  member(id, { lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40], ...over });

describe('blockShapeOf', () => {
  it('is null for a block with no member', () => {
    expect(blockShapeOf({ members: [] })).toBeNull();
  });

  it('reads the member with the lowest id, whatever the order the members come in', () => {
    const a = member('a', { minutesPerLesson: 45 });
    const b = member('b', { minutesPerLesson: 60 });
    const c = member('c', { minutesPerLesson: 90 });
    for (const members of [[a, b, c], [c, b, a], [b, c, a], [b, a, c]]) {
      expect(blockShapeOf({ members })?.id).toBe('a');
    }
  });

  it('compares ids as text, as the trigger does (10 comes before 9)', () => {
    expect(blockShapeOf({ members: [member('9'), member('10')] })?.id).toBe('10');
  });

  it('is the one member of a block of one', () => {
    const only = member('only');
    expect(blockShapeOf({ members: [only] })).toBe(only);
  });
});

describe('blockLengthsOf', () => {
  it('is empty for a block with no member', () => {
    expect(blockLengthsOf({ members: [] })).toEqual([]);
  });

  it('is one length per lesson of a uniform member', () => {
    expect(blockLengthsOf({ members: [member('a', { lessonsPerWeek: 3, minutesPerLesson: 40 })] })).toEqual([40, 40, 40]);
  });

  it('puts the longest first on a split member, whatever order its list is stored in', () => {
    expect(blockLengthsOf({ members: [split('a')] })).toEqual([80, 40]);
    expect(blockLengthsOf({ members: [split('a', { lessonLengths: [40, 80, 40], lessonsPerWeek: 3 })] })).toEqual([80, 40, 40]);
  });

  it('reads the lowest id and no other member', () => {
    expect(blockLengthsOf({ members: [member('b', { minutesPerLesson: 90 }), member('a', { minutesPerLesson: 45, lessonsPerWeek: 1 })] })).toEqual([45]);
  });
});

describe('blockFitOf', () => {
  describe('a block with no row', () => {
    it('fits whatever the block is: the rules are about rows', () => {
      expect(blockFitOf(block([member('a')]), [])).toBeNull();
      expect(blockFitOf(block([]), [])).toBeNull();
      expect(blockFitOf(block([member('a')], { sameTimesAsBlockId: 'other' }), [])).toBeNull();
      expect(blockFitOf(block([member('a', { shares: [{ teacherId: 'bo', lessons: 1, minutes: 60 }] })]), [])).toBeNull();
    });
  });

  describe('FOLLOWER', () => {
    it('refuses a block that follows another block\'s times, said of the block and not of a row', () => {
      expect(blockFitOf(block([member('a')], { sameTimesAsBlockId: 'leader' }), [row(60)])).toEqual({ reason: 'FOLLOWER', index: null });
    });

    it('is the first rule: a follower with no member, a share and a bad length is a follower', () => {
      const shared = member('a', { shares: [{ teacherId: 'bo', lessons: 1, minutes: 60 }] });
      expect(blockFitOf(block([shared], { sameTimesAsBlockId: 'leader' }), [row(45, 'ODD_WEEKS')])?.reason).toBe('FOLLOWER');
      expect(blockFitOf(block([], { sameTimesAsBlockId: 'leader' }), [row(60)])?.reason).toBe('FOLLOWER');
    });

    it('lets a block that follows nobody through', () => {
      expect(blockFitOf(block([member('a')], { sameTimesAsBlockId: null }), [row(60)])).toBeNull();
    });
  });

  describe('EMPTY', () => {
    it('refuses a block with no member to sit the lesson, said of the block', () => {
      expect(blockFitOf(block([]), [row(60)])).toEqual({ reason: 'EMPTY', index: null });
      expect(blockFitOf(block([]), [row(60), row(45, 'ODD_WEEKS')])).toEqual({ reason: 'EMPTY', index: null });
    });

    it('is after FOLLOWER and before every rule about the rows', () => {
      expect(blockFitOf(block([]), [row(45)])?.reason).toBe('EMPTY');
    });
  });

  describe('SHARES', () => {
    const shares = [{ teacherId: 'bo', lessons: 1, minutes: 60 }];

    it('refuses a block when a member shares its lessons between teachers, said of the block', () => {
      expect(blockFitOf(block([member('a', { shares })]), [row(60)])).toEqual({ reason: 'SHARES', index: null });
    });

    it('asks every member, not only the one the lessons are read from', () => {
      const members = [member('a'), member('b', { shares })];
      expect(blockFitOf(block(members), [row(60)])).toEqual({ reason: 'SHARES', index: null });
      expect(blockFitOf(block([member('a', { shares }), member('b')]), [row(60)])?.reason).toBe('SHARES');
    });

    it('reads an absent, a null and an empty list of shares as no share', () => {
      const bare = { id: 'a', lessonsPerWeek: 2, minutesPerLesson: 60, lessonLengths: [], recurrence: 'ALL_WEEKS' as const };
      expect(blockFitOf(block([bare]), [row(60)])).toBeNull();
      expect(blockFitOf(block([{ ...bare, shares: null }]), [row(60)])).toBeNull();
      expect(blockFitOf(block([{ ...bare, shares: [] }]), [row(60)])).toBeNull();
    });

    it('comes before the rules about the rows', () => {
      expect(blockFitOf(block([member('a', { shares })]), [row(45, 'ODD_WEEKS')])?.reason).toBe('SHARES');
    });
  });

  describe('LENGTH', () => {
    it('refuses a row whose length is not one of the block\'s, with the row\'s place', () => {
      expect(blockFitOf(block([member('a')]), [row(45)])).toEqual({ reason: 'LENGTH', index: 0 });
      expect(blockFitOf(block([member('a')]), [row(60), row(45)])).toEqual({ reason: 'LENGTH', index: 1 });
    });

    it('names the FIRST row of a wrong length, however many there are', () => {
      expect(blockFitOf(block([member('a')]), [row(60), row(50), row(45), row(70)])).toEqual({ reason: 'LENGTH', index: 1 });
    });

    it('accepts either length of a split block, in either order', () => {
      expect(blockFitOf(block([split('a')]), [row(80), row(40)])).toBeNull();
      expect(blockFitOf(block([split('a')]), [row(40), row(80)])).toBeNull();
      expect(blockFitOf(block([split('a')]), [row(60)])).toEqual({ reason: 'LENGTH', index: 0 });
    });

    it('is before WEEKS: a bad length later in the list outranks bad weeks earlier', () => {
      expect(blockFitOf(block([member('a')]), [row(60, 'ODD_WEEKS'), row(45)])).toEqual({ reason: 'LENGTH', index: 1 });
    });

    it('is before COUNT and MEMBER', () => {
      const rooms = [{ requirementId: 'stranger', roomId: 'r1' }];
      expect(blockFitOf(block([member('a', { lessonsPerWeek: 1 })]), [row(60), row(60), row(45, 'ALL_WEEKS', rooms)])).toEqual({ reason: 'LENGTH', index: 2 });
    });
  });

  describe('WEEKS', () => {
    it('refuses a row of other weeks than the block\'s, with the first such row', () => {
      expect(blockFitOf(block([member('a')]), [row(60), row(60, 'ODD_WEEKS'), row(60, 'EVEN_WEEKS')])).toEqual({ reason: 'WEEKS', index: 1 });
    });

    it('on an odd-weeks block takes a row of odd weeks and refuses every-week and even-week rows', () => {
      const odd = block([member('a', { recurrence: 'ODD_WEEKS' })]);
      expect(blockFitOf(odd, [row(60, 'ODD_WEEKS'), row(60, 'ODD_WEEKS')])).toBeNull();
      expect(blockFitOf(odd, [row(60, 'ALL_WEEKS')])).toEqual({ reason: 'WEEKS', index: 0 });
      expect(blockFitOf(odd, [row(60, 'ODD_WEEKS'), row(60, 'EVEN_WEEKS')])).toEqual({ reason: 'WEEKS', index: 1 });
    });

    it('on an even-weeks block takes a row of even weeks and refuses the other two', () => {
      const even = block([member('a', { recurrence: 'EVEN_WEEKS' })]);
      expect(blockFitOf(even, [row(60, 'EVEN_WEEKS')])).toBeNull();
      expect(blockFitOf(even, [row(60, 'ODD_WEEKS')])?.reason).toBe('WEEKS');
      expect(blockFitOf(even, [row(60, 'ALL_WEEKS')])?.reason).toBe('WEEKS');
    });

    it('on an every-week block refuses odd and even rows: pairs are not supported for a block, not even a complete pair', () => {
      const every = block([member('a')]);
      expect(blockFitOf(every, [row(60, 'ODD_WEEKS')])).toEqual({ reason: 'WEEKS', index: 0 });
      expect(blockFitOf(every, [row(60, 'EVEN_WEEKS')])).toEqual({ reason: 'WEEKS', index: 0 });
      expect(blockFitOf(every, [row(60, 'ODD_WEEKS'), row(60, 'EVEN_WEEKS')])).toEqual({ reason: 'WEEKS', index: 0 });
      expect(blockFitOf(every, [row(60, 'ALL_WEEKS'), row(60, 'ODD_WEEKS'), row(60, 'EVEN_WEEKS')])).toEqual({ reason: 'WEEKS', index: 1 });
    });

    it('is before COUNT: too many rows of the wrong weeks are told as the weeks', () => {
      const odd = block([member('a', { recurrence: 'ODD_WEEKS', lessonsPerWeek: 1 })]);
      expect(blockFitOf(odd, [row(60, 'ODD_WEEKS'), row(60, 'ODD_WEEKS'), row(60, 'ALL_WEEKS')])).toEqual({ reason: 'WEEKS', index: 2 });
    });
  });

  describe('COUNT', () => {
    it('lets a block place up to its lessons of a length, and fewer', () => {
      const three = block([member('a', { lessonsPerWeek: 3, minutesPerLesson: 40 })]);
      expect(blockFitOf(three, [row(40)])).toBeNull();
      expect(blockFitOf(three, [row(40), row(40)])).toBeNull();
      expect(blockFitOf(three, [row(40), row(40), row(40)])).toBeNull();
    });

    it('refuses the lesson over the count, and names the LAST row of that length', () => {
      const three = block([member('a', { lessonsPerWeek: 3, minutesPerLesson: 40 })]);
      expect(blockFitOf(three, [row(40), row(40), row(40), row(40)])).toEqual({ reason: 'COUNT', index: 3 });
      expect(blockFitOf(three, [row(40), row(40), row(40), row(40), row(40)])).toEqual({ reason: 'COUNT', index: 4 });
    });

    it.each<[string, number[], number | null]>([
      ['one of each', [80, 40], null],
      ['one of each, the other way round', [40, 80], null],
      ['only the long one', [80], null],
      ['two long: the second is over', [80, 80], 1],
      ['two long and a short between, the last long is over', [80, 40, 80], 2],
      ['two short: the second is over', [40, 40], 1],
      ['two long and two short: the long are told first', [40, 40, 80, 80], 3],
    ])('on 1 × 80 + 1 × 40: %s', (_name, minutes, over) => {
      const result = blockFitOf(block([split('a')]), minutes.map((one) => row(one)));
      expect(result).toEqual(over === null ? null : { reason: 'COUNT', index: over });
    });

    it('counts every length on its own: three of 40 beside the 80, with 80 + 40 + 40', () => {
      const mixed = block([split('a', { lessonsPerWeek: 3, lessonLengths: [80, 40, 40] })]);
      expect(blockFitOf(mixed, [row(80), row(40), row(40)])).toBeNull();
      expect(blockFitOf(mixed, [row(40), row(40), row(40)])).toEqual({ reason: 'COUNT', index: 2 });
      expect(blockFitOf(mixed, [row(80), row(80), row(40)])).toEqual({ reason: 'COUNT', index: 1 });
    });

    it('names the longest length over the count first, which is the order the block\'s lengths are in', () => {
      const mixed = block([split('a', { lessonsPerWeek: 3, lessonLengths: [80, 40, 40] })]);
      // 40 is over at index 2 (the third 40), 80 is over at index 4.
      expect(blockFitOf(mixed, [row(40), row(40), row(40), row(80), row(80)])).toEqual({ reason: 'COUNT', index: 4 });
    });

    it('is before MEMBER', () => {
      const rooms = [{ requirementId: 'stranger', roomId: 'r1' }];
      expect(blockFitOf(block([member('a', { lessonsPerWeek: 1 })]), [row(60, 'ALL_WEEKS', rooms), row(60)])).toEqual({ reason: 'COUNT', index: 1 });
    });
  });

  describe('MEMBER', () => {
    it('refuses a room named for a post that is not a member, with the first row that has one', () => {
      const a = member('a');
      const rows = [
        row(60, 'ALL_WEEKS', [{ requirementId: 'a', roomId: 'r1' }]),
        row(60, 'ALL_WEEKS', [{ requirementId: 'a', roomId: 'r1' }, { requirementId: 'stranger', roomId: 'r2' }]),
      ];
      expect(blockFitOf(block([a]), rows)).toEqual({ reason: 'MEMBER', index: 1 });
    });

    it('names the first of several rows with a stranger', () => {
      const stranger = [{ requirementId: 'x', roomId: 'r1' }];
      expect(blockFitOf(block([member('a', { lessonsPerWeek: 3 })]), [row(60), row(60, 'ALL_WEEKS', stranger), row(60, 'ALL_WEEKS', stranger)])).toEqual({ reason: 'MEMBER', index: 1 });
    });

    it('lets rooms through that name members only, any member, the same room for several, and a row with no rooms at all', () => {
      const members = [member('a', { lessonsPerWeek: 3 }), member('b', { lessonsPerWeek: 3 }), member('c', { lessonsPerWeek: 3 })];
      const rows = [
        row(60, 'ALL_WEEKS', [{ requirementId: 'a', roomId: 'r1' }, { requirementId: 'b', roomId: 'r1' }, { requirementId: 'c', roomId: 'r2' }]),
        row(60),
        { minutes: 60, recurrence: 'ALL_WEEKS' as const },
      ];
      expect(blockFitOf(block(members), rows)).toBeNull();
    });
  });

  describe('which rule is told when a set breaks several', () => {
    const rooms = [{ requirementId: 'stranger', roomId: 'r1' }];
    const shares = [{ teacherId: 'bo', lessons: 1, minutes: 60 }];
    // Every rule's breaker at once: a follower with a shared member and rows of the wrong length, weeks, count and a stranger room.
    const rows = [row(45, 'ODD_WEEKS', rooms), row(45, 'ODD_WEEKS', rooms), row(45, 'ODD_WEEKS', rooms)];

    it('goes FOLLOWER, EMPTY, SHARES, LENGTH, WEEKS, COUNT, MEMBER, each once the one before is mended', () => {
      const told: (string | undefined)[] = [];
      const shared = member('a', { shares, lessonsPerWeek: 1 });
      told.push(blockFitOf(block([shared], { sameTimesAsBlockId: 'leader' }), rows)?.reason);
      told.push(blockFitOf(block([], { sameTimesAsBlockId: null }), rows)?.reason);
      told.push(blockFitOf(block([shared]), rows)?.reason);
      const one = member('a', { lessonsPerWeek: 1 });
      told.push(blockFitOf(block([one]), rows)?.reason);
      const sixty = [row(60, 'ODD_WEEKS', rooms), row(60, 'ODD_WEEKS', rooms)];
      told.push(blockFitOf(block([one]), sixty)?.reason);
      const every = [row(60, 'ALL_WEEKS', rooms), row(60, 'ALL_WEEKS', rooms)];
      told.push(blockFitOf(block([one]), every)?.reason);
      told.push(blockFitOf(block([one]), [row(60, 'ALL_WEEKS', rooms)])?.reason);
      expect(told).toEqual(['FOLLOWER', 'EMPTY', 'SHARES', 'LENGTH', 'WEEKS', 'COUNT', 'MEMBER']);
    });

    it('tells a row that breaks two rules by the earlier one', () => {
      // 45 minutes of odd weeks: the length, not the weeks.
      expect(blockFitOf(block([member('a')]), [row(45, 'ODD_WEEKS')])?.reason).toBe('LENGTH');
      // A row of the wrong weeks that also names a stranger: the weeks.
      expect(blockFitOf(block([member('a')]), [row(60, 'ODD_WEEKS', rooms)])?.reason).toBe('WEEKS');
      // The over-count row that also names a stranger: the count.
      expect(blockFitOf(block([member('a', { lessonsPerWeek: 1 })]), [row(60), row(60, 'ALL_WEEKS', rooms)])).toEqual({ reason: 'COUNT', index: 1 });
    });
  });

  it('judges rows in any order, and a row\'s place is its place in the list given', () => {
    const b = block([split('a')]);
    expect(blockFitOf(b, [row(40), row(80), row(45)])).toEqual({ reason: 'LENGTH', index: 2 });
    expect(blockFitOf(b, [row(45), row(80), row(40)])).toEqual({ reason: 'LENGTH', index: 0 });
  });

  it('reads the lessons from the lowest id when the members are given in another order', () => {
    const members = [member('b', { lessonsPerWeek: 1, minutesPerLesson: 45 }), member('a', { lessonsPerWeek: 1, minutesPerLesson: 60 })];
    expect(blockFitOf(block(members), [row(60)])).toBeNull();
    expect(blockFitOf(block(members), [row(45)])).toEqual({ reason: 'LENGTH', index: 0 });
  });
});

describe('firstRowWithTwoRoomsForOneMember', () => {
  it('is -1 for no row, and for rows with no room or with one per member', () => {
    expect(firstRowWithTwoRoomsForOneMember([])).toBe(-1);
    expect(firstRowWithTwoRoomsForOneMember([{}, { rooms: [] }])).toBe(-1);
    expect(
      firstRowWithTwoRoomsForOneMember([{ rooms: [{ requirementId: 'a', roomId: 'r1' }, { requirementId: 'b', roomId: 'r1' }] }]),
    ).toBe(-1);
  });

  it('names the first row that names one member twice, the same room or another', () => {
    const twice = { rooms: [{ requirementId: 'a', roomId: 'r1' }, { requirementId: 'a', roomId: 'r2' }] };
    const same = { rooms: [{ requirementId: 'a', roomId: 'r1' }, { requirementId: 'a', roomId: 'r1' }] };
    expect(firstRowWithTwoRoomsForOneMember([{ rooms: [] }, twice, same])).toBe(1);
    expect(firstRowWithTwoRoomsForOneMember([same])).toBe(0);
  });

  it('lets one member have a room in each of two rows: the unique key is per lesson', () => {
    const one = { rooms: [{ requirementId: 'a', roomId: 'r1' }] };
    expect(firstRowWithTwoRoomsForOneMember([one, one])).toBe(-1);
  });
});

/*
 * THE PROPERTY: blockFitOf against a second, naive reading of the rules as the migration's preface states them
 * (20270218090000), written here with none of the function's own structure: sets, counts and scans, no early returns.
 * A seeded generator makes blocks of 0 to 4 members and lists of 0 to 6 rows, most of them near a fit, so that
 * every rule is hit many times and so is a fit.
 */

/** mulberry32: a small seeded generator, so a failure names its case and replays. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rule = 'FOLLOWER' | 'EMPTY' | 'SHARES' | 'LENGTH' | 'WEEKS' | 'COUNT' | 'MEMBER';
const RULES: readonly Rule[] = ['FOLLOWER', 'EMPTY', 'SHARES', 'LENGTH', 'WEEKS', 'COUNT', 'MEMBER'];

/** The reference: which rule is broken first, and which rows may be told for it. Null when the rows fit. */
function reference(b: PlacementBlock, rows: readonly BlockRowShape[]): { rule: Rule; indexes: number[] | null } | null {
  if (rows.length === 0) return null;
  const broken = new Map<Rule, number[] | null>();
  if (b.sameTimesAsBlockId !== null) broken.set('FOLLOWER', null);
  const byId = [...b.members].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  if (byId.length === 0) broken.set('EMPTY', null);
  if (byId.some((one) => (one.shares ?? []).length > 0)) broken.set('SHARES', null);
  const lowest = byId[0];
  if (lowest !== undefined) {
    const stored = lowest.lessonLengths ?? [];
    const lessons = stored.length > 1 ? [...stored] : Array.from({ length: lowest.lessonsPerWeek }, () => lowest.minutesPerLesson);
    const has = new Map<number, number>();
    for (const minutes of lessons) has.set(minutes, (has.get(minutes) ?? 0) + 1);
    const wrongLength = rows.flatMap((one, at) => (has.has(one.minutes) ? [] : [at]));
    if (wrongLength.length > 0) broken.set('LENGTH', [wrongLength[0]!]);
    const wrongWeeks = rows.flatMap((one, at) => (one.recurrence === lowest.recurrence ? [] : [at]));
    if (wrongWeeks.length > 0) broken.set('WEEKS', [wrongWeeks[0]!]);
    // Every length that has more rows than lessons: its last row is a row the count may be told of.
    const over: number[] = [];
    for (const minutes of new Set(rows.map((one) => one.minutes))) {
      const placed = rows.flatMap((one, at) => (one.minutes === minutes ? [at] : []));
      if (placed.length > (has.get(minutes) ?? 0) && has.has(minutes)) over.push(placed[placed.length - 1]!);
    }
    if (over.length > 0) broken.set('COUNT', over);
  }
  const memberIds = new Set(byId.map((one) => one.id));
  const strangers = rows.flatMap((one, at) => ((one.rooms ?? []).some((room) => !memberIds.has(room.requirementId)) ? [at] : []));
  if (strangers.length > 0) broken.set('MEMBER', [strangers[0]!]);
  const first = RULES.find((rule) => broken.has(rule));
  return first === undefined ? null : { rule: first, indexes: broken.get(first) ?? null };
}

interface Case {
  block: PlacementBlock;
  rows: BlockRowShape[];
}

function makeCase(random: () => number): Case {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
  const chance = (p: number): boolean => random() < p;
  const recurrences: readonly LessonRecurrence[] = ['ALL_WEEKS', 'ODD_WEEKS', 'EVEN_WEEKS'];
  const lengthsPool = [40, 60, 80];

  const blockRecurrence = chance(0.7) ? 'ALL_WEEKS' : pick(recurrences);
  const lessons = chance(0.4)
    ? [...Array.from({ length: 2 + Math.floor(random() * 3) }, () => pick(lengthsPool))].sort((x, y) => y - x)
    : Array.from({ length: 1 + Math.floor(random() * 4) }, () => 60);
  const mixed = lessons.length > 1 && lessons.some((one) => one !== lessons[0]);
  const shape = (id: string): PlacementBlockMember => ({
    id,
    lessonsPerWeek: lessons.length,
    minutesPerLesson: lessons[0]!,
    lessonLengths: mixed ? lessons : [],
    recurrence: blockRecurrence,
    shares: chance(0.06) ? [{ teacherId: 't', lessons: 1, minutes: lessons[lessons.length - 1]! }] : [],
  });
  const memberCount = chance(0.08) ? 0 : 1 + Math.floor(random() * 4);
  const ids = ['m-a', 'm-b', 'm-c', 'm-d', 'm-e'].slice(0, memberCount);
  // Members are given in any order, and now and then one differs from the rest: only the lowest id counts.
  const members = ids.map((id) => (chance(0.1) ? { ...shape(id), minutesPerLesson: 90, lessonsPerWeek: 1, lessonLengths: [] } : shape(id)));
  for (let at = members.length - 1; at > 0; at--) {
    const swap = Math.floor(random() * (at + 1));
    [members[at], members[swap]] = [members[swap]!, members[at]!];
  }

  const rowCount = chance(0.15) ? 0 : Math.min(6, Math.max(1, lessons.length + Math.floor(random() * 3) - 1));
  const rows: BlockRowShape[] = Array.from({ length: rowCount }, () => ({
    minutes: chance(0.93) ? pick(lessons) : pick([45, 90, 120]),
    recurrence: chance(0.93) ? blockRecurrence : pick(recurrences),
    rooms: Array.from({ length: Math.floor(random() * 3) }, () => ({
      requirementId: chance(0.88) && ids.length > 0 ? pick(ids) : 'stranger',
      roomId: pick(['r1', 'r2']),
    })),
  }));
  return { block: { id: 'block', sameTimesAsBlockId: chance(0.08) ? 'leader' : null, members }, rows };
}

const CASES = 800;

describe('blockFitOf against a naive reading of the rules (property)', () => {
  const cases = (() => {
    const random = seeded(20261116);
    return Array.from({ length: CASES }, () => makeCase(random));
  })();

  it('tells the same first rule as the reference, and a row the reference accepts, for every case', () => {
    const failures: string[] = [];
    cases.forEach((one, at) => {
      const asked = reference(one.block, one.rows);
      const got = blockFitOf(one.block, one.rows);
      const sameRule = (got?.reason ?? null) === (asked?.rule ?? null);
      const sameRow =
        asked === null || asked.indexes === null
          ? (got?.index ?? null) === null
          : got !== null && got.index !== null && asked.indexes.includes(got.index);
      if (!sameRule || !sameRow) failures.push(`case ${at}: ${JSON.stringify({ got, asked })}`);
    });
    expect(failures).toEqual([]);
  });

  it('is not vacuous: every rule and a fit are each hit many times', () => {
    const hits = new Map<string, number>();
    for (const one of cases) {
      const key = reference(one.block, one.rows)?.rule ?? (one.rows.length === 0 ? 'NO_ROWS' : 'FIT');
      hits.set(key, (hits.get(key) ?? 0) + 1);
    }
    for (const rule of [...RULES, 'FIT', 'NO_ROWS']) expect(hits.get(rule) ?? 0).toBeGreaterThanOrEqual(15);
  });

  it('names the row the rule is about: the first wrong length, the first wrong weeks, the first stranger, the last row of an over-full length', () => {
    let checked = 0;
    for (const one of cases) {
      const got = blockFitOf(one.block, one.rows);
      if (got === null || got.index === null) continue;
      const told = one.rows[got.index]!;
      const lowest = [...one.block.members].sort((x, y) => (x.id < y.id ? -1 : 1))[0]!;
      const lessons = (lowest.lessonLengths ?? []).length > 1 ? [...lowest.lessonLengths!] : Array.from({ length: lowest.lessonsPerWeek }, () => lowest.minutesPerLesson);
      if (got.reason === 'LENGTH') {
        expect(lessons).not.toContain(told.minutes);
        expect(one.rows.slice(0, got.index).every((earlier) => lessons.includes(earlier.minutes))).toBe(true);
      } else if (got.reason === 'WEEKS') {
        expect(told.recurrence).not.toBe(lowest.recurrence);
        expect(one.rows.slice(0, got.index).every((earlier) => earlier.recurrence === lowest.recurrence)).toBe(true);
      } else if (got.reason === 'COUNT') {
        const sameLength = one.rows.filter((other) => other.minutes === told.minutes);
        expect(sameLength.length).toBeGreaterThan(lessons.filter((minutes) => minutes === told.minutes).length);
        expect(one.rows.slice(got.index + 1).some((later) => later.minutes === told.minutes)).toBe(false);
      } else if (got.reason === 'MEMBER') {
        const ids = new Set(one.block.members.map((m) => m.id));
        expect((told.rooms ?? []).some((room) => !ids.has(room.requirementId))).toBe(true);
        expect(one.rows.slice(0, got.index).every((earlier) => (earlier.rooms ?? []).every((room) => ids.has(room.requirementId)))).toBe(true);
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('tells the same rule whatever order the rows come in', () => {
    const random = seeded(7);
    for (const one of cases) {
      const shuffled = [...one.rows];
      for (let at = shuffled.length - 1; at > 0; at--) {
        const swap = Math.floor(random() * (at + 1));
        [shuffled[at], shuffled[swap]] = [shuffled[swap]!, shuffled[at]!];
      }
      expect(blockFitOf(one.block, shuffled)?.reason ?? null).toBe(blockFitOf(one.block, one.rows)?.reason ?? null);
    }
  });

  it('keeps a set that fits fitting when a row is taken out, and never mends a set that breaks a rule by adding a row', () => {
    const random = seeded(99);
    for (const one of cases) {
      if (one.rows.length === 0) continue;
      const whole = blockFitOf(one.block, one.rows);
      const removed = Math.floor(random() * one.rows.length);
      const without = one.rows.filter((_, at) => at !== removed);
      if (whole === null) expect(blockFitOf(one.block, without)).toBeNull();
      else expect(blockFitOf(one.block, [...one.rows, one.rows[removed]!])).not.toBeNull();
      // A rule about the block alone (FOLLOWER, EMPTY, SHARES) is the same of every non-empty set.
      if (['FOLLOWER', 'EMPTY', 'SHARES'].includes(whole?.reason ?? '')) {
        expect(blockFitOf(one.block, without.length > 0 ? without : one.rows)?.reason).toBe(whole!.reason);
      }
    }
  });
});
