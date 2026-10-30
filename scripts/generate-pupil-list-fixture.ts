/**
 * Writes src/common/__fixtures__/pupil-list-cases.json (Elevlistan i
 * uppföljningen) from the gateway's src/common/replacing-groups.ts
 * lessonPupils. The web's copy replays it (web/lib/pupil-list.contract.test.ts),
 * and so does every reader that lists or counts a lesson's pupils: SS12000 v1
 * and v2, the class book, the register's reported absences, the timetable's
 * "x/y" and the timplan's line statistics.
 *
 *   npx ts-node --transpile-only scripts/generate-pupil-list-fixture.ts
 *
 * One school, twice. 7A holds Alva, Bo, Cim, Dag and Eva; 7A:1 is a half of
 * 7A and holds Alva and Bo. SvA7 holds Alva and Eva and, in the first school,
 * replaces Svenska. Stöd7 (lässtöd i svenska) holds Bo and replaces nothing.
 * Last läsår's SvA6 replaced Svenska too (in the first school) and still holds
 * Dag, as the rollover keeps a membership: it takes Dag off nothing this year.
 * Sv7f (Svenska fördjupning, a teaching group and not a half) holds Eva: its
 * own svenska keeps her, SvA7 or not (keptBy). The second school is the first
 * with no group replacing anything, so every reader must answer it as main
 * did. Ids are UUIDs, so SS12000's schema check takes them as they are.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { keptByOf, lessonPupils, replacedSubjectOf, replacingBySubject, yearsOf } from '../src/common/replacing-groups';

const id = (tail: string) => `e1e00000-0000-4000-8000-${tail.padStart(12, '0')}`;
const YEAR = id('1');
const PAST_YEAR = id('0');
const SV = id('5e0');
const SVA = id('5e1');
const MA = id('3a0');
const ALVA = id('a1');
const BO = id('b0');
const CIM = id('c1');
const C7A = id('a7');
const HALF = id('a71');
const SVA7 = id('5a7');
const STOD7 = id('5d7');
const SVA6 = id('5a6');
const SV7F = id('5f7');
const DAG = id('d4');
const EVA = id('e5');

const subjects = [
  { id: SV, name: 'Svenska', nationalCode: 'SV' },
  { id: SVA, name: 'Svenska som andraspråk', nationalCode: 'SVA' },
  { id: MA, name: 'Matematik', nationalCode: 'MA' },
];
const pupils = [
  { id: ALVA, name: 'Alva', homeGroupId: C7A, groupIds: [HALF, SVA7] },
  { id: BO, name: 'Bo', homeGroupId: C7A, groupIds: [HALF, STOD7] },
  { id: CIM, name: 'Cim', homeGroupId: C7A, groupIds: [] as string[] },
  { id: DAG, name: 'Dag', homeGroupId: C7A, groupIds: [SVA6] },
  { id: EVA, name: 'Eva', homeGroupId: C7A, groupIds: [SVA7, SV7F] },
];
/** Lessons: subject, groups (own first), named pupils. */
const lessons = [
  { id: id('1001'), name: '7A:s svenska', subjectId: SV, groupIds: [C7A], named: [] as string[] },
  { id: id('1002'), name: '7A:s svenska, Alva namngiven', subjectId: SV, groupIds: [C7A], named: [ALVA] },
  { id: id('1003'), name: '7A:s svenska med SvA7 tillagd', subjectId: SV, groupIds: [C7A, SVA7], named: [] },
  { id: id('1004'), name: 'halvans svenska', subjectId: SV, groupIds: [HALF], named: [] },
  { id: id('1005'), name: 'SvA7:s svenska som andraspråk', subjectId: SVA, groupIds: [SVA7], named: [] },
  { id: id('1006'), name: 'Stöd7:s svenska', subjectId: SV, groupIds: [STOD7], named: [] },
  { id: id('1007'), name: '7A:s matematik', subjectId: MA, groupIds: [C7A], named: [] },
  { id: id('1008'), name: 'Sv7f:s svenska', subjectId: SV, groupIds: [SV7F], named: [] },
];

