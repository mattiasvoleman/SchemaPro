import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  buildScopeReport,
  hideScopeHr,
  placeSpan,
  versionInForce,
  type ScopeBand,
  type ScopeVersion,
  type TeacherScope,
} from './assignment-scope';
import {
  DEFAULT_LOAD_POLICY,
  buildTeacherLoadReport,
  type LoadDuty,
  type LoadEmployment,
  type LoadInput,
  type LoadRequirement,
} from './teacher-load';
import { teachingWeeks } from './teaching-weeks';

/*
 * Undervisningsuppdragets omfattning (SFS 2026:1487). Every expected figure below is worked out by hand from the
 * ordinance and the year, not read off the code:
 *
 *   3 § p. 1  550-650 h, årskurs 1-6      3 § p. 2  500-600 h, årskurs 7-9
 *   4 § p. 1  planning at least 100 % of the teaching time      5 § p. 1  and 10 % more for årskurs 7-9
 *   3 § second paragraph  part-time: the same ratio to the working time
 *
 * The year is the one the other staffing suites use, 2026-08-17 to 2027-06-11, 43 ISO weeks (ISO 2026 has a week 53),
 * so 1 lesson a week of 60 minutes over an all-year row is 43 hours, and 17 lessons are 731 hours. The ordinance
 * is in force from 2027-07-01, so the VERSION below is judged from 2020 for these tests, and the in-force tests use their
 * own dates.
 */
const YEAR = { startDate: '2026-08-17', endDate: '2027-06-11' };
const ANNA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const LOW: ScopeBand = {
  schoolForm: 'GRUNDSKOLA',
  gradeNumbering: 'NIOARIG',
  gradeFrom: 1,
  gradeTo: 6,
  teachingHoursLow: 550,
  teachingHoursHigh: 650,
  planningFloorPercent: 100,
  teachingSection: '3 § p. 1',
  planningSection: '4 § p. 1',
  note: null,
};
const HIGH: ScopeBand = {
  schoolForm: 'GRUNDSKOLA',
  gradeNumbering: 'NIOARIG',
  gradeFrom: 7,
  gradeTo: 9,
  teachingHoursLow: 500,
  teachingHoursHigh: 600,
  planningFloorPercent: 110,
  teachingSection: '3 § p. 2',
  planningSection: '4 § p. 1 och 5 § p. 1',
  note: 'Tolkning: 5 § säger "Utöver den tid som anges i 4 §" men 4 § räknar inte upp årskurs 7-9.',
};
const ORDINANCE: ScopeVersion = {
  code: 'SFS2026:1487',
  sfs: 'SFS 2026:1487',
  title: 'Förordning om omfattning av tiden för lärares och förskollärares undervisningsuppdrag',
  validFrom: '2027-07-01',
  validTo: null,
  source: 'https://svenskforfattningssamling.se/sites/default/files/sfs/2026-06/SFS2026-1487.pdf',
  bands: [LOW, HIGH],
};
/** The same ordinance, in force from before the test year, so that the year is judged. */
const VERSION: ScopeVersion = { ...ORDINANCE, validFrom: '2020-01-01' };

const employment = (overrides: Partial<LoadEmployment> = {}): LoadEmployment => ({
  userId: ANNA,
  employmentPercent: 100,
  reductionPercent: 0,
  contractKind: 'FERIE',
  teachingTargetMinutesPerWeek: null,
  signature: 'ANN',
  ...overrides,
});

let seq = 0;
/** A year-long row of `lessons` × 60 minutes in årskurs 4-6 unless said otherwise. */
const row = (overrides: Partial<LoadRequirement> = {}): LoadRequirement => ({
  id: `req-${(seq += 1)}`,
  subjectId: 'ma',
  subjectName: 'Matematik',
  studentGroupId: 'g-5a',
  groupName: '5A',
  teacherId: ANNA,
  coTeacherId: null,
  lessonsPerWeek: 15,
  minutesPerLesson: 60,
  teacherLoadPercent: 100,
  coTeacherLoadPercent: 100,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  gradeSpan: { min: 4, max: 6 },
  ...overrides,
});

