import { slotPercentOf, toScheduledRequirements, type ScheduledMaster, type SlotRequirement } from './scheduled-load';
import { buildTeacherLoadReport, type LoadInput, type LoadRequirement } from './teacher-load';

const YEAR = { startDate: '2026-08-17', endDate: '2027-06-11' };
const ANNA = 'anna';
const BO = 'bo';
const MA = 'ma';

const requirement = (overrides: Partial<LoadRequirement> = {}): LoadRequirement => ({
  id: 'r-7a',
  subjectId: MA,
  subjectName: 'Matematik',
  studentGroupId: '7a',
  groupName: '7A',
  teacherId: ANNA,
  coTeacherId: null,
  lessonsPerWeek: 3,
  minutesPerLesson: 60,
  lessonLengths: [],
  teacherLoadPercent: 100,
  coTeacherLoadPercent: 100,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  gradeSpan: { min: 7, max: 7 },
  ...overrides,
});

const master = (id: string, overrides: Partial<ScheduledMaster> = {}): ScheduledMaster => ({
  id,
  subjectId: MA,
  subjectName: 'Matematik',
  studentGroupId: '7a',
  groupName: '7A',
  extraGroupIds: [],
  teacherId: ANNA,
  coTeacherId: null,
  dayOfWeek: 1,
  startTime: '08:00',
  endTime: '09:00',
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  isParked: false,
  ...overrides,
});

const input = (requirements: LoadRequirement[]): LoadInput => ({
  year: YEAR,
  policy: null,
  employments: [],
  requirements,
  qualifications: [],
  closures: [{ startDate: '2026-12-21', endDate: '2027-01-06', minGradeLevel: null, maxGradeLevel: null }],
  duties: [],
});

const span = () => ({ min: 7, max: 7 });
const weekly = (rows: LoadRequirement[]) =>
  Object.fromEntries(buildTeacherLoadReport(input(rows)).teachers.map((t) => [t.userId, t.assignedMinutesPerWeek]));

describe('slotPercentOf', () => {
  const rows: SlotRequirement[] = [
    { studentGroupId: '7a', subjectId: MA, teacherId: ANNA, coTeacherId: BO, teacherLoadPercent: 50, coTeacherLoadPercent: 30 },
    { studentGroupId: '7b', subjectId: MA, teacherId: ANNA, coTeacherId: null, teacherLoadPercent: 50, coTeacherLoadPercent: 100 },
    { studentGroupId: '7a', subjectId: 'sv', teacherId: BO, coTeacherId: null, teacherLoadPercent: 80, coTeacherLoadPercent: 100 },
  ];

  it('sums the rows of every group on the lesson that name the person, at the role they hold there', () => {
    // Samläst 7A+7B: 50 + 50.
    expect(slotPercentOf(['7a', '7b'], MA, 'LEAD', ANNA, rows)).toBe(100);
    // Bo is the co-teacher of 7A's row only.
    expect(slotPercentOf(['7a', '7b'], MA, 'ASSISTANT', BO, rows)).toBe(30);
    // The owner's row alone.
    expect(slotPercentOf(['7a'], MA, 'LEAD', ANNA, rows)).toBe(50);
  });

  it('falls back to the owner group’s row for the slot when no row names the person', () => {
    expect(slotPercentOf(['7a'], MA, 'LEAD', 'cy', rows)).toBe(50);
    expect(slotPercentOf(['7a'], MA, 'ASSISTANT', 'cy', rows)).toBe(30);
    expect(slotPercentOf(['7a'], MA, 'LEAD', null, rows)).toBe(50);
  });

  it('is 100 without a row, and always for a vikarie', () => {
    expect(slotPercentOf(['8a'], MA, 'LEAD', ANNA, rows)).toBe(100);
    expect(slotPercentOf(['7a'], 'bi', 'LEAD', ANNA, rows)).toBe(100);
    expect(slotPercentOf(['7a'], MA, 'SUBSTITUTE', ANNA, rows)).toBe(100);
  });
});

