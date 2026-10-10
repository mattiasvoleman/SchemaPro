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
