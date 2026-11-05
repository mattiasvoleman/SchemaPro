import { ConflictException, NotFoundException } from '@nestjs/common';
import { createPrismaMock, createTxMock, testUser, type PrismaMock, type TxMock } from '../../test/utils/prisma-mock';
import { recordedReads } from '../../test/utils/recorded-reads';
import { Role } from '../auth/enums/role.enum';
import { CalendarLessonsService } from '../calendar/calendar-lessons.service';
import type { PrismaService } from '../database/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { RealtimeService } from '../realtime/realtime.service';
import * as context from './cover-context';
import { ABOUT_THE_COLLEAGUE, COVER_REQUEST_RULE, RULE_PHRASES, TO_THE_COLLEAGUE, rulesInWords } from './cover-request-rules';
import {
  COVER_REQUEST_EXISTS,
  COVER_REQUEST_LESSON_CANCELLED,
  COVER_REQUEST_LESSON_COVERED,
  COVER_REQUEST_LESSON_STARTED,
  COVER_REQUEST_LESSON_TWICE,
  CoverRequestsService,
  myStateOf,
  type RequestLessonView,
} from './cover-requests.service';
import { toBoardRequest } from './cover-request-reads';
import { Prisma } from '@prisma/client';
import type { HardRuleCode, PersonDay } from './cover-rules';
import { CoverService } from './cover.service';

const SCHOOL = '33333333-3333-4333-8333-333333333333';
const LESSON = '44444444-4444-4444-8444-444444444444';
const LESSON_B = '45454545-4545-4545-8545-454545454545';
const ABSENCE = '55555555-5555-4555-8555-555555555555';
const REQUEST = '66666666-6666-4666-8666-666666666666';
const ABSENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ADMIN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ANNA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const BO = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ADMIN_AUTH = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const NOW = new Date('2026-10-14T06:00:00.000Z');
const START = new Date('2026-10-14T08:00:00.000Z');
const END = new Date('2026-10-14T09:00:00.000Z');

const sqlOf = (statement: unknown) => ((statement as { strings?: string[] }).strings ?? []).join('?');

/** A person's free day: nothing in the way, no cap. */
const freeDay = (userId: string, overrides: Partial<PersonDay> = {}): PersonDay => ({
  userId,
  isActiveTeacher: true,
  lessons: [],
  closures: [],
  preferredFree: [],
  bookings: [],
  absences: [],
  lunch: null,
  minDailyRestMinutes: null,
  pool: { member: false, hasEmployment: true, windows: [] },
  ...overrides,
});

