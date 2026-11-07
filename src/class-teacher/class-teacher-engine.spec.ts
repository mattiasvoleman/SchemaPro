import { BadRequestException, ConflictException } from '@nestjs/common';
import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import type { MasterLessonsService } from '../calendar/master-lessons.service';
import type { CalendarLessonsService } from '../calendar/calendar-lessons.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { datedConflicts } from './dated-conflicts';
import {
  askFrame,
  ClassTeacherEngine,
  diffSnapshots,
  frameInputOf,
  lessonState,
  toChangeView,
  type ChangeRow,
} from './class-teacher-engine';

jest.mock('./dated-conflicts', () => ({ datedConflicts: jest.fn().mockResolvedValue([]) }));
jest.mock('../year-rollover/projected-rosters', () => ({ rostersOfYear: jest.fn().mockResolvedValue({ kind: 'CURRENT' }) }));
jest.mock('../publication/publish-mode', () => ({
  ...jest.requireActual('../publication/publish-mode'),
  enterGrundschemaWrite: jest.fn().mockResolvedValue('DIRECT'),
}));
jest.mock('../cover/cover-decisions', () => ({ ...jest.requireActual('../cover/cover-decisions'), lockLessons: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../cover/cover-context', () => ({ ...jest.requireActual('../cover/cover-context'), schoolTimezone: jest.fn().mockResolvedValue('Europe/Stockholm') }));

const actor = testUser({ schoolId: 'school-1', userId: 'admin-1' });
const time = (value: string): Date => new Date(`1970-01-01T${value}:00.000Z`);
const day = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

const row = (over: Partial<ChangeRow> = {}): ChangeRow => ({
  id: 'change-1',
  schoolId: 'school-1',
  academicYearId: 'year-1',
  studentGroupId: 'class-1',
  authorId: 'teacher-1',
  kind: 'OCCASION_CANCEL',
  status: 'DRAFT',
  masterLessonId: null,
  calendarLessonId: 'lesson-1',
  date: day('2027-03-22'),
  targetDate: null,
  targetDayOfWeek: null,
  targetStart: null,
  targetEnd: null,
  targetRoomId: null,
  keepEnd: null,
  note: null,
  baseVersion: 'v1',
  baseSnapshot: { status: 'SCHEDULED', roomId: 'room-1' },
  rev: 1,
  publishedAt: null,
  publishedByUserId: null,
  createdAt: new Date('2027-03-15T08:00:00.000Z'),
  updatedAt: new Date('2027-03-15T08:00:00.000Z'),
  ...over,
});

type Statement = { strings: string[]; values: unknown[] };
const sql = (statement: unknown): string => (statement as Statement).strings.join('?');
/** The last value bound into a raw statement: for the frame, the flag that says a draft is new. */
const lastValue = (call: unknown[]): unknown => (call[0] as Statement).values.at(-1);

beforeEach(() => {
  (datedConflicts as jest.Mock).mockReset().mockResolvedValue([]);
});

interface World {
  /** What app.class_teacher_frame answers; null is "inside the frame". */
  frame?: string | null;
  version?: string | null;
  snapshot?: Record<string, unknown>;
}

function setup(world: World = {}) {
  const tx: TxMock = createTxMock();
  const prisma = createPrismaMock(tx) as unknown as PrismaService;
  const masters = {
    findConflicts: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockResolvedValue({}),
    create: jest.fn().mockResolvedValue({}),
  };
  const dated = { cancel: jest.fn().mockResolvedValue({}), changeRoom: jest.fn().mockResolvedValue({}) };
  const notifications = { recipientsForLessons: jest.fn().mockResolvedValue(['pupil-1', 'guardian-1']), notifyUsers: jest.fn().mockResolvedValue(2) };
  const realtime = { notifyLessonChanged: jest.fn().mockResolvedValue(undefined), notifyCoverBoardChanged: jest.fn() };
  const state = { frame: world.frame ?? null, version: world.version === undefined ? 'v1' : world.version, snapshot: world.snapshot ?? { status: 'SCHEDULED', roomId: 'room-1' } };
  tx['$queryRaw']!.mockImplementation(async (statement: unknown) => {
    const text = sql(statement);
    if (text.includes('class_teacher_frame')) return [{ reason: state.frame }];
    if (text.includes('_version')) return state.version === null ? [] : [{ version: state.version, snapshot: state.snapshot }];
    return [];
  });
  const engine = new ClassTeacherEngine(
    prisma,
    masters as unknown as MasterLessonsService,
    dated as unknown as CalendarLessonsService,
    notifications as unknown as NotificationsService,
    realtime as unknown as RealtimeService,
  );
  return { tx, prisma, engine, masters, dated, notifications, realtime, state };
}

describe('diffSnapshots', () => {
  it('names what is not what it was, and only that', () => {
    expect(diffSnapshots({ a: 1, b: 'x', c: [1, 2] }, { a: 1, b: 'y', c: [1, 2] })).toEqual([{ field: 'b', was: 'x', now: 'y' }]);
  });

  it('reads a field one side lacks as null, in the order of the names', () => {
    expect(diffSnapshots({ roomId: 'r1' }, { teachers: ['t:LEAD'] })).toEqual([
      { field: 'roomId', was: 'r1', now: null },
      { field: 'teachers', was: null, now: ['t:LEAD'] },
    ]);
  });

  it('compares lists by value and survives a snapshot that is not an object', () => {
    expect(diffSnapshots({ students: ['a', 'b'] }, { students: ['a', 'b'] })).toEqual([]);
    expect(diffSnapshots(null, { a: 1 })).toEqual([{ field: 'a', was: null, now: 1 }]);
    expect(diffSnapshots('x', undefined)).toEqual([]);
  });
});

describe('toChangeView', () => {
  it('writes dates as days and times as clocks, and the instants as ISO', () => {
    const view = toChangeView(
      row({ kind: 'TEMPLATE_SPLIT', calendarLessonId: null, masterLessonId: 'master-1', date: null, targetDayOfWeek: 2, targetStart: time('09:00'), targetEnd: time('09:30'), keepEnd: time('09:00') }),
    );
    expect(view).toMatchObject({
      id: 'change-1',
      kind: 'TEMPLATE_SPLIT',
      date: null,
      targetDayOfWeek: 2,
      targetStart: '09:00',
      targetEnd: '09:30',
      keepEnd: '09:00',
      createdAt: '2027-03-15T08:00:00.000Z',
      publishedAt: null,
    });
    expect(toChangeView(row({ targetDate: day('2027-03-23'), publishedAt: new Date('2027-03-16T10:00:00.000Z'), status: 'PUBLISHED' }))).toMatchObject({
      date: '2027-03-22',
      targetDate: '2027-03-23',
      status: 'PUBLISHED',
      publishedAt: '2027-03-16T10:00:00.000Z',
    });
  });

  it('is what the frame is asked about', () => {
    expect(frameInputOf(row({ targetRoomId: 'room-2' }))).toEqual({
      teacherId: 'teacher-1',
      studentGroupId: 'class-1',
      kind: 'OCCASION_CANCEL',
      masterLessonId: null,
      calendarLessonId: 'lesson-1',
      targetDate: null,
      targetDayOfWeek: null,
      targetStart: null,
      targetEnd: null,
      targetRoomId: 'room-2',
      keepEnd: null,
    });
  });
});

describe('askFrame and lessonState', () => {
  it('asks the database for the frame, with the creating flag, and answers its reason or null', async () => {
    const { tx } = setup({ frame: 'BLOCK' });
    const input = frameInputOf(row());
    expect(await askFrame(tx as never, input, true)).toBe('BLOCK');
    const text = sql(tx['$queryRaw']!.mock.calls[0]![0]);
    expect(text).toContain('app.class_teacher_frame');
    expect(lastValue(tx['$queryRaw']!.mock.calls[0]!)).toBe(true);
    const free = setup({ frame: null });
    expect(await askFrame(free.tx as never, input, false)).toBeNull();
  });

  it('reads a dated lesson through the calendar functions and a template lesson through the master ones', async () => {
    const { tx } = setup({ version: 'abc', snapshot: { status: 'SCHEDULED' } });
    expect(await lessonState(tx as never, 'calendar', 'lesson-1')).toEqual({ version: 'abc', snapshot: { status: 'SCHEDULED' } });
    expect(sql(tx['$queryRaw']!.mock.calls[0]![0])).toContain('class_teacher_calendar_version');
    await lessonState(tx as never, 'master', 'master-1');
    expect(sql(tx['$queryRaw']!.mock.calls[1]![0])).toContain('class_teacher_master_version');
  });

  it('says a lesson that is not there is not there', async () => {
    const { tx } = setup({ version: null });
    expect(await lessonState(tx as never, 'calendar', 'lesson-1')).toBeNull();
    tx['$queryRaw']!.mockResolvedValueOnce([{ version: 'x', snapshot: null }]);
    expect(await lessonState(tx as never, 'master', 'master-1')).toBeNull();
  });
});

describe('ClassTeacherEngine.evaluate', () => {
  beforeEach(() => jest.clearAllMocks());

  it('is GONE when the draft names no lesson any more', async () => {
    const { engine, tx } = setup();
    expect(await engine.evaluate(tx as never, row({ calendarLessonId: null }))).toEqual({ state: 'GONE' });
    expect(await engine.evaluate(tx as never, row({ kind: 'TEMPLATE_MOVE', calendarLessonId: null, masterLessonId: null }))).toEqual({ state: 'GONE' });
  });

  it('is REFUSED with the frame’s reason, asked as a written draft unless it is a new one', async () => {
    const { engine, tx } = setup({ frame: 'TIME_CLOSED' });
    expect(await engine.evaluate(tx as never, row())).toEqual({ state: 'REFUSED', reason: 'TIME_CLOSED' });
    expect(lastValue(tx['$queryRaw']!.mock.calls[0]!)).toBe(false);
    await engine.evaluate(tx as never, row(), { creating: true });
    expect(lastValue(tx['$queryRaw']!.mock.calls[1]!)).toBe(true);
  });

  it('is GONE when the frame says the lesson is gone', async () => {
    const { engine, tx } = setup({ frame: 'LESSON_GONE' });
    expect(await engine.evaluate(tx as never, row())).toEqual({ state: 'GONE' });
  });

  it('is GONE when the lesson cannot be read after the frame passed', async () => {
    const { engine, tx } = setup({ version: null });
    expect(await engine.evaluate(tx as never, row())).toEqual({ state: 'GONE' });
  });

  it('is STALE when the lesson is not what the draft was written against, and says what changed', async () => {
    const { engine, tx } = setup({ version: 'v2', snapshot: { status: 'SCHEDULED', roomId: 'room-9' } });
    expect(await engine.evaluate(tx as never, row())).toEqual({
      state: 'STALE',
      changed: [{ field: 'roomId', was: 'room-1', now: 'room-9' }],
    });
  });

  it('is OK for a cancellation that nothing stands in the way of', async () => {
    const { engine, tx } = setup();
    expect(await engine.evaluate(tx as never, row())).toEqual({ state: 'OK' });
    expect(datedConflicts).not.toHaveBeenCalled();
  });

  it('asks the dated check about a move, on the date and the hours it asks for, and is a CONFLICT with what it names', async () => {
    const { engine, tx } = setup();
    tx['calendarLesson']!['findUnique']!.mockResolvedValue({
      id: 'lesson-1',
      date: day('2027-03-22'),
      startsAt: new Date('2027-03-22T08:30:00.000Z'),
      endsAt: new Date('2027-03-22T09:30:00.000Z'),
      roomId: 'room-1',
      studentGroupId: 'class-1',
      studentGroup: { academicYearId: 'year-1' },
      teachers: [{ teacherId: 'teacher-1' }],
      extraGroups: [],
    });
    (datedConflicts as jest.Mock).mockResolvedValueOnce([{ kind: 'ROOM', other: { className: '4B', subjectName: 'Matte', start: '10:00', end: '11:00' } }]);
    const verdict = await engine.evaluate(
      tx as never,
      row({ kind: 'OCCASION_MOVE', targetDate: day('2027-03-23'), targetStart: time('10:00'), targetEnd: time('11:00'), targetRoomId: 'room-2' }),
    );
    expect(verdict).toEqual({ state: 'CONFLICT', conflicts: [{ kind: 'ROOM', other: { className: '4B', subjectName: 'Matte', start: '10:00', end: '11:00' } }] });
    const placement = (datedConflicts as jest.Mock).mock.calls[0]![1];
    expect(placement).toMatchObject({ lessonId: 'lesson-1', date: '2027-03-23', roomId: 'room-2', teacherIds: ['teacher-1'], academicYearId: 'year-1' });
    // 10:00 and 11:00 on the school's clock, which is an hour after UTC in March.
    expect(placement.startsAt.toISOString()).toBe('2027-03-23T09:00:00.000Z');
    expect(placement.endsAt.toISOString()).toBe('2027-03-23T10:00:00.000Z');
  });

  it('keeps the lesson’s own hours for a room change, and finds nothing when the lesson is gone', async () => {
    const { engine, tx } = setup();
    tx['calendarLesson']!['findUnique']!.mockResolvedValueOnce(null);
    expect(await engine.evaluate(tx as never, row({ kind: 'OCCASION_ROOM', targetRoomId: 'room-2' }))).toEqual({ state: 'OK' });
    tx['calendarLesson']!['findUnique']!.mockResolvedValueOnce({
      id: 'lesson-1',
      date: day('2027-03-22'),
      startsAt: new Date('2027-03-22T08:30:00.000Z'),
      endsAt: new Date('2027-03-22T09:30:00.000Z'),
      roomId: 'room-1',
      studentGroupId: 'class-1',
      studentGroup: { academicYearId: 'year-1' },
      teachers: [],
      extraGroups: [],
    });
    await engine.evaluate(tx as never, row({ kind: 'OCCASION_ROOM', targetRoomId: 'room-2' }));
    const placement = (datedConflicts as jest.Mock).mock.calls.at(-1)![1];
    expect(placement).toMatchObject({ date: '2027-03-22', roomId: 'room-2' });
    expect(placement.startsAt.toISOString()).toBe('2027-03-22T08:30:00.000Z');
  });

  const master = {
    id: 'master-1',
    academicYearId: 'year-1',
    studentGroupId: 'class-1',
    subjectId: 'subject-1',
    teacherId: 'teacher-1',
    coTeacherId: null,
    roomId: 'room-1',
    dayOfWeek: 1,
    startTime: time('08:30'),
    endTime: time('09:30'),
    recurrence: 'ALL_WEEKS',
    startDate: null,
    endDate: null,
    extraGroups: [],
    participants: [],
    subject: { name: 'Matte' },
  };
  const template = (over: Partial<ChangeRow> = {}) =>
    row({ kind: 'TEMPLATE_MOVE', calendarLessonId: null, masterLessonId: 'master-1', date: null, targetDayOfWeek: 2, targetStart: time('10:00'), targetEnd: time('11:00'), ...over });

  it('asks the editor’s own check about a move in the grundschema and names a clash by the other lesson, not by a person', async () => {
    const { engine, tx, masters } = setup();
    tx['masterLesson']!['findUnique']!.mockResolvedValue(master);
    masters.findConflicts.mockResolvedValue([
      { kind: 'TEACHER', message: 'Teacher already teaches Matte in this slot.', masterLessonId: 'master-2' },
      { kind: 'AVAILABILITY', message: 'The room is unavailable in this slot.' },
    ]);
    tx['masterLesson']!['findMany']!.mockResolvedValue([
      { id: 'master-2', dayOfWeek: 2, startTime: time('10:00'), endTime: time('11:00'), subject: { name: 'Svenska' }, studentGroup: { name: '4B' } },
    ]);
    const verdict = await engine.evaluate(tx as never, template());
    expect(verdict).toEqual({
      state: 'CONFLICT',
      conflicts: [{ kind: 'TEACHER', other: { className: '4B', subjectName: 'Svenska', day: 2, start: '10:00', end: '11:00' } }, { kind: 'AVAILABILITY' }],
    });
    const [, , identity, candidate, options] = masters.findConflicts.mock.calls[0]!;
    expect(identity).toEqual({ id: 'master-1', academicYearId: 'year-1', studentGroupId: 'class-1', subjectId: 'subject-1' });
    expect(candidate).toMatchObject({ dayOfWeek: 2, startMinutes: 600, endMinutes: 660, teacherId: 'teacher-1', roomId: 'room-1' });
    expect(options).toEqual({});
  });

  it('is OK when the editor’s check finds nothing, with the room the draft asks for', async () => {
    const { engine, tx, masters } = setup();
    tx['masterLesson']!['findUnique']!.mockResolvedValue(master);
    expect(await engine.evaluate(tx as never, template({ targetRoomId: 'room-2' }))).toEqual({ state: 'OK' });
    expect(masters.findConflicts.mock.calls[0]![3]).toMatchObject({ roomId: 'room-2' });
  });

  it('judges a split’s second part as a new lesson, beside the first part shortened when it lands on the same day', async () => {
    const { engine, tx, masters } = setup();
    tx['masterLesson']!['findUnique']!.mockResolvedValue(master);
    await engine.evaluate(tx as never, template({ kind: 'TEMPLATE_SPLIT', targetDayOfWeek: 1, targetStart: time('09:00'), targetEnd: time('09:30'), keepEnd: time('09:00') }));
    const [, , identity, candidate, options] = masters.findConflicts.mock.calls[0]!;
    expect(identity.id).toBeNull();
    expect(candidate).toMatchObject({ dayOfWeek: 1, startMinutes: 540, endMinutes: 570 });
    expect(options.excludeIds).toEqual(['master-1']);
    expect(options.alongside).toHaveLength(1);
    expect(options.alongside[0]).toMatchObject({ id: 'master-1', endTime: time('09:00') });
    // On another day the first part is nobody’s neighbour.
    await engine.evaluate(tx as never, template({ kind: 'TEMPLATE_SPLIT', targetDayOfWeek: 2, targetStart: time('09:00'), targetEnd: time('09:30'), keepEnd: time('09:00') }));
    expect(masters.findConflicts.mock.calls[1]![4].alongside).toEqual([]);
  });

  it('finds nothing to check when the template lesson is gone or the target is missing', async () => {
    const { engine, tx, masters } = setup();
    tx['masterLesson']!['findUnique']!.mockResolvedValueOnce(null);
    expect(await engine.evaluate(tx as never, template())).toEqual({ state: 'OK' });
    expect(await engine.evaluate(tx as never, template({ targetDayOfWeek: null }))).toEqual({ state: 'OK' });
    expect(masters.findConflicts).not.toHaveBeenCalled();
  });
});

describe('ClassTeacherEngine.publishOne', () => {
  beforeEach(() => jest.clearAllMocks());

  it('answers what the check found and writes nothing', async () => {
    for (const [world, expected] of [
      [{ frame: 'PAST' }, { id: 'change-1', outcome: 'REFUSED', reason: 'PAST' }],
      [{ frame: 'LESSON_GONE' }, { id: 'change-1', outcome: 'GONE' }],
      [{ version: 'v2', snapshot: { status: 'CANCELLED' } }, { id: 'change-1', outcome: 'STALE', changed: [{ field: 'roomId', was: 'room-1', now: null }, { field: 'status', was: 'SCHEDULED', now: 'CANCELLED' }] }],
    ] as const) {
      const { engine, dated, tx } = setup(world);
      expect(await engine.publishOne(actor, row())).toEqual(expected);
      expect(dated.cancel).not.toHaveBeenCalled();
      expect(tx['classTeacherChange']!['updateMany']).not.toHaveBeenCalled();
    }
  });

  it('answers CONFLICT with the clashes the check named', async () => {
    const { engine, tx } = setup();
    tx['calendarLesson']!['findUnique']!.mockResolvedValue({
      id: 'lesson-1', date: day('2027-03-22'), startsAt: new Date('2027-03-22T08:30:00.000Z'), endsAt: new Date('2027-03-22T09:30:00.000Z'),
      roomId: 'room-1', studentGroupId: 'class-1', studentGroup: { academicYearId: 'year-1' }, teachers: [], extraGroups: [],
    });
    (datedConflicts as jest.Mock).mockResolvedValueOnce([{ kind: 'BREAK' }]);
    expect(await engine.publishOne(actor, row({ kind: 'OCCASION_ROOM', targetRoomId: 'room-2' }))).toEqual({
      id: 'change-1',
      outcome: 'CONFLICT',
      conflicts: [{ kind: 'BREAK' }],
    });
  });

  it('cancels through the day operations, as the actor, with the draft’s note as the reason, and marks the draft published at its revision', async () => {
    const { engine, dated, tx } = setup();
    tx['classTeacherChange']!['updateMany']!.mockResolvedValue({ count: 1 });
    expect(await engine.publishOne(actor, row({ note: 'Studiebesök', rev: 3 }))).toEqual({ id: 'change-1', outcome: 'PUBLISHED' });
    expect(dated.cancel).toHaveBeenCalledWith('lesson-1', { reason: 'Studiebesök', cause: 'MANUAL' }, actor);
    expect(tx['classTeacherChange']!['updateMany']).toHaveBeenCalledWith({ where: { id: 'change-1', rev: 3, status: 'DRAFT' }, data: { status: 'PUBLISHED' } });
  });

  it('changes a room through the day operations', async () => {
    const { engine, dated, tx } = setup();
    tx['classTeacherChange']!['updateMany']!.mockResolvedValue({ count: 1 });
    tx['calendarLesson']!['findUnique']!.mockResolvedValue(null);
    await engine.publishOne(actor, row({ kind: 'OCCASION_ROOM', targetRoomId: 'room-2' }));
    expect(dated.changeRoom).toHaveBeenCalledWith('lesson-1', { roomId: 'room-2' }, actor);
  });

  it('moves a template lesson through the editor’s own update, keeping the room unless one is asked for', async () => {
    const { engine, masters, tx } = setup();
    tx['classTeacherChange']!['updateMany']!.mockResolvedValue({ count: 1 });
    tx['masterLesson']!['findUnique']!.mockResolvedValue(null);
    const move = row({ kind: 'TEMPLATE_MOVE', calendarLessonId: null, masterLessonId: 'master-1', date: null, targetDayOfWeek: 3, targetStart: time('10:00'), targetEnd: time('11:00') });
    await engine.publishOne(actor, move);
    expect(masters.update).toHaveBeenCalledWith('master-1', { dayOfWeek: 3, startTime: '10:00', endTime: '11:00' }, actor);
    await engine.publishOne(actor, { ...move, targetRoomId: 'room-2' });
    expect(masters.update).toHaveBeenLastCalledWith('master-1', { dayOfWeek: 3, startTime: '10:00', endTime: '11:00', roomId: 'room-2' }, actor);
  });

  const lesson = {
    id: 'master-1', academicYearId: 'year-1', subjectId: 'subject-1', studentGroupId: 'class-1', teacherId: 'teacher-1', coTeacherId: null, roomId: 'room-1',
    dayOfWeek: 1, startTime: time('08:30'), endTime: time('09:30'), isLocked: true, recurrence: 'ALL_WEEKS', startDate: day('2027-01-11'), endDate: null,
    extraGroups: [], participants: [], subject: { name: 'Matte' },
  };
  const split = row({ kind: 'TEMPLATE_SPLIT', calendarLessonId: null, masterLessonId: 'master-1', date: null, targetDayOfWeek: 2, targetStart: time('09:00'), targetEnd: time('09:30'), keepEnd: time('09:00') });

  it('splits by shortening the lesson first and then making the second part of the same class, subject and teacher', async () => {
    const { engine, masters, tx } = setup();
    tx['classTeacherChange']!['updateMany']!.mockResolvedValue({ count: 1 });
    tx['masterLesson']!['findUnique']!.mockResolvedValue(lesson);
    expect(await engine.publishOne(actor, { ...split, targetRoomId: 'room-2' })).toEqual({ id: 'change-1', outcome: 'PUBLISHED' });
    expect(masters.update).toHaveBeenCalledWith('master-1', { endTime: '09:00' }, actor);
    expect(masters.create).toHaveBeenCalledWith(
      {
        academicYearId: 'year-1', subjectId: 'subject-1', studentGroupId: 'class-1', teacherId: 'teacher-1', coTeacherId: null, roomId: 'room-2',
        dayOfWeek: 2, startTime: '09:00', endTime: '09:30', isLocked: true, recurrence: 'ALL_WEEKS', startDate: '2027-01-11', endDate: undefined,
      },
      actor,
    );
    expect(masters.update.mock.invocationCallOrder[0]).toBeLessThan(masters.create.mock.invocationCallOrder[0]!);
  });

  it('puts the lesson back as it was if the second part cannot be made, and says CONFLICT', async () => {
    const { engine, masters, tx } = setup();
    tx['masterLesson']!['findUnique']!.mockResolvedValue(lesson);
    masters.create.mockRejectedValueOnce(new ConflictException('taken'));
    const outcome = await engine.publishOne(actor, split);
    expect(outcome).toMatchObject({ id: 'change-1', outcome: 'CONFLICT' });
    expect(masters.update).toHaveBeenCalledTimes(2);
    expect(masters.update).toHaveBeenLastCalledWith('master-1', { endTime: '09:30' }, actor);
    expect(tx['classTeacherChange']!['updateMany']).not.toHaveBeenCalled();
  });

  it('reports a failed undo and still rethrows nothing but the original answer', async () => {
    const { engine, masters, tx } = setup();
    tx['masterLesson']!['findUnique']!.mockResolvedValue(lesson);
    masters.create.mockRejectedValueOnce(new ConflictException('taken'));
    masters.update.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('gone'));
    expect((await engine.publishOne(actor, split)).outcome).toBe('CONFLICT');
  });

  it('a split of a lesson that is gone is a conflict, not a half-made change', async () => {
    const { engine, masters, tx } = setup();
    tx['masterLesson']!['findUnique']!.mockResolvedValue(null);
    expect((await engine.publishOne(actor, split)).outcome).toBe('CONFLICT');
    expect(masters.update).not.toHaveBeenCalled();
  });

  it('answers FAILED for an editor refusal that is not a clash, and rethrows what it does not know', async () => {
    const { engine, dated, tx } = setup();
    dated.cancel.mockRejectedValueOnce(new BadRequestException('Only scheduled lessons can be cancelled.'));
    expect(await engine.publishOne(actor, row())).toEqual({ id: 'change-1', outcome: 'FAILED' });
    dated.cancel.mockRejectedValueOnce(new Error('boom'));
    await expect(engine.publishOne(actor, row())).rejects.toThrow('boom');
    expect(tx['classTeacherChange']!['updateMany']).not.toHaveBeenCalled();
  });

  it('still says PUBLISHED when the draft could not be marked, since the lesson has changed', async () => {
    const { engine, tx } = setup();
    tx['classTeacherChange']!['updateMany']!.mockResolvedValue({ count: 0 });
    expect(await engine.publishOne(actor, row())).toEqual({ id: 'change-1', outcome: 'PUBLISHED' });
  });

  describe('a date’s lesson moved', () => {
    const moved = row({ kind: 'OCCASION_MOVE', targetDate: day('2027-03-23'), targetStart: time('10:00'), targetEnd: time('11:00'), note: 'Flyttad' });
    const lessonRow = {
      id: 'lesson-1',
      status: 'SCHEDULED',
      date: day('2027-03-22'),
      startsAt: new Date('2027-03-22T08:30:00.000Z'),
      subjectId: 'subject-1',
      studentGroupId: 'class-1',
      studentGroup: { academicYearId: 'year-1' },
      subject: { name: 'Matte' },
      teachers: [{ teacherId: 'teacher-1' }],
      extraGroups: [],
      participants: [],
    };

    it('locks the lesson, judges it once more, writes its new hours and tells the class, the guardians and the teacher', async () => {
      const { engine, tx, notifications, realtime } = setup();
      tx['classTeacherChange']!['updateMany']!.mockResolvedValue({ count: 1 });
      tx['calendarLesson']!['findUnique']!.mockImplementation(async (args: { select: Record<string, unknown> }) =>
        args.select['status'] ? lessonRow : args.select['roomId'] && !args.select['startsAt'] ? { roomId: 'room-1' } : { ...lessonRow, roomId: 'room-1', endsAt: new Date('2027-03-22T09:30:00.000Z') },
      );
      expect(await engine.publishOne(actor, moved)).toEqual({ id: 'change-1', outcome: 'PUBLISHED' });
      const write = tx['calendarLesson']!['update']!.mock.calls[0]![0];
      expect(write.where).toEqual({ id: 'lesson-1' });
      expect(write.data.date).toEqual(day('2027-03-23'));
      expect(write.data.startsAt.toISOString()).toBe('2027-03-23T09:00:00.000Z');
      expect(write.data.endsAt.toISOString()).toBe('2027-03-23T10:00:00.000Z');
      expect(write.data.roomId).toBe('room-1');
      expect(write.data.note).toBe('Flyttad');
      expect(realtime.notifyLessonChanged).toHaveBeenCalledWith(tx, 'lesson-1');
      expect(notifications.notifyUsers).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ schoolId: 'school-1', userIds: ['pupil-1', 'guardian-1', 'teacher-1'], type: 'SCHEDULE_CHANGED' }),
      );
      expect(realtime.notifyCoverBoardChanged).toHaveBeenCalledWith('school-1', '2027-03-22', '2027-03-23');
    });

    it('is refused by the second look when the lesson is no longer scheduled, has changed or the hour is taken', async () => {
      for (const [lessonOver, version, clashes] of [
        [{ status: 'CANCELLED' }, 'v1', []],
        [{}, 'v2', []],
        [{}, 'v1', [{ kind: 'TEACHER' }]],
      ] as const) {
        const { engine, tx } = setup({ version });
        tx['calendarLesson']!['findUnique']!.mockImplementation(async (args: { select: Record<string, unknown> }) =>
          args.select['status'] ? { ...lessonRow, ...lessonOver } : { ...lessonRow, roomId: null, endsAt: new Date('2027-03-22T09:30:00.000Z') },
        );
        tx['classTeacherChange']!['updateMany']!.mockResolvedValue({ count: 1 });
        (datedConflicts as jest.Mock).mockReset().mockResolvedValueOnce([]).mockResolvedValue(clashes);
        const outcome = await engine.publishOne(actor, moved);
        expect(['CONFLICT', 'STALE', 'REFUSED']).toContain(outcome.outcome);
        expect(tx['calendarLesson']!['update']).not.toHaveBeenCalled();
      }
    });

    it('says the board changed over both days, earlier first, also when a lesson moves back', async () => {
      const { engine, tx, realtime } = setup();
      tx['classTeacherChange']!['updateMany']!.mockResolvedValue({ count: 1 });
      tx['calendarLesson']!['findUnique']!.mockImplementation(async (args: { select: Record<string, unknown> }) =>
        args.select['status'] ? { ...lessonRow, date: day('2027-03-25') } : args.select['roomId'] && !args.select['startsAt'] ? { roomId: null } : { ...lessonRow, roomId: null, endsAt: new Date('2027-03-22T09:30:00.000Z') },
      );
      await engine.publishOne(actor, moved);
      expect(realtime.notifyCoverBoardChanged).toHaveBeenCalledWith('school-1', '2027-03-23', '2027-03-25');
    });
  });
});

