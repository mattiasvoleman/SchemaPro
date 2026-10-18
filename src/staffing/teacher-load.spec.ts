import {
  DEFAULT_LOAD_POLICY,
  buildTeacherLoadReport,
  chargedMinutes,
  countedMinutesByTeacher,
  loadStatus,
  percentOfTarget,
  qualificationCovers,
  round5,
  standardWeekWeight,
  strongestCoveringQualification,
  targetMinutesPerWeek,
  type JudgedYear,
  type LoadDuty,
  type LoadEmployment,
  type LoadInput,
  type LoadPolicy,
  type LoadQualification,
  type LoadRequirement,
} from './teacher-load';

/*
 * The same läsår the teaching-hours suites use: 2026-08-17 to 2027-06-11, 43
 * ISO weeks, 22 odd and 21 even, because ISO 2026 has a week 53.
 */
const YEAR = { startDate: '2026-08-17', endDate: '2027-06-11' };
const ANNA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MA = 'ma-subject';
const NO = 'no-subject';

const policy = (overrides: Partial<LoadPolicy> = {}): LoadPolicy => ({
  ...DEFAULT_LOAD_POLICY,
  fullTimeTeachingMinutesPerWeek: 1080,
  ...overrides,
});

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
const requirement = (overrides: Partial<LoadRequirement> = {}): LoadRequirement => ({
  id: `req-${(seq += 1)}`,
  subjectId: MA,
  subjectName: 'Matematik',
  studentGroupId: 'g-7a',
  groupName: '7A',
  teacherId: ANNA,
  coTeacherId: null,
  lessonsPerWeek: 3,
  minutesPerLesson: 60,
  teacherLoadPercent: 100,
  coTeacherLoadPercent: 100,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  gradeSpan: { min: 7, max: 7 },
  ...overrides,
});

const qualification = (overrides: Partial<LoadQualification> = {}): LoadQualification => ({
  userId: ANNA,
  subjectId: MA,
  minGradeLevel: 7,
  maxGradeLevel: 9,
  kind: 'LEGITIMATION',
  validFrom: null,
  validTo: null,
  ...overrides,
});

const report = (overrides: Partial<LoadInput> = {}) =>
  buildTeacherLoadReport({
    year: YEAR,
    policy: policy(),
    employments: [employment()],
    requirements: [requirement()],
    qualifications: [],
    closures: [],
    duties: [],
    ...overrides,
  });

const duty = (overrides: Partial<LoadDuty> = {}): LoadDuty => ({
  userId: ANNA,
  minutesPerWeek: 60,
  countsAsTeaching: false,
  ...overrides,
});

const teacherRow = (input: Partial<LoadInput>, userId = ANNA) => {
  const row = report(input).teachers.find((teacher) => teacher.userId === userId);
  if (!row) throw new Error(`no row for ${userId}`);
  return row;
};

describe('round5', () => {
  it('rounds to the solver grid, halves up', () => {
    expect(round5(862)).toBe(860);
    expect(round5(863)).toBe(865);
    expect(round5(862.5)).toBe(865);
    expect(round5(0)).toBe(0);
  });
});

describe('targetMinutesPerWeek', () => {
  it('derives riktmärke × (tjänst − nedsättning) / 100 on the five-minute grid', () => {
    expect(targetMinutesPerWeek(employment(), policy())).toBe(1080);
    expect(targetMinutesPerWeek(employment({ employmentPercent: 80 }), policy())).toBe(865);
    expect(
      targetMinutesPerWeek(
        employment({ employmentPercent: 80, reductionPercent: 20 }),
        policy(),
      ),
    ).toBe(650);
  });

  it('is null with no post, and null when the school has set no riktmärke', () => {
    expect(targetMinutesPerWeek(null, policy())).toBeNull();
    expect(
      targetMinutesPerWeek(employment(), policy({ fullTimeTeachingMinutesPerWeek: null })),
    ).toBeNull();
  });

  it('lets the teacher’s own target win, even over a missing riktmärke', () => {
    expect(
      targetMinutesPerWeek(
        employment({ teachingTargetMinutesPerWeek: 900 }),
        policy({ fullTimeTeachingMinutesPerWeek: null }),
      ),
    ).toBe(900);
    expect(
      targetMinutesPerWeek(employment({ teachingTargetMinutesPerWeek: 0 }), policy()),
    ).toBe(0);
  });
});

describe('loadStatus', () => {
  it('reads the tolerance band inclusively at both edges', () => {
    // 1080 ± 10 % = 972..1188.
    expect(loadStatus(1188, 1080, 10)).toBe('OK');
    expect(loadStatus(1189, 1080, 10)).toBe('OVER');
    expect(loadStatus(972, 1080, 10)).toBe('OK');
    expect(loadStatus(971, 1080, 10)).toBe('UNDER');
  });

  it('judges the whole minutes the report prints beside it', () => {
    // Load percentages and odd weeks make fractions ordinary; the matrix shows
    // Math.round(counted), and a status of OVER beside "990" against a
    // 990 limit would contradict the figure next to it.
    expect(loadStatus(990.15, 900, 10)).toBe('OK');
    expect(loadStatus(990.5, 900, 10)).toBe('OVER');
    expect(loadStatus(809.6, 900, 10)).toBe('OK');
    expect(loadStatus(809.4, 900, 10)).toBe('UNDER');
  });

  it('with zero tolerance only the exact target is OK', () => {
    expect(loadStatus(1080, 1080, 0)).toBe('OK');
    expect(loadStatus(1081, 1080, 0)).toBe('OVER');
    expect(loadStatus(1079, 1080, 0)).toBe('UNDER');
  });

  it('is NO_TARGET without a target, whatever is assigned', () => {
    expect(loadStatus(2000, null, 10)).toBe('NO_TARGET');
    expect(loadStatus(0, null, 10)).toBe('NO_TARGET');
  });
});