const scope = (
  input: Partial<LoadInput>,
  versions: ScopeVersion[] = [VERSION],
  options: Parameters<typeof buildScopeReport>[3] = {},
) => {
  const full: LoadInput = {
    year: YEAR,
    policy: { ...DEFAULT_LOAD_POLICY, fullTimeTeachingMinutesPerWeek: 1080 },
    employments: [employment()],
    requirements: [row()],
    qualifications: [],
    closures: [],
    duties: [],
    ...input,
  };
  return buildScopeReport(full, buildTeacherLoadReport(full), versions, options);
};

const of = (report: ReturnType<typeof scope>, userId = ANNA): TeacherScope => {
  const found = report.teachers.find((teacher) => teacher.userId === userId);
  if (!found) throw new Error(`no scope row for ${userId}`);
  return found;
};

describe('the figures are the ordinance\'s, and the migration puts in the same', () => {
  const dir = join(__dirname, '..', '..', 'prisma', 'migrations');
  const name = readdirSync(dir).find((entry) => entry.startsWith('20270301090000_'));
  const sql = name ? readFileSync(join(dir, name, 'migration.sql'), 'utf8') : '';

  it('has the migration', () => {
    expect(name).toBeDefined();
  });

  it.each([LOW, HIGH])('seeds the band for årskurs $gradeFrom-$gradeTo exactly as stated in the ordinance', (band) => {
    const tuple =
      `('${band.schoolForm}', '${band.gradeNumbering}', ${band.gradeFrom}, ${band.gradeTo}, ${band.teachingHoursLow}, ${band.teachingHoursHigh}, ` +
      `${band.planningFloorPercent}, '${band.teachingSection}', '${band.planningSection}',`;
    expect(sql).toContain(tuple);
  });

  it('puts the ordinance in force on the day it says: 2027-07-01', () => {
    expect(sql).toContain("DATE '2027-07-01'");
    expect(ORDINANCE.validFrom).toBe('2027-07-01');
  });
});

describe('versionInForce', () => {
  it('holds from its first day and not the day before', () => {
    expect(versionInForce([ORDINANCE], '2027-07-01')?.code).toBe('SFS2026:1487');
    expect(versionInForce([ORDINANCE], '2027-06-30')).toBeNull();
  });

  it('holds to its last day, inclusive, and the next lydelse takes over the day after', () => {
    const closed: ScopeVersion = { ...ORDINANCE, validTo: '2029-12-31' };
    const next: ScopeVersion = { ...ORDINANCE, code: 'NEXT', validFrom: '2030-01-01', validTo: null };
    expect(versionInForce([closed, next], '2029-12-31')?.code).toBe('SFS2026:1487');
    expect(versionInForce([closed, next], '2030-01-01')?.code).toBe('NEXT');
  });

  it('judges a läsår by its first day: 2027/28 is in force, 2026/27 is not', () => {
    expect(scope({ year: { startDate: '2027-08-16', endDate: '2028-06-09' } }, [ORDINANCE]).version?.code).toBe('SFS2026:1487');
    const before = scope({}, [ORDINANCE]);
    expect(before.version).toBeNull();
    expect(before.yearReason).toBe('NOT_IN_FORCE');
    expect(of(before).verdict).toBe('NOT_JUDGED');
  });

  it('judges a year that starts on the day it comes into force', () => {
    expect(scope({ year: { startDate: '2027-07-01', endDate: '2028-06-09' } }, [ORDINANCE]).version).not.toBeNull();
    expect(scope({ year: { startDate: '2027-06-30', endDate: '2028-06-09' } }, [ORDINANCE]).version).toBeNull();
  });
});

