import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import { recordedReads } from '../../test/utils/recorded-reads';
import type { PrismaService } from '../database/prisma.service';
import {
  LESSON_LOG_BASIS,
  LESSON_LOG_NOT_YOURS,
  LESSON_LOG_RANGE,
  LESSON_LOG_STALE,
  LESSON_LOG_TOO_LONG,
  LESSON_LOG_TOPIC_ONE_LINE,
  LESSON_NOT_FOUND,
  LessonLogService,
  SUBSTITUTE_NOTE_NOT_YOURS,
  SUBSTITUTE_NOTE_STALE,
  assertRange,
} from './lesson-log.service';

const LESSON = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ME = '22222222-2222-4222-8222-222222222222';
const SCHOOL = '33333333-3333-4333-8333-333333333333';
const HOME = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ELSEWHERE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const EDITED = new Date('2026-10-20T09:15:00.000Z');

const teacher = testUser({ role: 'TEACHER' as never, channel: 'WEB' });
const pupil = testUser({ role: 'STUDENT' as never, channel: 'APP' });
const admin = testUser({ channel: 'WEB' });
const reader = testUser({ adminProfile: 'LASARE', channel: 'WEB' });

/** 08:00 and 08:45 Stockholm on 2026-10-20 (summer time until the 25th). */
const lessonRow = {
  id: LESSON,
  date: new Date('2026-10-20T00:00:00.000Z'),
  startsAt: new Date('2026-10-20T06:00:00.000Z'),
  endsAt: new Date('2026-10-20T06:45:00.000Z'),
  status: 'SCHEDULED',
  subject: { name: 'Matematik', color: '#123456' },
  studentGroup: { name: '7A' },
  extraGroups: [{ studentGroup: { name: '7B' } }],
  room: { name: 'B204' },
  teachers: [
    { role: 'LEAD', teacher: { firstName: 'Anna', lastName: 'Lind' } },
    { role: 'SUBSTITUTE', teacher: { firstName: 'Bo', lastName: 'Berg' } },
  ],
};

/** The SQL text of a raw statement the service sent. */
const sqlOf = (statement: unknown) => ((statement as { strings?: string[] }).strings ?? []).join('?');

