import type { ScopeVersion } from '../staffing/assignment-scope';
import type { LoadRead } from '../staffing/load-input';
import { DEFAULT_CHECK_POLICY } from '../staffing/staffing-checks';
import type { EnforcedPolicy } from '../staffing/staffing-enforcement';
import type { LoadEmployment, LoadInput, LoadRequirement, LoadScopeAssessment } from '../staffing/teacher-load';
import {
  basisOf,
  planOf,
  scopeCeilingTenths,
  scopeGrowthRefusal,
  type StaffingState,
} from './staffing-proposal.service';

/*
 * The ordinance's highest level of teaching time (SFS 2026:1487 3 §) in Föreslå bemanning: its edge as a teacher's limit under REFUSE,
 * as a noted ceiling the search honours under WARN, as a refusal of an answer that breaks it, and in the basis only under REFUSE.
 *
 * The year is 2026-08-17 to 2027-06-11, 43 teaching weeks, and the ordinance is judged from before it (VERSION holds from 2020). The edge
 * for årskurs 7-9 is 600 hours, so a standardvecka of 600 × 60 / 43 = 837.2 minutes, 8 372 tenths floored; 80 % of a post is 480 hours,
 * 6 697 tenths. One lesson a week of 60 minutes over the year is 43 hours.
 */
const YEAR = { startDate: '2026-08-17', endDate: '2027-06-11' };
const ANNA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const VERSION: ScopeVersion = {
  code: 'SFS2026:1487',
  sfs: 'SFS 2026:1487',
  title: 'Förordning',
  validFrom: '2020-01-01',
  validTo: null,
  source: 'https://example.invalid/sfs',
  bands: [
    {
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
    },
    {
      schoolForm: 'GRUNDSKOLA',
      gradeNumbering: 'NIOARIG',
      gradeFrom: 7,
      gradeTo: 9,
      teachingHoursLow: 500,
      teachingHoursHigh: 600,
      planningFloorPercent: 110,
      teachingSection: '3 § p. 2',
      planningSection: '4 § p. 1 och 5 § p. 1',
      note: null,
    },
  ],
};

const employment = (userId: string, employmentPercent = 100): LoadEmployment => ({
  userId,
  employmentPercent,
  reductionPercent: 0,
  contractKind: 'FERIE',
  teachingTargetMinutesPerWeek: null,
  signature: null,
});

const row = (id: string, teacherId: string | null, lessonsPerWeek: number): LoadRequirement => ({
  id,
  subjectId: `subject-${id}`,
  subjectName: `Ämne ${id}`,
  studentGroupId: 'g-7a',
  groupName: '7A',
  teacherId,
  coTeacherId: null,
  lessonsPerWeek,
  minutesPerLesson: 60,
  teacherLoadPercent: 100,
  coTeacherLoadPercent: 100,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  gradeSpan: { min: 7, max: 7 },
});

const input = (requirements: LoadRequirement[], employments = [employment(ANNA), employment(BO)]): LoadInput => ({
  year: YEAR,
  policy: {
    fullTimeTeachingMinutesPerWeek: 1000,
    overAllocationTolerancePercent: 10,
    fullTimeRegulatedHoursPerYear: 1360,
    workDaysPerYear: 194,
    qualificationMode: 'OFF',
  },
  employments,
  requirements,
  qualifications: [],
  closures: [],
  duties: [],
});

const state = (
  mode: 'OFF' | 'WARN' | 'REFUSE',
  requirements: LoadRequirement[],
  options: { versions?: readonly ScopeVersion[] | null; employments?: LoadEmployment[]; released?: string[] } = {},
): StaffingState => ({
  schoolId: 'school',
  read: { input: input(requirements, options.employments) } as unknown as LoadRead,
  policy: {
    ...DEFAULT_CHECK_POLICY,
    qualificationMode: 'OFF',
    overAllocationMode: 'WARN',
    assignmentScopeMode: mode,
    overAllocationTolerancePercent: 10,
    fullTimeTeachingMinutesPerWeek: 1000,
    unstaffedGeneration: 'ALLOW',
    showsPeriods: true,
  } as EnforcedPolicy,
  staffIds: [ANNA, BO],
  candidateIds: [ANNA, BO],
  lastYear: new Map(),
  released: new Set(options.released ?? []),
  ...(options.versions === null ? {} : { scopeVersions: options.versions ?? [VERSION] }),
});

