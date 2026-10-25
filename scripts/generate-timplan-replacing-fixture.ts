/*
 * Regenerates the planned and scheduled contract fixtures from the gateway,
 * first requiring every existing case to recompute byte-identically, then
 * appending the ersättande-grupper cases (replacing any earlier copy of them,
 * so it can be rerun).
 *
 *   npx ts-node --transpile-only scripts/generate-timplan-replacing-fixture.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { computePlannedCoverage, type PlannedCoverageInput } from '../src/common/timplan-planned';
import { computeScheduledCoverage, type ScheduledCoverageInput } from '../src/common/timplan-scheduled';

const ROOT = path.join(__dirname, '..');
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PREFIX = 'ersättande grupper:';

function regenerate<I>(file: string, compute: (input: I) => unknown, added: { name: string; input: I }[]) {
  const path = `${ROOT}/src/common/__fixtures__/${file}`;
  const before = fs.readFileSync(path, 'utf8');
  const { cases } = JSON.parse(before) as { cases: { name: string; input: I; coverage: unknown }[] };
  const kept = cases.filter((c) => !c.name.startsWith(PREFIX));
  for (const c of kept) {
    const again = JSON.stringify(compute(c.input));
    if (again !== JSON.stringify(c.coverage)) throw new Error(`${file}: "${c.name}" moved`);
  }
  const out = [...kept, ...added.map(({ name, input }) => ({ name, input, coverage: compute(input) }))];
  const text = JSON.stringify({ cases: out }, null, 1) + '\n';
  // Only additions: the kept cases' text is untouched.
  const keptText = JSON.stringify({ cases: kept }, null, 1) + '\n';
  if (cases.length === kept.length && keptText !== before) throw new Error(`${file}: kept cases do not reprint byte-identically`);
  fs.writeFileSync(path, text);
  console.log(`${file}: ${kept.length} kept, ${added.length} added`);
}

// ---------------------------------------------------------------------------
// Planned (P2)
// ---------------------------------------------------------------------------
const SUBJECTS = [
  { id: id(1), name: 'Matematik', nationalCode: 'MA', countsTowardTimplan: true },
  { id: id(2), name: 'Svenska', nationalCode: 'SV_SVA', countsTowardTimplan: true },
  { id: id(3), name: 'Svenska som andraspråk', nationalCode: 'SV_SVA', countsTowardTimplan: true },
];
const [MA, SV, SVA] = [id(1), id(2), id(3)];
const PLAN = id(1201);
const g7A = { id: id(1101), name: '7A', kind: 'CLASS' as const, gradeLevel: 7 };
const g7B = { id: id(1102), name: '7B', kind: 'CLASS' as const, gradeLevel: 7 };
const SvA7 = { id: id(1103), name: 'SvA7', kind: 'TEACHING_GROUP' as const, gradeLevel: null, replacesSubjectId: SV };
const Sv7n = { id: id(1104), name: 'Sv7 nivå', kind: 'TEACHING_GROUP' as const, gradeLevel: null };
const stod = { id: id(1105), name: 'SvA-stöd 7', kind: 'TEACHING_GROUP' as const, gradeLevel: null };
let serial = 1300;
const post = (groupId: string, subjectId: string, lessonsPerWeek: number, minutesPerLesson: number) => ({
  id: id(serial++),
  studentGroupId: groupId,
  subjectId,
  lessonsPerWeek,
  minutesPerLesson,
  recurrence: 'ALL_WEEKS' as const,
  startDate: null,
  endDate: null,
});
const pupil = (n: number, home: string, groupIds: string[]) => ({ id: id(n), homeGroupId: home, groupIds });

const plannedInput = (svaMinutes: number): PlannedCoverageInput => {
  serial = 1300;
  return {
    year: { startDate: '2026-08-17', endDate: '2027-06-11' },
    closures: [],
    plans: [
      {
        id: PLAN,
        name: 'Grundskolan 2024',
        status: 'DECIDED',
        entries: [
          { subjectId: MA, gradeLevel: 7, minutesPerWeek: 180 },
          { subjectId: SV, gradeLevel: 7, minutesPerWeek: 180 },
          { subjectId: SVA, gradeLevel: 7, minutesPerWeek: 180 },
        ],
      },
    ],
    attachments: [{ gradeLevel: 7, localTimplanId: PLAN }],
    subjects: SUBJECTS,
    groups: [g7A, g7B, SvA7, Sv7n, stod],
    requirements: [
      post(g7A.id, SV, 3, 60),
      post(g7A.id, MA, 3, 60),
      post(g7B.id, SV, 3, 60),
      post(g7B.id, MA, 3, 60),
      post(SvA7.id, SVA, 3, svaMinutes),
      post(Sv7n.id, SV, 1, 60),
      post(stod.id, SVA, 1, 60),
    ],
    pupils: [
      pupil(1401, g7A.id, []), // Alva: class Svenska only
      pupil(1402, g7A.id, [SvA7.id]), // Bo: SvA7 instead of 7A's Svenska
      pupil(1403, g7A.id, [SvA7.id, Sv7n.id]), // Cim: SvA7 takes him off the nivågrupp's Svenska too
      pupil(1404, g7A.id, [stod.id]), // Dag: the support model, SvA on top of class Svenska
      pupil(1405, g7A.id, [Sv7n.id]), // Eva: the nivågrupp on top of 7A's Svenska, double planned as before
      pupil(1406, g7B.id, [SvA7.id]), // Fia: SvA7 spans 7A and 7B
      pupil(1407, g7B.id, []), // Gus
    ],
    includePupils: true,
  };
};

regenerate('timplan-planned-cases.json', computePlannedCoverage, [
  {
    name: `${PREFIX} SvA7 replaces Svenska — its pupils in 7A and 7B are credited SvA7's SvA and none of their class's or a nivågrupp's Svenska, 180 of 180; an SvA support group that does not replace stays on top of class Svenska`,
    input: plannedInput(60),
  },
  {
    name: `${PREFIX} a replacing group planning less than the target leaves its pupils short of their own, listed with it as their only Svenska/SvA source`,
    input: plannedInput(50),
  },
]);

// ---------------------------------------------------------------------------
// Scheduled (layer 2)
// ---------------------------------------------------------------------------
const lesson = (
  n: number,
  groupId: string,
  subjectId: string,
  startTime: string,
  extra: { extraGroupIds?: string[]; studentIds?: string[] } = {},
) => ({
  id: id(n),
  studentGroupId: groupId,
  subjectId,
  startTime,
  endTime: `${String(Number(startTime.slice(0, 2)) + 1).padStart(2, '0')}:00:00`,
  recurrence: 'ALL_WEEKS' as const,
  startDate: null,
  endDate: null,
  isParked: false,
  extraGroupIds: extra.extraGroupIds ?? [],
  studentIds: extra.studentIds ?? [],
});
const ALVA = id(1501); // 7A and SvA7, named on one of 7A's Svenska lessons
const BO = id(1502); // 7A
const DAG = id(1503); // 7B and SvA7
const EVA = id(1504); // 7B
const scheduledInput = (drillGroupId?: string): ScheduledCoverageInput => {
  serial = 1600;
  return {
    year: { startDate: '2026-08-17', endDate: '2027-06-11' },
    subjects: SUBJECTS,
    closures: [],
    groups: [g7A, g7B, SvA7],
    requirements: [post(g7A.id, SV, 3, 60), post(g7B.id, SV, 3, 60), post(SvA7.id, SVA, 3, 60)],
    lessons: [
      lesson(1701, g7A.id, SV, '08:00:00'),
      lesson(1702, g7A.id, SV, '09:00:00'),
      lesson(1703, g7A.id, SV, '10:00:00', { studentIds: [ALVA] }),
      lesson(1704, SvA7.id, SVA, '08:00:00'),
      lesson(1705, SvA7.id, SVA, '09:00:00'),
      lesson(1706, SvA7.id, SVA, '10:00:00'),
      lesson(1707, g7B.id, SV, '08:00:00'),
      lesson(1708, g7B.id, SV, '09:00:00'),
      lesson(1709, g7B.id, SV, '13:00:00', { extraGroupIds: [SvA7.id] }),
    ],
    pupils: [
      { id: ALVA, homeGroupId: g7A.id, groupIds: [SvA7.id] },
      { id: BO, homeGroupId: g7A.id, groupIds: [] },
      { id: DAG, homeGroupId: g7B.id, groupIds: [SvA7.id] },
      { id: EVA, homeGroupId: g7B.id, groupIds: [] },
    ],
    includePupils: true,
    ...(drillGroupId ? { drillGroupId } : {}),
  };
};

/** 7A of five, three of them in SvA7; 7A plans 3 × 60 Svenska and schedules two. */
function majorityInput(): ScheduledCoverageInput {
  serial = 1800;
  return {
    year: { startDate: '2026-08-17', endDate: '2027-06-11' },
    subjects: SUBJECTS,
    closures: [],
    groups: [g7A, SvA7],
    requirements: [post(g7A.id, SV, 3, 60), post(SvA7.id, SVA, 3, 60)],
    lessons: [
      lesson(1901, g7A.id, SV, '08:00:00'),
      lesson(1902, g7A.id, SV, '09:00:00'),
      lesson(1903, SvA7.id, SVA, '08:00:00'),
      lesson(1904, SvA7.id, SVA, '09:00:00'),
      lesson(1905, SvA7.id, SVA, '10:00:00'),
    ],
    pupils: [
      { id: id(1951), homeGroupId: g7A.id, groupIds: [SvA7.id] },
      { id: id(1952), homeGroupId: g7A.id, groupIds: [SvA7.id] },
      { id: id(1953), homeGroupId: g7A.id, groupIds: [SvA7.id] },
      { id: id(1954), homeGroupId: g7A.id, groupIds: [] },
      { id: id(1955), homeGroupId: g7A.id, groupIds: [] },
    ],
    includePupils: true,
  };
}

regenerate('timplan-scheduled-cases.json', computeScheduledCoverage, [
  {
    name: `${PREFIX} SvA7 replaces Svenska — its pupils are planned and scheduled none of 7A's or 7B's Svenska, except a lesson naming one and 7B's lesson SvA7 attends as an extra group; group lines unchanged`,
    input: scheduledInput(),
  },
  {
    name: `${PREFIX} the same year drilled into SvA7: each member's lines and where their minutes come from`,
    input: scheduledInput(SvA7.id),
  },
  {
    name: `${PREFIX} most of 7A in SvA7 and 7A's Svenska a lesson short: the line's statistics are over the two pupils it reaches, not pulled to nothing by the three it does not`,
    input: majorityInput(),
  },
]);
