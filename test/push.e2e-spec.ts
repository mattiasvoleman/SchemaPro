import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { NotificationDeliveryService } from '../src/notifications/notification-delivery.service';
import { PushReceiptsService } from '../src/notifications/push-receipts.service';
import { resetExpoPacing } from '../src/notifications/expo-push.client';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

/**
 * Push over HTTP, with Expo mocked at fetch: no real push is ever sent.
 *
 *   * Off (the default, and production until somebody configures it): the
 *     config says so, registration is refused, nothing reaches Expo.
 *   * On (ConfigService answers PUSH_NOTIFICATIONS=expo): registration goes
 *     through the claim function for every role, a decision notifies after
 *     the response with exactly one send and no name or note in it, a dead
 *     device is settled, a receipts pass settles its tickets.
 *
 * What the functions do with the rows is the database's to prove (RLS 29d,
 * the adapter probe's ey-d).
 */

const SCHOOL = '33333333-3333-4333-8333-333333333333';
const ME = '22222222-2222-4222-8222-222222222222';
const GUARDIAN = '44444444-4444-4444-8444-444444444444';
const TOKEN = 'ExponentPushToken[abcdefgh1234]';
const OTHER_TOKEN = 'ExponentPushToken[zyxwvuts9876]';
const REQUEST = '88888888-8888-4888-8888-888888888888';
const who = (role: string, userId = ME) => asUser({ role: role as never, userId, schoolId: SCHOOL });