describe('standardWeekWeight', () => {
  it('weighs undated rows flat: every week 1, varannan vecka 0.5', () => {
    expect(standardWeekWeight({}, YEAR, [])).toBe(1);
    expect(standardWeekWeight({ recurrence: 'ODD_WEEKS' }, YEAR, [])).toBe(0.5);
    expect(standardWeekWeight({ recurrence: 'EVEN_WEEKS' }, YEAR, [])).toBe(0.5);
  });

  it('weighs a dated row by its share of the year’s teaching weeks', () => {
    // Autumn 2026-09-02..2026-12-18 is 16 of the year's 43 weeks.
    expect(
      standardWeekWeight({ startDate: '2026-09-02', endDate: '2026-12-18' }, YEAR, []),
    ).toBeCloseTo(16 / 43, 10);
  });

  it('subtracts lov from both sides of the fraction', () => {
    // Jullov takes 3 weeks off the year (43 → 40) and none off an autumn course
    // that ends before it, so the course's share rises.
    const jullov = { startDate: '2026-12-21', endDate: '2027-01-08' };
    expect(
      standardWeekWeight({ startDate: '2026-09-02', endDate: '2026-12-18' }, YEAR, [jullov]),
    ).toBeCloseTo(16 / 40, 10);
  });

  it('weighs an odd-week autumn course at its odd weeks only', () => {
    // Weeks 36..51 hold 8 odd weeks.
    expect(
      standardWeekWeight(
        { recurrence: 'ODD_WEEKS', startDate: '2026-09-02', endDate: '2026-12-18' },
        YEAR,
        [],
      ),
    ).toBeCloseTo(8 / 43, 10);
  });

  it('weighs nothing for a year with no teaching weeks', () => {
    expect(
      standardWeekWeight(
        { startDate: '2026-09-01' },
        { startDate: '2027-01-01', endDate: '2026-01-01' },
        [],
      ),
    ).toBe(0);
  });

  it('applies a grade-spanned studiedag only to a single-grade group', () => {
    const lagStudiedag = {
      startDate: '2026-09-14',
      endDate: '2026-09-14',
      minGradeLevel: 0,
      maxGradeLevel: 3,
    };
    const spring = { startDate: '2027-01-11' };
    // The course is in spring, the studiedag in autumn: the numerator is
    // unchanged and only the year's denominator moves — and only for åk 2.
    expect(
      standardWeekWeight({ ...spring, gradeSpan: { min: 2, max: 2 } }, YEAR, [lagStudiedag]),
    ).toBeCloseTo(22 / 42.8, 10);
    expect(
      standardWeekWeight({ ...spring, gradeSpan: { min: 2, max: 4 } }, YEAR, [lagStudiedag]),
    ).toBeCloseTo(22 / 43, 10);
    expect(
      standardWeekWeight({ ...spring, gradeSpan: null }, YEAR, [lagStudiedag]),
    ).toBeCloseTo(22 / 43, 10);
  });
});

