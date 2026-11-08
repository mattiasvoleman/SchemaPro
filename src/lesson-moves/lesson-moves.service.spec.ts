import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createPrismaMock, createTxMock, testUser, type PrismaMock, type TxMock } from '../../test/utils/prisma-mock';
import { Role } from '../auth/enums/role.enum';
import * as rosterModule from '../calendar/lesson-roster';
import type { PrismaService } from '../database/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { LessonMovesService, doorError, refusalError } from './lesson-moves.service';

jest.mock('../calendar/lesson-roster');
jest.mock('../cover/cover-context', () => ({ schoolTimezone: jest.fn().mockResolvedValue('Europe/Stockholm') }));
jest.mock('../access-log/access-log', () => ({ recordRead: jest.fn().mockResolvedValue(undefined) }));

const SCHOOL = '33333333-3333-4333-8333-333333333333';
const ADMIN = '11111111-1111-4111-8111-111111111111';
const TEACHER_X = '22222222-2222-4222-8222-222222222221';
const TEACHER_Y = '22222222-2222-4222-8222-222222222222';
const STRANGER = '22222222-2222-4222-8222-222222222229';
const PUPIL = '55555555-5555-4555-8555-555555555555';
const OTHER_PUPIL = '55555555-5555-4555-8555-555555555556';
const GUARDIAN = '77777777-7777-4777-8777-777777777777';
const X = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const Y = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002';
const Z = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000003';
const W = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000004';
const MOVE = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001';

const DATE = new Date('2026-11-10T00:00:00.000Z');
const at = (hhmm: string) => new Date(`2026-11-10T${hhmm}:00.000Z`);

/** A lesson as LESSON_SELECT reads it. */
const row = (id: string, from: string, to: string, extra: Record<string, unknown> = {}) => ({
  id,
  schoolId: SCHOOL,
  date: DATE,
  startsAt: at(from),
  endsAt: at(to),
  status: 'SCHEDULED',
  cancelCause: null,
  subjectId: `subject-${id}`,
  studentGroupId: `group-${id}`,
  subject: { name: `Ämne ${id.slice(-1)}` },
  studentGroup: { name: `Klass ${id.slice(-1)}` },
  room: { name: 'Sal', capacity: 30 },
  extraGroups: [],
  ...extra,
});