describe('CoverRequestsService', () => {
  let tx: TxMock;
  let prisma: PrismaMock;
  let realtime: { notifyLessonChanged: jest.Mock; notifyLessonsChanged: jest.Mock; notifyCoverBoardChanged: jest.Mock };
  let notifications: { notifyUsers: jest.Mock; recipientsForLessons: jest.Mock };
  let cover: CoverService;
  let service: CoverRequestsService;
  let days: Map<string, PersonDay>;
  let pairRows: Record<string, unknown>[];
  let locked: Record<string, unknown> | null;
  let sender: Record<string, unknown>[];
  /** The asked colleague's own row, as the locking read of a yes finds it. */
  let mine: { answer: string }[];

  const teacher = testUser({ userId: BO, role: Role.TEACHER, schoolId: SCHOOL });
  const admin = testUser({ userId: ADMIN, role: Role.SCHOOL_ADMIN, schoolId: SCHOOL });

  const pairRow = (overrides: Record<string, unknown> = {}) => ({
    absenceId: ABSENCE,
    absentTeacherId: ABSENT,
    lessonId: LESSON,
    isLive: true,
    decisionId: null,
    decision: null,
    decidedAt: null,
    removedTeachers: [],
    date: '2026-10-14',
    startsAt: START,
    endsAt: END,
    subjectId: 'subj',
    studentGroupId: 'grp',
    roomId: null,
    lessonStatus: 'SCHEDULED',
    cancelCause: null,
    absenceStartsAt: new Date('2026-10-13T22:00:00.000Z'),
    absenceEndsAt: new Date('2026-10-14T22:00:00.000Z'),
    absenceStatus: 'ACTIVE',
    teachers: [{ teacherId: ABSENT, role: 'LEAD' }],
    extraGroupIds: [],
    coveringSubstituteIds: [],
    ...overrides,
  });

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    realtime = {
      notifyLessonChanged: jest.fn().mockResolvedValue(undefined),
      notifyLessonsChanged: jest.fn().mockResolvedValue(undefined),
      notifyCoverBoardChanged: jest.fn(),
    };
    notifications = { notifyUsers: jest.fn().mockResolvedValue(1), recipientsForLessons: jest.fn().mockResolvedValue([]) };
    const calendar = new CalendarLessonsService(
      prisma as unknown as PrismaService,
      realtime as unknown as RealtimeService,
      notifications as unknown as NotificationsService,
    );
    cover = new CoverService(
      prisma as unknown as PrismaService,
      realtime as unknown as RealtimeService,
      notifications as unknown as NotificationsService,
      calendar,
    );
    jest.spyOn(cover, 'now').mockReturnValue(NOW);
    service = new CoverRequestsService(
      prisma as unknown as PrismaService,
      cover,
      notifications as unknown as NotificationsService,
      realtime as unknown as RealtimeService,
    );

    days = new Map([
      [ANNA, freeDay(ANNA)],
      [BO, freeDay(BO)],
    ]);
    pairRows = [pairRow()];
    locked = null;
    sender = [{ userId: ADMIN, authId: ADMIN_AUTH, adminProfile: 'FULL', hrRead: false }];
    mine = [{ answer: 'PENDING' }];
    jest.spyOn(context, 'readPersonDays').mockImplementation(async () => ({
      days,
      employments: new Map(),
      poolMembers: new Set(),
    }));
    tx.school.findUnique.mockResolvedValue({ timezone: 'Europe/Stockholm' });
    tx.academicYear.findFirst.mockResolvedValue({ id: 'year' });
    tx.$queryRaw.mockImplementation(async (statement: unknown) => {
      const text = sqlOf(statement);
      if (text.includes('app.cover_request_sender')) return sender;
      if (text.includes('FROM "CoverRequests"') && text.includes('FOR UPDATE')) return locked ? [locked] : [];
      if (text.includes('FROM "CoverRequestRecipients"') && text.includes('FOR UPDATE')) return mine;
      if (text.includes('"TeacherAbsences"')) return pairRows;
      return [];
    });
    // What the notices after the commit read of the lesson.
    tx.calendarLesson.findMany.mockResolvedValue([
      { id: LESSON, date: new Date('2026-10-14T00:00:00.000Z'), startsAt: START, studentGroupId: 'grp', roomId: null, subjectId: 'subj' },
    ]);
    tx.user.findMany.mockResolvedValue([
      { id: ANNA, firstName: 'Anna', lastName: 'Svensson' },
      { id: BO, firstName: 'Bo', lastName: 'Karlsson' },
    ]);
    tx.coverRequest.create.mockResolvedValue({ id: REQUEST });
    tx.coverRequest.findUnique.mockResolvedValue(requestRow());
  });

  afterEach(() => jest.restoreAllMocks());

  const requestRow = (overrides: Record<string, unknown> = {}) => ({
    id: REQUEST,
    status: 'OPEN',
    createdAt: NOW,
    expiresAt: new Date('2026-10-14T07:00:00.000Z'),
    requestedByUserId: ADMIN,
    acceptedByUserId: null,
    lessons: [{ absenceId: ABSENCE, calendarLessonId: LESSON }],
    recipients: [
      { userId: ANNA, answer: 'PENDING', answeredAt: null },
      { userId: BO, answer: 'PENDING', answeredAt: null },
    ],
    ...overrides,
  });

  const codeOf = async (promise: Promise<unknown>) => {
    const error = await promise.then(() => null, (e: unknown) => e);
    return (error as { getResponse?: () => { code?: string } } | null)?.getResponse?.().code ?? String(error);
  };
  const bodyOf = async (promise: Promise<unknown>) => {
    const error = await promise.then(() => null, (e: unknown) => e);
    return (error as { getResponse?: () => Record<string, unknown> } | null)?.getResponse?.() ?? {};
  };

  describe('create', () => {
    const dto = (overrides: Record<string, unknown> = {}) => ({
      lessons: [{ lessonId: LESSON, absenceId: ABSENCE }],
      recipientIds: [ANNA, BO],
      ...overrides,
    });

    it('stores the request with its lessons and recipients, never past the lesson start, and tells the colleagues after the commit', async () => {
      const view = await service.create(dto({ expiresInMinutes: 600 }), admin);

      const data = tx.coverRequest.create.mock.calls[0]![0].data;
      expect(data.requestedByUserId).toBe(ADMIN);
      // 600 minutes from 06:00 would be 16:00; the lesson starts at 08:00.
      expect(data.expiresAt).toEqual(START);
      expect(data.lessons.create).toEqual([{ schoolId: SCHOOL, absenceId: ABSENCE, calendarLessonId: LESSON }]);
      expect(data.recipients.create.map((r: { userId: string }) => r.userId)).toEqual([ANNA, BO]);
      expect(view.id).toBe(REQUEST);

      const notice = notifications.notifyUsers.mock.calls.find(([, options]) => options.type === 'COVER_REQUESTED');
      expect(notice).toBeDefined();
      const options = notice![1];
      expect(options.userIds).toEqual([ANNA, BO]);
      // The lesson and the time, never who is away or why.
      expect(JSON.stringify(options.meta)).not.toContain(ABSENT);
      // How many and from when, and that the answer is in Rastra: no subject, group or room in the
      // e-mail's subject or text, nor in the inbox row's meta (a lock screen shows a subject line).
      expect(options.email.subject).toMatch(/^Vikariefråga \S/);
      expect(options.email.body).toMatch(/^Kan du vikariera en lektion från .+\? Svara i Rastra senast /);
      for (const text of [options.email.subject, options.email.body, JSON.stringify(options.meta)]) {
        expect(text).not.toMatch(/subjectName|groupName|roomName|Matematik|7A/);
      }
      expect(options.meta.lessons).toEqual([{ lessonId: LESSON, startsAt: expect.any(String) }]);
      expect(realtime.notifyCoverBoardChanged).toHaveBeenCalled();
    });

    it('defaults to an hour', async () => {
      pairRows = [pairRow({ startsAt: new Date('2026-10-14T10:00:00.000Z'), endsAt: new Date('2026-10-14T11:00:00.000Z') })];
      await service.create(dto(), admin);
      expect(tx.coverRequest.create.mock.calls[0]![0].data.expiresAt).toEqual(new Date('2026-10-14T07:00:00.000Z'));
    });

    it('refuses a lesson a schemabrytande aktivitet or an avbokning has cancelled, by name', async () => {
      pairRows = [pairRow({ lessonStatus: 'CANCELLED', cancelCause: 'EVENT' })];
      expect(await codeOf(service.create(dto(), admin))).toBe(COVER_REQUEST_LESSON_CANCELLED);
      expect(tx.coverRequest.create).not.toHaveBeenCalled();
    });

    it('refuses a lesson that already has a vikarie or is handled', async () => {
      pairRows = [pairRow({ decision: 'CO_TEACHER' })];
      expect(await codeOf(service.create(dto(), admin))).toBe(COVER_REQUEST_LESSON_COVERED);
    });

    it('refuses a lesson that starts within the minute', async () => {
      jest.spyOn(cover, 'now').mockReturnValue(new Date(START.getTime() - 30_000));
      expect(await codeOf(service.create(dto(), admin))).toBe(COVER_REQUEST_LESSON_STARTED);
    });

    it('refuses a pair the absence does not put on the board', async () => {
      pairRows = [];
      expect(await codeOf(service.create(dto(), admin))).toBe('COVER_NOT_AFFECTED');
    });

    it('does not ask the absent colleague about their own lesson, or anybody who is not an active teacher', async () => {
      tx.user.findMany.mockResolvedValue([{ id: ANNA, firstName: 'Anna', lastName: 'Svensson' }]);
      expect(await codeOf(service.create(dto({ recipientIds: [ANNA, BO] }), admin))).toBe('COVER_REQUEST_RECIPIENT_INVALID');
      tx.user.findMany.mockResolvedValue([{ id: ABSENT, firstName: 'Frånvarande', lastName: 'Lärare' }]);
      expect(await codeOf(service.create(dto({ recipientIds: [ABSENT] }), admin))).toBe('COVER_REQUEST_RECIPIENT_INVALID');
    });

    it('does not ask a colleague the hard rules of cover would not put in front of the class, and names who and why', async () => {
      days.set(BO, freeDay(BO, { dailyCapMinutes: 30 }));
      const body = await bodyOf(service.create(dto(), admin));
      expect(body['code']).toBe('COVER_REQUEST_RECIPIENT_RULE');
      expect(body['message']).toContain('Bo Karlsson');
      expect(body['message']).toContain(RULE_PHRASES.DAILY_CAP(ABOUT_THE_COLLEAGUE));
      expect(body['params']).toMatchObject({ userId: BO, lessonId: LESSON, rules: 'DAILY_CAP' });
      expect(tx.coverRequest.create).not.toHaveBeenCalled();
    });

    it('judges a colleague asked for several lessons on the day those make', async () => {
      pairRows = [
        pairRow(),
        pairRow({ lessonId: LESSON_B, startsAt: new Date('2026-10-14T09:00:00.000Z'), endsAt: new Date('2026-10-14T10:00:00.000Z') }),
      ];
      days.set(BO, freeDay(BO, { dailyCapMinutes: 90 }));
      const body = await bodyOf(
        service.create(
          dto({ lessons: [{ lessonId: LESSON, absenceId: ABSENCE }, { lessonId: LESSON_B, absenceId: ABSENCE }], recipientIds: [BO] }),
          admin,
        ),
      );
      expect(body['code']).toBe('COVER_REQUEST_RECIPIENT_RULE');
      expect(body['params']).toMatchObject({ lessonId: LESSON_B, rules: 'DAILY_CAP' });
    });

    it('refuses one question that asks for a lesson twice (two absent teachers on it): a colleague cannot be put on it twice', async () => {
      const other = '77777777-7777-4777-8777-777777777777';
      const body = await bodyOf(
        service.create(dto({ lessons: [{ lessonId: LESSON, absenceId: ABSENCE }, { lessonId: LESSON, absenceId: other }] }), admin),
      );
      expect(body['code']).toBe(COVER_REQUEST_LESSON_TWICE);
      expect(body['params']).toEqual({ lessonId: LESSON });
      expect(tx.coverRequest.create).not.toHaveBeenCalled();
    });

    it('tries the notices once more when the first transaction fails, and gives up quietly after that: the question is stored either way', async () => {
      notifications.notifyUsers.mockRejectedValueOnce(new Error('pool'));
      const view = await service.create(dto(), admin);
      expect(view.id).toBe(REQUEST);
      expect(notifications.notifyUsers.mock.calls.filter(([, options]) => options.type === 'COVER_REQUESTED')).toHaveLength(2);

      notifications.notifyUsers.mockReset().mockRejectedValue(new Error('pool'));
      await expect(service.create(dto(), admin)).resolves.toMatchObject({ id: REQUEST });
    });

    it('refuses a second open request for a lesson, whether found or raced', async () => {
      tx.coverRequestLesson.findFirst.mockResolvedValue({ requestId: REQUEST, calendarLessonId: LESSON });
      expect(await codeOf(service.create(dto(), admin))).toBe(COVER_REQUEST_EXISTS);
      tx.coverRequestLesson.findFirst.mockResolvedValue(null);
      const raced = Object.assign(new Error('unique'), { code: 'P2002' });
      Object.setPrototypeOf(raced, (await import('@prisma/client')).Prisma.PrismaClientKnownRequestError.prototype);
      tx.coverRequest.create.mockRejectedValue(raced);
      expect(await codeOf(service.create(dto(), admin))).toBe(COVER_REQUEST_EXISTS);
    });

    it('ends an expired request that stands in the way of a new one before it looks', async () => {
      await service.create(dto(), admin);
      const settle = tx.$executeRaw.mock.calls.map(([statement]) => sqlOf(statement)).find((text) => text.includes("SET \"status\" = 'EXPIRED'"));
      expect(settle).toBeDefined();
    });
  });

  describe('withdraw', () => {
    it('takes the question back and tells those who had not answered', async () => {
      locked = { id: REQUEST, schoolId: SCHOOL, status: 'OPEN', expiresAt: new Date('2026-10-14T07:00:00.000Z'), requestedByUserId: ADMIN, now: NOW };
      tx.coverRequestLesson.findMany.mockResolvedValue([{ calendarLessonId: LESSON }]);
      tx.coverRequestRecipient.findMany.mockResolvedValue([{ userId: BO }]);
      await service.withdraw(REQUEST, admin);
      expect(tx.coverRequest.update).toHaveBeenCalledWith({ where: { id: REQUEST }, data: { status: 'WITHDRAWN' } });
      const closed = notifications.notifyUsers.mock.calls.find(([, options]) => options.type === 'COVER_REQUEST_CLOSED');
      expect(closed![1].userIds).toEqual([BO]);
      expect(closed![1].meta.reason).toBe('WITHDRAWN');
    });

    it('refuses to withdraw what has ended', async () => {
      locked = { id: REQUEST, schoolId: SCHOOL, status: 'ACCEPTED', expiresAt: NOW, requestedByUserId: ADMIN, now: NOW };
      const body = await bodyOf(service.withdraw(REQUEST, admin));
      expect(body['code']).toBe('COVER_REQUEST_ENDED');
      expect(body['params']).toEqual({ current: 'ACCEPTED' });
      expect(tx.coverRequest.update).not.toHaveBeenCalled();
    });
  });

  describe('accept: the first yes', () => {
    const open = (overrides: Record<string, unknown> = {}) => ({
      id: REQUEST,
      schoolId: SCHOOL,
      status: 'OPEN',
      expiresAt: new Date('2026-10-14T07:00:00.000Z'),
      requestedByUserId: ADMIN,
      now: NOW,
      ...overrides,
    });

    beforeEach(() => {
      locked = open();
      tx.coverRequestLesson.findMany.mockResolvedValue([{ absenceId: ABSENCE, calendarLessonId: LESSON }]);
      tx.coverRequestRecipient.findMany.mockResolvedValue([{ userId: ANNA }]);
      jest.spyOn(cover, 'decideInTransaction').mockResolvedValue({
        lessonIds: [LESSON],
        dates: ['2026-10-14'],
        notices: [{ kind: 'COVER', userId: BO, lessonId: LESSON }],
        classNotices: [],
        warnings: [],
        passNotices: [],
        closedRequests: [],
      });
    });

    it('places the colleague as the administrator who sent the question, claims it first, confirms the pass and tells everybody', async () => {
      const result = await service.accept(REQUEST, teacher);
      expect(result).toEqual({ requestId: REQUEST, lessons: 1 });

      // The sender's claims: the second transaction runs as the administrator.
      const users = prisma.withRls.mock.calls.map((call) => call[0]);
      expect(users[0]).toBe(teacher);
      expect(users[1]).toMatchObject({ authId: ADMIN_AUTH, role: 'SCHOOL_ADMIN', userId: ADMIN, schoolId: SCHOOL, adminProfile: 'FULL' });

      const claim = tx.coverRequest.update.mock.calls[0]![0];
      expect(claim).toEqual({ where: { id: REQUEST }, data: { status: 'ACCEPTED', acceptedByUserId: BO } });
      expect(tx.coverRequestRecipient.update).toHaveBeenCalledWith({
        where: { requestId_userId: { requestId: REQUEST, userId: BO } },
        data: { answer: 'ACCEPTED' },
      });
      // The claim comes before the decision, so the decision finds the request ended.
      const claimOrder = tx.coverRequest.update.mock.invocationCallOrder[0]!;
      const decideOrder = (cover.decideInTransaction as jest.Mock).mock.invocationCallOrder[0]!;
      expect(claimOrder).toBeLessThan(decideOrder);
      expect(cover.decideInTransaction).toHaveBeenCalledWith(
        tx,
        { lessonId: LESSON, absenceId: ABSENCE, kind: 'SUBSTITUTE', substituteId: BO, expected: 'OPEN' },
        expect.objectContaining({ userId: ADMIN }),
      );
      expect(tx.coverConfirmation.createMany).toHaveBeenCalledWith({
        data: [{ schoolId: SCHOOL, absenceId: ABSENCE, calendarLessonId: LESSON, userId: BO }],
      });

      const types = notifications.notifyUsers.mock.calls.map(([, options]) => [options.type, options.userIds]);
      expect(types).toContainEqual(['COVER_REQUEST_ACCEPTED', [ADMIN]]);
      expect(types).toContainEqual(['COVER_REQUEST_CLOSED', [ANNA]]);
      const closed = notifications.notifyUsers.mock.calls.find(([, options]) => options.type === 'COVER_REQUEST_CLOSED');
      expect(closed![1].meta.reason).toBe('TAKEN');
    });

    it('locks the lessons, then the request row, before it reads the pairs: the board\'s order, so a decision on a lesson and a yes never meet crossways', async () => {
      await service.accept(REQUEST, teacher);
      const queries = tx.$queryRaw.mock.calls.map(([statement], index) => ({ text: sqlOf(statement), order: tx.$queryRaw.mock.invocationCallOrder[index]! }));
      const requestLock = queries.find((query) => query.text.includes('"CoverRequests"') && query.text.includes('FOR UPDATE'))!;
      const pairs = queries.find((query) => query.text.includes('"TeacherAbsences"'))!;
      const lessonLock = tx.$executeRaw.mock.calls
        .map(([statement], index) => ({ text: sqlOf(statement), order: tx.$executeRaw.mock.invocationCallOrder[index]! }))
        .find((call) => call.text.includes('"CalendarLessons"') && call.text.includes('FOR UPDATE'))!;
      expect(lessonLock.order).toBeLessThan(requestLock.order);
      expect(requestLock.order).toBeLessThan(pairs.order);
    });

    it('tells the colleague who comes second that it is taken, and writes nothing', async () => {
      locked = open({ status: 'ACCEPTED' });
      expect(await codeOf(service.accept(REQUEST, teacher))).toBe('COVER_REQUEST_TAKEN');
      expect(tx.coverRequest.update).not.toHaveBeenCalled();
      expect(cover.decideInTransaction).not.toHaveBeenCalled();
    });

    it.each(['WITHDRAWN', 'EXPIRED', 'CLOSED'])('says a %s request is gone', async (status) => {
      locked = open({ status });
      expect(await codeOf(service.accept(REQUEST, teacher))).toBe('COVER_REQUEST_GONE');
      expect(tx.coverRequest.update).not.toHaveBeenCalled();
    });

    it('says a request past its time is gone even when the nightly job has not settled it', async () => {
      locked = open({ expiresAt: new Date(NOW.getTime() - 1000) });
      expect(await codeOf(service.accept(REQUEST, teacher))).toBe('COVER_REQUEST_GONE');
    });

    it('tells the one who said yes first, asking again, that it is theirs: a lost answer or a second tap is no defeat', async () => {
      const yours = Object.assign(new Error('yours'), {
        code: 'P2010',
        clientVersion: 'test',
        meta: { driverAdapterError: { cause: { originalCode: 'CR413' } } },
      });
      Object.setPrototypeOf(yours, Prisma.PrismaClientKnownRequestError.prototype);
      tx.$queryRaw.mockImplementation(async (statement: unknown) => {
        if (sqlOf(statement).includes('app.cover_request_sender')) throw yours;
        return [];
      });
      tx.coverRequestLesson.count.mockResolvedValue(2);
      await expect(service.accept(REQUEST, teacher)).resolves.toEqual({ requestId: REQUEST, lessons: 2 });
      expect(tx.coverRequest.update).not.toHaveBeenCalled();
      expect(cover.decideInTransaction).not.toHaveBeenCalled();
    });

    it('says the sender is gone, not that the request is missing, when they are removed or lose Drift between the lookup and the write', async () => {
      locked = null;
      expect(await codeOf(service.accept(REQUEST, teacher))).toBe('COVER_REQUEST_SENDER_GONE');
      locked = open();
      const noRight = Object.assign(new Error('rls'), { code: 'P2010', clientVersion: 'test', meta: { driverAdapterError: { cause: { originalCode: '42501' } } } });
      Object.setPrototypeOf(noRight, Prisma.PrismaClientKnownRequestError.prototype);
      tx.coverRequest.update.mockRejectedValue(noRight);
      expect(await codeOf(service.accept(REQUEST, teacher))).toBe('COVER_REQUEST_SENDER_GONE');
    });

    it('says the sender is gone, not 500, when they are deactivated between the lookup and the write (the publication lock, PB403)', async () => {
      const lockNotYours = Object.assign(new Error('PUBLICATION_LOCK_NOT_YOURS'), {
        code: 'P2010',
        clientVersion: 'test',
        meta: { driverAdapterError: { cause: { originalCode: 'PB403' } } },
      });
      Object.setPrototypeOf(lockNotYours, Prisma.PrismaClientKnownRequestError.prototype);
      // The first statement of the placement is the lock, and it is what refuses.
      jest.spyOn(cover, 'write').mockRejectedValue(lockNotYours);
      expect(await codeOf(service.accept(REQUEST, teacher))).toBe('COVER_REQUEST_SENDER_GONE');
      expect(tx.coverRequest.update).not.toHaveBeenCalled();
    });

    it('says the sender is gone, not that the request has ended, when it is invisible to their claims (a role changed to teacher)', async () => {
      tx.coverRequestLesson.findMany.mockResolvedValue([]);
      expect(await codeOf(service.accept(REQUEST, teacher))).toBe('COVER_REQUEST_SENDER_GONE');
      expect(tx.coverRequest.update).not.toHaveBeenCalled();
    });

    it('reads the colleague\'s own row FOR UPDATE, after the request row: a no from the same person in the same moment is waited for', async () => {
      await service.accept(REQUEST, teacher);
      const queries = tx.$queryRaw.mock.calls.map(([statement], index) => ({ text: sqlOf(statement), order: tx.$queryRaw.mock.invocationCallOrder[index]! }));
      const requestLock = queries.find((query) => query.text.includes('FROM "CoverRequests"') && query.text.includes('FOR UPDATE'))!;
      const ownRow = queries.find((query) => query.text.includes('FROM "CoverRequestRecipients"') && query.text.includes('FOR UPDATE'))!;
      expect(ownRow).toBeDefined();
      expect(requestLock.order).toBeLessThan(ownRow.order);
    });

    it('refuses a colleague who has answered, and one who was never asked', async () => {
      mine = [{ answer: 'DECLINED' }];
      expect(await codeOf(service.accept(REQUEST, teacher))).toBe('COVER_REQUEST_ANSWERED');
      mine = [];
      expect(await codeOf(service.accept(REQUEST, teacher))).toBe('COVER_REQUEST_NOT_FOUND');
    });

    it('refuses when the sender can no longer place anybody', async () => {
      sender = [];
      expect(await codeOf(service.accept(REQUEST, teacher))).toBe('COVER_REQUEST_SENDER_GONE');
      sender = [{ userId: ADMIN, authId: ADMIN_AUTH, adminProfile: 'FULL', hrRead: false }];
      locked = open({ requestedByUserId: null });
      expect(await codeOf(service.accept(REQUEST, teacher))).toBe('COVER_REQUEST_SENDER_GONE');
    });

    it('refuses a lesson that was cancelled or handled since the question was asked', async () => {
      pairRows = [pairRow({ lessonStatus: 'CANCELLED', cancelCause: 'EVENT' })];
      expect(await codeOf(service.accept(REQUEST, teacher))).toBe(COVER_REQUEST_LESSON_CANCELLED);
      pairRows = [pairRow({ decision: 'SUPERVISED_STUDY' })];
      expect(await codeOf(service.accept(REQUEST, teacher))).toBe(COVER_REQUEST_LESSON_COVERED);
      expect(tx.coverRequest.update).not.toHaveBeenCalled();
    });

    it('refuses a yes that breaks the daily cap, by name, and leaves the question open for the next colleague', async () => {
      days.set(BO, freeDay(BO, { dailyCapMinutes: 30 }));
      const body = await bodyOf(service.accept(REQUEST, teacher));
      expect(body['code']).toBe(COVER_REQUEST_RULE);
      expect(body['message']).toContain(RULE_PHRASES.DAILY_CAP(TO_THE_COLLEAGUE));
      expect(body['params']).toMatchObject({ lessonId: LESSON, rules: 'DAILY_CAP' });
      expect(tx.coverRequest.update).not.toHaveBeenCalled();
      expect(cover.decideInTransaction).not.toHaveBeenCalled();
    });

    it('refuses a yes from a colleague with another lesson at the time', async () => {
      days.set(
        BO,
        freeDay(BO, {
          lessons: [
            { id: 'other', date: '2026-10-14', start: START.getTime(), end: END.getTime(), status: 'SCHEDULED', studentGroupId: 'g', subjectId: 's' },
          ],
        }),
      );
      const body = await bodyOf(service.accept(REQUEST, teacher));
      expect(body['code']).toBe(COVER_REQUEST_RULE);
      expect(body['params']).toMatchObject({ rules: 'BUSY_LESSON' });
    });

    it('turns a decision that went stale underneath into "already handled", naming the lesson', async () => {
      (cover.decideInTransaction as jest.Mock).mockRejectedValue(
        new ConflictException({ message: 'stale', code: 'COVER_STALE', params: { current: 'COVERED' } }),
      );
      const body = await bodyOf(service.accept(REQUEST, teacher));
      expect(body['code']).toBe(COVER_REQUEST_LESSON_COVERED);
      expect(body['params']).toMatchObject({ lessonId: LESSON });
    });

    it('does not tell anybody when the write is refused', async () => {
      (cover.decideInTransaction as jest.Mock).mockRejectedValue(new NotFoundException('gone'));
      await service.accept(REQUEST, teacher).catch(() => undefined);
      expect(notifications.notifyUsers).not.toHaveBeenCalled();
    });
  });

  describe('decline and confirm', () => {
    it('declines for the colleague alone, while the answer is open', async () => {
      tx.coverRequestRecipient.updateMany.mockResolvedValue({ count: 1 });
      await service.decline(REQUEST, teacher);
      expect(tx.coverRequestRecipient.updateMany).toHaveBeenCalledWith({
        where: { requestId: REQUEST, userId: BO, answer: 'PENDING' },
        data: { answer: 'DECLINED' },
      });
    });

    it('tells a second no and a question that was never theirs apart', async () => {
      tx.coverRequestRecipient.updateMany.mockResolvedValue({ count: 0 });
      tx.coverRequestRecipient.findFirst.mockResolvedValue({ answer: 'DECLINED' });
      expect(await codeOf(service.decline(REQUEST, teacher))).toBe('COVER_REQUEST_ANSWERED');
      tx.coverRequestRecipient.findFirst.mockResolvedValue(null);
      expect(await codeOf(service.decline(REQUEST, teacher))).toBe('COVER_REQUEST_NOT_FOUND');
    });

    it('confirms through the database function and says so to the board', async () => {
      tx.$queryRaw.mockResolvedValue([{ n: 1 }]);
      tx.calendarLesson.findUnique.mockResolvedValue({ date: new Date('2026-10-14T00:00:00.000Z') });
      const result = await service.confirm(LESSON, teacher);
      expect(result).toEqual({ lessonId: LESSON, confirmed: 1 });
      expect(sqlOf(tx.$queryRaw.mock.calls[0]![0])).toContain('app.cover_confirm(');
      expect(realtime.notifyCoverBoardChanged).toHaveBeenCalledWith(SCHOOL, '2026-10-14', '2026-10-14');
    });
  });

  describe('settle: the job\'s pass', () => {
    const SENDER_ROW = { senderId: ADMIN, senderAuthId: ADMIN_AUTH, senderProfile: 'FULL', senderHrRead: false };
    const settled = (rows: Record<string, unknown>[]) =>
      tx.$queryRaw.mockImplementation(async (statement: unknown) => {
        const text = sqlOf(statement);
        if (text.includes('app.cover_requests_settle')) return rows;
        return [];
      });

    beforeEach(() => {
      tx.coverRequestLesson.findMany.mockResolvedValue([{ calendarLessonId: LESSON }]);
      tx.coverRequestRecipient.findMany.mockResolvedValue([{ userId: ANNA }]);
    });

    it('does nothing and tells nobody when no request is due', async () => {
      settled([]);
      expect(await service.settle()).toEqual({ expired: 0, notNeeded: 0 });
      expect(notifications.notifyUsers).not.toHaveBeenCalled();
    });

    it('tells the sender, as the sender, that nobody said yes in time: type CLOSED, reason UNANSWERED, no lesson named', async () => {
      settled([{ requestId: REQUEST, schoolId: SCHOOL, outcome: 'EXPIRED', ...SENDER_ROW }]);
      expect(await service.settle()).toEqual({ expired: 1, notNeeded: 0 });

      expect(prisma.withRls.mock.calls[0]![0]).toMatchObject({ authId: ADMIN_AUTH, role: 'SCHOOL_ADMIN', userId: ADMIN, schoolId: SCHOOL, adminProfile: 'FULL' });
      const [, options] = notifications.notifyUsers.mock.calls[0]!;
      expect(options).toMatchObject({ type: 'COVER_REQUEST_CLOSED', userIds: [ADMIN], schoolId: SCHOOL });
      expect(options.meta).toMatchObject({ requestId: REQUEST, reason: 'UNANSWERED', lessonCount: 1 });
      for (const text of [options.email.subject, options.email.body, JSON.stringify(options.meta)]) {
        expect(text).not.toMatch(/subjectName|groupName|roomName|Matematik|7A/);
      }
      expect(options.email.subject).toMatch(/^Ingen har tackat ja /);
      // The pending colleagues are not told a thing about a question that merely ran out.
      expect(tx.coverRequestRecipient.findMany).not.toHaveBeenCalled();
    });

    it('tells the colleagues the question still waited on, and only them, that it is no longer needed', async () => {
      settled([{ requestId: REQUEST, schoolId: SCHOOL, outcome: 'NOT_NEEDED', ...SENDER_ROW }]);
      expect(await service.settle()).toEqual({ expired: 0, notNeeded: 1 });

      expect(tx.coverRequestRecipient.findMany).toHaveBeenCalledWith({
        where: { requestId: REQUEST, answer: 'PENDING' },
        select: { userId: true },
      });
      const [, options] = notifications.notifyUsers.mock.calls[0]!;
      expect(options).toMatchObject({ type: 'COVER_REQUEST_CLOSED', userIds: [ANNA] });
      expect(options.meta.reason).toBe('NOT_NEEDED');
      expect(options.email.subject).toMatch(/^Vikariefrågan behövs inte längre /);
      expect(options.email.body).toContain('Du behöver inte svara');
      expect(realtime.notifyCoverBoardChanged).toHaveBeenCalled();
    });

    it('ends the request and logs, without telling anybody, when the sender can no longer place a vikarie', async () => {
      settled([{ requestId: REQUEST, schoolId: SCHOOL, outcome: 'NOT_NEEDED', senderId: null, senderAuthId: null, senderProfile: null, senderHrRead: null }]);
      expect(await service.settle()).toEqual({ expired: 0, notNeeded: 1 });
      expect(notifications.notifyUsers).not.toHaveBeenCalled();
    });

    it('goes on with the next request when the notices of one fail twice', async () => {
      settled([
        { requestId: REQUEST, schoolId: SCHOOL, outcome: 'EXPIRED', ...SENDER_ROW },
        { requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', schoolId: SCHOOL, outcome: 'EXPIRED', ...SENDER_ROW },
      ]);
      notifications.notifyUsers.mockRejectedValueOnce(new Error('pool')).mockRejectedValueOnce(new Error('pool')).mockResolvedValue(1);
      expect(await service.settle()).toEqual({ expired: 2, notNeeded: 0 });
      expect(notifications.notifyUsers).toHaveBeenCalledTimes(3);
    });
  });

  describe('fairness', () => {
    it('counts each colleague\'s received, yes, no and unanswered, and records the read', async () => {
      tx.coverRequestRecipient.groupBy
        .mockResolvedValueOnce([
          { userId: ANNA, answer: 'ACCEPTED', _count: { _all: 2 } },
          { userId: ANNA, answer: 'DECLINED', _count: { _all: 1 } },
          { userId: ANNA, answer: 'PENDING', _count: { _all: 4 } },
          { userId: BO, answer: 'PENDING', _count: { _all: 3 } },
        ])
        // Of the pending ones, the questions that can still be answered.
        .mockResolvedValueOnce([
          { userId: ANNA, _count: { _all: 1 } },
          { userId: BO, _count: { _all: 3 } },
        ]);
      const result = await service.fairness('2026-09-01', '2026-09-30', admin);
      // A question still open is received, and neither yes nor no nor left unanswered yet.
      expect(result.rows).toEqual([
        { userId: ANNA, received: 7, accepted: 2, declined: 1, unanswered: 3 },
        { userId: BO, received: 3, accepted: 0, declined: 0, unanswered: 0 },
      ]);
      expect(tx.coverRequestRecipient.groupBy.mock.calls[1]![0]).toMatchObject({
        by: ['userId'],
        where: { answer: 'PENDING', request: { status: 'OPEN' } },
      });
      // Work behaviour of named people, read as the cover counter is.
      expect(recordedReads(tx).map((read) => [read.kind, read.ids])).toEqual([['EMPLOYMENT', [ANNA, BO]]]);
    });

    it('refuses a period longer than a year, and one that ends before it starts', async () => {
      expect(await codeOf(service.fairness('2025-01-01', '2026-12-31', admin))).toBe('COVER_RANGE');
      expect(await codeOf(service.fairness('2026-09-30', '2026-09-01', admin))).toBe('COVER_RANGE');
    });
  });
});

