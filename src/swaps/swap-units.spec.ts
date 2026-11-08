import { buildUnits, slotKey, weeksMeet, type UnitRelations } from './swap-units';
import type { SwapLesson } from './swap-types';

const lesson = (id: string, over: Partial<SwapLesson> = {}): SwapLesson => ({
  id,
  subjectId: `s-${id}`,
  subjectName: `Ämne ${id}`,
  studentGroupId: `g-${id}`,
  groupName: `Grupp ${id}`,
  teacherId: null,
  coTeacherId: null,
  roomId: null,
  dayOfWeek: 1,
  startMinutes: 480,
  endMinutes: 540,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  isLocked: false,
  isGenerated: true,
  extraGroupIds: [],
  studentIds: [],
  ...over,
});

const relations = (over: Partial<UnitRelations> = {}): UnitRelations => ({
  blockOf: () => null,
  sameTimesOf: () => null,
  groupFacts: new Map(),
  sharesPupils: () => false,
  ...over,
});

describe('buildUnits: what the school laid beside a lesson goes with it', () => {
  it('is a unit of one for a lesson with nothing beside it', () => {
    const units = buildUnits([lesson('a'), lesson('b', { startMinutes: 600, endMinutes: 660 })], relations());
    expect(units.get('a')!.members.map((m) => m.id)).toEqual(['a']);
    expect(units.get('a')!.links).toEqual([]);
    expect(units.get('a')).not.toBe(units.get('b'));
  });

  it('joins the members of a parallel block standing in one slot, and names the link', () => {
    const blockOf = (l: SwapLesson) => (l.id === 'x' || l.id === 'y' ? 'B1' : null);
    const units = buildUnits([lesson('x'), lesson('y'), lesson('z')], relations({ blockOf }));
    expect(units.get('x')).toBe(units.get('y'));
    expect(units.get('z')).not.toBe(units.get('x'));
    expect(units.get('x')!.links).toEqual([{ kind: 'BLOCK', lessonId: 'y', viaLessonId: 'x' }]);
  });

  it('does not join block members in other weeks: weeks are part of the slot', () => {
    const blockOf = () => 'B1';
    const units = buildUnits(
      [lesson('x'), lesson('y', { recurrence: 'ODD_WEEKS' })],
      relations({ blockOf }),
    );
    expect(units.get('x')).not.toBe(units.get('y'));
  });

  it('does not join block members that stand in different slots', () => {
    const blockOf = () => 'B1';
    const units = buildUnits([lesson('x'), lesson('y', { dayOfWeek: 2 })], relations({ blockOf }));
    expect(units.get('x')).not.toBe(units.get('y'));
  });

  it("joins a block on another block's times, from either side", () => {
    const blockOf = (l: SwapLesson) => (l.id === 'autumn' ? 'A' : 'S');
    for (const sameTimesOf of [
      (b: string) => (b === 'S' ? 'A' : null),
      (b: string) => (b === 'A' ? 'S' : null),
    ]) {
      const units = buildUnits([lesson('autumn'), lesson('spring')], relations({ blockOf, sameTimesOf }));
      expect(units.get('autumn')).toBe(units.get('spring'));
      expect(units.get('autumn')!.links[0]!.kind).toBe('SAME_TIMES');
    }
  });

  it("joins the two halves of one class standing together (the rotation) and not a half with another class's half", () => {
    const groupFacts = new Map([
      ['7A:1', { halfOfId: '7A', replacesSubjectId: null }],
      ['7A:2', { halfOfId: '7A', replacesSubjectId: null }],
      ['7B:1', { halfOfId: '7B', replacesSubjectId: null }],
    ]);
    const units = buildUnits(
      [
        lesson('h1', { studentGroupId: '7A:1' }),
        lesson('h2', { studentGroupId: '7A:2' }),
        lesson('other', { studentGroupId: '7B:1' }),
      ],
      relations({ groupFacts }),
    );
    expect(units.get('h1')).toBe(units.get('h2'));
    expect(units.get('other')).not.toBe(units.get('h1'));
    expect(units.get('h1')!.links[0]!.kind).toBe('HALF');
  });

  it('joins a replacing group with the class lesson of the subject it replaces, when they share a pupil', () => {
    const groupFacts = new Map([['SvA7', { halfOfId: null, replacesSubjectId: 'sv' }]]);
    const lessons = [
      lesson('class-sv', { studentGroupId: '7A', subjectId: 'sv' }),
      lesson('sva', { studentGroupId: 'SvA7', subjectId: 'sva' }),
      lesson('bystander-sv', { studentGroupId: '7C', subjectId: 'sv' }),
    ];
    const units = buildUnits(
      lessons,
      relations({ groupFacts, sharesPupils: (a, b) => [a, b].sort().join() === '7A,SvA7' }),
    );
    expect(units.get('class-sv')).toBe(units.get('sva'));
    // 7C shares no pupil with SvA7: its svenska merely starts at the same time.
    expect(units.get('bystander-sv')).not.toBe(units.get('sva'));
    expect(units.get('sva')!.links[0]!.kind).toBe('REPLACING');
  });

  it('makes a unit of a chain: a block member, the half beside it and the replacing group beside that', () => {
    const blockOf = (l: SwapLesson) => (l.id === 'm1' || l.id === 'm2' ? 'B' : null);
    const groupFacts = new Map([
      ['G2', { halfOfId: 'C', replacesSubjectId: null }],
      ['G3', { halfOfId: 'C', replacesSubjectId: null }],
    ]);
    const units = buildUnits(
      [
        lesson('m1'),
        lesson('m2'),
        lesson('h2', { studentGroupId: 'G2' }),
        lesson('h3', { studentGroupId: 'G3' }),
      ],
      relations({ blockOf, groupFacts }),
    );
    // m1-m2 by block, h2-h3 by halves: two units, never one by mere proximity.
    expect(units.get('m1')).toBe(units.get('m2'));
    expect(units.get('h2')).toBe(units.get('h3'));
    expect(units.get('m1')).not.toBe(units.get('h2'));
  });

  it('marks a unit locked when any member is, and names a unit by its lowest member', () => {
    const blockOf = () => 'B';
    const units = buildUnits([lesson('b'), lesson('a', { isLocked: true })], relations({ blockOf }));
    expect(units.get('a')!.locked).toBe(true);
    expect(units.get('b')!.id).toBe('a');
  });
});

describe('weeksMeet', () => {
  it('lets odd never meet even, and a dated window meet only inside itself', () => {
    expect(weeksMeet({ recurrence: 'ODD_WEEKS', startDate: null, endDate: null }, { recurrence: 'EVEN_WEEKS', startDate: null, endDate: null })).toBe(false);
    expect(weeksMeet({ recurrence: 'ALL_WEEKS', startDate: null, endDate: '2026-12-20' }, { recurrence: 'ALL_WEEKS', startDate: '2027-01-12', endDate: null })).toBe(false);
    expect(weeksMeet({ recurrence: 'ALL_WEEKS', startDate: null, endDate: null }, { recurrence: 'EVEN_WEEKS', startDate: null, endDate: null })).toBe(true);
  });
});

describe('slotKey', () => {
  it('names a day and a clock', () => {
    expect(slotKey({ dayOfWeek: 2, startMinutes: 480, endMinutes: 540 })).toBe('2|480|540');
  });
});
