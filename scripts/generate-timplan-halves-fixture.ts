/*
 * Appends the halvklass cases to the planned contract fixture, first
 * requiring every existing case to recompute byte-identically (replacing any
 * earlier copy of these, so it can be rerun).
 *
 *   npx ts-node --transpile-only scripts/generate-timplan-halves-fixture.ts
 *
 * What they pin: a pupil reading a subject from the home class and from one
 * of its halves, whose rows in it are all dated, is not double planned — Dela
 * i halvklass swapping hemkunskap for slöjd leaves the class's slöjd, and
 * each half reads slöjd in its other term — and the line's sum is judged
 * against the target as always. Every neighbouring case still is: a half's
 * undated row, another class's half, both halves at once, a teaching group
 * on top of the class (dated or not), and two språkval through a half.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  computePlannedCoverage,
  type PlannedCoverageInput,
  type PlannedGroup,
  type PlannedRequirement,
} from '../src/common/timplan-planned';

const FILE = path.join(__dirname, '..', 'src/common/__fixtures__/timplan-planned-cases.json');
const PREFIX = 'halvklass:';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const before = fs.readFileSync(FILE, 'utf8');
const { cases } = JSON.parse(before) as {
  cases: { name: string; input: PlannedCoverageInput; coverage: unknown }[];
};
const kept = cases.filter((c) => !c.name.startsWith(PREFIX));
for (const c of kept) {
  if (JSON.stringify(computePlannedCoverage(c.input)) !== JSON.stringify(c.coverage)) {
    throw new Error(`"${c.name}" moved`);
  }
}
if (cases.length === kept.length && JSON.stringify({ cases: kept }, null, 1) + '\n' !== before) {
  throw new Error('kept cases do not reprint byte-identically');
}

// 2026/27 without lov: 43 teaching weeks, 21 in the autumn (to 10 January)
// and 22 in the spring. A dated row weighs its share, so 1 × 70 is
// 70 × 21 / 43 = 34 in the autumn and 70 × 22 / 43 = 36 in the spring.
const YEAR = { startDate: '2026-08-17', endDate: '2027-06-11' };
// As term-halves.service.ts periodsOf stores them: the year's own ends null.
const AUTUMN = { startDate: null, endDate: '2027-01-10' };
const SPRING = { startDate: '2027-01-11', endDate: null };
const ALL_YEAR = { startDate: null, endDate: null };

const S = {
  SL: id(2001),
  HKK: id(2002),
  TK: id(2003),
  MA: id(2004),
  SV: id(2005),
  SPA: id(2006),
  TYS: id(2007),
};
const SUBJECTS = [
  { id: S.SL, name: 'Slöjd', nationalCode: 'SL', countsTowardTimplan: true },
  { id: S.HKK, name: 'Hem- och konsumentkunskap', nationalCode: 'HKK', countsTowardTimplan: true },
  { id: S.TK, name: 'Teknik', nationalCode: 'TK', countsTowardTimplan: true },
  { id: S.MA, name: 'Matematik', nationalCode: 'MA', countsTowardTimplan: true },
  { id: S.SV, name: 'Svenska', nationalCode: 'SV_SVA', countsTowardTimplan: true },
  { id: S.SPA, name: 'Spanska', nationalCode: 'M2', countsTowardTimplan: true },
  { id: S.TYS, name: 'Tyska', nationalCode: 'M2', countsTowardTimplan: true },
];
const PLAN = id(2101);
const PLANS = [
  {
    id: PLAN,
    name: 'Grundskolan 2024',
    status: 'DECIDED' as const,
    entries: [
      { subjectId: S.SL, gradeLevel: 6, minutesPerWeek: 80 },
      { subjectId: S.HKK, gradeLevel: 6, minutesPerWeek: 30 },
      { subjectId: S.TK, gradeLevel: 6, minutesPerWeek: 60 },
      { subjectId: S.MA, gradeLevel: 6, minutesPerWeek: 180 },
      { subjectId: S.SV, gradeLevel: 6, minutesPerWeek: 180 },
      { subjectId: S.SPA, gradeLevel: 6, minutesPerWeek: 30 },
      { subjectId: S.TYS, gradeLevel: 6, minutesPerWeek: 30 },
    ],
  },
];

let groupSerial = 2200;
const theClass = (name: string): PlannedGroup => ({ id: id(groupSerial++), name, kind: 'CLASS', gradeLevel: 6 });
const halvesOf = (group: PlannedGroup): [PlannedGroup, PlannedGroup] =>
  [1, 2].map((n) => ({
    id: id(groupSerial++),
    name: `${group.name}:${n}`,
    kind: 'TEACHING_GROUP' as const,
    gradeLevel: 6,
    halfOfId: group.id,
  })) as [PlannedGroup, PlannedGroup];
const teachingGroup = (name: string): PlannedGroup => ({ id: id(groupSerial++), name, kind: 'TEACHING_GROUP', gradeLevel: null });

let rowSerial = 2400;
const post = (
  group: PlannedGroup,
  subjectId: string,
  lessonsPerWeek: number,
  minutesPerLesson: number,
  period: { startDate: string | null; endDate: string | null } = ALL_YEAR,
): PlannedRequirement => ({
  id: id(rowSerial++),
  studentGroupId: group.id,
  subjectId,
  lessonsPerWeek,
  minutesPerLesson,
  recurrence: 'ALL_WEEKS',
  ...period,
});
let pupilSerial = 2600;
const pupil = (home: PlannedGroup, groups: PlannedGroup[]) => ({
  id: id(pupilSerial++),
  homeGroupId: home.id,
  groupIds: groups.map((group) => group.id),
});

// The plan and the subjects a case plans, and nothing else: an unplanned
// line in every class would bury the pupil verdicts the case is about.
const yearOf = (groups: PlannedGroup[], requirements: PlannedRequirement[], pupils: ReturnType<typeof pupil>[]): PlannedCoverageInput => {
  const used = new Set(requirements.map((row) => row.subjectId));
  return {
    year: YEAR,
    closures: [],
    plans: PLANS.map((plan) => ({ ...plan, entries: plan.entries.filter((entry) => used.has(entry.subjectId)) })),
    attachments: [{ gradeLevel: 6, localTimplanId: PLAN }],
    subjects: SUBJECTS.filter((subject) => used.has(subject.id)),
    groups,
    requirements,
    pupils,
    includePupils: true,
  };
};
const reset = () => {
  groupSerial = 2200;
  rowSerial = 2400;
  pupilSerial = 2600;
};

/**
 * 6A split, hemkunskap swapped with slöjd: 6A:1 reads hemkunskap in the
 * autumn and slöjd in the spring, 6A:2 the other way round, 1 × 70 each.
 * 6A keeps its slöjd post at `slojd`, and has no hemkunskap post (the split
 * replaced it). Both halves also read teknik all year, undated: a half's
 * undated row in ANOTHER subject does not make its slöjd a second planning.
 */