describe('the teaching hours of the year', () => {
  it('is the lessons\' own minutes over the weeks they run: 15 × 60 min × 43 weeks is 645 h', () => {
    const anna = of(scope({}));
    expect(anna.teachingHours).toBe(645);
    expect(anna.stages).toEqual([
      { gradeFrom: 1, gradeTo: 6, hours: 645, teachingHoursLow: 550, teachingHoursHigh: 650, planningFloorPercent: 100 },
    ]);
  });

  it('counts a row of varannan vecka in the weeks it runs: 2 × 60 min × 22 odd weeks is 44 h, so 689 h with the 645', () => {
    const anna = of(scope({ requirements: [row(), row({ lessonsPerWeek: 2, recurrence: 'ODD_WEEKS', subjectId: 'no' })] }));
    expect(anna.teachingHours).toBe(689);
  });

  it('counts a row that runs a term in the term\'s weeks (the same arithmetic as the timplan page)', () => {
    const autumn = { startDate: '2026-08-17', endDate: '2026-12-18' };
    const weeks = teachingWeeks(autumn, YEAR, [], 5);
    const anna = of(scope({ requirements: [row({ lessonsPerWeek: 4, ...autumn })] }));
    expect(anna.teachingHours).toBe(Math.round(((4 * 60 * weeks) / 60) * 10) / 10);
    expect(anna.teachingHours).toBeGreaterThan(0);
    expect(anna.teachingHours).toBeLessThan(4 * 43);
  });

  it('takes lov out of the weeks a row runs', () => {
    const noClosure = of(scope({})).teachingHours;
    const withLov = of(scope({ closures: [{ startDate: '2026-10-26', endDate: '2026-10-30' }] })).teachingHours;
    expect(noClosure - withLov).toBe(15);
  });

  it('is never weighted: not by the row\'s percentage, not by the subject\'s factor', () => {
    expect(of(scope({ requirements: [row({ teacherLoadPercent: 50 })] })).teachingHours).toBe(645);
    expect(of(scope({ requirements: [row({ teacherLoadPercent: 200 })] })).teachingHours).toBe(645);
    expect(of(scope({ requirements: [row({ loadWeight: 2.5 })] })).teachingHours).toBe(645);
  });

  it('counts the co-teacher\'s whole row and each teacher\'s own lessons of a shared row', () => {
    const together = scope({ employments: [employment(), employment({ userId: BO, signature: 'BO' })], requirements: [row({ lessonsPerWeek: 3, coTeacherId: BO })] });
    expect(of(together).teachingHours).toBe(129);
    expect(of(together, BO).teachingHours).toBe(129);
    const shared = scope({
      employments: [employment(), employment({ userId: BO, signature: 'BO' })],
      requirements: [row({ lessonsPerWeek: 3, shares: [{ teacherId: BO, lessons: 1, minutes: 60 }] })],
    });
    expect(of(shared).teachingHours).toBe(86);
    expect(of(shared, BO).teachingHours).toBe(43);
  });

  it('does not count an uppdrag, whether or not the school counts it against the riktmärke', () => {
    const duty: LoadDuty = { userId: ANNA, minutesPerWeek: 120, countsAsTeaching: true };
    expect(of(scope({ duties: [duty] })).teachingHours).toBe(645);
  });
});

describe('the verdict against the span (3 §)', () => {
  it('is INSIDE up to and including the upper edge: 645 h against 650', () => {
    const anna = of(scope({}));
    expect(anna.verdict).toBe('INSIDE');
    expect(anna.ordinanceHighestHours).toBe(650);
    expect(anna.highestHours).toBe(650);
  });

  it('is OVER_MAX above it: 17 × 60 × 43 = 731 h against 650', () => {
    const anna = of(scope({ requirements: [row({ lessonsPerWeek: 17 })] }));
    expect(anna.teachingHours).toBe(731);
    expect(anna.verdict).toBe('OVER_MAX');
  });

  it('is judged on the printed figures: 650.0 prints and is not over 650.0, 650.7 is', () => {
    // 907 min a week over 43 weeks is 39 001 min, 650.0167 h, printed 650.0; 908 is 650.7.
    expect(of(scope({ requirements: [row({ lessonsPerWeek: 1, minutesPerLesson: 907 })] })).verdict).toBe('INSIDE');
    expect(of(scope({ requirements: [row({ lessonsPerWeek: 1, minutesPerLesson: 908 })] })).verdict).toBe('OVER_MAX');
  });

  it('uses the stricter edge for åk 7-9: 14 × 60 × 43 = 602 h against 600', () => {
    const anna = of(scope({ requirements: [row({ lessonsPerWeek: 14, gradeSpan: { min: 7, max: 9 } })] }));
    expect(anna.teachingHours).toBe(602);
    expect(anna.verdict).toBe('OVER_MAX');
    expect(anna.ordinanceHighestHours).toBe(600);
    expect(of(scope({ requirements: [row({ lessonsPerWeek: 13, gradeSpan: { min: 7, max: 9 } })] })).verdict).toBe('INSIDE');
  });

  it('shows the lower edge too, and says INSIDE between the two edges (the rektor\'s call under 8 §)', () => {
    const anna = of(scope({ requirements: [row({ lessonsPerWeek: 13 })] }));
    expect(anna.teachingHours).toBe(559);
    expect(anna.fullTimeLowestHours).toBe(550);
    expect(anna.verdict).toBe('INSIDE');
  });
});