describe('push (e2e)', () => {
  let harness: TestHarness;
  let pushOn: boolean;
  let fetchMock: jest.Mock;
  const realFetch = globalThis.fetch;
  const http = () => harness.app.getHttpServer();
  const settle = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await harness.app.get(NotificationDeliveryService).idle();
  };
  const expoCalls = () => fetchMock.mock.calls.filter((call) => String(call[0]).includes('exp.host'));

  beforeAll(async () => {
    harness = await createTestApp();
    const config = harness.app.get(ConfigService);
    const real = config.get.bind(config);
    jest.spyOn(config, 'get').mockImplementation(((key: string) =>
      key === 'push' ? { ...(real('push') as object), enabled: pushOn } : real(key)) as never);
  });
  afterAll(async () => {
    globalThis.fetch = realFetch;
    await harness.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    resetExpoPacing();
    pushOn = false;
    fetchMock = jest.fn(async (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as unknown;
      if (url.endsWith('/push/send')) {
        return { ok: true, status: 200, json: async () => ({ data: (body as unknown[]).map((_m, i) => ({ status: 'ok', id: `ticket-${i}-abcdef` })) }) };
      }
      if (url.endsWith('/push/getReceipts')) {
        return { ok: true, status: 200, json: async () => ({ data: { 'ticket-dead-1': { status: 'error', details: { error: 'DeviceNotRegistered' } } } }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    harness.tx.$queryRaw.mockReset();
    harness.tx.$executeRaw.mockReset();
    harness.tx.$queryRaw.mockResolvedValue([]);
    harness.tx.$executeRaw.mockResolvedValue(1);
  });

  describe('off, as by default', () => {
    it('says so to every role', async () => {
      for (const role of ['GUARDIAN', 'STUDENT', 'TEACHER', 'SCHOOL_ADMIN']) {
        const response = await request(http()).get('/api/v1/push/config').set('x-test-user', who(role)).expect(200);
        expect(response.body).toEqual({ enabled: false });
      }
    });

    it('refuses a registration with 409 PUSH_DISABLED and writes nothing', async () => {
      const response = await request(http())
        .post('/api/v1/devices')
        .set('x-test-user', who('GUARDIAN'))
        .send({ token: TOKEN, platform: 'IOS', locale: 'sv' })
        .expect(409);
      expect(response.body.code).toBe('PUSH_DISABLED');
      expect(harness.tx.$queryRaw).not.toHaveBeenCalled();
    });

    it('still lets a device be unregistered and released', async () => {
      await request(http()).post('/api/v1/devices/unregister').set('x-test-user', who('STUDENT')).send({ token: TOKEN }).expect(204);
      expect(harness.tx.devicePushToken.deleteMany).toHaveBeenCalledWith({ where: { token: TOKEN, userId: ME } });
      await request(http()).post('/api/v1/devices/release').set('x-test-user', who('TEACHER')).send({ token: OTHER_TOKEN }).expect(204);
      const sql = harness.tx.$executeRaw.mock.calls[0]![0] as { strings: string[]; values: unknown[] };
      expect(sql.strings.join('?')).toContain('app.release_device_push_token(');
      expect(sql.values).toEqual([OTHER_TOKEN]);
    });

    it('sends nothing to Expo when a decision notifies, and checks no receipt', async () => {
      arrangeLeaveDecision();
      await request(http()).patch(`/api/v1/leave-requests/${REQUEST}/decide`).set('x-test-user', who('SCHOOL_ADMIN')).send({ status: 'REJECTED' }).expect(200);
      await settle();
      expect(expoCalls()).toHaveLength(0);
      expect(harness.app.get(PushReceiptsService).scheduled).toBe(false);
    });
  });

  describe('on', () => {
    beforeEach(() => {
      pushOn = true;
    });

    it('says so', async () => {
      await request(http()).get('/api/v1/push/config').set('x-test-user', who('STUDENT')).expect(200, { enabled: true });
    });

    it.each(['GUARDIAN', 'STUDENT', 'TEACHER', 'SCHOOL_ADMIN'])('registers a %s’s own device through the claim function', async (role) => {
      await request(http()).post('/api/v1/devices').set('x-test-user', who(role)).send({ token: TOKEN, platform: 'ANDROID', locale: 'en' }).expect(204);
      const sql = harness.tx.$queryRaw.mock.calls[0]![0] as { strings: string[]; values: unknown[] };
      expect(sql.strings.join('?')).toContain('app.claim_device_push_token(');
      // The owner is the claims' user: nothing in the call names one.
      expect(sql.values).toEqual([TOKEN, 'ANDROID', 'en']);
    });

    it.each([
      ['a token that is not Expo’s', { token: 'fcm:abc', platform: 'IOS', locale: 'sv' }],
      ['a platform it does not know', { token: TOKEN, platform: 'WEB', locale: 'sv' }],
      ['a language it does not speak', { token: TOKEN, platform: 'IOS', locale: 'de' }],
      ['somebody else as the owner', { token: TOKEN, platform: 'IOS', locale: 'sv', userId: GUARDIAN }],
    ])('refuses %s with 400', async (_name, body) => {
      await request(http()).post('/api/v1/devices').set('x-test-user', who('GUARDIAN')).send(body).expect(400);
      expect(harness.tx.$queryRaw).not.toHaveBeenCalled();
    });

    it('notifies after the response with exactly one send, and no name, note or title in it', async () => {
      arrangeLeaveDecision();
      harness.tx.$queryRaw.mockImplementation(async (sql: { strings?: string[] }) =>
        sql.strings?.join('?').includes('app.push_targets(')
          ? [{ token_id: 'tok-1', user_id: GUARDIAN, token: TOKEN, locale: 'sv', timezone: 'Europe/Stockholm' }]
          : [],
      );
      await request(http())
        .patch(`/api/v1/leave-requests/${REQUEST}/decide`)
        .set('x-test-user', who('SCHOOL_ADMIN'))
        .send({ status: 'REJECTED', note: 'Familjeresa till Thailand nekas' })
        .expect(200);
      // The send waits for the commit (a hook on a later turn, the unit specs
      // assert nothing leaves inside the transaction); here, that it happens
      // exactly once.
      await settle();
      expect(expoCalls()).toHaveLength(1);
      const sent = JSON.parse((expoCalls()[0]![1] as { body: string }).body) as Array<Record<string, unknown>>;
      expect(sent).toEqual([
        expect.objectContaining({
          to: TOKEN,
          title: 'Ledighet',
          body: 'Ledighetsansökan 19 okt–21 okt har avslagits.',
          data: { notificationId: expect.stringMatching(/^[0-9a-f-]{36}$/), type: 'LEAVE_DECIDED' },
        }),
      ]);
      const text = JSON.stringify(sent);
      for (const word of ['Ella', 'Ekström', 'Thailand', 'Familjeresa']) expect(text).not.toContain(word);
      // The ticket is stored for its receipt.
      const settled = harness.tx.$executeRaw.mock.calls.map((call) => call[0] as { strings: string[]; values: unknown[] }).find((sql) => sql.strings.join('?').includes('app.push_settle('));
      expect(settled?.values).toEqual([SCHOOL, [], JSON.stringify([{ id: 'ticket-0-abcdef', tokenId: 'tok-1' }])]);
    });

    it('sends nothing for a decision refused before it is written', async () => {
      arrangeLeaveDecision('APPROVED');
      await request(http()).patch(`/api/v1/leave-requests/${REQUEST}/decide`).set('x-test-user', who('SCHOOL_ADMIN')).send({ status: 'REJECTED' }).expect(400);
      await settle();
      expect(expoCalls()).toHaveLength(0);
      expect(harness.tx.notification.createMany).not.toHaveBeenCalled();
    });

    it('revokes a device Expo answers DeviceNotRegistered for', async () => {
      arrangeLeaveDecision();
      harness.tx.$queryRaw.mockImplementation(async (sql: { strings?: string[] }) =>
        sql.strings?.join('?').includes('app.push_targets(')
          ? [{ token_id: 'tok-dead', user_id: GUARDIAN, token: TOKEN, locale: 'en', timezone: 'Europe/Stockholm' }]
          : [],
      );
      fetchMock.mockImplementationOnce(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ status: 'error', details: { error: 'DeviceNotRegistered' } }] }),
      }));
      await request(http()).patch(`/api/v1/leave-requests/${REQUEST}/decide`).set('x-test-user', who('SCHOOL_ADMIN')).send({ status: 'REJECTED' }).expect(200);
      await settle();
      const settled = harness.tx.$executeRaw.mock.calls.map((call) => call[0] as { strings: string[]; values: unknown[] }).find((sql) => sql.strings.join('?').includes('app.push_settle('));
      expect(settled?.values).toEqual([SCHOOL, ['tok-dead'], '[]']);
    });

    it('settles a receipts pass: DeviceNotRegistered revokes, and the checked tickets go', async () => {
      harness.tx.$queryRaw.mockImplementation(async (sql: { strings?: string[] }) =>
        sql.strings?.join('?').includes('app.push_due_receipts(') ? [{ ticket_id: 'ticket-dead-1' }, { ticket_id: 'ticket-late-1' }] : [],
      );
      await harness.app.get(PushReceiptsService).tick();
      expect(expoCalls().map((call) => call[0])).toEqual(['https://exp.host/--/api/v2/push/getReceipts']);
      const settled = harness.tx.$executeRaw.mock.calls[0]![0] as { strings: string[]; values: unknown[] };
      expect(settled.strings.join('?')).toContain('app.push_receipts_settled(');
      expect(settled.values).toEqual([['ticket-dead-1'], ['ticket-dead-1']]);
    });
  });

  /** A pending (or already decided) leave request of Ella's, requested by her guardian. */
  function arrangeLeaveDecision(status = 'PENDING'): void {
    harness.tx.leaveRequest.findUnique.mockResolvedValue({
      id: REQUEST,
      schoolId: SCHOOL,
      studentId: '55555555-5555-4555-8555-555555555555',
      requestedById: GUARDIAN,
      startDate: new Date('2026-10-19T00:00:00.000Z'),
      endDate: new Date('2026-10-21T00:00:00.000Z'),
      status,
      student: { firstName: 'Ella', lastName: 'Ekström' },
    });
    harness.tx.leaveRequest.update.mockResolvedValue({ id: REQUEST, status: 'REJECTED' });
  }
});
