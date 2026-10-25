/**
 * Appends (or rewrites) the Ersättande grupper cases of
 * src/common/__fixtures__/year-clashes-cases.json from the gateway's
 * yearClashes, which web/lib/conflicts.ts replays through detectConflicts.
 *
 *   npx ts-node --transpile-only scripts/generate-year-clashes-replacing-fixture.ts
 *
 * Every other case is left as it is, byte for byte.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { yearClashes, type YearClashInput } from '../src/common/year-clashes';

const file = path.join(__dirname, '../src/common/__fixtures__/year-clashes-cases.json');
const fixture = JSON.parse(readFileSync(file, 'utf8')) as { cases: { name: string }[] };

const lesson = (
  id: string,
  studentGroupId: string,
  subjectId: string,
  teacherId: string,
  extra: { extraGroupIds?: string[]; studentIds?: string[] } = {},
) => ({
  id,
  subjectId,
  dayOfWeek: 1,
  startTime: '08:00',
  endTime: '09:00',
  teacherId,
  coTeacherId: null,
  roomId: null,
  studentGroupId,
  extraGroupIds: extra.extraGroupIds ?? [],
  studentIds: extra.studentIds ?? [],
  recurrence: 'ALL_WEEKS' as const,
  startDate: null,
  endDate: null,
});

/**
 * 7A (Alva, Bo) and 7B (Dag, Eva). SvA7 holds Alva and Dag and replaces
 * svenska; Ma7 holds Bo. Every lesson Monday 08:00, each with its own teacher,
 * so only pupils clash.
 */
const school = (lessons: YearClashInput['lessons'], replaces: string | null = 'sv'): YearClashInput => ({
  lessons,
  constraints: [],
  studentGroupOf: [
    ['alva', '7a'],
    ['bo', '7a'],
    ['dag', '7b'],
    ['eva', '7b'],
  ],
  memberships: [
    { studentId: 'alva', studentGroupId: 'sva7' },
    { studentId: 'dag', studentGroupId: 'sva7' },
    { studentId: 'bo', studentGroupId: 'ma7' },
  ],
  pupilBuffers: [],
  ...(replaces ? { replacing: [{ id: 'sva7', replacesSubjectId: replaces }] } : {}),
});

const cases: { name: string; input: YearClashInput }[] = [
  {
    name: 'ersättande grupper: SvA7 beside 7A’s svenska, which it replaces, is no clash',
    input: school([lesson('sv7a', '7a', 'sv', 't1'), lesson('sva', 'sva7', 'sva', 't2')]),
  },
  {
    name: 'ersättande grupper: SvA7 beside 7A’s matematik clashes as before',
    input: school([lesson('ma7a', '7a', 'ma', 't1'), lesson('sva', 'sva7', 'sva', 't2')]),
  },
  {
    name: 'ersättande grupper: SvA7 beside a svenska it is added to clashes, its pupils are on it',
    input: school([lesson('sv7b', '7b', 'sv', 't1', { extraGroupIds: ['sva7'] }), lesson('sva', 'sva7', 'sva', 't2')]),
  },
  {
    name: 'ersättande grupper: a SvA pupil named on 7A’s svenska keeps it beside SvA7 a clash',
    input: school([lesson('sv7a', '7a', 'sv', 't1', { studentIds: ['alva'] }), lesson('sva', 'sva7', 'sva', 't2')]),
  },
  {
    name: 'ersättande grupper: 7A’s svenska still clashes with Ma7 and with 7A’s own matematik',
    input: school([lesson('sv7a', '7a', 'sv', 't1'), lesson('ma', 'ma7', 'ma', 't2'), lesson('ma7a', '7a', 'ma', 't3')]),
  },
  {
    name: 'ersättande grupper: the same SvA7 replacing nothing clashes with 7A’s svenska, as before the phase',
    input: school([lesson('sv7a', '7a', 'sv', 't1'), lesson('sva', 'sva7', 'sva', 't2')], null),
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
