import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { ClassTeacherService, assertShape, mondayOf } from './class-teacher.service';
import type { ClassTeacherEngine, ChangeRow } from './class-teacher-engine';
import { CODES } from './class-teacher.types';

const teacher = testUser({ role: 'TEACHER' as never, userId: 'teacher-1', schoolId: 'school-1', authId: 'auth-teacher-1' });
const time = (value: string): Date => new Date(`1970-01-01T${value}:00.000Z`);
const day = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

type Statement = { strings: string[]; values: unknown[] };
const sql = (statement: unknown): string => (statement as Statement).strings.join('?');

const sqlError = (state: string, code = 'P2010'): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError('refused', { code, clientVersion: 'test', meta: { driverAdapterError: { cause: { originalCode: state } } } });

const changeRow = (over: Partial<ChangeRow> = {}): ChangeRow => ({
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
  baseVersion: 'a'.repeat(32),
  baseSnapshot: {},
  rev: 1,
  publishedAt: null,
  publishedByUserId: null,
  createdAt: new Date('2027-03-15T08:00:00.000Z'),
  updatedAt: new Date('2027-03-15T08:00:00.000Z'),
  ...over,
});

interface World {
  appointed?: boolean;
  frame?: string | null;
  state?: { version: string; snapshot: Record<string, unknown> } | null;
  selfPublish?: boolean | null;
}

function setup(world: World = {}) {
  const tx: TxMock = createTxMock();
  const prisma = createPrismaMock(tx) as unknown as PrismaService;
  const engine = { evaluate: jest.fn(), publishClass: jest.fn() };
  const service = new ClassTeacherService(prisma, engine as unknown as ClassTeacherEngine);
  tx['classTeacherAppointment']!['findFirst']!.mockResolvedValue(world.appointed === false ? null : { id: 'appointment-1' });
  tx['classTeacherSettings']!['findUnique']!.mockResolvedValue(world.selfPublish === null ? null : { selfPublish: world.selfPublish ?? false });
  tx['studentGroup']!['findUnique']!.mockResolvedValue({ id: 'class-1', name: '4A', academicYearId: 'year-1' });
  tx['school']!['findUnique']!.mockResolvedValue({ timezone: 'Europe/Stockholm' });
  const state = world.state === undefined ? { version: 'a'.repeat(32), snapshot: { status: 'SCHEDULED' } } : world.state;
  tx['$queryRaw']!.mockImplementation(async (statement: unknown) => {
    const text = sql(statement);
    if (text.includes('class_teacher_frame')) return [{ reason: world.frame ?? null }];
    if (text.includes('_version')) return state ? [state] : [];
    if (text.includes('class_teacher_actor')) {
      return [{ userId: 'admin-9', authId: 'auth-admin-9', adminProfile: 'SCHEMALAGGARE', hrRead: false }];
    }
    return [];
  });
  return { tx, prisma, engine, service };
}

describe('mondayOf', () => {
  it('is the Monday of the week a date is in', () => {
    expect(mondayOf('2027-03-22')).toBe('2027-03-22');
    expect(mondayOf('2027-03-24')).toBe('2027-03-22');
    expect(mondayOf('2027-03-28')).toBe('2027-03-22');
    expect(mondayOf('2027-03-29')).toBe('2027-03-29');
  });
});

