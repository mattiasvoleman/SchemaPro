import {
  cancelledNoteOf,
  closedDaysOf,
  expandNamedGroups,
  noteOf,
  ownersOf,
  planReplacements,
  teacherClashes,
  uncoveredPupilIds,
  uncoveredPupils,
  type GroupFacts,
  type PlanLesson,
  type PlanOwner,
} from './activity-plan';

const group = (id: string, kind: GroupFacts['kind'], gradeLevel: number | null = null, halfOfId: string | null = null): GroupFacts => ({
  id,
  name: id,
  kind,
  gradeLevel,
  halfOfId,
});

// 7A with two halves, 7B, 7C, 8A, a replacing group SvA7 of 7A pupils, a språkval of 7A and 7B, a nivågrupp
// wholly in 7A and 7B, and a group of 7A and 8A.
const GROUPS: GroupFacts[] = [
  group('7A', 'CLASS', 7),
  group('7A-1', 'TEACHING_GROUP', 7, '7A'),
  group('7A-2', 'TEACHING_GROUP', 7, '7A'),
  group('7B', 'CLASS', 7),
  group('7C', 'CLASS', 7),
  group('8A', 'CLASS', 8),
  group('SvA7', 'TEACHING_GROUP'),
  group('Spanska', 'TEACHING_GROUP'),
  group('Nivå', 'TEACHING_GROUP'),
  group('Blandad', 'TEACHING_GROUP'),
  group('Tom', 'TEACHING_GROUP'),
];

const HOMES = new Map<string, string[]>([
  ['SvA7', ['7A', '7A']],
  ['Spanska', ['7A', '7B', '7C']],
  ['Nivå', ['7A', '7B', '7B']],
  ['Blandad', ['7A', '8A']],
  ['Tom', []],
]);

describe('who gets a replacement lesson', () => {
  it('names the classes the administrator named, with a half folded into its class', () => {
    const owners = ownersOf({ scope: 'GROUPS', minGradeLevel: null, maxGradeLevel: null, groupIds: ['7B', '7A-1', '7A', 'Spanska', 'ghost'] }, GROUPS);
    expect(owners.map((owner) => owner.id)).toEqual(['7A', '7B', 'Spanska']);
  });

  it('keeps a half named alone as its own owner, for its own pupils', () => {
    const owners = ownersOf({ scope: 'GROUPS', minGradeLevel: null, maxGradeLevel: null, groupIds: ['7A-2'] }, GROUPS);
    expect(owners.map((owner) => owner.id)).toEqual(['7A-2']);
  });

  it('takes the classes of an årskurs span and no half, teaching group or class outside it', () => {
    const owners = ownersOf({ scope: 'GRADES', minGradeLevel: 7, maxGradeLevel: 7, groupIds: [] }, GROUPS);
    expect(owners.map((owner) => owner.id)).toEqual(['7A', '7B', '7C']);
    expect(ownersOf({ scope: 'GRADES', minGradeLevel: 8, maxGradeLevel: 9, groupIds: [] }, GROUPS).map((owner) => owner.id)).toEqual(['8A']);
    // A span that has no end names nobody.
    expect(ownersOf({ scope: 'GRADES', minGradeLevel: 7, maxGradeLevel: null, groupIds: [] }, GROUPS)).toEqual([]);
  });

  it('takes every class of the school and none of its halves or teaching groups', () => {
    expect(ownersOf({ scope: 'SCHOOL', minGradeLevel: null, maxGradeLevel: null, groupIds: [] }, GROUPS).map((owner) => owner.id)).toEqual([
      '7A',
      '7B',
      '7C',
      '8A',
    ]);
  });
});

describe('what the cancellation takes with a named class', () => {
  it('takes its halves and the groups whose pupils all go in the named classes', () => {
    expect(expandNamedGroups(['7A'], GROUPS, HOMES).sort()).toEqual(['7A', '7A-1', '7A-2', 'SvA7']);
    // 7B named as well: the nivågrupp (7A, 7B, 7B) now lies inside, and the språkval still has a 7C pupil.
    expect(expandNamedGroups(['7A', '7B'], GROUPS, HOMES).sort()).toEqual(['7A', '7A-1', '7A-2', '7B', 'Nivå', 'SvA7']);
  });

  it('leaves a group with a pupil of another class, and names nothing it was not asked', () => {
    const taken = expandNamedGroups(['7A'], GROUPS, HOMES);
    expect(taken).not.toContain('Spanska');
    expect(taken).not.toContain('Blandad');
    // An empty group is not "all inside": it is nobody's.
    expect(taken).not.toContain('Tom');
    // A group with a member of no class can never be inside.
    expect(expandNamedGroups(['7A'], GROUPS, new Map([['SvA7', ['7A', 'none']]]))).not.toContain('SvA7');
  });

  it('does not widen a named teaching group, and does not take the halves of a class that is not named', () => {
    expect(expandNamedGroups(['Spanska'], GROUPS, HOMES)).toEqual(['Spanska']);
    expect(expandNamedGroups(['7B'], GROUPS, HOMES).sort()).toEqual(['7B']);
  });
});

