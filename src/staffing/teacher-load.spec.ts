import {
  DEFAULT_LOAD_POLICY,
  buildTeacherLoadReport,
  loadStatus,
  qualificationCovers,
  round5,
  standardWeekWeight,
  targetMinutesPerWeek,
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
      expect(result.totals).toEqual({ teacherMinutesPerWeek: 240, lessonMinutesPerWeek: 120 });
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