describe('assertShape', () => {
  const move = { calendarLessonId: 'l', targetDate: '2027-03-23', targetStart: '10:00', targetEnd: '11:00' };
  const ok = (kind: Parameters<typeof assertShape>[0], dto: Parameters<typeof assertShape>[1]) => expect(() => assertShape(kind, dto, false)).not.toThrow();
  const bad = (kind: Parameters<typeof assertShape>[0], dto: Parameters<typeof assertShape>[1]) =>
    expect(() => assertShape(kind, dto, false)).toThrow(BadRequestException);

  it('lets each kind carry what it uses', () => {
    ok('OCCASION_MOVE', move);
    ok('OCCASION_MOVE', { ...move, targetRoomId: 'r' });
    ok('OCCASION_CANCEL', { calendarLessonId: 'l', note: 'Studiebesök' });
    ok('OCCASION_ROOM', { calendarLessonId: 'l', targetRoomId: 'r' });
    ok('TEMPLATE_MOVE', { masterLessonId: 'm', targetDayOfWeek: 2, targetStart: '10:00', targetEnd: '11:00' });
    ok('TEMPLATE_SPLIT', { masterLessonId: 'm', targetDayOfWeek: 2, targetStart: '09:00', targetEnd: '09:30', keepEnd: '09:00' });
  });

  it('names the lesson of its layer and no other', () => {
    bad('OCCASION_CANCEL', {});
    bad('OCCASION_CANCEL', { calendarLessonId: 'l', masterLessonId: 'm' });
    bad('TEMPLATE_MOVE', { calendarLessonId: 'l', targetDayOfWeek: 2, targetStart: '10:00', targetEnd: '11:00' });
    bad('TEMPLATE_MOVE', { masterLessonId: 'm', calendarLessonId: 'l', targetDayOfWeek: 2, targetStart: '10:00', targetEnd: '11:00' });
  });

  it('asks for what a kind needs and refuses what it does not use', () => {
    bad('OCCASION_MOVE', { calendarLessonId: 'l', targetStart: '10:00', targetEnd: '11:00' });
    bad('OCCASION_MOVE', { ...move, targetDayOfWeek: 2 });
    bad('OCCASION_MOVE', { ...move, keepEnd: '10:30' });
    bad('OCCASION_CANCEL', { calendarLessonId: 'l', targetRoomId: 'r' });
    bad('OCCASION_CANCEL', { calendarLessonId: 'l', targetDate: '2027-03-23' });
    bad('OCCASION_ROOM', { calendarLessonId: 'l' });
    bad('OCCASION_ROOM', { calendarLessonId: 'l', targetRoomId: 'r', targetStart: '10:00' });
    bad('TEMPLATE_MOVE', { masterLessonId: 'm', targetStart: '10:00', targetEnd: '11:00' });
    bad('TEMPLATE_MOVE', { masterLessonId: 'm', targetDayOfWeek: 2, targetStart: '10:00', targetEnd: '11:00', targetDate: '2027-03-23' });
    bad('TEMPLATE_MOVE', { masterLessonId: 'm', targetDayOfWeek: 2, targetStart: '10:00', targetEnd: '11:00', keepEnd: '10:30' });
    bad('TEMPLATE_SPLIT', { masterLessonId: 'm', targetDayOfWeek: 2, targetStart: '09:00', targetEnd: '09:30' });
    bad('TEMPLATE_SPLIT', { masterLessonId: 'm', targetDayOfWeek: 2, targetStart: '09:00', targetEnd: '09:30', keepEnd: '09:00', targetDate: '2027-03-23' });
  });

  it('asks for the version a new draft is written against', () => {
    expect(() => assertShape('OCCASION_CANCEL', { calendarLessonId: 'l' }, true)).toThrow(BadRequestException);
    expect(() => assertShape('OCCASION_CANCEL', { calendarLessonId: 'l', baseVersion: 'a'.repeat(32) } as never, true)).not.toThrow();
  });
});

describe('ClassTeacherService.mine', () => {
  it('lists the classes the caller is klasslärare of, and whether the school lets them publish', async () => {
    const { service, tx } = setup({ selfPublish: true });
    tx['classTeacherAppointment']!['findMany']!.mockResolvedValue([{ studentGroupId: 'class-1' }]);
    tx['studentGroup']!['findMany']!.mockResolvedValue([{ id: 'class-1', name: '4A', academicYearId: 'year-1' }]);
    expect(await service.mine(teacher)).toEqual({ classes: [{ id: 'class-1', name: '4A', academicYearId: 'year-1' }], selfPublish: true });
    expect(tx['classTeacherAppointment']!['findMany']).toHaveBeenCalledWith({ where: { userId: 'teacher-1' }, select: { studentGroupId: true } });
  });

  it('says no to publishing for a school that has not decided', async () => {
    const { service } = setup({ selfPublish: null });
    expect((await service.mine(teacher)).selfPublish).toBe(false);
  });
});