const DTO = { onlyUnstaffed: false, respectQualifications: false, pinnedRequirementIds: [] as string[] };
const teacherOf = (plan: ReturnType<typeof planOf>, userId: string) => plan.teacherById.get(userId)!;

describe('scopeCeilingTenths: the ordinance\'s edge as a standardvecka in tenths', () => {
  it('is the level in hours over the school\'s teaching weeks, floored: 600 h × 60 / 43 = 837.2 min is 8 372 tenths', () => {
    expect(scopeCeilingTenths(input([row('r1', ANNA, 10)]), [VERSION], ANNA, 43)).toBe(8372);
  });

  it('holds a teacher with no teaching to the strictest edge a row could put them on (åk 7-9, 600 h), scaled by their post', () => {
    expect(scopeCeilingTenths(input([]), [VERSION], BO, 43)).toBe(8372);
    expect(scopeCeilingTenths(input([], [employment(ANNA), employment(BO, 80)]), [VERSION], BO, 43)).toBe(6697);
  });

  it('scales a teacher\'s own level by their post: 480 h for 80 %', () => {
    expect(scopeCeilingTenths(input([row('r1', BO, 5)], [employment(ANNA), employment(BO, 80)]), [VERSION], BO, 43)).toBe(6697);
  });

  it('has none where the level cannot be judged: no post, no lydelse in force, no weeks', () => {
    expect(scopeCeilingTenths(input([row('r1', BO, 5)], [employment(ANNA)]), [VERSION], BO, 43)).toBeNull();
    expect(scopeCeilingTenths(input([row('r1', ANNA, 5)]), [{ ...VERSION, validFrom: '2027-07-01' }], ANNA, 43)).toBeNull();
    expect(scopeCeilingTenths(input([row('r1', ANNA, 5)]), [VERSION], ANNA, 0)).toBeNull();
  });
});

describe('planOf under the ordinance\'s highest level of teaching time', () => {
  // Anna carries 5 lessons (215 h) and 2 are open; Bo carries nothing. Both a full ferietjänst with a riktmärke of 1 000 minutes and 10 %.
  const rows = [row('r1', ANNA, 5), row('r2', null, 4)];

  it('lets REFUSE hold the engine to the ordinance: the limit comes down under the riktmärke\'s 11 004, with the target and the floor under it', () => {
    const plan = planOf(state('REFUSE', rows), DTO);
    for (const id of [ANNA, BO]) {
      const teacher = teacherOf(plan, id);
      expect(teacher.limitTenths).toBe(8372);
      expect(teacher.targetTenths).toBe(8372);
      expect(teacher.floorTenths).toBe(8372);
      expect(teacher.scopeCeilingTenths).toBe(8372);
      expect(teacher.keepOrShed).toBe(false);
    }
    // The limit is never under the target or the floor (the engine's schema).
    for (const teacher of plan.teachers) {
      expect(teacher.limitTenths! >= teacher.targetTenths!).toBe(true);
      expect(teacher.targetTenths! >= teacher.floorTenths!).toBe(true);
    }
  });

  it('keeps or sheds a teacher who already carries more than the ordinance allows: they are given nothing new', () => {
    const over = [row('r1', ANNA, 15), row('r2', null, 4)];
    const plan = planOf(state('REFUSE', over), DTO);
    expect(teacherOf(plan, ANNA).keepOrShed).toBe(true);
    expect(teacherOf(plan, BO).keepOrShed).toBe(false);
  });

  it('leaves the engine\'s limit exactly as the riktmärke made it under WARN, and notes the ordinance\'s edge for the search', () => {
    const plan = planOf(state('WARN', rows), DTO);
    const anna = teacherOf(plan, ANNA);
    expect(anna.limitTenths).toBe(11004);
    expect(anna.targetTenths).toBe(10000);
    expect(anna.scopeCeilingTenths).toBe(8372);
  });

  it('asks nothing of the ordinance under OFF, and without the lydelser, whatever the mode says', () => {
    for (const plan of [planOf(state('OFF', rows), DTO), planOf(state('REFUSE', rows, { versions: null }), DTO)]) {
      expect(teacherOf(plan, ANNA).limitTenths).toBe(11004);
      expect(teacherOf(plan, ANNA).scopeCeilingTenths).toBeUndefined();
    }
  });

  it('does not lower the limit of a teacher whose riktmärke is already tighter than the ordinance', () => {
    const tight = state('REFUSE', rows);
    tight.read.input.policy = { ...tight.read.input.policy!, fullTimeTeachingMinutesPerWeek: 600 };
    const anna = teacherOf(planOf(tight, DTO), ANNA);
    // 600 × 1.10 = 660 min, 6 604 tenths: under the ordinance's 8 372, so it stays.
    expect(anna.limitTenths).toBe(6604);
    expect(anna.scopeCeilingTenths).toBe(8372);
  });

  it('leaves a teacher with no riktmärke (no target) as they are: their room is unknown, not the ordinance\'s', () => {
    const none = state('REFUSE', rows);
    none.read.input.policy = { ...none.read.input.policy!, fullTimeTeachingMinutesPerWeek: null };
    const anna = teacherOf(planOf(none, DTO), ANNA);
    expect(anna.limitTenths).toBeNull();
    expect(anna.keepOrShed).toBe(true);
  });
});

