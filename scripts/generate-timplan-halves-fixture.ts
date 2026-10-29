/*
 * Appends the halvklass cases to the planned contract fixture, first
 * requiring every existing case to recompute byte-identically (replacing any
 * earlier copy of these, so it can be rerun).
 *
 *   npx ts-node --transpile-only scripts/generate-timplan-halves-fixture.ts
 *
 * What they pin: a pupil reading a subject from the home class and from one
 * of its halves is not double planned in the one shape Dela i halvklass
 * leaves when it swaps two subjects — hemkunskap swapped for slöjd takes the
 * class's hemkunskap off it and leaves its slöjd, and each half reads slöjd in
 * the period it does not read hemkunskap — and the line's sum is judged
 * against the target as always. Every neighbouring shape still is: the
 * class's post put back after a split (in turn or swapped), a half's dated
 * post with no swap beside it (short, nearly the whole year, or dated with
 * the year's own ends), a swap whose periods meet or whose slöjd is undated,
 * both halves at once, another class's half, two halves without the class, a
 * teaching group of the same shape or on top of the class, and two språkval
 * through a half.
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

const period = (startDate: string | null, endDate: string | null) => ({ startDate, endDate });

/**
 * The swap as Dela i halvklass writes it for `group`: its first half reads
 * hemkunskap in the autumn and slöjd in the spring, its second the other way
 * round, 1 × 70 each. The class's hemkunskap post is gone (the split replaced
 * it); whatever slöjd the class keeps is the caller's.
 */
const swapPosts = (first: PlannedGroup, second: PlannedGroup): PlannedRequirement[] => [
  post(first, S.HKK, 1, 70, AUTUMN),
  post(first, S.SL, 1, 70, SPRING),
  post(second, S.SL, 1, 70, AUTUMN),
  post(second, S.HKK, 1, 70, SPRING),
];

/**
 * 6A split, hemkunskap swapped with slöjd, 6A keeping its slöjd at `slojd`.
 * Both halves also read teknik all year, undated, which 6A has no post in:
 * a row of the half that meets every period is not the swap's other subject,
 * and does not stop the hemkunskap from being it. `putBack` adds 6A's
 * hemkunskap post again, as an admin might after the split.
 */
const swap = (slojd: { lessons: number; minutes: number }, putBack = false): PlannedCoverageInput => {
  reset();
  const c6A = theClass('6A');
  const [h1, h2] = halvesOf(c6A);
  return yearOf(
    [c6A, h1, h2],
    [
      post(c6A, S.SL, slojd.lessons, slojd.minutes),
      ...(putBack ? [post(c6A, S.HKK, 1, 30)] : []),
      ...swapPosts(h1, h2),
      post(h1, S.TK, 1, 60),
      post(h2, S.TK, 1, 60),
    ],
    [pupil(c6A, [h1]), pupil(c6A, [h2])],
  );
};

/**
 * One subject in turn (hemkunskap, the autumn's first and second half), and
 * 6A's hemkunskap post put back: Mål shows the class's hemkunskap unplanned
 * until its pupils are in the halves, and the post is how an admin answers
 * that red cell. Each pupil then reads hemkunskap twice.
 */
const inTurnPutBack = (): PlannedCoverageInput => {
  reset();
  const c6A = theClass('6A');
  const [h1, h2] = halvesOf(c6A);
  return yearOf(
    [c6A, h1, h2],
    [
      post(c6A, S.HKK, 1, 30),
      post(h1, S.HKK, 5, 30, period(null, '2026-10-25')),
      post(h2, S.HKK, 5, 30, period('2026-10-26', '2027-01-10')),
    ],
    [pupil(c6A, [h1]), pupil(c6A, [h2])],
  );
};

/** A half's dated post in the class's subject with no swap beside it, each class one shape. */
const datedWithoutSwap = (): PlannedCoverageInput => {
  reset();
  // Dated with the year's own first and last day, as the post's dialog stores them.
  const c6B = theClass('6B');
  const [b1] = halvesOf(c6B);
  // The whole year but its first week.
  const c6C = theClass('6C');
  const [c1] = halvesOf(c6C);
  // Matematik in the spring on top of 6D's.
  const c6D = theClass('6D');
  const [d1] = halvesOf(c6D);
  return yearOf(
    [c6B, b1, c6C, c1, c6D, d1],
    [
      post(c6B, S.SL, 2, 40),
      post(b1, S.SL, 1, 40, period('2026-08-17', '2027-06-11')),
      post(c6C, S.SL, 2, 40),
      post(c1, S.SL, 2, 40, period('2026-08-24', null)),
      post(c6D, S.MA, 3, 60),
      post(d1, S.MA, 1, 60, SPRING),
    ],
    [pupil(c6B, [b1]), pupil(c6C, [c1]), pupil(c6D, [d1])],
  );
};

/** A half with hemkunskap the class has none of, but not in a period of its own. */
const periodsThatMeet = (): PlannedCoverageInput => {
  reset();
  // 6E:1's slöjd is undated: a whole year, which meets its hemkunskap.
  const c6E = theClass('6E');
  const [e1] = halvesOf(c6E);
  // Hemkunskap inside the period the half reads slöjd: in the spring, and in the autumn.
  const c6F = theClass('6F');
  const [f1, f2] = halvesOf(c6F);
  // Hemkunskap to 11 January and slöjd from it: one day in common.
  const c6G = theClass('6G');
  const [g1] = halvesOf(c6G);
  return yearOf(
    [c6E, e1, c6F, f1, f2, c6G, g1],
    [
      post(c6E, S.SL, 2, 40),
      post(e1, S.SL, 1, 40),
      post(e1, S.HKK, 1, 70, AUTUMN),
      post(c6F, S.SL, 2, 25),
      post(f1, S.SL, 1, 70, SPRING),
      post(f1, S.HKK, 1, 70, period('2027-03-01', '2027-04-30')),
      post(f2, S.SL, 1, 70, AUTUMN),
      post(f2, S.HKK, 1, 70, period('2026-09-01', '2026-10-30')),
      post(c6G, S.SL, 2, 25),
      post(g1, S.HKK, 1, 70, period(null, '2027-01-11')),
      post(g1, S.SL, 1, 70, period('2027-01-11', null)),
    ],
    [pupil(c6E, [e1]), pupil(c6F, [f1]), pupil(c6F, [f2]), pupil(c6G, [g1])],
  );
};

