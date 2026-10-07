import {
  MAX_CHAIN_HOPS,
  chainOf,
  homeClassOverlay,
  pendingMoves,
  planActivation,
  planMoves,
  type ActivationGroup,
  type ActivationSource,
  type ActivationStudent,
  type ActivationYear,
} from './activation-plan';

const year = (id: string, name: string, startDate: string, endDate: string, extra: Partial<ActivationYear> = {}): ActivationYear => ({
  id,
  name,
  startDate,
  endDate,
  isActive: false,
  predecessorId: null,
  graduatingGradeLevel: null,
  ...extra,
});
const group = (id: string, academicYearId: string, gradeLevel: number | null, predecessorId: string | null = null, kind: ActivationGroup['kind'] = 'CLASS'): ActivationGroup => ({
  id,
  name: id.toUpperCase(),
  academicYearId,
  kind,
  gradeLevel,
  predecessorId,
});
const pupil = (id: string, studentGroupId: string | null, isActive = true): ActivationStudent => ({ id, isActive, studentGroupId });

/** A (2026/27, active) → B (2027/28) → C (2028/29), and an unrelated summer year. */
function school(): ActivationSource {
  return {
    yearId: 'B',
    years: [
      year('A', '2026/27', '2026-08-17', '2027-06-11', { isActive: true }),
      year('B', '2027/28', '2027-08-16', '2028-06-09', { predecessorId: 'A', graduatingGradeLevel: 9 }),
      year('C', '2028/29', '2028-08-14', '2029-06-08', { predecessorId: 'B', graduatingGradeLevel: 9 }),
      year('S', 'Sommarskola', '2027-06-14', '2027-07-02'),
    ],
    groups: [
      group('a7', 'A', 7),
      group('a8', 'A', 8),
      group('a9', 'A', 9),
      group('a6', 'A', 6),
      group('aX', 'A', 7),
      group('b8', 'B', 8, 'a7'),
      group('b9', 'B', 9, 'a8'),
      group('b7', 'B', 7, 'a6', 'TEACHING_GROUP'),
      group('c9', 'C', 9, 'b8'),
      group('s1', 'S', null),
    ],
    students: [
      pupil('p1', 'a7'),
      pupil('p2', 'a7'),
      pupil('p3', 'a8'),
      pupil('p4', 'a9'),
      pupil('p5', 'a6'),
      pupil('p6', 'aX'),
      pupil('p7', 'b8'),
      pupil('p9', 's1'),
      pupil('p10', null),
      pupil('p11', 'a7', false),
    ],
    members: [],
  };
}

