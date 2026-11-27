import { buildTeacherLoadReport, DEFAULT_LOAD_POLICY, targetMinutesPerWeek, type LoadEmployment, type LoadInput, type LoadRequirement, type LoadScopeAssessment } from './teacher-load';
import { hideScopeHr, scopeOfTeacher, type ScopeBand, type ScopeVersion } from './assignment-scope';
import { overScopeFinding, staffingSentence, STAFF_TEACHER_OVER_SCOPE_HIDDEN, type CheckPolicy } from './staffing-checks';

/*
 * PROVET AV JA OCH NEJ (K7b, #414 L-4b, R1b).
 *
 * The sakbeskrivning (6.3) said: "Om en rad ja eller nej-svar mot timmar som läsaren känner kan begränsa tjänsten till ett intervall
 * har inte prövats här." This is that test. A reader without HR-läs is not handed a teacher's tjänst %, nedsättning or the upper edge of
 * their span (hideScopeHr, STAFF_TEACHER_OVER_SCOPE_HIDDEN), but is handed a yes or no: "this teacher would get more than the
 * ordinance's highest level". The ordinance's span is public (3 §: 650 and 600 hours), and the edge for a teacher is the span times the
 * post (the active share, tjänst minus nedsättning). The reader knows the hours they place: the lessons are in the schedule.
 *
 * THE ATTACK, as a scheduler without HR-läs who may write lessons would run it: place a row of m minutes a week for the teacher, read the
 * verdict, undo it, and halve the range. `ask(m)` is the real chain a write goes through (scopeOfTeacher for before and after, then
 * overScopeFinding with the reader's policy), and the report's own verdict for the same state (hideScopeHr), which is the other place the
 * bit is handed out; the proposal's `overBefore`/`overAfter` are read off the same verdict.
 *
 * WHAT IT FINDS, and what the sakbeskrivning now says (6.3):
 *   - YES, the verdict bounds the teacher's ACTIVE SHARE (tjänst minus nedsättning, weighted by teaching weeks) to the hours of one
 *     minute a week: about a tenth of a percentage point, in thirteen writes (halving 4096 minutes a week). It is no more than the verdict has to be: a write check that
 *     says nothing short of "over" is no check, and any coarser answer is wrong for the teacher.
 *   - It does NOT give the split. A post of 80 % and one of 90 % less 10 % answer every question alike.
 *   - It gives nothing the reader does not already have where the school has no target of its own for the teacher: the target in
 *     minutes is shown to every administrator (hrHiddenNotice: "Målet i minuter visas för alla") and is the active share times the
 *     school's full-time minutes, to five minutes. The verdict is the finer of the two, and neither is finer than a person can use.
 *   - It gives the active share where the school HAS set a target of its own: the target then says nothing of the share and the verdict
 *     does. That is the one thing the verdict adds, and it is stated.
 *   - It carries no figure: the hidden finding's params are the role alone, and the report's hidden row has no edge.
 *
 * Every number below is worked from the ordinance and the year, not read off the code (see assignment-scope.spec.ts).
 */
const YEAR = { startDate: '2026-08-17', endDate: '2027-06-11' };
const ANNA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const BAND: ScopeBand = {
  schoolForm: 'GRUNDSKOLA',
  gradeNumbering: 'NIOARIG',
  gradeFrom: 4,
  gradeTo: 6,
  teachingHoursLow: 550,
  teachingHoursHigh: 650,
  planningFloorPercent: 100,
  teachingSection: '3 § p. 1',
  planningSection: '4 § p. 1',
  note: null,
};
/** In force from before the test year, so that the year is judged (the real one holds from 2027-07-01). */
const VERSION: ScopeVersion = {
  code: 'SFS2026:1487',
  sfs: 'SFS 2026:1487',
  title: 'Förordning om omfattning av tiden för lärares och förskollärares undervisningsuppdrag',
  validFrom: '2020-01-01',
  validTo: null,
  source: 'https://svenskforfattningssamling.se/sites/default/files/sfs/2026-06/SFS2026-1487.pdf',
  bands: [BAND],
};

/** The school's full-time teaching minutes a week: a school's own figure, shown to every administrator with the target. */
const FULL_TIME_MINUTES = 1080;