describe('LessonMovesService', () => {
  let tx: TxMock;
  let prisma: PrismaMock;
  let realtime: { notifyLessonsChanged: jest.Mock };
  let notifications: { notifyUsers: jest.Mock; guardiansOf: jest.Mock };
  let service: LessonMovesService;
  let lessons: Record<string, ReturnType<typeof row>>;
  /** The roster of each lesson, by id, as the one roster reader would answer it. */
  let rosters: Record<string, string[]>;

  const admin = () => testUser({ role: Role.SCHOOL_ADMIN, userId: ADMIN });
  const teacher = (userId = TEACHER_X) => testUser({ role: Role.TEACHER, userId });

  beforeEach(() => {
    // The clock before every lesson of the file (they are all 2026-11-10), only Date: the lessons are over or not
    // by this clock and never by the day the suite is run.
    jest.useFakeTimers({ now: at('08:00'), doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'] });
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    realtime = { notifyLessonsChanged: jest.fn().mockResolvedValue(undefined) };
    notifications = { notifyUsers: jest.fn().mockResolvedValue(1), guardiansOf: jest.fn().mockResolvedValue([GUARDIAN]) };
    service = new LessonMovesService(
      prisma as unknown as PrismaService,
      realtime as unknown as RealtimeService,
      notifications as unknown as NotificationsService,
    );
    lessons = { [X]: row(X, '09:00', '10:00'), [Y]: row(Y, '09:00', '10:00'), [Z]: row(Z, '09:30', '10:30'), [W]: row(W, '11:00', '12:00') };
    rosters = { [X]: [PUPIL, OTHER_PUPIL], [Y]: [], [Z]: [], [W]: [PUPIL] };

    tx['calendarLesson']!['findUnique']!.mockImplementation(async ({ where }: { where: { id: string } }) => lessons[where.id] ?? null);
    tx['calendarLesson']!['findMany']!.mockImplementation(async () => Object.values(lessons));
    tx['user']!['findFirst']!.mockResolvedValue({ id: PUPIL });
    tx['lessonPupilMove']!['findFirst']!.mockResolvedValue(null);
    tx['calendarLessonTeacher']!['findFirst']!.mockImplementation(async ({ where }: { where: { teacherId: string; calendarLessonId: string | { in: string[] } } }) => {
      const ids = typeof where.calendarLessonId === 'string' ? [where.calendarLessonId] : where.calendarLessonId.in;
      return (where.teacherId === TEACHER_X && ids.includes(X)) || (where.teacherId === TEACHER_Y && ids.includes(Y)) ? { id: 'teaches' } : null;
    });
    tx['calendarLessonTeacher']!['findMany']!.mockResolvedValue([{ teacherId: TEACHER_X }, { teacherId: TEACHER_Y }]);
    tx['schoolDaySettings']!['findUnique']!.mockResolvedValue({ guardianNoticeOnMove: false });
    tx['$queryRaw']!.mockResolvedValue([{ id: MOVE }]);
    (rosterModule.calendarLessonRosters as jest.Mock).mockImplementation(async (_tx: unknown, asked: Array<{ id: string }>, options: { among?: string[] }) =>
      new Map(
        asked.map((lesson) => [
          lesson.id,
          new Set((rosters[lesson.id] ?? []).filter((id) => !options.among || options.among.includes(id))),
        ]),
      ),
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('move', () => {
    it('moves a pupil of the lesson to a parallel one through the database’s door, and tells the rooms and the teachers', async () => {
      const result = await service.move(PUPIL, X, Y, admin());

      expect(result).toEqual({ moved: true, moveId: MOVE, warnings: [] });
      const call = tx['$queryRaw']!.mock.calls.find(([sql]) => String(sql?.strings ?? sql).includes('app.lesson_pupil_move'));
      expect(call).toBeDefined();
      expect(call![0].values).toEqual([PUPIL, X, Y]);
      expect(realtime.notifyLessonsChanged).toHaveBeenCalledWith(tx, expect.arrayContaining([X, Y]));
      // The teachers of both lessons, not the one who moved (the administrator is no teacher on them).
      expect(notifications.notifyUsers).toHaveBeenCalledTimes(1);
      expect(notifications.notifyUsers).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ userIds: [TEACHER_X, TEACHER_Y], type: 'LESSON_PUPIL_MOVED', meta: expect.objectContaining({ fromLessonId: X, toLessonId: Y, studentId: PUPIL }) }),
      );
    });

    it('does not tell the guardian unless the school has said so, and then in a mail that names no child', async () => {
      await service.move(PUPIL, X, Y, admin());
      expect(notifications.guardiansOf).not.toHaveBeenCalled();

      notifications.notifyUsers.mockClear();
      tx['schoolDaySettings']!['findUnique']!.mockResolvedValue({ guardianNoticeOnMove: true });
      await service.move(PUPIL, X, Y, admin());
      const guardianNotice = notifications.notifyUsers.mock.calls.map(([, input]) => input).find((input) => input.userIds.includes(GUARDIAN));
      expect(guardianNotice).toBeDefined();
      expect(guardianNotice.email.subject).toMatch(/byter lektion/);
      expect(JSON.stringify(guardianNotice)).not.toMatch(/Elev|Klass 1|Sal/);
    });

    it('does not tell the teacher who made the move', async () => {
      await service.move(PUPIL, X, Y, teacher(TEACHER_X));
      const input = notifications.notifyUsers.mock.calls[0]![1];
      expect(input.userIds).toEqual([TEACHER_Y]);
    });

    it('warns, and does not refuse, when the target’s room would be over its capacity', async () => {
      lessons[Y] = row(Y, '09:00', '10:00', { room: { name: 'Liten sal', capacity: 2 } });
      rosters[Y] = ['p-a', 'p-b'];
      const result = await service.move(PUPIL, X, Y, admin());
      expect(result.moved).toBe(true);
      expect(result.warnings).toEqual([{ code: 'TARGET_ROOM_OVER_CAPACITY', headcount: 3, capacity: 2 }]);
    });

    it.each([
      ['a lesson that does not overlap', W, 'LESSON_MOVE_NOT_PARALLEL'],
    ])('refuses %s with a named reason, and writes nothing', async (_what, target, code) => {
      await expect(service.move(PUPIL, X, target, admin())).rejects.toMatchObject({ response: { code } });
      expect(tx['$queryRaw']!.mock.calls.some(([sql]) => String(sql?.strings ?? '').includes('app.lesson_pupil_move'))).toBe(false);
      expect(realtime.notifyLessonsChanged).not.toHaveBeenCalled();
    });

    it('refuses a cancelled target, and a target an activity has replaced, with different reasons', async () => {
      lessons[Y] = row(Y, '09:00', '10:00', { status: 'CANCELLED', cancelCause: 'MANUAL' });
      await expect(service.move(PUPIL, X, Y, admin())).rejects.toMatchObject({ response: { code: 'LESSON_MOVE_LESSON_NOT_HELD', params: { side: 'TO' } } });
      lessons[Y] = row(Y, '09:00', '10:00', { status: 'CANCELLED', cancelCause: 'EVENT' });
      await expect(service.move(PUPIL, X, Y, admin())).rejects.toMatchObject({ response: { code: 'LESSON_MOVE_REPLACED_BY_ACTIVITY', params: { side: 'TO' } } });
    });

    it('refuses a pupil who is not on the lesson they are moved from', async () => {
      rosters[X] = [OTHER_PUPIL];
      await expect(service.move(PUPIL, X, Y, admin())).rejects.toMatchObject({ response: { code: 'LESSON_MOVE_PUPIL_NOT_ON_LESSON' } });
    });

    it('refuses a pupil who is on the target already', async () => {
      rosters[Y] = [PUPIL];
      await expect(service.move(PUPIL, X, Y, admin())).rejects.toMatchObject({ response: { code: 'LESSON_MOVE_ALREADY_ON_TARGET' } });
    });

    it('refuses a target that would put the pupil beside another of their lessons', async () => {
      // Z runs 09:30-10:30; the pupil has W-like lesson 10:00-11:00 as well.
      const next = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000005';
      lessons[next] = row(next, '10:00', '11:00');
      rosters[next] = [PUPIL];
      await expect(service.move(PUPIL, X, Z, admin())).rejects.toMatchObject({ response: { code: 'LESSON_MOVE_PUPIL_DOUBLE_BOOKED' } });
    });

    it('lets a teacher of the source and a teacher of the target move the pupil, and no other teacher', async () => {
      await expect(service.move(PUPIL, X, Y, teacher(TEACHER_X))).resolves.toMatchObject({ moved: true });
      await expect(service.move(PUPIL, X, Y, teacher(TEACHER_Y))).resolves.toMatchObject({ moved: true });
      await expect(service.move(PUPIL, X, Y, teacher(STRANGER))).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('lets a mentor who teaches neither lesson move their mentee, and says nothing about the lesson to anyone else', async () => {
      tx['$queryRaw']!.mockImplementation(async (sql: { strings?: string[] }) =>
        String(sql?.strings).includes('lesson_move_is_mentor') ? [{ mentor: true }] : [{ id: MOVE }],
      );
      await expect(service.move(PUPIL, X, Y, teacher(STRANGER))).resolves.toMatchObject({ moved: true });

      tx['$queryRaw']!.mockImplementation(async (sql: { strings?: string[] }) =>
        String(sql?.strings).includes('lesson_move_is_mentor') ? [{ mentor: false }] : [{ id: MOVE }],
      );
      rosters[X] = [];
      // The stranger is turned away before the roster is read: the refusal does not reveal who is on the lesson.
      await expect(service.move(PUPIL, X, Y, teacher(STRANGER))).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('moves a pupil on from a lesson a move put them on, from where they started', async () => {
      tx['lessonPupilMove']!['findFirst']!.mockResolvedValue({ id: MOVE, fromLessonId: X });
      lessons[W] = row(W, '09:15', '10:15');
      rosters[W] = [];
      const result = await service.move(PUPIL, Y, W, admin());
      expect(result.moved).toBe(true);
      const call = tx['$queryRaw']!.mock.calls.find(([sql]) => String(sql?.strings).includes('app.lesson_pupil_move'));
      expect(call![0].values).toEqual([PUPIL, Y, W]);
    });

    it('sends a pupil back to the lesson they started on: the move is undone, and nothing is checked of the target', async () => {
      tx['lessonPupilMove']!['findFirst']!.mockResolvedValue({ id: MOVE, fromLessonId: X });
      tx['$queryRaw']!.mockResolvedValue([{ id: null }]);
      lessons[X] = row(X, '09:00', '10:00', { status: 'CANCELLED', cancelCause: 'MANUAL' });
      const result = await service.move(PUPIL, Y, X, admin());
      expect(result).toEqual({ moved: false, moveId: null, warnings: [] });
      expect(notifications.notifyUsers.mock.calls[0]![1].meta.undone).toBe(true);
    });

    it('refuses a source that is over, with its own reason, and writes nothing: the day is not the hour', async () => {
      // 10:00: the pupil's lesson ended at 10:00 sharp, and the teacher of the target alone is asking.
      jest.setSystemTime(at('10:00'));
      lessons[Y] = row(Y, '09:00', '11:00');
      await expect(service.move(PUPIL, X, Y, teacher(TEACHER_Y))).rejects.toMatchObject({
        response: { code: 'LESSON_MOVE_LESSON_OVER', params: { side: 'FROM' } },
        status: 409,
      });
      expect(tx['$queryRaw']!.mock.calls.some(([sql]) => String(sql?.strings ?? '').includes('app.lesson_pupil_move'))).toBe(false);
      expect(realtime.notifyLessonsChanged).not.toHaveBeenCalled();

      // A minute earlier the source is still running: the door is asked.
      jest.setSystemTime(at('09:59'));
      await expect(service.move(PUPIL, X, Y, teacher(TEACHER_Y))).resolves.toMatchObject({ moved: true });
    });

    it('leaves a pupil who is moved on from a lesson a move put them on to the database after the first source ended', async () => {
      // Moved from X to Y; X ended at 10:00, Y runs to 11:00 and the pupil goes on to Z. Who may do that after the end is the
      // database's to say (an administrator with Drift, a teacher on the lesson the pupil stands on): no refusal from the clock here.
      tx['lessonPupilMove']!['findFirst']!.mockResolvedValue({ id: MOVE, fromLessonId: X });
      lessons[Y] = row(Y, '09:00', '11:00');
      lessons[Z] = row(Z, '09:30', '10:30');
      rosters[Y] = [PUPIL];
      rosters[Z] = [];
      jest.setSystemTime(at('10:15'));
      await expect(service.move(PUPIL, Y, Z, teacher(TEACHER_Y))).resolves.toMatchObject({ moved: true });
      const call = tx['$queryRaw']!.mock.calls.find(([sql]) => String(sql?.strings).includes('app.lesson_pupil_move'));
      expect(call![0].values).toEqual([PUPIL, Y, Z]);
    });

    it('sends a pupil back to a first source that has ended through the door, which answers who may', async () => {
      tx['lessonPupilMove']!['findFirst']!.mockResolvedValue({ id: MOVE, fromLessonId: X });
      jest.setSystemTime(at('10:30'));
      tx['$queryRaw']!.mockResolvedValue([{ id: null }]);
      await expect(service.move(PUPIL, Y, X, admin())).resolves.toEqual({ moved: false, moveId: null, warnings: [] });
      const refused = new Prisma.PrismaClientKnownRequestError('boom', {
        code: 'P2010',
        clientVersion: 'x',
        meta: { driverAdapterError: { cause: { originalCode: 'LM416', originalMessage: 'LESSON_MOVE_LESSON_OVER: ...' } } },
      });
      tx['$queryRaw']!.mockRejectedValue(refused);
      await expect(service.move(PUPIL, Y, X, teacher(TEACHER_Y))).rejects.toMatchObject({ response: { code: 'LESSON_MOVE_LESSON_OVER' }, status: 409 });
    });

    it('answers the database’s refusal of a source that is over (a clock that ran between the gateway and the door) with the same code', async () => {
      const over = new Prisma.PrismaClientKnownRequestError('boom', {
        code: 'P2010',
        clientVersion: 'x',
        meta: { driverAdapterError: { cause: { originalCode: 'LM416', originalMessage: 'LESSON_MOVE_LESSON_OVER: ...' } } },
      });
      tx['$queryRaw']!.mockRejectedValue(over);
      await expect(service.move(PUPIL, X, Y, admin())).rejects.toMatchObject({ response: { code: 'LESSON_MOVE_LESSON_OVER' }, status: 409 });
      expect(realtime.notifyLessonsChanged).not.toHaveBeenCalled();
    });

    it.each([
      ['a lesson that went missing', 'LESSON_MOVE_LESSON_NOT_FOUND: lektionen finns inte i skolan', 'LESSON_MOVE_LESSON_NOT_FOUND'],
      ['a pupil who is gone', 'LESSON_MOVE_NOT_A_PUPIL: bara en aktiv elev i skolan kan flyttas', 'LESSON_MOVE_NOT_A_PUPIL'],
      ['a move that is gone', 'LESSON_MOVE_NOT_FOUND: flytten finns inte', 'LESSON_MOVE_NOT_FOUND'],
      ['a refusal that names nothing', 'something else', 'LESSON_MOVE_NOT_FOUND'],
    ])('says which of the three LM404 it is: %s', async (_what, originalMessage, code) => {
      tx['$queryRaw']!.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('boom', { code: 'P2010', clientVersion: 'x', meta: { driverAdapterError: { cause: { originalCode: 'LM404', originalMessage } } } }),
      );
      await expect(service.move(PUPIL, X, Y, admin())).rejects.toMatchObject({ response: { code }, status: 404 });
    });

    it('answers the database’s refusal of a race with the same code the gateway would have given', async () => {
      const refused = new Prisma.PrismaClientKnownRequestError('boom', {
        code: 'P2010',
        clientVersion: 'x',
        meta: { driverAdapterError: { cause: { originalCode: 'LM412', originalMessage: 'LESSON_MOVE_NOT_PARALLEL: ...' } } },
      });
      tx['$queryRaw']!.mockRejectedValue(refused);
      await expect(service.move(PUPIL, X, Y, admin())).rejects.toMatchObject({ response: { code: 'LESSON_MOVE_NOT_PARALLEL' } });
      expect(realtime.notifyLessonsChanged).not.toHaveBeenCalled();
    });
  });

  describe('undo', () => {
    it('takes a move back through the door, tells the rooms and the teachers that it is undone', async () => {
      tx['lessonPupilMove']!['findUnique']!.mockResolvedValue({ studentId: PUPIL, fromLessonId: X, toLessonId: Y });
      await service.undo(MOVE, admin());
      expect(tx['$executeRaw']!.mock.calls.some(([sql]) => String(sql?.strings).includes('lesson_pupil_move_undo'))).toBe(true);
      expect(realtime.notifyLessonsChanged).toHaveBeenCalledWith(tx, expect.arrayContaining([X, Y]));
      expect(notifications.notifyUsers.mock.calls[0]![1].meta).toMatchObject({ undone: true, fromLessonId: X, toLessonId: Y });
    });

    it('is a 404 for a move the caller cannot read', async () => {
      tx['lessonPupilMove']!['findUnique']!.mockResolvedValue(null);
      await expect(service.undo(MOVE, teacher(STRANGER))).rejects.toBeInstanceOf(NotFoundException);
    });

    it('says that the lesson the pupil was moved from is over, and does not tell anyone', async () => {
      tx['lessonPupilMove']!['findUnique']!.mockResolvedValue({ studentId: PUPIL, fromLessonId: X, toLessonId: Y });
      tx['$executeRaw']!.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('boom', {
          code: 'P2010',
          clientVersion: 'x',
          meta: { driverAdapterError: { cause: { originalCode: 'LM416', originalMessage: 'LESSON_MOVE_LESSON_OVER: ...' } } },
        }),
      );
      await expect(service.undo(MOVE, teacher(TEACHER_Y))).rejects.toMatchObject({ response: { code: 'LESSON_MOVE_LESSON_OVER' }, status: 409 });
      expect(realtime.notifyLessonsChanged).not.toHaveBeenCalled();
      expect(notifications.notifyUsers).not.toHaveBeenCalled();
    });

    it('says why when the pupil has a mark on the lesson they were moved to', async () => {
      tx['lessonPupilMove']!['findUnique']!.mockResolvedValue({ studentId: PUPIL, fromLessonId: X, toLessonId: Y });
      tx['$executeRaw']!.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('boom', {
          code: 'P2010',
          clientVersion: 'x',
          meta: { driverAdapterError: { cause: { originalCode: 'LM415', originalMessage: 'LESSON_MOVE_HAS_ATTENDANCE' } } },
        }),
      );
      await expect(service.undo(MOVE, admin())).rejects.toMatchObject({ response: { code: 'LESSON_MOVE_HAS_ATTENDANCE' } });
    });
  });

  describe('candidates', () => {
    it('lists the lessons that overlap, the ones the pupil can go to first, and each refusal by name', async () => {
      lessons[Y] = row(Y, '09:00', '10:00', { room: { name: 'Sal 1', capacity: 1 } });
      rosters[Y] = ['p-a'];
      const cancelled = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000006';
      lessons[cancelled] = row(cancelled, '09:00', '10:00', { status: 'CANCELLED', cancelCause: 'EVENT' });
      rosters[Z] = [];

      const result = await service.candidates(X, PUPIL, admin());

      expect(result.from).toMatchObject({ id: X, subject: 'Ämne 1' });
      expect(result.candidates.map((candidate) => candidate.id)).toEqual([Y, Z, cancelled]);
      expect(result.candidates[0]).toMatchObject({ headcount: 1, roomCapacity: 1, refusal: null, warnings: [{ code: 'TARGET_ROOM_OVER_CAPACITY', headcount: 2, capacity: 1 }] });
      expect(result.candidates[2]!.refusal).toEqual({ code: 'LESSON_MOVE_REPLACED_BY_ACTIVITY', side: 'TO' });
      // W (11:00) does not overlap and is not a candidate at all.
      expect(result.candidates.some((candidate) => candidate.id === W)).toBe(false);
    });

    it('offers the lessons to a pupil who stands on a lesson a move put them on, though the first source has ended: that is a correction, and the door judges who may', async () => {
      tx['lessonPupilMove']!['findFirst']!.mockResolvedValue({ id: MOVE, fromLessonId: X });
      lessons[Y] = row(Y, '09:00', '11:00');
      rosters[Y] = [PUPIL];
      jest.setSystemTime(at('10:15'));
      const result = await service.candidates(Y, PUPIL, admin());
      expect(result.candidates.every((candidate) => candidate.refusal?.code !== 'LESSON_MOVE_LESSON_OVER')).toBe(true);
    });

    it('refuses every lesson, as the source being over, once the pupil’s lesson has ended', async () => {
      jest.setSystemTime(at('10:30'));
      const result = await service.candidates(X, PUPIL, admin());
      expect(result.candidates.length).toBeGreaterThan(0);
      expect(result.candidates.map((candidate) => candidate.refusal)).toEqual(
        result.candidates.map(() => ({ code: 'LESSON_MOVE_LESSON_OVER', side: 'FROM' })),
      );
    });

    it('marks a lesson the pupil is on already, and one that would double-book them', async () => {
      rosters[Y] = [PUPIL];
      const next = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000005';
      lessons[next] = row(next, '10:00', '11:00');
      rosters[next] = [PUPIL];
      const result = await service.candidates(X, PUPIL, admin());
      expect(result.candidates.find((candidate) => candidate.id === Y)!.refusal).toEqual({ code: 'LESSON_MOVE_ALREADY_ON_TARGET' });
      expect(result.candidates.find((candidate) => candidate.id === Z)!.refusal).toEqual({ code: 'LESSON_MOVE_PUPIL_DOUBLE_BOOKED' });
    });
  });

  describe('pupils', () => {
    it('gives an administrator and a teacher of the lesson the whole list, arrivals marked', async () => {
      tx['user']!['findMany']!.mockResolvedValue([
        { id: PUPIL, firstName: 'Alva', lastName: 'A' },
        { id: OTHER_PUPIL, firstName: 'Bo', lastName: 'B' },
      ]);
      tx['lessonPupilMove']!['findMany']!.mockResolvedValue([{ studentId: OTHER_PUPIL }]);
      const forTeacher = await service.pupils(X, teacher(TEACHER_X));
      expect(forTeacher.students.map((pupil) => [pupil.id, pupil.arrived])).toEqual([[PUPIL, false], [OTHER_PUPIL, true]]);
      expect((await service.pupils(X, admin())).students).toHaveLength(2);
    });

    it('gives a mentor who teaches nothing on the lesson only the pupils they mentor, and a stranger nothing', async () => {
      tx['$queryRaw']!.mockResolvedValue([{ id: PUPIL }]);
      tx['user']!['findMany']!.mockResolvedValue([{ id: PUPIL, firstName: 'Alva', lastName: 'A' }]);
      expect((await service.pupils(X, teacher(STRANGER))).students.map((pupil) => pupil.id)).toEqual([PUPIL]);
      tx['$queryRaw']!.mockResolvedValue([]);
      expect((await service.pupils(X, teacher(STRANGER))).students).toEqual([]);
    });
  });

  describe('forLesson', () => {
    it('names the pupils the lesson lost and gained, with where to and from', async () => {
      tx['lessonPupilMove']!['findMany']!.mockResolvedValue([
        {
          id: MOVE,
          studentId: PUPIL,
          fromLessonId: X,
          toLessonId: Y,
          movedById: ADMIN,
          createdAt: new Date('2026-11-10T07:00:00.000Z'),
          student: { firstName: 'Alva', lastName: 'A' },
          movedBy: { firstName: 'Rektor', lastName: 'R' },
          fromLesson: lessons[X],
          toLesson: lessons[Y],
        },
      ]);
      const atSource = await service.forLesson(X, admin());
      expect(atSource.arrivals).toEqual([]);
      expect(atSource.departures[0]).toMatchObject({ moveId: MOVE, studentName: 'Alva A', other: { id: Y, subject: 'Ämne 2' }, movedByName: 'Rektor R' });
      const atTarget = await service.forLesson(Y, admin());
      expect(atTarget.departures).toEqual([]);
      expect(atTarget.arrivals[0]).toMatchObject({ studentName: 'Alva A', other: { id: X } });
    });

    it('does not name a mover with a protected identity to a colleague on the lesson, and names them to an administrator and to themselves', async () => {
      tx['lessonPupilMove']!['findMany']!.mockResolvedValue([
        {
          id: MOVE,
          studentId: PUPIL,
          fromLessonId: X,
          toLessonId: Y,
          movedById: TEACHER_X,
          createdAt: new Date('2026-11-10T07:00:00.000Z'),
          student: { firstName: 'Alva', lastName: 'A' },
          movedBy: { firstName: 'Skyddad', lastName: 'Lärare' },
          fromLesson: lessons[X],
          toLesson: lessons[Y],
        },
      ]);
      // The marked staff of the school, as Skolans dag's function answers a teacher.
      tx['$queryRaw']!.mockResolvedValue([{ id: TEACHER_X }]);
      const asColleague = await service.forLesson(Y, teacher(TEACHER_Y));
      expect(asColleague.arrivals[0]!.movedByName).toBeNull();
      expect(JSON.stringify(asColleague)).not.toContain('Skyddad');
      expect((await service.forLesson(Y, admin())).arrivals[0]!.movedByName).toBe('Skyddad Lärare');
      expect((await service.forLesson(Y, teacher(TEACHER_X))).arrivals[0]!.movedByName).toBe('Skyddad Lärare');
      // A mover nobody marked is named to the colleague.
      tx['$queryRaw']!.mockResolvedValue([]);
      expect((await service.forLesson(Y, teacher(TEACHER_Y))).arrivals[0]!.movedByName).toBe('Skyddad Lärare');
    });
  });
});

describe('the answers a refusal becomes', () => {
  it('is a 409 with a code and, for a lesson-specific reason, which lesson', () => {
    const error = refusalError({ code: 'LESSON_MOVE_LESSON_NOT_HELD', side: 'FROM' });
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({ code: 'LESSON_MOVE_LESSON_NOT_HELD', params: { side: 'FROM' } });
  });

  it('turns a SQLSTATE of the door into the code and the status, and leaves any other error alone', () => {
    const state = (originalCode: string, originalMessage = '') =>
      new Prisma.PrismaClientKnownRequestError('boom', {
        code: 'P2010',
        clientVersion: 'x',
        meta: { driverAdapterError: { cause: { originalCode, originalMessage } } },
      });
    expect(doorError(state('LM403'))).toBeInstanceOf(ForbiddenException);
    expect(doorError(state('LM404'))).toBeInstanceOf(NotFoundException);
    expect(doorError(state('LM409', 'LESSON_MOVE_EXISTS: x'))).toMatchObject({ response: { code: 'LESSON_MOVE_EXISTS' } });
    const other = new Error('network');
    expect(doorError(other)).toBe(other);
    expect(doorError(state('23505'))).toMatchObject({ code: 'P2010' });
  });
});