describe('planActivation', () => {
  it('moves along the links, graduates at G, and leaves everyone else alone', () => {
    const plan = planActivation(school(), '2027-06-14');
    expect(plan.chain.map((previous) => previous.name)).toEqual(['2026/27']);
    expect(plan.moves).toEqual([
      { fromGroupId: 'a7', fromGroupName: 'A7', toGroupId: 'b8', toGroupName: 'B8', count: 2, studentIds: ['p1', 'p2'] },
      { fromGroupId: 'a8', fromGroupName: 'A8', toGroupId: 'b9', toGroupName: 'B9', count: 1, studentIds: ['p3'] },
    ]);
    expect(plan.graduates).toEqual({ count: 1, studentIds: ['p4'] });
    expect(plan.unplaced.pupils).toEqual([
      { studentId: 'p5', fromGroupId: 'a6', reason: 'SUCCESSOR_NOT_A_CLASS' },
      { studentId: 'p6', fromGroupId: 'aX', reason: 'NO_SUCCESSOR' },
    ]);
    expect(plan).toMatchObject({ alreadyInYear: 1, inLaterYear: 0, otherOrNone: 2, inactiveUntouched: 1, blocking: false });
    expect(plan.currentlyActive).toEqual({ id: 'A', name: '2026/27' });
    expect(pendingMoves(plan)).toBe(6);
  });

  it('refuses while the old year still runs, naming its last day', () => {
    const plan = planActivation(school(), '2027-06-11');
    expect(plan.problems).toEqual([
      { code: 'YEAR_ACTIVATION_TOO_EARLY', blocking: true, params: { year: '2026/27', endDate: '2027-06-11' } },
    ]);
    expect(plan.blocking).toBe(true);
  });

  it('follows two hops when a year was skipped, and refuses a year whose successor holds the pupils', () => {
    const source = { ...school(), yearId: 'C' };
    const plan = planActivation(source, '2028-07-01');
    expect(plan.chain.map((previous) => previous.id)).toEqual(['B', 'A']);
    // p1, p2: a7 → b8 → c9. p3: a8 → b9, which has no successor in C and is at G: a graduate.
    expect(plan.moves).toEqual([
      expect.objectContaining({ fromGroupId: 'a7', toGroupId: 'c9', count: 2 }),
      expect.objectContaining({ fromGroupId: 'b8', toGroupId: 'c9', count: 1 }),
    ]);
    expect(plan.graduates.studentIds).toEqual(['p3', 'p4']);

    // A pupil already in C counts as in a later year when B is activated —
    // and makes B a superseded year.
    const later = school();
    later.students.push(pupil('p8', 'c9'));
    const b = planActivation(later, '2027-06-14');
    expect(b.inLaterYear).toBe(1);
    expect(b.problems).toEqual([expect.objectContaining({ code: 'YEAR_IS_SUPERSEDED', params: { year: '2027/28', successor: '2028/29', pupils: 1 } })]);

    // A, once B holds pupils, is superseded.
    const moved = school();
    moved.yearId = 'A';
    const superseded = planActivation(moved, '2027-07-01');
    expect(superseded.problems).toEqual([
      expect.objectContaining({ code: 'YEAR_IS_SUPERSEDED', params: { year: '2026/27', successor: '2027/28', pupils: 1 } }),
    ]);
  });

  it('refuses a year two links back when a later year of its chain holds the pupils, naming that year', () => {
    // A → B → C, everyone already in C, B empty: A looked one link ahead,
    // found B empty, and could be activated back with no pupils at all.
    const source = school();
    source.yearId = 'A';
    source.years = source.years.map((candidate) => ({ ...candidate, isActive: candidate.id === 'C' }));
    source.students = [pupil('q1', 'c9'), pupil('q2', 'c9'), pupil('q3', 'a7', false)];
    const plan = planActivation(source, '2029-07-01');
    expect(plan.inLaterYear).toBe(2);
    expect(plan.problems).toEqual([
      { code: 'YEAR_IS_SUPERSEDED', blocking: true, params: { year: '2026/27', successor: '2028/29', pupils: 2 } },
    ]);
    // B, between them, is refused for the same reason.
    expect(planActivation({ ...source, yearId: 'B' }, '2029-07-01').problems).toEqual([
      expect.objectContaining({ code: 'YEAR_IS_SUPERSEDED', params: { year: '2027/28', successor: '2028/29', pupils: 2 } }),
    ]);
    // An inactive pupil in a later year supersedes nothing.
    source.students = [pupil('q1', 'c9', false)];
    expect(planActivation(source, '2029-07-01').problems).toEqual([]);
  });

  it('counts teaching-group memberships the rollover decided on placements that have changed since, without blocking', () => {
    const source = school();
    // A teaching group Ma7 in A, carried into B as Ma8 with p1 (copied at the rollover).
    source.groups.push(group('aMa', 'A', 7, null, 'TEACHING_GROUP'), group('bMa', 'B', 8, 'aMa', 'TEACHING_GROUP'));
    source.members = [
      { studentGroupId: 'aMa', studentId: 'p1' },
      { studentGroupId: 'bMa', studentId: 'p1' },
      // p2 was in a skipped class at the rollover and was re-placed into 7A since: not copied.
      { studentGroupId: 'aMa', studentId: 'p2' },
      // p4 graduates, but someone had added them to next year's Ma8.
      { studentGroupId: 'bMa', studentId: 'p4' },
    ];
    const plan = planActivation(source, '2027-06-14');
    expect(plan.problems).toEqual([
      { code: 'MEMBERSHIPS_OUT_OF_DATE', blocking: false, params: { missing: 1, stale: 1 } },
    ]);
    expect(plan.blocking).toBe(false);
    // The hash is the writes', not the warnings'.
    expect(plan.planHash).toBe(planActivation({ ...source, members: [] }, '2027-06-14').planHash);
    // With no member carried into Ma8 at all (carryTeachingGroupMembers off), nothing is missing.
    source.members = [{ studentGroupId: 'aMa', studentId: 'p1' }, { studentGroupId: 'aMa', studentId: 'p2' }];
    expect(planActivation(source, '2027-06-14').problems).toEqual([]);
  });

  it('is a no-op the second time: the same pupils are already in the year', () => {
    const source = school();
    const first = planActivation(source, '2027-06-14');
    for (const move of first.writes) {
      for (const id of move.studentIds) {
        source.students.find((student) => student.id === id)!.studentGroupId = move.toGroupId;
      }
    }
    source.years = source.years.map((candidate) => ({ ...candidate, isActive: candidate.id === 'B' }));
    const second = planActivation(source, '2027-06-14');
    expect(second.writes).toEqual([]);
    expect(second.moves).toEqual([]);
    expect(second.alreadyInYear).toBe(4);
    expect(second.blocking).toBe(false);
    expect(second.planHash).not.toBe(first.planHash);
    expect(planActivation(source, '2027-06-14').planHash).toBe(second.planHash);
  });

  it('labels a broken chain unplaced when the next year has no G', () => {
    const source = school();
    source.years[1] = { ...source.years[1]!, graduatingGradeLevel: null };
    const plan = planActivation(source, '2027-06-14');
    expect(plan.graduates.count).toBe(0);
    expect(plan.unplaced.studentIds).toContain('p4');
  });

  it('gives a year with no predecessor an empty plan', () => {
    const plan = planActivation({ ...school(), yearId: 'S' }, '2027-06-14');
    expect(plan).toMatchObject({ chain: [], moves: [], blocking: false, alreadyInYear: 1 });
  });

  it('stops following the chain after MAX_CHAIN_HOPS, and at a cycle', () => {
    const years = Array.from({ length: MAX_CHAIN_HOPS + 3 }, (_, index) =>
      year(`Y${index}`, `År ${index}`, '2000-01-01', '2000-06-01', { predecessorId: index === 0 ? null : `Y${index - 1}` }),
    );
    expect(chainOf(years, `Y${MAX_CHAIN_HOPS + 2}`)).toHaveLength(MAX_CHAIN_HOPS);
    const cycle = [year('X', 'X', '2000-01-01', '2000-06-01', { predecessorId: 'Z' }), year('Z', 'Z', '2000-01-01', '2000-06-01', { predecessorId: 'X' })];
    expect(chainOf(cycle, 'X').map((previous) => previous.id)).toEqual(['Z']);
  });

  it('keeps every plan hash it had before planMoves was split out of it (refactor guard)', () => {
    // The hashes the fixtures above had at f5ff8da, before the walk moved
    // into planMoves: a preview taken on the old code must still execute.
    const hashOf = (source: ActivationSource, today: string) => planActivation(source, today).planHash;
    const b = 'c3a8076a7156ec75bbfc87028b303871e5e606d9a1ecf379ee5c5f9890ddb8d7';
    expect(hashOf(school(), '2027-06-14')).toBe(b);
    expect(hashOf(school(), '2027-06-11')).toBe(b);
    expect(hashOf({ ...school(), yearId: 'C' }, '2028-07-01')).toBe(
      '8c617fc88dbf65c2fa57c4ade7b41050ebe6dad7f8b3b28fce678c2e85980a56',
    );
    const later = school();
    later.students.push(pupil('p8', 'c9'));
    expect(hashOf(later, '2027-06-14')).toBe(b);
    expect(hashOf({ ...school(), yearId: 'A' }, '2027-07-01')).toBe(
      '6a3b57bc666e7d36550a03bf09246ae6bbe18d54aba6c5d3bb9b5f1c3e1ba925',
    );
    expect(hashOf({ ...school(), yearId: 'S' }, '2027-06-14')).toBe(
      'b75a8820bda19f92751ceafd54388c420fa289143515efd8b3f1c23c5a6c5a8d',
    );
  });

  it('plans with the walk planMoves makes, whatever the day, and homeClassOverlay maps exactly its writes', () => {
    for (const source of [school(), { ...school(), yearId: 'C' }, { ...school(), yearId: 'A' }]) {
      const moves = planMoves(source);
      for (const today of ['2000-01-01', '2027-06-14', '9999-12-31']) {
        const plan = planActivation(source, today);
        expect(plan.writes).toEqual(moves.writes);
        expect(plan.graduates.studentIds).toEqual([...moves.graduates].sort());
        expect(plan.unplaced.studentIds).toEqual(moves.unplaced.map((entry) => entry.studentId).sort());
        expect(plan).toMatchObject({
          alreadyInYear: moves.alreadyInYear,
          inLaterYear: moves.inLaterYear,
          otherOrNone: moves.otherOrNone,
          inactiveUntouched: moves.inactiveUntouched,
        });
      }
    }
    const homeOf = homeClassOverlay(planMoves(school()));
    expect(Object.fromEntries(homeOf)).toEqual({ p1: 'b8', p2: 'b8', p3: 'b9', p4: null, p5: null, p6: null });
    // Inactive p11, p7 already in B, p9 in an unrelated year and p10 in none are not in it.
    for (const id of ['p7', 'p9', 'p10', 'p11']) expect(homeOf.has(id)).toBe(false);
  });
});