describe('what a colleague sees of a request', () => {
  const lesson = (overrides: Partial<RequestLessonView> = {}): RequestLessonView => ({
    lessonId: LESSON,
    date: '2026-10-14',
    startsAt: START.toISOString(),
    endsAt: END.toISOString(),
    subjectName: 'Matematik',
    groupName: '7A',
    roomName: null,
    cancelled: false,
    ...overrides,
  });
  const row = (overrides: Record<string, unknown> = {}) => ({
    status: 'OPEN' as const,
    expiresAt: new Date(NOW.getTime() + 3_600_000),
    acceptedByUserId: null as string | null,
    recipients: [{ answer: 'PENDING' as const }],
    lessons: [{}],
    ...overrides,
  });

  it('is answerable only while it is open, in time, with every lesson held', () => {
    expect(myStateOf(row(), BO, NOW, [lesson()])).toBe('OPEN');
    expect(myStateOf(row({ expiresAt: new Date(NOW.getTime() - 1) }), BO, NOW, [lesson()])).toBe('EXPIRED');
    expect(myStateOf(row(), BO, NOW, [lesson({ cancelled: true })])).toBe('CLOSED');
    expect(myStateOf(row(), BO, NOW, [])).toBe('CLOSED');
  });

  it('says who got it from the colleague\'s side', () => {
    expect(myStateOf(row({ status: 'ACCEPTED', acceptedByUserId: BO }), BO, NOW, [lesson()])).toBe('ACCEPTED_BY_ME');
    expect(myStateOf(row({ status: 'ACCEPTED', acceptedByUserId: ANNA }), BO, NOW, [lesson()])).toBe('TAKEN');
    expect(myStateOf(row({ status: 'ACCEPTED', acceptedByUserId: null }), BO, NOW, [lesson()])).toBe('TAKEN');
    expect(myStateOf(row({ recipients: [{ answer: 'DECLINED' }] }), BO, NOW, [lesson()])).toBe('DECLINED_BY_ME');
    expect(myStateOf(row({ status: 'WITHDRAWN' }), BO, NOW, [lesson()])).toBe('WITHDRAWN');
  });

  it('reads an open request past its time as expired on the board too', () => {
    const board = toBoardRequest(
      {
        id: REQUEST,
        status: 'OPEN',
        createdAt: NOW,
        expiresAt: new Date(NOW.getTime() - 1),
        requestedByUserId: ADMIN,
        acceptedByUserId: null,
        lessons: [{ absenceId: ABSENCE, calendarLessonId: LESSON }],
        recipients: [{ userId: ANNA, answer: 'PENDING', answeredAt: null }],
      },
      NOW,
    );
    expect(board.status).toBe('EXPIRED');
    expect(board.pairs).toEqual([{ absenceId: ABSENCE, lessonId: LESSON }]);
  });
});

