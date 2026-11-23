import { DEFAULT_CHECK_POLICY, judgeRequirementWrite, type CheckPolicy } from './staffing-checks';
import type { ScopeVersion } from './assignment-scope';
import type { LoadInput, LoadRequirement } from './teacher-load';

/*
 * STAFF_TEACHER_OVER_SCOPE is judged on the hours in a stage, as the report's OVER_MAX is (T7, the user's decision on the review of #382):
 * förskoleklass and groups with no årskurs are counted in the total and are never a reason to refuse (review of #404, M-2 and M-3).
 * Anna is full-time in årskurs 7 (upper edge 600 h) in a year of 43 weeks: 13 lessons a week of 60 minutes are 559 h, 14 are 602.
 */
const ANNA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const YEAR = { startDate: '2026-08-17', endDate: '2027-06-11' };
const version: ScopeVersion = {
  code: 'SFS2026:1487',
  sfs: 'SFS 2026:1487',
  title: 'Förordning',
  validFrom: '2020-01-01',
  validTo: null,
  source: 'https://example.invalid/sfs',
  bands: [
    { schoolForm: 'GRUNDSKOLA', gradeNumbering: 'NIOARIG', gradeFrom: 1, gradeTo: 6, teachingHoursLow: 550, teachingHoursHigh: 650, planningFloorPercent: 100, teachingSection: '3 § p. 1', planningSection: '4 §', note: null },
    { schoolForm: 'GRUNDSKOLA', gradeNumbering: 'NIOARIG', gradeFrom: 7, gradeTo: 9, teachingHoursLow: 500, teachingHoursHigh: 600, planningFloorPercent: 110, teachingSection: '3 § p. 2', planningSection: '4 §', note: null },
  ],
};
const stage7 = { min: 7, max: 7 };
const preschool = { min: 0, max: 0 };

const row = (id: string, lessonsPerWeek: number, gradeSpan: { min: number; max: number } | null): LoadRequirement => ({
  id,
  subjectId: id,
  subjectName: `Ämne ${id}`,
  studentGroupId: `g-${id}`,
  groupName: id,
  teacherId: ANNA,
  coTeacherId: null,
  lessonsPerWeek,
  minutesPerLesson: 60,
  teacherLoadPercent: 100,
  coTeacherLoadPercent: 100,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  gradeSpan,
});
const input = (requirements: LoadRequirement[]): LoadInput => ({
  year: YEAR,
  policy: null,
  employments: [{ userId: ANNA, employmentPercent: 100, reductionPercent: 0, contractKind: 'FERIE', teachingTargetMinutesPerWeek: null, signature: null }],
  requirements,
  qualifications: [],
  closures: [],
  duties: [],
});
const policy = (overrides: Partial<CheckPolicy> = {}): CheckPolicy => ({
  ...DEFAULT_CHECK_POLICY,
  qualificationMode: 'OFF',
  overAllocationMode: 'OFF',
  assignmentScopeMode: 'REFUSE',
  ...overrides,
});
const write = (stored: LoadRequirement[], after: LoadRequirement, p: CheckPolicy = policy()) =>
  judgeRequirementWrite({ input: input(stored), policy: p, before: null, after, subjectName: 'X', scopeVersions: [version] }).map(({ code, params }) => ({ code, params }));

describe('STAFF_TEACHER_OVER_SCOPE is judged on the hours in a stage', () => {
  it('says the stage hours against the line, not the total with förskoleklass counted in: 602 h in åk 7 and 602 h in förskoleklass is 602 h over 600, not 1 204', () => {
    expect(write([row('ma', 13, stage7), row('f', 14, preschool)], row('no', 1, stage7))).toEqual([
      { code: 'STAFF_TEACHER_OVER_SCOPE', params: { role: 'TEACHER', hours: '602', limit: '600' } },
    ]);
  });

  it('refuses nothing for förskoleklass to a teacher who is over only in the stages: the write adds no hour in a stage', () => {
    // 14 lessons in åk 7 is 602 h, over before the write; 3 lessons more in förskoleklass change none of the hours the line is judged on.
    expect(write([row('ma', 14, stage7)], row('f', 3, preschool))).toEqual([]);
  });

  it('refuses nothing for a group with no årskurs either', () => {
    expect(write([row('ma', 14, stage7)], row('x', 3, null))).toEqual([]);
  });

  it('still refuses, saying the stage hours, a row in a stage for a teacher who is over before and has förskoleklass beside', () => {
    expect(write([row('ma', 14, stage7), row('f', 3, preschool)], row('no', 1, stage7))).toEqual([
      { code: 'STAFF_TEACHER_OVER_SCOPE', params: { role: 'TEACHER', hours: '645', limit: '600' } },
    ]);
  });

  it('warns, under WARN, in the same cases and no others', () => {
    const warn = policy({ assignmentScopeMode: 'WARN' });
    expect(write([row('ma', 14, stage7)], row('f', 3, preschool), warn)).toEqual([]);
    expect(write([row('ma', 13, stage7), row('f', 14, preschool)], row('no', 1, stage7), warn)).toEqual([
      { code: 'STAFF_TEACHER_OVER_SCOPE', params: { role: 'TEACHER', hours: '602', limit: '600' } },
    ]);
  });

  it('asks nothing of a teacher who has only förskoleklass', () => {
    expect(write([row('f', 14, preschool)], row('f2', 14, preschool))).toEqual([]);
  });
});
