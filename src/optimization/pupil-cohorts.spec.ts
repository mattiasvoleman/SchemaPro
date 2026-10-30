import cases from '../common/__fixtures__/pupil-gaps-cases.json';
import { pupilKeyOf, replacedSubjectOf, replacingBySubject } from '../common/replacing-groups';
import { lockMarginOf, pupilCohortsOf, type PupilCohort } from './pupil-cohorts';

/*
 * The gateway's side of the contract (src/common/__fixtures__/pupil-gaps-cases.json):
 * from each case's school, the cohorts, keys and margins it sends are exactly
 * the engine form the engine counts (optimization-engine/tests/test_pupil_gaps.py),
 * and the report counts the school form itself (web/lib/gaps.contract.test.ts).
 * So the three read one timetable and give one number.
 */

interface SchoolCase {
  name: string;
  groups: { id: string; kind: string; halfOfId: string | null; replacesSubjectId: string | null }[];
  pupils: { id: string; home: string; groups: string[] }[];
  buffers: { group: string; subject: string; minutesBefore: number; minutesAfter: number }[];
  lessons: { id: string; groups: string[]; subject: string; pupils: string[]; locked: boolean }[];
  engine: {
    requirements: { id: string; group: string; pupilKey: string }[];
    fixedLessons: { id: string }[];
    fixedMargins: { fixedLesson: string; minutesBefore: number; minutesAfter: number }[];
    cohorts: { groupIds: string[]; fixedLessonIds: string[]; home: string; pupils: number }[];
  };
}

const all = (cases as unknown as { cases: SchoolCase[] }).cases;

function groupsByPupil(school: SchoolCase): Map<string, Set<string>> {
  return new Map(school.pupils.map((pupil) => [pupil.id, new Set([pupil.home, ...pupil.groups])]));
}

const normal = (cohorts: PupilCohort[]) =>
  cohorts.map((cohort) => JSON.stringify(cohort)).sort();

describe('pupilCohortsOf: the fixture school, as the engine is told it', () => {
  it.each(all.map((school) => [school.name, school] as const))('%s', (_name, school) => {
    const derivedKeys = school.engine.requirements
      .map((requirement) => requirement.pupilKey)
      .filter((key) => key !== undefined && key.includes('~'));
    const cohorts = pupilCohortsOf({
      homeOf: new Map(school.pupils.map((pupil) => [pupil.id, pupil.home])),
      groupsOf: groupsByPupil(school),
      groups: school.groups,
      derivedKeys,
      locks: school.lessons
        .filter((lesson) => lesson.locked)
        .map((lesson) => ({ id: lesson.id, groupIds: lesson.groups, subjectId: lesson.subject, pupilIds: lesson.pupils })),
    });
    expect(normal(cohorts)).toEqual(
      normal(
        school.engine.cohorts.map((cohort) => ({
          groupIds: [...cohort.groupIds].sort(),
          fixedLessonIds: [...cohort.fixedLessonIds].sort(),
          homeGroupId: cohort.home,
          pupils: cohort.pupils,
        })),
      ),
    );
  });

  it.each(all.map((school) => [school.name, school] as const))(
    "%s: every requirement's key is the one the payload derives",
    (_name, school) => {
      const pupilsOf = groupsByPupil(school);
      const shares = (a: string, b: string) => [...pupilsOf.values()].some((groups) => groups.has(a) && groups.has(b));
      const bySubject = replacingBySubject(replacedSubjectOf(school.groups));
      for (const requirement of school.engine.requirements) {
        const subject = school.lessons.find(
          (lesson) => !lesson.locked && `r-${lesson.groups[0]}-${lesson.subject}` === requirement.id,
        )?.subject;
        expect(subject).toBeDefined();
        expect(
          pupilKeyOf(requirement.group, { subjectId: subject!, groupIds: [requirement.group] }, bySubject, shares),
        ).toBe(requirement.pupilKey);
      }
    },
  );

  it.each(all.map((school) => [school.name, school] as const))(
    "%s: the locks' margins are their groups' widest rows",
    (_name, school) => {
      const buffers = new Map(
        school.buffers.map((row) => [`${row.group}:${row.subject}`, { minutesBefore: row.minutesBefore, minutesAfter: row.minutesAfter }]),
      );
      const margins = school.lessons
        .filter((lesson) => lesson.locked)
        .flatMap((lesson) => {
          const margin = lockMarginOf(buffers, { groupIds: lesson.groups, subjectId: lesson.subject });
          return margin ? [{ fixedLesson: lesson.id, ...margin }] : [];
        });
      expect(margins).toEqual(school.engine.fixedMargins);
    },
  );
});