describe('the rules in words', () => {
  const finding = (code: HardRuleCode) => ({ code, params: {} });

  it('joins them as a sentence and has a phrase for every hard rule', () => {
    const them = ABOUT_THE_COLLEAGUE;
    expect(rulesInWords([finding('BUSY_LESSON')], them)).toBe(RULE_PHRASES.BUSY_LESSON(them));
    expect(rulesInWords([finding('BUSY_LESSON'), finding('DAILY_CAP'), finding('LUNCH')], them)).toBe(
      `${RULE_PHRASES.BUSY_LESSON(them)}, ${RULE_PHRASES.DAILY_CAP(them)} och ${RULE_PHRASES.LUNCH(them)}`,
    );
    for (const voice of [TO_THE_COLLEAGUE, ABOUT_THE_COLLEAGUE]) {
      expect(Object.values(RULE_PHRASES).every((phrase) => phrase(voice).length > 0)).toBe(true);
    }
  });

  it('speaks to the colleague as "du" and about them as "hen", in the order of a subordinate clause', () => {
    // "eftersom du …" and "…, som …": the negation and "redan" stand before the verb,
    // and no plural "de" or main-clause "skulle inte" is left over from the other voice.
    const all = Object.keys(RULE_PHRASES) as HardRuleCode[];
    const you = all.map((code) => RULE_PHRASES[code](TO_THE_COLLEAGUE)).join(' | ');
    const they = all.map((code) => RULE_PHRASES[code](ABOUT_THE_COLLEAGUE)).join(' | ');
    expect(you).toContain('att du inte kan då');
    expect(you).toContain('inte skulle få din lunch');
    expect(you).toContain('inte har angett att du kan arbeta då');
    expect(they).toContain('att hen inte kan då');
    expect(they).toContain('inte skulle få sin lunch');
    expect(they).toContain('inte har angett att hen kan arbeta då');
    for (const text of [you, they]) {
      expect(text).toContain('redan undervisar på lektionen');
      expect(text).toContain('inte är en aktiv lärare');
      expect(text).not.toMatch(/\bde\b/);
      expect(text).not.toContain('skulle inte');
      expect(text).not.toContain('undervisar redan');
      expect(text).not.toContain('är inte en');
    }
  });
});