describe('toScheduledRequirements', () => {
  it('an untouched generated schedule reads exactly as planned', () => {
    const planned = [requirement(), requirement({ id: 'r-odd', subjectId: 'sl', subjectName: 'Slöjd', recurrence: 'ODD_WEEKS', lessonsPerWeek: 1, minutesPerLesson: 80 })];
    const masters = [
      master('a'), master('b', { dayOfWeek: 2 }), master('c', { dayOfWeek: 3 }),
      master('odd', { subjectId: 'sl', subjectName: 'Slöjd', recurrence: 'ODD_WEEKS', startTime: '10:00', endTime: '11:20' }),
    ];
    expect(weekly(toScheduledRequirements(masters, planned, span, null))).toEqual(weekly(planned));
  });

  it('counts each lesson at its own length: a split row and its two lessons agree, a shortened lesson is short', () => {
    const split = [requirement({ lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40] })];
    const masters = [master('long', { endTime: '09:20' }), master('short', { dayOfWeek: 3, endTime: '08:40' })];
    expect(weekly(toScheduledRequirements(masters, split, span, null))).toEqual({ [ANNA]: 120 });
    expect(weekly(split)).toEqual({ [ANNA]: 120 });
    expect(weekly(toScheduledRequirements([master('long', { endTime: '09:00' })], split, span, null))).toEqual({ [ANNA]: 60 });
  });

  it('leaves a parked lesson out, and honours a dated window as the planned row does', () => {
    const autumn = { startDate: '2026-08-17', endDate: '2026-12-18' };
    const planned = [requirement({ lessonsPerWeek: 1, ...autumn })];
    const masters = [master('dated', autumn), master('parked', { isParked: true })];
    expect(weekly(toScheduledRequirements(masters, planned, span, null))).toEqual(weekly(planned));
  });

  it('charges each slot its row’s percentage, and 100 for a lesson nobody planned', () => {
    const planned = [requirement({ coTeacherId: BO, teacherLoadPercent: 100, coTeacherLoadPercent: 50, lessonsPerWeek: 1 })];
    const rows = toScheduledRequirements(
      [master('co', { coTeacherId: BO }), master('hand', { subjectId: 'bi', subjectName: 'Biologi', dayOfWeek: 4 })],
      planned,
      span,
      null,
    );
    expect(rows.map((row) => [row.id, row.teacherLoadPercent, row.coTeacherLoadPercent])).toEqual([
      ['m:co', 100, 50],
      ['m:hand', 100, 100],
    ]);
    expect(weekly(rows)).toEqual({ [ANNA]: 120, [BO]: 30 });
  });

  it('samläsning: one lesson for 7A+7B charges the sum of the two rows — 50/50 and 100/100 both equal planned', () => {
    for (const percent of [50, 100]) {
      const planned = [
        requirement({ teacherLoadPercent: percent }),
        requirement({ id: 'r-7b', studentGroupId: '7b', groupName: '7B', teacherLoadPercent: percent }),
      ];
      const masters = ['a', 'b', 'c'].map((id, i) => master(id, { extraGroupIds: ['7b'], dayOfWeek: i + 1 }));
      expect(weekly(toScheduledRequirements(masters, planned, span, null))).toEqual(weekly(planned));
    }
  });

  it('carries the subject weight only when one is handed in, as readLoadInput does under FACTOR', () => {
    expect(toScheduledRequirements([master('a')], [], span, null)[0]).not.toHaveProperty('loadWeight');
    expect(toScheduledRequirements([master('a')], [], span, () => 0.7)[0]).toMatchObject({ loadWeight: 0.7 });
  });

  it('asks the span of every group the lesson is for', () => {
    const asked: string[][] = [];
    toScheduledRequirements([master('a', { extraGroupIds: ['7b', '7a'] })], [], (ids) => (asked.push(ids), null), null);
    expect(asked).toEqual([['7a', '7b']]);
  });
});
