/*
 * Appends the national-line cases to the planned contract fixture, first
 * requiring every existing case to recompute byte-identically (replacing any
 * earlier copy of these, so it can be rerun).
 *
 *   npx ts-node --transpile-only scripts/generate-timplan-national-fixture.ts
 *
 * What they pin: counted subjects that share a national code which is no
 * alternative (SL on Slöjd, Textilslöjd and Trä- och metallslöjd) are ONE
 * line, 'national:SL', and the parts are read together — the line's target is
 * the SUM of the plan's entries over them, what is planned is the sum of their
 * rows. The shapes are the ones the school of the report plans (#170, #215,
 * #218): half 1 on textilslöjd until 2027-01-03 and trä- och metallslöjd from
 * 2027-01-04, half 2 the other way round, at the class's rate (åk 4); åk 7
 * swapping hemkunskap with trä- och metallslöjd per term, in the halves only
 * and with the class keeping a post of its own in the part (the swap's four
 * conditions are per subject, and a part of a line is still a subject); åk 8
 * with textilslöjd 2 × 65 one term per half. Neighbouring shapes stay as they
 * were: the same part from two groups is double planned, a plan with an entry
 * on each part is one line of their sum, a subject no other counted subject
 * shares the code with keeps its own line (a subject that does not count
 * toward the timplan does not share it).
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
const PREFIX = 'national:';
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

// The school year of the report, without lov: 43 teaching weeks, 20 to 3 January
// (weeks 34 to 53) and 23 from 4 January. A dated row weighs its share, so 1 × 60
// is 60 × 20 / 43 = 28 in the autumn and 60 × 23 / 43 = 32 in the spring, and
// 28 + 32 is the 60 a pupil reading both parts gets.
const YEAR = { startDate: '2026-08-18', endDate: '2027-06-10' };
// As term-halves.service.ts periodsOf stores them: the year's own ends null.
const AUTUMN = { startDate: null, endDate: '2027-01-03' };
const SPRING = { startDate: '2027-01-04', endDate: null };
const ALL_YEAR = { startDate: null, endDate: null };

const S = {
  SL: id(3001),
  TX: id(3002),
  TM: id(3003),
  HKK: id(3004),
  SLV: id(3005),
};
const SLOJD = { id: S.SL, name: 'Slöjd', nationalCode: 'SL', countsTowardTimplan: true };
const TEXTIL = { id: S.TX, name: 'Textilslöjd', nationalCode: 'SL', countsTowardTimplan: true };
const TRA = { id: S.TM, name: 'Trä- och metallslöjd', nationalCode: 'SL', countsTowardTimplan: true };
const HEMKUNSKAP = { id: S.HKK, name: 'Hem- och konsumentkunskap', nationalCode: 'HKK', countsTowardTimplan: true };
// Slöjd with the same code that the timplan does not count (a verkstad hour of the school).
const VERKSTAD = { id: S.SLV, name: 'Slöjdverkstad', nationalCode: 'SL', countsTowardTimplan: false };

const PLAN = id(3101);
// "Test 2 utkast utkast" of the report: the slöjd targets are on Slöjd alone.
// Hemkunskap's are the case's own (the report does not give them).
const entries = (...more: { subjectId: string; gradeLevel: number; minutesPerWeek: number }[]) => [
  ...[
    [4, 60],
    [5, 60],
    [6, 80],
    [7, 65],
    [8, 65],
    [9, 65],
  ].map(([gradeLevel, minutesPerWeek]) => ({ subjectId: S.SL, gradeLevel: gradeLevel!, minutesPerWeek: minutesPerWeek! })),
  ...more,
];
const planOf = (extra: ReturnType<typeof entries> = entries()) => ({
  id: PLAN,
  name: 'Test 2 utkast utkast',
  status: 'DECIDED' as const,
  entries: extra,
});

let groupSerial = 3200;
const theClass = (name: string, gradeLevel: number): PlannedGroup => ({
  id: id(groupSerial++),
  name,
  kind: 'CLASS',
  gradeLevel,
});
const halvesOf = (group: PlannedGroup): [PlannedGroup, PlannedGroup] =>
  [1, 2].map((n) => ({
    id: id(groupSerial++),
    name: `${group.name}:${n}`,
    kind: 'TEACHING_GROUP' as const,
    gradeLevel: group.gradeLevel,
    halfOfId: group.id,
  })) as [PlannedGroup, PlannedGroup];

type Period = { startDate: string | null; endDate: string | null };
let rowSerial = 3400;
const post = (
  group: PlannedGroup,
  subjectId: string,
  lessonsPerWeek: number,
  minutesPerLesson: number,
  period: Period = ALL_YEAR,
): PlannedRequirement => ({
  id: id(rowSerial++),
  studentGroupId: group.id,
  subjectId,
  lessonsPerWeek,
  minutesPerLesson,
  recurrence: 'ALL_WEEKS',
  ...period,
});
let pupilSerial = 3600;
const pupil = (home: PlannedGroup, groups: PlannedGroup[]) => ({
  id: id(pupilSerial++),
  homeGroupId: home.id,
  groupIds: groups.map((group) => group.id),
});
/** A half of ten pupils. */
const ten = (home: PlannedGroup, half: PlannedGroup) => Array.from({ length: 10 }, () => pupil(home, [half]));