const employment = (employmentPercent: number, reductionPercent: number, teachingTargetMinutesPerWeek: number | null = null): LoadEmployment => ({
  userId: ANNA,
  employmentPercent,
  reductionPercent,
  contractKind: 'FERIE',
  teachingTargetMinutesPerWeek,
  signature: 'ANN',
});

/** A year-long row of one lesson a week of `minutes` minutes in årskurs 4-6: the write the attacker makes. */
const placed = (minutes: number): LoadRequirement => ({
  id: `probe-${minutes}`,
  subjectId: 'ma',
  subjectName: 'Matematik',
  studentGroupId: 'g-5a',
  groupName: '5A',
  teacherId: ANNA,
  coTeacherId: null,
  lessonsPerWeek: 1,
  minutesPerLesson: minutes,
  teacherLoadPercent: 100,
  coTeacherLoadPercent: 100,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  gradeSpan: { min: 4, max: 6 },
});

const inputOf = (post: LoadEmployment, requirements: LoadRequirement[]): LoadInput => ({
  year: YEAR,
  policy: { ...DEFAULT_LOAD_POLICY, fullTimeTeachingMinutesPerWeek: FULL_TIME_MINUTES },
  employments: [post],
  requirements,
  qualifications: [],
  closures: [],
  duties: [],
});

/** The reader's policy: a schemaläggare without HR-läs, the school's mode WARN (REFUSE answers the same, and stops the write). */
const HIDDEN_READER: CheckPolicy = {
  qualificationMode: 'OFF',
  overAllocationMode: 'OFF',
  overAllocationTolerancePercent: 10,
  fullTimeTeachingMinutesPerWeek: FULL_TIME_MINUTES,
  assignmentScopeMode: 'WARN',
  showsPeriods: false,
};

interface Answer {
  /** What the write answers: STAFF_TEACHER_OVER_SCOPE_HIDDEN, or nothing. */
  writeSaysOver: boolean;
  /** What the report's row says to the same reader for the same state. */
  reportSaysOver: boolean;
  /** The hours the reader knows: the teacher's teaching hours, a figure of the lessons they placed, in the row. */
  hours: number;
}

/** The yes or no the reader is handed for a write of `minutes` a week, through the chain a write goes through. */
function ask(post: LoadEmployment, minutes: number): Answer {
  const before = scopeOfTeacher(inputOf(post, []), [VERSION], ANNA);
  const after = scopeOfTeacher(inputOf(post, [placed(minutes)]), [VERSION], ANNA);
  const finding = overScopeFinding({ policy: HIDDEN_READER, userId: ANNA, role: 'TEACHER', before, after });
  return {
    writeSaysOver: finding !== null,
    reportSaysOver: after !== null && hideScopeHr(after).verdict === 'OVER_MAX',
    hours: after?.teachingHours ?? 0,
  };
}

interface Bound {
  /** The active share, in percent, is at least this and below the next. */
  low: number;
  high: number;
  /** The writes the search took. */
  asks: number;
}

/**
 * The reader's search: the least minutes a week that answers OVER, by halving, and the share that interval gives. The reader knows the
 * ordinance's 650 hours and the hours of what they placed (the `hours` of the row), and nothing else.
 */
function search(post: LoadEmployment): Bound {
  let asks = 0;
  const probe = (minutes: number): Answer => {
    asks += 1;
    return ask(post, minutes);
  };
  let no = 1;
  let yes = 4096;
  // A share of up to 100 % can be over 650 hours at 4096 minutes a week or not at all: the search starts from "yes" there.
  if (!probe(yes).writeSaysOver) throw new Error('not over even at 4096 minutes a week');
  while (yes - no > 1) {
    const middle = Math.floor((no + yes) / 2);
    if (probe(middle).writeSaysOver) yes = middle;
    else no = middle;
  }
  const hoursNo = ask(post, no).hours;
  const hoursYes = ask(post, yes).hours;
  // OVER is `round1(hours) > round1(650 × share)`: the edge, in hours, lies at or above the last NO and below the first YES.
  return { low: (hoursNo / 650) * 100, high: (hoursYes / 650) * 100, asks };
}

const active = (post: LoadEmployment) => post.employmentPercent - post.reductionPercent;