const swap = (slojd: { lessons: number; minutes: number }): PlannedCoverageInput => {
  reset();
  const c6A = theClass('6A');
  const [h1, h2] = halvesOf(c6A);
  return yearOf(
    [c6A, h1, h2],
    [
      post(c6A, S.SL, slojd.lessons, slojd.minutes),
      post(h1, S.HKK, 1, 70, AUTUMN),
      post(h1, S.SL, 1, 70, SPRING),
      post(h2, S.SL, 1, 70, AUTUMN),
      post(h2, S.HKK, 1, 70, SPRING),
      post(h1, S.TK, 1, 60),
      post(h2, S.TK, 1, 60),
    ],
    [pupil(c6A, [h1]), pupil(c6A, [h2])],
  );
};

/** The halves' neighbours, each a class of its own so no case leans on another. */
const halvesStillDouble = (): PlannedCoverageInput => {
  reset();
  // 6B:1 reads slöjd all year on top of 6B's: two plannings.
  const c6B = theClass('6B');
  const [b1] = halvesOf(c6B);
  // 6C:1 has a spring slöjd post and an undated one beside it.
  const c6C = theClass('6C');
  const [c1] = halvesOf(c6C);
  // 6D's halves swap as 6A's do; one pupil is placed in both.
  const c6D = theClass('6D');
  const [d1, d2] = halvesOf(c6D);
  // A 6E pupil in 6D:1: another class's half.
  const c6E = theClass('6E');
  // 6F has no slöjd post of its own; one pupil is in both its halves.
  const c6F = theClass('6F');
  const [f1, f2] = halvesOf(c6F);
  return yearOf(
    [c6B, b1, c6C, c1, c6D, d1, d2, c6E, c6F, f1, f2],
    [
      post(c6B, S.SL, 2, 40),
      post(b1, S.SL, 1, 40),
      post(c6C, S.SL, 2, 40),
      post(c1, S.SL, 1, 70, SPRING),
      post(c1, S.SL, 1, 20),
      post(c6D, S.SL, 2, 25),
      post(d1, S.SL, 1, 70, SPRING),
      post(d2, S.SL, 1, 70, AUTUMN),
      post(c6E, S.SL, 2, 40),
      post(f1, S.SL, 1, 70, SPRING),
      post(f2, S.SL, 1, 70, AUTUMN),
    ],
    [
      pupil(c6B, [b1]),
      pupil(c6C, [c1]),
      pupil(c6D, [d1, d2]),
      pupil(c6D, [d1]), // the swap as 6A's: not double planned
      pupil(c6E, [d1]),
      pupil(c6F, [f1, f2]),
    ],
  );
};