const reset = () => {
  groupSerial = 3200;
  rowSerial = 3400;
  pupilSerial = 3600;
};

const yearOf = (
  grades: number[],
  subjects: PlannedCoverageInput['subjects'],
  groups: PlannedGroup[],
  requirements: PlannedRequirement[],
  pupils: ReturnType<typeof pupil>[],
  plan = planOf(),
): PlannedCoverageInput => ({
  year: YEAR,
  closures: [],
  plans: [plan],
  attachments: grades.map((gradeLevel) => ({ gradeLevel, localTimplanId: PLAN })),
  subjects,
  groups,
  requirements,
  pupils,
  includePupils: true,
});

/** The halves reading `a` and `b` in turn: half 1 `a` then `b`, half 2 the other way round. */
const inTurn = (
  [h1, h2]: readonly [PlannedGroup, PlannedGroup],
  a: string,
  b: string,
  lessons: number,
  minutes: number,
): PlannedRequirement[] => [
  post(h1, a, lessons, minutes, AUTUMN),
  post(h1, b, lessons, minutes, SPRING),
  post(h2, b, lessons, minutes, AUTUMN),
  post(h2, a, lessons, minutes, SPRING),
];

/** Åk 4: 4A's two halves of ten swap textilslöjd and trä- och metallslöjd at 1 × 60. */
const aak4 = (): PlannedCoverageInput => {
  reset();
  const c4A = theClass('4A', 4);
  const halves = halvesOf(c4A);
  return yearOf(
    [4],
    [SLOJD, TEXTIL, TRA, HEMKUNSKAP],
    [c4A, ...halves],
    inTurn(halves, S.TX, S.TM, 1, 60),
    [...ten(c4A, halves[0]), ...ten(c4A, halves[1])],
  );
};

/**
 * 4B as 4A, except that 4B:2 reads trä- och metallslöjd in the autumn and
 * nothing in the spring: the class is carried by its halves, and the ten
 * pupils of 4B:2 are short on the line on their own (28 of 60) — listed with
 * the national line, their trä as the only source.
 */
const aak4Short = (): PlannedCoverageInput => {
  reset();
  const c4B = theClass('4B', 4);
  const [h1, h2] = halvesOf(c4B);
  return yearOf(
    [4],
    [SLOJD, TEXTIL, TRA, HEMKUNSKAP],
    [c4B, h1, h2],
    [
      post(h1, S.TX, 1, 60, AUTUMN),
      post(h1, S.TM, 1, 60, SPRING),
      post(h2, S.TM, 1, 60, AUTUMN),
    ],
    [...ten(c4B, h1), ...ten(c4B, h2)],
  );
};

