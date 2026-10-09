import { buildReconciliation, type CreditRow, type ReconciliationInput } from './staffing-reconciliation';
import type { ScheduledMaster } from './scheduled-load';
import type { LoadRequirement } from './teacher-load';

const YEAR = { startDate: '2026-08-17', endDate: '2027-06-11' };
const ANNA = 'aaaaaaaa-0000-4000-8000-000000000001';
const BO = 'bbbbbbbb-0000-4000-8000-000000000002';
const CY = 'cccccccc-0000-4000-8000-000000000003';
const DAG = 'dddddddd-0000-4000-8000-000000000004';
const G7A = '77777777-0000-4000-8000-00000000007a';
const G7B = '77777777-0000-4000-8000-00000000007b';
const MA = 'ma';

/** Every weekday of the year: a calendar published whole. */
function weekdays(from: string, to: string, skip: string[] = []): string[] {
  const days: string[] = [];
  for (let at = new Date(`${from}T00:00:00Z`); at <= new Date(`${to}T00:00:00Z`); at.setUTCDate(at.getUTCDate() + 1)) {
    const day = at.toISOString().slice(0, 10);
    if (at.getUTCDay() !== 0 && at.getUTCDay() !== 6 && !skip.includes(day)) days.push(day);
  }
  return days;
}

const requirement: LoadRequirement = {
  id: 'r-ma',
  subjectId: MA,
  subjectName: 'Matematik',
  studentGroupId: G7A,
  groupName: '7A',
  teacherId: ANNA,
  coTeacherId: BO,
  lessonsPerWeek: 3,
  minutesPerLesson: 60,
  lessonLengths: [],
  teacherLoadPercent: 100,
  coTeacherLoadPercent: 50,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  gradeSpan: { min: 7, max: 7 },
};

const master = (id: string, dayOfWeek: number, overrides: Partial<ScheduledMaster> = {}): ScheduledMaster => ({
  id,
  subjectId: MA,
  subjectName: 'Matematik',
  studentGroupId: G7A,
  groupName: '7A',
  extraGroupIds: [],
  teacherId: ANNA,
  coTeacherId: BO,
  dayOfWeek,
  startTime: '08:00',
  endTime: '09:00',
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  isParked: false,
  ...overrides,
});

const t = (personId: string, role: string, bucket: string, minutes: number, lessons: number, extra: string[] = []): CreditRow => ({
  kind: 'T', personId, role, subjectId: MA, studentGroupId: G7A, extraGroupIds: extra, bucket, minutes, lessons,
});

/**
 * Two weeks, 7–18 September 2026, of a Ma row Anna leads at 100 % and Bo
 * co-teaches at 50 %: three 60-minute lessons a week. Of the six: four held
 * by both, one by Cy as vikarie (the flow replaced both rows), one cancelled
 * because the teacher was away (the rows stay). Dag's LEAD row sits beside
 * Cy's SUBSTITUTE on another lesson (a master re-teacher on top of a vikarie).
 */
const credits: CreditRow[] = [
  t(ANNA, 'LEAD', 'DELIVERED', 240, 4),
  t(BO, 'ASSISTANT', 'DELIVERED', 240, 4),
  t(CY, 'SUBSTITUTE', 'DELIVERED', 60, 1),
  t(ANNA, 'LEAD', 'CANCELLED_TEACHER_UNAVAILABLE', 60, 1),
  t(BO, 'ASSISTANT', 'CANCELLED_TEACHER_UNAVAILABLE', 60, 1),
  t(DAG, 'LEAD', 'DISPLACED', 60, 1),
  t(ANNA, 'LEAD', 'CANCELLED_ON_BREAK', 60, 1),
  { kind: 'C', personId: ANNA, role: 'LEAD', subjectId: MA, studentGroupId: G7A, extraGroupIds: [], bucket: 'DELIVERED', minutes: 60, lessons: 1 },
  { kind: 'C', personId: BO, role: 'ASSISTANT', subjectId: MA, studentGroupId: G7A, extraGroupIds: [], bucket: 'DELIVERED', minutes: 60, lessons: 1 },
  { kind: 'G', personId: null, role: null, subjectId: MA, studentGroupId: G7A, extraGroupIds: null, bucket: 'CANCELLED_TEACHER_UNAVAILABLE', minutes: 60, lessons: 1 },
  { kind: 'G', personId: null, role: null, subjectId: MA, studentGroupId: G7B, extraGroupIds: null, bucket: 'TEACHERLESS', minutes: 40, lessons: 1 },
];