/**
 * The swap's own shape, reached some other way. 6H is swapped as 6A is, and
 * one of its pupils is the swap; the rest are not.
 */
const swapShapeElsewhere = (): PlannedCoverageInput => {
  reset();
  const c6H = theClass('6H');
  const [h1, h2] = halvesOf(c6H);
  // A 6J pupil in 6H:1: another class's half.
  const c6J = theClass('6J');
  // 6K keeps no slöjd post; one pupil is in both its halves.
  const c6K = theClass('6K');
  const [k1, k2] = halvesOf(c6K);
  // A teaching group, not a half, with the swap's two posts.
  const c6L = theClass('6L');
  const group = teachingGroup('Hemkunskap och slöjd 6L');
  return yearOf(
    [c6H, h1, h2, c6J, c6K, k1, k2, c6L, group],
    [
      post(c6H, S.SL, 2, 25),
      ...swapPosts(h1, h2),
      post(c6J, S.SL, 2, 40),
      ...swapPosts(k1, k2),
      post(c6L, S.SL, 2, 25),
      post(group, S.HKK, 1, 70, AUTUMN),
      post(group, S.SL, 1, 70, SPRING),
    ],
    [
      pupil(c6H, [h1]), // the swap: not double planned
      pupil(c6H, [h1, h2]),
      pupil(c6J, [h1]),
      pupil(c6K, [k1, k2]),
      pupil(c6L, [group]),
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
 * The alternatives are judged as before: a half's dated Spanska and a
 * språkval group's Tyska are two alternatives, read one OR the other. 6M's
 * Svenska and its half's spring Svenska are no swap — the half's Spanska is
 * in the same spring — so they are double planned like any two groups.
 */
const alternatives = (): PlannedCoverageInput => {
  reset();
  const c6M = theClass('6M');
  const [m1, m2] = halvesOf(c6M);
  const tyska = teachingGroup('Tyska 6');
  return yearOf(
    [c6M, m1, m2, tyska],
    [
      post(c6M, S.SV, 3, 60),
      post(m1, S.SV, 1, 60, SPRING),
      post(m1, S.SPA, 2, 60, SPRING),
      post(m2, S.SPA, 2, 60, AUTUMN),
      post(tyska, S.TYS, 1, 40),
    ],
    [pupil(c6M, [m1, tyska]), pupil(c6M, [m1]), pupil(c6M, [m2])],
  );
};

const added = [
  {
    name: `${PREFIX} hemkunskap swapped with slöjd — 6A's slöjd 2 × 25 and each half's slöjd in the term it reads no hemkunskap, which 6A has no post in, are one planning, not double: 50 + 34 and 50 + 36, both on the target of 80`,
    input: swap({ lessons: 2, minutes: 25 }),
  },
  {
    name: `${PREFIX} the same swap with 6A's slöjd cut to 2 × 20 — the sum is the pupil's figure: 74 and 76 of 80, each pupil under on their own, from 6A and their half, and not double planned`,
    input: swap({ lessons: 2, minutes: 20 }),
  },
  {
    name: `${PREFIX} 6A's hemkunskap put back after the swap — each pupil is double planned in hemkunskap and in slöjd, since the half's hemkunskap is no longer a subject the class has none of`,
    input: swap({ lessons: 2, minutes: 25 }, true),
  },
  {
    name: `${PREFIX} 6A's hemkunskap put back after a split in turn — each pupil reads it from 6A all year and from their half for half the autumn, double planned at 65 and 68 of 30`,
    input: inTurnPutBack(),
  },
  {
    name: `${PREFIX} a half's dated post with no swap beside it is double planned — slöjd dated with the year's own ends, slöjd from the year's second week, matematik in the spring`,
    input: datedWithoutSwap(),
  },
  {
    name: `${PREFIX} a half's hemkunskap that meets its slöjd's period is no swap — an undated slöjd, hemkunskap inside the slöjd term (spring and autumn), and a day in common — all double planned`,
    input: periodsThatMeet(),
  },
  {
    name: `${PREFIX} the swap's shape reached some other way is double planned — both halves at once, another class's half, two halves without the class, a teaching group with the swap's posts — while 6H's pupil in one half is the swap`,
    input: swapShapeElsewhere(),
  },
  {
    name: `${PREFIX} a teaching group on top of the class's matematik is still double planned, all year or dated to the spring`,
    input: teachingGroupsStillDouble(),
  },
  {
    name: `${PREFIX} the alternatives as before — a half's dated Spanska with a Tyska group is two språkval, and the class's Svenska with its half's Svenska in the Spanska spring is no swap, double planned`,
    input: alternatives(),
  },
];

const out = [...kept, ...added.map(({ name, input }) => ({ name, input, coverage: computePlannedCoverage(input) }))];
fs.writeFileSync(FILE, JSON.stringify({ cases: out }, null, 1) + '\n');
console.log(`timplan-planned-cases.json: ${kept.length} kept, ${added.length} added`);
