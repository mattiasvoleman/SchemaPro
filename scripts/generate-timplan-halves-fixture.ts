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
 * class's hemkunskap off it and leaves its slöjd; each half reads slöjd in
 * the period it does not read hemkunskap, the other half the other way
 * round, all four posts in one week — and the line's sum is judged against
 * the target as always. Neither are two or three swaps on the same halves in
 * one week, each kept subject with a partner of its own (nor a pupil whose
 * replacing group takes a rival away). Every neighbouring shape still is,
 * each case failing
 * one part of the signature where it can: the class's post put back after a
 * split (in turn, swapped, or kept for the autumn), a half's dated post with
 * no swap beside it, a second post of the half in the subject, periods that
 * meet, another half that does not mirror the swap (another split beside it,
 * an extra post, both subjects in one period, the mirror split over two
 * halves), a third subject the class has that makes the same swap with the
 * half's hemkunskap (also when the class has it for one term), a half whose
 * two posts differ in their week, the shape
 * reached through both halves, another class's half, two halves without the
 * class or a teaching group, a teaching group on top of the class, and two
 * språkval through a half.
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
  TX: id(2008),
  TM: id(2009),
  BL: id(2010),
  MU: id(2011),
  SVA: id(2012),
};
const SUBJECTS = [
  { id: S.SL, name: 'Slöjd', nationalCode: 'SL', countsTowardTimplan: true },
  { id: S.HKK, name: 'Hem- och konsumentkunskap', nationalCode: 'HKK', countsTowardTimplan: true },
  { id: S.TK, name: 'Teknik', nationalCode: 'TK', countsTowardTimplan: true },
  { id: S.MA, name: 'Matematik', nationalCode: 'MA', countsTowardTimplan: true },
  { id: S.SV, name: 'Svenska', nationalCode: 'SV_SVA', countsTowardTimplan: true },
  { id: S.SPA, name: 'Spanska', nationalCode: 'M2', countsTowardTimplan: true },
  { id: S.TYS, name: 'Tyska', nationalCode: 'M2', countsTowardTimplan: true },
  // #215's slöjd swap: the plan has a slöjd row, and these have no target of their own.
  { id: S.TX, name: 'Textilslöjd', nationalCode: 'SL', countsTowardTimplan: true },
  { id: S.TM, name: 'Trä- och metallslöjd', nationalCode: 'SL', countsTowardTimplan: true },
  // A second and a third swap's partners: no target of their own in these cases.
  { id: S.BL, name: 'Bild', nationalCode: 'BL', countsTowardTimplan: true },
  { id: S.MU, name: 'Musik', nationalCode: 'MU', countsTowardTimplan: true },
  { id: S.SVA, name: 'Svenska som andraspråk', nationalCode: 'SV_SVA', countsTowardTimplan: true },
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
      { subjectId: S.SVA, gradeLevel: 6, minutesPerWeek: 180 },
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

type Period = { startDate: string | null; endDate: string | null };
/** A week other than the default: odd or even weeks, or lessons of more than one length. */
type Week = Pick<PlannedRequirement, 'recurrence' | 'lessonLengths'>;
let rowSerial = 2400;
const post = (
  group: PlannedGroup,
  subjectId: string,
  lessonsPerWeek: number,
  minutesPerLesson: number,
  period: Period = ALL_YEAR,
  week: Week = {},
): PlannedRequirement => ({
  id: id(rowSerial++),
  studentGroupId: group.id,
  subjectId,
  lessonsPerWeek,
  minutesPerLesson,
  recurrence: 'ALL_WEEKS',
  ...period,
  ...week,
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

const period = (startDate: string | null, endDate: string | null): Period => ({ startDate, endDate });

/**
 * A swap of `x` (the subject the class keeps) and `y` (the one the split took
 * off it), as Dela i halvklass writes it: the first half reads y in `first`
 * and x in `second`, the second half the other way round, one week for all
 * four unless `xWeek` gives x's posts on the first half another.
 */
const swapPosts = (
  [h1, h2]: readonly [PlannedGroup, PlannedGroup],
  options: {
    x?: string;
    y?: string;
    lessons?: number;
    minutes?: number;
    first?: Period;
    second?: Period;
    xWeek?: { lessons: number; minutes: number } & Week;
  } = {},
): PlannedRequirement[] => {
  const { x = S.SL, y = S.HKK, lessons = 1, minutes = 70, first = AUTUMN, second = SPRING, xWeek } = options;
  const xOf = (group: PlannedGroup, when: Period) =>
    xWeek
      ? post(group, x, xWeek.lessons, xWeek.minutes, when, { ...(xWeek.recurrence ? { recurrence: xWeek.recurrence } : {}), ...(xWeek.lessonLengths ? { lessonLengths: xWeek.lessonLengths } : {}) })
      : post(group, x, lessons, minutes, when);
  return [post(h1, y, lessons, minutes, first), xOf(h1, second), xOf(h2, first), post(h2, y, lessons, minutes, second)];
};

/**
 * 6A split, hemkunskap swapped with slöjd, 6A keeping its slöjd at `slojd`.
 * Both halves also read teknik all year, undated, which 6A has no post in:
 * a row of the half that meets every period is not the swap's other subject,
 * and does not stop the hemkunskap from being it. `classHemkunskap` gives
 * 6A a hemkunskap post again: put back all year, or kept for the autumn.
 * `extraSlojd` gives 6A:1 a second slöjd post, in March and April.
 */
const swap = (
  slojd: { lessons: number; minutes: number },
  options: { classHemkunskap?: Period; extraSlojd?: boolean } = {},
): PlannedCoverageInput => {
  reset();
  const c6A = theClass('6A');
  const halves = halvesOf(c6A);
  return yearOf(
    [c6A, ...halves],
    [
      post(c6A, S.SL, slojd.lessons, slojd.minutes),
      ...(options.classHemkunskap ? [post(c6A, S.HKK, 1, 30, options.classHemkunskap)] : []),
      ...swapPosts(halves),
      ...(options.extraSlojd ? [post(halves[0], S.SL, 1, 40, period('2027-03-01', '2027-04-30'))] : []),
      post(halves[0], S.TK, 1, 60),
      post(halves[1], S.TK, 1, 60),
    ],
    [pupil(c6A, [halves[0]]), pupil(c6A, [halves[1]])],
  );
};

/** Hemkunskap in turn over the autumn's halves (#215), as Dela i halvklass writes it with one subject. */
const hemkunskapInTurn = ([h1, h2]: readonly [PlannedGroup, PlannedGroup]): PlannedRequirement[] => [
  post(h1, S.HKK, 5, 30, period(null, '2026-10-25')),
  post(h2, S.HKK, 5, 30, period('2026-10-26', '2027-01-10')),
];

/**
 * One subject in turn and 6A's hemkunskap post put back: Mål shows the
 * class's hemkunskap unplanned until its pupils are in the halves, and the
 * post is how an admin answers that red cell. Each pupil then reads
 * hemkunskap twice.
 */
const inTurnPutBack = (): PlannedCoverageInput => {
  reset();
  const c6A = theClass('6A');
  const halves = halvesOf(c6A);
  return yearOf(
    [c6A, ...halves],
    [post(c6A, S.HKK, 1, 30), ...hemkunskapInTurn(halves)],
    [pupil(c6A, [halves[0]]), pupil(c6A, [halves[1]])],
  );
};

/**
 * The same, beside #215's slöjd swap — textilslöjd and trä- och metallslöjd
 * over the terms, the class's slöjd post gone — as a school reading both in
 * halves has it. 6A:1's hemkunskap meets no day of its spring trä, which 6A
 * has no post in; but 6A:2 does not read hemkunskap in the spring, and the
 * slöjd's week is not the hemkunskap's.
 */
const slojdSwapBesideHemkunskapInTurn = (): PlannedCoverageInput => {
  reset();
  const c6A = theClass('6A');
  const halves = halvesOf(c6A);
  return yearOf(
    [c6A, ...halves],
    [
      post(c6A, S.HKK, 1, 30),
      ...swapPosts(halves, { x: S.TM, y: S.TX, lessons: 2, minutes: 60 }),
      ...hemkunskapInTurn(halves),
    ],
    [pupil(c6A, [halves[0]]), pupil(c6A, [halves[1]])],
  );
};

/**
 * Hemkunskap in turn over the autumn's halves and teknik in turn over the
 * spring's, in the same week, and 6A's hemkunskap put back. Each half's
 * hemkunskap meets no day of its teknik, and 6A has no teknik; only the
 * other half's mirror is missing.
 */
const twoSubjectsInTurn = (): PlannedCoverageInput => {
  reset();
  const c6A = theClass('6A');
  const [h1, h2] = halvesOf(c6A);
  return yearOf(
    [c6A, h1, h2],
    [
      post(c6A, S.HKK, 1, 30),
      ...hemkunskapInTurn([h1, h2]),
      post(h1, S.TK, 5, 30, period('2027-01-11', '2027-03-28')),
      post(h2, S.TK, 5, 30, period('2027-03-29', null)),
    ],
    [pupil(c6A, [h1]), pupil(c6A, [h2])],
  );
};

/** The swap, and a half's matematik on top of the class's: 6A:1's in the spring, 6B:2's in the autumn. */
const swapAndExtraMatematik = (): PlannedCoverageInput => {
  reset();
  const c6A = theClass('6A');
  const a = halvesOf(c6A);
  const c6B = theClass('6B');
  const b = halvesOf(c6B);
  return yearOf(
    [c6A, ...a, c6B, ...b],
    [
      post(c6A, S.SL, 2, 25),
      post(c6A, S.MA, 3, 60),
      ...swapPosts(a),
      post(a[0], S.MA, 1, 60, SPRING),
      post(c6B, S.SL, 2, 25),
      post(c6B, S.MA, 3, 60),
      ...swapPosts(b),
      post(b[1], S.MA, 1, 60, AUTUMN),
    ],
    [pupil(c6A, [a[0]]), pupil(c6A, [a[1]]), pupil(c6B, [b[0]]), pupil(c6B, [b[1]])],
  );
};

/**
 * A half with the swap's own two posts whose other half does not read them
 * the other way round. 6N reads hemkunskap in turn, and 6N:1 has slöjd in the
 * spring too, which 6N:2 has none of. 6P:2 reads its hemkunskap inside the
 * autumn it reads slöjd in, so none of it in 6P:1's slöjd spring. 6U:2 reads
 * both in the spring, so no slöjd in 6U:1's hemkunskap autumn. 6W has three
 * halves, and the mirror is split between them: 6W:2 reads the slöjd and
 * 6W:3 the hemkunskap. 6X swaps over the autumn's halves, and 6X:2 reads its
 * slöjd in the spring: a third period, which meets neither of 6X:1's.
 */
const otherHalfDoesNotMirror = (): PlannedCoverageInput => {
  reset();
  const c6N = theClass('6N');
  const [n1, n2] = halvesOf(c6N);
  const c6P = theClass('6P');
  const [p1, p2] = halvesOf(c6P);
  const c6U = theClass('6U');
  const [u1, u2] = halvesOf(c6U);
  const c6W = theClass('6W');
  const [w1, w2] = halvesOf(c6W);
  const w3: PlannedGroup = { id: id(groupSerial++), name: '6W:3', kind: 'TEACHING_GROUP', gradeLevel: 6, halfOfId: c6W.id };
  const c6X = theClass('6X');
  const [x1, x2] = halvesOf(c6X);
  const firstAutumnHalf = period(null, '2026-10-25');
  const secondAutumnHalf = period('2026-10-26', '2027-01-10');
  return yearOf(
    [c6N, n1, n2, c6P, p1, p2, c6U, u1, u2, c6W, w1, w2, w3, c6X, x1, x2],
    [
      post(c6N, S.SL, 2, 40),
      post(n1, S.HKK, 1, 70, AUTUMN),
      post(n2, S.HKK, 1, 70, SPRING),
      post(n1, S.SL, 1, 70, SPRING),
      post(c6P, S.SL, 2, 25),
      post(p1, S.HKK, 1, 70, AUTUMN),
      post(p1, S.SL, 1, 70, SPRING),
      post(p2, S.SL, 1, 70, AUTUMN),
      post(p2, S.HKK, 1, 70, period('2026-09-01', '2026-10-30')),
      post(c6U, S.SL, 2, 25),
      post(u1, S.HKK, 1, 70, AUTUMN),
      post(u1, S.SL, 1, 70, SPRING),
      post(u2, S.SL, 1, 70, SPRING),
      post(u2, S.HKK, 1, 70, SPRING),
      post(c6W, S.SL, 2, 25),
      post(w1, S.HKK, 1, 70, AUTUMN),
      post(w1, S.SL, 1, 70, SPRING),
      post(w2, S.SL, 1, 70, AUTUMN),
      post(w3, S.HKK, 1, 70, SPRING),
      post(c6X, S.SL, 2, 25),
      post(x1, S.HKK, 1, 70, firstAutumnHalf),
      post(x1, S.SL, 1, 70, secondAutumnHalf),
      post(x2, S.SL, 1, 70, SPRING),
      post(x2, S.HKK, 1, 70, secondAutumnHalf),
    ],
    [
      pupil(c6N, [n1]),
      pupil(c6N, [n2]),
      pupil(c6P, [p1]),
      pupil(c6P, [p2]),
      pupil(c6U, [u1]),
      pupil(c6W, [w1]),
      pupil(c6X, [x1]),
    ],
  );
};

/**
 * The swap with slöjd as its first subject (6A:1 reads slöjd in the autumn
 * and hemkunskap in the spring), and teknik split in turn over the terms in
 * the swap's very week, 1 × 70: 6A:1 in the autumn, 6A:2 in the spring. Each
 * half's hemkunskap then makes the same swap with its teknik as with its
 * slöjd. 6A has its teknik post back, so one of the two is a pupil reading
 * teknik twice, and nothing tells which: neither is exempt, double planned
 * in slöjd and in teknik. 6B has no teknik post, so its teknik in turn is
 * no second planning of anything: the swap stays the swap.
 */
const thirdSubjectInTheSwapsWeek = (): PlannedCoverageInput => {
  reset();
  const c6A = theClass('6A');
  const a = halvesOf(c6A);
  const c6B = theClass('6B');
  const b = halvesOf(c6B);
  const teknikInTurn = ([h1, h2]: readonly [PlannedGroup, PlannedGroup]) => [
    post(h1, S.TK, 1, 70, AUTUMN),
    post(h2, S.TK, 1, 70, SPRING),
  ];
  return yearOf(
    [c6A, ...a, c6B, ...b],
    [
      post(c6A, S.SL, 2, 25),
      post(c6A, S.TK, 1, 30),
      ...swapPosts(a, { first: SPRING, second: AUTUMN }),
      ...teknikInTurn(a),
      post(c6B, S.SL, 2, 25),
      ...swapPosts(b, { first: SPRING, second: AUTUMN }),
      ...teknikInTurn(b),
    ],
    [pupil(c6A, [a[0]]), pupil(c6A, [a[1]]), pupil(c6B, [b[0]]), pupil(c6B, [b[1]])],
  );
};

/** The swap with the slöjd in another week than the hemkunskap, each class one way. */
const weekDiffers = (): PlannedCoverageInput => {
  reset();
  const classes = (['6Q', '6R', '6S', '6T', '6V'] as const).map((name) => {
    const group = theClass(name);
    return { group, halves: halvesOf(group) };
  });
  // The hemkunskap's week, then the slöjd's: each pair differs in one way only.
  const weeks: [number, { lessons: number; minutes: number } & Week][] = [
    [1, { lessons: 2, minutes: 70 }], // more lessons
    [1, { lessons: 1, minutes: 60 }], // shorter lessons
    [2, { lessons: 2, minutes: 70, lessonLengths: [70, 40] }], // two lengths beside 2 × 70
    [1, { lessons: 1, minutes: 70, recurrence: 'ODD_WEEKS' }], // odd weeks
    [1, { lessons: 2, minutes: 35 }], // the same 70 minutes in two lessons
  ];
  return yearOf(
    classes.flatMap(({ group, halves }) => [group, ...halves]),
    classes.flatMap(({ group, halves }, index) => [
      post(group, S.SL, 2, 25),
      ...swapPosts(halves, { lessons: weeks[index]![0], xWeek: weeks[index]![1] }),
    ]),
    classes.flatMap(({ group, halves }) => [pupil(group, [halves[0]]), pupil(group, [halves[1]])]),
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

/** The swap mirrored and in one week, but over periods that meet. */
const periodsThatMeet = (): PlannedCoverageInput => {
  reset();
  const shapes: [string, Period, Period][] = [
    // The slöjd undated: a whole year, which meets every period.
    ['6E', AUTUMN, ALL_YEAR],
    // The second period from December: four weeks in common.
    ['6F', AUTUMN, period('2026-12-01', null)],
    // Hemkunskap to 11 January and slöjd from it: one day in common.
    ['6G', period(null, '2027-01-11'), period('2027-01-11', null)],
  ];
  const classes = shapes.map(([name, first, second]) => {
    const group = theClass(name);
    return { group, halves: halvesOf(group), first, second };
  });
  return yearOf(
    classes.flatMap(({ group, halves }) => [group, ...halves]),
    classes.flatMap(({ group, halves, first, second }) => [post(group, S.SL, 2, 25), ...swapPosts(halves, { first, second })]),
    classes.flatMap(({ group, halves }) => [pupil(group, [halves[0]]), pupil(group, [halves[1]])]),
  );
};

/**
 * The swap's own shape, reached some other way. 6H is swapped as 6A is, and
 * one of its pupils is the swap; the rest are not. 6J and 6L are swapped
 * too, so that their own halves would mirror what their pupil reads.
 */
const swapShapeElsewhere = (): PlannedCoverageInput => {
  reset();
  const c6H = theClass('6H');
  const h = halvesOf(c6H);
  // A 6J pupil in 6H:1: another class's half.
  const c6J = theClass('6J');
  const j = halvesOf(c6J);
  // 6K keeps no slöjd post; one pupil is in both its halves.
  const c6K = theClass('6K');
  const k = halvesOf(c6K);
  // A teaching group, not a half, with 6L:1's two posts.
  const c6L = theClass('6L');
  const l = halvesOf(c6L);
  const group = teachingGroup('Hemkunskap och slöjd 6L');
  return yearOf(
    [c6H, ...h, c6J, ...j, c6K, ...k, c6L, ...l, group],
    [
      post(c6H, S.SL, 2, 25),
      ...swapPosts(h),
      post(c6J, S.SL, 2, 40),
      ...swapPosts(j),
      ...swapPosts(k),
      post(c6L, S.SL, 2, 25),
      ...swapPosts(l),
      post(group, S.HKK, 1, 70, AUTUMN),
      post(group, S.SL, 1, 70, SPRING),
    ],
    [
      pupil(c6H, [h[0]]), // the swap: not double planned
      pupil(c6H, [h[0], h[1]]),
      pupil(c6J, [h[0]]),
      pupil(c6K, [k[0], k[1]]),
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

/**
 * Two swaps on the same halves, in the same terms and the same week — the
 * dialog proposes one week for two posts of one week: 6A swaps hemkunskap
 * for slöjd and bild for teknik, keeping its slöjd and its teknik, and each
 * half reads hemkunskap and bild in one term, slöjd and teknik in the other.
 * Each kept subject has a partner of its own, so both swaps are exempt. 6B
 * draws the second swap the other way round (the kept teknik first), and 6C
 * adds a third, musik for matematik. In 6D the slöjd could take either
 * partner and the teknik only the hemkunskap (6D:2 reads teknik in the
 * hemkunskap's half of the autumn, not the bild's): taking the first partner
 * that fits gives the slöjd the hemkunskap and leaves the teknik none, but
 * slöjd with bild and teknik with hemkunskap gives both one.
 */
const twoSwapsInOneWeek = (): PlannedCoverageInput => {
  reset();
  const c6A = theClass('6A');
  const a = halvesOf(c6A);
  const c6B = theClass('6B');
  const b = halvesOf(c6B);
  const c6C = theClass('6C');
  const c = halvesOf(c6C);
  const c6D = theClass('6D');
  const d = halvesOf(c6D);
  const firstAutumnHalf = period(null, '2026-10-25');
  const secondAutumnHalf = period('2026-10-26', '2027-01-10');
  return yearOf(
    [c6A, ...a, c6B, ...b, c6C, ...c, c6D, ...d],
    [
      post(c6A, S.SL, 2, 25),
      post(c6A, S.TK, 1, 30),
      ...swapPosts(a),
      ...swapPosts(a, { x: S.TK, y: S.BL }),
      post(c6B, S.SL, 2, 25),
      post(c6B, S.TK, 1, 30),
      ...swapPosts(b),
      ...swapPosts(b, { x: S.TK, y: S.BL, first: SPRING, second: AUTUMN }),
      post(c6C, S.SL, 2, 25),
      post(c6C, S.TK, 1, 30),
      post(c6C, S.MA, 3, 60),
      ...swapPosts(c),
      ...swapPosts(c, { x: S.TK, y: S.BL }),
      ...swapPosts(c, { x: S.MA, y: S.MU }),
      post(c6D, S.SL, 2, 25),
      post(c6D, S.TK, 1, 30),
      post(d[0], S.SL, 1, 70, SPRING),
      post(d[0], S.TK, 1, 70, SPRING),
      post(d[0], S.HKK, 1, 70, secondAutumnHalf),
      post(d[0], S.BL, 1, 70, firstAutumnHalf),
      post(d[1], S.SL, 1, 70, AUTUMN),
      post(d[1], S.TK, 1, 70, secondAutumnHalf),
      post(d[1], S.HKK, 1, 70, SPRING),
      post(d[1], S.BL, 1, 70, SPRING),
    ],
    [
      ...[a, b, c].flatMap((halves, index) => [
        pupil([c6A, c6B, c6C][index]!, [halves[0]]),
        pupil([c6A, c6B, c6C][index]!, [halves[1]]),
      ]),
      pupil(c6D, [d[0]]),
    ],
  );
};

/**
 * The swap, and svenska split in turn in its week beside 6A's svenska: the
 * L shape with svenska. The first pupil is in SvA6, which replaces svenska,
 * so neither 6A's svenska nor the half's reaches them, and their slöjd keeps
 * its partner. The second reads svenska twice, and is double planned in it
 * and in slöjd.
 */
const replacingGroupBesideTheSwap = (): PlannedCoverageInput => {
  reset();
  const c6A = theClass('6A');
  const halves = halvesOf(c6A);
  const sva: PlannedGroup = { id: id(groupSerial++), name: 'SvA6', kind: 'TEACHING_GROUP', gradeLevel: null, replacesSubjectId: S.SV };
  return yearOf(
    [c6A, ...halves, sva],
    [
      post(c6A, S.SL, 2, 25),
      post(c6A, S.SV, 3, 60),
      ...swapPosts(halves),
      post(halves[0], S.SV, 1, 70, SPRING),
      post(halves[1], S.SV, 1, 70, AUTUMN),
      post(sva, S.SVA, 3, 60),
    ],
    [pupil(c6A, [halves[0], sva]), pupil(c6A, [halves[1]])],
  );
};

/**
 * Rows of the half in a subject the class has that are no swap: 6A:1's
 * matematik 1 × 70 in the spring, the swap's week but nothing on 6A:2 to
 * mirror it, and 6B:1's in the autumn, the hemkunskap's own term. Neither
 * takes the hemkunskap from the slöjd: the slöjd stays the swap, the
 * matematik is double planned.
 */
const rowsThatAreNoPartner = (): PlannedCoverageInput => {
  reset();
  const c6A = theClass('6A');
  const a = halvesOf(c6A);
  const c6B = theClass('6B');
  const b = halvesOf(c6B);
  return yearOf(
    [c6A, ...a, c6B, ...b],
    [
      post(c6A, S.SL, 2, 25),
      post(c6A, S.MA, 3, 60),
      ...swapPosts(a),
      post(a[0], S.MA, 1, 70, SPRING),
      post(c6B, S.SL, 2, 25),
      post(c6B, S.MA, 3, 60),
      ...swapPosts(b),
      post(b[0], S.MA, 1, 70, AUTUMN),
    ],
    [pupil(c6A, [a[0]]), pupil(c6B, [b[0]])],
  );
};

/**
 * The L shape with 6A's teknik back for the spring only: a class post in a
 * subject, in any period, makes the subject the class's, so the half's
 * teknik is a kept row beside the slöjd, and neither is exempt.
 */
const classTeknikForTheSpring = (): PlannedCoverageInput => {
  reset();
  const c6A = theClass('6A');
  const halves = halvesOf(c6A);
  return yearOf(
    [c6A, ...halves],
    [
      post(c6A, S.SL, 2, 25),
      post(c6A, S.TK, 1, 30, SPRING),
      ...swapPosts(halves, { first: SPRING, second: AUTUMN }),
      post(halves[0], S.TK, 1, 70, AUTUMN),
      post(halves[1], S.TK, 1, 70, SPRING),
    ],
    [pupil(c6A, [halves[0]]), pupil(c6A, [halves[1]])],
  );
};

const added = [
  {
    name: `${PREFIX} hemkunskap swapped with slöjd — 6A's slöjd 2 × 25 and each half's slöjd in the term it reads no hemkunskap, which 6A has no post in, mirrored by the other half in one week, are one planning, not double: 50 + 34 and 50 + 36, both on the target of 80`,
    input: swap({ lessons: 2, minutes: 25 }),
  },
  {
    name: `${PREFIX} the same swap with 6A's slöjd cut to 2 × 20 — the sum is the pupil's figure: 74 and 76 of 80, each pupil under on their own, from 6A and their half, and not double planned`,
    input: swap({ lessons: 2, minutes: 20 }),
  },
  {
    name: `${PREFIX} 6A's hemkunskap put back after the swap — each pupil is double planned in hemkunskap and in slöjd, since the half's hemkunskap is no longer a subject the class has none of`,
    input: swap({ lessons: 2, minutes: 25 }, { classHemkunskap: ALL_YEAR }),
  },
  {
    name: `${PREFIX} 6A's hemkunskap kept for the autumn beside the swap — a dated class post is the class's too: double planned in hemkunskap and in slöjd`,
    input: swap({ lessons: 2, minutes: 25 }, { classHemkunskap: AUTUMN }),
  },
  {
    name: `${PREFIX} a second slöjd post on 6A:1 beside the swap, in March and April — the half's slöjd is not the swap's one post, so its pupil is double planned`,
    input: swap({ lessons: 2, minutes: 25 }, { extraSlojd: true }),
  },
  {
    name: `${PREFIX} 6A's hemkunskap put back after a split in turn — each pupil reads it from 6A all year and from their half for half the autumn, double planned at 65 and 68 of 30`,
    input: inTurnPutBack(),
  },
  {
    name: `${PREFIX} the same beside #215's slöjd swap of textilslöjd and trä- och metallslöjd — 6A:1's hemkunskap meets no day of its trä, which 6A has none of, but nothing mirrors it in that week: double planned at 65 and 68 of 30`,
    input: slojdSwapBesideHemkunskapInTurn(),
  },
  {
    name: `${PREFIX} hemkunskap in turn over the autumn and teknik over the spring in one week, and 6A's hemkunskap put back — the other half reads no hemkunskap in the half's teknik weeks: double planned`,
    input: twoSubjectsInTurn(),
  },
  {
    name: `${PREFIX} the swap and a half's matematik on top of the class's, in the spring or in the autumn — the half's hemkunskap is the slöjd's partner, not the matematik's: double planned in matematik only`,
    input: swapAndExtraMatematik(),
  },
  {
    name: `${PREFIX} the other half does not read the two the other way round — 6N:2 reads no slöjd, 6P:2 no hemkunskap in 6P:1's slöjd spring, 6U:2 no slöjd in 6U:1's hemkunskap autumn, 6W's mirror split over two halves, 6X:2's slöjd in a third period: double planned`,
    input: otherHalfDoesNotMirror(),
  },
  {
    name: `${PREFIX} teknik in turn in the swap's very week — with 6A's teknik back, the half's hemkunskap makes a swap with its teknik as with its slöjd, so neither is exempt; with 6B's teknik gone, the swap stays the swap`,
    input: thirdSubjectInTheSwapsWeek(),
  },
  {
    name: `${PREFIX} two swaps on the same halves in one week — hemkunskap for slöjd and bild for teknik, either way round, a third for matematik, and one where the first partner that fits is the wrong one: each kept subject has a partner of its own, so none is double planned`,
    input: twoSwapsInOneWeek(),
  },
  {
    name: `${PREFIX} svenska in turn in the swap's week beside 6A's svenska — the pupil in SvA6 reads neither, so their slöjd keeps its partner; the other reads svenska twice: double planned in svenska and slöjd`,
    input: replacingGroupBesideTheSwap(),
  },
  {
    name: `${PREFIX} a half's matematik in the swap's week with no mirror, or in the hemkunskap's term, is no partner's rival — the slöjd stays the swap, the matematik is double planned`,
    input: rowsThatAreNoPartner(),
  },
  {
    name: `${PREFIX} the teknik in turn beside 6A's teknik back for the spring only — a class post in any period makes the subject the class's: double planned in slöjd and teknik`,
    input: classTeknikForTheSpring(),
  },
  {
    name: `${PREFIX} the swap with the half's slöjd in another week than its hemkunskap — more lessons, shorter lessons, lessons of two lengths, odd weeks, the same minutes in two lessons: double planned`,
    input: weekDiffers(),
  },
  {
    name: `${PREFIX} a half's dated post with no swap beside it is double planned — slöjd dated with the year's own ends, slöjd from the year's second week, matematik in the spring`,
    input: datedWithoutSwap(),
  },
  {
    name: `${PREFIX} the swap mirrored and in one week, but over periods that meet — an undated slöjd, four weeks in common, one day in common: double planned`,
    input: periodsThatMeet(),
  },
  {
    name: `${PREFIX} the swap's shape reached some other way is double planned — both halves at once, another class's half, two halves without the class, a teaching group with a half's posts — while 6H's pupil in one half is the swap`,
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