function school(name: string, replaces: boolean, cases: Record<string, string>) {
  const groups = [
    { id: C7A, name: '7A', kind: 'CLASS', gradeLevel: 7, halfOfId: null, replacesSubjectId: null, academicYearId: YEAR },
    { id: HALF, name: '7A:1', kind: 'TEACHING_GROUP', gradeLevel: 7, halfOfId: C7A, replacesSubjectId: null, academicYearId: YEAR },
    { id: SVA7, name: 'SvA7', kind: 'TEACHING_GROUP', gradeLevel: 7, halfOfId: null, replacesSubjectId: replaces ? SV : null, academicYearId: YEAR },
    { id: STOD7, name: 'Stöd7', kind: 'TEACHING_GROUP', gradeLevel: 7, halfOfId: null, replacesSubjectId: null, academicYearId: YEAR },
    { id: SV7F, name: 'Sv7f', kind: 'TEACHING_GROUP', gradeLevel: 7, halfOfId: null, replacesSubjectId: null, academicYearId: YEAR },
    { id: SVA6, name: 'SvA6', kind: 'TEACHING_GROUP', gradeLevel: 6, halfOfId: null, replacesSubjectId: replaces ? SV : null, academicYearId: PAST_YEAR },
  ];
  const membersOf = new Map<string, Set<string>>();
  for (const pupil of pupils) {
    for (const groupId of [pupil.homeGroupId, ...pupil.groupIds]) membersOf.set(groupId, (membersOf.get(groupId) ?? new Set()).add(pupil.id));
  }
  const byId = new Map(groups.map((group) => [group.id, group]));
  const bySubject = replacingBySubject(replacedSubjectOf(groups));
  const yearOf = yearsOf(groups);
  const expected = Object.fromEntries(
    lessons.map((lesson) => {
      const keptBy = keptByOf(byId.get(lesson.groupIds[0]!));
      const scope = { ...lesson, academicYearId: YEAR, ...(keptBy ? { keptBy } : {}) };
      return [lesson.id, lessonPupils(scope, membersOf, bySubject, yearOf)];
    }),
  );
  return { name, groups, cases, expected };
}

const fixture = {
  note: 'Generated by scripts/generate-pupil-list-fixture.ts from src/common/replacing-groups.ts (lessonPupils); never edit by hand.',
  academicYearId: YEAR,
  pastAcademicYearId: PAST_YEAR,
  subjects,
  pupils,
  lessons,
  schools: [
    school('med SvA7, som ersätter svenska', true, {
      [ALVA]: 'i SvA7, som ersätter svenska: inte på 7A:s svenska eller halvans, men kvar där hon namnges eller där SvA7 är tillagd',
      [BO]: 'i Stöd7, som inte ersätter något: kvar på 7A:s svenska, halvans och Stöd7:s',
      [CIM]: 'bara i 7A: på 7A:s lektioner',
      [DAG]: 'i fjolårets SvA6, som ersatte svenska då: kvar på årets svenska (läsåret)',
      [EVA]: 'i SvA7 och i Sv7f: inte på 7A:s svenska, men kvar på Sv7f:s egen (keptBy)',
    }),
    school('utan ersättande grupp', false, {
      [ALVA]: 'SvA7 ersätter inget: på varje lektion hennes grupper har, som på main',
      [BO]: 'som i den första skolan',
      [CIM]: 'som i den första skolan',
      [DAG]: 'som i den första skolan',
      [EVA]: 'SvA7 ersätter inget: på 7A:s svenska och Sv7f:s, som på main',
    }),
  ],
};
writeFileSync(path.join(__dirname, '../src/common/__fixtures__/pupil-list-cases.json'), `${JSON.stringify(fixture, null, 2)}\n`);
