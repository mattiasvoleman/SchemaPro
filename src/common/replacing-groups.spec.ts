import fixture from './__fixtures__/replacing-groups-cases.json';
import {
  baseOf,
  keysShare,
  derivedKey,
  leavesLesson,
  parseDerivedKey,
  pupilKeyOf,
  pupilKeysOf,
  replacedPupils,
  replacedSubjectOf,
  replacementPairs,
  replacementsOf,
  replacingBySubject,
  replacingGroupsOfNamed,
  yearsOf,
} from './replacing-groups';

/**
 * 7A (Alva, Bo, Cim) and 7B (Dag); SvA7 replaces Svenska and holds Alva and
 * Dag; Ma7 holds Bo. The rule's answers are written out here by hand, so the
 * generated fixture the web replays is checked against intent and not only
 * against itself.
 */
const groups = [
  { id: '7A', replacesSubjectId: null },
  { id: '7B', replacesSubjectId: null },
  { id: 'SvA7', replacesSubjectId: 'SV' },
  { id: 'Ma7', replacesSubjectId: null },
];
const replaced = replacedSubjectOf(groups);
const bySubject = replacingBySubject(replaced);
const pairs = new Set(['7A SvA7', '7B SvA7', '7A Ma7']);
const shares = (a: string, b: string) => pairs.has(a < b ? `${a} ${b}` : `${b} ${a}`);
const partnersOf = (groupId: string) =>
  [...pairs].flatMap((pair) => {
    const [a, b] = pair.split(' ');
    return a === groupId ? [b!] : b === groupId ? [a!] : [];
  });
const alva = replacementsOf(['7A', 'SvA7'], replaced);
const bo = replacementsOf(['7A', 'Ma7'], replaced);

describe('the rule, per pupil', () => {
  it('takes a pupil of a replacing group off the class’s lesson in its subject', () => {
    expect(alva).toEqual([{ groupId: 'SvA7', subjectId: 'SV' }]);
    expect(leavesLesson(alva, { subjectId: 'SV', groupIds: ['7A'] })).toBe(true);
  });

  it('leaves them on every other subject, and on the replacing group’s own lessons', () => {
    expect(leavesLesson(alva, { subjectId: 'MA', groupIds: ['7A'] })).toBe(false);
    expect(leavesLesson(alva, { subjectId: 'SVA', groupIds: ['SvA7'] })).toBe(false);
    // A school with one subject for both: SvA7's own lessons carry SvA7.
    expect(leavesLesson(alva, { subjectId: 'SV', groupIds: ['SvA7'] })).toBe(false);
  });

  it('keeps them on a lesson the replacing group is added to (an extra group puts its pupils on)', () => {
    expect(leavesLesson(alva, { subjectId: 'SV', groupIds: ['7B', 'SvA7'] })).toBe(false);
  });

  it('keeps a named pupil on, whatever their groups say', () => {
    expect(leavesLesson(alva, { subjectId: 'SV', groupIds: ['7A'] }, true)).toBe(false);
  });

  it('changes nothing for a pupil in no replacing group', () => {
    expect(bo).toEqual([]);
    expect(leavesLesson(bo, { subjectId: 'SV', groupIds: ['7A'] })).toBe(false);
  });

  it('takes the same pupils off a roster', () => {
    const membersOf = new Map([['SvA7', new Set(['Alva', 'Dag'])]]);
    const roster = ['Alva', 'Bo', 'Cim'];
    expect([...replacedPupils(roster, { subjectId: 'SV', groupIds: ['7A'] }, new Set(), bySubject, membersOf)]).toEqual([
      'Alva',
    ]);
    expect(replacedPupils(roster, { subjectId: 'SV', groupIds: ['7A'] }, new Set(['Alva']), bySubject, membersOf).size).toBe(0);
    expect(replacedPupils(roster, { subjectId: 'MA', groupIds: ['7A'] }, new Set(), bySubject, membersOf).size).toBe(0);
    expect(replacedPupils(roster, { subjectId: 'SV', groupIds: ['7A', 'SvA7'] }, new Set(), bySubject, membersOf).size).toBe(0);
  });
});