describe('ClassTeacherService.actorOf', () => {
  it('builds the administrator’s principal from what the database says, with the session’s school, closures and channel', async () => {
    const { service } = setup();
    const actor = await service.actorOf({ ...teacher, closedSchools: { x: 'y' }, channel: 'WEB' } as never, 'class-1');
    expect(actor).toEqual({
      authId: 'auth-admin-9',
      role: 'SCHOOL_ADMIN',
      userId: 'admin-9',
      schoolId: 'school-1',
      adminProfile: 'SCHEMALAGGARE',
      hrRead: false,
      closedSchools: { x: 'y' },
      channel: 'WEB',
    });
  });

  it('is 403 for a teacher who is not klasslärare of the class and 409 when the administrator is gone', async () => {
    const { service, tx } = setup();
    tx['$queryRaw']!.mockRejectedValueOnce(sqlError('CT403'));
    await expect(service.actorOf(teacher, 'class-1')).rejects.toMatchObject({ response: { code: CODES.NOT_APPOINTED } });
    tx['$queryRaw']!.mockRejectedValueOnce(sqlError('CT422'));
    await expect(service.actorOf(teacher, 'class-1')).rejects.toMatchObject({ response: { code: CODES.APPOINTER_GONE } });
    tx['$queryRaw']!.mockResolvedValueOnce([]);
    await expect(service.actorOf(teacher, 'class-1')).rejects.toBeInstanceOf(ConflictException);
    const boom = new Error('boom');
    tx['$queryRaw']!.mockRejectedValueOnce(boom);
    await expect(service.actorOf(teacher, 'class-1')).rejects.toBe(boom);
  });
});

