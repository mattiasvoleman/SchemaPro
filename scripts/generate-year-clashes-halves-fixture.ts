/**
 * Appends (or rewrites) the Halvklasser cases of
 * src/common/__fixtures__/year-clashes-cases.json from the gateway's
 * yearClashes, which web/lib/conflicts.ts replays through detectConflicts.
 *
 *   npx ts-node --transpile-only scripts/generate-year-clashes-halves-fixture.ts
 *
 * Every other case is left as it is, byte for byte.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { yearClashes, type YearClashInput } from '../src/common/year-clashes';

const file = path.join(__dirname, '../src/common/__fixtures__/year-clashes-cases.json');
const fixture = JSON.parse(readFileSync(file, 'utf8')) as { cases: { name: string }[] };

const lesson = (id: string, studentGroupId: string, startTime: string, endTime: string, teacherId: string) => ({
  id,
  subjectId: `s-${id}`,
  dayOfWeek: 1,
  startTime,
  endTime,
  teacherId,
  coTeacherId: null,
  roomId: null,
  studentGroupId,
  extraGroupIds: [],
  studentIds: [],
  recurrence: 'ALL_WEEKS' as const,
  startDate: null,
  endDate: null,
});

/**
 * 7A (Alva, Bo) split in 7A:1 and 7A:2; Ma7 holds Alva. Monday: 7A:1's
 * slöjd and 7A:2's NO at 08:00, 7A's svenska and Ma7 at 08:30, 7B's
 * engelska at 08:00 — every lesson with its own teacher, so only pupils clash.
 */
const school = (memberships: YearClashInput['memberships']): YearClashInput => ({
  lessons: [
    lesson('slojd', '7a1', '08:00', '09:00', 't1'),
    lesson('no', '7a2', '08:00', '09:00', 't2'),
    lesson('svenska', '7a', '08:30', '09:30', 't3'),
    lesson('ma', 'ma7', '08:30', '09:30', 't4'),
    lesson('engelska', '7b', '08:00', '09:00', 't5'),
  ],
  constraints: [],
  studentGroupOf: [
    ['alva', '7a'],
    ['bo', '7a'],
    ['eva', '7b'],
  ],
  memberships: [{ studentId: 'alva', studentGroupId: 'ma7' }, ...memberships],
  pupilBuffers: [],
  halves: [
    { id: '7a1', halfOfId: '7a' },
    { id: '7a2', halfOfId: '7a' },
  ],
});

/**
 * Erik left 7A in no half; every active pupil is in 7A:1. Every reader takes
 * home rows of active STUDENTs only, so Erik has none, though his Tyska row
 * may still stand (the board's memberships carry it). Tyska at 08:00 beside
 * 7A:2's NO.
 */
const withLeaver = (erikAtHome: boolean): YearClashInput => {
  const base = school([
    { studentId: 'alva', studentGroupId: '7a1' },
    { studentId: 'bo', studentGroupId: '7a1' },
    { studentId: 'erik', studentGroupId: 'ty7' },
  ]);
  return {
    ...base,
    lessons: [...base.lessons, lesson('tyska', 'ty7', '08:00', '09:00', 't6')],
    studentGroupOf: erikAtHome ? [...base.studentGroupOf, ['erik', '7a']] : base.studentGroupOf,
  };
};

const cases: { name: string; input: YearClashInput }[] = [
  {
    name: 'a pupil who left a split class in no half has no home row, so no half answers for him: Tyska runs beside 7A:2',
    input: withLeaver(false),
  },
  {
    name: 'the same pupil still in the class and in no half: Tyska clashes with both halves',
    input: withLeaver(true),
  },
  {
    name: 'a class’s halves before placement: the class and its groups clash with both, the halves never with each other',
    input: school([]),
  },
  {
    name: 'a class’s halves once its pupils are placed: a group clashes only with the half its pupils are in',
    input: school([
      { studentId: 'alva', studentGroupId: '7a1' },
      { studentId: 'bo', studentGroupId: '7a2' },
    ]),
  },
];

const names = new Set(cases.map((c) => c.name));
fixture.cases = [
  ...fixture.cases.filter((c) => !names.has(c.name)),
  ...cases.map((c) => ({
    name: c.name,
    input: c.input,
    clashes: Object.fromEntries([...yearClashes(c.input).entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
  })),
];

writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
console.log('ok');