describe('part-time (3 § second paragraph)', () => {
  it('scales the span by the post: 80 % has 520 h as its upper edge', () => {
    const anna = of(scope({ employments: [employment({ employmentPercent: 80 })], requirements: [row({ lessonsPerWeek: 10 })] }));
    expect(anna.ordinanceHighestHours).toBe(520);
    expect(anna.teachingHours).toBe(430);
    expect(anna.verdict).toBe('INSIDE');
    expect(of(scope({ employments: [employment({ employmentPercent: 80 })], requirements: [row({ lessonsPerWeek: 14 })] })).verdict).toBe('OVER_MAX');
  });

  it('takes the nedsättning out of the post, as partial leave is working time the teacher does not have', () => {
    const anna = of(scope({ employments: [employment({ employmentPercent: 100, reductionPercent: 20 })] }));
    expect(anna.ordinanceHighestHours).toBe(520);
    expect(anna.verdict).toBe('OVER_MAX');
  });

  it('weights a post that changes in the year by its teaching weeks, as the regulated hours are', () => {
    const changing = employment({
      employmentPercent: 100,
      periods: [{ validFrom: '2026-11-02', validTo: '2027-06-11', employmentPercent: 50, reductionPercent: 0, teachingTargetMinutesPerWeek: null } as never],
    });
    const anna = of(scope({ employments: [changing] }));
    // Strictly between a half and a whole post: 325 h and 650 h.
    expect(anna.ordinanceHighestHours).toBeGreaterThan(325);
    expect(anna.ordinanceHighestHours).toBeLessThan(650);
  });
});

describe('a teacher in two stages (T2: blended by hours)', () => {
  const mixed = [row({ lessonsPerWeek: 15 }), row({ lessonsPerWeek: 5, gradeSpan: { min: 7, max: 9 }, subjectId: 'no' })];

  it('blends the edges by the hours in each stage: 645 h at 650 and 215 h at 600 is 637.5', () => {
    const anna = of(scope({ requirements: mixed }));
    expect(anna.teachingHours).toBe(860);
    expect(anna.fullTimeHighestHours).toBe(637.5);
    expect(anna.fullTimeLowestHours).toBe(537.5);
    expect(anna.stages.map((stage) => stage.hours)).toEqual([645, 215]);
    expect(anna.verdict).toBe('OVER_MAX');
  });

  it('adds up the planning floor per stage: 645 × 100 % + 215 × 110 % is 881.5 h', () => {
    expect(of(scope({ requirements: mixed })).planningFloorHours).toBe(881.5);
  });

  it('reads a group over both stages in the STRICTER one (6-7: 600 h and 110 %)', () => {
    const anna = of(scope({ requirements: [row({ lessonsPerWeek: 10, gradeSpan: { min: 6, max: 7 } })] }));
    expect(anna.stages).toHaveLength(1);
    expect(anna.stages[0]).toMatchObject({ gradeFrom: 7, gradeTo: 9, hours: 430, teachingHoursHigh: 600 });
    expect(anna.planningFloorHours).toBe(473);
  });
});

