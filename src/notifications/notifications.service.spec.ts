import type { Logger } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { NotificationDeliveryService } from './notification-delivery.service';
import { NotificationsService } from './notifications.service';

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * `NotificationsService` deliberately takes the caller's transaction client so
 * rows are written inside the caller's RLS transaction — there is no wrapper
 * choice to assert here; instead we assert every query goes through the given
 * `tx` and carries the caller's schoolId, and that nothing leaves the process
 * before the transaction has committed.
 */
describe('NotificationsService', () => {
  let service: NotificationsService;
  let delivery: NotificationDeliveryService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let tx: TxMock;
  let fetchMock: jest.Mock;

  const globalWithFetch = globalThis as { fetch?: unknown };
  const realFetch = globalWithFetch.fetch;

  const ENV_KEYS = ['RESEND_API_KEY', 'EMAIL_FROM'] as const;
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> =
    {};

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    delivery = new NotificationDeliveryService(prisma as unknown as PrismaService);
    // No pause between mails here, but in the test of the pause itself.
    delivery.emailIntervalMs = 0;
    service = new NotificationsService(prisma as unknown as PrismaService, delivery);
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    globalWithFetch.fetch = fetchMock;
  });

  afterEach(() => {
    globalWithFetch.fetch = realFetch;
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    jest.restoreAllMocks();
  });

  const client = () => tx as unknown as PrismaClient;
  /** notifyUsers inside a withRls transaction, as every caller makes it. */
  const inTransaction = <T>(fn: (c: PrismaClient) => Promise<T>) => prisma.withRls(testUser(), fn) as Promise<T>;

  /** The after-commit hook runs on a later turn; then the queue drains. */
  const flushDelivery = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await delivery.idle();
  };

  const loggerOf = (s: object): Logger => (s as unknown as { logger: Logger }).logger;

  describe('notifyUsers', () => {
    it('writes one row per recipient with an id it made, the caller schoolId, and returns the count', async () => {
      const meta = { reason: 'sick' };

      await expect(
        service.notifyUsers(client(), {
          schoolId: SCHOOL_ID,
          userIds: ['user-1', 'user-2'],
          type: 'LEAVE_DECIDED',
          meta,
        }),
      ).resolves.toBe(2);

      expect(tx.notification.createMany).toHaveBeenCalledWith({
        data: [
          { id: expect.stringMatching(UUID), schoolId: SCHOOL_ID, userId: 'user-1', type: 'LEAVE_DECIDED', meta },
          { id: expect.stringMatching(UUID), schoolId: SCHOOL_ID, userId: 'user-2', type: 'LEAVE_DECIDED', meta },
        ],
      });
      const { data } = tx.notification.createMany.mock.calls[0][0] as { data: Array<{ id: string }> };
      expect(new Set(data.map((row) => row.id)).size).toBe(2);
    });

    it('never reads the rows back: a teacher may insert a guardian’s notice but not select it', async () => {
      process.env.RESEND_API_KEY = 'resend-key';
      tx.user.findMany.mockResolvedValue([{ id: 'user-1', email: 'anna@school.se' }]);
      await inTransaction((c) =>
        service.notifyUsers(c, { schoolId: SCHOOL_ID, userIds: ['user-1'], type: 'ABSENCE_UNREPORTED', meta: {}, email: { subject: 'S', body: 'B' } }),
      );
      await flushDelivery();
      expect(tx.notification.createManyAndReturn).not.toHaveBeenCalled();
      expect(tx.notification.findMany).not.toHaveBeenCalled();
      expect(tx.notification.create).not.toHaveBeenCalled();
    });

    it('dedupes recipients before writing', async () => {
      await expect(
        service.notifyUsers(client(), {
          schoolId: SCHOOL_ID,
          userIds: ['user-1', 'user-2', 'user-1'],
          type: 'LESSON_CANCELLED',
          meta: {},
        }),
      ).resolves.toBe(2);

      const { data } = tx.notification.createMany.mock.calls[0][0] as {
        data: Array<{ userId: string }>;
      };
      expect(data.map((row) => row.userId)).toEqual(['user-1', 'user-2']);
    });

    it('writes every recipient past 500, in statements of 500, and never cuts one off', async () => {
      const userIds = Array.from({ length: 1203 }, (_, i) => `user-${i}`);

      await expect(
        service.notifyUsers(client(), {
          schoolId: SCHOOL_ID,
          userIds,
          type: 'SCHEDULE_CHANGED',
          meta: {},
        }),
      ).resolves.toBe(1203);

      const written = tx.notification.createMany.mock.calls.map(
        (call) => (call[0] as { data: Array<{ userId: string }> }).data.map((row) => row.userId),
      );
      expect(written.map((chunk) => chunk.length)).toEqual([500, 500, 203]);
      expect(written.flat()).toEqual(userIds);
    });

    it('resolves addresses and queues the outbox per chunk, and mails all 1,203 in mails of 50', async () => {
      process.env.RESEND_API_KEY = 'resend-key';
      process.env.EMAIL_FROM = 'SchemaPro <noreply@schemapro.test>';
      delivery.emailIntervalMs = 0;
      const userIds = Array.from({ length: 1203 }, (_, i) => `user-${i}`);
      tx.user.findMany.mockImplementation(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(where.id.in.map((id) => ({ id, email: `${id}@school.se` }))),
      );

      await inTransaction((c) =>
        service.notifyUsers(c, {
          schoolId: SCHOOL_ID,
          userIds,
          type: 'CANCELLATION_DIGEST',
          meta: {},
          email: { subject: 'Inställda lektioner: Prao', body: 'x' },
        }),
      );
      expect(tx.user.findMany.mock.calls.map((call) => (call[0] as { where: { id: { in: string[] } } }).where.id.in.length)).toEqual([
        500, 500, 203,
      ]);
      expect(prisma.onCommit).toHaveBeenCalledTimes(1);

      await flushDelivery();
      const mails = fetchMock.mock.calls.map((call) => JSON.parse((call[1] as { body: string }).body) as { to: string[]; bcc: string[] });
      // 49 on BCC beside the sender's own `to`: 50 per mail, the provider's documented cap.
      expect(mails.every((mail) => mail.to.length + mail.bcc.length <= 50)).toBe(true);
      expect(mails).toHaveLength(Math.ceil(500 / 49) * 2 + Math.ceil(203 / 49));
      expect(mails.flatMap((mail) => mail.bcc)).toEqual(userIds.map((id) => `${id}@school.se`));
    });

    it('waits between two mails for the provider’s rate', async () => {
      process.env.RESEND_API_KEY = 'resend-key';
      delivery.emailIntervalMs = 40;
      tx.user.findMany.mockImplementation(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(where.id.in.map((id) => ({ id, email: `${id}@school.se` }))),
      );
      const sentAt: number[] = [];
      fetchMock.mockImplementation(() => {
        sentAt.push(Date.now());
        return Promise.resolve({ ok: true, status: 200 });
      });

      await inTransaction((c) =>
        service.notifyUsers(c, {
          schoolId: SCHOOL_ID,
          userIds: Array.from({ length: 120 }, (_, i) => `user-${i}`),
          type: 'LESSON_CANCELLED',
          meta: {},
          email: { subject: 'S', body: 'B' },
        }),
      );
      await flushDelivery();
      expect(sentAt).toHaveLength(3);
      // The service waits from the instant it records before each fetch; this
      // mock reads the clock again inside fetch, so each gap carries a
      // millisecond of rounding at either end and any pause in between (38 ms
      // on a loaded CI runner). Without the wait the gaps are about 0 ms, so 30
      // still tells the two apart.
      for (let i = 1; i < sentAt.length; i++) expect(sentAt[i]! - sentAt[i - 1]!).toBeGreaterThanOrEqual(30);
    });

    it('writes nothing and returns 0 for an empty recipient list', async () => {
      await expect(
        service.notifyUsers(client(), {
          schoolId: SCHOOL_ID,
          userIds: [],
          type: 'ABSENCE_UNREPORTED',
          meta: {},
        }),
      ).resolves.toBe(0);

      expect(tx.notification.createMany).not.toHaveBeenCalled();
    });

    it('skips email entirely when RESEND_API_KEY is not set: no address read, no hook', async () => {
      await inTransaction((c) =>
        service.notifyUsers(c, {
          schoolId: SCHOOL_ID,
          userIds: ['user-1'],
          type: 'LEAVE_DECIDED',
          meta: {},
          email: { subject: 'Hello', body: 'World' },
        }),
      );
      await flushDelivery();

      expect(tx.user.findMany).not.toHaveBeenCalled();
      expect(prisma.onCommit).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('skips email when no email payload is given, even with a key configured', async () => {
      process.env.RESEND_API_KEY = 'resend-key';

      await inTransaction((c) =>
        service.notifyUsers(c, {
          schoolId: SCHOOL_ID,
          userIds: ['user-1'],
          type: 'LEAVE_DECIDED',
          meta: {},
        }),
      );
      await flushDelivery();

      expect(tx.user.findMany).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('mirrors to email after the commit: resolves active recipients in-tx and BCCs their addresses', async () => {
      const warn = jest.spyOn(loggerOf(delivery), 'warn').mockImplementation(() => undefined);
      process.env.RESEND_API_KEY = 'resend-key';
      process.env.EMAIL_FROM = 'SchemaPro <noreply@schemapro.test>';
      tx.user.findMany.mockResolvedValue([
        { id: 'user-1', email: 'anna@school.se' },
        { id: 'user-2', email: '' }, // no address on file — must be filtered out
        { id: 'user-3', email: 'bjorn@school.se' },
      ]);

      await expect(
        inTransaction(async (c) => {
          const count = await service.notifyUsers(c, {
            schoolId: SCHOOL_ID,
            userIds: ['user-1', 'user-2', 'user-3'],
            type: 'LEAVE_DECIDED',
            meta: {},
            email: { subject: 'Decided', body: 'Your leave was approved.' },
          });
          // Still inside the transaction: nothing has left the process.
          await new Promise((resolve) => setImmediate(resolve));
          expect(fetchMock).not.toHaveBeenCalled();
          return count;
        }),
      ).resolves.toBe(3);

      // Address resolution stays inside the caller's RLS transaction and only
      // targets active users among the recipients.
      expect(tx.user.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['user-1', 'user-2', 'user-3'] }, isActive: true },
        select: { id: true, email: true },
      });

      await flushDelivery();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [
        string,
        { method: string; headers: Record<string, string>; body: string },
      ];
      expect(url).toBe('https://api.resend.com/emails');
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe('Bearer resend-key');
      // Resend reads the body as JSON only when told it is.
      expect(init.headers['Content-Type']).toBe('application/json');
      expect(JSON.parse(init.body)).toEqual({
        from: 'SchemaPro <noreply@schemapro.test>',
        // Recipients go on BCC so they never see each other; `to` is the sender.
        to: ['noreply@schemapro.test'],
        bcc: ['anna@school.se', 'bjorn@school.se'],
        subject: 'Decided',
        text: 'Your leave was approved.',
      });
      // A delivered mail is not a failed dispatch.
      expect(warn).not.toHaveBeenCalled();
    });

    it('tells nobody when the transaction rolls back after the notice', async () => {
      process.env.RESEND_API_KEY = 'resend-key';
      tx.user.findMany.mockResolvedValue([{ id: 'user-1', email: 'anna@school.se' }]);
      await expect(
        inTransaction(async (c) => {
          await service.notifyUsers(c, { schoolId: SCHOOL_ID, userIds: ['user-1'], type: 'LEAVE_DECIDED', meta: {}, email: { subject: 'S', body: 'B' } });
          throw new Error('refused after the notice');
        }),
      ).rejects.toThrow('refused after the notice');
      await flushDelivery();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('registers one hook per transaction, and mails once per notifyUsers call', async () => {
      process.env.RESEND_API_KEY = 'resend-key';
      tx.user.findMany.mockResolvedValue([{ id: 'user-1', email: 'anna@school.se' }]);
      await inTransaction(async (c) => {
        for (const subject of ['A', 'B', 'C']) {
          await service.notifyUsers(c, { schoolId: SCHOOL_ID, userIds: ['user-1'], type: 'LESSON_CANCELLED', meta: {}, email: { subject, body: 'x' } });
        }
      });
      expect(prisma.onCommit).toHaveBeenCalledTimes(1);
      await flushDelivery();
      expect(fetchMock.mock.calls.map((call) => JSON.parse((call[1] as { body: string }).body).subject)).toEqual(['A', 'B', 'C']);
    });

    it('delivers nothing, and says so, outside a withRls transaction', async () => {
      process.env.RESEND_API_KEY = 'resend-key';
      tx.user.findMany.mockResolvedValue([{ id: 'user-1', email: 'anna@school.se' }]);
      const warn = jest.spyOn(loggerOf(service), 'warn').mockImplementation(() => undefined);
      await expect(
        service.notifyUsers(client(), { schoolId: SCHOOL_ID, userIds: ['user-1'], type: 'LEAVE_DECIDED', meta: {}, email: { subject: 'S', body: 'B' } }),
      ).resolves.toBe(1);
      await flushDelivery();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith('Notice not delivered: no transaction to wait for [type=LEAVE_DECIDED]');
      // The in-app row is still written.
      expect(tx.notification.createMany).toHaveBeenCalledTimes(1);
    });

    it('falls back to the default sender when EMAIL_FROM is unset', async () => {
      process.env.RESEND_API_KEY = 'resend-key';
      tx.user.findMany.mockResolvedValue([{ id: 'user-1', email: 'anna@school.se' }]);

      await inTransaction((c) =>
        service.notifyUsers(c, {
          schoolId: SCHOOL_ID,
          userIds: ['user-1'],
          type: 'LEAVE_DECIDED',
          meta: {},
          email: { subject: 'S', body: 'B' },
        }),
      );
      await flushDelivery();

      const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
      expect(JSON.parse(init.body)).toMatchObject({
        from: 'SchemaPro <noreply@schemapro.app>',
        to: ['noreply@schemapro.app'],
      });
    });

    it('sends no email when no active recipient has an address', async () => {
      process.env.RESEND_API_KEY = 'resend-key';
      tx.user.findMany.mockResolvedValue([]);

      await expect(
        inTransaction((c) =>
          service.notifyUsers(c, {
            schoolId: SCHOOL_ID,
            userIds: ['user-1'],
            type: 'LEAVE_DECIDED',
            meta: {},
            email: { subject: 'S', body: 'B' },
          }),
        ),
      ).resolves.toBe(1);

      await flushDelivery();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('never fails the mutation when the email API rejects (network)', async () => {
      process.env.RESEND_API_KEY = 'resend-key';
      tx.user.findMany.mockResolvedValue([{ id: 'user-1', email: 'anna@school.se' }]);
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
      const warn = jest.spyOn(loggerOf(delivery), 'warn').mockImplementation(() => undefined);

      await expect(
        inTransaction((c) =>
          service.notifyUsers(c, {
            schoolId: SCHOOL_ID,
            userIds: ['user-1'],
            type: 'LEAVE_DECIDED',
            meta: {},
            email: { subject: 'S', body: 'B' },
          }),
        ),
      ).resolves.toBe(1);

      await flushDelivery();
      expect(warn).toHaveBeenCalledWith('Email dispatch failed [network]');
    });

    it('logs a non-2xx dispatch without surfacing it', async () => {
      process.env.RESEND_API_KEY = 'resend-key';
      tx.user.findMany.mockResolvedValue([{ id: 'user-1', email: 'anna@school.se' }]);
      fetchMock.mockResolvedValue({ ok: false, status: 429 });
      const warn = jest.spyOn(loggerOf(delivery), 'warn').mockImplementation(() => undefined);

      await expect(
        inTransaction((c) =>
          service.notifyUsers(c, {
            schoolId: SCHOOL_ID,
            userIds: ['user-1'],
            type: 'LEAVE_DECIDED',
            meta: {},
            email: { subject: 'S', body: 'B' },
          }),
        ),
      ).resolves.toBe(1);

      await flushDelivery();
      expect(warn).toHaveBeenCalledWith('Email dispatch failed [status=429]');
    });
  });

  describe('deliver', () => {
    // The database writes the LEAVE_REQUESTED notices to the mentors itself
    // (20261023091000: the LeaveRequests_tell_mentors trigger and
    // app.leave_requests_tell_new_mentors); deliver hands them on.
    const entry = (overrides: Record<string, unknown> = {}) => ({
      schoolId: SCHOOL_ID,
      type: 'LEAVE_REQUESTED' as const,
      meta: { startDate: '2027-02-15', endDate: '2027-02-16', schoolDays: 2 },
      recipients: [
        { userId: 'mentor-1', notificationId: 'n-1' },
        { userId: 'mentor-2', notificationId: 'n-2' },
      ],
      email: { subject: 'Ny ledighetsansökan', body: 'x', recipients: [{ userId: 'mentor-1', email: 'mentor-1@school.se' }] },
      ...overrides,
    });

    it('mails the notices another writer made, after the commit, and writes no row of its own', async () => {
      process.env.RESEND_API_KEY = 'resend-key';
      process.env.EMAIL_FROM = 'SchemaPro <noreply@schemapro.test>';

      await inTransaction(async (c) => service.deliver(c, entry()));

      expect(tx.notification.createMany).not.toHaveBeenCalled();
      expect(prisma.onCommit).toHaveBeenCalledTimes(1);
      expect(fetchMock).not.toHaveBeenCalled();
      await flushDelivery();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const mail = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as { bcc: string[]; subject: string };
      expect(mail.bcc).toEqual(['mentor-1@school.se']);
      expect(mail.subject).toBe('Ny ledighetsansökan');
    });

    it('queues nothing when neither e-mail nor push is configured, and nothing for no recipient', async () => {
      await inTransaction(async (c) => service.deliver(c, entry()));
      process.env.RESEND_API_KEY = 'resend-key';
      await inTransaction(async (c) => service.deliver(c, entry({ recipients: [] })));

      expect(prisma.onCommit).not.toHaveBeenCalled();
      await flushDelivery();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('delivers nothing outside a withRls transaction, and says so', async () => {
      process.env.RESEND_API_KEY = 'resend-key';
      const warn = jest.spyOn(loggerOf(service), 'warn').mockImplementation(() => undefined);

      service.deliver(client(), entry());

      await flushDelivery();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('type=LEAVE_REQUESTED'));
    });

    describe('deliverCommitted', () => {
      // The sync's and an integration key's leave catch-up (20261101090000):
      // their transaction has no outbox, so the caller hands the notices over
      // once it has resolved.
      it('mails the notices of a committed transaction it is handed, as one batch, without any transaction', async () => {
        process.env.RESEND_API_KEY = 'resend-key';
        process.env.EMAIL_FROM = 'SchemaPro <noreply@schemapro.test>';

        service.deliverCommitted([entry(), entry({ recipients: [] })]);

        expect(prisma.onCommit).not.toHaveBeenCalled();
        expect(tx.notification.createMany).not.toHaveBeenCalled();
        await flushDelivery();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const mail = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as { bcc: string[] };
        expect(mail.bcc).toEqual(['mentor-1@school.se']);
      });

      it('queues nothing when neither e-mail nor push is configured', async () => {
        service.deliverCommitted([entry()]);

        await flushDelivery();
        expect(fetchMock).not.toHaveBeenCalled();
      });
    });
  });

  describe('recipientsForLessons', () => {
    it('asks nothing for no lesson', async () => {
      await expect(service.recipientsForLessons(client(), [])).resolves.toEqual([]);
      expect(tx.user.findMany).not.toHaveBeenCalled();
      expect(tx.guardianStudent.findMany).not.toHaveBeenCalled();
    });

    it('reaches the active pupils of the classes, their teaching groups and the pupils named, plus all their guardians', async () => {
      tx.user.findMany.mockImplementation(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          where.studentGroupId
            ? [{ id: 'home-1', studentGroupId: 'group-1' }]
            : // The named pupils who are active pupils.
              [{ id: 'named-1' }],
        ),
      );
      tx.studentGroupMember.findMany.mockResolvedValue([{ studentId: 'member-1', studentGroupId: 'group-2' }]);
      tx.guardianStudent.findMany.mockResolvedValue([{ guardianId: 'guardian-1' }]);

      await expect(
        service.recipientsForLessons(client(), [
          { groupIds: ['group-1'], participantIds: [] },
          { groupIds: ['group-2'], participantIds: ['named-1', 'named-gone'] },
        ]),
      ).resolves.toEqual(['home-1', 'member-1', 'named-1', 'guardian-1']);

      // Active STUDENT rows only: who is told.
      expect(tx.user.findMany).toHaveBeenCalledWith({
        where: { studentGroupId: { in: ['group-1', 'group-2'] }, role: 'STUDENT', isActive: true },
        select: { id: true, studentGroupId: true },
      });
      expect(tx.studentGroupMember.findMany).toHaveBeenCalledWith({
        where: { studentGroupId: { in: ['group-1', 'group-2'] }, student: { role: 'STUDENT', isActive: true } },
        select: { studentId: true, studentGroupId: true },
      });
      expect(tx.user.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['named-1', 'named-gone'] }, role: 'STUDENT', isActive: true },
        select: { id: true },
      });
      expect(tx.guardianStudent.findMany).toHaveBeenCalledWith({
        where: { studentId: { in: ['home-1', 'member-1', 'named-1'] } },
        select: { guardianId: true },
      });
    });
  });

  describe('guardiansOf', () => {
    it('returns [] without querying when no students are given', async () => {
      await expect(service.guardiansOf(client(), [])).resolves.toEqual([]);

      expect(tx.guardianStudent.findMany).not.toHaveBeenCalled();
    });

    it('maps the guardian links of the given students', async () => {
      tx.guardianStudent.findMany.mockResolvedValue([
        { guardianId: 'guardian-1' },
        { guardianId: 'guardian-2' },
      ]);

      await expect(
        service.guardiansOf(client(), ['student-1']),
      ).resolves.toEqual(['guardian-1', 'guardian-2']);

      expect(tx.guardianStudent.findMany).toHaveBeenCalledWith({
        where: { studentId: { in: ['student-1'] } },
        select: { guardianId: true },
      });
    });
  });
});