/** A teaching group on top of the class's own post, undated or dated, is not a half. */
const teachingGroupsStillDouble = (): PlannedCoverageInput => {
  reset();
  const c6A = theClass('6A');
  const fordjupning = teachingGroup('Ma-fördjupning 6');
  const varterminen = teachingGroup('Ma 6 VT');
  return yearOf(
    [c6A, fordjupning, varterminen],
    [post(c6A, S.MA, 3, 60), post(fordjupning, S.MA, 1, 40), post(varterminen, S.MA, 1, 60, SPRING)],
    [pupil(c6A, [fordjupning]), pupil(c6A, [varterminen]), pupil(c6A, [])],
  );
};

/**
 * The alternatives are judged as before. 6G's Svenska and its half's dated
 * Svenska are one planning, as for any subject; a half's dated Spanska and
 * a språkval group's Tyska are two alternatives, read one OR the other.
 */
const alternatives = (): PlannedCoverageInput => {
  reset();
  const c6G = theClass('6G');
  const [g1, g2] = halvesOf(c6G);
  const tyska = teachingGroup('Tyska 6');
  return yearOf(
    [c6G, g1, g2, tyska],
    [
      post(c6G, S.SV, 3, 60),
      post(g1, S.SV, 1, 60, SPRING),
      post(g1, S.SPA, 2, 60, SPRING),
      post(g2, S.SPA, 2, 60, AUTUMN),
      post(tyska, S.TYS, 1, 40),
    ],
    [pupil(c6G, [g1, tyska]), pupil(c6G, [g1]), pupil(c6G, [g2])],
  );
};

const added = [
  {
    name: `${PREFIX} hemkunskap swapped with slöjd — 6A's slöjd 2 × 25 and each half's slöjd in its other term are one planning, not double: 50 + 34 and 50 + 36, both on the target of 80`,
    input: swap({ lessons: 2, minutes: 25 }),
  },
  {
    name: `${PREFIX} the same swap with 6A's slöjd cut to 2 × 20 — the sum is the pupil's figure: 74 and 76 of 80, each pupil under on their own, from 6A and their half, and not double planned`,
    input: swap({ lessons: 2, minutes: 20 }),
  },
  {
    name: `${PREFIX} still double planned beside the swap — a half's undated slöjd, a half with an undated slöjd beside its dated one, a pupil in both halves, another class's half, and two halves without the class`,
    input: halvesStillDouble(),
  },
  {
    name: `${PREFIX} a teaching group on top of the class's matematik is still double planned, all year or dated to the spring`,
    input: teachingGroupsStillDouble(),
  },
  {
    name: `${PREFIX} the alternatives as before — the class's Svenska and its half's dated Svenska are one planning, and a half's dated Spanska with a Tyska group is two språkval`,
    input: alternatives(),
  },
];

const out = [...kept, ...added.map(({ name, input }) => ({ name, input, coverage: computePlannedCoverage(input) }))];
fs.writeFileSync(FILE, JSON.stringify({ cases: out }, null, 1) + '\n');
console.log(`timplan-planned-cases.json: ${kept.length} kept, ${added.length} added`);