describe('what is outside the ordinance', () => {
  it('counts förskoleklassen in the total but gives it no band (prop. 2025/26:196 s. 43-44)', () => {
    const anna = of(scope({ requirements: [row({ lessonsPerWeek: 10 }), row({ lessonsPerWeek: 5, gradeSpan: { min: 0, max: 0 }, subjectId: 'sv' })] }));
    expect(anna.teachingHours).toBe(645);
    expect(anna.unregulatedHours).toBe(215);
    expect(anna.stages.map((stage) => stage.hours)).toEqual([430]);
    // Time is time: the total counts against the edge of the stage the teacher is in.
    expect(anna.verdict).toBe('INSIDE');
    expect(anna.planningFloorHours).toBe(430);
  });

  it('says NO_STAGE for a teacher whose only teaching is in förskoleklass', () => {
    const anna = of(scope({ requirements: [row({ gradeSpan: { min: 0, max: 0 } })] }));
    expect(anna.verdict).toBe('NOT_JUDGED');
    expect(anna.notJudged).toBe('NO_STAGE');
    expect(anna.teachingHours).toBe(645);
  });

  it('reads a group of förskoleklass and åk 1-2 in the band it touches', () => {
    const anna = of(scope({ requirements: [row({ lessonsPerWeek: 10, gradeSpan: { min: 0, max: 2 } })] }));
    expect(anna.stages).toHaveLength(1);
    expect(anna.stages[0]).toMatchObject({ gradeFrom: 1, gradeTo: 6, hours: 430 });
    expect(anna.unregulatedHours).toBe(0);
  });

  it('keeps a group with no derivable årskurs as unknown hours: counted, not placed', () => {
    const anna = of(scope({ requirements: [row({ lessonsPerWeek: 10 }), row({ lessonsPerWeek: 5, gradeSpan: null, subjectId: 'sv' })] }));
    expect(anna.teachingHours).toBe(645);
    expect(anna.unknownGradeHours).toBe(215);
    expect(anna.stages.map((stage) => stage.hours)).toEqual([430]);
  });

  it('is not judged without a post: the span cannot be scaled', () => {
    const anna = of(scope({ employments: [] }));
    expect(anna.verdict).toBe('NOT_JUDGED');
    expect(anna.notJudged).toBe('NO_POST');
    expect(anna.fullTimeHighestHours).toBe(650);
    expect(anna.highestHours).toBeNull();
  });

  it('is not judged without teaching, and a teacher with a post and no rows is still listed', () => {
    const anna = of(scope({ requirements: [] }));
    expect(anna.notJudged).toBe('NO_TEACHING');
    expect(anna.teachingHours).toBe(0);
  });

  it('gives the ten-year numbering no verdict: the ordinance has no band for it until it is changed', () => {
    const report = scope({ year: { ...YEAR, gradeNumbering: 'TIOARIG' } });
    expect(report.yearReason).toBe('NUMBERING_NOT_COVERED');
    expect(of(report).verdict).toBe('NOT_JUDGED');
    expect(of(report).teachingHours).toBe(645);
    expect(of(report).stages).toEqual([]);
  });

  it('judges a ten-year year once a version has bands in that numbering (data, not code)', () => {
    const tenYear: ScopeVersion = {
      ...VERSION,
      bands: [{ ...LOW, gradeNumbering: 'TIOARIG', gradeFrom: 1, gradeTo: 7 }, { ...HIGH, gradeNumbering: 'TIOARIG', gradeFrom: 8, gradeTo: 10 }],
    };
    const report = scope({ year: { ...YEAR, gradeNumbering: 'TIOARIG' }, requirements: [row({ gradeSpan: { min: 5, max: 7 } })] }, [tenYear]);
    expect(report.yearReason).toBeNull();
    expect(of(report).stages[0]).toMatchObject({ gradeFrom: 1, gradeTo: 7, hours: 645 });
  });

  it('ignores a band of another school form', () => {
    const other: ScopeVersion = { ...VERSION, bands: [{ ...LOW, schoolForm: 'SPECIALSKOLA' }] };
    expect(scope({}, [other]).yearReason).toBe('NUMBERING_NOT_COVERED');
  });
});

describe('a teacher\'s own level within the span (8 §)', () => {
  it('is OVER_OWN above the own level and not over the ordinance: 645 h against an own 600', () => {
    const anna = of(scope({}, [VERSION], { ownLevelHours: new Map([[ANNA, 600]]) }));
    expect(anna.verdict).toBe('OVER_OWN');
    expect(anna.highestHours).toBe(600);
    expect(anna.ordinanceHighestHours).toBe(650);
  });

  it('is still OVER_MAX above the ordinance, whatever the own level says', () => {
    const anna = of(scope({ requirements: [row({ lessonsPerWeek: 17 })] }, [VERSION], { ownLevelHours: new Map([[ANNA, 600]]) }));
    expect(anna.verdict).toBe('OVER_MAX');
  });

  it('never lifts the edge: an own level above the ordinance is the ordinance', () => {
    const anna = of(scope({}, [VERSION], { ownLevelHours: new Map([[ANNA, 900]]) }));
    expect(anna.highestHours).toBe(650);
  });

  it('scales with the post like the span itself', () => {
    const anna = of(scope({ employments: [employment({ employmentPercent: 50 })], requirements: [row({ lessonsPerWeek: 7 })] }, [VERSION], { ownLevelHours: new Map([[ANNA, 600]]) }));
    expect(anna.highestHours).toBe(300);
  });
});