describe('ClassTeacherService.week', () => {
  const lessonRow = (over: Record<string, unknown> = {}) => ({
    id: 'lesson-1',
    date: day('2027-03-22'),
    startsAt: new Date('2027-03-22T07:30:00.000Z'),
    endsAt: new Date('2027-03-22T08:30:00.000Z'),
    status: 'SCHEDULED',
    roomId: 'room-1',
    subjectId: 'subject-1',
    subject: { name: 'Matte' },
    studentGroup: { name: '4A' },
    teachers: [{ teacherId: 'teacher-1' }],
    ...over,
  });

  function withWeek(world: World = {}) {
    const ctx = setup(world);
    const { tx } = ctx;
    tx['classTeacherOpenTime']!['findMany']!.mockResolvedValue([{ dayOfWeek: 1, startTime: time('08:00'), endTime: time('12:00') }]);
    tx['classTeacherChange']!['findMany']!.mockResolvedValue([
      changeRow({ id: 'c-occasion', calendarLessonId: 'lesson-1' }),
      changeRow({ id: 'c-template', kind: 'TEMPLATE_MOVE', calendarLessonId: null, masterLessonId: 'master-1', date: null, targetDayOfWeek: 2, targetStart: time('10:00'), targetEnd: time('11:00') }),
    ]);
    tx['calendarLesson']!['findMany']!.mockResolvedValue([lessonRow(), lessonRow({ id: 'lesson-2', teachers: [{ teacherId: 'someone-else' }], roomId: null })]);
    tx['subject']!['findMany']!.mockResolvedValue([{ id: 'subject-1', name: 'Matte' }]);
    tx['studentGroup']!['findMany']!.mockResolvedValue([{ id: 'class-1', name: '4A' }]);
    tx['$queryRaw']!.mockImplementation(async (statement: unknown) => {
      const text = sql(statement);
      if (text.includes('"Rooms"')) return [{ id: 'room-1', name: 'Sal 1', refusal: null }, { id: 'room-3', name: 'Aulan', refusal: 'ROOM_NEEDS_APPROVAL' }];
      if (text.includes('class_teacher_master_lessons')) {
        return [
          { id: 'master-1', studentGroupId: 'class-1', subjectId: 'subject-1', dayOfWeek: 1, startTime: time('08:30'), endTime: time('09:30'), roomId: 'room-1', teacherId: 'teacher-1', recurrence: 'ALL_WEEKS', version: 'm1', refusal: null },
          { id: 'master-2', studentGroupId: 'class-1', subjectId: 'subject-1', dayOfWeek: 2, startTime: time('09:00'), endTime: time('10:00'), roomId: null, teacherId: 'other', recurrence: 'ODD_WEEKS', version: 'm2', refusal: 'OTHER_TEACHER' },
        ];
      }
      if (text.includes('class_teacher_calendar_states')) {
        return [{ calendarLessonId: 'lesson-1', version: 'v1', refusal: null }, { calendarLessonId: 'lesson-2', version: 'v2', refusal: 'OTHER_TEACHER' }];
      }
      return [];
    });
    return ctx;
  }

  it('is a week of the class: the dated lessons and the grundschema with the frame’s verdict, the open hours, the drafts and the rooms', async () => {
    const { service, tx } = withWeek({ selfPublish: true });
    const view = await service.week('class-1', { from: '2027-03-24' }, teacher);
    expect(view).toMatchObject({
      classId: 'class-1',
      className: '4A',
      academicYearId: 'year-1',
      weekStart: '2027-03-22',
      days: ['2027-03-22', '2027-03-23', '2027-03-24', '2027-03-25', '2027-03-26'],
      openTimes: [{ dayOfWeek: 1, start: '08:00', end: '12:00' }],
      selfPublish: true,
      rooms: [{ id: 'room-1', name: 'Sal 1', refusal: null }, { id: 'room-3', name: 'Aulan', refusal: 'ROOM_NEEDS_APPROVAL' }],
    });
    // 07:30 UTC is 08:30 in Stockholm before the clocks change on 28 March.
    expect(view.occasions[0]).toEqual({
      id: 'lesson-1',
      date: '2027-03-22',
      start: '08:30',
      end: '09:30',
      status: 'SCHEDULED',
      subjectId: 'subject-1',
      subjectName: 'Matte',
      className: '4A',
      roomId: 'room-1',
      mine: true,
      version: 'v1',
      refusal: null,
      draftId: 'c-occasion',
    });
    expect(view.occasions[1]).toMatchObject({ id: 'lesson-2', mine: false, refusal: 'OTHER_TEACHER', draftId: null });
    expect(view.template).toEqual([
      expect.objectContaining({ id: 'master-1', dayOfWeek: 1, start: '08:30', end: '09:30', subjectName: 'Matte', className: '4A', mine: true, refusal: null, draftId: 'c-template' }),
      expect.objectContaining({ id: 'master-2', recurrence: 'ODD_WEEKS', mine: false, refusal: 'OTHER_TEACHER', draftId: null }),
    ]);
    expect(view.drafts.map((draft) => draft.id)).toEqual(['c-occasion', 'c-template']);
    // Nobody but the klasslärare is named.
    expect(JSON.stringify(view)).not.toContain('someone-else');
    expect(tx['classTeacherChange']!['findMany']).toHaveBeenCalledWith(expect.objectContaining({ where: { studentGroupId: 'class-1', status: 'DRAFT' } }));
  });

  it('asks for this week on the school’s clock when no date is given', async () => {
    const { service } = withWeek();
    const view = await service.week('class-1', {}, teacher);
    expect(view.days).toHaveLength(5);
    expect(new Date(`${view.weekStart}T00:00:00.000Z`).getUTCDay()).toBe(1);
  });

  it('is 403 for a class the caller is not klasslärare of, before anything is read', async () => {
    const { service, tx } = withWeek({ appointed: false });
    await expect(service.week('class-1', {}, teacher)).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx['calendarLesson']!['findMany']).not.toHaveBeenCalled();
  });

  it('is 404 for a class that is not there', async () => {
    const { service, tx } = withWeek();
    tx['studentGroup']!['findUnique']!.mockResolvedValue(null);
    await expect(service.week('class-1', {}, teacher)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ClassTeacherService.create', () => {
  const dto = { kind: 'OCCASION_CANCEL' as const, calendarLessonId: 'lesson-1', baseVersion: 'a'.repeat(32), note: 'Studiebesök' };

  it('asks the frame as a new draft, reads the lesson’s version and writes the draft in the teacher’s name', async () => {
    const { service, tx } = setup();
    tx['classTeacherChange']!['create']!.mockResolvedValue(changeRow({ note: 'Studiebesök' }));
    const view = await service.create('class-1', dto, teacher);
    expect(view).toMatchObject({ id: 'change-1', kind: 'OCCASION_CANCEL', note: 'Studiebesök', rev: 1 });
    expect(tx['$queryRaw']!.mock.calls[0]!.slice(-1)[0]).toBe(true);
    expect(tx['classTeacherChange']!['create']).toHaveBeenCalledWith({
      data: expect.objectContaining({
        schoolId: 'school-1',
        academicYearId: 'year-1',
        studentGroupId: 'class-1',
        authorId: 'teacher-1',
        kind: 'OCCASION_CANCEL',
        calendarLessonId: 'lesson-1',
        masterLessonId: null,
        targetDate: null,
        note: 'Studiebesök',
        baseVersion: 'a'.repeat(32),
        baseSnapshot: {},
      }),
    });
  });

  it('parses a move’s day and hours and a split’s end', async () => {
    const { service, tx } = setup();
    tx['classTeacherChange']!['create']!.mockResolvedValue(changeRow());
    await service.create('class-1', { kind: 'OCCASION_MOVE', calendarLessonId: 'lesson-1', baseVersion: 'a'.repeat(32), targetDate: '2027-03-23', targetStart: '10:00', targetEnd: '11:00', targetRoomId: 'room-2' }, teacher);
    expect(tx['classTeacherChange']!['create']!.mock.calls[0]![0].data).toMatchObject({
      targetDate: day('2027-03-23'),
      targetStart: time('10:00'),
      targetEnd: time('11:00'),
      targetRoomId: 'room-2',
    });
    await service.create('class-1', { kind: 'TEMPLATE_SPLIT', masterLessonId: 'master-1', baseVersion: 'a'.repeat(32), targetDayOfWeek: 2, targetStart: '09:00', targetEnd: '09:30', keepEnd: '09:00' }, teacher);
    expect(tx['classTeacherChange']!['create']!.mock.calls[1]![0].data).toMatchObject({ masterLessonId: 'master-1', calendarLessonId: null, targetDayOfWeek: 2, keepEnd: time('09:00') });
  });

  it('names what stops it: 403 with the frame’s reason, 404 for a lesson that is gone, 403 for a class that is not theirs', async () => {
    const outside = setup({ frame: 'REPLACING_GROUP' });
    await expect(outside.service.create('class-1', dto, teacher)).rejects.toMatchObject({
      status: 403,
      response: { code: CODES.OUTSIDE_FRAME, reason: 'REPLACING_GROUP' },
    });
    expect(outside.tx['classTeacherChange']!['create']).not.toHaveBeenCalled();
    const gone = setup({ frame: 'LESSON_GONE' });
    await expect(gone.service.create('class-1', dto, teacher)).rejects.toBeInstanceOf(NotFoundException);
    const stranger = setup({ appointed: false });
    await expect(stranger.service.create('class-1', dto, teacher)).rejects.toMatchObject({ response: { code: CODES.NOT_APPOINTED } });
  });

  it('is 404 when the class or the lesson cannot be read', async () => {
    const noClass = setup();
    noClass.tx['studentGroup']!['findUnique']!.mockResolvedValue(null);
    await expect(noClass.service.create('class-1', dto, teacher)).rejects.toBeInstanceOf(NotFoundException);
    const noLesson = setup({ state: null });
    await expect(noLesson.service.create('class-1', dto, teacher)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('is 409 with the lesson as it is now when it has changed since the page read it', async () => {
    const { service, tx } = setup({ state: { version: 'b'.repeat(32), snapshot: { status: 'CANCELLED' } } });
    await expect(service.create('class-1', dto, teacher)).rejects.toMatchObject({
      status: 409,
      response: { code: CODES.STALE, current: { version: 'b'.repeat(32), snapshot: { status: 'CANCELLED' } } },
    });
    expect(tx['classTeacherChange']!['create']).not.toHaveBeenCalled();
  });

  it('is 409 with the draft that already waits for the lesson, when two write at once', async () => {
    const { service, tx } = setup();
    tx['classTeacherChange']!['create']!.mockRejectedValue(sqlError('23505', 'P2002'));
    tx['classTeacherChange']!['findFirst']!.mockResolvedValue(changeRow({ id: 'earlier' }));
    await expect(service.create('class-1', dto, teacher)).rejects.toMatchObject({
      status: 409,
      response: { code: CODES.DRAFT_EXISTS, existing: expect.objectContaining({ id: 'earlier' }) },
    });
    expect(tx['classTeacherChange']!['findFirst']).toHaveBeenCalledWith({ where: { studentGroupId: 'class-1', status: 'DRAFT', calendarLessonId: 'lesson-1' } });
  });

  it('looks for the template’s draft by the template lesson, and says so even if it cannot find it', async () => {
    const { service, tx } = setup();
    tx['classTeacherChange']!['create']!.mockRejectedValue(sqlError('23505'));
    tx['classTeacherChange']!['findFirst']!.mockResolvedValue(null);
    await expect(
      service.create('class-1', { kind: 'TEMPLATE_MOVE', masterLessonId: 'master-1', baseVersion: 'a'.repeat(32), targetDayOfWeek: 2, targetStart: '10:00', targetEnd: '11:00' }, teacher),
    ).rejects.toMatchObject({ status: 409, response: { code: CODES.DRAFT_EXISTS } });
    expect(tx['classTeacherChange']!['findFirst']!.mock.calls[0]![0].where).toEqual({ studentGroupId: 'class-1', status: 'DRAFT', masterLessonId: 'master-1' });
  });

  it('turns the database’s own refusals into coded answers', async () => {
    const stale = setup();
    stale.tx['classTeacherChange']!['create']!.mockRejectedValue(sqlError('CT409'));
    await expect(stale.service.create('class-1', dto, teacher)).rejects.toMatchObject({ status: 409, response: { code: CODES.STALE } });
    const row = setup();
    row.tx['classTeacherChange']!['create']!.mockRejectedValue(sqlError('42501'));
    await expect(row.service.create('class-1', dto, teacher)).rejects.toMatchObject({ status: 403, response: { code: CODES.OUTSIDE_FRAME } });
    const odd = setup();
    odd.tx['classTeacherChange']!['create']!.mockRejectedValue(sqlError('CT400'));
    await expect(odd.service.create('class-1', dto, teacher)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a request of the wrong shape before it touches the database', async () => {
    const { service, tx } = setup();
    await expect(service.create('class-1', { kind: 'OCCASION_CANCEL', baseVersion: 'a'.repeat(32) }, teacher)).rejects.toBeInstanceOf(BadRequestException);
    expect(tx['classTeacherAppointment']!['findFirst']).not.toHaveBeenCalled();
  });
});

describe('ClassTeacherService.update', () => {
  it('merges the patch onto the draft, asks the frame as a written draft, and writes at the revision read', async () => {
    const { service, tx } = setup();
    const current = changeRow({ kind: 'OCCASION_MOVE', targetDate: day('2027-03-23'), targetStart: time('10:00'), targetEnd: time('11:00'), rev: 2 });
    tx['classTeacherChange']!['findFirst']!.mockResolvedValue(current);
    tx['classTeacherChange']!['updateMany']!.mockResolvedValue({ count: 1 });
    tx['classTeacherChange']!['findUnique']!.mockResolvedValue({ ...current, targetStart: time('10:15'), rev: 3 });
    const view = await service.update('class-1', 'change-1', { rev: 2, targetStart: '10:15', note: 'Kortare', targetRoomId: null }, teacher);
    expect(view).toMatchObject({ id: 'change-1', targetStart: '10:15', rev: 3 });
    expect(tx['classTeacherChange']!['updateMany']).toHaveBeenCalledWith({
      where: { id: 'change-1', rev: 2, status: 'DRAFT' },
      data: { targetStart: time('10:15'), targetRoomId: null, note: 'Kortare' },
    });
    expect(tx['$queryRaw']!.mock.calls[0]!.slice(-1)[0]).toBe(false);
  });

  it('writes every column a patch may carry', async () => {
    const { service, tx } = setup();
    const current = changeRow({ rev: 1 });
    tx['classTeacherChange']!['findFirst']!.mockResolvedValue(current);
    tx['classTeacherChange']!['updateMany']!.mockResolvedValue({ count: 1 });
    tx['classTeacherChange']!['findUnique']!.mockResolvedValue(current);
    await service.update('class-1', 'change-1', { rev: 1, targetDate: '2027-03-24', targetDayOfWeek: 3, targetStart: '09:00', targetEnd: '10:00', keepEnd: '09:30', targetRoomId: 'room-2' }, teacher);
    expect(tx['classTeacherChange']!['updateMany']!.mock.calls[0]![0].data).toEqual({
      targetDate: day('2027-03-24'),
      targetDayOfWeek: 3,
      targetStart: time('09:00'),
      targetEnd: time('10:00'),
      targetRoomId: 'room-2',
      keepEnd: time('09:30'),
    });
  });

  it('is 409 with the draft as it stands when someone else has changed it, or it is published', async () => {
    const { service, tx } = setup();
    tx['classTeacherChange']!['findFirst']!.mockResolvedValue(changeRow({ rev: 4, note: 'Någon annans' }));
    await expect(service.update('class-1', 'change-1', { rev: 3, note: 'Mitt' }, teacher)).rejects.toMatchObject({
      status: 409,
      response: { code: CODES.REV, current: expect.objectContaining({ rev: 4, note: 'Någon annans' }) },
    });
    tx['classTeacherChange']!['findFirst']!.mockResolvedValue(changeRow({ rev: 3, status: 'PUBLISHED' }));
    await expect(service.update('class-1', 'change-1', { rev: 3, note: 'Mitt' }, teacher)).rejects.toMatchObject({ response: { code: CODES.REV } });
    expect(tx['classTeacherChange']!['updateMany']).not.toHaveBeenCalled();
  });

  it('is 409 too when the write finds the revision gone between the read and the write', async () => {
    const { service, tx } = setup();
    tx['classTeacherChange']!['findFirst']!.mockResolvedValue(changeRow({ rev: 3 }));
    tx['classTeacherChange']!['updateMany']!.mockResolvedValue({ count: 0 });
    tx['classTeacherChange']!['findUnique']!.mockResolvedValue(changeRow({ rev: 4 }));
    await expect(service.update('class-1', 'change-1', { rev: 3, note: 'x' }, teacher)).rejects.toMatchObject({ response: { code: CODES.REV, current: expect.objectContaining({ rev: 4 }) } });
    tx['classTeacherChange']!['findUnique']!.mockResolvedValue(null);
    await expect(service.update('class-1', 'change-1', { rev: 3, note: 'x' }, teacher)).rejects.toMatchObject({ response: { code: CODES.REV, current: expect.objectContaining({ rev: 3 }) } });
  });

  it('is 404 for a draft that is not there or not the class’s, 403 for a class that is not theirs, and 403 with the reason outside the frame', async () => {
    const missing = setup();
    missing.tx['classTeacherChange']!['findFirst']!.mockResolvedValue(null);
    await expect(missing.service.update('class-1', 'change-1', { rev: 1, note: 'x' }, teacher)).rejects.toMatchObject({ status: 404 });
    expect(missing.tx['classTeacherChange']!['findFirst']).toHaveBeenCalledWith({ where: { id: 'change-1', studentGroupId: 'class-1' } });
    const stranger = setup({ appointed: false });
    await expect(stranger.service.update('class-1', 'change-1', { rev: 1 }, teacher)).rejects.toMatchObject({ response: { code: CODES.NOT_APPOINTED } });
    const outside = setup({ frame: 'TARGET_CLOSED' });
    outside.tx['classTeacherChange']!['findFirst']!.mockResolvedValue(changeRow());
    await expect(outside.service.update('class-1', 'change-1', { rev: 1, targetStart: '07:00' }, teacher)).rejects.toMatchObject({
      status: 403,
      response: { reason: 'TARGET_CLOSED' },
    });
  });
});

describe('ClassTeacherService.discard', () => {
  it('removes a waiting draft of the class at the revision read', async () => {
    const { service, tx } = setup();
    tx['classTeacherChange']!['deleteMany']!.mockResolvedValue({ count: 1 });
    await expect(service.discard('class-1', 'change-1', 2, teacher)).resolves.toBeUndefined();
    expect(tx['classTeacherChange']!['deleteMany']).toHaveBeenCalledWith({ where: { id: 'change-1', studentGroupId: 'class-1', rev: 2, status: 'DRAFT' } });
  });

  it('is 409 with the draft as it stands when it has changed, 404 when it is gone', async () => {
    const { service, tx } = setup();
    tx['classTeacherChange']!['deleteMany']!.mockResolvedValue({ count: 0 });
    tx['classTeacherChange']!['findFirst']!.mockResolvedValue(changeRow({ rev: 5 }));
    await expect(service.discard('class-1', 'change-1', 2, teacher)).rejects.toMatchObject({ status: 409, response: { code: CODES.REV, current: expect.objectContaining({ rev: 5 }) } });
    tx['classTeacherChange']!['findFirst']!.mockResolvedValue(null);
    await expect(service.discard('class-1', 'change-1', 2, teacher)).rejects.toMatchObject({ status: 404 });
    await expect(setup({ appointed: false }).service.discard('class-1', 'change-1', 2, teacher)).rejects.toMatchObject({ status: 403 });
  });
});

describe('ClassTeacherService.check, preview and publish', () => {
  it('judges every waiting draft as the administrator the appointment runs as', async () => {
    const { service, tx, engine, prisma } = setup();
    tx['classTeacherChange']!['findMany']!.mockResolvedValue([changeRow()]);
    engine.evaluate.mockResolvedValue({ state: 'OK' });
    const result = await service.check('class-1', teacher);
    expect(result).toEqual([{ change: expect.objectContaining({ id: 'change-1' }), verdict: { state: 'OK' } }]);
    const asWhom = (prisma.withRls as unknown as jest.Mock).mock.calls.map((call) => (call[0] as { userId: string }).userId);
    expect(asWhom).toEqual(['teacher-1', 'admin-9']);
  });

  it('answers a refused check with the database’s words', async () => {
    const { service, tx } = setup();
    tx['$queryRaw']!.mockRejectedValue(sqlError('CT422'));
    await expect(service.check('class-1', teacher)).rejects.toMatchObject({ response: { code: CODES.APPOINTER_GONE } });
  });

  it('tries a change that is not written: the frame as a new draft, against the lesson as it is now', async () => {
    const { service, engine } = setup({ state: { version: 'c'.repeat(32), snapshot: { status: 'SCHEDULED' } } });
    engine.evaluate.mockResolvedValue({ state: 'CONFLICT', conflicts: [{ kind: 'GROUP' }] });
    const result = await service.preview('class-1', { kind: 'OCCASION_MOVE', calendarLessonId: 'lesson-1', targetDate: '2027-03-23', targetStart: '10:00', targetEnd: '11:00' }, teacher);
    expect(result).toEqual({ verdict: { state: 'CONFLICT', conflicts: [{ kind: 'GROUP' }] } });
    const [, draft, options] = engine.evaluate.mock.calls[0]!;
    expect(options).toEqual({ creating: true });
    expect(draft).toMatchObject({
      authorId: 'teacher-1',
      kind: 'OCCASION_MOVE',
      calendarLessonId: 'lesson-1',
      targetDate: day('2027-03-23'),
      targetStart: time('10:00'),
      baseVersion: 'c'.repeat(32),
      status: 'DRAFT',
    });
  });

  it('says GONE for a lesson that is not there and refuses a preview of the wrong shape', async () => {
    const { service, engine } = setup({ state: null });
    expect(await service.preview('class-1', { kind: 'OCCASION_CANCEL', calendarLessonId: 'lesson-1' }, teacher)).toEqual({ verdict: { state: 'GONE' } });
    expect(engine.evaluate).not.toHaveBeenCalled();
    await expect(service.preview('class-1', { kind: 'OCCASION_ROOM', calendarLessonId: 'lesson-1' }, teacher)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('tries a change of the grundschema through the master functions', async () => {
    const { service, engine, tx } = setup();
    tx['studentGroup']!['findUnique']!.mockResolvedValue(null);
    engine.evaluate.mockResolvedValue({ state: 'OK' });
    await service.preview('class-1', { kind: 'TEMPLATE_MOVE', masterLessonId: 'master-1', targetDayOfWeek: 2, targetStart: '10:00', targetEnd: '11:00', keepEnd: undefined }, teacher);
    expect(tx['$queryRaw']!.mock.calls.some((call) => sql(call[0]).includes('class_teacher_master_version'))).toBe(true);
  });

  it('publishes for the klasslärare only where the school allows it, as the administrator the database names', async () => {
    const off = setup({ selfPublish: false });
    await expect(off.service.publish('class-1', {}, teacher)).rejects.toMatchObject({ status: 403, response: { code: CODES.PUBLISH_OFF } });
    expect(off.engine.publishClass).not.toHaveBeenCalled();
    const none = setup({ selfPublish: null });
    await expect(none.service.publish('class-1', {}, teacher)).rejects.toMatchObject({ response: { code: CODES.PUBLISH_OFF } });
    const stranger = setup({ appointed: false, selfPublish: true });
    await expect(stranger.service.publish('class-1', {}, teacher)).rejects.toMatchObject({ response: { code: CODES.NOT_APPOINTED } });

    const on = setup({ selfPublish: true });
    on.engine.publishClass.mockResolvedValue([{ id: 'change-1', outcome: 'PUBLISHED' }]);
    expect(await on.service.publish('class-1', { changeIds: ['change-1'] }, teacher)).toEqual({ outcomes: [{ id: 'change-1', outcome: 'PUBLISHED' }] });
    expect(on.engine.publishClass).toHaveBeenCalledWith(expect.objectContaining({ userId: 'admin-9', role: 'SCHOOL_ADMIN' }), 'class-1', ['change-1']);
  });

  it('is told, not surprised, by a claimed error the database raises in the publication', async () => {
    const { service, engine } = setup({ selfPublish: true });
    engine.publishClass.mockRejectedValue(sqlError('CT403'));
    await expect(service.publish('class-1', {}, teacher)).rejects.toMatchObject({ status: 403 });
  });
});