const at = (iso: string) => new Date(iso);
const lesson = (id: string, date: string, from: string, to: string, pupils: string[]): PlanLesson => ({
  id,
  date,
  startsAt: at(`${date}T${from}:00.000Z`),
  endsAt: at(`${date}T${to}:00.000Z`),
  pupils: new Set(pupils),
});
const owner = (groupId: string, pupils: string[]): PlanOwner => ({ groupId, pupils: new Set(pupils) });

describe('the replacement lesson of a class and day', () => {
  const classA = owner('7A', ['a1', 'a2', 'a3']);
  const classB = owner('7B', ['b1', 'b2']);

  it('is one lesson from the first start to the last end of what it replaces', () => {
    const plan = planReplacements(
      [
        lesson('late', '2026-11-10', '13:00', '13:45', ['a1', 'a2']),
        lesson('early', '2026-11-10', '08:00', '08:45', ['a1', 'a2', 'a3']),
        lesson('mid', '2026-11-10', '10:15', '11:00', ['a3']),
      ],
      [classA],
    );
    expect(plan).toEqual([
      { groupId: '7A', date: '2026-11-10', startsAt: at('2026-11-10T08:00:00.000Z'), endsAt: at('2026-11-10T13:45:00.000Z'), lessonIds: ['early', 'late', 'mid'] },
    ]);
  });

  it('holds only the lessons whose roster has one of the class’s pupils', () => {
    const plan = planReplacements(
      [lesson('a', '2026-11-10', '08:00', '08:45', ['a1']), lesson('b', '2026-11-10', '09:00', '09:45', ['b1'])],
      [classA, classB],
    );
    expect(plan.map((entry) => [entry.groupId, entry.lessonIds])).toEqual([
      ['7A', ['a']],
      ['7B', ['b']],
    ]);
  });

  it('puts a lesson that holds pupils of two classes on both days (a språkval, a block)', () => {
    const plan = planReplacements(
      [lesson('spanska', '2026-11-10', '10:00', '10:45', ['a1', 'b1']), lesson('matte-a', '2026-11-10', '08:00', '08:45', ['a1', 'a2', 'a3'])],
      [classA, classB],
    );
    expect(plan).toEqual([
      { groupId: '7A', date: '2026-11-10', startsAt: at('2026-11-10T08:00:00.000Z'), endsAt: at('2026-11-10T10:45:00.000Z'), lessonIds: ['matte-a', 'spanska'] },
      { groupId: '7B', date: '2026-11-10', startsAt: at('2026-11-10T10:00:00.000Z'), endsAt: at('2026-11-10T10:45:00.000Z'), lessonIds: ['spanska'] },
    ]);
  });

  it('has no lesson on a day nothing was cancelled: a weekend, a lov, the other week of an A/B pair', () => {
    // Friday 2026-11-13 and Monday 2026-11-16: the weekend between has no row, and a Tuesday of the B week none either.
    const plan = planReplacements(
      [lesson('fri', '2026-11-13', '08:00', '08:45', ['a1']), lesson('mon', '2026-11-16', '08:00', '08:45', ['a1'])],
      [classA],
    );
    expect(plan.map((entry) => entry.date)).toEqual(['2026-11-13', '2026-11-16']);
    expect(planReplacements([], [classA])).toEqual([]);
  });

  it('keeps the instants of the lessons across the change to summer time', () => {
    // Friday 2027-03-26 is CET (08:00 = 07:00Z); Monday 2027-03-29 is CEST (08:00 = 06:00Z).
    const plan = planReplacements(
      [lesson('fri', '2027-03-26', '07:00', '07:45', ['a1']), lesson('mon', '2027-03-29', '06:00', '06:45', ['a1'])],
      [classA],
    );
    expect(plan.map((entry) => [entry.date, entry.startsAt.toISOString(), entry.endsAt.toISOString()])).toEqual([
      ['2027-03-26', '2027-03-26T07:00:00.000Z', '2027-03-26T07:45:00.000Z'],
      ['2027-03-29', '2027-03-29T06:00:00.000Z', '2027-03-29T06:45:00.000Z'],
    ]);
  });

  it('writes nothing for a day the class is off school (a lov entered after the activity), and keeps its other days', () => {
    const plan = planReplacements(
      [lesson('tue', '2026-11-10', '08:00', '08:45', ['a1']), lesson('wed', '2026-11-11', '08:00', '08:45', ['a1', 'b1'])],
      [{ ...classA, closed: new Set(['2026-11-11']) }, classB],
    );
    expect(plan.map((entry) => `${entry.date} ${entry.groupId}`)).toEqual(['2026-11-10 7A', '2026-11-11 7B']);
  });

  it('writes nothing for a class with nobody in it, and is in date then group order', () => {
    const plan = planReplacements(
      [lesson('x', '2026-11-11', '08:00', '08:45', ['a1', 'b1']), lesson('y', '2026-11-10', '08:00', '08:45', ['a1', 'b1'])],
      [classB, owner('7X', []), classA],
    );
    expect(plan.map((entry) => `${entry.date} ${entry.groupId}`)).toEqual(['2026-11-10 7A', '2026-11-10 7B', '2026-11-11 7A', '2026-11-11 7B']);
  });
});