describe('scopeGrowthRefusal: an answer that breaks the ordinance is refused (REFUSE only)', () => {
  // Anna carries 10 lessons (430 h) of åk 7: giving her the 4 open ones is 602 h over a 600 h edge.
  const rows = [row('r1', ANNA, 10), row('r2', null, 4)];

  it('names the teacher who ends over it with more hours than they began with', () => {
    const refuse = state('REFUSE', rows);
    const plan = planOf(refuse, DTO);
    expect(scopeGrowthRefusal(refuse, plan, new Map([['r2', ANNA]]))).toBe(ANNA);
    expect(scopeGrowthRefusal(refuse, plan, new Map([['r2', BO]]))).toBeNull();
  });

  it('does not refuse under WARN or OFF, nor without the lydelser: the apply warns, or asks nothing', () => {
    for (const mode of ['WARN', 'OFF'] as const) {
      const s = state(mode, rows);
      expect(scopeGrowthRefusal(s, planOf(s, DTO), new Map([['r2', ANNA]]))).toBeNull();
    }
    const none = state('REFUSE', rows, { versions: null });
    expect(scopeGrowthRefusal(none, planOf(none, DTO), new Map([['r2', ANNA]]))).toBeNull();
  });

  it('does not refuse a teacher who is already over and gains nothing', () => {
    const over = state('REFUSE', [row('r1', ANNA, 15), row('r2', null, 4)]);
    expect(scopeGrowthRefusal(over, planOf(over, DTO), new Map([['r2', BO]]))).toBeNull();
  });
});

describe('the basis and the ordinance', () => {
  const rows = [row('r1', ANNA, 10), row('r2', null, 4)];
  const digest = (mode: 'OFF' | 'WARN' | 'REFUSE', versions?: readonly ScopeVersion[] | null) =>
    basisOf(state(mode, rows, { versions }));

  it('is the digest it always was for a school that warns or asks nothing: an undo logged before the check existed is judged against it still', () => {
    expect(digest('WARN')).toBe(digest('OFF'));
    expect(digest('WARN')).toBe(digest('WARN', null));
  });

  it('moves with the ordinance only under REFUSE, where it is part of every teacher\'s limit', () => {
    expect(digest('REFUSE')).not.toBe(digest('WARN'));
    expect(digest('REFUSE')).not.toBe(digest('REFUSE', null));
    // A new lydelse (a migration) makes an old proposal stale.
    expect(digest('REFUSE')).not.toBe(digest('REFUSE', [VERSION, { ...VERSION, code: 'NEXT', validFrom: '2030-01-01' }]));
    expect(digest('REFUSE')).toBe(digest('REFUSE'));
  });
});

