import { ConflictException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_CHECK_POLICY,
  STAFF_TEACHER_NOT_QUALIFIED,
  STAFF_TEACHER_OVER_TARGET,
  STAFF_TEACHER_OVER_TARGET_HIDDEN,
  STAFF_TEACHER_OVER_TARGET_IN_PERIOD,
  STAFF_UNSTAFFED_REQUIREMENTS,
  gradesParam,
  judgeRequirementBatch,
  judgeRequirementWrite,
  overTargetFinding,
  qualificationFinding,
  settleFindings,
  staffingSentence,
  type CheckPolicy,
  type StaffingFinding,
  type StaffingWarning,
} from './staffing-checks';
import type { JudgedYear, LoadEmployment, LoadInput, LoadQualification, LoadRequirement } from './teacher-load';

const YEAR = { startDate: '2026-08-17', endDate: '2027-06-11' };
const ANNA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MA = 'subject-ma';

const policy = (overrides: Partial<CheckPolicy> = {}): CheckPolicy => ({
  ...DEFAULT_CHECK_POLICY,
  fullTimeTeachingMinutesPerWeek: 1000,
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

const employment = (userId: string, overrides: Partial<LoadEmployment> = {}): LoadEmployment => ({
  userId,
  employmentPercent: 100,
  reductionPercent: 0,
  contractKind: 'FERIE',
  teachingTargetMinutesPerWeek: null,
  signature: null,
  ...overrides,
});

const requirement = (overrides: Partial<LoadRequirement> = {}): LoadRequirement => ({
  id: 'req-1',
  subjectId: MA,
  subjectName: 'Matematik',
  studentGroupId: 'group-7a',
  groupName: '7A',
  teacherId: null,
  coTeacherId: null,
  lessonsPerWeek: 2,
  minutesPerLesson: 60,
  teacherLoadPercent: 100,
  coTeacherLoadPercent: 100,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  gradeSpan: { min: 7, max: 9 },
  ...overrides,
});

const input = (overrides: Partial<LoadInput> = {}): LoadInput => ({
  year: YEAR,
  policy: null,
  employments: [employment(ANNA)],
  requirements: [],
  qualifications: [qualification()],
  closures: [],
  duties: [],
  ...overrides,
});

describe('gradesParam', () => {
  it('writes a span as the engine does: one year once, a range with an en dash, unknown as any', () => {
    expect(gradesParam({ min: 7, max: 7 })).toBe('7');
    expect(gradesParam({ min: 7, max: 9 })).toBe('7–9');
    expect(gradesParam(null)).toBe('any');
  });
});

describe('qualificationFinding', () => {
  const ask = (overrides: Partial<Parameters<typeof qualificationFinding>[0]> = {}) =>
    qualificationFinding({
      policy: policy(),
      qualifications: [qualification({ userId: BO })],
      userId: ANNA,
      role: 'TEACHER',
      subject: { id: MA, name: 'Matematik' },
      span: { min: 7, max: 9 },
      window: YEAR,
      ...overrides,
    });

  it('names the subject and the span, and whose role it is — never the person', () => {
    expect(ask()).toEqual({
      code: STAFF_TEACHER_NOT_QUALIFIED,
      mode: 'WARN',
      userId: ANNA,
      params: { role: 'TEACHER', subject: 'Matematik', grades: '7–9' },
    });
  });

  it('carries the mode it was asked under', () => {
    expect(ask({ policy: policy({ qualificationMode: 'REFUSE' }) })?.mode).toBe('REFUSE');
  });

  it('asks nothing under OFF', () => {
    expect(ask({ policy: policy({ qualificationMode: 'OFF' }) })).toBeNull();
  });

  it('asks nothing of a school with no behörighet rows at all', () => {
    // Not "nobody is qualified": nothing has been recorded, and the report
    // reads it the same way (qualificationsRecorded: false).
    expect(ask({ qualifications: [] })).toBeNull();
  });

  it('passes a teacher whose behörighet covers the whole span', () => {
    expect(ask({ qualifications: [qualification()] })).toBeNull();
  });

  it('refuses a span the behörighet only half covers', () => {
    expect(
      ask({ qualifications: [qualification({ minGradeLevel: 7, maxGradeLevel: 8 })] }),
    ).not.toBeNull();
  });

  it('passes any behörighet in the subject when the group has no derivable years', () => {
    expect(
      ask({ qualifications: [qualification({ minGradeLevel: 1, maxGradeLevel: 3 })], span: null }),
    ).toBeNull();
    expect(ask({ span: null })?.params.grades).toBe('any');
  });

  it('reads validity against the window: the läsår for the plan, a day for a vikarie', () => {
    const fromAugust = qualification({ validFrom: '2026-08-01' });
    // Planned in spring for a year starting in August: valid in the year.
    expect(ask({ qualifications: [fromAugust] })).toBeNull();
    // A lesson in June before it starts: not valid that day.
    expect(
      ask({ qualifications: [fromAugust], window: { startDate: '2026-06-01', endDate: '2026-06-01' } }),
    ).not.toBeNull();
  });
});

/*
 * Tioårig grundskola (SFS 2025:729). The behörighet is stated in NIOARIG; the
 * window carries the läsår's numbering when it is tioårig (JudgedYear), and
 * the span is read through it — a tioårig 10A is the 9 a "7–9" holds. The
 * finding names the årskurser as the läsår numbers them: an 11 against a
 * "7–9" says 11, never the NIOARIG 10 it was judged as.
 */
describe('qualificationFinding in a tioårig läsår', () => {
  const TIOARIG: JudgedYear = { startDate: '2028-08-21', endDate: '2029-06-15', gradeNumbering: 'TIOARIG' };
  const NIOARIG: JudgedYear = { startDate: '2027-08-16', endDate: '2028-06-09', gradeNumbering: 'NIOARIG' };
  const ask = (span: { min: number; max: number } | null, window: JudgedYear) =>
    qualificationFinding({
      policy: policy(),
      qualifications: [qualification()],
      userId: ANNA,
      role: 'TEACHER',
      subject: { id: MA, name: 'Matematik' },
      span,
      window,
    });

  it('passes a 10A, and the tioårig högstadium 8–10, under a 7–9 behörighet', () => {
    expect(ask({ min: 10, max: 10 }, TIOARIG)).toBeNull();
    expect(ask({ min: 8, max: 10 }, TIOARIG)).toBeNull();
  });

  it('names an 11 against a 7–9 as the läsår numbers it, "11", and says so in Swedish', () => {
    const finding = ask({ min: 11, max: 11 }, TIOARIG);
    expect(finding).toEqual({
      code: STAFF_TEACHER_NOT_QUALIFIED,
      mode: 'WARN',
      userId: ANNA,
      params: { role: 'TEACHER', subject: 'Matematik', grades: '11' },
    });
    expect(staffingSentence(finding!)).toBe('Läraren saknar behörighet i Matematik för åk 11.');
    // A span reaching past the behörighet names the whole span, in the year's numbering.
    expect(ask({ min: 9, max: 11 }, TIOARIG)?.params.grades).toBe('9–11');
    // A tioårig 7 is the NIOARIG 6, below the 7–9.
    expect(ask({ min: 7, max: 7 }, TIOARIG)?.params.grades).toBe('7');
  });

  it('judges a nioårig läsår raw, the numbering stated or absent: its 10 is past a 7–9', () => {
    for (const window of [NIOARIG, YEAR]) {
      expect(ask({ min: 9, max: 9 }, window)).toBeNull();
      expect(ask({ min: 10, max: 10 }, window)?.params.grades).toBe('10');
    }
  });

  it('still passes a span it cannot judge, and still reads validity against the window', () => {
    expect(ask(null, TIOARIG)).toBeNull();
    // A vikarie's day before the behörighet starts: not valid that day, whatever the numbering.
    expect(
      qualificationFinding({
        policy: policy(),
        qualifications: [qualification({ validFrom: '2028-09-01' })],
        userId: ANNA,
        role: 'SUBSTITUTE',
        subject: { id: MA, name: 'Matematik' },
        span: { min: 10, max: 10 },
        window: { startDate: '2028-08-28', endDate: '2028-08-28', gradeNumbering: 'TIOARIG' } as JudgedYear,
      })?.params,
    ).toEqual({ role: 'SUBSTITUTE', subject: 'Matematik', grades: '10' });
  });

  it('judges a timplanspost write and a batch through the input’s year the same way', () => {
    const tioarigInput = input({ year: TIOARIG });
    const tenA = requirement({ id: 'req-10a', gradeSpan: { min: 10, max: 10 }, groupName: '10A' });
    const elevenA = requirement({ id: 'req-11a', gradeSpan: { min: 11, max: 11 }, groupName: '11A' });
    const write = (after: LoadRequirement, year: LoadInput) =>
      judgeRequirementWrite({ input: year, policy: policy({ overAllocationMode: 'OFF' }), before: null, after, subjectName: 'Matematik' });

    expect(write({ ...tenA, teacherId: ANNA }, tioarigInput)).toEqual([]);
    expect(write({ ...elevenA, teacherId: ANNA }, tioarigInput)).toEqual([
      expect.objectContaining({ code: STAFF_TEACHER_NOT_QUALIFIED, params: { role: 'TEACHER', subject: 'Matematik', grades: '11' } }),
    ]);
    // The nioårig year as it always was: the 10 is not held.
    expect(write({ ...tenA, teacherId: ANNA }, input())).toEqual([
      expect.objectContaining({ code: STAFF_TEACHER_NOT_QUALIFIED, params: expect.objectContaining({ grades: '10' }) }),
    ]);

    const batch = (year: LoadInput) =>
      judgeRequirementBatch({
        input: { ...year, requirements: [tenA, elevenA] },
        policy: policy({ overAllocationMode: 'OFF' }),
        changes: [
          { requirementId: 'req-10a', teacherId: ANNA },
          { requirementId: 'req-11a', teacherId: ANNA },
        ],
      });
    expect(batch(tioarigInput)).toEqual([
      expect.objectContaining({ params: expect.objectContaining({ grades: '11' }), requirementIds: ['req-11a'] }),
    ]);
    expect(batch(input()).map((finding) => finding.requirementIds)).toEqual([['req-10a'], ['req-11a']]);
  });
});

describe('overTargetFinding', () => {
  const ask = (overrides: Partial<Parameters<typeof overTargetFinding>[0]> = {}) =>
    overTargetFinding({
      policy: policy(),
      employment: employment(ANNA),
      userId: ANNA,
      role: 'TEACHER',
      before: 1000,
      after: 1120,
      ...overrides,
    });

  it('names the minutes, the target, the limit and the tolerance', () => {
    expect(ask()).toEqual({
      code: STAFF_TEACHER_OVER_TARGET,
      mode: 'WARN',
      userId: ANNA,
      params: { role: 'TEACHER', minutes: 1120, target: 1000, limit: 1100, tolerance: 10 },
    });
  });

  it('lets exactly the limit through and refuses the first minute past it', () => {
    expect(ask({ after: 1100 })).toBeNull();
    expect(ask({ after: 1100.5 })).not.toBeNull();
  });

  it('judges the whole minutes it prints, so it never says "1 100 against a limit of 1 100"', () => {
    // 1 060 + 1 × 45 min at 89 % = 1 100.05: printed as 1 100, which is the
    // limit and not past it. It used to refuse here with minutes: 1100,
    // limit: 1100 — a sentence that contradicts itself.
    expect(ask({ before: 1060, after: 1100.05 })).toBeNull();
    expect(ask({ before: 1060, after: 1100.5 })?.params).toMatchObject({ minutes: 1101, limit: 1100 });
  });

  it('is inert for a teacher with no target', () => {
    expect(ask({ employment: null })).toBeNull();
    expect(ask({ policy: policy({ fullTimeTeachingMinutesPerWeek: null }) })).toBeNull();
  });

  it('reads a per-teacher target even without a riktmärke', () => {
    const finding = ask({
      policy: policy({ fullTimeTeachingMinutesPerWeek: null }),
      employment: employment(ANNA, { teachingTargetMinutesPerWeek: 600 }),
      after: 700,
      before: 600,
    });
    expect(finding?.params).toMatchObject({ target: 600, limit: 660, minutes: 700 });
  });

  it('never fires on a write that does not add to the load', () => {
    // A teacher already over, whose row loses a lesson: still over, and the
    // PATCH is the fix, not the problem.
    expect(ask({ before: 1300, after: 1240 })).toBeNull();
    expect(ask({ before: 1300, after: 1300 })).toBeNull();
  });

  it('asks nothing under OFF', () => {
    expect(ask({ policy: policy({ overAllocationMode: 'OFF' }) })).toBeNull();
  });
});

describe('judgeRequirementWrite', () => {
  const judge = (args: {
    input?: LoadInput;
    policy?: CheckPolicy;
    before?: LoadRequirement | null;
    after: LoadRequirement;
  }) =>
    judgeRequirementWrite({
      input: args.input ?? input(),
      policy: args.policy ?? policy(),
      before: args.before ?? null,
      after: args.after,
      subjectName: args.after.subjectName,
    });

  it('asks nothing of a row with no teacher', () => {
    expect(judge({ after: requirement() })).toEqual([]);
  });

  it('asks behörighet of a teacher newly put on the row, lead and co-teacher alike', () => {
    const findings = judge({ after: requirement({ teacherId: BO, coTeacherId: BO.replace('b', 'c') }) });
    expect(findings.map((f) => [f.code, f.params.role])).toEqual([
      [STAFF_TEACHER_NOT_QUALIFIED, 'TEACHER'],
      [STAFF_TEACHER_NOT_QUALIFIED, 'CO_TEACHER'],
    ]);
  });

  it('delade lektioner: asks behörighet of a share’s new teacher, as a teacher, after the lead', () => {
    const findings = judge({
      after: requirement({ teacherId: ANNA, lessonsPerWeek: 3, shares: [{ teacherId: BO, lessons: 1, minutes: 60 }] }),
    });
    // Anna holds Ma 7–9 (input()'s one behörighet); Bo holds nothing.
    expect(findings.map((f) => [f.code, f.userId, f.params.role])).toEqual([[STAFF_TEACHER_NOT_QUALIFIED, BO, 'TEACHER']]);
  });

  it('delade lektioner: does not ask again of a teacher whose share only changes size', () => {
    const stored = requirement({ teacherId: ANNA, lessonsPerWeek: 3, shares: [{ teacherId: BO, lessons: 1, minutes: 60 }] });
    expect(
      judge({
        input: input({ requirements: [stored] }),
        before: stored,
        after: { ...stored, shares: [{ teacherId: BO, lessons: 2, minutes: 60 }] },
      }),
    ).toEqual([]);
  });

  it('delade lektioner: charges the share’s teacher only their own lessons, and the lead the rest', () => {
    // Bo's riktmärke is 1 000 (+10 %: 1 100). He has 1 000 already; one
    // lesson of the row puts him at 1 060, inside; two at 1 120, past it.
    const year = input({
      employments: [employment(ANNA), employment(BO)],
      qualifications: [qualification(), qualification({ userId: BO })],
      requirements: [requirement({ id: 'req-0', teacherId: BO, lessonsPerWeek: 10, minutesPerLesson: 100 })],
    });
    const row = (lessons: number) =>
      requirement({ teacherId: ANNA, lessonsPerWeek: 3, shares: [{ teacherId: BO, lessons, minutes: 60 }] });
    expect(judge({ input: year, policy: policy({ overAllocationMode: 'REFUSE' }), after: row(1) })).toEqual([]);
    const findings = judge({ input: year, policy: policy({ overAllocationMode: 'REFUSE' }), after: row(2) });
    expect(findings.map((f) => [f.code, f.userId, f.params.minutes])).toEqual([[STAFF_TEACHER_OVER_TARGET, BO, 1120]]);
  });

  it('does not ask behörighet again of the teacher the row already had', () => {
    const stored = requirement({ teacherId: BO });
    expect(
      judge({
        input: input({ requirements: [stored] }),
        before: stored,
        after: { ...stored, lessonsPerWeek: 3 },
      }),
    ).toEqual([]);
  });

  it('counts the year and the uppdrag that count, and refuses the write that takes them past', () => {
    // Anna: 8 × 60 = 480 teaching + a 500-minute counted uppdrag = 980; the
    // new row adds 120 → 1 100 is the limit exactly, 1 160 is past it.
    const year = input({
      requirements: [requirement({ id: 'req-0', teacherId: ANNA, lessonsPerWeek: 8 })],
      duties: [
        { userId: ANNA, minutesPerWeek: 500, countsAsTeaching: true },
        { userId: ANNA, minutesPerWeek: 900, countsAsTeaching: false },
      ],
    });
    expect(judge({ input: year, after: requirement({ teacherId: ANNA, lessonsPerWeek: 2 }) })).toEqual([]);
    const findings = judge({
      input: year,
      policy: policy({ overAllocationMode: 'REFUSE' }),
      after: requirement({ teacherId: ANNA, lessonsPerWeek: 3 }),
    });
    expect(findings).toEqual([
      expect.objectContaining({
        code: STAFF_TEACHER_OVER_TARGET,
        mode: 'REFUSE',
        params: expect.objectContaining({ minutes: 1160, target: 1000 }),
      }),
    ]);
  });

  it('charges each teacher the row’s own percentage', () => {
    const year = input({
      employments: [employment(ANNA), employment(BO)],
      requirements: [requirement({ id: 'req-0', teacherId: ANNA, coTeacherId: BO, lessonsPerWeek: 16 })],
      qualifications: [],
    });
    // 16 × 60 = 960 each; a new 3 × 60 row at 0 % for the co-teacher leaves
    // Bo at 960, and at 100 % for the lead puts Anna at 1 140.
    const findings = judge({
      input: year,
      after: requirement({ teacherId: ANNA, coTeacherId: BO, lessonsPerWeek: 3, coTeacherLoadPercent: 0 }),
    });
    expect(findings.map((f) => [f.code, f.params.role])).toEqual([[STAFF_TEACHER_OVER_TARGET, 'TEACHER']]);
  });

  it('reads a PATCH against the row as it stood, so a lighter row is never refused', () => {
    const stored = requirement({ teacherId: ANNA, lessonsPerWeek: 20 });
    expect(
      judge({
        input: input({ requirements: [stored] }),
        policy: policy({ overAllocationMode: 'REFUSE' }),
        before: stored,
        after: { ...stored, lessonsPerWeek: 19 },
      }),
    ).toEqual([]);
  });

  it('puts the lead before the co-teacher and behörighet before load, every time', () => {
    const year = input({
      employments: [employment(ANNA), employment(BO)],
      requirements: [requirement({ id: 'req-0', teacherId: ANNA, coTeacherId: BO, lessonsPerWeek: 18 })],
      qualifications: [qualification({ userId: 'someone-else' })],
    });
    const findings = judge({
      input: year,
      after: requirement({ teacherId: ANNA, coTeacherId: BO, lessonsPerWeek: 2 }),
    });
    expect(findings.map((f) => `${f.params.role}:${f.code}`)).toEqual([
      `TEACHER:${STAFF_TEACHER_NOT_QUALIFIED}`,
      `TEACHER:${STAFF_TEACHER_OVER_TARGET}`,
      `CO_TEACHER:${STAFF_TEACHER_NOT_QUALIFIED}`,
      `CO_TEACHER:${STAFF_TEACHER_OVER_TARGET}`,
    ]);
  });

  it('asks nothing when both modes are OFF', () => {
    expect(
      judge({
        policy: policy({ qualificationMode: 'OFF', overAllocationMode: 'OFF' }),
        after: requirement({ teacherId: BO, lessonsPerWeek: 40 }),
      }),
    ).toEqual([]);
  });
});

describe('judgeRequirementBatch', () => {
  const CY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  // Riktmärke 1000, 10 %: the limit is 1 100. Anna and Bo each carry 960 of
  // other rows and one 120-minute row of Ma: 1 080 each, inside.
  const school = (overrides: Partial<LoadInput> = {}): LoadInput =>
    input({
      employments: [employment(ANNA), employment(BO), employment(CY)],
      qualifications: [qualification(), qualification({ userId: BO })],
      requirements: [
        requirement({ id: 'a-rest', subjectId: 'x', teacherId: ANNA, lessonsPerWeek: 16 }),
        requirement({ id: 'b-rest', subjectId: 'x', teacherId: BO, lessonsPerWeek: 16 }),
        requirement({ id: 'r-anna', teacherId: ANNA }),
        requirement({ id: 'r-bo', teacherId: BO }),
        requirement({ id: 'r-open' }),
      ],
      ...overrides,
    });
  const refuse = policy({ qualificationMode: 'REFUSE', overAllocationMode: 'REFUSE' });

  it('judges a swap as one write: neither teacher grows, so nothing is said, where one row at a time refuses', () => {
    const year = school();
    const changes = [
      { requirementId: 'r-anna', teacherId: BO },
      { requirementId: 'r-bo', teacherId: ANNA },
    ];
    expect(judgeRequirementBatch({ input: year, policy: refuse, changes })).toEqual([]);
    // The first half alone puts Bo at 1 200.
    const bo = year.requirements.find((row) => row.id === 'r-anna')!;
    expect(
      judgeRequirementWrite({ input: year, policy: refuse, before: bo, after: { ...bo, teacherId: BO }, subjectName: 'Matematik' }),
    ).toEqual([expect.objectContaining({ code: STAFF_TEACHER_OVER_TARGET, userId: BO })]);
  });

  it('asks the load once per teacher who grows, naming every row they gain, in row order', () => {
    const findings = judgeRequirementBatch({
      input: school(),
      policy: refuse,
      changes: [
        { requirementId: 'r-open', teacherId: ANNA },
        { requirementId: 'r-bo', teacherId: ANNA },
      ],
    });
    expect(findings).toEqual([
      expect.objectContaining({
        code: STAFF_TEACHER_OVER_TARGET,
        mode: 'REFUSE',
        userId: ANNA,
        requirementIds: ['r-bo', 'r-open'],
        params: { role: 'TEACHER', minutes: 1320, target: 1000, limit: 1100, tolerance: 10 },
      }),
    ]);
  });

  it('asks behörighet of every row whose lead becomes somebody new, before any load, in row order', () => {
    const findings = judgeRequirementBatch({
      input: school(),
      policy: refuse,
      changes: [
        { requirementId: 'r-open', teacherId: CY },
        { requirementId: 'r-bo', teacherId: CY },
        // Unchanged, and emptied: neither is an assignment.
        { requirementId: 'r-anna', teacherId: ANNA },
        { requirementId: 'b-rest', teacherId: null },
      ],
    });
    expect(findings.map((f) => [f.code, f.userId, f.requirementIds])).toEqual([
      [STAFF_TEACHER_NOT_QUALIFIED, CY, ['r-bo']],
      [STAFF_TEACHER_NOT_QUALIFIED, CY, ['r-open']],
    ]);
    // Cy carries 240 of a 1 000 target: no load finding.
  });

  it('asks nothing under OFF, no behörighet with nothing recorded, and no load with the load mode off', () => {
    const changes = [{ requirementId: 'r-open', teacherId: ANNA }];
    expect(judgeRequirementBatch({ input: school(), policy: policy({ qualificationMode: 'OFF', overAllocationMode: 'OFF' }), changes })).toEqual([]);
    expect(
      judgeRequirementBatch({ input: school({ qualifications: [] }), policy: policy({ overAllocationMode: 'OFF' }), changes: [{ requirementId: 'r-open', teacherId: CY }] }),
    ).toEqual([]);
    expect(judgeRequirementBatch({ input: school(), policy: policy({ overAllocationMode: 'OFF' }), changes })).toEqual([]);
  });

  it('throws on a row the year does not hold', () => {
    expect(() =>
      judgeRequirementBatch({ input: school(), policy: refuse, changes: [{ requirementId: 'nope', teacherId: ANNA }] }),
    ).toThrow('nope');
  });

  describe('undoing an apply, judged against the state the apply found', () => {
    // Before the apply Anna carried 1 200 (OVER her 1 100), r-extra among it,
    // in a subject she holds no behörighet for. The apply gave r-extra to Cy;
    // she now carries 1 080. Putting it back is a "growth" from today, but no
    // more than she carried a minute ago.
    const applied = () =>
      school({
        requirements: [
          ...school().requirements,
          requirement({ id: 'r-extra', subjectId: 'y', teacherId: CY }),
        ],
      });
    const undo = [{ requirementId: 'r-extra', teacherId: ANNA }];
    const restoring = new Map<string, string | null>([['r-extra', ANNA]]);

    it('is refused as a fresh write — the reproduction — but not as the undo it is', () => {
      expect(
        judgeRequirementBatch({ input: applied(), policy: refuse, changes: undo }).map((f) => [f.code, f.userId]),
      ).toEqual([
        [STAFF_TEACHER_NOT_QUALIFIED, ANNA],
        [STAFF_TEACHER_OVER_TARGET, ANNA],
      ]);
      expect(judgeRequirementBatch({ input: applied(), policy: refuse, changes: undo, restoring })).toEqual([]);
    });

    it('still asks about a lead the row did not have, and a load past both today and before the apply', () => {
      const findings = judgeRequirementBatch({
        input: applied(),
        policy: refuse,
        changes: [...undo, { requirementId: 'r-open', teacherId: ANNA }],
        restoring,
      });
      expect(findings.map((f) => [f.code, f.userId, f.requirementIds])).toEqual([
        [STAFF_TEACHER_OVER_TARGET, ANNA, ['r-extra', 'r-open']],
      ]);
      expect(findings[0]!.params).toMatchObject({ minutes: 1320 });

      // Restoring r-extra to Bo, who never had it, is a new assignment.
      expect(
        judgeRequirementBatch({
          input: applied(),
          policy: refuse,
          changes: [{ requirementId: 'r-extra', teacherId: BO }],
          restoring,
        }).map((f) => [f.code, f.userId]),
      ).toEqual([
        [STAFF_TEACHER_NOT_QUALIFIED, BO],
        [STAFF_TEACHER_OVER_TARGET, BO],
      ]);
    });
  });
});

describe('a post that changes during the year (20261022120000): the load question per stretch', () => {
  // Anna's post is 100 % until 31 October and 80 % from Sunday 1 November:
  // target 1000 and then 800 (limit 1100 and 880 at the default 10 %).
  const changing = employment(ANNA, {
    periods: [{ validFrom: '2026-11-01', validTo: null, employmentPercent: 80, reductionPercent: 0, teachingTargetMinutesPerWeek: null }],
  });
  const year = (minutes: number) =>
    input({
      employments: [changing],
      requirements: [requirement({ id: 'req-held', teacherId: ANNA, lessonsPerWeek: minutes / 50, minutesPerLesson: 50 })],
    });
  const write = (minutes: number, dates: Partial<LoadRequirement> = {}) =>
    judgeRequirementWrite({
      input: year(850),
      policy: policy(),
      before: null,
      after: requirement({ id: 'req-new', teacherId: ANNA, lessonsPerWeek: minutes / 50, minutesPerLesson: 50, ...dates }),
      subjectName: 'Matematik',
    }).filter((finding) => finding.code !== STAFF_TEACHER_NOT_QUALIFIED);

  it('refuses a whole-year row for the stretch it takes over, naming the stretch, where the year alone would pass it', () => {
    expect(write(200)).toEqual([
      {
        code: STAFF_TEACHER_OVER_TARGET_IN_PERIOD,
        mode: 'WARN',
        userId: ANNA,
        params: { role: 'TEACHER', minutes: 1050, target: 800, limit: 880, tolerance: 10, from: '2026-11-01', to: '2027-06-11' },
      },
    ]);
    // The same write for a post without the period: 1050 against 1000 is within 1100.
    expect(
      judgeRequirementWrite({
        input: { ...year(850), employments: [employment(ANNA)] },
        policy: policy(),
        before: null,
        after: requirement({ id: 'req-new', teacherId: ANNA, lessonsPerWeek: 4, minutesPerLesson: 50 }),
        subjectName: 'Matematik',
      }).filter((finding) => finding.code !== STAFF_TEACHER_NOT_QUALIFIED),
    ).toEqual([]);
  });

  it("gives a reader who may not see how a post changes the verdict alone (Roller i skolan), in a write, a batch and a 409", () => {
    const hidden = policy({ showsPeriods: false });
    const verdict = {
      code: STAFF_TEACHER_OVER_TARGET_HIDDEN,
      mode: 'WARN',
      userId: ANNA,
      params: { role: 'TEACHER', tolerance: 10 },
    };
    expect(
      judgeRequirementWrite({
        input: year(850),
        policy: hidden,
        before: null,
        after: requirement({ id: 'req-new', teacherId: ANNA, lessonsPerWeek: 4, minutesPerLesson: 50 }),
        subjectName: 'Matematik',
      }).filter((finding) => finding.code !== STAFF_TEACHER_NOT_QUALIFIED),
    ).toEqual([verdict]);
    // Neither the stretch's 1050, 800 and 880, nor its dates, nor a figure
    // that would read as the year's: the tolerance is the policy's own.
    expect(staffingSentence(verdict).match(/\d+/g)).toEqual(['10']);
    const batch = judgeRequirementBatch({
      input: { ...year(850), requirements: [...year(850).requirements, requirement({ id: 'req-new', teacherId: null, lessonsPerWeek: 4, minutesPerLesson: 50 })] },
      policy: hidden,
      changes: [{ requirementId: 'req-new', teacherId: ANNA }],
    }).filter((finding) => finding.code !== STAFF_TEACHER_NOT_QUALIFIED);
    expect(batch.map((finding) => [finding.code, finding.params])).toEqual([
      [STAFF_TEACHER_OVER_TARGET_HIDDEN, { role: 'TEACHER', tolerance: 10 }],
    ]);
    const refused = judgeRequirementWrite({
      input: year(850),
      policy: policy({ overAllocationMode: 'REFUSE', showsPeriods: false }),
      before: null,
      after: requirement({ id: 'req-new', teacherId: ANNA, lessonsPerWeek: 4, minutesPerLesson: 50 }),
      subjectName: 'Matematik',
    });
    try {
      settleFindings(refused);
      throw new Error('not refused');
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toEqual({
        message: staffingSentence(verdict),
        code: STAFF_TEACHER_OVER_TARGET_HIDDEN,
        params: { role: 'TEACHER', tolerance: 10 },
      });
    }
    // A post that does not change is worded with its figures for every
    // reader: its target in minutes is the matrix's own.
    expect(
      judgeRequirementWrite({
        input: { ...year(850), employments: [employment(ANNA)] },
        policy: hidden,
        before: null,
        after: requirement({ id: 'req-new', teacherId: ANNA, lessonsPerWeek: 8, minutesPerLesson: 50 }),
        subjectName: 'Matematik',
      }).filter((finding) => finding.code !== STAFF_TEACHER_NOT_QUALIFIED),
    ).toEqual([
      {
        code: STAFF_TEACHER_OVER_TARGET,
        mode: 'WARN',
        userId: ANNA,
        params: { role: 'TEACHER', minutes: 1250, target: 1000, limit: 1100, tolerance: 10 },
      },
    ]);
  });

  it('judges a row only in the stretch it runs in: an autumn course adds nothing to the spring', () => {
    expect(write(200, { startDate: '2026-08-17', endDate: '2026-10-30' })).toEqual([]);
    // In the 80 % stretch the same minutes are over.
    expect(write(200, { startDate: '2026-11-02', endDate: '2027-01-29' })[0]).toMatchObject({
      code: STAFF_TEACHER_OVER_TARGET_IN_PERIOD,
      params: { from: '2026-11-01', to: '2027-06-11' },
    });
  });

  it('refuses under REFUSE with the stretch in the 409, and never a write that does not add to it', () => {
    const findings = judgeRequirementWrite({
      input: year(850),
      policy: policy({ overAllocationMode: 'REFUSE' }),
      before: null,
      after: requirement({ id: 'req-new', teacherId: ANNA, lessonsPerWeek: 4, minutesPerLesson: 50 }),
      subjectName: 'Matematik',
    }).filter((finding) => finding.code !== STAFF_TEACHER_NOT_QUALIFIED);
    expect(() => settleFindings(findings)).toThrow(
      'Läraren skulle få 1050 min/v mot riktmärket 800 min/v från 2026-11-01 till och med 2027-06-11 (gränsen är 880 min/v med 10 % tolerans).',
    );
    // Already over in the spring at 950, and the write takes a lesson away: no finding.
    const over = year(950);
    expect(
      judgeRequirementWrite({
        input: over,
        policy: policy({ overAllocationMode: 'REFUSE' }),
        before: over.requirements[0]!,
        after: { ...over.requirements[0]!, lessonsPerWeek: 18 },
        subjectName: 'Matematik',
      }),
    ).toEqual([]);
  });

  it('asks the batch the same question, per teacher, per stretch', () => {
    const batchYear = input({
      employments: [changing],
      requirements: [
        requirement({ id: 'req-held', teacherId: ANNA, lessonsPerWeek: 17, minutesPerLesson: 50 }),
        requirement({ id: 'req-free', teacherId: null, lessonsPerWeek: 4, minutesPerLesson: 50 }),
      ],
    });
    const findings = judgeRequirementBatch({
      input: batchYear,
      policy: policy({ qualificationMode: 'OFF' }),
      changes: [{ requirementId: 'req-free', teacherId: ANNA }],
    });
    expect(findings).toEqual([
      expect.objectContaining({
        code: STAFF_TEACHER_OVER_TARGET_IN_PERIOD,
        requirementIds: ['req-free'],
        params: expect.objectContaining({ minutes: 1050, target: 800, from: '2026-11-01' }),
      }),
    ]);
  });
});

describe('settleFindings', () => {
  const finding = (mode: 'WARN' | 'REFUSE', code: StaffingFinding['code'] = STAFF_TEACHER_NOT_QUALIFIED): StaffingFinding => ({
    code,
    mode,
    userId: ANNA,
    params: code === STAFF_TEACHER_NOT_QUALIFIED
      ? { role: 'TEACHER', subject: 'Matematik', grades: '7–9' }
      : { role: 'CO_TEACHER', minutes: 1250, target: 1080, limit: 1188, tolerance: 10 },
  });

  it('hands back WARNs as code and params, without whom they are about', () => {
    expect(settleFindings([finding('WARN')])).toEqual([
      { code: STAFF_TEACHER_NOT_QUALIFIED, params: { role: 'TEACHER', subject: 'Matematik', grades: '7–9' } },
    ]);
  });

  it('throws the first REFUSE as a 409 with its code, params and Swedish', () => {
    let thrown: unknown;
    try {
      settleFindings([finding('WARN'), finding('REFUSE', STAFF_TEACHER_OVER_TARGET), finding('REFUSE')]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConflictException);
    expect((thrown as ConflictException).getResponse()).toEqual({
      code: STAFF_TEACHER_OVER_TARGET,
      params: { role: 'CO_TEACHER', minutes: 1250, target: 1080, limit: 1188, tolerance: 10 },
      message:
        'Medläraren skulle få 1250 min/v mot riktmärket 1080 min/v (gränsen är 1188 min/v med 10 % tolerans).',
    });
  });

  it('downgrades a REFUSE to a warning when asked to — the vikarie', () => {
    expect(settleFindings([finding('REFUSE')], { downgrade: true })).toHaveLength(1);
  });
});

/**
 * The Swedish a 409 carries in `detail` and the Swedish the web renders from
 * the code are ONE sentence, written twice: here in staffingSentence, there in
 * web/messages/sv.json under engineMessages. Rendered with the ICU subset the
 * catalogue is written in (select and plural, see app/messages.py), so a reword
 * of either without the other fails here — and the params a finding carries
 * are exactly the arguments the catalogue's template takes.
 */
describe('the catalogue says what staffingSentence says', () => {
  const root = join(__dirname, '..', '..');
  const sv = (JSON.parse(readFileSync(join(root, 'web/messages/sv.json'), 'utf8')) as {
    engineMessages: Record<string, string>;
  }).engineMessages;
  const fixture = JSON.parse(
    readFileSync(join(root, 'web/i18n/__fixtures__/engine-messages.json'), 'utf8'),
  ) as Record<string, string>;

  /** {name}, {name, select, …} and {name, plural, …} with #, and nothing more. */
  const render = (template: string, params: Record<string, string | number>): string => {
    let out = '';
    for (let i = 0; i < template.length; ) {
      if (template[i] !== '{') {
        out += template[i++];
        continue;
      }
      let depth = 0;
      let end = i;
      for (; end < template.length; end++) {
        if (template[end] === '{') depth++;
        if (template[end] === '}' && --depth === 0) break;
      }
      const inside = template.slice(i + 1, end);
      i = end + 1;
      const [name, kind, ...rest] = inside.split(',');
      const value = params[name!.trim()]!;
      if (kind === undefined) {
        out += String(value);
        continue;
      }
      const branches = new Map<string, string>();
      const body = rest.join(',');
      const branch = /(\w+)\s*\{/g;
      let match: RegExpExecArray | null;
      while ((match = branch.exec(body)) !== null) {
        let d = 1;
        let j = branch.lastIndex;
        for (; j < body.length && d > 0; j++) d += body[j] === '{' ? 1 : body[j] === '}' ? -1 : 0;
        branches.set(match[1]!, body.slice(branch.lastIndex, j - 1));
        branch.lastIndex = j;
      }
      const key = kind.trim() === 'plural' ? (value === 1 ? 'one' : 'other') : String(value);
      const chosen = branches.get(key) ?? branches.get('other')!;
      out += render(kind.trim() === 'plural' ? chosen.replace('#', String(value)) : chosen, params);
    }
    return out;
  };

  const argumentsOf = (template: string): string[] => {
    const names = new Set<string>();
    let depth = 0;
    for (let i = 0; i < template.length; i++) {
      if (template[i] === '}') depth--;
      if (template[i] !== '{') continue;
      depth++;
      if (depth === 1) names.add(/^\w+/.exec(template.slice(i + 1))![0]);
    }
    return [...names].sort();
  };

  const cases: StaffingWarning[] = [
    { code: STAFF_TEACHER_NOT_QUALIFIED, params: { role: 'TEACHER', subject: 'Matematik', grades: '7–9' } },
    { code: STAFF_TEACHER_NOT_QUALIFIED, params: { role: 'SUBSTITUTE', subject: 'Engelska', grades: 'any' } },
    { code: STAFF_TEACHER_NOT_QUALIFIED, params: { role: 'CO_TEACHER', subject: 'Slöjd', grades: '4' } },
    {
      code: STAFF_TEACHER_OVER_TARGET,
      params: { role: 'TEACHER', minutes: 1250, target: 1080, limit: 1188, tolerance: 10 },
    },
    {
      code: STAFF_TEACHER_OVER_TARGET,
      params: { role: 'CO_TEACHER', minutes: 700, target: 600, limit: 600, tolerance: 0 },
    },
    {
      code: STAFF_TEACHER_OVER_TARGET_IN_PERIOD,
      params: { role: 'TEACHER', minutes: 1000, target: 865, limit: 951, tolerance: 10, from: '2026-11-01', to: '2027-06-11' },
    },
    {
      code: STAFF_TEACHER_OVER_TARGET_IN_PERIOD,
      params: { role: 'CO_TEACHER', minutes: 600, target: 540, limit: 540, tolerance: 0, from: '2027-02-01', to: '2027-03-28' },
    },
    { code: STAFF_TEACHER_OVER_TARGET_HIDDEN, params: { role: 'TEACHER', tolerance: 10 } },
    { code: STAFF_TEACHER_OVER_TARGET_HIDDEN, params: { role: 'SUBSTITUTE', tolerance: 0 } },
  ];

  it.each(cases.map((warning) => [warning.code, warning.params.role, warning] as const))(
    '%s (%s)',
    (_code, _role, warning) => {
      expect(staffingSentence(warning)).toBe(render(sv[warning.code]!, warning.params));
      expect(Object.keys(warning.params).sort()).toEqual(argumentsOf(fixture[warning.code]!));
    },
  );

  it('has the generate pre-flight’s sentence in both catalogues', () => {
    expect(argumentsOf(fixture[STAFF_UNSTAFFED_REQUIREMENTS]!)).toEqual(['count']);
    expect(render(sv[STAFF_UNSTAFFED_REQUIREMENTS]!, { count: 1 })).toMatch(/^1 timplanspost saknar lärare/);
    expect(render(sv[STAFF_UNSTAFFED_REQUIREMENTS]!, { count: 3 })).toMatch(/^3 timplansposter saknar lärare/);
  });
});