describe('the rule, per group', () => {
  it('answers a replaced subject’s lessons for a derived key, and every other lesson for the group', () => {
    expect(pupilKeyOf('7A', { subjectId: 'SV', groupIds: ['7A'] }, bySubject, shares)).toBe(derivedKey('7A', ['SvA7']));
    expect(pupilKeyOf('7A', { subjectId: 'MA', groupIds: ['7A'] }, bySubject, shares)).toBe('7A');
    // SvA7 on the lesson: its pupils are on it, nothing is left out.
    expect(pupilKeysOf({ subjectId: 'SV', groupIds: ['7B', 'SvA7'] }, bySubject, shares)).toEqual(['7B', 'SvA7']);
    // A named pupil of SvA7 is on it too.
    expect(pupilKeyOf('7A', { subjectId: 'SV', groupIds: ['7A'] }, bySubject, shares, ['SvA7'])).toBe('7A');
    expect(
      replacingGroupsOfNamed(['Alva'], (pupil) => (pupil === 'Alva' ? ['7A', 'SvA7'] : []), replaced),
    ).toEqual(['SvA7']);
  });

  it('leaves a group no replacing group shares pupils with as it is', () => {
    const lonely = (a: string, b: string) => shares(a, b) && a !== '7C' && b !== '7C';
    expect(pupilKeyOf('7C', { subjectId: 'SV', groupIds: ['7C'] }, bySubject, lonely)).toBe('7C');
  });

  it('pairs a derived key with its group and the group’s partners, never with the replacing group', () => {
    const key = derivedKey('7A', ['SvA7']);
    expect(parseDerivedKey(key)).toEqual({ groupId: '7A', replacing: ['SvA7'] });
    expect(baseOf(key)).toBe('7A');
    expect(baseOf('7A')).toBe('7A');
    const added = replacementPairs([key, '7A', 'SvA7'], partnersOf);
    expect(added).toEqual([
      ['7A', key],
      [key, 'Ma7'],
    ]);
  });

  it('pairs two derived keys of one class, and of partners, unless one leaves the other’s group out', () => {
    const sv = derivedKey('7A', ['SvA7']);
    const sv7b = derivedKey('7B', ['SvA7']);
    const en = derivedKey('7A', ['EnS']);
    const added = replacementPairs([sv, en, sv7b], partnersOf);
    expect(added).toContainEqual([en, sv].sort() as [string, string]);
    // 7A and 7B share no pupil, so their svenska keys are not paired.
    expect(added.find((pair) => pair.includes(sv) && pair.includes(sv7b))).toBeUndefined();
  });

  it('answers keysShare exactly as the pairs say, over every key of the fixture school', () => {
    const f = fixture as unknown as { pairs: [string, string][]; expected: { keys: Record<string, string[]>; addedPairs: [string, string][] } };
    const base = new Set(f.pairs.map(([a, b]) => `${a} ${b}`));
    const baseShares = (a: string, b: string) => base.has(a < b ? `${a} ${b}` : `${b} ${a}`);
    const added = new Set(f.expected.addedPairs.map(([a, b]) => `${a} ${b}`));
    const keys = [...new Set([...Object.values(f.expected.keys).flat(), ...f.pairs.flat()])].sort();
    for (const a of keys) {
      for (const b of keys) {
        if (a === b) continue;
        const pairKey = a < b ? `${a} ${b}` : `${b} ${a}`;
        const expected = a.includes('~') || b.includes('~') ? added.has(pairKey) : base.has(pairKey);
        expect([a, b, keysShare(a, b, baseShares)]).toEqual([a, b, expected]);
      }
    }
  });

  it('adds nothing at a school with no replacing group', () => {
    const none = replacingBySubject(replacedSubjectOf([{ id: '7A' }, { id: 'Ma7', replacesSubjectId: null }]));
    expect(none.size).toBe(0);
    expect(pupilKeysOf({ subjectId: 'SV', groupIds: ['7A', 'Ma7'] }, none, () => true)).toEqual(['7A', 'Ma7']);
    expect(replacementPairs(['7A', 'Ma7'], partnersOf)).toEqual([]);
  });
});

describe('the shared fixture (the web replays it)', () => {
  interface Fixture {
    groups: { id: string; replacesSubjectId: string | null; academicYearId: string }[];
    groupsOfPupil: Record<string, string[]>;
    pairs: [string, string][];
    lessons: { id: string; subjectId: string; groupIds: string[]; named: string[]; academicYearId: string }[];
    expected: {
      leaves: { lesson: string; pupil: string; leaves: boolean }[];
      keys: Record<string, string[]>;
      addedPairs: [string, string][];
    };
  }
  const f = fixture as unknown as Fixture;
  const fReplaced = replacedSubjectOf(f.groups);
  const fYearOf = yearsOf(f.groups);
  const fBySubject = replacingBySubject(fReplaced);
  const fPairs = new Set(f.pairs.map(([a, b]) => `${a} ${b}`));
  const fShares = (a: string, b: string) => fPairs.has(a < b ? `${a} ${b}` : `${b} ${a}`);
  const fPartners = (groupId: string) => f.pairs.flatMap(([a, b]) => (a === groupId ? [b] : b === groupId ? [a] : []));

  it('replays: every pupil’s answer on every lesson', () => {
    const lessons = new Map(f.lessons.map((lesson) => [lesson.id, lesson]));
    for (const row of f.expected.leaves) {
      const lesson = lessons.get(row.lesson)!;
      const got = leavesLesson(replacementsOf(f.groupsOfPupil[row.pupil]!, fReplaced, fYearOf), lesson, lesson.named.includes(row.pupil));
      expect([row.lesson, row.pupil, got]).toEqual([row.lesson, row.pupil, row.leaves]);
    }
  });

  it('replays: every lesson’s keys and the pairs they add', () => {
    const keys = Object.fromEntries(
      f.lessons.map((lesson) => [
        lesson.id,
        pupilKeysOf(
          lesson,
          fBySubject,
          fShares,
          replacingGroupsOfNamed(lesson.named, (pupil) => f.groupsOfPupil[pupil] ?? [], fReplaced),
          fYearOf,
        ),
      ]),
    );
    expect(keys).toEqual(f.expected.keys);
    expect(replacementPairs(Object.values(keys).flat(), fPartners)).toEqual(f.expected.addedPairs);
  });

  it('reaches every answer: a pupil off, a pupil on, a derived key, an added pair', () => {
    expect(f.expected.leaves.some((row) => row.leaves)).toBe(true);
    expect(f.expected.leaves.some((row) => !row.leaves)).toBe(true);
    expect(Object.values(f.expected.keys).flat().some((key) => key.includes('~'))).toBe(true);
    expect(f.expected.addedPairs.length).toBeGreaterThan(0);
  });
});
