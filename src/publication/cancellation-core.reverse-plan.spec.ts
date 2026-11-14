import type { PrismaClient } from '@prisma/client';
import { createTxMock, type TxMock } from '../../test/utils/prisma-mock';
import { applyReinstatement, reversePlan, type BatchRow } from './cancellation-core';

jest.mock('./publish-mode', () => ({ publishModeOf: jest.fn().mockResolvedValue('DIRECT') }));

/**
 * Reversing a cancellation puts each lesson back in its room unless the room
 * is taken by then. A hall the school lets several groups use at once (Delade
 * salar) is not taken by a lesson that fits it beside this one: the generator
 * put the two there together.
 */
type Query = { where?: Record<string, any> };

const SCHOOL = 'school-1';
const HALL = 'hall';
const OTHER_GROUP = 'group-b';
const STARTS = new Date('2026-08-12T08:00:00.000Z');
const ENDS = new Date('2026-08-12T09:00:00.000Z');

describe('reversePlan and a shared room', () => {
  let tx: TxMock;
  const client = () => tx as unknown as PrismaClient;
  const batch = { id: 'batch-1', cause: 'EVENT', academicYearId: 'year-1' } as unknown as BatchRow;

  /** A Wednesday lesson, 08:00-09:00 UTC, cancelled by the batch, whose master still runs it there. */
  const arrange = (mode: 'OFF' | 'SOFT' | 'HARD', room: { canBeShared: boolean; capacity: number | null } | null) => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-01T00:00:00.000Z'));
    tx = createTxMock();
    tx.cancellationBatchLesson.findMany.mockResolvedValue([
      {
        previousNote: null,
        calendarLesson: {
          id: 'cl-1',
          date: new Date('2026-08-12T00:00:00.000Z'),
          startsAt: STARTS,
          endsAt: ENDS,
          status: 'CANCELLED',
          cancelCause: 'EVENT',
          roomId: HALL,
          masterLessonId: 'm-1',
          _count: { attendanceRecords: 0 },
        },
      },
    ]);
    tx.masterLesson.findMany.mockResolvedValue([
      {
        id: 'm-1',
        isParked: false,
        dayOfWeek: 3,
        startTime: new Date('1970-01-01T08:00:00.000Z'),
        endTime: new Date('1970-01-01T09:00:00.000Z'),
        recurrence: 'ALL_WEEKS',
        startDate: null,
        endDate: null,
      },
    ]);
    // Another lesson stands in the hall at the same hour.
    tx.calendarLesson.findFirst.mockResolvedValue({ id: 'cl-2' });
    tx.roomBooking.findFirst.mockResolvedValue(null);
    tx.lunchSetting.findUnique.mockResolvedValue({ placementSharedMode: mode });
    tx.room.findMany.mockImplementation((query: Query = {}) =>
      Promise.resolve(room !== null && query.where?.['canBeShared'] ? [{ id: HALL, ...room }] : []),
    );
    const lessonRow = (id: string, studentGroupId: string) => ({
      id,
      startsAt: STARTS,
      endsAt: ENDS,
      subjectId: 'subject-1',
      studentGroupId,
      extraGroups: [],
    });
    tx.calendarLesson.findMany.mockResolvedValue([lessonRow('cl-1', 'group-a'), lessonRow('cl-2', OTHER_GROUP)]);
    tx.user.findMany.mockImplementation((query: Query = {}) =>
      Promise.resolve(
        [
          { id: 'a1', studentGroupId: 'group-a' },
          { id: 'a2', studentGroupId: 'group-a' },
          { id: 'b1', studentGroupId: OTHER_GROUP },
          { id: 'b2', studentGroupId: OTHER_GROUP },
        ].filter((pupil) => query.where?.['studentGroupId']?.in?.includes(pupil.studentGroupId)),
      ),
    );
  };

  afterEach(() => {
    jest.useRealTimers();
  });

  it('puts the lesson back into a shared hall that holds both classes’ pupils', async () => {
    arrange('HARD', { canBeShared: true, capacity: 4 });
    const plan = await reversePlan(client(), SCHOOL, batch, 'UTC');
    expect(plan.reinstate.map((entry) => entry.id)).toEqual(['cl-1']);
    expect(plan.skipped).toEqual([]);
  });

  it('skips it as taken when their pupils together do not fit', async () => {
    arrange('SOFT', { canBeShared: true, capacity: 3 });
    const plan = await reversePlan(client(), SCHOOL, batch, 'UTC');
    expect(plan.reinstate).toEqual([]);
    expect(plan.skipped).toEqual([expect.objectContaining({ lessonId: 'cl-1', roomId: HALL, by: 'LESSON' })]);
  });

  it('skips it as before for a room not marked, a room without a capacity, or the rule off', async () => {
    for (const [mode, room] of [
      ['HARD', null],
      ['HARD', { canBeShared: true, capacity: null }],
      ['OFF', { canBeShared: true, capacity: 100 }],
    ] as const) {
      arrange(mode, room);
      const plan = await reversePlan(client(), SCHOOL, batch, 'UTC');
      expect(plan.skipped).toEqual([expect.objectContaining({ lessonId: 'cl-1', by: 'LESSON' })]);
    }
  });

  it('asks nothing about the rule when no lesson stands in the room', async () => {
    arrange('HARD', { canBeShared: true, capacity: 4 });
    tx.calendarLesson.findFirst.mockResolvedValue(null);
    const plan = await reversePlan(client(), SCHOOL, batch, 'UTC');
    expect(plan.reinstate.map((entry) => entry.id)).toEqual(['cl-1']);
    expect(tx.lunchSetting.findUnique).not.toHaveBeenCalled();
  });
});