describe('pupilCohortsOf: the rules one at a time', () => {
  const groups = [
    { id: '7A', kind: 'CLASS', halfOfId: null, replacesSubjectId: null },
    { id: '7A:1', kind: 'TEACHING_GROUP', halfOfId: '7A', replacesSubjectId: null },
    { id: '7A:2', kind: 'TEACHING_GROUP', halfOfId: '7A', replacesSubjectId: null },
    { id: 'SvA7', kind: 'TEACHING_GROUP', halfOfId: null, replacesSubjectId: 'sv' },
    { id: 'Fd7', kind: 'TEACHING_GROUP', halfOfId: null, replacesSubjectId: null },
  ];

  it('keeps a pupil of a replacing group on a teaching group that keeps its members (keptBy)', () => {
    const [cohort] = pupilCohortsOf({
      homeOf: new Map([['p1', '7A']]),
      groupsOf: new Map([['p1', new Set(['7A', 'SvA7', 'Fd7', '7A:1'])]]),
      groups,
      derivedKeys: [],
      locks: [
        { id: 'class-sv', groupIds: ['7A'], subjectId: 'sv', pupilIds: [] },
        { id: 'fd-sv', groupIds: ['Fd7'], subjectId: 'sv', pupilIds: [] },
      ],
    });
    // 7A's svenska is SvA7's to replace; Svenska fördjupning keeps its members.
    expect(cohort!.fixedLessonIds).toEqual(['fd-sv']);
  });

  it("keeps a named pupil on a lock their replacing group would take them off, and nobody else", () => {
    const cohorts = pupilCohortsOf({
      homeOf: new Map([
        ['p1', '7A'],
        ['p2', '7A'],
      ]),
      groupsOf: new Map([
        ['p1', new Set(['7A', 'SvA7', '7A:1'])],
        ['p2', new Set(['7A', 'SvA7', '7A:1'])],
      ]),
      groups,
      derivedKeys: [],
      locks: [{ id: 'class-sv', groupIds: ['7A'], subjectId: 'sv', pupilIds: ['p1'] }],
    });
    expect(cohorts.map((cohort) => [cohort.fixedLessonIds, cohort.pupils])).toEqual([
      [[], 1],
      [['class-sv'], 1],
    ]);
  });

  it('sends a derived key with the pupils it holds, and never with a member of its replacing group', () => {
    const cohorts = pupilCohortsOf({
      homeOf: new Map([
        ['p1', '7A'],
        ['p2', '7A'],
      ]),
      groupsOf: new Map([
        ['p1', new Set(['7A', 'SvA7', '7A:2'])],
        ['p2', new Set(['7A', '7A:2'])],
      ]),
      groups,
      derivedKeys: ['7A~SvA7', '7A~SvA7'],
      locks: [],
    });
    expect(cohorts.map((cohort) => cohort.groupIds)).toEqual([
      ['7A', '7A:2', '7A~SvA7'],
      ['7A', '7A:2', 'SvA7'],
    ]);
  });

  it('counts pupils booked alike once, and a class of its own apart', () => {
    const cohorts = pupilCohortsOf({
      homeOf: new Map([
        ['p1', '7A'],
        ['p2', '7A'],
        ['p3', '7B'],
      ]),
      groupsOf: new Map([
        ['p1', new Set(['7A'])],
        ['p2', new Set(['7A'])],
        ['p3', new Set(['7B'])],
      ]),
      groups: [{ id: '7A' }, { id: '7B' }],
      derivedKeys: [],
      locks: [],
    });
    expect(cohorts).toEqual([
      { groupIds: ['7A'], fixedLessonIds: [], homeGroupId: '7A', pupils: 2 },
      { groupIds: ['7B'], fixedLessonIds: [], homeGroupId: '7B', pupils: 1 },
    ]);
  });

  it('has no margin for a lock no row reaches, or one whose rows say nothing', () => {
    const buffers = new Map([
      ['7A:idh', { minutesBefore: 5, minutesAfter: 10 }],
      ['7B:idh', { minutesBefore: 10, minutesAfter: 0 }],
      ['7C:idh', { minutesBefore: 0, minutesAfter: 0 }],
    ]);
    expect(lockMarginOf(buffers, { groupIds: ['7A', '7B'], subjectId: 'idh' })).toEqual({
      minutesBefore: 10,
      minutesAfter: 10,
    });
    expect(lockMarginOf(buffers, { groupIds: ['7C'], subjectId: 'idh' })).toBeNull();
    expect(lockMarginOf(buffers, { groupIds: ['7A'], subjectId: 'ma' })).toBeNull();
  });
});