describe('ClassTeacherEngine.publishClass', () => {
  beforeEach(() => jest.clearAllMocks());

  it('publishes what is waiting, oldest first, and answers an outcome for each', async () => {
    const { engine, tx } = setup();
    const first = row({ id: 'a', createdAt: new Date('2027-03-15T08:00:00.000Z') });
    const second = row({ id: 'b', calendarLessonId: 'lesson-2', createdAt: new Date('2027-03-15T09:00:00.000Z') });
    tx['classTeacherChange']!['findMany']!.mockResolvedValue([first, second]);
    tx['classTeacherChange']!['findUnique']!.mockImplementation(async (args: { where: { id: string } }) => (args.where.id === 'a' ? first : second));
    tx['classTeacherChange']!['updateMany']!.mockResolvedValue({ count: 1 });
    const outcomes = await engine.publishClass(actor, 'class-1');
    expect(outcomes).toEqual([
      { id: 'a', outcome: 'PUBLISHED' },
      { id: 'b', outcome: 'PUBLISHED' },
    ]);
    expect(tx['classTeacherChange']!['findMany']).toHaveBeenCalledWith({
      where: { studentGroupId: 'class-1', status: 'DRAFT' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  });

  it('asks only for the drafts named', async () => {
    const { engine, tx } = setup();
    tx['classTeacherChange']!['findMany']!.mockResolvedValue([]);
    expect(await engine.publishClass(actor, 'class-1', ['x'])).toEqual([]);
    expect(tx['classTeacherChange']!['findMany']!.mock.calls[0]![0].where).toEqual({ studentGroupId: 'class-1', status: 'DRAFT', id: { in: ['x'] } });
  });

  it('asks again after a pass that published something, so two lessons that swap hours both go', async () => {
    const { engine, tx } = setup();
    const a = row({ id: 'a' });
    const b = row({ id: 'b', calendarLessonId: 'lesson-2' });
    tx['classTeacherChange']!['findMany']!.mockResolvedValue([a, b]);
    tx['classTeacherChange']!['findUnique']!.mockImplementation(async (args: { where: { id: string } }) => (args.where.id === 'a' ? a : b));
    tx['classTeacherChange']!['updateMany']!.mockResolvedValue({ count: 1 });
    // a meets a clash until b has gone: the first pass publishes b alone, the second a.
    let bDone = false;
    const publishOne = jest.spyOn(engine, 'publishOne').mockImplementation(async (_actor, change) => {
      if (change.id === 'b') {
        bDone = true;
        return { id: 'b', outcome: 'PUBLISHED' };
      }
      return bDone ? { id: 'a', outcome: 'PUBLISHED' } : { id: 'a', outcome: 'CONFLICT', conflicts: [{ kind: 'ROOM' }] };
    });
    expect(await engine.publishClass(actor, 'class-1')).toEqual([
      { id: 'a', outcome: 'PUBLISHED' },
      { id: 'b', outcome: 'PUBLISHED' },
    ]);
    expect(publishOne).toHaveBeenCalledTimes(3);
  });

  it('stops when a pass publishes nothing, and does not retry a draft that is refused', async () => {
    const { engine, tx } = setup();
    const a = row({ id: 'a' });
    const b = row({ id: 'b', calendarLessonId: 'lesson-2' });
    tx['classTeacherChange']!['findMany']!.mockResolvedValue([a, b]);
    tx['classTeacherChange']!['findUnique']!.mockImplementation(async (args: { where: { id: string } }) => (args.where.id === 'a' ? a : b));
    const publishOne = jest.spyOn(engine, 'publishOne').mockImplementation(async (_actor, change) =>
      change.id === 'a' ? { id: 'a', outcome: 'CONFLICT', conflicts: [] } : { id: 'b', outcome: 'REFUSED', reason: 'PAST' },
    );
    expect(await engine.publishClass(actor, 'class-1')).toEqual([
      { id: 'a', outcome: 'CONFLICT', conflicts: [] },
      { id: 'b', outcome: 'REFUSED', reason: 'PAST' },
    ]);
    expect(publishOne).toHaveBeenCalledTimes(2);
  });

  it('reads each draft again before publishing it, and calls one that has gone meanwhile GONE', async () => {
    const { engine, tx } = setup();
    tx['classTeacherChange']!['findMany']!.mockResolvedValue([row({ id: 'a' }), row({ id: 'b' })]);
    tx['classTeacherChange']!['findUnique']!.mockResolvedValueOnce(null).mockResolvedValueOnce(row({ id: 'b', status: 'PUBLISHED' }));
    expect(await engine.publishClass(actor, 'class-1')).toEqual([
      { id: 'a', outcome: 'GONE' },
      { id: 'b', outcome: 'GONE' },
    ]);
  });
});
