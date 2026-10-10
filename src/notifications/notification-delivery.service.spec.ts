import type { Logger } from '@nestjs/common';
import { createPrismaMock, createTxMock, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { MAX_PENDING_BATCHES, NotificationDeliveryService } from './notification-delivery.service';
import type { OutboxEntry } from './notification-outbox';

const SCHOOL = '33333333-3333-4333-8333-333333333333';

const entry = (overrides: Partial<OutboxEntry> = {}): OutboxEntry => ({
  schoolId: SCHOOL,
  type: 'LESSON_CANCELLED',
  meta: { subjectName: 'Matematik', startsAt: '2026-10-13T06:00:00.000Z' },
  recipients: [
    { userId: 'u1', notificationId: 'n1' },
    { userId: 'u2', notificationId: 'n2' },
  ],
  email: {
    subject: 'S',
    body: 'B',
    recipients: [
      { userId: 'u1', email: 'u1@example.invalid' },
      { userId: 'u2', email: 'u2@example.invalid' },
    ],
  },
  ...overrides,
});

describe('NotificationDeliveryService (e-mail)', () => {
  let tx: TxMock;
  let prisma: ReturnType<typeof createPrismaMock>;
  let delivery: NotificationDeliveryService;
  let fetchMock: jest.Mock;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    delivery = new NotificationDeliveryService(prisma as unknown as PrismaService);
    fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    process.env.RESEND_API_KEY = 'resend-key';
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.RESEND_API_KEY;
  });

  const bccOf = (call: number) => JSON.parse((fetchMock.mock.calls[call][1] as { body: string }).body).bcc as string[];

  it('leaves out who opted out of the type, read by user in the delivery’s own door', async () => {
    tx.$queryRaw.mockResolvedValue([{ user_id: 'u2' }]);
    delivery.enqueue([entry()]);
    await delivery.idle();
    expect(prisma.withDeliveryService).toHaveBeenCalledTimes(1);
    const sql = tx.$queryRaw.mock.calls[0][0] as { strings: string[]; values: unknown[] };
    expect(sql.strings.join('?')).toContain('app.delivery_opt_outs(');
    expect(sql.values).toEqual([SCHOOL, ['u1', 'u2'], 'LESSON_CANCELLED']);
    expect(bccOf(0)).toEqual(['u1@example.invalid']);
  });

  it('sends nothing when everybody opted out', async () => {
    tx.$queryRaw.mockResolvedValue([{ user_id: 'u1' }, { user_id: 'u2' }]);
    delivery.enqueue([entry()]);
    await delivery.idle();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['the unreported absence', { type: 'ABSENCE_UNREPORTED' as const, meta: {} }],
    ['a substitute’s own booking', { type: 'LESSON_SUBSTITUTE' as const, meta: { cover: true } }],
    ['a withdrawn booking', { type: 'LESSON_COVER_WITHDRAWN' as const, meta: {} }],
  ])('ignores opt-outs for %s', async (_name, overrides) => {
    tx.$queryRaw.mockResolvedValue([{ user_id: 'u1' }, { user_id: 'u2' }]);
    delivery.enqueue([entry(overrides)]);
    await delivery.idle();
    expect(prisma.withDeliveryService).not.toHaveBeenCalled();
    expect(bccOf(0)).toEqual(['u1@example.invalid', 'u2@example.invalid']);
  });

  it('never mails a teacher’s absence report, and wants nothing for it', async () => {
    expect(delivery.wants({ type: 'TEACHER_ABSENCE_REPORTED', email: { subject: 's', body: 'b' } })).toBe(false);
    delivery.enqueue([entry({ type: 'TEACHER_ABSENCE_REPORTED' })]);
    await delivery.idle();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks nothing of the database when no recipient has an address', async () => {
    delivery.enqueue([entry({ email: { subject: 'S', body: 'B', recipients: [{ userId: 'u1', email: '' }] } })]);
    await delivery.idle();
    expect(prisma.withDeliveryService).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('delivers batches one after another, never two at once', async () => {
    let inFlight = 0;
    let most = 0;
    fetchMock.mockImplementation(async () => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return { ok: true, status: 200 };
    });
    for (let i = 0; i < 4; i++) delivery.enqueue([entry({ meta: { i } })]);
    await delivery.idle();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(most).toBe(1);
  });

  it('keeps going after a batch fails, and logs only its error’s name', async () => {
    const warn = jest.spyOn((delivery as unknown as { logger: Logger }).logger, 'warn').mockImplementation(() => undefined);
    prisma.withDeliveryService.mockRejectedValueOnce(new TypeError('boom with a secret'));
    delivery.enqueue([entry()]);
    delivery.enqueue([entry()]);
    await delivery.idle();
    expect(warn).toHaveBeenCalledWith('Delivery failed [TypeError, notices=1]');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a batch beyond the bound and ignores an empty one', async () => {
    const warn = jest.spyOn((delivery as unknown as { logger: Logger }).logger, 'warn').mockImplementation(() => undefined);
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    delivery.enqueue([]);
    for (let i = 0; i <= MAX_PENDING_BATCHES + 1; i++) delivery.enqueue([entry()]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Delivery queue full'));
  });
});

describe('NotificationDeliveryService (push)', () => {
  let tx: TxMock;
  let prisma: ReturnType<typeof createPrismaMock>;
  let expo: { send: jest.Mock; receipts: jest.Mock };
  let delivery: NotificationDeliveryService;
  let targets: Array<{ token_id: string; user_id: string; token: string; locale: string; timezone: string }>;
  let targetCalls: Array<{ values: unknown[] }>;
  let settled: Array<{ values: unknown[] }>;
  let enabled: boolean;
  const fetchMock = jest.fn();
  const realFetch = globalThis.fetch;

  const config = { get: (key: string) => (key === 'push' ? { enabled, apiUrl: 'https://x.invalid' } : undefined) };

  beforeEach(() => {
    enabled = true;
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    expo = {
      send: jest.fn(async (messages: unknown[]) => messages.map((_m, i) => ({ status: 'ok', id: `ticket-${i}-abc` }))),
      receipts: jest.fn(),
    };
    delivery = new NotificationDeliveryService(prisma as unknown as PrismaService, config as never, expo as never);
    targets = [
      { token_id: 't-u1', user_id: 'u1', token: 'ExponentPushToken[aaaaaaaa]', locale: 'sv', timezone: 'Europe/Stockholm' },
      { token_id: 't-u2', user_id: 'u2', token: 'ExponentPushToken[bbbbbbbb]', locale: 'en', timezone: 'Europe/Stockholm' },
    ];
    targetCalls = [];
    settled = [];
    tx.$queryRaw.mockImplementation(async (sql: { strings: string[]; values: unknown[] }) => {
      if (sql.strings.join('?').includes('app.push_targets(')) {
        targetCalls.push(sql);
        const users = sql.values[1] as string[];
        return targets.filter((t) => users.includes(t.user_id));
      }
      return [];
    });
    tx.$executeRaw.mockImplementation(async (sql: { strings: string[]; values: unknown[] }) => {
      if (sql.strings.join('?').includes('app.push_settle(')) settled.push(sql);
      return 1;
    });
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const lesson = (overrides: Partial<OutboxEntry> = {}): OutboxEntry => entry({ email: undefined, ...overrides });

  it('does nothing about push while it is off: no query, no Expo call', async () => {
    enabled = false;
    expect(delivery.pushEnabled()).toBe(false);
    expect(delivery.wants({ type: 'LESSON_CANCELLED' })).toBe(false);
    delivery.enqueue([lesson()]);
    await delivery.idle();
    expect(prisma.withDeliveryService).not.toHaveBeenCalled();
    expect(expo.send).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('wants every notice but a teacher’s absence report once push is on, even without e-mail', () => {
    expect(delivery.wants({ type: 'LESSON_CANCELLED' })).toBe(true);
    expect(delivery.wants({ type: 'TEACHER_ABSENCE_REPORTED' })).toBe(false);
    expect(new NotificationDeliveryService(prisma as unknown as PrismaService, config as never).pushEnabled()).toBe(false);
  });

  it('sends each device its language, with only the notice id and type as data', async () => {
    delivery.enqueue([lesson()]);
    await delivery.idle();
    expect(targetCalls).toHaveLength(1);
    expect(targetCalls[0]!.values).toEqual([SCHOOL, ['u1', 'u2'], 'LESSON_CANCELLED', false]);
    expect(expo.send).toHaveBeenCalledTimes(1);
    expect(expo.send.mock.calls[0][0]).toEqual([
      {
        to: 'ExponentPushToken[aaaaaaaa]',
        title: 'Inställd lektion',
        body: 'En lektion tis 13 okt 08:00 är inställd.',
        data: { notificationId: 'n1', type: 'LESSON_CANCELLED' },
        ttl: 86_400,
        channelId: 'default',
        sound: 'default',
        priority: 'default',
      },
      {
        to: 'ExponentPushToken[bbbbbbbb]',
        title: 'Lesson cancelled',
        body: 'A lesson Tue 13 Oct 08:00 is cancelled.',
        data: { notificationId: 'n2', type: 'LESSON_CANCELLED' },
        ttl: 86_400,
        channelId: 'default',
        sound: 'default',
        priority: 'default',
      },
    ]);
    expect(JSON.stringify(expo.send.mock.calls[0][0])).not.toContain('Matematik');
  });

  it('coalesces one person’s notices of a kind in one transaction into one push', async () => {
    delivery.enqueue([lesson(), lesson({ recipients: [{ userId: 'u1', notificationId: 'n3' }] }), lesson({ recipients: [{ userId: 'u1', notificationId: 'n4' }] })]);
    await delivery.idle();
    const sent = expo.send.mock.calls[0][0] as Array<{ to: string; body: string; data: { notificationId: string } }>;
    expect(sent.map((m) => [m.to, m.body, m.data.notificationId])).toEqual([
      ['ExponentPushToken[aaaaaaaa]', '3 lektioner är inställda.', 'n1'],
      ['ExponentPushToken[bbbbbbbb]', 'A lesson Tue 13 Oct 08:00 is cancelled.', 'n2'],
    ]);
  });

  it('asks for a substitute’s booking with opt-outs ignored, apart from the class’s notice', async () => {
    delivery.enqueue([
      lesson({ type: 'LESSON_SUBSTITUTE', meta: { startsAt: '2026-10-13T06:00:00.000Z' }, recipients: [{ userId: 'u2', notificationId: 'n-class' }] }),
      lesson({ type: 'LESSON_SUBSTITUTE', meta: { startsAt: '2026-10-13T06:00:00.000Z', cover: true }, recipients: [{ userId: 'u1', notificationId: 'n-cover' }] }),
      lesson({ type: 'LESSON_COVER_WITHDRAWN', meta: {}, recipients: [{ userId: 'u1', notificationId: 'n-off' }] }),
      lesson({ type: 'ABSENCE_UNREPORTED', meta: { date: '2026-10-13' }, recipients: [{ userId: 'u2', notificationId: 'n-abs' }] }),
    ]);
    await delivery.idle();
    expect(targetCalls.map((call) => [call.values[2], call.values[3]])).toEqual([
      ['LESSON_SUBSTITUTE', false],
      ['LESSON_SUBSTITUTE', true],
      ['LESSON_COVER_WITHDRAWN', true],
      ['ABSENCE_UNREPORTED', true],
    ]);
    const bodies = (expo.send.mock.calls[0][0] as Array<{ body: string }>).map((m) => m.body);
    expect(bodies).toEqual([
      'A lesson Tue 13 Oct 08:00 has a substitute.',
      'Du har ett vikariepass tis 13 okt 08:00.',
      'Ett vikariepass är avbokat.',
      'Unreported absence 13 Oct. Open SchemaPro to see more.',
    ]);
  });

  it('never pushes a teacher’s absence report', async () => {
    delivery.enqueue([lesson({ type: 'TEACHER_ABSENCE_REPORTED', meta: { teacherName: 'Karin Lund' } })]);
    await delivery.idle();
    expect(targetCalls).toHaveLength(0);
    expect(expo.send).not.toHaveBeenCalled();
  });

  it('sends nothing to a person without a live token, and settles nothing', async () => {
    targets = [];
    delivery.enqueue([lesson()]);
    await delivery.idle();
    expect(expo.send).not.toHaveBeenCalled();
    expect(settled).toHaveLength(0);
  });

  it('stores the ok tickets and revokes a device Expo says is gone, in the school it was sent for', async () => {
    const warn = jest.spyOn((delivery as unknown as { logger: Logger }).logger, 'warn').mockImplementation(() => undefined);
    expo.send.mockResolvedValue([
      { status: 'ok', id: 'ticket-ok-1' },
      { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
    ]);
    delivery.enqueue([lesson()]);
    await delivery.idle();
    expect(settled).toHaveLength(1);
    expect(settled[0]!.values).toEqual([SCHOOL, ['t-u2'], JSON.stringify([{ id: 'ticket-ok-1', tokenId: 't-u1' }])]);
    expect(warn).toHaveBeenCalledWith('Push tickets with errors [DeviceNotRegistered=1, sent=2]');
  });

  it('logs other ticket errors by code and settles nothing for them', async () => {
    const warn = jest.spyOn((delivery as unknown as { logger: Logger }).logger, 'warn').mockImplementation(() => undefined);
    expo.send.mockResolvedValue([{ status: 'error', details: { error: 'MessageRateExceeded' } }, { status: 'error' }]);
    delivery.enqueue([lesson()]);
    await delivery.idle();
    expect(settled).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith('Push tickets with errors [MessageRateExceeded=1, Unknown=1, sent=2]');
  });
});
