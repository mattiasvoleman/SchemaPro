import type { TeacherDutyKind } from '@prisma/client';
import {
  hashStaffingCarry,
  planStaffingCarry,
  promoteLabel,
  slotsOverLessons,
  type ExistingStaffing,
  type SourceDuty,
  type SourceEmployment,
  type StaffingCarryInput,
  type StaffingWrites,
} from './rollover-staffing';

const T1 = '10000000-0000-4000-8000-000000000001';
const T2 = '10000000-0000-4000-8000-000000000002';
const GONE = '10000000-0000-4000-8000-000000000003';
const PUPIL = '10000000-0000-4000-8000-000000000004';
const G7B = 'g7b';
const G9A = 'g9a';

const post = (userId: string, extra: Partial<SourceEmployment> = {}): SourceEmployment => ({
  id: `e-${userId}`,
  userId,
  employmentPercent: '100.000',
  reductionPercent: '0.000',
  contractKind: 'FERIE',
  teachingTargetMinutesPerWeek: null,
  signature: null,
  note: null,
  ...extra,
});

let dutySeq = 0;
const duty = (userId: string, kind: TeacherDutyKind, label: string, extra: Partial<SourceDuty> = {}): SourceDuty => ({
  id: `d-${String(++dutySeq).padStart(3, '0')}`,
  userId,
  kind,
  label,
  minutesPerWeek: 30,
  countsAsTeaching: false,
  subjectId: null,
  studentGroupId: null,
  note: null,
  slot: null,
  ...extra,
});

const NAMES: Record<string, string> = { [G7B]: '7B', [G9A]: '9A' };
const SUCCESSORS: Record<string, { key: string; name: string }> = { [G7B]: { key: G7B, name: '8B' } };

function input(
  employments: SourceEmployment[],
  duties: SourceDuty[],
  existing: ExistingStaffing | null = null,
): StaffingCarryInput {
  return {
    staffing: {
      employments,
      duties,
      staff: new Map([
        [T1, { role: 'TEACHER', isActive: true }],
        [T2, { role: 'SCHOOL_ADMIN', isActive: true }],
        [GONE, { role: 'TEACHER', isActive: false }],
        [PUPIL, { role: 'STUDENT', isActive: true }],
      ]),
    },
    successorOf: (id) => SUCCESSORS[id] ?? null,
    groupName: (id) => NAMES[id] ?? null,
    existing,
  };
}

const none = (): ExistingStaffing => ({ employmentUserIds: new Set(), signatures: new Map(), duties: [] });

describe('promoteLabel (D4)', () => {
  it.each([
    ['Mentor 7B', 'Mentor 8B'],
    ['Mentor 7B/7C', 'Mentor 8B/7C'],
    ['7B och 7B igen', '8B och 8B igen'],
    ['Mentor 17B', 'Mentor 17B'],
    ['Mentor 7BX', 'Mentor 7BX'],
    ['mentor 7b', 'mentor 7b'],
    ['Studiehandledning', 'Studiehandledning'],
    ['(7B)', '(8B)'],
  ])('%s → %s', (label, promoted) => {
    expect(promoteLabel(label, '7B', '8B')).toBe(promoted);
  });

  it('keeps the source label when the promoted one would pass 80 characters', () => {
    const label = `${'x'.repeat(76)} 7B`;
    expect(promoteLabel(label, '7B', '8B')).toBe(`${'x'.repeat(76)} 8B`);
    expect(promoteLabel(label, '7B', '8B längre')).toBe(label);
  });

  it('treats letters beyond ASCII as part of a token', () => {
    expect(promoteLabel('Mentor Å7B', '7B', '8B')).toBe('Mentor Å7B');
    expect(promoteLabel('Mentor Ö7', 'Ö7', 'Ö8')).toBe('Mentor Ö8');
  });
});