describe('what a reader without HR-läs can learn of a colleague from the yes or no of the ordinance’s upper edge', () => {
  // The posts of a school: whole, part-time, with a reduction, and one that a person can read at a glance.
  const POSTS: Array<[string, LoadEmployment]> = [
    ['100 %', employment(100, 0)],
    ['80 %', employment(80, 0)],
    ['100 % less 20 %', employment(100, 20)],
    ['60 % less 10 %', employment(60, 10)],
    ['75 %', employment(75, 0)],
    ['50 %', employment(50, 0)],
    ['27,5 %', employment(27.5, 0)],
  ];

  it.each(POSTS)('bounds the active share of a post of %s to a tenth of a percentage point, in thirteen writes', (_label, post) => {
    const found = search(post);
    // The truth is inside the interval the reader is left with...
    expect(active(post)).toBeGreaterThanOrEqual(found.low - 1e-9);
    expect(active(post)).toBeLessThanOrEqual(found.high + 1e-9);
    // ...which is a tenth of a point wide: one minute a week over 43 weeks is 0.7 hours of 650.
    expect(found.high - found.low).toBeLessThan(0.15);
    // ...in thirteen writes: the first at 4096 minutes, then twelve halvings of the range.
    expect(found.asks).toBeLessThanOrEqual(13);
  });

  it('gives the same yes or no through the write and through the report, for every write', () => {
    for (const [, post] of POSTS) {
      for (const minutes of [1, 100, 500, 800, 1000, 1500, 2000, 3000]) {
        const answer = ask(post, minutes);
        expect(answer.reportSaysOver).toBe(answer.writeSaysOver);
      }
    }
  });

  it('does not give the split: a post of 80 % and one of 90 % less 10 % answer every question alike', () => {
    const pairs: Array<[LoadEmployment, LoadEmployment]> = [
      [employment(80, 0), employment(90, 10)],
      [employment(100, 0), employment(130, 30)],
      [employment(50, 0), employment(60, 10)],
    ];
    for (const [one, other] of pairs) {
      expect(active(one)).toBe(active(other));
      for (const minutes of [1, 200, 400, 560, 563, 570, 650, 700, 800, 1000, 1200, 2000]) {
        const [a, b] = [ask(one, minutes), ask(other, minutes)];
        expect(a).toEqual(b);
      }
    }
  });

  it('is no more than the target in minutes already says, where the school has set no target of its own', () => {
    // The target is the active share times the school's full-time minutes, to five minutes, and every administrator reads it.
    for (const [, post] of POSTS) {
      const shown = targetMinutesPerWeek(post, { ...DEFAULT_LOAD_POLICY, fullTimeTeachingMinutesPerWeek: FULL_TIME_MINUTES })!;
      const fromTarget = (shown / FULL_TIME_MINUTES) * 100;
      // To five minutes of 1080: 0.46 percentage points wide. The verdict is finer, and a person's post is a multiple of half a percent.
      expect(Math.abs(fromTarget - active(post))).toBeLessThanOrEqual((2.5 / FULL_TIME_MINUTES) * 100 + 1e-9);
    }
  });

  it('is the active share where the school has set a target of its own: the target says nothing of it and the verdict does', () => {
    // A school that agreed 900 minutes with a teacher of 60 % less 10 %: the target shown is 900, which is 83 % of 1080, and the post is 50 %.
    const post = employment(60, 10, 900);
    expect(targetMinutesPerWeek(post, { ...DEFAULT_LOAD_POLICY, fullTimeTeachingMinutesPerWeek: FULL_TIME_MINUTES })).toBe(900);
    const found = search(post);
    expect(found.low).toBeLessThanOrEqual(50);
    expect(found.high).toBeGreaterThanOrEqual(50);
    // The reader learns 50 % from a target of 900 minutes: the one thing the verdict adds.
    expect(found.high - found.low).toBeLessThan(0.15);
  });

  it('carries no figure: the hidden write answer is the role alone, and the report’s hidden row has no edge, hours-left or floor-fit', () => {
    const post = employment(80, 0);
    const before = scopeOfTeacher(inputOf(post, []), [VERSION], ANNA);
    const after = scopeOfTeacher(inputOf(post, [placed(1500)]), [VERSION], ANNA)!;
    const finding = overScopeFinding({ policy: HIDDEN_READER, userId: ANNA, role: 'TEACHER', before, after })!;
    expect(finding.code).toBe(STAFF_TEACHER_OVER_SCOPE_HIDDEN);
    expect(finding.params).toEqual({ role: 'TEACHER' });
    // The sentence has the ordinance's number and no other: no hours and no limit.
    expect(staffingSentence(finding).replace('SFS 2026:1487 3 §', '')).not.toMatch(/\d/);

    const hidden = hideScopeHr(after);
    expect(hidden.highestHours).toBeNull();
    expect(hidden.ordinanceHighestHours).toBeNull();
    expect(hidden.remainingHours).toBeNull();
    expect(hidden.planningFits).toBeNull();
    // What stays is what the reader has put there (the hours of the lessons) and the ordinance's own span, which is the same for everybody.
    expect(hidden.teachingHours).toBe(after.teachingHours);
    expect(hidden.fullTimeHighestHours).toBe(650);
  });

  it('is the same bit through the load report’s own arithmetic, so no other channel is finer', () => {
    // The report and the write take the active share from one function (activePercentOf), and the verdict is judged on the printed hours.
    const post = employment(80, 0);
    const report = buildTeacherLoadReport(inputOf(post, [placed(1500)]));
    expect(report.teachers.find((row) => row.userId === ANNA)).toBeDefined();
    const [no, yes] = [ask(post, 520), ask(post, 530)];
    // 80 % of 650 is 520 hours; one lesson of 520 minutes a week over 43 weeks is 372.7 hours, so the edge is crossed between 725 and 726 minutes.
    expect(no.writeSaysOver).toBe(false);
    expect(yes.writeSaysOver).toBe(false);
    expect(ask(post, 725).writeSaysOver).toBe(false);
    expect(ask(post, 726).writeSaysOver).toBe(true);
  });
});

