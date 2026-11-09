import { BadRequestException, ConflictException } from '@nestjs/common';
import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import type { MasterLessonsService } from '../calendar/master-lessons.service';
import type { CalendarLessonsService } from '../calendar/calendar-lessons.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { readBoardFacts } from '../swaps/board-rules';
import { publishModeOf } from '../publication/publish-mode';
import { substituteNotedLessons } from '../lesson-log/substitute-noted';
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

jest.mock('./dated-conflicts', () => ({ ...jest.requireActual('./dated-conflicts'), datedConflicts: jest.fn().mockResolvedValue([]) }));
jest.mock('../year-rollover/projected-rosters', () => ({ rostersOfYear: jest.fn().mockResolvedValue({ kind: 'CURRENT' }) }));
jest.mock('../publication/publish-mode', () => ({
  ...jest.requireActual('../publication/publish-mode'),
  enterGrundschemaWrite: jest.fn().mockResolvedValue('DIRECT'),
  publishModeOf: jest.fn().mockResolvedValue('DIRECT'),
}));
jest.mock('../swaps/board-rules', () => ({ ...jest.requireActual('../swaps/board-rules'), readBoardFacts: jest.fn() }));
jest.mock('../lesson-log/substitute-noted', () => ({ substituteNotedLessons: jest.fn().mockResolvedValue(new Set()) }));
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

/** A school with no ramtid, no meal and no rule on årskurser: the board holds nothing. */
const noBoard = { frames: [], sittings: new Map(), gradeRules: [], spans: new Map() };

beforeEach(() => {
  (datedConflicts as jest.Mock).mockReset().mockResolvedValue([]);
  (readBoardFacts as jest.Mock).mockReset().mockResolvedValue(noBoard);
  (publishModeOf as jest.Mock).mockReset().mockResolvedValue('DIRECT');
  (substituteNotedLessons as jest.Mock).mockReset().mockResolvedValue(new Set());
});

