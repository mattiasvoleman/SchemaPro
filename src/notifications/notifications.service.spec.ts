import type { Logger } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { createTxMock, type TxMock } from '../../test/utils/prisma-mock';
import { NotificationsService } from './notifications.service';

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';

/**
 * `NotificationsService` deliberately takes the caller's transaction client so
 * rows are written inside the caller's RLS transaction — there is no wrapper
 * choice to assert here; instead we assert every query goes through the given
 * `tx` and carries the caller's schoolId.
 */
describe('NotificationsService', () => {
  let service: NotificationsService;
  let tx: TxMock;
  let fetchMock: jest.Mock;

  const globalWithFetch = globalThis as { fetch?: unknown };
  const realFetch = globalWithFetch.fetch;

  const ENV_KEYS = ['RESEND_API_KEY', 'EMAIL_FROM'] as const;
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> =
    {};

  beforeEach(() => {
    tx = createTxMock();
    service = new NotificationsService();
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

  /** Email dispatch is fire-and-forget; let its microtasks settle. */
  const flushEmailDispatch = () =>
    new Promise((resolve) => setImmediate(resolve));

  const loggerOf = (s: NotificationsService): Logger =>
    (s as unknown as { logger: Logger }).logger;

  describe('notifyUsers', () => {
    it('writes one row per recipient with the caller schoolId and returns the count', async () => {
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
          { schoolId: SCHOOL_ID, userId: 'user-1', type: 'LEAVE_DECIDED', meta },
          { schoolId: SCHOOL_ID, userId: 'user-2', type: 'LEAVE_DECIDED', meta },
        ],
      });
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

    it('caps the fan-out at 500 recipients', async () => {
      const userIds = Array.from({ length: 502 }, (_, i) => `user-${i}`);

      await expect(
        service.notifyUsers(client(), {
          schoolId: SCHOOL_ID,
          userIds,
          type: 'SCHEDULE_CHANGED',
          meta: {},
        }),
      ).resolves.toBe(500);

      const { data } = tx.notification.createMany.mock.calls[0][0] as {
        data: Array<{ userId: string }>;
      };
      expect(data).toHaveLength(500);
      expect(data[0].userId).toBe('user-0');
      expect(data[499].userId).toBe('user-499');
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

    it('skips email entirely when RESEND_API_KEY is not set', async () => {
      await service.notifyUsers(client(), {
        schoolId: SCHOOL_ID,
        userIds: ['user-1'],
        type: 'LEAVE_DECIDED',
        meta: {},
        email: { subject: 'Hello', body: 'World' },
      });
      await flushEmailDispatch();

      expect(tx.user.findMany).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('skips email when no email payload is given, even with a key configured', async () => {
      process.env.RESEND_API_KEY = 'resend-key';

      await service.notifyUsers(client(), {
        schoolId: SCHOOL_ID,
        userIds: ['user-1'],
        type: 'LEAVE_DECIDED',
        meta: {},
      });
      await flushEmailDispatch();

      expect(tx.user.findMany).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('mirrors to email: resolves active recipients in-tx and BCCs their addresses', async () => {
      const warn = jest
        .spyOn(loggerOf(service), 'warn')
        .mockImplementation(() => undefined);
      process.env.RESEND_API_KEY = 'resend-key';
      process.env.EMAIL_FROM = 'SchemaPro <noreply@schemapro.test>';
      tx.user.findMany.mockResolvedValue([
        { email: 'anna@school.se' },
        { email: '' }, // no address on file — must be filtered out
        { email: 'bjorn@school.se' },
      ]);

      await expect(
        service.notifyUsers(client(), {
          schoolId: SCHOOL_ID,
          userIds: ['user-1', 'user-2', 'user-3'],
          type: 'LEAVE_DECIDED',
          meta: {},
          email: { subject: 'Decided', body: 'Your leave was approved.' },
        }),
      ).resolves.toBe(3);

      // Address resolution stays inside the caller's RLS transaction and only
      // targets active users among the recipients.
      expect(tx.user.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['user-1', 'user-2', 'user-3'] }, isActive: true },
        select: { email: true },
      });

      await flushEmailDispatch();
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

    it('falls back to the default sender when EMAIL_FROM is unset', async () => {
      process.env.RESEND_API_KEY = 'resend-key';
      tx.user.findMany.mockResolvedValue([{ email: 'anna@school.se' }]);

      await service.notifyUsers(client(), {
        schoolId: SCHOOL_ID,
        userIds: ['user-1'],
        type: 'LEAVE_DECIDED',
        meta: {},
        email: { subject: 'S', body: 'B' },
      });
      await flushEmailDispatch();

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
        service.notifyUsers(client(), {
          schoolId: SCHOOL_ID,
          userIds: ['user-1'],
          type: 'LEAVE_DECIDED',
          meta: {},
          email: { subject: 'S', body: 'B' },
        }),
      ).resolves.toBe(1);

      await flushEmailDispatch();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('never fails the mutation when the email API rejects (network)', async () => {
      process.env.RESEND_API_KEY = 'resend-key';
      tx.user.findMany.mockResolvedValue([{ email: 'anna@school.se' }]);
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
      const warn = jest
        .spyOn(loggerOf(service), 'warn')
        .mockImplementation(() => undefined);

      await expect(
        service.notifyUsers(client(), {
          schoolId: SCHOOL_ID,
          userIds: ['user-1'],
          type: 'LEAVE_DECIDED',
          meta: {},
          email: { subject: 'S', body: 'B' },
        }),
      ).resolves.toBe(1);

      await flushEmailDispatch();
      expect(warn).toHaveBeenCalledWith('Email dispatch failed [network]');
    });

    it('logs a non-2xx dispatch without surfacing it', async () => {
      process.env.RESEND_API_KEY = 'resend-key';
      tx.user.findMany.mockResolvedValue([{ email: 'anna@school.se' }]);
      fetchMock.mockResolvedValue({ ok: false, status: 429 });
      const warn = jest
        .spyOn(loggerOf(service), 'warn')
        .mockImplementation(() => undefined);

      await expect(
        service.notifyUsers(client(), {
          schoolId: SCHOOL_ID,
          userIds: ['user-1'],
          type: 'LEAVE_DECIDED',
          meta: {},
          email: { subject: 'S', body: 'B' },
        }),
      ).resolves.toBe(1);

      await flushEmailDispatch();
      expect(warn).toHaveBeenCalledWith('Email dispatch failed [status=429]');
    });
  });

  describe('recipientsForGroups', () => {
    it('returns [] without querying when no groups are given', async () => {
      await expect(service.recipientsForGroups(client(), [])).resolves.toEqual(
        [],
      );

      expect(tx.user.findMany).not.toHaveBeenCalled();
      expect(tx.guardianStudent.findMany).not.toHaveBeenCalled();
    });

    it('returns active students of the groups plus all their guardians', async () => {
      tx.user.findMany.mockResolvedValue([{ id: 'student-1' }, { id: 'student-2' }]);
      tx.guardianStudent.findMany.mockResolvedValue([
        { guardianId: 'guardian-1' },
        { guardianId: 'guardian-2' },
      ]);

      await expect(
        service.recipientsForGroups(client(), ['group-1', 'group-2']),
      ).resolves.toEqual(['student-1', 'student-2', 'guardian-1', 'guardian-2']);

      expect(tx.user.findMany).toHaveBeenCalledWith({
        where: {
          role: 'STUDENT',
          isActive: true,
          studentGroupId: { in: ['group-1', 'group-2'] },
        },
        select: { id: true },
      });
      expect(tx.guardianStudent.findMany).toHaveBeenCalledWith({
        where: { studentId: { in: ['student-1', 'student-2'] } },
        select: { guardianId: true },
      });
    });

    it('returns [] when the groups have no active students', async () => {
      tx.user.findMany.mockResolvedValue([]);
      tx.guardianStudent.findMany.mockResolvedValue([]);

      await expect(
        service.recipientsForGroups(client(), ['group-1']),
      ).resolves.toEqual([]);
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
