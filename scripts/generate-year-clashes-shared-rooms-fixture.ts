/**
 * Appends (or rewrites) the Delade salar cases of
 * src/common/__fixtures__/year-clashes-cases.json from the gateway's
 * yearClashes, which web/lib/conflicts.ts replays through detectConflicts.
 *
 *   npx ts-node --transpile-only scripts/generate-year-clashes-shared-rooms-fixture.ts
 *
 * Every other case is left as it is, byte for byte. The cases are small
 * enough to read: the expectations printed into the JSON are checked by eye
 * against each case's name, and the rule itself is pinned independently by
 * src/common/__fixtures__/shared-rooms-cases.json.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { yearClashes, type YearClashInput } from '../src/common/year-clashes';

const file = path.join(__dirname, '../src/common/__fixtures__/year-clashes-cases.json');
const fixture = JSON.parse(readFileSync(file, 'utf8')) as { cases: { name: string }[] };

const lesson = (
  id: string,
  studentGroupId: string,
  teacherId: string,
  extra: { roomId?: string; startTime?: string; endTime?: string; recurrence?: 'ALL_WEEKS' | 'ODD_WEEKS' | 'EVEN_WEEKS' } = {},
) => ({
  id,
  subjectId: `s-${id}`,
  dayOfWeek: 1,
  startTime: extra.startTime ?? '08:00',
  endTime: extra.endTime ?? '09:00',
  teacherId,
  coTeacherId: null,
  roomId: extra.roomId ?? 'hall',
  studentGroupId,
  extraGroupIds: [] as string[],
  studentIds: [] as string[],
  recurrence: extra.recurrence ?? ('ALL_WEEKS' as const),
  startDate: null,
  endDate: null,
});

/** Two pupils in each of 7A, 7B and 7C; `seats` is what the hall holds, null a hall nobody shares. */
const school = (lessons: YearClashInput['lessons'], seats: number | null = 4): YearClashInput => ({
  lessons,
  constraints: [],
  studentGroupOf: [
    ['a1', '7a'],
    ['a2', '7a'],
    ['b1', '7b'],
    ['b2', '7b'],
    ['c1', '7c'],
    ['c2', '7c'],
  ],
  memberships: [],
  pupilBuffers: [],
  ...(seats === null ? {} : { sharedRooms: [{ roomId: 'hall', seats }] }),
});

const cases: { name: string; input: YearClashInput }[] = [
  {
    name: 'delade salar: two classes whose pupils fit the hall share it',
    input: school([lesson('a', '7a', 't1'), lesson('b', '7b', 't2')]),
  },
  {
    name: 'delade salar: two classes over the seats clash in the hall',
    input: school([lesson('a', '7a', 't1'), lesson('b', '7b', 't2')], 3),
  },
  {
    name: 'delade salar: a hall nobody has marked shared clashes as before',
    input: school([lesson('a', '7a', 't1'), lesson('b', '7b', 't2')], null),
  },
  {
    name: 'delade salar: three lessons whose pairs fit but not all three clash in pairs',
    input: school([lesson('a', '7a', 't1'), lesson('b', '7b', 't2'), lesson('c', '7c', 't3')]),
  },
  {
    name: 'delade salar: a long lesson beside two that follow each other fits the hall',
    input: school([
      lesson('long', '7a', 't1', { startTime: '08:00', endTime: '10:00' }),
      lesson('first', '7b', 't2', { startTime: '08:00', endTime: '09:00' }),
      lesson('second', '7c', 't3', { startTime: '09:00', endTime: '10:00' }),
    ]),
  },
  {
    name: 'delade salar: odd and even weeks add no pupils to each other',
    input: school([
      lesson('every', '7a', 't1', { recurrence: 'ALL_WEEKS' }),
      lesson('odd', '7b', 't2', { recurrence: 'ODD_WEEKS' }),
      lesson('even', '7c', 't3', { recurrence: 'EVEN_WEEKS' }),
    ]),
  },
  {
    name: 'delade salar: a class nobody knows keeps the hall exclusive',
    input: school([lesson('a', '7a', 't1'), lesson('x', '7x', 't2')], 1000),
  },
  {
    name: 'delade salar: the same teacher still clashes in a shared hall',
    input: school([lesson('a', '7a', 't1'), lesson('b', '7b', 't1')]),
  },
  {
    name: 'delade salar: the same class still clashes in a shared hall',
    input: school([lesson('a', '7a', 't1'), lesson('b', '7a', 't2')]),
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