describe('planning and follow-up (4 §, 5 §)', () => {
  it('is at least the teaching time in åk 1-6: 645 h of teaching is 645 h of planning', () => {
    expect(of(scope({})).planningFloorHours).toBe(645);
  });

  it('is 110 % in åk 7-9: 13 × 60 × 43 = 559 h is 614.9 h', () => {
    expect(of(scope({ requirements: [row({ lessonsPerWeek: 13, gradeSpan: { min: 8, max: 8 } })] })).planningFloorHours).toBe(614.9);
  });

  it('fits in a full ferietjänst when the year holds teaching, the floor and the uppdrag: 1 767 - 645 - 0 = 1 122 h', () => {
    const anna = of(scope({}));
    expect(anna.remainingHours).toBe(1122);
    expect(anna.planningFits).toBe(true);
  });

  it('does not fit when the uppdrag take the year: 700 min a week over 43 weeks is 501.7 h, leaving 620.3 h for a floor of 645', () => {
    const anna = of(scope({ duties: [{ userId: ANNA, minutesPerWeek: 700, countsAsTeaching: false }] }));
    expect(anna.remainingHours).toBe(620.3);
    expect(anna.planningFits).toBe(false);
  });

  it('is known only for a ferietjänst: a semestertjänst has no year figure', () => {
    const anna = of(scope({ employments: [employment({ contractKind: 'SEMESTER' })] }));
    expect(anna.remainingHours).toBeNull();
    expect(anna.planningFits).toBeNull();
    expect(anna.planningFloorHours).toBe(645);
  });

  it('scales the working time by the post: 50 % of 1 767 is 883.5 h, less 322.5 h of teaching, is 561 h', () => {
    const anna = of(scope({ employments: [employment({ employmentPercent: 50 })], requirements: [row({ lessonsPerWeek: 7.5 })] }));
    expect(anna.teachingHours).toBe(322.5);
    expect(anna.remainingHours).toBe(561);
  });
});

describe('what a reader without HR-läs gets (hr-visibility.ts)', () => {
  it('keeps the verdict and the floor and loses every figure that gives the post back', () => {
    const hidden = hideScopeHr(of(scope({ employments: [employment({ employmentPercent: 80 })], requirements: [row({ lessonsPerWeek: 14 })] })));
    expect(hidden.verdict).toBe('OVER_MAX');
    expect(hidden.teachingHours).toBe(602);
    expect(hidden.planningFloorHours).toBe(602);
    expect(hidden.fullTimeHighestHours).toBe(650);
    expect(hidden.highestHours).toBeNull();
    expect(hidden.ordinanceHighestHours).toBeNull();
    expect(hidden.remainingHours).toBeNull();
    expect(hidden.planningFits).toBeNull();
  });
});

describe('placeSpan', () => {
  it('places a span in the band it lies in, in the stricter of two, and nowhere outside the bands', () => {
    const bands = [LOW, HIGH];
    expect(placeSpan({ min: 3, max: 3 }, bands)).toEqual({ kind: 'BAND', band: LOW });
    expect(placeSpan({ min: 8, max: 9 }, bands)).toEqual({ kind: 'BAND', band: HIGH });
    expect(placeSpan({ min: 5, max: 8 }, bands)).toEqual({ kind: 'BAND', band: HIGH });
    expect(placeSpan({ min: 0, max: 0 }, bands)).toEqual({ kind: 'UNREGULATED' });
    expect(placeSpan({ min: 10, max: 12 }, bands)).toEqual({ kind: 'UNREGULATED' });
    expect(placeSpan(null, bands)).toEqual({ kind: 'UNKNOWN' });
  });
});