/*
 * THE OTHER VERDICT (g494). The report keeps `verdict` for a reader without HR-läs, and OVER_OWN is "over the level the rektor set": it
 * flips at the rektor's level times the active share, where OVER_MAX flips at the ordinance's edge times the same share. A reader who
 * places lessons and reads the row finds both edges in thirteen reads each, and the level is their ratio times the ordinance's 650.
 * The rektor's level is what hideScopeHr takes out of `assessment` for that reader, so the row must not say it by another road.
 */
describe('what a reader without HR-läs can learn of the rektor’s level from the verdict of the report’s row', () => {
  const assessed = (levelHours: number | null): ReadonlyMap<string, LoadScopeAssessment> =>
    new Map([[ANNA, { levelHours, exceptionKind: null, ownInitiativeOn: null, note: 'skäl', decidedAt: '2026-03-05T08:00:00.000Z' }]]);
  /** The row the reader is handed after placing `minutes` a week for the teacher. */
  const rowAfter = (post: LoadEmployment, level: number | null, minutes: number) =>
    hideScopeHr(scopeOfTeacher({ ...inputOf(post, [placed(minutes)]), scopeAssessments: assessed(level) }, [VERSION], ANNA)!);
  const MINUTES = Array.from({ length: 4096 / 8 }, (_, index) => 1 + index * 8);

  it.each([
    ['80 %', employment(80, 0), 561],
    ['100 %', employment(100, 0), 572],
    ['60 % less 10 %', employment(60, 10), 600],
  ])('never says OVER_OWN to the reader, for a post of %s and a level of %s h', (_label, post, level) => {
    // Without the rektor's level at 561 the row says INSIDE or OVER_MAX; with it the unhidden row says OVER_OWN between the two edges.
    const seen = new Set(MINUTES.map((minutes) => rowAfter(post, level, minutes).verdict));
    expect(seen.has('OVER_OWN')).toBe(false);
  });

  it('answers a teacher the rektor has given a level of 561 and one who has none, or one of 640, with the same verdict at every write', () => {
    for (const post of [employment(80, 0), employment(100, 0), employment(50, 0)]) {
      for (const minutes of MINUTES) {
        const none = rowAfter(post, null, minutes).verdict;
        expect(rowAfter(post, 561, minutes).verdict).toBe(none);
        expect(rowAfter(post, 640, minutes).verdict).toBe(none);
      }
    }
  });
});