describe('LessonLogService', () => {
  let tx: TxMock;
  let service: LessonLogService;
  let teacherRole: string | null;

  beforeEach(() => {
    tx = createTxMock();
    service = new LessonLogService(createPrismaMock(tx) as unknown as PrismaService);
    teacherRole = 'REGULAR';
    tx.$queryRaw = jest.fn((statement: unknown) =>
      Promise.resolve(sqlOf(statement).includes('app.lesson_teacher_role(') ? [{ role: teacherRole }] : []),
    );
    tx.school.findUnique.mockResolvedValue({ timezone: 'Europe/Stockholm' });
    tx.calendarLesson.findUnique.mockResolvedValue(lessonRow);
    tx.lessonLog.findUnique.mockResolvedValue(null);
    tx.lessonSubstituteNote.findUnique.mockResolvedValue(null);
  });

  describe('a lesson for its page', () => {
    it('answers the lesson on the school’s clock, the log and the note, and everything editable for its own teacher', async () => {
      tx.lessonLog.findUnique.mockResolvedValue({
        topic: 'Bråk',
        homework: 'Uppgift 4.1',
        updatedAt: EDITED,
        writtenBy: { firstName: 'Anna', lastName: 'Lind' },
      });
      tx.lessonSubstituteNote.findUnique.mockResolvedValue({
        body: 'Planeringen ligger i lärplattformen.',
        updatedAt: EDITED,
        writtenBy: null,
      });
      const view = await service.lesson(LESSON, teacher);
      expect(view).toEqual({
        lesson: {
          id: LESSON,
          date: '2026-10-20',
          start: '08:00',
          end: '08:45',
          status: 'SCHEDULED',
          subject: 'Matematik',
          subjectColor: '#123456',
          groups: ['7A', '7B'],
          room: 'B204',
          teachers: [
            { name: 'Anna Lind', role: 'LEAD' },
            { name: 'Bo Berg', role: 'SUBSTITUTE' },
          ],
        },
        role: 'REGULAR',
        may: { writeLog: true, readNote: true, writeNote: true },
        log: { topic: 'Bråk', homework: 'Uppgift 4.1', writtenBy: 'Anna Lind', updatedAt: EDITED.toISOString() },
        note: { body: 'Planeringen ligger i lärplattformen.', writtenBy: null, updatedAt: EDITED.toISOString() },
      });
      // Nothing about a person is read: no läslogg row.
      expect(recordedReads(tx)).toEqual([]);
    });

    it('lets the substitute write the log and read the note, not write it', async () => {
      teacherRole = 'SUBSTITUTE';
      const view = await service.lesson(LESSON, teacher);
      expect([view.role, view.may]).toEqual(['SUBSTITUTE', { writeLog: true, readNote: true, writeNote: false }]);
      expect(tx.lessonSubstituteNote.findUnique).toHaveBeenCalled();
    });

    it('shows another teacher the log, and never asks for the note', async () => {
      teacherRole = null;
      tx.lessonSubstituteNote.findUnique.mockResolvedValue({ body: 'hemligt', updatedAt: EDITED, writtenBy: null });
      const view = await service.lesson(LESSON, teacher);
      expect([view.role, view.may, view.note]).toEqual(['COLLEAGUE', { writeLog: false, readNote: false, writeNote: false }, null]);
      expect(tx.lessonSubstituteNote.findUnique).not.toHaveBeenCalled();
    });

    it('lets an administrator who writes DRIFT change the log; a läsare reads it; neither reads or writes the note', async () => {
      tx.lessonSubstituteNote.findUnique.mockResolvedValue({ body: 'Kalle går ut 10.15', updatedAt: EDITED, writtenBy: null });
      const full = await service.lesson(LESSON, admin);
      expect([full.role, full.may, full.note]).toEqual(['ADMIN', { writeLog: true, readNote: false, writeNote: false }, null]);
      const read = await service.lesson(LESSON, reader);
      expect([read.role, read.may, read.note]).toEqual(['ADMIN', { writeLog: false, readNote: false, writeNote: false }, null]);
      // The note is not even asked for, and an administrator is no teacher of
      // the lesson, so the function is not asked either.
      expect(tx.lessonSubstituteNote.findUnique).not.toHaveBeenCalled();
      expect(tx.$queryRaw.mock.calls.some(([statement]) => sqlOf(statement).includes('lesson_teacher_role'))).toBe(false);
    });

    it('is a 404 for a lesson the caller cannot read', async () => {
      tx.calendarLesson.findUnique.mockResolvedValue(null);
      await expect(service.lesson(LESSON, teacher)).rejects.toMatchObject({
        constructor: NotFoundException,
        response: { code: LESSON_NOT_FOUND },
      });
    });
  });

  describe('writing the log', () => {
    it('creates it trimmed, with the school (the database stamps the writer), after the lesson’s lock', async () => {
      tx.lessonLog.create.mockResolvedValue({ topic: 'Bråk', homework: 'Rad ett\nrad två', updatedAt: EDITED, writtenBy: { firstName: 'Anna', lastName: 'Lind' } });
      const result = await service.putLog(LESSON, { topic: '  Bråk ', homework: '\r\nRad ett\r\nrad två  \n', basis: null }, teacher);
      expect(tx.lessonLog.create).toHaveBeenCalledWith({
        data: { schoolId: SCHOOL, calendarLessonId: LESSON, topic: 'Bråk', homework: 'Rad ett\nrad två' },
        select: expect.any(Object),
      });
      expect(result.log).toEqual({ topic: 'Bråk', homework: 'Rad ett\nrad två', writtenBy: 'Anna Lind', updatedAt: EDITED.toISOString() });
      const lock = tx.$executeRaw.mock.calls.findIndex(([statement]) => sqlOf(statement).includes('pg_advisory_xact_lock'));
      expect(lock).toBeGreaterThanOrEqual(0);
      expect(tx.$executeRaw.mock.calls[lock]![0].values).toEqual([`LessonLog:log:${LESSON}`]);
    });

    it('updates the one there is', async () => {
      tx.lessonLog.findUnique.mockResolvedValue({ id: 'log', updatedAt: EDITED });
      tx.lessonLog.update.mockResolvedValue({ topic: null, homework: 'Läs s. 12', updatedAt: EDITED, writtenBy: null });
      await service.putLog(LESSON, { homework: 'Läs s. 12', basis: EDITED.toISOString() }, teacher);
      expect(tx.lessonLog.update).toHaveBeenCalledWith({
        where: { id: 'log' },
        data: { topic: null, homework: 'Läs s. 12' },
        select: expect.any(Object),
      });
    });

    it('removes it when both fields are empty, and writes nothing when there was none', async () => {
      tx.lessonLog.findUnique.mockResolvedValue({ id: 'log', updatedAt: EDITED });
      await expect(service.putLog(LESSON, { topic: '   ', homework: null }, teacher)).resolves.toEqual({ log: null });
      expect(tx.lessonLog.delete).toHaveBeenCalledWith({ where: { id: 'log' } });
      tx.lessonLog.findUnique.mockResolvedValue(null);
      tx.lessonLog.delete.mockClear();
      await expect(service.putLog(LESSON, {}, teacher)).resolves.toEqual({ log: null });
      expect(tx.lessonLog.delete).not.toHaveBeenCalled();
      expect(tx.lessonLog.create).not.toHaveBeenCalled();
    });

    it('refuses a log someone changed since the form read it, and one that appeared since', async () => {
      tx.lessonLog.findUnique.mockResolvedValue({ id: 'log', updatedAt: new Date('2026-10-20T09:16:00.000Z') });
      await expect(service.putLog(LESSON, { topic: 'x', basis: EDITED.toISOString() }, teacher)).rejects.toMatchObject({
        constructor: ConflictException,
        response: { code: LESSON_LOG_STALE },
      });
      await expect(service.putLog(LESSON, { topic: 'x', basis: null }, teacher)).rejects.toMatchObject({
        response: { code: LESSON_LOG_STALE },
      });
      tx.lessonLog.findUnique.mockResolvedValue(null);
      await expect(service.putLog(LESSON, { topic: 'x', basis: EDITED.toISOString() }, teacher)).rejects.toMatchObject({
        response: { code: LESSON_LOG_STALE },
      });
      expect(tx.lessonLog.create).not.toHaveBeenCalled();
      expect(tx.lessonLog.update).not.toHaveBeenCalled();
    });

    it('reads a basis with an offset as the same instant, and refuses one Date cannot read before any read', async () => {
      tx.lessonLog.findUnique.mockResolvedValue({ id: 'log', updatedAt: EDITED });
      tx.lessonLog.update.mockResolvedValue({ topic: 'x', homework: null, updatedAt: EDITED, writtenBy: null });
      await expect(service.putLog(LESSON, { topic: 'x', basis: '2026-10-20T11:15:00.000+02:00' }, teacher)).resolves.toBeDefined();
      tx.calendarLesson.findUnique.mockClear();
      await expect(service.putLog(LESSON, { topic: 'x', basis: '2026-02-30T25:61:00Z' }, teacher)).rejects.toMatchObject({
        constructor: BadRequestException,
        response: { code: LESSON_LOG_BASIS },
      });
      await expect(service.putNote(LESSON, { body: 'x', basis: 'igår' }, teacher)).rejects.toMatchObject({
        response: { code: LESSON_LOG_BASIS },
      });
      expect(tx.calendarLesson.findUnique).not.toHaveBeenCalled();
    });

    it('checks nothing without a basis: a script’s PUT overwrites', async () => {
      tx.lessonLog.findUnique.mockResolvedValue({ id: 'log', updatedAt: EDITED });
      tx.lessonLog.update.mockResolvedValue({ topic: 'x', homework: null, updatedAt: EDITED, writtenBy: null });
      await expect(service.putLog(LESSON, { topic: 'x' }, teacher)).resolves.toMatchObject({ log: { topic: 'x' } });
    });

    it('refuses a teacher who neither teaches nor covers the lesson, before anything is written', async () => {
      teacherRole = null;
      await expect(service.putLog(LESSON, { topic: 'x' }, teacher)).rejects.toMatchObject({
        constructor: ForbiddenException,
        response: { code: LESSON_LOG_NOT_YOURS },
      });
      expect(tx.lessonLog.create).not.toHaveBeenCalled();
    });

    it('lets the substitute write it', async () => {
      teacherRole = 'SUBSTITUTE';
      tx.lessonLog.create.mockResolvedValue({ topic: 'x', homework: null, updatedAt: EDITED, writtenBy: null });
      await expect(service.putLog(LESSON, { topic: 'x' }, teacher)).resolves.toMatchObject({ log: { topic: 'x' } });
    });

    it('refuses a topic over two lines and a field past its length, counted in characters, before any read', async () => {
      await expect(service.putLog(LESSON, { topic: 'Rad ett\nrad två' }, teacher)).rejects.toMatchObject({
        constructor: BadRequestException,
        response: { code: LESSON_LOG_TOPIC_ONE_LINE },
      });
      await expect(service.putLog(LESSON, { topic: 'x'.repeat(201) }, teacher)).rejects.toMatchObject({
        response: { code: LESSON_LOG_TOO_LONG, params: { field: 'topic', max: 200 } },
      });
      await expect(service.putLog(LESSON, { homework: 'x'.repeat(1001) }, teacher)).rejects.toMatchObject({
        response: { code: LESSON_LOG_TOO_LONG, params: { field: 'homework', max: 1000 } },
      });
      // 200 characters of which each is two UTF-16 units: the database's char_length says 200.
      tx.lessonLog.create.mockResolvedValue({ topic: 'x', homework: null, updatedAt: EDITED, writtenBy: null });
      await expect(service.putLog(LESSON, { topic: '📐'.repeat(200) }, teacher)).resolves.toBeDefined();
      expect(tx.calendarLesson.findUnique).toHaveBeenCalledTimes(1);
    });

    it('is a 404 for a lesson the caller cannot read', async () => {
      tx.calendarLesson.findUnique.mockResolvedValue(null);
      await expect(service.putLog(LESSON, { topic: 'x' }, teacher)).rejects.toMatchObject({ response: { code: LESSON_NOT_FOUND } });
    });
  });

  describe('writing the note to the substitute', () => {
    it('is the lesson’s own teacher’s: the substitute and another teacher are refused', async () => {
      for (const role of ['SUBSTITUTE', null]) {
        teacherRole = role;
        await expect(service.putNote(LESSON, { body: 'x' }, teacher)).rejects.toMatchObject({
          constructor: ForbiddenException,
          response: { code: SUBSTITUTE_NOTE_NOT_YOURS },
        });
      }
      expect(tx.lessonSubstituteNote.create).not.toHaveBeenCalled();
    });

    it('creates, updates and removes it, trimmed, under its own lock', async () => {
      tx.lessonSubstituteNote.create.mockResolvedValue({ body: 'Läs högt', updatedAt: EDITED, writtenBy: { firstName: 'Anna', lastName: 'Lind' } });
      await expect(service.putNote(LESSON, { body: ' Läs högt\n', basis: null }, teacher)).resolves.toEqual({
        note: { body: 'Läs högt', writtenBy: 'Anna Lind', updatedAt: EDITED.toISOString() },
      });
      expect(tx.lessonSubstituteNote.create).toHaveBeenCalledWith({
        data: { schoolId: SCHOOL, calendarLessonId: LESSON, body: 'Läs högt' },
        select: expect.any(Object),
      });
      expect(tx.$executeRaw.mock.calls.some(([statement]) => (statement as { values: unknown[] }).values?.[0] === `LessonLog:note:${LESSON}`)).toBe(true);

      tx.lessonSubstituteNote.findUnique.mockResolvedValue({ id: 'note', updatedAt: EDITED });
      tx.lessonSubstituteNote.update.mockResolvedValue({ body: 'Ny', updatedAt: EDITED, writtenBy: null });
      await service.putNote(LESSON, { body: 'Ny', basis: EDITED.toISOString() }, teacher);
      expect(tx.lessonSubstituteNote.update).toHaveBeenCalledWith({ where: { id: 'note' }, data: { body: 'Ny' }, select: expect.any(Object) });

      await expect(service.putNote(LESSON, { body: '' }, teacher)).resolves.toEqual({ note: null });
      expect(tx.lessonSubstituteNote.delete).toHaveBeenCalledWith({ where: { id: 'note' } });
    });

    it('refuses a note changed since the form read it', async () => {
      tx.lessonSubstituteNote.findUnique.mockResolvedValue({ id: 'note', updatedAt: new Date('2026-10-21T00:00:00.000Z') });
      await expect(service.putNote(LESSON, { body: 'x', basis: EDITED.toISOString() }, teacher)).rejects.toMatchObject({
        constructor: ConflictException,
        response: { code: SUBSTITUTE_NOTE_STALE },
      });
    });

    it('refuses a note past 2 000 characters', async () => {
      await expect(service.putNote(LESSON, { body: 'x'.repeat(2001) }, teacher)).rejects.toMatchObject({
        response: { code: LESSON_LOG_TOO_LONG, params: { field: 'body', max: 2000 } },
      });
    });

    it('refuses an administrator, who is no teacher of the lesson, whatever the profile writes', async () => {
      // The route admits TEACHER alone; behind it the function answers NULL
      // for every other role, and the database has no administrator's arm.
      teacherRole = null;
      for (const caller of [admin, reader]) {
        await expect(service.putNote(LESSON, { body: 'x' }, caller)).rejects.toMatchObject({
          constructor: ForbiddenException,
          response: { code: SUBSTITUTE_NOTE_NOT_YOURS },
        });
      }
      expect(tx.lessonSubstituteNote.create).not.toHaveBeenCalled();
    });
  });

  describe('the caller’s own lessons over a range', () => {
    it('gives a pupil the logs of the lessons the roster reader puts them on, and no note', async () => {
      tx.calendarLesson.findMany.mockResolvedValue([
        { id: LESSON, studentGroupId: HOME, extraGroups: [] },
        { id: OTHER, studentGroupId: ELSEWHERE, extraGroups: [] },
      ]);
      // The roster reader: the pupil is in HOME and in no teaching group.
      tx.user.findMany.mockResolvedValue([{ id: ME, studentGroupId: HOME }]);
      tx.lessonLog.findMany.mockResolvedValue([{ calendarLessonId: LESSON, topic: 'Bråk', homework: null }]);
      const result = await service.listForCaller({ from: '2026-10-19', to: '2026-10-25' }, pupil);
      expect(result).toEqual({ entries: [{ lessonId: LESSON, topic: 'Bråk', homework: null }] });
      expect(tx.lessonLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { calendarLessonId: { in: [LESSON] } } }));
      expect(tx.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: { in: [ME] }, role: 'STUDENT', isActive: true }) }),
      );
      expect(tx.lessonSubstituteNote.findMany).not.toHaveBeenCalled();
      expect(recordedReads(tx)).toEqual([]);
    });

    it('asks for no log when the roster puts the pupil on none of the lessons', async () => {
      tx.calendarLesson.findMany.mockResolvedValue([{ id: OTHER, studentGroupId: ELSEWHERE, extraGroups: [] }]);
      await expect(service.listForCaller({ from: '2026-10-19', to: '2026-10-19' }, pupil)).resolves.toEqual({ entries: [] });
      expect(tx.lessonLog.findMany).not.toHaveBeenCalled();
    });

    it('gives a teacher the logs and notes of the lessons they are on, a lesson with only a note included', async () => {
      tx.calendarLessonTeacher.findMany.mockResolvedValue([{ calendarLessonId: LESSON }, { calendarLessonId: OTHER }]);
      tx.lessonLog.findMany.mockResolvedValue([{ calendarLessonId: LESSON, topic: 'Bråk', homework: 'Läs' }]);
      tx.lessonSubstituteNote.findMany.mockResolvedValue([{ calendarLessonId: OTHER, body: 'Ring mig' }]);
      const result = await service.listForCaller({ from: '2026-10-19', to: '2026-10-30' }, teacher);
      expect(result.entries).toEqual([
        { lessonId: LESSON, topic: 'Bråk', homework: 'Läs', substituteNote: null },
        { lessonId: OTHER, topic: null, homework: null, substituteNote: 'Ring mig' },
      ]);
      expect(tx.calendarLessonTeacher.findMany).toHaveBeenCalledWith({
        where: {
          teacherId: ME,
          calendarLesson: { date: { gte: new Date('2026-10-19T00:00:00.000Z'), lte: new Date('2026-10-30T00:00:00.000Z') } },
        },
        select: { calendarLessonId: true },
      });
    });

    it('refuses a range that is not one: an unreal day, backwards, or past six weeks', async () => {
      for (const [from, to] of [
        ['2026-02-30', '2026-03-01'],
        ['2026-10-20', '2026-10-19'],
        ['2026-10-01', '2026-11-12'],
      ]) {
        await expect(service.listForCaller({ from: from!, to: to! }, teacher)).rejects.toMatchObject({
          constructor: BadRequestException,
          response: { code: LESSON_LOG_RANGE },
        });
      }
      await expect(service.listForCaller({ from: '2026-10-01', to: '2026-11-11' }, teacher)).resolves.toEqual({ entries: [] });
    });
  });

  describe('the lessons a teacher handed over', () => {
    it('lists the lessons decided for the caller’s own absences in the range, one row each, with whether a note is left', async () => {
      tx.teacherAbsence.findMany.mockResolvedValue([{ id: 'a-1' }, { id: 'a-2' }]);
      tx.teacherAbsenceCover.findMany.mockResolvedValue([
        { calendarLessonId: LESSON, decision: 'SUBSTITUTE' },
        { calendarLessonId: OTHER, decision: 'CANCELLED' },
      ]);
      tx.calendarLesson.findMany.mockResolvedValue([
        {
          id: LESSON,
          date: new Date('2026-10-20T00:00:00.000Z'),
          startsAt: new Date('2026-10-20T06:00:00.000Z'),
          endsAt: new Date('2026-10-20T06:45:00.000Z'),
          subjectId: 's',
          studentGroupId: HOME,
          roomId: null,
          status: 'SCHEDULED',
        },
      ]);
      tx.lessonSubstituteNote.findMany.mockResolvedValue([{ calendarLessonId: LESSON }]);
      const result = await service.handedOver({ from: '2026-10-19', to: '2026-10-25' }, teacher);
      expect(result.lessons).toEqual([
        {
          lessonId: LESSON,
          date: '2026-10-20',
          startsAt: '2026-10-20T06:00:00.000Z',
          endsAt: '2026-10-20T06:45:00.000Z',
          subjectId: 's',
          studentGroupId: HOME,
          roomId: null,
          status: 'SCHEDULED',
          decision: 'SUBSTITUTE',
          noted: true,
        },
      ]);
      expect(tx.teacherAbsence.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: ME }) }));
      expect(tx.teacherAbsenceCover.findMany).toHaveBeenCalledWith({
        where: { absentTeacherId: ME, absenceId: { in: ['a-1', 'a-2'] } },
        select: { calendarLessonId: true, decision: true },
      });
      expect(tx.calendarLesson.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: [LESSON, OTHER] }, date: { gte: new Date('2026-10-19T00:00:00.000Z'), lte: new Date('2026-10-25T00:00:00.000Z') } },
        }),
      );
      // Nothing names the substitute, nothing is in the läslogg.
      expect(JSON.stringify(result)).not.toMatch(/substitute(Id)?"/);
      expect(recordedReads(tx)).toEqual([]);
    });

    it('asks for no decision when the caller was not away, and refuses a range that is not one', async () => {
      await expect(service.handedOver({ from: '2026-10-19', to: '2026-10-25' }, teacher)).resolves.toEqual({ lessons: [] });
      expect(tx.teacherAbsenceCover.findMany).not.toHaveBeenCalled();
      await expect(service.handedOver({ from: '2026-10-25', to: '2026-10-19' }, teacher)).rejects.toMatchObject({
        response: { code: LESSON_LOG_RANGE },
      });
    });
  });

  it('counts a range’s days inclusively', () => {
    expect(() => assertRange('2026-10-01', '2026-10-01', 1, 'X')).not.toThrow();
    expect(() => assertRange('2026-10-01', '2026-10-02', 1, 'X')).toThrow(BadRequestException);
  });
});
