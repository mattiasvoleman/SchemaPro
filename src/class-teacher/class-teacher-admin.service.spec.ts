import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { ClassTeacherAdminService, mergeSpans } from './class-teacher-admin.service';
import type { ClassTeacherEngine, ChangeRow } from './class-teacher-engine';
import { CODES } from './class-teacher.types';

const admin = testUser({ schoolId: 'school-1', userId: 'admin-1' });
const time = (value: string): Date => new Date(`1970-01-01T${value}:00.000Z`);
const day = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

const sqlError = (state: string): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError('refused', { code: 'P2010', clientVersion: 'test', meta: { driverAdapterError: { cause: { originalCode: state } } } });

const draft = (over: Partial<ChangeRow> = {}): ChangeRow => ({
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

function setup() {
  const tx: TxMock = createTxMock();
  const prisma = createPrismaMock(tx) as unknown as PrismaService;
  const engine = { evaluate: jest.fn().mockResolvedValue({ state: 'OK' }), publishClass: jest.fn() };
  const service = new ClassTeacherAdminService(prisma, engine as unknown as ClassTeacherEngine);
  return { tx, service, engine };
}

describe('mergeSpans', () => {
  it('makes touching and overlapping spans of a day one, and leaves the rest', () => {
    expect(
      mergeSpans([
        { dayOfWeek: 2, startTime: '10:00', endTime: '12:00' },
        { dayOfWeek: 1, startTime: '10:00', endTime: '12:00' },
        { dayOfWeek: 1, startTime: '08:00', endTime: '10:00' },
        { dayOfWeek: 1, startTime: '09:00', endTime: '09:30' },
        { dayOfWeek: 1, startTime: '13:00', endTime: '14:00' },
      ]),
    ).toEqual([
      { dayOfWeek: 1, startTime: '08:00', endTime: '12:00' },
      { dayOfWeek: 1, startTime: '13:00', endTime: '14:00' },
      { dayOfWeek: 2, startTime: '10:00', endTime: '12:00' },
    ]);
  });

  it('does not stitch days together, and an empty list is empty', () => {
    expect(mergeSpans([{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }, { dayOfWeek: 2, startTime: '08:00', endTime: '12:00' }])).toHaveLength(2);
    expect(mergeSpans([])).toEqual([]);
  });
});

describe('ClassTeacherAdminService.appointments', () => {
  it('names the class and the teacher and says whether the appointment still runs', async () => {
    const { service, tx } = setup();
    tx['classTeacherAppointment']!['findMany']!.mockResolvedValue([
      { id: 'a1', academicYearId: 'year-1', studentGroupId: 'class-2', userId: 'u2', appointedByUserId: 'admin-1' },
      { id: 'a2', academicYearId: 'year-1', studentGroupId: 'class-1', userId: 'u1', appointedByUserId: 'exp' },
      { id: 'a3', academicYearId: 'year-1', studentGroupId: 'class-1', userId: 'u3', appointedByUserId: null },
      { id: 'a4', academicYearId: 'year-1', studentGroupId: 'class-3', userId: 'u1', appointedByUserId: 'gone' },
    ]);
    tx['studentGroup']!['findMany']!.mockResolvedValue([{ id: 'class-1', name: '4A' }, { id: 'class-2', name: '4B' }, { id: 'class-3', name: '5A' }]);
    tx['user']!['findMany']!.mockResolvedValue([
      { id: 'u1', firstName: 'Anna', lastName: 'Andersson', role: 'TEACHER', isActive: true, adminProfile: null },
      { id: 'u2', firstName: 'Bo', lastName: 'Berg', role: 'TEACHER', isActive: true, adminProfile: null },
      { id: 'u3', firstName: 'Cia', lastName: 'Cederholm', role: 'TEACHER', isActive: true, adminProfile: null },
      { id: 'admin-1', firstName: 'Sara', lastName: 'Schema', role: 'SCHOOL_ADMIN', isActive: true, adminProfile: 'SCHEMALAGGARE' },
      { id: 'exp', firstName: 'Eva', lastName: 'Expedit', role: 'SCHOOL_ADMIN', isActive: true, adminProfile: 'EXPEDITION' },
    ]);
    const list = await service.appointments('year-1', admin);
    expect(list.map((row) => [row.className, row.teacherName, row.runs])).toEqual([
      ['4A', 'Anna Andersson', false],
      ['4A', 'Cia Cederholm', false],
      ['4B', 'Bo Berg', true],
      ['5A', 'Anna Andersson', false],
    ]);
    expect(tx['classTeacherAppointment']!['findMany']).toHaveBeenCalledWith({ where: { academicYearId: 'year-1' }, orderBy: { createdAt: 'asc' } });
  });

  it('counts an inactive administrator, a teacher and a läsare as no one to run as', async () => {
    const { service, tx } = setup();
    tx['classTeacherAppointment']!['findMany']!.mockResolvedValue([
      { id: 'a1', academicYearId: 'y', studentGroupId: 'c', userId: 'u1', appointedByUserId: 'off' },
      { id: 'a2', academicYearId: 'y', studentGroupId: 'c', userId: 'u2', appointedByUserId: 'reader' },
      { id: 'a3', academicYearId: 'y', studentGroupId: 'c', userId: 'u3', appointedByUserId: 'rektor' },
    ]);
    tx['user']!['findMany']!.mockResolvedValue([
      { id: 'off', firstName: 'A', lastName: 'B', role: 'SCHOOL_ADMIN', isActive: false, adminProfile: 'FULL' },
      { id: 'reader', firstName: 'C', lastName: 'D', role: 'SCHOOL_ADMIN', isActive: true, adminProfile: 'LASARE' },
      { id: 'rektor', firstName: 'E', lastName: 'F', role: 'SCHOOL_ADMIN', isActive: true, adminProfile: 'REKTOR' },
    ]);
    expect((await service.appointments('y', admin)).map((row) => row.runs)).toEqual([false, false, true]);
  });
});

describe('ClassTeacherAdminService.appoint and remove', () => {
  it('appoints in the administrator’s name and answers the year’s list', async () => {
    const { service, tx } = setup();
    tx['studentGroup']!['findUnique']!.mockResolvedValue({ academicYearId: 'year-1' });
    tx['classTeacherAppointment']!['findFirst']!.mockResolvedValue(null);
    await service.appoint({ studentGroupId: 'class-1', userId: 'u1' }, admin);
    expect(tx['classTeacherAppointment']!['create']).toHaveBeenCalledWith({
      data: { schoolId: 'school-1', academicYearId: 'year-1', studentGroupId: 'class-1', userId: 'u1', appointedByUserId: 'admin-1' },
    });
    expect(tx['classTeacherAppointment']!['findMany']).toHaveBeenCalledWith({ where: { academicYearId: 'year-1' }, orderBy: { createdAt: 'asc' } });
  });

  it('takes an existing appointment over instead of making a second', async () => {
    const { service, tx } = setup();
    tx['studentGroup']!['findUnique']!.mockResolvedValue({ academicYearId: 'year-1' });
    tx['classTeacherAppointment']!['findFirst']!.mockResolvedValue({ id: 'a1' });
    await service.appoint({ studentGroupId: 'class-1', userId: 'u1' }, admin);
    expect(tx['classTeacherAppointment']!['update']).toHaveBeenCalledWith({ where: { id: 'a1' }, data: { appointedByUserId: 'admin-1' } });
    expect(tx['classTeacherAppointment']!['create']).not.toHaveBeenCalled();
  });

  it('is 404 for a class that is not there and 400 for a teacher the database refuses', async () => {
    const { service, tx } = setup();
    tx['studentGroup']!['findUnique']!.mockResolvedValue(null);
    await expect(service.appoint({ studentGroupId: 'class-1', userId: 'u1' }, admin)).rejects.toBeInstanceOf(NotFoundException);
    tx['studentGroup']!['findUnique']!.mockResolvedValue({ academicYearId: 'year-1' });
    tx['classTeacherAppointment']!['findFirst']!.mockResolvedValue(null);
    tx['classTeacherAppointment']!['create']!.mockRejectedValue(sqlError('CT400'));
    await expect(service.appoint({ studentGroupId: 'class-1', userId: 'u1' }, admin)).rejects.toMatchObject({ status: 400 });
  });

  it('removes an appointment, and is 404 for one that is not there', async () => {
    const { service, tx } = setup();
    tx['classTeacherAppointment']!['deleteMany']!.mockResolvedValue({ count: 1 });
    await expect(service.remove('a1', admin)).resolves.toBeUndefined();
    tx['classTeacherAppointment']!['deleteMany']!.mockResolvedValue({ count: 0 });
    await expect(service.remove('a1', admin)).rejects.toMatchObject({ response: { code: CODES.GONE } });
  });
});

describe('ClassTeacherAdminService open times', () => {
  it('lists the spans as clocks', async () => {
    const { service, tx } = setup();
    tx['classTeacherOpenTime']!['findMany']!.mockResolvedValue([
      { id: 'o1', academicYearId: 'year-1', studentGroupId: null, dayOfWeek: 1, startTime: time('08:00'), endTime: time('12:00') },
    ]);
    expect(await service.openTimes('year-1', admin)).toEqual([
      { id: 'o1', academicYearId: 'year-1', studentGroupId: null, dayOfWeek: 1, startTime: '08:00', endTime: '12:00' },
    ]);
  });

  it('replaces the spans of the scope whole, merging the ones that touch, and leaves other scopes alone', async () => {
    const { service, tx } = setup();
    await service.setOpenTimes(
      {
        academicYearId: 'year-1',
        studentGroupId: null,
        spans: [
          { dayOfWeek: 1, startTime: '08:00', endTime: '10:00' },
          { dayOfWeek: 1, startTime: '10:00', endTime: '12:00' },
        ],
      },
      admin,
    );
    expect(tx['classTeacherOpenTime']!['deleteMany']).toHaveBeenCalledWith({ where: { academicYearId: 'year-1', studentGroupId: null } });
    expect(tx['classTeacherOpenTime']!['createMany']).toHaveBeenCalledWith({
      data: [{ schoolId: 'school-1', academicYearId: 'year-1', studentGroupId: null, dayOfWeek: 1, startTime: time('08:00'), endTime: time('12:00') }],
    });
    await service.setOpenTimes({ academicYearId: 'year-1', studentGroupId: 'class-1', spans: [] }, admin);
    expect(tx['classTeacherOpenTime']!['deleteMany']).toHaveBeenLastCalledWith({ where: { academicYearId: 'year-1', studentGroupId: 'class-1' } });
    expect(tx['classTeacherOpenTime']!['createMany']).toHaveBeenCalledTimes(1);
  });

  it('refuses a span that ends before it starts, and maps the database’s refusal of the rest', async () => {
    const { service, tx } = setup();
    await expect(service.setOpenTimes({ academicYearId: 'year-1', spans: [{ dayOfWeek: 1, startTime: '10:00', endTime: '09:00' }] }, admin)).rejects.toBeInstanceOf(ConflictException);
    expect(tx['classTeacherOpenTime']!['deleteMany']).not.toHaveBeenCalled();
    tx['classTeacherOpenTime']!['createMany']!.mockRejectedValue(sqlError('23514'));
    await expect(service.setOpenTimes({ academicYearId: 'year-1', spans: [{ dayOfWeek: 1, startTime: '08:00', endTime: '09:00' }] }, admin)).rejects.toMatchObject({ status: 400 });
  });
});

describe('ClassTeacherAdminService settings', () => {
  it('is off for a school with no row and on when the row says so', async () => {
    const { service, tx } = setup();
    expect(await service.settings(admin)).toEqual({ selfPublish: false });
    tx['classTeacherSettings']!['findUnique']!.mockResolvedValue({ selfPublish: true });
    expect(await service.settings(admin)).toEqual({ selfPublish: true });
  });

  it('writes the school’s one row', async () => {
    const { service, tx } = setup();
    tx['classTeacherSettings']!['upsert']!.mockResolvedValue({ selfPublish: true });
    expect(await service.updateSettings({ selfPublish: true }, admin)).toEqual({ selfPublish: true });
    expect(tx['classTeacherSettings']!['upsert']).toHaveBeenCalledWith({
      where: { schoolId: 'school-1' },
      create: { schoolId: 'school-1', selfPublish: true },
      update: { selfPublish: true },
    });
  });
});

describe('ClassTeacherAdminService drafts', () => {
  it('lists what waits with the class, the author, the lesson’s subject and the check’s verdict', async () => {
    const { service, tx, engine } = setup();
    tx['classTeacherChange']!['findMany']!.mockResolvedValue([
      draft(),
      draft({ id: 'change-2', kind: 'TEMPLATE_MOVE', calendarLessonId: null, masterLessonId: 'master-1', authorId: null, date: null }),
    ]);
    tx['studentGroup']!['findMany']!.mockResolvedValue([{ id: 'class-1', name: '4A' }]);
    tx['user']!['findMany']!.mockResolvedValue([{ id: 'teacher-1', firstName: 'Anna', lastName: 'Andersson' }]);
    tx['calendarLesson']!['findMany']!.mockResolvedValue([{ id: 'lesson-1', subject: { name: 'Matte' } }]);
    tx['masterLesson']!['findMany']!.mockResolvedValue([{ id: 'master-1', subject: { name: 'Svenska' } }]);
    engine.evaluate.mockResolvedValueOnce({ state: 'OK' }).mockResolvedValueOnce({ state: 'REFUSED', reason: 'NOT_APPOINTED' });
    const rows = await service.drafts('class-1', admin);
    expect(rows).toEqual([
      { change: expect.objectContaining({ id: 'change-1' }), className: '4A', authorName: 'Anna Andersson', subjectName: 'Matte', verdict: { state: 'OK' } },
      { change: expect.objectContaining({ id: 'change-2' }), className: '4A', authorName: null, subjectName: 'Svenska', verdict: { state: 'REFUSED', reason: 'NOT_APPOINTED' } },
    ]);
    expect(tx['classTeacherChange']!['findMany']).toHaveBeenCalledWith({
      where: { status: 'DRAFT', studentGroupId: 'class-1' },
      orderBy: [{ studentGroupId: 'asc' }, { createdAt: 'asc' }],
    });
  });

  it('lists every class’s drafts when none is named, and a draft with no lesson has no subject', async () => {
    const { service, tx } = setup();
    tx['classTeacherChange']!['findMany']!.mockResolvedValue([draft({ calendarLessonId: null, authorId: 'gone' })]);
    const rows = await service.drafts(undefined, admin);
    expect(rows[0]).toMatchObject({ className: '', authorName: null, subjectName: null });
    expect(tx['classTeacherChange']!['findMany']!.mock.calls[0]![0].where).toEqual({ status: 'DRAFT' });
  });

  it('throws a waiting draft away, and is 404 for one that is gone or published', async () => {
    const { service, tx } = setup();
    tx['classTeacherChange']!['deleteMany']!.mockResolvedValue({ count: 1 });
    await expect(service.discard('change-1', admin)).resolves.toBeUndefined();
    expect(tx['classTeacherChange']!['deleteMany']).toHaveBeenCalledWith({ where: { id: 'change-1', status: 'DRAFT' } });
    tx['classTeacherChange']!['deleteMany']!.mockResolvedValue({ count: 0 });
    await expect(service.discard('change-1', admin)).rejects.toMatchObject({ response: { code: CODES.GONE } });
  });

  it('publishes a class as the administrator who asks', async () => {
    const { service, engine } = setup();
    engine.publishClass.mockResolvedValue([{ id: 'change-1', outcome: 'PUBLISHED' }]);
    expect(await service.publish('class-1', ['change-1'], admin)).toEqual({ outcomes: [{ id: 'change-1', outcome: 'PUBLISHED' }] });
    expect(engine.publishClass).toHaveBeenCalledWith(admin, 'class-1', ['change-1']);
    engine.publishClass.mockRejectedValue(sqlError('CT422'));
    await expect(service.publish('class-1', undefined, admin)).rejects.toMatchObject({ response: { code: CODES.APPOINTER_GONE } });
  });
});