describe('planStaffingCarry — the rollover (nothing in the target yet)', () => {
  it('carries every column of an active teacher’s post and uppdrag, and names per-year terms', () => {
    const plan = planStaffingCarry(
      input(
        [
          post(T1, { employmentPercent: '90.500', reductionPercent: '20.000', contractKind: 'SEMESTER', signature: 'AB', note: 'n' }),
          post(T2, { teachingTargetMinutesPerWeek: 700 }),
        ],
        [
          duty(T1, 'AMNESANSVAR', 'Ämnesansvar Ma', {
            minutesPerWeek: 40,
            countsAsTeaching: true,
            subjectId: 'ma',
            note: 'note',
            slot: { dayOfWeek: 3, startTime: '13:00', endTime: '13:45' },
          }),
        ],
      ),
    );
    expect(plan.writes.employments).toEqual([
      { sourceEmploymentId: `e-${T1}`, userId: T1, employmentPercent: '90.500', reductionPercent: '20.000', contractKind: 'SEMESTER', teachingTargetMinutesPerWeek: null, signature: 'AB', note: 'n' },
      { sourceEmploymentId: `e-${T2}`, userId: T2, employmentPercent: '100.000', reductionPercent: '0.000', contractKind: 'FERIE', teachingTargetMinutesPerWeek: 700, signature: null, note: null },
    ]);
    expect(plan.writes.duties).toEqual([
      expect.objectContaining({ userId: T1, kind: 'AMNESANSVAR', label: 'Ämnesansvar Ma', minutesPerWeek: 40, countsAsTeaching: true, subjectId: 'ma', note: 'note', groupKey: null, slot: { dayOfWeek: 3, startTime: '13:00', endTime: '13:45' } }),
    ]);
    expect(plan.preview.employments).toMatchObject({ carried: 2, withReduction: [T1], withTargetOverride: [T2] });
    expect(plan.problems).toEqual([{ code: 'STAFFING_PER_YEAR_TERMS_CARRIED', blocking: false, params: { reductions: 1, overrides: 1 } }]);
  });

  it('carries nobody who is inactive or not staff, and lists them', () => {
    const plan = planStaffingCarry(
      input([post(GONE), post(PUPIL)], [duty(GONE, 'RASTVAKT', 'Rastvakt'), duty(PUPIL, 'ANNAT', 'Något')]),
    );
    expect(plan.writes).toEqual({ employments: [], duties: [] });
    expect(plan.preview.employments.notCarried).toEqual([
      { userId: GONE, reason: 'INACTIVE' },
      { userId: PUPIL, reason: 'NOT_STAFF' },
    ]);
    expect(plan.preview.duties.notCarried.map((row) => row.reason)).toEqual(['TEACHER_NOT_CARRIED', 'TEACHER_NOT_CARRIED']);
    expect(plan.problems).toEqual([{ code: 'STAFFING_TEACHERS_NOT_CARRIED', blocking: false, params: { teachers: 2 } }]);
    // A person nobody knows (deleted between the reads) is not staff either.
    expect(planStaffingCarry(input([post('unknown')], [])).preview.employments.notCarried).toEqual([{ userId: 'unknown', reason: 'NOT_STAFF' }]);
  });

  it('moves a mentorskap to its class’s successor and relabels it; leaves one whose class has none, and drops the group of any other kind', () => {
    const plan = planStaffingCarry(
      input(
        [],
        [
          duty(T1, 'MENTORSKAP', 'Mentor 7B', { studentGroupId: G7B }),
          duty(T1, 'MENTORSKAP', 'Mentor 9A', { studentGroupId: G9A }),
          duty(T2, 'ANNAT', 'Studiehandledning 9A', { studentGroupId: G9A }),
          duty(T2, 'MENTORSKAP', 'Mentor', { studentGroupId: 'elsewhere' }),
        ],
      ),
    );
    expect(plan.writes.duties.map((row) => [row.label, row.groupKey])).toEqual([
      ['Mentor 8B', G7B],
      ['Studiehandledning 9A', null],
    ]);
    expect(plan.preview.duties.notCarried.map((row) => [row.label, row.reason, row.groupName])).toEqual([
      ['Mentor 9A', 'GROUP_LEAVES', '9A'],
      ['Mentor', 'GROUP_LEAVES', null],
    ]);
    expect(plan.preview.duties.groupDropped).toEqual([expect.objectContaining({ label: 'Studiehandledning 9A', groupName: '9A' })]);
    expect(plan.preview.duties.relabelled).toEqual([expect.objectContaining({ from: 'Mentor 7B', to: 'Mentor 8B' })]);
    expect(plan.problems.map((problem) => [problem.code, problem.params])).toEqual([
      ['STAFFING_MENTORSKAP_NOT_CARRIED', { duties: 2, groups: ['9A'] }],
      ['STAFFING_DUTY_GROUP_DROPPED', { duties: 1, groups: ['9A'] }],
    ]);
  });

  it('carries a slot on the grid as HH:MM, and an uppdrag whose slot is off the grid without it', () => {
    const plan = planStaffingCarry(
      input(
        [],
        [
          duty(T1, 'RASTVAKT', 'Rast', { slot: { dayOfWeek: 2, startTime: '10:00', endTime: '10:20' } }),
          duty(T1, 'APT_KONFERENS', 'APT', { slot: { dayOfWeek: 2, startTime: '15:02', endTime: '16:00' } }),
          duty(T1, 'ANNAT', 'Sekund', { slot: { dayOfWeek: 4, startTime: '08:00:30', endTime: '09:00' } }),
        ],
      ),
    );
    expect(plan.writes.duties.map((row) => row.slot)).toEqual([{ dayOfWeek: 2, startTime: '10:00', endTime: '10:20' }, null, null]);
    expect(plan.preview.duties).toMatchObject({ carried: 3, slots: 1 });
    expect(plan.preview.duties.slotDropped.map((row) => row.label)).toEqual(['APT', 'Sekund']);
    expect(plan.problems).toEqual([{ code: 'STAFFING_SLOT_OFF_GRID', blocking: false, params: { duties: 2 } }]);
  });

  it('sums each teacher’s carried uppdrag, sorted by teacher', () => {
    const plan = planStaffingCarry(input([post(T2)], [duty(T1, 'RASTVAKT', 'R', { minutesPerWeek: 20 }), duty(T1, 'ANNAT', 'A', { minutesPerWeek: 25 })]));
    expect(plan.preview.teachers).toEqual([
      { userId: T1, employment: 'NONE', duties: 2, dutyMinutesPerWeek: 45 },
      { userId: T2, employment: 'CARRIED', duties: 0, dutyMinutesPerWeek: 0 },
    ]);
  });
});