/*
 * A registered exception under 11 § (AssignmentScopeAssessments): the rektor's decision that a teacher may teach beyond the span, their own
 * initiative or a single pupil or a small group. The ordinance's edge is then no ceiling for them, in the plan or in the refusal, and the
 * plan being another plan, it is a part of the basis under REFUSE. A level without an exception is none of this: OVER_OWN never refuses.
 */
describe('a teacher with a registered exception under 11 §', () => {
  const assessment = (exceptionKind: LoadScopeAssessment['exceptionKind'], levelHours: number | null = null): LoadScopeAssessment => ({
    levelHours,
    exceptionKind,
    ownInitiativeOn: exceptionKind === 'OWN_INITIATIVE' ? '2026-05-02' : null,
    note: null,
    decidedAt: '2026-03-05T08:00:00.000Z',
  });
  const withAssessments = (s: StaffingState, entries: [string, LoadScopeAssessment][]): StaffingState => {
    s.read.input.scopeAssessments = new Map(entries);
    return s;
  };
  const rows = [row('r1', ANNA, 10), row('r2', null, 4)];

  it('has no ceiling: the edge is not theirs', () => {
    const excepted = input([row('r1', ANNA, 10)]);
    excepted.scopeAssessments = new Map([[ANNA, assessment('SMALL_GROUP')]]);
    expect(scopeCeilingTenths(excepted, [VERSION], ANNA, 43)).toBeNull();
    // A colleague without one has it still.
    expect(scopeCeilingTenths(excepted, [VERSION], BO, 43)).toBe(8372);
    // A level alone is no exception.
    excepted.scopeAssessments = new Map([[ANNA, assessment(null, 500)]]);
    expect(scopeCeilingTenths(excepted, [VERSION], ANNA, 43)).toBe(8372);
  });

  it('is left to the riktmärke by the plan under REFUSE: the engine\'s limit is not lowered for them, and is for a colleague', () => {
    const plan = planOf(withAssessments(state('REFUSE', rows), [[ANNA, assessment('OWN_INITIATIVE')]]), DTO);
    expect(teacherOf(plan, ANNA).limitTenths).toBe(11004);
    expect(teacherOf(plan, ANNA).scopeCeilingTenths).toBeUndefined();
    expect(teacherOf(plan, BO).limitTenths).toBe(8372);
  });

  it('is not refused for ending over the ordinance with more hours: 430 h and the 4 open lessons make 602 h of a 600 h edge', () => {
    const s = withAssessments(state('REFUSE', rows), [[ANNA, assessment('SMALL_GROUP')]]);
    expect(scopeGrowthRefusal(s, planOf(s, DTO), new Map([['r2', ANNA]]))).toBeNull();
    const plain = withAssessments(state('REFUSE', rows), [[ANNA, assessment(null, 500)]]);
    expect(scopeGrowthRefusal(plain, planOf(plain, DTO), new Map([['r2', ANNA]]))).toBe(ANNA);
  });

  it('is part of the basis under REFUSE, who holds one and not what it says: another plan is a proposal gone old', () => {
    const digest = (entries: [string, LoadScopeAssessment][], mode: 'WARN' | 'REFUSE' = 'REFUSE') => basisOf(withAssessments(state(mode, rows), entries));
    expect(digest([[ANNA, assessment('SMALL_GROUP')]])).not.toBe(digest([]));
    expect(digest([[ANNA, assessment('SMALL_GROUP')]])).toBe(digest([[ANNA, assessment('OWN_INITIATIVE')]]));
    expect(digest([[BO, assessment('SMALL_GROUP')]])).not.toBe(digest([[ANNA, assessment('SMALL_GROUP')]]));
    // A level alone changes no plan, so no basis; and a school that registers none has the digest it would have had.
    expect(digest([[ANNA, assessment(null, 500)]])).toBe(digest([]));
    expect(digest([], 'REFUSE')).toBe(basisOf(state('REFUSE', rows)));
  });

  it('is no part of the basis under WARN, where the plan does not move for them', () => {
    const digest = (entries: [string, LoadScopeAssessment][]) => basisOf(withAssessments(state('WARN', rows), entries));
    expect(digest([[ANNA, assessment('SMALL_GROUP')]])).toBe(digest([]));
  });
});