const base = (overrides: Partial<ReconciliationInput> = {}): ReconciliationInput => ({
  year: YEAR,
  from: '2026-09-07',
  to: '2026-09-18',
  clamped: false,
  asOfDate: '2026-10-09',
  loadModel: 'MINUTES',
  published: { from: '2026-08-17', through: '2027-06-11' },
  publishedDays: weekdays('2026-08-17', '2026-10-09'),
  requirements: [requirement],
  employmentUserIds: [ANNA, BO],
  groups: [
    { id: G7A, gradeLevel: 7, kind: 'CLASS' },
    { id: G7B, gradeLevel: 7, kind: 'CLASS' },
  ],
  closures: [],
  masters: [master('mon', 1), master('wed', 3), master('fri', 5)],
  publish: { breaks: [], closures: [], timezone: 'Europe/Stockholm' },
  credits,
  weightOf: () => 1,
  own: null,
  ...overrides,
});

const row = (result: ReturnType<typeof buildReconciliation>, userId: string) =>
  result.teachers.find((teacher) => teacher.userId === userId)!;

describe('buildReconciliation', () => {
  it('planned and scheduled agree for a schedule that went to plan, each role at its percentage', () => {
    const result = buildReconciliation(base());
    expect(row(result, ANNA)).toMatchObject({ planned: 360, scheduled: 360 });
    expect(row(result, BO)).toMatchObject({ planned: 180, scheduled: 180 });
    expect(result.comparison).toEqual({ from: '2026-09-07', to: '2026-09-18' });
  });

  it('credits the held lessons to the rows on them: lead and co-teacher at their percentages, the vikarie at 100 %', () => {
    const result = buildReconciliation(base());
    expect(row(result, ANNA)).toMatchObject({ delivered: 240, substituteMinutes: 0, deliveredLessons: 4 });
    expect(row(result, BO)).toMatchObject({ delivered: 120, deliveredLessons: 4 });
    expect(row(result, CY)).toMatchObject({ planned: 0, scheduled: 0, delivered: 60, substituteMinutes: 60, deliveredLessons: 1 });
    expect(row(result, CY).lines).toEqual([
      { subjectId: MA, studentGroupId: G7A, extraGroupIds: [], planned: 0, scheduled: 0, delivered: 60, substituteMinutes: 60, lostMinutes: 0 },
    ]);
  });

  it('names what others covered of each grundschema slot, the co-teacher’s too, at the slot’s percentage', () => {
    const result = buildReconciliation(base());
    expect(row(result, ANNA).coveredByOthersMinutes).toBe(60);
    expect(row(result, BO).coveredByOthersMinutes).toBe(30);
  });

  it('counts the cancelled lesson as lost for the teachers whose rows it kept, by cause; a lov cancellation is neither', () => {
    const result = buildReconciliation(base());
    expect(row(result, ANNA).lost).toEqual({
      cancelledTeacherUnavailable: 60,
      cancelledRoomUnavailable: 0,
      cancelledManual: 0,
      cancelledUnknown: 0,
      otherStatus: 0,
    });
    expect(row(result, ANNA).lostMinutes).toBe(60);
    expect(row(result, BO).lostMinutes).toBe(30);
    // Held + lost + covered is the scheduled, for both.
    expect(240 + 60 + 60).toBe(row(result, ANNA).scheduled);
    expect(120 + 30 + 30).toBe(row(result, BO).scheduled);
  });

  it('credits a LEAD beside a SUBSTITUTE to nobody and tells the admin', () => {
    const result = buildReconciliation(base());
    expect(row(result, DAG)).toMatchObject({ delivered: 0, displacedLessons: 1, lines: [] });
    expect(result.notices).toContainEqual({ code: 'STAFFING_LEAD_BESIDE_SUBSTITUTE', params: { lessons: 1 } });
  });

  it('charges a row beside a vikarie no lost or coming minutes: the vikarie carries them, once', () => {
    const result = buildReconciliation(
      base({
        credits: [
          t(CY, 'SUBSTITUTE', 'CANCELLED_TEACHER_UNAVAILABLE', 60, 1),
          t(DAG, 'LEAD', 'DISPLACED_NOT_HELD', 60, 1),
          t(CY, 'SUBSTITUTE', 'AHEAD', 60, 1),
          t(DAG, 'LEAD', 'DISPLACED_NOT_HELD', 60, 1),
        ],
      }),
    );
    expect(row(result, CY)).toMatchObject({ lostMinutes: 60, aheadMinutes: 60 });
    expect(row(result, DAG)).toMatchObject({ lostMinutes: 0, aheadMinutes: 0, displacedLessons: 0, lines: [] });
    expect(result.notices.map((notice) => notice.code)).not.toContain('STAFFING_LEAD_BESIDE_SUBSTITUTE');
  });

  it('lists the bortfall per group in the pupils’ minutes, with teacherless lessons, for the admin', () => {
    const result = buildReconciliation(base());
    expect(result.groupLosses).toEqual([
      expect.objectContaining({ studentGroupId: G7A, subjectId: MA, cancelledTeacherUnavailable: 60, teacherless: 0, lessons: 1 }),
      expect.objectContaining({ studentGroupId: G7B, subjectId: MA, teacherless: 40, lessons: 1 }),
    ]);
    expect(result.totals).toEqual({
      planned: 540,
      scheduled: 540,
      delivered: 420,
      substituteMinutes: 60,
      coveredByOthersMinutes: 90,
      lostMinutes: 90,
      aheadMinutes: 0,
    });
  });

  it('gives a teacher their own row only: no colleague, no group losses, no totals, no displaced count', () => {
    const result = buildReconciliation(base({ own: ANNA }));
    expect(result.teachers.map((teacher) => teacher.userId)).toEqual([ANNA]);
    expect(result.groupLosses).toEqual([]);
    expect(result.totals).toBeNull();
    expect(row(result, ANNA).displacedLessons).toBeNull();
    expect(result.notices.map((notice) => notice.code)).not.toContain('STAFFING_LEAD_BESIDE_SUBSTITUTE');
  });

  it('weighs every charged figure by the subject’s factor under FACTOR, and the group losses not at all', () => {
    const result = buildReconciliation(base({ loadModel: 'FACTOR', weightOf: () => 1.5, requirements: [{ ...requirement, loadWeight: 1.5 }] }));
    expect(result.loadModel).toBe('FACTOR');
    expect(row(result, ANNA)).toMatchObject({ planned: 540, scheduled: 540, delivered: 360, coveredByOthersMinutes: 90, lostMinutes: 90 });
    expect(row(result, CY)).toMatchObject({ delivered: 90, substituteMinutes: 90 });
    expect(result.groupLosses[0]).toMatchObject({ cancelledTeacherUnavailable: 60 });
  });

  it('charges a samläst lesson the sum of the rows that name the teacher', () => {
    const rows = [
      { ...requirement, coTeacherId: null, teacherLoadPercent: 50 },
      { ...requirement, id: 'r-7b', studentGroupId: G7B, groupName: '7B', coTeacherId: null, teacherLoadPercent: 50 },
    ];
    const result = buildReconciliation(
      base({
        requirements: rows,
        masters: [1, 3, 5].map((day) => master(`m${day}`, day, { extraGroupIds: [G7B], coTeacherId: null })),
        credits: [t(ANNA, 'LEAD', 'DELIVERED', 360, 6, [G7B])],
      }),
    );
    // Planned 2 × (3 × 60 × 2 weeks × 50 %); scheduled and delivered six lessons at 100 %.
    expect(row(result, ANNA)).toMatchObject({ planned: 360, scheduled: 360, delivered: 360 });
    expect(row(result, ANNA).lines.find((line) => line.studentGroupId === G7A)).toMatchObject({ extraGroupIds: [G7B] });
  });

  it('measures the plan from the first published day, and names the gap two publishes left', () => {
    const result = buildReconciliation(
      base({
        published: { from: '2026-09-14', through: '2027-06-11' },
        publishedDays: weekdays('2026-09-14', '2026-10-09', ['2026-09-16']),
      }),
    );
    expect(result.comparison).toEqual({ from: '2026-09-14', to: '2026-09-18' });
    expect(row(result, ANNA)).toMatchObject({ planned: 180, scheduled: 180 });
    expect(result.notices).toContainEqual({ code: 'STAFFING_RANGE_BEFORE_PUBLISHED', params: { publishedFrom: '2026-09-14' } });
    expect(result.notices).toContainEqual({
      code: 'STAFFING_RANGE_HAS_GAPS',
      params: { days: 1, from: '2026-09-16', through: '2026-09-16' },
    });
  });

  it('says so when nothing is published, when the range reaches today, and when it was clamped', () => {
    const result = buildReconciliation(
      base({ published: null, publishedDays: [], credits: [], to: '2026-10-09', clamped: true }),
    );
    expect(result.notices.map((notice) => notice.code)).toEqual([
      'STAFFING_RANGE_CLAMPED',
      'STAFFING_NOTHING_PUBLISHED',
      'STAFFING_RANGE_INCLUDES_FUTURE',
    ]);
    expect(row(result, ANNA).delivered).toBe(0);
  });

  it('counts a lesson in the range not yet ended as ahead, not delivered', () => {
    const result = buildReconciliation(base({ credits: [t(ANNA, 'LEAD', 'AHEAD', 120, 2), t(ANNA, 'LEAD', 'AHEAD_CANCELLED', 60, 1)] }));
    expect(row(result, ANNA)).toMatchObject({ aheadMinutes: 120, delivered: 0, lostMinutes: 0 });
  });

  it('rounds each line, each teacher and the totals once, from unrounded sums', () => {
    // Two lines of 0,4 minutes each: 0 and 0 on the lines, 1 on the teacher.
    const tiny = [
      { ...requirement, coTeacherId: null, teacherLoadPercent: 1 },
      { ...requirement, id: 'r-7b', studentGroupId: G7B, coTeacherId: null, teacherLoadPercent: 1 },
    ];
    const result = buildReconciliation(
      base({
        requirements: tiny,
        masters: [],
        credits: [
          t(ANNA, 'LEAD', 'DELIVERED', 40, 1),
          { ...t(ANNA, 'LEAD', 'DELIVERED', 40, 1), studentGroupId: G7B },
        ],
      }),
    );
    expect(row(result, ANNA).lines.map((line) => line.delivered)).toEqual([0, 0]);
    expect(row(result, ANNA).delivered).toBe(1);
  });

  it('skips the scheduled walk on a lov day as publish does, by the group’s own årskurs', () => {
    const lov = { startDate: '2026-09-14', endDate: '2026-09-18', minGradeLevel: 7, maxGradeLevel: 9 };
    const result = buildReconciliation(
      base({
        closures: [lov],
        publish: {
          breaks: [{ startDate: new Date('2026-09-14T00:00:00Z'), endDate: new Date('2026-09-18T00:00:00Z'), minGradeLevel: 7, maxGradeLevel: 9 }],
          closures: [],
          timezone: 'Europe/Stockholm',
        },
      }),
    );
    // One week of the two is lov for åk 7: planned and scheduled both halve.
    expect(row(result, ANNA)).toMatchObject({ planned: 180, scheduled: 180 });
  });
});
