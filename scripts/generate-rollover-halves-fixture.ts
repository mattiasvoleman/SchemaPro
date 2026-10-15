/**
 * Appends (or rewrites) the `halves` block of
 * src/common/__fixtures__/year-rollover-cases.json from the gateway's
 * resolveGroups, which web/lib/year-rollover.ts replays (Halvklasser).
 *
 *   npx ts-node --transpile-only scripts/generate-rollover-halves-fixture.ts
 *
 * The rest of the fixture is left as it is, byte for byte.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { nameCollisions, resolveGroups, type GroupChoice, type RolloverGroupInput } from '../src/common/year-rollover';

const file = path.join(__dirname, '../src/common/__fixtures__/year-rollover-cases.json');
const fixture = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;

const input: RolloverGroupInput[] = [
  { id: '7a', name: '7A', kind: 'CLASS', gradeLevel: 7, halfOfId: null },
  { id: '7a1', name: '7A:1', kind: 'TEACHING_GROUP', gradeLevel: 7, halfOfId: '7a' },
  { id: '7a2', name: '7A:2', kind: 'TEACHING_GROUP', gradeLevel: 7, halfOfId: '7a' },
  { id: '8b', name: '8B', kind: 'CLASS', gradeLevel: 8, halfOfId: null },
  { id: '8bs', name: 'Slöjd 8B grupp 1', kind: 'TEACHING_GROUP', gradeLevel: 8, halfOfId: '8b' },
  { id: '9a', name: '9A', kind: 'CLASS', gradeLevel: 9, halfOfId: null },
  { id: '9a1', name: '9A:1', kind: 'TEACHING_GROUP', gradeLevel: 9, halfOfId: '9a' },
  { id: 'ma7', name: 'Ma7 grupp 1', kind: 'TEACHING_GROUP', gradeLevel: 7, halfOfId: null },
];

const cases: { name: string; carryTeachingGroups: boolean; choices: Record<string, GroupChoice> }[] = [
  { name: 'halves follow their class, teaching groups not carried', carryTeachingGroups: false, choices: {} },
  { name: 'halves follow their class, teaching groups carried', carryTeachingGroups: true, choices: {} },
  {
    name: 'an intake class gives its halves twins; a half dropped, one renamed, other choices on a half ignored',
    carryTeachingGroups: false,
    choices: {
      '7a': { outcome: 'INTAKE' },
      '7a2': { outcome: 'SKIP' },
      '8bs': { name: 'Slöjd 9B grupp A' },
      '9a1': { outcome: 'PROMOTE' },
    },
  },
  { name: 'a class skipped takes its halves with it', carryTeachingGroups: true, choices: { '7a': { outcome: 'SKIP' } } },
];

fixture['halves'] = {
  input,
  cases: cases.map((c) => {
    const resolved = resolveGroups(input, 9, { carryTeachingGroups: c.carryTeachingGroups }, new Map(Object.entries(c.choices)));
    return { ...c, graduatingGradeLevel: 9, resolved, collisions: nameCollisions(resolved) };
  }),
};

writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
console.log('ok');