describe('buildTeacherLoadReport', () => {
  describe('the standardvecka', () => {
    it('sums lessons × minutes for every requirement naming the teacher', () => {
      const row = teacherRow({
        requirements: [
          requirement({ lessonsPerWeek: 3, minutesPerLesson: 60 }),
          requirement({ subjectId: NO, subjectName: 'NO', lessonsPerWeek: 2, minutesPerLesson: 45 }),
        ],
      });
      expect(row.assignedMinutesPerWeek).toBe(270);
      expect(row.requirementCount).toBe(2);
    });

    it('counts a co-taught row fully for both teachers, and once in lesson minutes', () => {
      const result = report({
        employments: [employment(), employment({ userId: BO, signature: 'BO' })],
        requirements: [requirement({ coTeacherId: BO, lessonsPerWeek: 2, minutesPerLesson: 60 })],
      });
      const anna = result.teachers.find((t) => t.userId === ANNA)!;
      const bo = result.teachers.find((t) => t.userId === BO)!;
      expect(anna.assignedMinutesPerWeek).toBe(120);
      expect(bo.assignedMinutesPerWeek).toBe(120);
      expect(result.totals).toEqual({
        teacherMinutesPerWeek: 240,
        lessonMinutesPerWeek: 120,
        dutyMinutesPerWeek: 0,
      });
    });

    it('counts odd and even weeks at half each, so the pair makes a whole', () => {
      const row = teacherRow({
        requirements: [
          requirement({ recurrence: 'ODD_WEEKS', lessonsPerWeek: 2, minutesPerLesson: 60 }),
          requirement({ recurrence: 'EVEN_WEEKS', lessonsPerWeek: 2, minutesPerLesson: 60 }),
        ],
      });
      expect(row.assignedMinutesPerWeek).toBe(120);
      // The busiest week carries one of them, not both.
      expect(row.peakMinutesPerWeek).toBe(120);
    });

    it('weighs a term course by its share of the year, and rounds to whole minutes', () => {
      const row = teacherRow({
        requirements: [
          requirement({
            lessonsPerWeek: 4,
            minutesPerLesson: 60,
            startDate: '2026-09-02',
            endDate: '2026-12-18',
          }),
        ],
      });
      // 240 × 16 / 43 = 89.30…
      expect(row.assignedMinutesPerWeek).toBe(89);
    });

    it('sums whole-year minutes once for every week of the year in the annual figure', () => {
      const row = teacherRow({
        requirements: [requirement({ lessonsPerWeek: 2, minutesPerLesson: 60 })],
        closures: [{ startDate: '2026-12-21', endDate: '2027-01-08' }],
      });
      // 120 minutes × 40 teaching weeks / 60.
      expect(row.annual.assignedHoursPerYear).toBe(80);
    });
  });

  describe('the toppvecka', () => {
    it('is the week a term course and a year course collide in', () => {
      const row = teacherRow({
        requirements: [
          requirement({ lessonsPerWeek: 10, minutesPerLesson: 60 }),
          requirement({
            subjectId: NO,
            subjectName: 'NO',
            lessonsPerWeek: 4,
            minutesPerLesson: 60,
            startDate: '2026-09-01',
            endDate: '2026-12-18',
          }),
          requirement({
            subjectId: 'sv',
            subjectName: 'Svenska',
            lessonsPerWeek: 4,
            minutesPerLesson: 60,
            startDate: '2027-01-11',
          }),
        ],
      });
      expect(row.peakMinutesPerWeek).toBe(840);
      // 600 + 240 × 16/43 + 240 × 22/43 = 600 + 212.09…
      expect(row.assignedMinutesPerWeek).toBe(812);
    });

    it('is the teacher’s own peak, not the school’s', () => {
      const result = report({
        employments: [employment(), employment({ userId: BO, signature: 'BO' })],
        requirements: [
          requirement({ lessonsPerWeek: 5, minutesPerLesson: 60 }),
          requirement({ teacherId: BO, lessonsPerWeek: 3, minutesPerLesson: 60 }),
        ],
      });
      expect(result.teachers.find((t) => t.userId === ANNA)!.peakMinutesPerWeek).toBe(300);
      expect(result.teachers.find((t) => t.userId === BO)!.peakMinutesPerWeek).toBe(180);
    });
  });

  describe('target and status', () => {
    it('derives the target from the post and reads the balance against it', () => {
      const row = teacherRow({
        employments: [employment({ employmentPercent: 80 })],
        requirements: [requirement({ lessonsPerWeek: 10, minutesPerLesson: 60 })],
      });
      expect(row.targetMinutesPerWeek).toBe(865);
      expect(row.balanceMinutesPerWeek).toBe(265);
      expect(row.percentOfTarget).toBe(69.4);
      expect(row.status).toBe('UNDER');
    });

    it('states percentOfTarget through the exported helper the staffing proposal reads', () => {
      const rows: Partial<LoadInput> = {
        employments: [employment({ employmentPercent: 80 }), employment({ userId: BO, teachingTargetMinutesPerWeek: 0 })],
        requirements: [
          requirement({ lessonsPerWeek: 7, minutesPerLesson: 55, teacherLoadPercent: 37 }),
          requirement({ teacherId: BO }),
        ],
        duties: [duty({ countsAsTeaching: true, minutesPerWeek: 33 })],
      };
      const full = report(rows);
      const counted = countedMinutesByTeacher({ year: YEAR, closures: [], duties: rows.duties!, requirements: rows.requirements! });
      expect(full.teachers.map((row) => row.userId).sort()).toEqual([ANNA, BO]);
      for (const row of full.teachers) {
        expect(percentOfTarget(counted.get(row.userId) ?? 0, row.targetMinutesPerWeek)).toBe(row.percentOfTarget);
      }
      expect(full.teachers.find((row) => row.userId === ANNA)!.percentOfTarget).not.toBeNull();
      expect(percentOfTarget(500, null)).toBeNull();
      expect(percentOfTarget(500, 0)).toBeNull();
      expect(percentOfTarget(142.45, 990)).toBe(14.4);
    });

    it('is OVER one minute past the tolerance and OK on it', () => {
      // Target 1080, tolerance 10 % → 1188 is the edge.
      const onTheEdge = teacherRow({
        requirements: [requirement({ lessonsPerWeek: 22, minutesPerLesson: 54 })], // 1188
      });
      expect(onTheEdge.status).toBe('OK');
      const past = teacherRow({
        requirements: [
          requirement({ lessonsPerWeek: 22, minutesPerLesson: 54 }),
          requirement({ subjectId: NO, subjectName: 'NO', lessonsPerWeek: 1, minutesPerLesson: 15 }),
        ],
        policy: policy({ overAllocationTolerancePercent: 10 }),
      });
      // 1203 > 1188
      expect(past.status).toBe('OVER');
      expect(past.balanceMinutesPerWeek).toBe(-123);
    });

    it('is NO_TARGET for every teacher when the school has set no riktmärke', () => {
      const result = report({
        policy: policy({ fullTimeTeachingMinutesPerWeek: null }),
        requirements: [requirement({ lessonsPerWeek: 40, minutesPerLesson: 60 })],
      });
      expect(result.teachers[0]).toMatchObject({
        status: 'NO_TARGET',
        targetMinutesPerWeek: null,
        balanceMinutesPerWeek: null,
        percentOfTarget: null,
        assignedMinutesPerWeek: 2400,
      });
    });

    it('reads a school with no policy row as the table defaults: no riktmärke, WARN, 1360 h, 194 days', () => {
      const result = report({ policy: null });
      expect(result.teachers[0]).toMatchObject({
        status: 'NO_TARGET',
        annual: { regulatedHoursPerYear: 1360, workDaysPerYear: 194 },
      });
    });

    it('is NO_TARGET for a teacher on requirements with no post, and still lists them', () => {
      const result = report({
        employments: [],
        requirements: [requirement({ teacherId: BO })],
      });
      expect(result.teachers).toHaveLength(1);
      expect(result.teachers[0]).toMatchObject({
        userId: BO,
        employment: null,
        status: 'NO_TARGET',
        assignedMinutesPerWeek: 180,
        annual: { regulatedHoursPerYear: null },
      });
    });

    it('lists a teacher with a post and nothing assigned as UNDER at zero', () => {
      const result = report({ requirements: [] });
      expect(result.teachers[0]).toMatchObject({
        userId: ANNA,
        status: 'UNDER',
        assignedMinutesPerWeek: 0,
        peakMinutesPerWeek: 0,
        requirementCount: 0,
        subjects: [],
        percentOfTarget: 0,
      });
    });

    it('sorts OVER first, then UNDER, OK and NO_TARGET, then by id', () => {
      const CILLA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      const result = report({
        employments: [
          employment({ userId: CILLA, signature: 'C' }), // UNDER
          employment({ userId: BO, signature: 'B' }), // OVER
          employment(), // OK
        ],
        requirements: [
          requirement({ teacherId: CILLA, lessonsPerWeek: 1 }),
          requirement({ teacherId: BO, lessonsPerWeek: 30 }),
          requirement({ teacherId: ANNA, lessonsPerWeek: 18 }),
          requirement({ teacherId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', lessonsPerWeek: 1 }),
        ],
      });
      expect(result.teachers.map((t) => t.status)).toEqual(['OVER', 'UNDER', 'OK', 'NO_TARGET']);
    });
  });

  describe('per subject', () => {
    it('gives the SCB figure: 80 % post with 600 of 900 in Ma is 53,3 % Ma and 26,7 % NO', () => {
      const row = teacherRow({
        employments: [employment({ employmentPercent: 80 })],
        requirements: [
          requirement({ lessonsPerWeek: 10, minutesPerLesson: 60 }),
          requirement({ subjectId: NO, subjectName: 'NO', lessonsPerWeek: 5, minutesPerLesson: 60 }),
        ],
      });
      expect(row.subjects).toEqual([
        {
          subjectId: MA,
          subjectName: 'Matematik',
          minutesPerWeek: 600,
          shareOfTeaching: 0.6667,
          percentOfEmployment: 53.3,
          percentOfFullTime: 55.6,
        },
        {
          subjectId: NO,
          subjectName: 'NO',
          minutesPerWeek: 300,
          shareOfTeaching: 0.3333,
          percentOfEmployment: 26.7,
          percentOfFullTime: 27.8,
        },
      ]);
    });

    it('takes the share on unrounded minutes, so two half-weighted rows still split 50/50', () => {
      const row = teacherRow({
        requirements: [
          requirement({ recurrence: 'ODD_WEEKS', lessonsPerWeek: 1, minutesPerLesson: 45 }),
          requirement({
            subjectId: NO,
            subjectName: 'NO',
            recurrence: 'EVEN_WEEKS',
            lessonsPerWeek: 1,
            minutesPerLesson: 45,
          }),
        ],
      });
      // 22.5 each, rounded to 23 and 22 would still be two halves.
      expect(row.subjects.map((s) => s.shareOfTeaching)).toEqual([0.5, 0.5]);
      expect(row.subjects.map((s) => s.percentOfEmployment)).toEqual([50, 50]);
      expect(row.assignedMinutesPerWeek).toBe(45);
    });

    it('merges two groups in the same subject into one subject row', () => {
      const row = teacherRow({
        requirements: [
          requirement({ studentGroupId: 'g-7a', groupName: '7A', lessonsPerWeek: 3 }),
          requirement({ studentGroupId: 'g-7b', groupName: '7B', lessonsPerWeek: 3 }),
        ],
      });
      expect(row.subjects).toHaveLength(1);
      expect(row.subjects[0]!.minutesPerWeek).toBe(360);
      expect(row.subjects[0]!.shareOfTeaching).toBe(1);
    });

    it('leaves the percent columns null where their denominator is missing', () => {
      const row = teacherRow({
        employments: [],
        policy: policy({ fullTimeTeachingMinutesPerWeek: null }),
      });
      expect(row.subjects[0]).toMatchObject({
        percentOfEmployment: null,
        percentOfFullTime: null,
        shareOfTeaching: 1,
      });
    });
  });

  describe('unstaffed requirements', () => {
    it('lists a row with no lead teacher, with its standardvecka minutes, and charges nobody', () => {
      const result = report({
        requirements: [
          requirement({ teacherId: null, recurrence: 'ODD_WEEKS', lessonsPerWeek: 2, minutesPerLesson: 60 }),
        ],
      });
      expect(result.unstaffedRequirements).toEqual([
        {
          requirementId: expect.any(String),
          subjectId: MA,
          subjectName: 'Matematik',
          studentGroupId: 'g-7a',
          groupName: '7A',
          minutesPerWeek: 60,
          teacherMinutesPerWeek: 60,
          gradeSpan: { min: 7, max: 7 },
        },
      ]);
      expect(result.teachers[0]!.assignedMinutesPerWeek).toBe(0);
      expect(result.totals.lessonMinutesPerWeek).toBe(60);
    });

    it('still charges a co-teacher on a row whose lead is missing', () => {
      const result = report({
        employments: [],
        requirements: [requirement({ teacherId: null, coTeacherId: BO })],
      });
      expect(result.unstaffedRequirements).toHaveLength(1);
      expect(result.teachers[0]).toMatchObject({ userId: BO, assignedMinutesPerWeek: 180 });
    });
  });

  describe('unqualified assignments', () => {
    it('checks nothing, and says so, when the school has recorded no qualifications', () => {
      const result = report({ qualifications: [] });
      expect(result.qualificationsRecorded).toBe(false);
      expect(result.unqualifiedAssignments).toEqual([]);
    });

    it('checks nothing when the policy turns the check OFF', () => {
      const result = report({
        policy: policy({ qualificationMode: 'OFF' }),
        qualifications: [qualification({ userId: BO })],
      });
      expect(result.qualificationsRecorded).toBe(true);
      expect(result.unqualifiedAssignments).toEqual([]);
    });

    it('flags a teacher with no qualification in the subject once any colleague has one', () => {
      const result = report({ qualifications: [qualification({ userId: BO })] });
      expect(result.unqualifiedAssignments).toEqual([
        {
          requirementId: expect.any(String),
          userId: ANNA,
          role: 'TEACHER',
          subjectId: MA,
          subjectName: 'Matematik',
          studentGroupId: 'g-7a',
          groupName: '7A',
          gradeSpan: { min: 7, max: 7 },
        },
      ]);
    });

    it('accepts a qualification whose span contains the group’s whole span, and refuses one that does not', () => {
      const covered = report({
        requirements: [requirement({ gradeSpan: { min: 7, max: 9 } })],
        qualifications: [qualification({ minGradeLevel: 7, maxGradeLevel: 9 })],
      });
      expect(covered.unqualifiedAssignments).toEqual([]);

      const halfCovered = report({
        requirements: [requirement({ gradeSpan: { min: 6, max: 7 } })],
        qualifications: [qualification({ minGradeLevel: 7, maxGradeLevel: 9 })],
      });
      expect(halfCovered.unqualifiedAssignments).toHaveLength(1);
    });

    it('accepts any qualification in the subject for a group with no derivable grade', () => {
      const result = report({
        requirements: [requirement({ gradeSpan: null })],
        qualifications: [qualification({ minGradeLevel: 1, maxGradeLevel: 3 })],
      });
      expect(result.unqualifiedAssignments).toEqual([]);
    });

    it('ignores a qualification that expired before the year, or starts after it', () => {
      const expired = report({
        qualifications: [qualification({ validTo: '2026-06-30' })],
      });
      expect(expired.unqualifiedAssignments).toHaveLength(1);
      const future = report({
        qualifications: [qualification({ validFrom: '2027-08-01' })],
      });
      expect(future.unqualifiedAssignments).toHaveLength(1);
      const expiringMidYear = report({
        qualifications: [qualification({ validTo: '2026-12-31' })],
      });
      expect(expiringMidYear.unqualifiedAssignments).toEqual([]);
    });

    it('checks the co-teacher too, under their own role', () => {
      const result = report({
        requirements: [requirement({ coTeacherId: BO })],
        qualifications: [qualification()],
      });
      expect(result.unqualifiedAssignments).toEqual([
        expect.objectContaining({ userId: BO, role: 'CO_TEACHER' }),
      ]);
    });
  });
});

describe('qualificationCovers', () => {
  it('is false for another subject whatever the span', () => {
    expect(
      qualificationCovers(
        qualification({ subjectId: NO, minGradeLevel: 0, maxGradeLevel: 12 }),
        { subjectId: MA, gradeSpan: { min: 7, max: 7 } },
        YEAR,
      ),
    ).toBe(false);
  });

  it('reads the span inclusively at both ends', () => {
    expect(
      qualificationCovers(
        qualification({ minGradeLevel: 7, maxGradeLevel: 9 }),
        { subjectId: MA, gradeSpan: { min: 7, max: 9 } },
        YEAR,
      ),
    ).toBe(true);
  });
});

describe('Fas 2: each teacher is charged the row’s own percentage', () => {
  const pair = (overrides: Partial<LoadRequirement>) =>
    report({
      employments: [employment(), employment({ userId: BO, signature: 'BO' })],
      requirements: [requirement({ coTeacherId: BO, lessonsPerWeek: 4, ...overrides })],
    });
  const rowOf = (result: ReturnType<typeof report>, userId: string) =>
    result.teachers.find((t) => t.userId === userId)!;

  it('charges a co-teacher at 50 % half the row, and the lesson minutes stay whole', () => {
    const result = pair({ coTeacherLoadPercent: 50 });
    expect(rowOf(result, ANNA).assignedMinutesPerWeek).toBe(240);
    expect(rowOf(result, BO).assignedMinutesPerWeek).toBe(120);
    expect(rowOf(result, BO).peakMinutesPerWeek).toBe(120);
    expect(result.totals).toMatchObject({ teacherMinutesPerWeek: 360, lessonMinutesPerWeek: 240 });
  });

  it('keeps a co-teacher at 0 % on the row — a resurslärare in the room — at zero minutes', () => {
    const result = pair({ coTeacherLoadPercent: 0 });
    const bo = rowOf(result, BO);
    expect(bo.assignedMinutesPerWeek).toBe(0);
    expect(bo.requirementCount).toBe(1);
    expect(bo.subjects).toEqual([
      expect.objectContaining({ subjectId: MA, minutesPerWeek: 0, shareOfTeaching: 0, percentOfEmployment: 0 }),
    ]);
    expect(bo.annual.assignedHoursPerYear).toBe(0);
  });

  it('charges a lead at 200 % double, in the standardvecka, the toppvecka and the year', () => {
    const result = report({
      requirements: [requirement({ lessonsPerWeek: 2, minutesPerLesson: 55, teacherLoadPercent: 200 })],
    });
    const anna = rowOf(result, ANNA);
    expect(anna.assignedMinutesPerWeek).toBe(220);
    expect(anna.peakMinutesPerWeek).toBe(220);
    // 110 × 43 weeks × 2 / 60.
    expect(anna.annual.assignedHoursPerYear).toBe(157.7);
    expect(result.totals.lessonMinutesPerWeek).toBe(110);
  });

  it('applies the percentage on top of the odd/even half, and the peak at the charged share', () => {
    const result = report({
      requirements: [
        requirement({ recurrence: 'ODD_WEEKS', lessonsPerWeek: 2, minutesPerLesson: 80, teacherLoadPercent: 50 }),
        requirement({ recurrence: 'EVEN_WEEKS', lessonsPerWeek: 2, minutesPerLesson: 80, teacherLoadPercent: 75 }),
      ],
    });
    const anna = rowOf(result, ANNA);
    // 160 × ½ × 0.5 + 160 × ½ × 0.75.
    expect(anna.assignedMinutesPerWeek).toBe(100);
    // An odd week charges 80, an even week 120.
    expect(anna.peakMinutesPerWeek).toBe(120);
  });

  it('reports what an unstaffed row would charge its lead beside its lesson minutes', () => {
    const result = report({
      requirements: [requirement({ teacherId: null, lessonsPerWeek: 4, teacherLoadPercent: 50 })],
    });
    expect(result.unstaffedRequirements[0]).toMatchObject({ minutesPerWeek: 240, teacherMinutesPerWeek: 120 });
  });

  it('is the Fas 1 report exactly when both percentages are 100', () => {
    const base = pair({});
    expect(rowOf(base, ANNA).assignedMinutesPerWeek).toBe(240);
    expect(rowOf(base, BO).assignedMinutesPerWeek).toBe(240);
  });

  it('chargedMinutes states the three figures one row is worth', () => {
    expect(
      chargedMinutes(
        requirement({ lessonsPerWeek: 3, recurrence: 'ODD_WEEKS', teacherLoadPercent: 150, coTeacherLoadPercent: 50 }),
        YEAR,
        [],
      ),
    ).toEqual({ lesson: 90, teacher: 135, coTeacher: 45 });
  });
});

describe('Fas 2: uppdrag', () => {
  it('adds a counted uppdrag to the minutes the target reads, and only draws an uncounted one', () => {
    const row = teacherRow({
      requirements: [requirement({ lessonsPerWeek: 15 })],
      duties: [duty({ minutesPerWeek: 60 }), duty({ minutesPerWeek: 120, countsAsTeaching: true })],
    });
    expect(row).toMatchObject({
      assignedMinutesPerWeek: 900,
      dutyMinutesPerWeek: 180,
      countedDutyMinutesPerWeek: 120,
      countedMinutesPerWeek: 1020,
      balanceMinutesPerWeek: 60,
      percentOfTarget: 94.4,
      status: 'OK',
      dutyCount: 2,
    });
  });

  it('can push a teacher OVER with a counted uppdrag, never with an uncounted one', () => {
    const own = { employments: [employment({ teachingTargetMinutesPerWeek: 600 })] };
    const requirements = [requirement({ lessonsPerWeek: 10 })];
    expect(
      teacherRow({ ...own, requirements, duties: [duty({ minutesPerWeek: 400 })] }).status,
    ).toBe('OK');
    expect(
      teacherRow({
        ...own,
        requirements,
        duties: [duty({ minutesPerWeek: 61, countsAsTeaching: true })],
      }).status,
    ).toBe('OVER');
    // 600 + 60 is exactly the tolerance edge: still OK.
    expect(
      teacherRow({
        ...own,
        requirements,
        duties: [duty({ minutesPerWeek: 60, countsAsTeaching: true })],
      }).status,
    ).toBe('OK');
  });

  it('keeps percentOfEmployment a share of the teaching, whatever the uppdrag', () => {
    const row = teacherRow({
      employments: [employment({ employmentPercent: 80 })],
      requirements: [requirement({ lessonsPerWeek: 10 }), requirement({ subjectId: NO, subjectName: 'NO', lessonsPerWeek: 5 })],
      duties: [duty({ minutesPerWeek: 300, countsAsTeaching: true })],
    });
    expect(row.subjects.map((s) => s.percentOfEmployment)).toEqual([53.3, 26.7]);
  });

  it('makes a teacher with only an uppdrag a row of their own, NO_TARGET without a post', () => {
    const result = report({
      employments: [],
      requirements: [],
      duties: [duty({ userId: BO, minutesPerWeek: 40 })],
    });
    expect(result.teachers).toEqual([
      expect.objectContaining({
        userId: BO,
        status: 'NO_TARGET',
        assignedMinutesPerWeek: 0,
        dutyMinutesPerWeek: 40,
        countedMinutesPerWeek: 0,
        requirementCount: 0,
        dutyCount: 1,
      }),
    ]);
    expect(result.totals.dutyMinutesPerWeek).toBe(40);
  });

  it('leaves uppdrag out of the teaching’s toppvecka and annual hours, and keeps their own beside them', () => {
    const row = teacherRow({
      requirements: [requirement({ lessonsPerWeek: 2 })],
      duties: [duty({ minutesPerWeek: 120, countsAsTeaching: true })],
    });
    expect(row.peakMinutesPerWeek).toBe(120);
    expect(row.annual.assignedHoursPerYear).toBe(86);
    // An undated uppdrag: its peak is its minutes, its year every week's.
    expect(row.dutyPeakMinutesPerWeek).toBe(120);
    expect(row.annual.dutyHoursPerYear).toBe(86);
  });
});

describe('Daterade uppdrag (20261017090000): an uppdrag counts the weeks it runs', () => {
  // 43 ISO weeks; 18 of them up to 2026-12-18.
  const untilJul = (overrides: Partial<LoadDuty> = {}) => duty({ minutesPerWeek: 90, validTo: '2026-12-18', ...overrides });

  it('charges a dated uppdrag its share of the year’s weeks, its whole minutes in its own toppvecka, and its weeks in the annual hours', () => {
    const row = teacherRow({ requirements: [], duties: [untilJul()] });
    expect(row.dutyMinutesPerWeek).toBe(Math.round((90 * 18) / 43));
    expect(row.dutyPeakMinutesPerWeek).toBe(90);
    expect(row.annual.dutyHoursPerYear).toBe(27);
    expect(row.dutyCount).toBe(1);
  });

  it('leaves an undated uppdrag exactly what it was: the dates are absent, null or both', () => {
    for (const shape of [{}, { validFrom: null, validTo: null }]) {
      const row = teacherRow({ requirements: [], duties: [duty({ minutesPerWeek: 90, ...shape })] });
      expect(row).toMatchObject({ dutyMinutesPerWeek: 90, dutyPeakMinutesPerWeek: 90 });
      expect(row.annual.dutyHoursPerYear).toBe(round1Of((90 * 43) / 60));
    }
  });

  it('meets the target only in its weeks, and the write-time figure is the report’s', () => {
    const own = { employments: [employment({ teachingTargetMinutesPerWeek: 600 })] };
    const requirements = [requirement({ lessonsPerWeek: 10 })];
    // 120 counted minutes all year would push 600 to 720, OVER; until the
    // jullov they weigh 18/43 of that, 50, inside the tolerance.
    const undated = teacherRow({ ...own, requirements, duties: [duty({ minutesPerWeek: 120, countsAsTeaching: true })] });
    const dated = teacherRow({ ...own, requirements, duties: [untilJul({ minutesPerWeek: 120, countsAsTeaching: true })] });
    expect(undated.status).toBe('OVER');
    expect(dated).toMatchObject({ status: 'OK', countedDutyMinutesPerWeek: 50, countedMinutesPerWeek: 650 });
    const counted = countedMinutesByTeacher({
      year: YEAR,
      closures: [],
      requirements,
      duties: [untilJul({ minutesPerWeek: 120, countsAsTeaching: true })],
    });
    expect(Math.round(counted.get(ANNA)!)).toBe(dated.countedMinutesPerWeek);
  });

  it('adds two dated uppdrag that never meet into the standardvecka, but not into the toppvecka', () => {
    const row = teacherRow({
      requirements: [],
      duties: [untilJul({ minutesPerWeek: 60 }), duty({ minutesPerWeek: 90, validFrom: '2027-01-04' })],
    });
    expect(row.dutyPeakMinutesPerWeek).toBe(90);
    expect(row.dutyMinutesPerWeek).toBe(Math.round((60 * 18 + 90 * 23) / 43));
  });
});

const round1Of = (value: number) => Math.round(value * 10) / 10;

describe('Fas 2: ämnesflaskhalsar', () => {
  const CY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const unstaffed = (overrides: Partial<LoadRequirement> = {}) =>
    requirement({ teacherId: null, studentGroupId: 'g-8a', groupName: '8A', lessonsPerWeek: 4, ...overrides });

  it('is not computed at all when the school has recorded no behörighet', () => {
    const result = report({ requirements: [unstaffed()], qualifications: [] });
    expect(result.bottlenecksComputed).toBe(false);
    expect(result.subjectBottlenecks).toEqual([]);
  });

  it('is computed whatever the qualificationMode — capacity is not a warning', () => {
    const result = report({
      policy: policy({ qualificationMode: 'OFF' }),
      requirements: [unstaffed()],
      qualifications: [qualification()],
    });
    expect(result.bottlenecksComputed).toBe(true);
    expect(result.subjectBottlenecks).toHaveLength(1);
  });

  it('sums target − counted over the qualified, at the lead’s percentage, and is short past it', () => {
    const result = report({
      employments: [employment({ teachingTargetMinutesPerWeek: 600 })],
      requirements: [
        requirement({ lessonsPerWeek: 5 }),
        unstaffed({ lessonsPerWeek: 4 }),
        unstaffed({ id: 'half', studentGroupId: 'g-8b', groupName: '8B', lessonsPerWeek: 4, teacherLoadPercent: 50 }),
      ],
      qualifications: [qualification()],
      duties: [duty({ minutesPerWeek: 60, countsAsTeaching: true }), duty({ minutesPerWeek: 500 })],
    });
    // Anna: 600 − (300 + 60 counted) = 240 left; the uncounted 500 consume nothing.
    expect(result.subjectBottlenecks).toEqual([
      {
        subjectId: MA,
        subjectName: 'Matematik',
        unstaffedCount: 2,
        demandedMinutesPerWeek: 360,
        qualifiedRemainingMinutesPerWeek: 240,
        qualifiedTeacherCount: 1,
        qualifiedNoTargetCount: 0,
        short: true,
      },
    ]);
  });

  it('counts a qualified teacher with no target apart, and adds nothing for them', () => {
    const result = report({
      employments: [],
      requirements: [unstaffed()],
      qualifications: [qualification(), qualification({ userId: BO, kind: 'TILLATEN' })],
    });
    expect(result.subjectBottlenecks[0]).toMatchObject({
      qualifiedRemainingMinutesPerWeek: 0,
      qualifiedTeacherCount: 0,
      qualifiedNoTargetCount: 2,
      short: true,
    });
  });

  it('ignores an expired behörighet, and adds zero — never a negative — for an over-target teacher', () => {
    const result = report({
      employments: [
        employment({ teachingTargetMinutesPerWeek: 300 }),
        employment({ userId: BO, signature: 'BO' }),
        employment({ userId: CY, signature: 'CY', teachingTargetMinutesPerWeek: 200 }),
      ],
      requirements: [requirement({ lessonsPerWeek: 10 }), unstaffed({ lessonsPerWeek: 1 })],
      qualifications: [
        qualification(),
        qualification({ userId: BO, validTo: '2026-06-30' }),
        qualification({ userId: CY }),
      ],
    });
    // Anna 300 − 600 → 0, Bo's legitimation ended before the year, Cy 200.
    expect(result.subjectBottlenecks[0]).toMatchObject({
      demandedMinutesPerWeek: 60,
      qualifiedRemainingMinutesPerWeek: 200,
      qualifiedTeacherCount: 2,
      short: false,
    });
  });

  it('counts no capacity for a deactivated holder, whom Föreslå lärare never offers', () => {
    // Deactivating a teacher keeps their post and behörigheter (users.service
    // allows it). Their 1 080 minutes used to read as room in Matematik while
    // the picker, which ranks active staff only, had nobody qualified to show.
    const result = report({
      employments: [employment()],
      requirements: [unstaffed()],
      qualifications: [qualification()],
      inactiveUserIds: [ANNA],
    });
    expect(result.bottlenecksComputed).toBe(true);
    expect(result.subjectBottlenecks[0]).toMatchObject({
      qualifiedRemainingMinutesPerWeek: 0,
      qualifiedTeacherCount: 0,
      qualifiedNoTargetCount: 0,
      short: true,
    });
  });

  it('takes a behörighet in the subject at any span as capacity, and none in another subject', () => {
    const result = report({
      employments: [employment()],
      requirements: [unstaffed({ gradeSpan: { min: 9, max: 9 } })],
      qualifications: [
        qualification({ minGradeLevel: 1, maxGradeLevel: 3 }),
        qualification({ userId: BO, subjectId: NO }),
      ],
    });
    expect(result.subjectBottlenecks[0]).toMatchObject({ qualifiedRemainingMinutesPerWeek: 1080, qualifiedTeacherCount: 1 });
  });

  it('lists only subjects with an unstaffed row, short ones first by deficit', () => {
    const result = report({
      employments: [employment()],
      requirements: [
        requirement({ subjectId: 'sv', subjectName: 'Svenska', lessonsPerWeek: 2 }),
        unstaffed({ subjectId: 'bi', subjectName: 'Biologi', lessonsPerWeek: 2 }),
        unstaffed({ subjectId: 'tk', subjectName: 'Teknik', lessonsPerWeek: 5 }),
        unstaffed({ lessonsPerWeek: 1 }),
      ],
      qualifications: [qualification()],
    });
    expect(result.subjectBottlenecks.map((b) => [b.subjectId, b.short])).toEqual([
      ['tk', true],
      ['bi', true],
      [MA, false],
    ]);
  });
});

describe('strongestCoveringQualification', () => {
  it('picks LEGITIMATION over BEHORIG over TILLATEN among the ones that cover', () => {
    const held = [
      qualification({ kind: 'TILLATEN' }),
      qualification({ kind: 'LEGITIMATION', minGradeLevel: 1, maxGradeLevel: 6 }),
      qualification({ kind: 'BEHORIG' }),
      qualification({ userId: BO, kind: 'LEGITIMATION' }),
    ];
    expect(
      strongestCoveringQualification(held, ANNA, { subjectId: MA, gradeSpan: { min: 7, max: 9 } }, YEAR),
    ).toBe('BEHORIG');
  });

  it('is null for nobody covering, including an expired row', () => {
    expect(
      strongestCoveringQualification(
        [qualification({ validTo: '2026-08-16' })],
        ANNA,
        { subjectId: MA, gradeSpan: { min: 7, max: 7 } },
        YEAR,
      ),
    ).toBeNull();
  });
});

/*
 * Tioårig grundskola (SFS 2025:729). A behörighet is stated in the nine-year
 * numbering for good (grade-numbering.ts): a tioårig läsår's årskurs is one
 * higher than the same åldersband in a nioårig one, so its 10A is the 9 a
 * "7–9" holds, its 8–10 the 7–9, and its 11 (specialskolan's) the NIOARIG 10
 * the same "7–9" does not reach. The year carries its numbering only when it
 * is tioårig; a nioårig year — the field absent or NIOARIG — is judged raw, as
 * it always was. What the report names stays in the year's own numbering.
 */
describe('Tioårig grundskola: a behörighet is judged in NIOARIG through the year’s numbering', () => {
  // The first tioårig läsår (TIOARIG_FROM is 2028-07-01).
  const TIOARIG_YEAR: JudgedYear = { startDate: '2028-08-21', endDate: '2029-06-15', gradeNumbering: 'TIOARIG' };
  const NIOARIG_YEAR: JudgedYear = { startDate: '2027-08-16', endDate: '2028-06-09', gradeNumbering: 'NIOARIG' };
  const NINE_YEAR_AS_ALWAYS: JudgedYear = { startDate: '2027-08-16', endDate: '2028-06-09' };
  const sevenToNine = qualification({ minGradeLevel: 7, maxGradeLevel: 9 });
  const covers = (q: LoadQualification, min: number, max: number, year: JudgedYear) =>
    qualificationCovers(q, { subjectId: MA, gradeSpan: { min, max } }, year);

  describe('qualificationCovers', () => {
    it('holds a tioårig 10A with a 7–9 behörighet, and the whole tioårig högstadium 8–10', () => {
      expect(covers(sevenToNine, 10, 10, TIOARIG_YEAR)).toBe(true);
      expect(covers(sevenToNine, 8, 10, TIOARIG_YEAR)).toBe(true);
    });

    it('does not hold the tioårig 11 (NIOARIG 10) or 7 (NIOARIG 6) with a 7–9 behörighet', () => {
      expect(covers(sevenToNine, 11, 11, TIOARIG_YEAR)).toBe(false);
      expect(covers(sevenToNine, 7, 7, TIOARIG_YEAR)).toBe(false);
      expect(covers(sevenToNine, 9, 11, TIOARIG_YEAR)).toBe(false);
    });

    it('reads a tioårig lågstadium 2–4 as the NIOARIG 1–3, and its åk 1 as förskoleklassens åldersband', () => {
      const oneToThree = qualification({ minGradeLevel: 1, maxGradeLevel: 3 });
      const fToThree = qualification({ minGradeLevel: 0, maxGradeLevel: 3 });
      expect(covers(oneToThree, 2, 4, TIOARIG_YEAR)).toBe(true);
      // Tioårig åk 1 is NIOARIG F (toNioarig): a 1–3 does not reach it, an F–3 does.
      expect(covers(oneToThree, 1, 1, TIOARIG_YEAR)).toBe(false);
      expect(covers(fToThree, 1, 4, TIOARIG_YEAR)).toBe(true);
    });

    it('judges a nioårig year raw, the numbering stated or absent: its 10 is past a 7–9', () => {
      for (const year of [NIOARIG_YEAR, NINE_YEAR_AS_ALWAYS]) {
        expect(covers(sevenToNine, 9, 9, year)).toBe(true);
        expect(covers(sevenToNine, 7, 9, year)).toBe(true);
        expect(covers(sevenToNine, 10, 10, year)).toBe(false);
        expect(covers(sevenToNine, 6, 6, year)).toBe(false);
      }
    });

    it('still covers a span it cannot judge, and still reads the subject and validity against the year’s bounds', () => {
      expect(qualificationCovers(sevenToNine, { subjectId: MA, gradeSpan: null }, TIOARIG_YEAR)).toBe(true);
      // Expired the summer before the tioårig läsår: no span makes it valid.
      expect(covers(qualification({ validTo: '2028-06-30' }), 10, 10, TIOARIG_YEAR)).toBe(false);
      expect(
        qualificationCovers(
          qualification({ subjectId: NO }),
          { subjectId: MA, gradeSpan: { min: 10, max: 10 } },
          TIOARIG_YEAR,
        ),
      ).toBe(false);
    });
  });

  describe('strongestCoveringQualification', () => {
    it('picks among the rows that hold the tioårig span read in NIOARIG', () => {
      const held = [
        // NIOARIG 10–10: holds the tioårig 11 only, not the 10A's NIOARIG 9.
        qualification({ kind: 'LEGITIMATION', minGradeLevel: 10, maxGradeLevel: 10 }),
        qualification({ kind: 'TILLATEN', minGradeLevel: 7, maxGradeLevel: 9 }),
        qualification({ kind: 'BEHORIG', minGradeLevel: 4, maxGradeLevel: 9 }),
      ];
      const tenA = { subjectId: MA, gradeSpan: { min: 10, max: 10 } };
      expect(strongestCoveringQualification(held, ANNA, tenA, TIOARIG_YEAR)).toBe('BEHORIG');
      // The same 10 in a nioårig year is specialskolan's 10: only the 10–10 row holds it.
      expect(strongestCoveringQualification(held, ANNA, tenA, NINE_YEAR_AS_ALWAYS)).toBe('LEGITIMATION');
      expect(strongestCoveringQualification(held, ANNA, tenA, NIOARIG_YEAR)).toBe('LEGITIMATION');
    });

    it('is null for the tioårig 11 against a 7–9, whoever else holds it', () => {
      expect(
        strongestCoveringQualification(
          [sevenToNine, qualification({ userId: BO, minGradeLevel: 10, maxGradeLevel: 10 })],
          ANNA,
          { subjectId: MA, gradeSpan: { min: 11, max: 11 } },
          TIOARIG_YEAR,
        ),
      ).toBeNull();
    });
  });

  describe('buildTeacherLoadReport', () => {
    const reportOn = (gradeSpan: { min: number; max: number }, year: JudgedYear) =>
      report({
        year,
        requirements: [requirement({ id: 'req-x', gradeSpan, studentGroupId: 'g-x', groupName: `${gradeSpan.min}A` })],
        qualifications: [sevenToNine],
      });

    it('flags no tioårig 10A taught under a 7–9 behörighet, and flags the 11 with its span as the year numbers it', () => {
      expect(reportOn({ min: 10, max: 10 }, TIOARIG_YEAR).unqualifiedAssignments).toEqual([]);
      expect(reportOn({ min: 11, max: 11 }, TIOARIG_YEAR).unqualifiedAssignments).toEqual([
        expect.objectContaining({ userId: ANNA, role: 'TEACHER', groupName: '11A', gradeSpan: { min: 11, max: 11 } }),
      ]);
    });

    it('flags the same 10A in a nioårig year, as it always did', () => {
      expect(reportOn({ min: 10, max: 10 }, NINE_YEAR_AS_ALWAYS).unqualifiedAssignments).toEqual([
        expect.objectContaining({ userId: ANNA, gradeSpan: { min: 10, max: 10 } }),
      ]);
      expect(reportOn({ min: 10, max: 10 }, NIOARIG_YEAR).unqualifiedAssignments).toHaveLength(1);
    });

    it('changes nothing but the behörighet: the minutes, the target and the status are the nioårig ones', () => {
      const bounds = { startDate: '2028-08-21', endDate: '2029-06-15' };
      const tioarig = reportOn({ min: 10, max: 10 }, { ...bounds, gradeNumbering: 'TIOARIG' });
      const nioarig = reportOn({ min: 10, max: 10 }, bounds);
      expect(tioarig.teachers).toEqual(nioarig.teachers);
      expect(tioarig.unstaffedRequirements).toEqual(nioarig.unstaffedRequirements);
      expect(nioarig.unqualifiedAssignments).toHaveLength(1);
    });
  });
});