/**
 * THE LESSON A TEMPLATE MOVED OUT FROM UNDER A BATCH. A DIRECT edit of the template moves the rows it can carry and writes none for
 * the new day, so the row the batch cancelled is the class's lesson that week: taken back, it goes to the template's slot of its week
 * (with the template's room and LEAD) and is a lesson again, instead of being deleted with nothing in its place. Wednesday 2026-08-12
 * 08:00-09:00, the template moved to Friday 10:00-11:00 after the batch was made.
 */
describe('reversePlan and a template that moved', () => {
  let tx: TxMock;
  const client = () => tx as unknown as PrismaClient;
  const batch = { id: 'batch-1', cause: 'EVENT', academicYearId: 'year-1', createdAt: new Date('2026-07-01T00:00:00.000Z') } as unknown as BatchRow;
  const cancelled = (id: string, date: string, masterLessonId: string | null = 'm-1', roomId: string | null = null, at = '08:00', until = '09:00') => ({
    previousNote: 'Tidigare anteckning',
    calendarLesson: {
      id,
      date: new Date(`${date}T00:00:00.000Z`),
      startsAt: new Date(`${date}T${at}:00.000Z`),
      endsAt: new Date(`${date}T${until}:00.000Z`),
      status: 'CANCELLED',
      cancelCause: 'EVENT',
      roomId,
      masterLessonId,
      studentGroupId: 'group-1',
      _count: { attendanceRecords: 0 },
    },
  });
  const master = (over: Record<string, unknown> = {}) => ({
    id: 'm-1',
    isParked: false,
    updatedAt: new Date('2026-07-20T00:00:00.000Z'),
    roomId: null,
    teacherId: null,
    dayOfWeek: 5,
    startTime: new Date('1970-01-01T10:00:00.000Z'),
    endTime: new Date('1970-01-01T11:00:00.000Z'),
    recurrence: 'ALL_WEEKS',
    startDate: null,
    endDate: null,
    ...over,
  });
  const arrange = (
    rows = [cancelled('cl-1', '2026-08-12')],
    masters = [master()],
    existing: Array<{ masterLessonId: string; date: string }> = [],
    school: { year?: [string, string]; breaks?: Array<Record<string, unknown>>; closures?: Array<Record<string, unknown>> } = {},
  ) => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-01T00:00:00.000Z'));
    tx = createTxMock();
    tx.cancellationBatchLesson.findMany.mockResolvedValue(rows);
    tx.masterLesson.findMany.mockResolvedValue(masters);
    tx.calendarLesson.findMany.mockResolvedValue(existing.map((entry) => ({ masterLessonId: entry.masterLessonId, date: new Date(`${entry.date}T00:00:00.000Z`) })));
    tx.calendarLesson.findFirst.mockResolvedValue(null);
    tx.roomBooking.findFirst.mockResolvedValue(null);
    // The school's days: the year, its lov and its closures, as a publication reads them.
    const [from, to] = school.year ?? ['2026-08-01', '2027-06-15'];
    tx.academicYear.findUnique.mockResolvedValue({ startDate: new Date(`${from}T00:00:00.000Z`), endDate: new Date(`${to}T00:00:00.000Z`) });
    tx.schoolBreak.findMany.mockResolvedValue(school.breaks ?? []);
    tx.availabilityConstraint.findMany.mockResolvedValue(school.closures ?? []);
    tx.studentGroup.findMany.mockResolvedValue([{ id: 'group-1', gradeLevel: 7 }]);
  };
  const closure = (over: Record<string, unknown>) => ({
    resourceType: 'STUDENT_GROUP',
    userId: null,
    roomId: null,
    studentGroupId: 'group-1',
    minGradeLevel: null,
    maxGradeLevel: null,
    date: new Date('2026-08-14T00:00:00.000Z'),
    startTime: new Date('1970-01-01T00:00:00.000Z'),
    endTime: new Date('1970-01-01T00:00:00.000Z'),
    ...over,
  });
  const lov = (over: Record<string, unknown> = {}) => ({
    startDate: new Date('2026-08-13T00:00:00.000Z'),
    endDate: new Date('2026-08-15T00:00:00.000Z'),
    minGradeLevel: null,
    maxGradeLevel: null,
    ...over,
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('carries the lesson to the template’s slot of its own week, with its note, when the new day has no row', async () => {
    arrange();
    const plan = await reversePlan(client(), SCHOOL, batch, 'UTC');
    expect(plan.reinstate).toEqual([]);
    expect(plan.templateMoved).toEqual([]);
    expect(plan.relocate).toEqual([
      {
        id: 'cl-1',
        previousNote: 'Tidigare anteckning',
        from: '2026-08-12',
        to: '2026-08-14',
        startsAt: new Date('2026-08-14T10:00:00.000Z'),
        endsAt: new Date('2026-08-14T11:00:00.000Z'),
        roomId: null,
        leadId: null,
      },
    ]);
    // One read of the new days, for the whole plan, by master and date, and not of the rows being carried: a template moved to another
    // hour of the SAME day has its new slot on the date the old row stands on, which is no lesson standing there already.
    expect(tx.calendarLesson.findMany).toHaveBeenCalledTimes(1);
    expect(tx.calendarLesson.findMany.mock.calls[0]![0].where).toEqual({
      id: { notIn: ['cl-1'] },
      masterLessonId: { in: ['m-1'] },
      date: { in: [new Date('2026-08-14T00:00:00.000Z')] },
    });
  });

  it('carries a lesson to another hour of its own day when the template only changed its hour', async () => {
    arrange([cancelled('cl-1', '2026-08-12')], [master({ dayOfWeek: 3, startTime: new Date('1970-01-01T09:30:00.000Z'), endTime: new Date('1970-01-01T10:30:00.000Z') })]);
    const plan = await reversePlan(client(), SCHOOL, batch, 'UTC');
    expect(plan.templateMoved).toEqual([]);
    expect(plan.relocate).toEqual([
      expect.objectContaining({ id: 'cl-1', from: '2026-08-12', to: '2026-08-12', startsAt: new Date('2026-08-12T09:30:00.000Z'), endsAt: new Date('2026-08-12T10:30:00.000Z') }),
    ]);
  });

  it('reads the school’s clock for the new slot, not UTC', async () => {
    arrange();
    const plan = await reversePlan(client(), SCHOOL, batch, 'Europe/Stockholm');
    expect(plan.relocate[0]).toMatchObject({ to: '2026-08-14', startsAt: new Date('2026-08-14T08:00:00.000Z'), endsAt: new Date('2026-08-14T09:00:00.000Z') });
  });

  it('puts the lesson of a week before the template’s weekday on that week’s day, and one after it on the same week’s day', async () => {
    // Sunday 2026-08-16 is a stray row's date: its ISO week is Monday 10 August to Sunday 16 August, the template's day Friday 14 August.
    arrange([cancelled('cl-sun', '2026-08-16')]);
    expect((await reversePlan(client(), SCHOOL, batch, 'UTC')).relocate[0]).toMatchObject({ from: '2026-08-16', to: '2026-08-14' });
    // Monday 10 August: the same week, the template's Friday after it.
    arrange([cancelled('cl-mon', '2026-08-10')]);
    expect((await reversePlan(client(), SCHOOL, batch, 'UTC')).relocate[0]).toMatchObject({ from: '2026-08-10', to: '2026-08-14' });
  });

  it('deletes the old row as before when the new day already has a row of the lesson: the lesson is where it runs now', async () => {
    arrange([cancelled('cl-1', '2026-08-12')], [master()], [{ masterLessonId: 'm-1', date: '2026-08-14' }]);
    const plan = await reversePlan(client(), SCHOOL, batch, 'UTC');
    expect(plan.relocate).toEqual([]);
    expect(plan.templateMoved).toEqual([{ lessonId: 'cl-1', date: '2026-08-12' }]);
  });

  it('deletes the old row and reinstates the batch’s own row that already runs at the template, instead of carrying the old one beside it', async () => {
    // A week-long batch: Wednesday was cancelled, the template moved to Friday, a publication wrote Friday and the batch took it (S7).
    // The row on the new day is a candidate of this very batch, so it must not be left out of the question "is the lesson there already?":
    // left out, both came back, two lessons that week (the review of #319).
    arrange([cancelled('cl-wed', '2026-08-12'), cancelled('cl-fri', '2026-08-14', 'm-1', null, '10:00', '11:00')], [master()], [{ masterLessonId: 'm-1', date: '2026-08-14' }]);
    const plan = await reversePlan(client(), SCHOOL, batch, 'UTC');
    expect(plan.relocate).toEqual([]);
    expect(plan.templateMoved).toEqual([{ lessonId: 'cl-wed', date: '2026-08-12' }]);
    expect(plan.reinstate.map((entry) => entry.id)).toEqual(['cl-fri']);
    // Only the rows to be carried are left out of the question: the candidate that already runs at the template is among the rows asked about.
    expect(tx.calendarLesson.findMany.mock.calls[0]![0].where.id).toEqual({ notIn: ['cl-wed'] });
  });

  it('carries one lesson a week: a second cancelled row of the same lesson in that week is deleted', async () => {
    arrange([cancelled('cl-1', '2026-08-12'), cancelled('cl-2', '2026-08-13')]);
    const plan = await reversePlan(client(), SCHOOL, batch, 'UTC');
    expect(plan.relocate.map((move) => move.id)).toEqual(['cl-1']);
    expect(plan.templateMoved.map((entry) => entry.lessonId)).toEqual(['cl-2']);
    // Both are rows to be carried, so neither counts as the lesson being there already.
    expect(tx.calendarLesson.findMany.mock.calls[0]![0].where.id).toEqual({ notIn: ['cl-1', 'cl-2'] });
  });

  it.each([
    ['a parked lesson, which has no slot', { isParked: true }],
    ['a template that ends before the new day', { endDate: new Date('2026-08-13T00:00:00.000Z') }],
    ['a template that starts after the new day', { startDate: new Date('2026-08-15T00:00:00.000Z') }],
  ])('deletes the old row as before for %s', async (_label, over) => {
    arrange([cancelled('cl-1', '2026-08-12')], [master(over)]);
    const plan = await reversePlan(client(), SCHOOL, batch, 'UTC');
    expect(plan.relocate).toEqual([]);
    expect(plan.templateMoved).toEqual([{ lessonId: 'cl-1', date: '2026-08-12' }]);
  });

  it('deletes the old row as before when the lesson has no template left', async () => {
    arrange([cancelled('cl-1', '2026-08-12')], []);
    const plan = await reversePlan(client(), SCHOOL, batch, 'UTC');
    expect(plan.relocate).toEqual([]);
    expect(plan.reinstate).toEqual([]);
    expect(plan.templateMoved).toEqual([{ lessonId: 'cl-1', date: '2026-08-12' }]);
  });

  it('puts a lesson the template never moved back where it stands, off the template’s slot: an exception made for its date, not a move of the grundschema', async () => {
    // The class teacher moved Wednesday's lesson to Thursday 14:00 (the row keeps its master); the master was written before the batch.
    arrange([cancelled('cl-1', '2026-08-13', 'm-1', null, '14:00', '15:00')], [master({ updatedAt: new Date('2026-06-01T00:00:00.000Z') })]);
    const plan = await reversePlan(client(), SCHOOL, batch, 'UTC');
    expect(plan.reinstate).toEqual([{ id: 'cl-1', previousNote: 'Tidigare anteckning' }]);
    expect(plan.relocate).toEqual([]);
    expect(plan.templateMoved).toEqual([]);
    expect(tx.calendarLesson.findMany).not.toHaveBeenCalled();
  });

  it('never carries a lesson into the past: a new slot that has begun is deleted as before', async () => {
    // The old row is ahead (Sunday 16 August), the template's Friday of that week has begun.
    arrange([cancelled('cl-1', '2026-08-16')]);
    jest.setSystemTime(new Date('2026-08-14T10:30:00.000Z'));
    const plan = await reversePlan(client(), SCHOOL, batch, 'UTC');
    expect(plan.relocate).toEqual([]);
    expect(plan.templateMoved).toEqual([{ lessonId: 'cl-1', date: '2026-08-16' }]);
  });

  it('puts a lesson of a template that has not moved back where it was, as ever, and asks nothing about new days', async () => {
    arrange([cancelled('cl-1', '2026-08-12')], [master({ dayOfWeek: 3, startTime: new Date('1970-01-01T08:00:00.000Z'), endTime: new Date('1970-01-01T09:00:00.000Z') })]);
    const plan = await reversePlan(client(), SCHOOL, batch, 'UTC');
    expect(plan.reinstate.map((entry) => entry.id)).toEqual(['cl-1']);
    expect(plan.relocate).toEqual([]);
    expect(tx.calendarLesson.findMany).not.toHaveBeenCalled();
    expect(tx.academicYear.findUnique).not.toHaveBeenCalled();
    expect(tx.schoolBreak.findMany).not.toHaveBeenCalled();
  });

  describe('the days the school has', () => {
    it.each([
      ['after the last day of the year', { year: ['2026-08-01', '2026-08-13'] as [string, string] }],
      ['before the first day of the year', { year: ['2026-08-15', '2027-06-15'] as [string, string] }],
      ['in a lov', { breaks: [lov()] }],
      ['in a lov that is for the class’s årskurs', { breaks: [lov({ minGradeLevel: 6, maxGradeLevel: 9 })] }],
      ['on a day the class is closed', { closures: [closure({})] }],
      ['on a day the class’s årskurs is closed', { closures: [closure({ resourceType: 'GRADE_LEVEL', studentGroupId: null, minGradeLevel: 7, maxGradeLevel: 7 })] }],
    ])('deletes the old row as before when the template’s day lies %s: a publication would not write the lesson there', async (_label, school) => {
      arrange([cancelled('cl-1', '2026-08-12')], [master()], [], school);
      const plan = await reversePlan(client(), SCHOOL, batch, 'UTC');
      expect(plan.relocate).toEqual([]);
      expect(plan.templateMoved).toEqual([{ lessonId: 'cl-1', date: '2026-08-12' }]);
    });

    it.each([
      ['a lov for other årskurser', { breaks: [lov({ minGradeLevel: 1, maxGradeLevel: 3 })] }],
      ['another class’s closure', { closures: [closure({ studentGroupId: 'group-2' })] }],
      ['a closure of another day', { closures: [closure({ date: new Date('2026-08-13T00:00:00.000Z') })] }],
      ['a closure of the early morning, before the lesson', { closures: [closure({ startTime: new Date('1970-01-01T06:00:00.000Z'), endTime: new Date('1970-01-01T07:00:00.000Z') })] }],
      ['a teacher’s closure, which cancels a lesson rather than takes it from the class', { closures: [closure({ resourceType: 'TEACHER', studentGroupId: null, userId: 't-1' })] }],
    ])('carries the lesson all the same past %s', async (_label, school) => {
      arrange([cancelled('cl-1', '2026-08-12')], [master()], [], school);
      const plan = await reversePlan(client(), SCHOOL, batch, 'UTC');
      expect(plan.relocate.map((move) => move.id)).toEqual(['cl-1']);
      expect(plan.templateMoved).toEqual([]);
    });

    it('asks for the whole span of the new days, once, for the school’s timezone', async () => {
      arrange([cancelled('cl-1', '2026-08-12'), cancelled('cl-2', '2026-08-19', 'm-2')], [master(), master({ id: 'm-2', dayOfWeek: 4 })]);
      await reversePlan(client(), SCHOOL, batch, 'UTC');
      expect(tx.schoolBreak.findMany).toHaveBeenCalledTimes(1);
      expect(tx.schoolBreak.findMany.mock.calls[0]![0].where).toMatchObject({
        academicYearId: 'year-1',
        startDate: { lte: new Date('2026-08-20T00:00:00.000Z') },
        endDate: { gte: new Date('2026-08-14T00:00:00.000Z') },
      });
    });
  });

  describe('the room and the teacher the template gives it', () => {
    it('carries the template’s room and LEAD with the lesson, not the ones the old row had', async () => {
      arrange([cancelled('cl-1', '2026-08-12', 'm-1', 'room-old')], [master({ roomId: 'room-new', teacherId: 'teacher-new' })]);
      const plan = await reversePlan(client(), SCHOOL, batch, 'UTC');
      expect(plan.relocate).toEqual([expect.objectContaining({ id: 'cl-1', roomId: 'room-new', leadId: 'teacher-new' })]);
    });

    it('asks about the template’s room at the new slot, not the old row’s', async () => {
      arrange([cancelled('cl-1', '2026-08-12', 'm-1', 'room-old')], [master({ roomId: 'room-new' })]);
      await reversePlan(client(), SCHOOL, batch, 'UTC');
      expect(tx.calendarLesson.findFirst.mock.calls[0]![0].where.roomId).toBe('room-new');
      expect(tx.roomBooking.findFirst.mock.calls[0]![0].where.roomId).toBe('room-new');
    });

    it('carries the lesson when the old room is taken at the new hour and the template’s room is free: it is the template’s room that matters', async () => {
      arrange([cancelled('cl-1', '2026-08-12', 'm-1', 'room-old')], [master({ roomId: 'room-new' })]);
      tx.calendarLesson.findFirst.mockImplementation((query: Query) => Promise.resolve(query.where?.['roomId'] === 'room-old' ? { id: 'other' } : null));
      const plan = await reversePlan(client(), SCHOOL, batch, 'UTC');
      expect(plan.skipped).toEqual([]);
      expect(plan.relocate).toEqual([expect.objectContaining({ id: 'cl-1', roomId: 'room-new' })]);
    });

    it('asks nothing about a room when the template has none, whatever room the old row had', async () => {
      arrange([cancelled('cl-1', '2026-08-12', 'm-1', 'room-old')], [master({ roomId: null })]);
      const plan = await reversePlan(client(), SCHOOL, batch, 'UTC');
      expect(tx.calendarLesson.findFirst).not.toHaveBeenCalled();
      expect(plan.relocate).toEqual([expect.objectContaining({ id: 'cl-1', roomId: null })]);
    });

    it('asks about the lesson’s own room at its own slot when it is put back where it stands', async () => {
      arrange([cancelled('cl-1', '2026-08-13', 'm-1', 'room-old', '14:00', '15:00')], [master({ updatedAt: new Date('2026-06-01T00:00:00.000Z'), roomId: 'room-new' })]);
      await reversePlan(client(), SCHOOL, batch, 'UTC');
      expect(tx.calendarLesson.findFirst.mock.calls[0]![0].where.roomId).toBe('room-old');
    });
  });

  it('asks about the room at the NEW slot, and names the new day when the room is taken there (the row stays cancelled where it was)', async () => {
    arrange([cancelled('cl-1', '2026-08-12', 'm-1', HALL)], [master({ roomId: HALL })]);
    tx.calendarLesson.findFirst.mockResolvedValue({ id: 'other' });
    tx.lunchSetting.findUnique.mockResolvedValue({ placementSharedMode: 'OFF' });
    const plan = await reversePlan(client(), SCHOOL, batch, 'UTC');
    expect(plan.relocate).toEqual([]);
    expect(plan.skipped).toEqual([{ lessonId: 'cl-1', date: '2026-08-14', roomId: HALL, by: 'LESSON' }]);
    const asked = tx.calendarLesson.findFirst.mock.calls[0]![0].where;
    expect(asked.startsAt).toEqual({ lt: new Date('2026-08-14T11:00:00.000Z') });
    expect(asked.endsAt).toEqual({ gt: new Date('2026-08-14T10:00:00.000Z') });
  });

  describe('applyReinstatement of a relocation', () => {
    const planOf = async (over: Record<string, unknown> = {}) => {
      arrange([cancelled('cl-1', '2026-08-12', 'm-1', 'room-old')], [master({ roomId: 'room-new', teacherId: 'teacher-new', ...over })]);
      const plan = await reversePlan(client(), SCHOOL, batch, 'UTC');
      jest.setSystemTime(new Date('2026-08-01T00:00:00.000Z'));
      tx.calendarLesson.updateMany.mockResolvedValue({ count: 1 });
      return plan;
    };

    it('writes the lesson at its new date, hours and room, scheduled, with the note it had, under the guards of a reinstatement', async () => {
      const plan = await planOf();
      await applyReinstatement(client(), 'EVENT', plan);
      expect(tx.calendarLesson.updateMany).toHaveBeenCalledWith({
        where: { id: 'cl-1', status: 'CANCELLED', cancelCause: 'EVENT', startsAt: { gt: new Date('2026-08-01T00:00:00.000Z') }, attendanceRecords: { none: {} } },
        data: {
          date: new Date('2026-08-14T00:00:00.000Z'),
          startsAt: new Date('2026-08-14T10:00:00.000Z'),
          endsAt: new Date('2026-08-14T11:00:00.000Z'),
          roomId: 'room-new',
          status: 'SCHEDULED',
          cancelCause: null,
          note: 'Tidigare anteckning',
        },
      });
      expect(tx.calendarLesson.deleteMany).not.toHaveBeenCalled();
    });

    it('gives the lesson the template’s LEAD: another teacher’s LEAD row goes, the template’s is written unless a vikarie holds the lesson', async () => {
      const plan = await planOf();
      await applyReinstatement(client(), 'EVENT', plan);
      expect(tx.calendarLessonTeacher.deleteMany).toHaveBeenCalledWith({ where: { calendarLessonId: 'cl-1', role: 'LEAD', teacherId: { not: 'teacher-new' } } });
      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
      const [strings, ...values] = tx.$executeRaw.mock.calls[0]!;
      const sql = (strings as string[]).join('?');
      expect(values).toEqual(['teacher-new', 'cl-1', 'teacher-new']);
      expect(sql).toContain(`INSERT INTO "CalendarLessonTeachers"`);
      expect(sql).toContain(`x."role" = 'SUBSTITUTE'`);
      expect(sql).toContain(`x."teacherId" = `);
    });

    it('takes the LEAD away when the template has no teacher, and writes none', async () => {
      const plan = await planOf({ teacherId: null });
      await applyReinstatement(client(), 'EVENT', plan);
      expect(tx.calendarLessonTeacher.deleteMany).toHaveBeenCalledWith({ where: { calendarLessonId: 'cl-1', role: 'LEAD' } });
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });

    it('leaves the teachers alone when a guard kept the row from being written (it changed under the plan)', async () => {
      const plan = await planOf();
      tx.calendarLesson.updateMany.mockResolvedValue({ count: 0 });
      await applyReinstatement(client(), 'EVENT', plan);
      expect(tx.calendarLessonTeacher.deleteMany).not.toHaveBeenCalled();
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });
  });
});