describe('planStaffingCarry — into a year that already has rows (2)', () => {
  it('drops a signature another teacher holds in the target, and keeps the post', () => {
    const existing = { ...none(), signatures: new Map([['AB', T2]]) };
    const plan = planStaffingCarry(input([post(T1, { signature: 'AB' })], [], existing));
    expect(plan.writes.employments[0]).toMatchObject({ userId: T1, signature: null });
    expect(plan.preview.employments.signaturesDropped).toEqual([{ userId: T1, signature: 'AB' }]);
    expect(plan.problems).toEqual([{ code: 'STAFFING_SIGNATURE_TAKEN', blocking: false, params: { teachers: 1 } }]);
  });

  it('skips a teacher who has a post in the target whole: the post and every uppdrag (C2)', () => {
    const existing = { ...none(), employmentUserIds: new Set([T1]) };
    const plan = planStaffingCarry(input([post(T1)], [duty(T1, 'RASTVAKT', 'Rastvakt'), duty(T1, 'ANNAT', 'Ny sak')], existing));
    expect(plan.writes).toEqual({ employments: [], duties: [] });
    expect(plan.preview.employments.notCarried).toEqual([{ userId: T1, reason: 'ALREADY_PRESENT' }]);
    expect(plan.preview.duties.notCarried.map((row) => row.reason)).toEqual(['TEACHER_ALREADY_SET_UP', 'TEACHER_ALREADY_SET_UP']);
    expect(plan.preview.teachers).toEqual([{ userId: T1, employment: 'ALREADY_PRESENT', duties: 0, dutyMinutesPerWeek: 0 }]);
    expect(plan.problems).toEqual([{ code: 'STAFFING_ALREADY_PRESENT', blocking: false, params: { teachers: 1, duties: 2 } }]);
  });

  it('matches uppdrag one to one: two source "Rastvakt" against one in the target carry one', () => {
    const existing = { ...none(), duties: [{ id: 't1', userId: T1, kind: 'RASTVAKT' as const, label: ' rastvakt', groupKey: null, slot: null }] };
    const plan = planStaffingCarry(input([], [duty(T1, 'RASTVAKT', 'Rastvakt'), duty(T1, 'RASTVAKT', 'Rastvakt')], existing));
    expect(plan.writes.duties).toHaveLength(1);
    expect(plan.preview.duties.notCarried.map((row) => row.reason)).toEqual(['ALREADY_PRESENT']);
  });

  it('finds a mentorskap on the successor group after the class was renamed, and does not take another class’s bare "Mentor" for it', () => {
    const renamed = { ...none(), duties: [{ id: 't1', userId: T1, kind: 'MENTORSKAP' as const, label: 'Mentor 8B (bytt namn)', groupKey: G7B, slot: null }] };
    expect(planStaffingCarry(input([], [duty(T1, 'MENTORSKAP', 'Mentor 7B', { studentGroupId: G7B })], renamed)).writes.duties).toEqual([]);

    const otherClass = { ...none(), duties: [{ id: 't1', userId: T1, kind: 'MENTORSKAP' as const, label: 'Mentor', groupKey: 'target:8c', slot: null }] };
    const plan = planStaffingCarry(input([], [duty(T1, 'MENTORSKAP', 'Mentor', { studentGroupId: G7B })], otherClass));
    expect(plan.writes.duties).toEqual([expect.objectContaining({ label: 'Mentor', groupKey: G7B })]);
  });

  it('matches a promoted label too: "Mentor 7B" against a groupless "Mentor 8B"', () => {
    const existing = { ...none(), duties: [{ id: 't1', userId: T1, kind: 'MENTORSKAP' as const, label: 'Mentor 8B', groupKey: null, slot: null }] };
    expect(planStaffingCarry(input([], [duty(T1, 'MENTORSKAP', 'Mentor 7B', { studentGroupId: G7B })], existing)).writes.duties).toEqual([]);
  });

  it('flags a carried slot that overlaps one the teacher has in the target, and a mentorskap whose class already has a mentor', () => {
    const existing = {
      ...none(),
      duties: [
        { id: 't-apt', userId: T1, kind: 'APT_KONFERENS' as const, label: 'Konferens', groupKey: null, slot: { dayOfWeek: 2, startTime: '15:00', endTime: '17:00' } },
        { id: 't-mentor', userId: T2, kind: 'MENTORSKAP' as const, label: 'Mentor 8B', groupKey: G7B, slot: null },
      ],
    };
    const plan = planStaffingCarry(
      input(
        [],
        [
          duty(T1, 'APT_KONFERENS', 'APT', { slot: { dayOfWeek: 2, startTime: '16:00', endTime: '17:00' } }),
          duty(T1, 'MENTORSKAP', 'Mentor 7B', { studentGroupId: G7B }),
        ],
        existing,
      ),
    );
    expect(plan.writes.duties).toHaveLength(2);
    expect(plan.preview.duties.overlapsTargetDuty).toEqual([expect.objectContaining({ label: 'APT', targetDutyId: 't-apt' })]);
    expect(plan.preview.duties.successorHasMentor).toEqual([expect.objectContaining({ label: 'Mentor 7B', groupName: '8B' })]);
  });

  it('counts the lessons a carried slot would land on, the teacher’s own as lead or co-teacher', () => {
    const writes: StaffingWrites = {
      employments: [],
      duties: [
        { sourceDutyId: 'a', userId: T1, kind: 'RASTVAKT', label: 'R', minutesPerWeek: 20, countsAsTeaching: false, subjectId: null, groupKey: null, note: null, slot: { dayOfWeek: 1, startTime: '10:00', endTime: '10:30' } },
        { sourceDutyId: 'b', userId: T2, kind: 'RASTVAKT', label: 'R', minutesPerWeek: 20, countsAsTeaching: false, subjectId: null, groupKey: null, note: null, slot: { dayOfWeek: 1, startTime: '12:00', endTime: '12:30' } },
      ],
    };
    const lessons = [
      { teacherId: T1, coTeacherId: null, dayOfWeek: 1, startTime: '10:20', endTime: '11:00' },
      { teacherId: 'x', coTeacherId: T1, dayOfWeek: 1, startTime: '09:00', endTime: '10:05' },
      { teacherId: T1, coTeacherId: null, dayOfWeek: 1, startTime: '10:30', endTime: '11:00' },
      { teacherId: T2, coTeacherId: null, dayOfWeek: 2, startTime: '12:00', endTime: '12:30' },
    ];
    expect(slotsOverLessons(writes, lessons)).toEqual({ code: 'STAFFING_SLOTS_OVER_LESSONS', blocking: false, params: { duties: 1, lessons: 2 } });
    expect(slotsOverLessons(writes, [])).toBeNull();
  });

  it('plans nothing over its own result (idempotent)', () => {
    const source = input(
      [post(T1, { signature: 'AB' })],
      [duty(T1, 'MENTORSKAP', 'Mentor 7B', { studentGroupId: G7B, slot: { dayOfWeek: 1, startTime: '08:00', endTime: '08:30' } }), duty(T2, 'RASTVAKT', 'Rast')],
      none(),
    );
    const first = planStaffingCarry(source);
    const after: ExistingStaffing = {
      employmentUserIds: new Set(first.writes.employments.map((row) => row.userId)),
      signatures: new Map(first.writes.employments.filter((row) => row.signature).map((row) => [row.signature!, row.userId])),
      duties: first.writes.duties.map((row, index) => ({ id: `t${index}`, userId: row.userId, kind: row.kind, label: row.label, groupKey: row.groupKey, slot: row.slot })),
    };
    const second = planStaffingCarry({ ...source, existing: after });
    expect(second.writes).toEqual({ employments: [], duties: [] });
    expect(second.preview.teachers.every((row) => row.duties === 0)).toBe(true);
  });

  it('hashes the writes whatever order the rows were read in', () => {
    const rows = [duty(T1, 'RASTVAKT', 'A'), duty(T2, 'ANNAT', 'B'), duty(T1, 'APT_KONFERENS', 'C')];
    const one = planStaffingCarry(input([post(T1), post(T2)], rows));
    const two = planStaffingCarry(input([post(T2), post(T1)], [...rows].reverse()));
    expect(hashStaffingCarry('s', 't', one.writes)).toBe(hashStaffingCarry('s', 't', two.writes));
    expect(hashStaffingCarry('s', 't', one.writes)).not.toBe(hashStaffingCarry('s', 'other', one.writes));
  });
});