/**
 * Åk 7: hemkunskap swapped with trä- och metallslöjd at 1 × 140 per term, in
 * the halves only — the class has no post in either. The Slöjd entry of 65 is
 * met by the one term of trä each half reads (140 × 20 / 43 = 65 in the
 * autumn, 75 in the spring), and hemkunskap's 65 (the case's own) the same.
 */
const aak7 = (): PlannedCoverageInput => {
  reset();
  const c7A = theClass('7A', 7);
  const halves = halvesOf(c7A);
  return yearOf(
    [7],
    [SLOJD, TEXTIL, TRA, HEMKUNSKAP],
    [c7A, ...halves],
    inTurn(halves, S.HKK, S.TM, 1, 140),
    [...ten(c7A, halves[0]), ...ten(c7A, halves[1])],
    planOf(entries({ subjectId: S.HKK, gradeLevel: 7, minutesPerWeek: 65 })),
  );
};

/**
 * Åk 7 with the class keeping a post in the part: 7A keeps trä- och
 * metallslöjd 2 × 25 and the swap leaves it its trä, 7A:1 reads hemkunskap in
 * the autumn and trä in the spring, 7A:2 the other way round. The class's trä
 * and the half's are one planning as in the swap with slöjd itself (the
 * subject is the same, the four conditions hold), summed on the line and
 * against the Slöjd entry; 7B has the same two posts of trä with no swap
 * beside them (its hemkunskap stays the class's), and its pupils are double
 * planned in trä whatever the line says.
 */
const aak7Swap = (): PlannedCoverageInput => {
  reset();
  const c7A = theClass('7A', 7);
  const swapHalves = halvesOf(c7A);
  const c7B = theClass('7B', 7);
  const [b1, b2] = halvesOf(c7B);
  return yearOf(
    [7],
    [SLOJD, TEXTIL, TRA, HEMKUNSKAP],
    [c7A, ...swapHalves, c7B, b1, b2],
    [
      post(c7A, S.TM, 2, 25),
      ...inTurn(swapHalves, S.HKK, S.TM, 1, 70),
      post(c7B, S.TM, 2, 25),
      post(c7B, S.HKK, 1, 30),
      post(b1, S.TM, 1, 40),
      post(b2, S.TM, 1, 40),
    ],
    [
      pupil(c7A, [swapHalves[0]]),
      pupil(c7A, [swapHalves[1]]),
      pupil(c7B, [b1]),
      pupil(c7B, [b2]),
    ],
    planOf(entries({ subjectId: S.HKK, gradeLevel: 7, minutesPerWeek: 30 })),
  );
};

/**
 * Åk 8: textilslöjd 2 × 65 for one term per half and nothing else on the
 * line — 130 × 20 / 43 = 60 in the autumn, 70 in the spring, against 65:
 * the autumn half is five short on the line, the spring half over it.
 */
const aak8 = (): PlannedCoverageInput => {
  reset();
  const c8A = theClass('8A', 8);
  const [h1, h2] = halvesOf(c8A);
  return yearOf(
    [8],
    [SLOJD, TEXTIL, TRA, HEMKUNSKAP],
    [c8A, h1, h2],
    [post(h1, S.TX, 2, 65, AUTUMN), post(h2, S.TX, 2, 65, SPRING)],
    [...ten(c8A, h1), ...ten(c8A, h2)],
  );
};

/**
 * A plan with an entry on each part is one line of their sum. Åk 5 follows a
 * plan with Slöjd 20, Textilslöjd 20 and Trä- och metallslöjd 20: a target of
 * 60 on the line, whichever subject carries it. 5A plans textil 1 × 60 alone
 * and is MET on the line (its trä cell has its own 20 and 0 planned, the
 * line's status); 5B plans textil 1 × 40 and trä 1 × 20, 5C slöjd 1 × 40
 * and 5D textil 3 × 40 (OVER: 60 above, past a lesson of 40).
 */