describe('the pupils nothing replaces', () => {
  it('counts a pupil of a cancelled lesson that no class of the activity holds, once', () => {
    const lessons = [
      lesson('l1', '2026-11-10', '08:00', '08:45', ['a1', 'c1']),
      lesson('l2', '2026-11-10', '09:00', '09:45', ['c1', 'c2']),
    ];
    expect(uncoveredPupils(lessons, [owner('7A', ['a1'])])).toBe(2);
    expect(uncoveredPupils(lessons, [owner('7A', ['a1']), owner('7C', ['c1', 'c2'])])).toBe(0);
    expect(uncoveredPupils([], [owner('7A', ['a1'])])).toBe(0);
  });

  it('names them', () => {
    const lessons = [lesson('l1', '2026-11-10', '08:00', '08:45', ['a1', 'c1']), lesson('l2', '2026-11-10', '09:00', '09:45', ['c2'])];
    expect([...uncoveredPupilIds(lessons, [owner('7A', ['a1'])])].sort()).toEqual(['c1', 'c2']);
  });
});

describe('the days a class is off school', () => {
  const lov = (from: string, to: string, min: number | null = null, max: number | null = null) => ({
    startDate: at(`${from}T00:00:00.000Z`),
    endDate: at(`${to}T00:00:00.000Z`),
    minGradeLevel: min,
    maxGradeLevel: max,
  });

  it('is the days of the window a break covers, a lov that began before it included', () => {
    const closed = closedDaysOf([lov('2026-10-30', '2026-11-10')], 7, '2026-11-09', '2026-11-13');
    expect([...closed]).toEqual(['2026-11-09', '2026-11-10']);
  });

  it('reads a break for some years as the group’s årskurs: inside it, outside it, and a group with none', () => {
    const studiedag = [lov('2026-11-10', '2026-11-10', 7, 9)];
    expect(closedDaysOf(studiedag, 8, '2026-11-09', '2026-11-13').size).toBe(1);
    expect(closedDaysOf(studiedag, 6, '2026-11-09', '2026-11-13').size).toBe(0);
    // A group that cannot be shown to be inside the span keeps its lesson.
    expect(closedDaysOf(studiedag, null, '2026-11-09', '2026-11-13').size).toBe(0);
    expect(closedDaysOf([lov('2026-11-10', '2026-11-10')], null, '2026-11-09', '2026-11-13').size).toBe(1);
  });

  it('is empty without a break', () => {
    expect(closedDaysOf([], 7, '2026-11-09', '2026-11-13').size).toBe(0);
  });
});

describe('a responsible teacher busy with another class', () => {
  const plan = [
    { groupId: '7A', date: '2026-11-10', startsAt: at('2026-11-10T08:00:00.000Z'), endsAt: at('2026-11-10T10:00:00.000Z'), lessonIds: [] },
  ];
  const responsible = [{ studentGroupId: '7A', teacherId: 'bo' }];
  const busy = (teacherId: string, date: string, from: string, to: string) => ({
    teacherId,
    date,
    startsAt: at(`${date}T${from}:00.000Z`),
    endsAt: at(`${date}T${to}:00.000Z`),
    groupName: '7B',
  });

  it('is named when the lessons overlap, never when they only touch', () => {
    expect(teacherClashes(plan, responsible, [busy('bo', '2026-11-10', '09:30', '10:15')])).toEqual([
      { teacherId: 'bo', date: '2026-11-10', groupId: '7A', busyWith: '7B' },
    ]);
    expect(teacherClashes(plan, responsible, [busy('bo', '2026-11-10', '10:00', '10:45')])).toEqual([]);
    expect(teacherClashes(plan, responsible, [busy('bo', '2026-11-10', '07:15', '08:00')])).toEqual([]);
  });

  it('ignores another day, another teacher, and a teacher responsible for another class', () => {
    expect(teacherClashes(plan, responsible, [busy('bo', '2026-11-11', '09:00', '09:45')])).toEqual([]);
    expect(teacherClashes(plan, responsible, [busy('cy', '2026-11-10', '09:00', '09:45')])).toEqual([]);
    expect(teacherClashes(plan, [{ studentGroupId: '7B', teacherId: 'bo' }], [busy('bo', '2026-11-10', '09:00', '09:45')])).toEqual([]);
  });
});

describe('the words on the lessons', () => {
  it('puts the description after the name, and says "Inställd" on the cancelled ones', () => {
    expect(noteOf('Friluftsdag åk 7', null)).toBe('Friluftsdag åk 7');
    expect(noteOf('Friluftsdag åk 7', 'Samling vid skolgården')).toBe('Friluftsdag åk 7: Samling vid skolgården');
    expect(cancelledNoteOf('Friluftsdag åk 7')).toBe('Inställd: Friluftsdag åk 7');
  });
});
