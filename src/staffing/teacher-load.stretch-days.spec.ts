import { buildTeacherLoadReport, DEFAULT_LOAD_POLICY, yearTargetMinutesPerWeek, type LoadEmployment, type LoadInput, type LoadRequirement } from './teacher-load';

/**
 * What L-5 moves besides the annual figures (granskningen av #400). A stretch of a post that changes during the year is weighted by its
 * school days, so the year's target, the saldo and the percentage of a post that changes, the stretches' `teachingWeeks`, and which stretch
 * is judged at all, follow the weeks counted in school days too, and not only `annual` and `scope`. The läsår starts on a Saturday (the
 * production year of 2025/26's shape): 15 August to 11 June is 43 weeks of school days, 21 before the Monday 11 January and 22 from it,
 * where a whole-week count says 22 + 22 = 44, for a week before the first Monday that holds no lesson. The counted minutes are the same.
 */
const YEAR = { startDate: '2026-08-15', endDate: '2027-06-11' };
const POLICY = { ...DEFAULT_LOAD_POLICY, fullTimeTeachingMinutesPerWeek: 1080, fullTimeRegulatedHoursPerYear: 1360 };
const row: LoadRequirement = {
  id: 'r1',
  subjectId: 'ma',
  subjectName: 'Matematik',
  studentGroupId: 'g1',
  groupName: '5A',
  teacherId: 'anna',
  coTeacherId: null,
  lessonsPerWeek: 17,
  minutesPerLesson: 50,
  teacherLoadPercent: 100,
  coTeacherLoadPercent: 100,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  gradeSpan: { min: 5, max: 5 },
};
const post = (employmentPercent: number, periods: LoadEmployment['periods']): LoadEmployment => ({
  userId: 'anna',
  employmentPercent,
  reductionPercent: 0,
  contractKind: 'FERIE',
  teachingTargetMinutesPerWeek: null,
  signature: 'ANNA',
  periods,
});
const inputOf = (employment: LoadEmployment): LoadInput => ({
  year: YEAR,
  policy: POLICY,
  employments: [employment],
  requirements: [row],
  qualifications: [],
  closures: [],
  duties: [],
});
const period = (validFrom: string, employmentPercent: number) => ({ validFrom, validTo: null, employmentPercent, reductionPercent: 0, teachingTargetMinutesPerWeek: null });
const annaOf = (input: LoadInput) => buildTeacherLoadReport(input).teachers.find((teacher) => teacher.userId === 'anna')!;

describe('a post that changes during a läsår that starts on a Saturday', () => {
  it('weights the year by school days: 21 weeks at 1 080 and 22 at 650 minutes is a target of 860, and not 865 of 22 + 22', () => {
    const input = inputOf(post(100, [period('2027-01-11', 60)]));
    const anna = annaOf(input);
    // 60 % of a post is a target of 650 (the riktmärke is rounded to five minutes): (1 080 × 21 + 650 × 22) / 43 = 860.0. A whole-week count
    // has (1 080 × 22 + 650 × 22) / 44 = 865.
    expect(anna.targetMinutesPerWeek).toBe(860);
    expect(yearTargetMinutesPerWeek(input, input.employments[0]!)).toBe(860);
    expect(anna.balanceMinutesPerWeek).toBe(10);
    expect(anna.percentOfTarget).toBe(98.8);
    expect(anna.periods.map((one) => one.teachingWeeks)).toEqual([21, 22]);
    // The regulated hours follow the same weights: 79.5 % of 1 360 h, and not 80 % (1 088 h).
    expect(anna.annual.regulatedHoursPerYear).toBe(1081.7);
    // What the stretches count is untouched: the counted minutes, in the year and in each stretch.
    expect(anna.countedMinutesPerWeek).toBe(850);
    expect(anna.periods.map((one) => one.countedMinutesPerWeek)).toEqual([850, 850]);
    expect(anna.status).toBe('OVER');
  });

  it('leaves the standardvecka alone: a term course is its whole weeks over the stretch\'s whole weeks, 16 of 22 in the autumn and 16 of 44 in the year', () => {
    // 180 minutes a week from Wednesday 2 September to Friday 18 December: 16 weeks touched, all in the first stretch (22 whole weeks, from
    // Saturday 15 August). 850 + 180 × 16 / 22 = 980.9 in the stretch and 850 + 180 × 16 / 44 = 915.5 in the year. Counted in school days it
    // would be 15.6 / 21 and 15.6 / 43: 983.7 and 915.3. The weeks of the annual figures are school days; the standardvecka is not.
    const term: LoadRequirement = { ...row, id: 'r2', studentGroupId: 'g2', groupName: '5B', lessonsPerWeek: 3, minutesPerLesson: 60, startDate: '2026-09-02', endDate: '2026-12-18' };
    const input = { ...inputOf(post(100, [period('2027-01-11', 60)])), requirements: [row, term] };
    const anna = annaOf(input);
    expect(anna.periods.map((one) => one.countedMinutesPerWeek)).toEqual([981, 850]);
    expect(anna.countedMinutesPerWeek).toBe(915);
    expect(anna.assignedMinutesPerWeek).toBe(915);
  });

  it('judges no stretch that holds only the weekend: a base stretch of Saturday and Sunday before a period from the first Monday has no school day', () => {
    // 50 % until the weekend is over and 100 % from Monday 17 August: the base stretch is 15-16 August, which holds no lesson. Judged as a
    // week it would be OVER (850 against 540), and the post OVER all year; it has no teaching week, so the post is UNDER at its 100 %.
    const anna = annaOf(inputOf(post(50, [period('2026-08-17', 100)])));
    expect(anna.periods.map((one) => one.teachingWeeks)).toEqual([0, 43]);
    expect(anna.targetMinutesPerWeek).toBe(1080);
    expect(anna.balanceMinutesPerWeek).toBe(230);
    expect(anna.status).toBe('UNDER');
    expect(anna.countedMinutesPerWeek).toBe(850);
  });
});
