import { halfPairs, halvesByClass, unplacedPupils, unplacedShareOf, type GroupHalf } from './class-halves';

/**
 * 7A (Alva, Bo, Cim, Dag) split into 7A:1 and 7A:2; Ma7 holds Alva and Eva
 * (of 7B); 7B is a class of its own with no halves.
 */
const groups: GroupHalf[] = [
  { id: '7A', halfOfId: null },
  { id: '7A:1', halfOfId: '7A' },
  { id: '7A:2', halfOfId: '7A' },
  { id: '7B', halfOfId: null },
  { id: 'Ma7', halfOfId: null },
];

/** groupId -> pupils and pupil -> groups, as every caller reads them. */
const maps = (placed: Record<string, string[]>) => {
  const membersOf = new Map<string, Set<string>>([
    ['7A', new Set(['alva', 'bo', 'cim', 'dag'])],
    ['7B', new Set(['eva'])],
    ['Ma7', new Set(['alva', 'eva'])],
  ]);
  for (const [half, pupils] of Object.entries(placed)) membersOf.set(half, new Set(pupils));
  const groupsOf = new Map<string, Set<string>>();
  for (const [group, pupils] of membersOf) {
    for (const pupil of pupils) groupsOf.set(pupil, new Set([...(groupsOf.get(pupil) ?? []), group]));
  }
  return { membersOf, groupsOf };
};

const keys = (pairs: [string, string][]) => pairs.map(([a, b]) => `${a}|${b}`).sort();

describe('halfPairs', () => {
  it('pairs each half with its class and with every group of the class before anyone is placed, and never the two halves', () => {
    const { membersOf, groupsOf } = maps({});

    expect(keys(halfPairs(groups, membersOf, groupsOf))).toEqual(['7A:1|Ma7', '7A:2|Ma7', '7A|7A:1', '7A|7A:2']);
  });

  it('pairs a half only with its class once every pupil is placed: the members bring their own groups', () => {
    const { membersOf, groupsOf } = maps({ '7A:1': ['alva', 'bo'], '7A:2': ['cim', 'dag'] });

    expect(keys(halfPairs(groups, membersOf, groupsOf))).toEqual(['7A|7A:1', '7A|7A:2']);
  });

  it('keeps the unplaced pupils’ groups on both halves while some are still to place', () => {
    // Alva (Ma7) is placed in 7A:2; Bo is placed nowhere and is in Ma7 too.
    const { membersOf, groupsOf } = maps({ '7A:2': ['alva'] });
    groupsOf.get('bo')!.add('Ma7');
    membersOf.get('Ma7')!.add('bo');

    expect(keys(halfPairs(groups, membersOf, groupsOf))).toEqual(['7A:1|Ma7', '7A:2|Ma7', '7A|7A:1', '7A|7A:2']);
  });

  it('pairs a half with its class when the class has no pupils yet', () => {
    expect(keys(halfPairs(groups, new Map(), new Map()))).toEqual(['7A|7A:1', '7A|7A:2']);
  });

  it('adds nothing for a school with no halves', () => {
    const { membersOf, groupsOf } = maps({});

    expect(halfPairs(groups.filter((group) => !group.halfOfId), membersOf, groupsOf)).toEqual([]);
  });
});

describe('the unplaced pupils and the halves’ share of them', () => {
  it('reads the class less everyone a half holds, and shares it out rounded up', () => {
    const { membersOf } = maps({ '7A:1': ['alva'] });

    expect(halvesByClass(groups)).toEqual(new Map([['7A', ['7A:1', '7A:2']]]));
    expect(unplacedPupils('7A', ['7A:1', '7A:2'], membersOf)).toEqual(['bo', 'cim', 'dag']);
    expect(unplacedShareOf(groups, membersOf)).toEqual(new Map([['7A:1', 2], ['7A:2', 2]]));
  });
});