const entryOnEachPart = (): PlannedCoverageInput => {
  reset();
  const classes = ['5A', '5B', '5C', '5D'].map((name) => theClass(name, 5));
  const [c5A, c5B, c5C, c5D] = classes as [PlannedGroup, PlannedGroup, PlannedGroup, PlannedGroup];
  return yearOf(
    [5],
    [SLOJD, TEXTIL, TRA, HEMKUNSKAP],
    classes,
    [
      post(c5A, S.TX, 1, 60),
      post(c5B, S.TX, 1, 40),
      post(c5B, S.TM, 1, 20),
      post(c5C, S.SL, 1, 40),
      post(c5D, S.TX, 3, 40),
    ],
    [],
    planOf([
      { subjectId: S.SL, gradeLevel: 5, minutesPerWeek: 20 },
      { subjectId: S.TX, gradeLevel: 5, minutesPerWeek: 20 },
      { subjectId: S.TM, gradeLevel: 5, minutesPerWeek: 20 },
    ]),
  );
};

/**
 * A code only one counted subject carries keeps the subject's own line:
 * Slöjdverkstad shares SL but does not count toward the timplan, so it is in no
 * line and Slöjd stays 'subject:<id>' with its own entry and its own rows.
 */
const sharedWithAnUncountedSubject = (): PlannedCoverageInput => {
  reset();
  const c6A = theClass('6A', 6);
  return yearOf(
    [6],
    [SLOJD, VERKSTAD, HEMKUNSKAP],
    [c6A],
    [post(c6A, S.SL, 1, 80), post(c6A, S.SLV, 1, 40)],
    [],
    planOf([{ subjectId: S.SL, gradeLevel: 6, minutesPerWeek: 80 }]),
  );
};

const added: { name: string; input: PlannedCoverageInput }[] = [
  {
    name: `${PREFIX} åk 4 — two halves of ten swap textilslöjd and trä- och metallslöjd at 1 × 60 across 2027-01-03 and 2027-01-04, the plan's Slöjd entry of 60 is read through the parts: 4A is carried by its halves and each pupil reads 60, nobody is double planned`,
    input: aak4(),
  },
  {
    name: `${PREFIX} åk 4 with a half that reads trä- och metallslöjd in the autumn and nothing in the spring — the class is carried, the half's ten pupils read 28 of 60 on the national line and are listed with their trä as the only source`,
    input: aak4Short(),
  },
  {
    name: `${PREFIX} åk 7 — hemkunskap swapped with trä- och metallslöjd at 1 × 140 per term in the halves only: the Slöjd entry of 65 is met by one term of trä, 65 in the autumn and 75 in the spring`,
    input: aak7(),
  },
  {
    name: `${PREFIX} åk 7 with the class keeping trä- och metallslöjd 2 × 25 — the swap's trä and the class's are one planning summed on the Slöjd line (7A), while the same two posts with no swap beside them are double planned in trä (7B)`,
    input: aak7Swap(),
  },
  {
    name: `${PREFIX} åk 8 — textilslöjd 2 × 65 for one term per half: 60 of 65 in the autumn, 70 in the spring, the autumn half's ten pupils five short on the line`,
    input: aak8(),
  },
  {
    name: `${PREFIX} a plan with an entry on each part is judged as one line of their sum — Slöjd 20, Textilslöjd 20 and Trä- och metallslöjd 20 make 60, which textil alone meets (5A), as do 40 + 20 (5B), slöjd 40 is short (5C) and textil 3 × 40 is over (5D)`,
    input: entryOnEachPart(),
  },
  {
    name: `${PREFIX} a code shared only with a subject that does not count toward the timplan is no shared code — Slöjd keeps its own line with its own 80, Slöjdverkstad is in none`,
    input: sharedWithAnUncountedSubject(),
  },
];

const out = [...kept, ...added.map(({ name, input }) => ({ name, input, coverage: computePlannedCoverage(input) }))];
fs.writeFileSync(FILE, JSON.stringify({ cases: out }, null, 1) + '\n');
console.log(`timplan-planned-cases.json: ${kept.length} kept, ${added.length} added`);
