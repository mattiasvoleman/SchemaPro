import type { ScopeVersion } from '../staffing/assignment-scope';
import type { LoadRead } from '../staffing/load-input';
import { DEFAULT_CHECK_POLICY } from '../staffing/staffing-checks';
import type { EnforcedPolicy } from '../staffing/staffing-enforcement';
import type { LoadInput, LoadRequirement } from '../staffing/teacher-load';
import { giveBackOverScope, planOf, type StaffingState } from './staffing-proposal.service';

/*
 * giveBackOverScope: what Föreslå bemanning does under REFUSE of the ordinance's highest level of teaching time with an answer that
 * leaves a teacher over it by the real hours (review of #408). The year is 2026-08-17 to 2027-06-11, 43 teaching weeks; the edge for
 * åk 7-9 is 600 hours; one lesson of 60 minutes a week is 43 hours.
 */
const ANNA = 'd0000000-0000-4000-8000-00000000000a';
const CY = 'd0000000-0000-4000-8000-00000000000c';

const band = (gradeFrom: number, gradeTo: number, low: number, high: number, percent: number): ScopeVersion['bands'][number] => ({
  schoolForm: 'GRUNDSKOLA',
  gradeNumbering: 'NIOARIG',
  gradeFrom,
  gradeTo,
  teachingHoursLow: low,
  teachingHoursHigh: high,
  planningFloorPercent: percent,
  teachingSection: '3 §',
  planningSection: '4 §',
  note: null,
});

describe('giveBackOverScope', () => {
  const YEAR_BOUNDS = { startDate: '2026-08-17', endDate: '2027-06-11' };
  const VERSION: ScopeVersion = {
    code: 'SFS2026:1487',
    sfs: 'SFS 2026:1487',
    title: 'Förordning',
    validFrom: '2020-01-01',
    validTo: null,
    source: 'https://example.invalid/sfs',
    bands: [band(7, 9, 500, 600, 110)],
  };
  const row = (id: string, teacherId: string | null, lessons: number): LoadRequirement => ({
    id,
    subjectId: `s-${id}`,
    subjectName: `Ämne ${id}`,
    studentGroupId: 'g-7a',
    groupName: '7A',
    teacherId,
    coTeacherId: null,
    lessonsPerWeek: lessons,
    minutesPerLesson: 60,
    teacherLoadPercent: 100,
    coTeacherLoadPercent: 100,
    recurrence: 'ALL_WEEKS',
    startDate: null,
    endDate: null,
    gradeSpan: { min: 7, max: 7 },
  });
  const stateOf = (rows: LoadRequirement[]): StaffingState => {
    const input: LoadInput = {
      year: YEAR_BOUNDS,
      policy: { fullTimeTeachingMinutesPerWeek: 1080, overAllocationTolerancePercent: 10, fullTimeRegulatedHoursPerYear: 1360, workDaysPerYear: 194, qualificationMode: 'OFF' },
      employments: [
        { userId: ANNA, employmentPercent: 100, reductionPercent: 0, contractKind: 'FERIE', teachingTargetMinutesPerWeek: null, signature: null },
        { userId: CY, employmentPercent: 100, reductionPercent: 0, contractKind: 'FERIE', teachingTargetMinutesPerWeek: null, signature: null },
      ],
      requirements: rows,
      qualifications: [],
      closures: [],
      duties: [],
    };
    return {
      schoolId: 'school',
      read: { input } as unknown as LoadRead,
      policy: { ...DEFAULT_CHECK_POLICY, qualificationMode: 'OFF', overAllocationMode: 'OFF', assignmentScopeMode: 'REFUSE', fullTimeTeachingMinutesPerWeek: 1080, unstaffedGeneration: 'ALLOW', showsPeriods: true } as EnforcedPolicy,
      staffIds: [ANNA, CY],
      candidateIds: [ANNA, CY],
      lastYear: new Map(),
      released: new Set(['k1', 'k2']),
      scopeVersions: [VERSION],
    };
  };
  const DTO = { onlyUnstaffed: false, respectQualifications: false, pinnedRequirementIds: [] as string[] };

  it('gives back the largest row the teacher was given first, and stops as soon as nobody is over: 10 lessons (430 h) and 4 (172 h) on 8 (344 h)', () => {
    // 344 + 430 is over a 600 h edge; 344 + 172 is 516 h, inside it. Giving back the 430 h row is all it takes.
    const state = stateOf([row('own', ANNA, 8), row('big', null, 10), row('small', null, 4)]);
    const plan = planOf(state, DTO);
    const leads = new Map([['big', ANNA], ['small', ANNA]]);
    const unstaffed = new Map();
    expect(giveBackOverScope(state, plan, leads, unstaffed)).toEqual(['big']);
    expect([...leads]).toEqual([['small', ANNA]]);
    expect([...unstaffed]).toEqual([['big', 'NO_CAPACITY_LEFT']]);
  });

  it('puts a kept row back to the lead it has today and does not call it unstaffed', () => {
    const state = stateOf([row('own', ANNA, 8), row('k1', CY, 10)]);
    const plan = planOf(state, DTO);
    const leads = new Map([['k1', ANNA]]);
    const unstaffed = new Map();
    expect(giveBackOverScope(state, plan, leads, unstaffed)).toEqual(['k1']);
    expect([...leads]).toEqual([['k1', CY]]);
    expect(unstaffed.size).toBe(0);
  });

  it('does nothing for an answer nobody ends over, and for a teacher who is over already and gains nothing', () => {
    const fine = stateOf([row('own', ANNA, 8), row('open', null, 4)]);
    expect(giveBackOverScope(fine, planOf(fine, DTO), new Map([['open', ANNA]]), new Map())).toEqual([]);
    const over = stateOf([row('own', ANNA, 15), row('open', null, 4)]);
    expect(giveBackOverScope(over, planOf(over, DTO), new Map([['open', CY]]), new Map())).toEqual([]);
  });

  it('does nothing under WARN or OFF, where the apply warns or asks nothing', () => {
    for (const mode of ['WARN', 'OFF'] as const) {
      const state = stateOf([row('own', ANNA, 8), row('big', null, 10)]);
      state.policy = { ...state.policy, assignmentScopeMode: mode };
      expect(giveBackOverScope(state, planOf(state, DTO), new Map([['big', ANNA]]), new Map())).toEqual([]);
    }
  });
});