/** The claim a publication makes: the database counts the revision up, and the draft is read again at the new one. */
function claims(tx: TxMock, change: ChangeRow) {
  tx['classTeacherChange']!['updateMany']!.mockResolvedValue({ count: 1 });
  tx['classTeacherChange']!['findUnique']!.mockResolvedValue({ ...change, rev: change.rev + 1 });
}

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

  it('does not judge a cancellation against the day, however crowded it is: a lesson that is taken away clashes with nothing', async () => {
    const { engine, tx } = setup();
    tx['calendarLesson']!['findUnique']!.mockResolvedValue({
      id: 'lesson-1', date: day('2027-03-22'), startsAt: new Date('2027-03-22T08:30:00.000Z'), endsAt: new Date('2027-03-22T09:30:00.000Z'), roomId: 'room-1', subjectId: 'subject-1',
      studentGroupId: 'class-1', studentGroup: { academicYearId: 'year-1' }, teachers: [], extraGroups: [], participants: [],
    });
    (datedConflicts as jest.Mock).mockResolvedValue([{ kind: 'ROOM' }]);
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
      subjectId: 'subject-1',
      studentGroupId: 'class-1',
      studentGroup: { academicYearId: 'year-1' },
      teachers: [{ teacherId: 'teacher-1' }],
      extraGroups: [],
      participants: [],
    });
    (datedConflicts as jest.Mock).mockResolvedValueOnce([{ kind: 'ROOM', other: { className: '4B', subjectName: 'Matte', start: '10:00', end: '11:00' } }]);
    const verdict = await engine.evaluate(
      tx as never,
      row({ kind: 'OCCASION_MOVE', targetDate: day('2027-03-23'), targetStart: time('10:00'), targetEnd: time('11:00'), targetRoomId: 'room-2' }),
    );
    expect(verdict).toEqual({ state: 'CONFLICT', conflicts: [{ kind: 'ROOM', other: { className: '4B', subjectName: 'Matte', start: '10:00', end: '11:00' } }] });
    const placement = (datedConflicts as jest.Mock).mock.calls[0]![2];
    expect(placement).toMatchObject({ lessonId: 'lesson-1', date: '2027-03-23', roomId: 'room-2', teacherIds: ['teacher-1'], academicYearId: 'year-1', schoolId: 'school-1', subjectId: 'subject-1', participantIds: [] });
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
      subjectId: 'subject-1',
      studentGroupId: 'class-1',
      studentGroup: { academicYearId: 'year-1' },
      teachers: [],
      extraGroups: [],
      participants: [],
    });
    await engine.evaluate(tx as never, row({ kind: 'OCCASION_ROOM', targetRoomId: 'room-2' }));
    const placement = (datedConflicts as jest.Mock).mock.calls.at(-1)![2];
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
      roomId: 'room-1', subjectId: 'subject-1', studentGroupId: 'class-1', studentGroup: { academicYearId: 'year-1' }, teachers: [], extraGroups: [], participants: [],
    });
    (datedConflicts as jest.Mock).mockResolvedValueOnce([{ kind: 'BREAK' }]);
    expect(await engine.publishOne(actor, row({ kind: 'OCCASION_ROOM', targetRoomId: 'room-2' }))).toEqual({
      id: 'change-1',
      outcome: 'CONFLICT',
      conflicts: [{ kind: 'BREAK' }],
    });
  });

  it('cancels through the day operations, as the actor, with the draft’s note as the reason, and marks the draft published at the revision it claimed', async () => {
    const { engine, dated, tx } = setup();
    const draft = row({ note: 'Studiebesök', rev: 3 });
    claims(tx, draft);
    expect(await engine.publishOne(actor, draft)).toEqual({ id: 'change-1', outcome: 'PUBLISHED' });
    expect(dated.cancel).toHaveBeenCalledWith('lesson-1', { reason: 'Studiebesök', cause: 'MANUAL' }, actor);
    // The claim counts the revision up from the one the publisher read; the mark is made at the claimed one.
    expect(tx['classTeacherChange']!['updateMany']).toHaveBeenNthCalledWith(1, { where: { id: 'change-1', rev: 3, status: 'DRAFT' }, data: { updatedAt: expect.any(Date) } });
    expect(tx['classTeacherChange']!['updateMany']).toHaveBeenNthCalledWith(2, { where: { id: 'change-1', rev: 4, status: 'DRAFT' }, data: { status: 'PUBLISHED' } });
    expect(tx['classTeacherChange']!['updateMany']!.mock.invocationCallOrder[0]).toBeLessThan(dated.cancel.mock.invocationCallOrder[0]!);
  });

  it('carries out nothing for a draft someone else has claimed first, and says it is gone', async () => {
    for (const lost of [{ count: 0 }]) {
      const { engine, dated, masters, tx } = setup();
      tx['classTeacherChange']!['updateMany']!.mockResolvedValue(lost);
      expect(await engine.publishOne(actor, row())).toEqual({ id: 'change-1', outcome: 'GONE' });
      expect(await engine.publishOne(actor, row({ kind: 'TEMPLATE_SPLIT', calendarLessonId: null, masterLessonId: 'master-1', date: null, targetDayOfWeek: 2, targetStart: time('09:00'), targetEnd: time('09:30'), keepEnd: time('09:00') }))).toEqual({ id: 'change-1', outcome: 'GONE' });
      expect(dated.cancel).not.toHaveBeenCalled();
      expect(masters.update).not.toHaveBeenCalled();
      expect(masters.create).not.toHaveBeenCalled();
      expect(tx['classTeacherChange']!['updateMany']).toHaveBeenCalledTimes(2);
    }
  });

  it('says it is gone too when the claim was made and the draft cannot be read again', async () => {
    const { engine, dated, tx } = setup();
    tx['classTeacherChange']!['updateMany']!.mockResolvedValue({ count: 1 });
    tx['classTeacherChange']!['findUnique']!.mockResolvedValue(null);
    expect(await engine.publishOne(actor, row())).toEqual({ id: 'change-1', outcome: 'GONE' });
    expect(dated.cancel).not.toHaveBeenCalled();
  });

  it('claims once before a single write however many publish: two at once carry a split out once', async () => {
    const { engine, masters, tx } = setup();
    const draft = row({ kind: 'TEMPLATE_SPLIT', calendarLessonId: null, masterLessonId: 'master-1', date: null, targetDayOfWeek: 2, targetStart: time('09:00'), targetEnd: time('09:30'), keepEnd: time('09:00') });
    tx['masterLesson']!['findUnique']!.mockResolvedValue({ id: 'master-1', academicYearId: 'year-1', subjectId: 'subject-1', studentGroupId: 'class-1', teacherId: 'teacher-1', coTeacherId: null, roomId: 'room-1', dayOfWeek: 1, startTime: time('08:30'), endTime: time('09:30'), isLocked: false, recurrence: 'ALL_WEEKS', startDate: null, endDate: null, extraGroups: [], participants: [], subject: { name: 'Matte' }, schoolId: 'school-1' });
    // The database lets one of two claimants count the revision up; the other finds it moved.
    let taken = false;
    tx['classTeacherChange']!['updateMany']!.mockImplementation(async (args: { data: { status?: string } }) => {
      if (args.data.status) return { count: 1 };
      if (taken) return { count: 0 };
      taken = true;
      return { count: 1 };
    });
    tx['classTeacherChange']!['findUnique']!.mockResolvedValue({ ...draft, rev: draft.rev + 1 });
    const outcomes = await Promise.all([engine.publishOne(actor, draft), engine.publishOne(actor, draft)]);
    expect(outcomes.map((one) => one.outcome).sort()).toEqual(['GONE', 'PUBLISHED']);
    expect(masters.create).toHaveBeenCalledTimes(1);
    expect(masters.update).toHaveBeenCalledTimes(1);
  });

  it('changes a room through the day operations', async () => {
    const { engine, dated, tx } = setup();
    const draft = row({ kind: 'OCCASION_ROOM', targetRoomId: 'room-2' });
    claims(tx, draft);
    tx['calendarLesson']!['findUnique']!.mockResolvedValue(null);
    await engine.publishOne(actor, draft);
    expect(dated.changeRoom).toHaveBeenCalledWith('lesson-1', { roomId: 'room-2' }, actor);
  });

  it('moves a template lesson through the editor’s own update, keeping the room unless one is asked for', async () => {
    const { engine, masters, tx } = setup();
    const move = row({ kind: 'TEMPLATE_MOVE', calendarLessonId: null, masterLessonId: 'master-1', date: null, targetDayOfWeek: 3, targetStart: time('10:00'), targetEnd: time('11:00') });
    claims(tx, move);
    tx['masterLesson']!['findUnique']!.mockResolvedValue(null);
    await engine.publishOne(actor, move);
    expect(masters.update).toHaveBeenCalledWith('master-1', { dayOfWeek: 3, startTime: '10:00', endTime: '11:00' }, actor);
    claims(tx, { ...move, targetRoomId: 'room-2' });
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
    claims(tx, { ...split, targetRoomId: 'room-2' });
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
    claims(tx, split);
    tx['masterLesson']!['findUnique']!.mockResolvedValue(lesson);
    masters.create.mockRejectedValueOnce(new ConflictException('taken'));
    const outcome = await engine.publishOne(actor, split);
    expect(outcome).toMatchObject({ id: 'change-1', outcome: 'CONFLICT' });
    expect(masters.update).toHaveBeenCalledTimes(2);
    expect(masters.update).toHaveBeenLastCalledWith('master-1', { endTime: '09:30' }, actor);
    // The claim only: the draft is not marked, and stays a draft for the next publication.
    expect(tx['classTeacherChange']!['updateMany']).toHaveBeenCalledTimes(1);
  });

  it('reports a failed undo and still rethrows nothing but the original answer', async () => {
    const { engine, masters, tx } = setup();
    claims(tx, split);
    tx['masterLesson']!['findUnique']!.mockResolvedValue(lesson);
    masters.create.mockRejectedValueOnce(new ConflictException('taken'));
    masters.update.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('gone'));
    expect((await engine.publishOne(actor, split)).outcome).toBe('CONFLICT');
  });

  it('names the clash the editor found after the claim by its kind alone to a klasslärare in a school that publishes through a draft, and in full to an administrator', async () => {
    (publishModeOf as jest.Mock).mockResolvedValue('DRAFT');
    const neighbour = { id: 'master-2', dayOfWeek: 2, startTime: time('10:00'), endTime: time('11:00'), subject: { name: 'Svenska' }, studentGroup: { name: '4B' } };
    for (const [options, expected] of [
      [{ forTeacher: true }, [{ kind: 'ROOM' }]],
      [{}, [{ kind: 'ROOM', other: { className: '4B', subjectName: 'Svenska', day: 2, start: '10:00', end: '11:00' } }]],
    ] as const) {
      const { engine, masters, tx } = setup();
      const move = row({ kind: 'TEMPLATE_MOVE', calendarLessonId: null, masterLessonId: 'master-1', date: null, targetDayOfWeek: 2, targetStart: time('10:00'), targetEnd: time('11:00') });
      claims(tx, move);
      tx['masterLesson']!['findUnique']!.mockResolvedValue(lesson);
      tx['masterLesson']!['findMany']!.mockResolvedValue([neighbour]);
      // The first look finds nothing in the way; a write later the editor's own does, and the second look names it.
      masters.findConflicts.mockResolvedValueOnce([]).mockResolvedValue([{ kind: 'ROOM', message: 'x', masterLessonId: 'master-2' }]);
      masters.update.mockRejectedValueOnce(new ConflictException('taken'));
      expect({ options, outcome: await engine.publishOne(actor, move, options) }).toEqual({ options, outcome: { id: 'change-1', outcome: 'CONFLICT', conflicts: expected } });
      expect(masters.findConflicts).toHaveBeenCalledTimes(2);
    }
  });

  it('a split of a lesson that is gone is a conflict, not a half-made change', async () => {
    const { engine, masters, tx } = setup();
    claims(tx, split);
    tx['masterLesson']!['findUnique']!.mockResolvedValue(null);
    expect((await engine.publishOne(actor, split)).outcome).toBe('CONFLICT');
    expect(masters.update).not.toHaveBeenCalled();
  });

  it('answers FAILED for an editor refusal that is not a clash, and rethrows what it does not know', async () => {
    const { engine, dated, tx } = setup();
    claims(tx, row());
    dated.cancel.mockRejectedValueOnce(new BadRequestException('Only scheduled lessons can be cancelled.'));
    expect(await engine.publishOne(actor, row())).toEqual({ id: 'change-1', outcome: 'FAILED' });
    dated.cancel.mockRejectedValueOnce(new Error('boom'));
    await expect(engine.publishOne(actor, row())).rejects.toThrow('boom');
    // Claimed twice, marked never.
    expect(tx['classTeacherChange']!['updateMany']!.mock.calls.every(([args]: [{ data: { status?: string } }]) => args.data.status === undefined)).toBe(true);
  });

  it('still says PUBLISHED when the draft could not be marked, since the lesson has changed', async () => {
    const { engine, tx } = setup();
    claims(tx, row());
    // The claim is taken; the mark at the claimed revision finds the draft changed.
    tx['classTeacherChange']!['updateMany']!.mockImplementation(async (args: { data: { status?: string } }) => ({ count: args.data.status ? 0 : 1 }));
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
      note: null as string | null,
      roomId: 'room-1' as string | null,
      teachers: [{ teacherId: 'teacher-1' }],
      extraGroups: [],
      participants: [],
      movesFrom: [] as Array<{ studentId: string }>,
    };

    it('locks the lesson, judges it once more, writes its new hours and tells the class, the guardians and the teacher', async () => {
      const { engine, tx, notifications, realtime } = setup();
      claims(tx, moved);
      tx['calendarLesson']!['findUnique']!.mockImplementation(async (args: { select: Record<string, unknown> }) =>
        args.select['status'] ? lessonRow : { ...lessonRow, roomId: 'room-1', endsAt: new Date('2027-03-22T09:30:00.000Z') },
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

    it('does not tell a pupil moved off the lesson for the day that it has moved, as the day operations do not', async () => {
      const { engine, tx, notifications } = setup();
      claims(tx, moved);
      tx['calendarLesson']!['findUnique']!.mockImplementation(async (args: { select: Record<string, unknown> }) =>
        args.select['status'] ? { ...lessonRow, movesFrom: [{ studentId: 'pupil-9' }] } : { ...lessonRow, roomId: 'room-1', endsAt: new Date('2027-03-22T09:30:00.000Z') },
      );
      await engine.publishOne(actor, moved);
      expect(tx['calendarLesson']!['findUnique']!.mock.calls.some(([args]: [{ select: Record<string, unknown> }]) => args.select['movesFrom'] !== undefined)).toBe(true);
      expect(notifications.recipientsForLessons).toHaveBeenCalledWith(tx, [expect.objectContaining({ movedOffIds: ['pupil-9'] })]);
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
        claims(tx, moved);
        (datedConflicts as jest.Mock).mockReset().mockResolvedValueOnce([]).mockResolvedValue(clashes);
        const outcome = await engine.publishOne(actor, moved);
        expect(['CONFLICT', 'STALE', 'REFUSED']).toContain(outcome.outcome);
        expect(tx['calendarLesson']!['update']).not.toHaveBeenCalled();
      }
    });

    it('says the board changed over both days, earlier first, also when a lesson moves back', async () => {
      const { engine, tx, realtime } = setup();
      claims(tx, moved);
      tx['calendarLesson']!['findUnique']!.mockImplementation(async (args: { select: Record<string, unknown> }) =>
        args.select['status'] ? { ...lessonRow, date: day('2027-03-25'), roomId: null } : { ...lessonRow, roomId: null, endsAt: new Date('2027-03-22T09:30:00.000Z') },
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

  it('asks again after a pass that published something, so a lesson moved into the hour another leaves goes after it', async () => {
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

// ---------------------------------------------------------------------------
// The board's rules, what a change of the template does to the calendar, and
// what a klasslärare may read of a school that publishes through a draft.
// ---------------------------------------------------------------------------

describe('ClassTeacherEngine.evaluate: the rest of what the editor holds a placement to', () => {
  const grundschema = {
    id: 'master-1',
    schoolId: 'school-1',
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
  const move = (over: Partial<ChangeRow> = {}) =>
    row({ kind: 'TEMPLATE_MOVE', calendarLessonId: null, masterLessonId: 'master-1', date: null, targetDayOfWeek: 2, targetStart: time('10:00'), targetEnd: time('11:00'), ...over });
  /** A dated lesson of the template, as reconcilableLessons selects it. */
  const dated = (date: string, from: string, to: string, extra: Record<string, unknown> = {}) => ({
    id: `cl-${date}`,
    date: day(date),
    startsAt: new Date(`${date}T${from}:00.000Z`),
    endsAt: new Date(`${date}T${to}:00.000Z`),
    roomId: 'room-1',
    studentGroup: { name: '4A' },
    _count: { lessonLogs: 0 },
    ...extra,
  });

  it('holds a lesson of the template to the board: the ramtid, the class’s meal and a closure on årskurser, by kind and with no lesson named', async () => {
    const facts = (over: Record<string, unknown>) => ({ ...noBoard, spans: new Map([['class-1', [4, 4]]]), ...over });
    const tue = (start: number, end: number) => ({ dayOfWeek: 2, startMinutes: start, endMinutes: end });
    for (const [expected, board] of [
      ['FRAME', facts({ frames: [{ min: 1, max: 6, day: null, start: 480, end: 900 }] })],
      ['LUNCH', facts({ sittings: new Map([['class-1|2', [{ studentGroupId: 'class-1', ...tue(630, 660) }]]]) })],
      ['GRADE_RULE', facts({ gradeRules: [{ resourceType: 'GRADE_LEVEL', minGradeLevel: 1, maxGradeLevel: 6, dayOfWeek: 2, startMinutes: 600, endMinutes: 720 }] })],
    ] as const) {
      const { engine, tx } = setup();
      tx['masterLesson']!['findUnique']!.mockResolvedValue(grundschema);
      (readBoardFacts as jest.Mock).mockResolvedValue(board);
      // 10:00-11:00 on a Tuesday: inside the frame 08:00-15:00 is fine, so the frame case moves the lesson to 15:30.
      const change = expected === 'FRAME' ? move({ targetStart: time('15:30'), targetEnd: time('16:30') }) : move();
      expect(await engine.evaluate(tx as never, change)).toEqual({ state: 'CONFLICT', conflicts: [{ kind: expected }] });
    }
  });

  it('reads the board with the year’s own numbering of its årskurser', async () => {
    const { engine, tx } = setup();
    tx['masterLesson']!['findUnique']!.mockResolvedValue(grundschema);
    tx['academicYear']!['findUnique']!.mockResolvedValue({ gradeNumbering: 'TIOARIG' });
    await engine.evaluate(tx as never, move());
    expect(readBoardFacts).toHaveBeenCalledWith(tx, expect.objectContaining({ gradeNumbering: 'TIOARIG' }));
    expect(tx['academicYear']!['findUnique']).toHaveBeenCalledWith({ where: { id: 'year-1' }, select: { gradeNumbering: true } });
  });

  it('reads the board for the groups of the lesson on the day it moves to, and a school that holds nothing finds nothing', async () => {
    const { engine, tx } = setup();
    tx['masterLesson']!['findUnique']!.mockResolvedValue(grundschema);
    expect(await engine.evaluate(tx as never, move())).toEqual({ state: 'OK' });
    expect(readBoardFacts).toHaveBeenCalledWith(tx, expect.objectContaining({ academicYearId: 'year-1', schoolId: 'school-1', groupIds: ['class-1'], weekday: 2, gradeNumbering: 'NIOARIG' }));
  });

  it('is a CONFLICT with a lesson moved for its date, since a change of the template would carry it to a third day, and names the date', async () => {
    const { engine, tx } = setup();
    tx['masterLesson']!['findUnique']!.mockResolvedValue(grundschema);
    // Monday 2027-03-22 08:30 is the template's own (CET: 07:30Z), and so is Monday 2027-04-05 (CEST: 06:30Z);
    // Tuesday 2027-03-23 13:00 is the Monday lesson moved for that date (12:00Z).
    tx['calendarLesson']!['findMany']!.mockResolvedValue([dated('2027-03-22', '07:30', '08:30'), dated('2027-03-23', '12:00', '13:00'), dated('2027-04-05', '06:30', '07:30')]);
    for (const change of [move(), move({ kind: 'TEMPLATE_SPLIT', targetDayOfWeek: 1, targetStart: time('09:00'), targetEnd: time('09:30'), keepEnd: time('09:00') })]) {
      expect(await engine.evaluate(tx as never, change)).toEqual({
        state: 'CONFLICT',
        conflicts: [{ kind: 'EXCEPTION', other: { className: '4A', subjectName: 'Matte', date: '2027-03-23', start: '13:00', end: '14:00' } }],
      });
    }
  });

  it('asks for the lessons the change would rewrite and no others: the template’s own, still to be held, with no register', async () => {
    const { engine, tx } = setup();
    tx['masterLesson']!['findUnique']!.mockResolvedValue(grundschema);
    await engine.evaluate(tx as never, move());
    expect(tx['calendarLesson']!['findMany']!.mock.calls[0]![0].where).toEqual({
      masterLessonId: 'master-1',
      status: 'SCHEDULED',
      startsAt: { gt: expect.any(Date) },
      attendanceRecords: { none: {} },
    });
  });

  it('meets a lesson that differs from the template in one respect alone: its day, its start or its end', async () => {
    // Template: Monday 08:30-09:30. Monday 2027-04-05 is CEST, so 08:30 is 06:30Z.
    for (const [what, row, shown] of [
      ['the day', dated('2027-04-06', '06:30', '07:30'), { date: '2027-04-06', start: '08:30', end: '09:30' }],
      ['the start', dated('2027-04-05', '07:00', '07:30'), { date: '2027-04-05', start: '09:00', end: '09:30' }],
      ['the end', dated('2027-04-05', '06:30', '08:00'), { date: '2027-04-05', start: '08:30', end: '10:00' }],
    ] as const) {
      const { engine, tx } = setup();
      tx['masterLesson']!['findUnique']!.mockResolvedValue(grundschema);
      tx['calendarLesson']!['findMany']!.mockResolvedValue([row]);
      const verdict = await engine.evaluate(tx as never, move());
      expect({ what, verdict }).toEqual({
        what,
        verdict: { state: 'CONFLICT', conflicts: [{ kind: 'EXCEPTION', other: { className: '4A', subjectName: 'Matte', ...shown } }] },
      });
    }
  });

  it('meets a lesson whose room was changed for its date, since a change of the template writes the template’s room on every future lesson', async () => {
    // Monday 2027-04-05 08:30-09:30 (CEST: 06:30Z) is the template's own day and hour, in room-2 for that date; the template is in room-1.
    for (const [what, template, row] of [
      ['another room for the date', grundschema, dated('2027-04-05', '06:30', '07:30', { roomId: 'room-2' })],
      ['a room for a date the template has none for', { ...grundschema, roomId: null }, dated('2027-04-05', '06:30', '07:30', { roomId: 'room-2' })],
      ['no room for a date the template has one for', grundschema, dated('2027-04-05', '06:30', '07:30', { roomId: null })],
    ] as const) {
      const { engine, tx } = setup();
      tx['masterLesson']!['findUnique']!.mockResolvedValue(template);
      tx['calendarLesson']!['findMany']!.mockResolvedValue([dated('2027-03-22', '07:30', '08:30', { roomId: template.roomId }), row]);
      const verdict = await engine.evaluate(tx as never, move({ targetDayOfWeek: 1, targetStart: time('09:00'), targetEnd: time('10:00') }));
      expect({ what, verdict }).toEqual({
        what,
        verdict: { state: 'CONFLICT', conflicts: [{ kind: 'EXCEPTION', other: { className: '4A', subjectName: 'Matte', date: '2027-04-05', start: '08:30', end: '09:30' } }] },
      });
    }
  });

  it('does not count the template’s own room as an exception, with or without one', async () => {
    for (const roomId of ['room-1', null] as const) {
      const { engine, tx } = setup();
      tx['masterLesson']!['findUnique']!.mockResolvedValue({ ...grundschema, roomId });
      tx['calendarLesson']!['findMany']!.mockResolvedValue([dated('2027-03-22', '07:30', '08:30', { roomId }), dated('2027-04-05', '06:30', '07:30', { roomId })]);
      const verdict = await engine.evaluate(tx as never, move({ targetDayOfWeek: 1, targetStart: time('09:00'), targetEnd: time('10:00') }));
      expect({ roomId, state: verdict.state }).toEqual({ roomId, state: 'OK' });
    }
  });

  it('reads the room of the dated lessons it compares with the template’s', async () => {
    const { engine, tx } = setup();
    tx['masterLesson']!['findUnique']!.mockResolvedValue(grundschema);
    await engine.evaluate(tx as never, move());
    expect(tx['calendarLesson']!['findMany']!.mock.calls[0]![0].select).toEqual(expect.objectContaining({ roomId: true }));
  });

  it('counts a lesson moved to another hour of its own day as moved, and the template’s own lessons as not', async () => {
    const { engine, tx } = setup();
    tx['masterLesson']!['findUnique']!.mockResolvedValue(grundschema);
    // Monday 2027-04-05 at 09:30 (CEST: 07:30Z) is an hour late: its day is the template's, its hour is not.
    tx['calendarLesson']!['findMany']!.mockResolvedValue([dated('2027-03-22', '07:30', '08:30'), dated('2027-04-05', '07:30', '08:30')]);
    const verdict = await engine.evaluate(tx as never, move());
    expect(verdict.state).toBe('CONFLICT');
    expect((verdict as { conflicts: unknown[] }).conflicts).toEqual([
      { kind: 'EXCEPTION', other: expect.objectContaining({ date: '2027-04-05', start: '09:30', end: '10:30' }) },
    ]);
  });

  it('names at most five lessons moved for their dates', async () => {
    const { engine, tx } = setup();
    tx['masterLesson']!['findUnique']!.mockResolvedValue(grundschema);
    tx['calendarLesson']!['findMany']!.mockResolvedValue(Array.from({ length: 9 }, (_, n) => dated(`2027-04-${String(5 + n).padStart(2, '0')}`, '12:00', '13:00')));
    const verdict = await engine.evaluate(tx as never, move());
    expect((verdict as { conflicts: unknown[] }).conflicts).toHaveLength(5);
  });

  it('leaves the calendar alone in a school that publishes through a draft: the template is a draft there, and a publication carries it over by its own rules', async () => {
    (publishModeOf as jest.Mock).mockResolvedValue('DRAFT');
    const { engine, tx } = setup();
    tx['masterLesson']!['findUnique']!.mockResolvedValue(grundschema);
    tx['calendarLesson']!['findMany']!.mockResolvedValue([dated('2027-03-23', '12:00', '13:00')]);
    expect(await engine.evaluate(tx as never, move())).toEqual({ state: 'OK' });
    expect(tx['calendarLesson']!['findMany']).not.toHaveBeenCalled();
  });

  describe('what a move of the template takes out of the calendar', () => {
    // Today is Wednesday 2027-03-24 10:00 on the school's clock; the template's Monday lesson moves to Tuesday (a day LATER, so only the end of its period can take a lesson).
    beforeEach(() => jest.useFakeTimers({ now: new Date('2027-03-24T09:00:00.000Z') }));
    afterEach(() => jest.useRealTimers());

    it('is OK with the count of what it removes when no lesson has been moved for its date', async () => {
      const { engine, tx } = setup();
      // A template that ends on Monday 2027-04-05. Its Mondays are 08:30 CEST (06:30Z); a day later is Tuesday the 30th (inside), the 6th and the 13th (after the end).
      tx['masterLesson']!['findUnique']!.mockResolvedValue({ ...grundschema, endDate: day('2027-04-05') });
      tx['calendarLesson']!['findMany']!.mockResolvedValue([
        dated('2027-03-29', '06:30', '07:30', { id: 'cl-a' }),
        dated('2027-04-05', '06:30', '07:30', { id: 'cl-b', _count: { lessonLogs: 2 } }),
        dated('2027-04-12', '06:30', '07:30', { id: 'cl-c' }),
      ]);
      (substituteNotedLessons as jest.Mock).mockResolvedValue(new Set(['cl-c']));
      expect(await engine.evaluate(tx as never, move())).toEqual({ state: 'OK', removes: { lessons: 2, withLog: 2 } });
      expect(substituteNotedLessons).toHaveBeenCalledWith(tx, ['cl-b', 'cl-c']);
    });

    it('says nothing when it removes nothing, and nothing of a split, which leaves the first part where it is', async () => {
      const { engine, tx } = setup();
      tx['masterLesson']!['findUnique']!.mockResolvedValue(grundschema);
      tx['calendarLesson']!['findMany']!.mockResolvedValue([dated('2027-03-29', '06:30', '07:30'), dated('2027-04-05', '06:30', '07:30')]);
      expect(await engine.evaluate(tx as never, move())).toEqual({ state: 'OK' });
      const split = move({ kind: 'TEMPLATE_SPLIT', targetDayOfWeek: 1, targetStart: time('09:00'), targetEnd: time('09:30'), keepEnd: time('09:00') });
      tx['calendarLesson']!['findMany']!.mockClear();
      expect(await engine.evaluate(tx as never, split)).toEqual({ state: 'OK' });
      // Once for the lessons moved for their dates, never for the removal of a split.
      expect(tx['calendarLesson']!['findMany']).toHaveBeenCalledTimes(1);
    });

    it('counts a lesson that the change would carry back to a time that has begun', async () => {
      const { engine, tx } = setup();
      // Moving the Monday lesson to Monday 06:00 (before the day's first hour) on the template of today's week: a row of this
      // Thursday 2027-03-25 07:30Z moved back to Wednesday 24th is over already.
      tx['masterLesson']!['findUnique']!.mockResolvedValue({ ...grundschema, dayOfWeek: 4, startTime: time('08:30'), endTime: time('09:30') });
      tx['calendarLesson']!['findMany']!.mockResolvedValue([dated('2027-03-25', '07:30', '08:30', { id: 'cl-now' })]);
      const back = move({ targetDayOfWeek: 3, targetStart: time('08:00'), targetEnd: time('09:00') });
      expect(await engine.evaluate(tx as never, back)).toEqual({ state: 'OK', removes: { lessons: 1, withLog: 0 } });
    });
  });

  describe('what a klasslärare reads of a school that publishes through a draft', () => {
    it('is told by a publication for a teacher, too: the outcome names the clash by its kind alone, and publishClass hands the flag to each draft', async () => {
      (publishModeOf as jest.Mock).mockResolvedValue('DRAFT');
      const { engine, tx, masters } = setup();
      tx['masterLesson']!['findUnique']!.mockResolvedValue(grundschema);
      tx['masterLesson']!['findMany']!.mockResolvedValue([{ id: 'master-2', dayOfWeek: 2, startTime: time('10:00'), endTime: time('11:00'), subject: { name: 'Svenska' }, studentGroup: { name: '4B' } }]);
      masters.findConflicts.mockResolvedValue([{ kind: 'ROOM', message: 'x', masterLessonId: 'master-2' }]);
      expect(await engine.publishOne(actor, move(), { forTeacher: true })).toEqual({ id: 'change-1', outcome: 'CONFLICT', conflicts: [{ kind: 'ROOM' }] });
      expect(((await engine.publishOne(actor, move())) as { conflicts: Array<{ other?: unknown }> }).conflicts[0]!.other).toBeDefined();
      tx['classTeacherChange']!['findMany']!.mockResolvedValue([move()]);
      tx['classTeacherChange']!['findUnique']!.mockResolvedValue(move());
      const publishOne = jest.spyOn(engine, 'publishOne');
      await engine.publishClass(actor, 'class-1', undefined, { forTeacher: true });
      expect(publishOne).toHaveBeenCalledWith(actor, expect.objectContaining({ id: 'change-1' }), { forTeacher: true });
    });

    const clash = [{ kind: 'TEACHER', message: 'x', masterLessonId: 'master-2' }, { kind: 'AVAILABILITY', message: 'y' }];
    const other = { id: 'master-2', dayOfWeek: 2, startTime: time('10:00'), endTime: time('11:00'), subject: { name: 'Svenska' }, studentGroup: { name: '4B' } };

    it('names a clash with the draft grundschema by its kind alone to a teacher, and in full to an administrator', async () => {
      (publishModeOf as jest.Mock).mockResolvedValue('DRAFT');
      const { engine, tx, masters } = setup();
      tx['masterLesson']!['findUnique']!.mockResolvedValue(grundschema);
      tx['masterLesson']!['findMany']!.mockResolvedValue([other]);
      masters.findConflicts.mockResolvedValue(clash);
      expect(await engine.evaluate(tx as never, move(), { forTeacher: true })).toEqual({ state: 'CONFLICT', conflicts: [{ kind: 'TEACHER' }, { kind: 'AVAILABILITY' }] });
      const full = await engine.evaluate(tx as never, move());
      expect(full).toEqual({
        state: 'CONFLICT',
        conflicts: [{ kind: 'TEACHER', other: { className: '4B', subjectName: 'Svenska', day: 2, start: '10:00', end: '11:00' } }, { kind: 'AVAILABILITY' }],
      });
    });

    it('does not hide it where the grundschema is not a draft, nor a clash with the published calendar', async () => {
      const { engine, tx, masters } = setup();
      tx['masterLesson']!['findUnique']!.mockResolvedValue(grundschema);
      tx['masterLesson']!['findMany']!.mockResolvedValue([other]);
      masters.findConflicts.mockResolvedValue(clash);
      const direct = await engine.evaluate(tx as never, move(), { forTeacher: true });
      expect((direct as { conflicts: Array<{ other?: unknown }> }).conflicts[0]!.other).toBeDefined();
      // A draft school's calendar is the published one, which a teacher reads: a dated clash keeps the lesson it is with.
      (publishModeOf as jest.Mock).mockResolvedValue('DRAFT');
      tx['calendarLesson']!['findUnique']!.mockResolvedValue({
        id: 'lesson-1', date: day('2027-03-22'), startsAt: new Date('2027-03-22T08:30:00.000Z'), endsAt: new Date('2027-03-22T09:30:00.000Z'), roomId: 'room-1', subjectId: 'subject-1',
        studentGroupId: 'class-1', studentGroup: { academicYearId: 'year-1' }, teachers: [], extraGroups: [], participants: [],
      });
      const shown = { kind: 'ROOM', other: { className: '4B', subjectName: 'Matte', date: '2027-03-22', start: '09:00', end: '10:00' } };
      (datedConflicts as jest.Mock).mockResolvedValue([shown]);
      expect(await engine.evaluate(tx as never, row({ kind: 'OCCASION_ROOM', targetRoomId: 'room-2' }), { forTeacher: true })).toEqual({ state: 'CONFLICT', conflicts: [shown] });
    });
  });
});

describe('ClassTeacherEngine: a date’s lesson moved, the protection against a second writer', () => {
  const moved = row({ kind: 'OCCASION_MOVE', targetDate: day('2027-03-23'), targetStart: time('10:00'), targetEnd: time('11:00'), note: 'Flyttad pga besök' });
  const lessonRow = {
    id: 'lesson-1', status: 'SCHEDULED', date: day('2027-03-22'), startsAt: new Date('2027-03-22T08:30:00.000Z'), subjectId: 'subject-1', studentGroupId: 'class-1',
    studentGroup: { academicYearId: 'year-1' }, subject: { name: 'Matte' }, note: null as string | null, roomId: 'room-1' as string | null,
    teachers: [{ teacherId: 'teacher-1' }], extraGroups: [], participants: [{ studentId: 'pupil-1' }],
  };
  const world = (lesson: Record<string, unknown> = lessonRow) => {
    const made = setup();
    claims(made.tx, moved);
    made.tx['calendarLesson']!['findUnique']!.mockImplementation(async (args: { select: Record<string, unknown> }) =>
      args.select['status'] ? lesson : { ...lesson, endsAt: new Date('2027-03-22T09:30:00.000Z') },
    );
    return made;
  };
  const publication = jest.requireMock('../publication/publish-mode').enterGrundschemaWrite as jest.Mock;
  const lock = jest.requireMock('../cover/cover-decisions').lockLessons as jest.Mock;
  const versionReads = (tx: TxMock) =>
    tx['$queryRaw']!.mock.calls.map((call, n) => ({ n, order: tx['$queryRaw']!.mock.invocationCallOrder[n]!, text: sql(call[0]) })).filter((read) => read.text.includes('class_teacher_calendar_version'));

  beforeEach(() => {
    publication.mockClear();
    lock.mockClear();
  });

  it('takes the school’s publication lock first, then the lesson’s row lock, and only then reads the lesson to judge it', async () => {
    const { engine, tx } = world();
    expect(await engine.publishOne(actor, moved)).toEqual({ id: 'change-1', outcome: 'PUBLISHED' });
    expect(publication).toHaveBeenCalledWith(tx, 'school-1');
    expect(lock).toHaveBeenCalledWith(tx, ['lesson-1']);
    const reads = versionReads(tx);
    // The first look is the check's, outside the writing transaction; the second is the writer's, after both locks.
    expect(reads).toHaveLength(2);
    expect(publication.mock.invocationCallOrder[0]).toBeLessThan(lock.mock.invocationCallOrder[0]!);
    expect(lock.mock.invocationCallOrder[0]).toBeLessThan(reads[1]!.order);
    expect(reads[0]!.order).toBeLessThan(publication.mock.invocationCallOrder[0]!);
    expect(tx['calendarLesson']!['update']!.mock.invocationCallOrder[0]).toBeGreaterThan(reads[1]!.order);
  });

  it('is refused when a schemaläggare changed the lesson after the check looked and before the lock was got', async () => {
    const { engine, tx } = world();
    let reads = 0;
    tx['$queryRaw']!.mockImplementation(async (statement: unknown) => {
      const text = sql(statement);
      if (text.includes('class_teacher_frame')) return [{ reason: null }];
      if (text.includes('_version')) return [{ version: ++reads === 1 ? 'v1' : 'v2', snapshot: { status: 'SCHEDULED', roomId: 'room-1' } }];
      return [];
    });
    const outcome = await engine.publishOne(actor, moved);
    expect(outcome.outcome).toBe('CONFLICT');
    // The check's look, the writer's look, and the look that names the clash for the answer.
    expect(reads).toBe(3);
    expect(tx['calendarLesson']!['update']).not.toHaveBeenCalled();
  });

  it('adds the klasslärare’s words to the lesson’s own note and keeps the note when there are none', async () => {
    const { engine, tx } = world({ ...lessonRow, note: 'Ta med gympakläder' });
    await engine.publishOne(actor, moved);
    expect(tx['calendarLesson']!['update']!.mock.calls[0]![0].data.note).toBe('Ta med gympakläder · Flyttad pga besök');
    const quiet = row({ kind: 'OCCASION_MOVE', targetDate: day('2027-03-23'), targetStart: time('10:00'), targetEnd: time('11:00'), note: null });
    const again = world({ ...lessonRow, note: 'Ta med gympakläder' });
    claims(again.tx, quiet);
    await again.engine.publishOne(actor, quiet);
    expect('note' in again.tx['calendarLesson']!['update']!.mock.calls[0]![0].data).toBe(false);
    const plain = world();
    await plain.engine.publishOne(actor, moved);
    expect(plain.tx['calendarLesson']!['update']!.mock.calls[0]![0].data.note).toBe('Flyttad pga besök');
  });

  it('judges the hour with the date’s lessons and the year’s pupils, in the writing transaction', async () => {
    const { engine, tx } = world();
    await engine.publishOne(actor, moved);
    const [, context, placement] = (datedConflicts as jest.Mock).mock.calls.at(-1)!;
    expect(context.basis).toEqual({ kind: 'CURRENT' });
    expect(placement).toMatchObject({ lessonId: 'lesson-1', date: '2027-03-23', subjectId: 'subject-1', schoolId: 'school-1', participantIds: ['pupil-1'], roomId: 'room-1' });
    expect((datedConflicts as jest.Mock).mock.calls.at(-1)![0]).toBe(tx);
  });
});
