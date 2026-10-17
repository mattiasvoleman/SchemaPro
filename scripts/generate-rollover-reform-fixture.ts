/**
 * Appends (or rewrites) the `reform` block of
 * src/common/__fixtures__/year-rollover-cases.json from the gateway's
 * resolveGroups and promoteName with the step into the tioårig numbering
 * (INTO_TIOARIG, SFS 2025:729 övergångsbestämmelse 4), which
 * web/lib/year-rollover.ts replays: the wizard names next year's groups with
 * the step the preview says.
 *
 *   npx ts-node --transpile-only scripts/generate-rollover-reform-fixture.ts
 *
 * The rest of the fixture is left as it is, byte for byte.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  INTO_TIOARIG,
  ONE_YEAR,
  nameCollisions,
  promoteName,
  resolveGroups,
  type GroupChoice,
  type RolloverGroupInput,
} from '../src/common/year-rollover';

const file = path.join(__dirname, '../src/common/__fixtures__/year-rollover-cases.json');
const fixture = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;

// An F–9 school in its last nine-year year, 2027/28.
const input: RolloverGroupInput[] = [
  { id: 'fa', name: 'FA', kind: 'CLASS', gradeLevel: 0, halfOfId: null },
  { id: 'fa1', name: 'FA:1', kind: 'TEACHING_GROUP', gradeLevel: 0, halfOfId: 'fa' },
  { id: 'fb', name: 'Fsk B', kind: 'CLASS', gradeLevel: 0, halfOfId: null },
  { id: '1a', name: '1A', kind: 'CLASS', gradeLevel: 1, halfOfId: null },
  { id: '7a', name: '7A', kind: 'CLASS', gradeLevel: 7, halfOfId: null },
  { id: '7a1', name: '7A:1', kind: 'TEACHING_GROUP', gradeLevel: 7, halfOfId: '7a' },
  { id: '8a', name: '8A', kind: 'CLASS', gradeLevel: 8, halfOfId: null },
  { id: '8b', name: '8B', kind: 'CLASS', gradeLevel: 8, halfOfId: null },
  { id: '9a', name: '9A', kind: 'CLASS', gradeLevel: 9, halfOfId: null },
  { id: 'ma7', name: 'Ma7 grupp 1', kind: 'TEACHING_GROUP', gradeLevel: 7, halfOfId: null },
  { id: 'ugg', name: 'Ugglan', kind: 'CLASS', gradeLevel: null, halfOfId: null },
];

const cases: { name: string; carryTeachingGroups: boolean; choices: Record<string, GroupChoice> }[] = [
  { name: 'every årskull two up, förskoleklassen to åk 2, the nians out', carryTeachingGroups: true, choices: {} },
  {
    name: 'the F class’s intake twin is the new åk 1, its half’s twin with it',
    carryTeachingGroups: false,
    choices: { fa: { outcome: 'INTAKE' } },
  },
  {
    name: 'a class carried moves one årskurs and is renamed; a förskoleklass cannot be carried',
    carryTeachingGroups: true,
    choices: { '7a': { outcome: 'CARRY' }, fb: { outcome: 'CARRY' } },
  },
  {
    name: 'a carried class is named for the årskurs it reaches: 8B carried is 9B, beside 7A typed as 9B',
    carryTeachingGroups: false,
    choices: { '8b': { outcome: 'CARRY' }, '7a': { name: '9B' } },
  },
];

const names: { name: string; gradeLevel: number; to: number }[] = [
  { name: '8A', gradeLevel: 8, to: 10 },
  { name: 'Klass 7B', gradeLevel: 7, to: 9 },
  { name: 'FA', gradeLevel: 0, to: 2 },
  { name: 'F-klass C', gradeLevel: 0, to: 1 },
  { name: 'Klass 1A', gradeLevel: 1, to: 3 },
];

// A förskoleklass whose half is not named after it: the half's intake twin
// keeps its own name in a year like any other, and takes the class twin's
// across the reform, where the twin moves up one.
const fInput: RolloverGroupInput[] = [
  { id: 'fsk', name: 'Fsk A', kind: 'CLASS', gradeLevel: 0, halfOfId: null },
  { id: 'fsk1', name: 'FA1', kind: 'TEACHING_GROUP', gradeLevel: 0, halfOfId: 'fsk' },
  { id: '1b', name: '1B', kind: 'CLASS', gradeLevel: 1, halfOfId: null },
];
const steps = { ONE_YEAR, INTO_TIOARIG };

fixture['reform'] = {
  step: INTO_TIOARIG,
  names: names.map((row) => ({ ...row, expected: promoteName(row.name, row.gradeLevel, row.to) })),
  input,
  cases: cases.map((c) => {
    const resolved = resolveGroups(
      input,
      9,
      { carryTeachingGroups: c.carryTeachingGroups },
      new Map(Object.entries(c.choices)),
      INTO_TIOARIG,
    );
    return { ...c, graduatingGradeLevel: 9, resolved, collisions: nameCollisions(resolved) };
  }),
  fHalves: {
    input: fInput,
    cases: (['ONE_YEAR', 'INTO_TIOARIG'] as const).map((step) => {
      const choices = { fsk: { outcome: 'INTAKE' as const } };
      const resolved = resolveGroups(fInput, 9, { carryTeachingGroups: false }, new Map(Object.entries(choices)), steps[step]);
      return { name: `an F class's intake, ${step}`, step, choices, graduatingGradeLevel: 9, resolved, collisions: nameCollisions(resolved) };
    }),
  },
};

writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
console.log('ok');
