import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from '@nestjs/common';
import { createPrismaMock, createTxMock, type TxMock } from '../../test/utils/prisma-mock';
import { MemoryOutbound } from '../../test/utils/outbound-memory';
import type { PrismaService } from '../database/prisma.service';
import { EMAIL_TIMEOUT_MS, NOTICE_LEASE_MS, NotificationDeliveryService } from './notification-delivery.service';
import type { OutboxEntry, OutboxSettled } from './notification-outbox';

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

/** An entry for `n` people with an address each: 98 of them are two mails of 49. */
const wide = (n: number, overrides: Partial<OutboxEntry> = {}, prefix = 'w'): OutboxEntry =>
  entry({
    recipients: Array.from({ length: n }, (_v, i) => ({ userId: `${prefix}${i}`, notificationId: `n-${prefix}${i}` })),
    email: { subject: 'S', body: 'B', recipients: Array.from({ length: n }, (_v, i) => ({ userId: `${prefix}${i}`, email: `${prefix}${i}@example.invalid` })) },
    ...overrides,
  });

/**
 * What the producers of an entry know and the queue does not keep: the addresses. The delivery reads them from the
 * database when a row is planned (app.outbound_addresses), so a spec says who has one.
 */
const withAddresses = (store: MemoryOutbound, batch: readonly OutboxEntry[]): void => {
  for (const one of batch) for (const r of one.email?.recipients ?? []) if (r.email) store.directory.set(r.userId, r.email);
};

const logOf = (delivery: NotificationDeliveryService): Logger => (delivery as unknown as { logger: Logger }).logger;

/** A Resend that answers like the real one for a repeated key: the first request sends, the next ones are answered as it was. */
const resend = () => {
  const delivered = new Map<string, { bcc: string[]; subject: string }>();
  const requests: Array<{ key: string; bcc: string[]; subject: string }> = [];
  const fetchMock = jest.fn(async (_url: string, init: { headers: Record<string, string>; body: string }) => {
    const body = JSON.parse(init.body) as { bcc: string[]; subject: string };
    const key = init.headers['Idempotency-Key']!;
    requests.push({ key, bcc: body.bcc, subject: body.subject });
    if (!delivered.has(key)) delivered.set(key, body);
    return { ok: true, status: 200 };
  });
  return { fetchMock, delivered, requests };
};

describe('NotificationDeliveryService (e-mail)', () => {
  let tx: TxMock;
  let prisma: ReturnType<typeof createPrismaMock>;
  let store: MemoryOutbound;
  let delivery: NotificationDeliveryService;
  let fetchMock: jest.Mock;
  const realFetch = globalThis.fetch;

  const make = () => {
    const made = new NotificationDeliveryService(prisma as unknown as PrismaService, undefined, undefined, undefined, store);
    // The provider's pacing is its own test, below.
    made.emailIntervalMs = 0;
    made.pushIntervalMs = 0;
    return made;
  };

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    store = new MemoryOutbound();
    delivery = make();
    fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    process.env.RESEND_API_KEY = 'resend-key';
    delete process.env.EMAIL_FROM;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.RESEND_API_KEY;
    jest.restoreAllMocks();
  });

  /** Hands a batch over as its producer does, with the addresses in the database. */
  const enqueue = (batch: OutboxEntry[], settled?: OutboxSettled) => {
    withAddresses(store, batch);
    return delivery.enqueue(batch, settled);
  };
  const bccOf = (call: number) => JSON.parse((fetchMock.mock.calls[call]![1] as { body: string }).body).bcc as string[];
  const subjectOf = (call: unknown[]) => (JSON.parse((call[1] as { body: string }).body) as { subject: string }).subject;
  const until = async (condition: () => boolean) => {
    for (let i = 0; i < 500 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(condition()).toBe(true);
  };

  it('leaves out who opted out of the type, read by user in the delivery’s own door', async () => {
    tx.$queryRaw.mockResolvedValue([{ user_id: 'u2' }]);
    await enqueue([entry()]);
    await delivery.idle();
    expect(prisma.withDeliveryService).toHaveBeenCalledTimes(1);
    const sql = tx.$queryRaw.mock.calls[0]![0] as { strings: string[]; values: unknown[] };
    expect(sql.strings.join('?')).toContain('app.delivery_opt_outs(');
    expect(sql.values).toEqual([SCHOOL, ['u1', 'u2'], 'LESSON_CANCELLED']);
    expect(bccOf(0)).toEqual(['u1@example.invalid']);
  });

  it('sends nothing when everybody opted out, and the row is done all the same', async () => {
    tx.$queryRaw.mockResolvedValue([{ user_id: 'u1' }, { user_id: 'u2' }]);
    await enqueue([entry()]);
    await delivery.idle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.count('DONE')).toBe(1);
  });

  it.each([
    ['the unreported absence', { type: 'ABSENCE_UNREPORTED' as const, meta: {} }],
    ['a substitute’s own booking', { type: 'LESSON_SUBSTITUTE' as const, meta: { cover: true } }],
    ['a withdrawn booking', { type: 'LESSON_COVER_WITHDRAWN' as const, meta: {} }],
  ])('ignores opt-outs for %s', async (_name, overrides) => {
    tx.$queryRaw.mockResolvedValue([{ user_id: 'u1' }, { user_id: 'u2' }]);
    await enqueue([entry(overrides)]);
    await delivery.idle();
    expect(prisma.withDeliveryService).not.toHaveBeenCalled();
    expect(bccOf(0)).toEqual(['u1@example.invalid', 'u2@example.invalid']);
  });

  it('mails a teacher’s absence report to the administrators who have not switched it off (K6), and wants nothing for it without a mail', async () => {
    expect(delivery.wants({ type: 'TEACHER_ABSENCE_REPORTED', email: { subject: 's', body: 'b' } })).toBe(true);
    expect(delivery.wants({ type: 'TEACHER_ABSENCE_REPORTED' })).toBe(false);
    tx.$queryRaw.mockResolvedValue([{ user_id: 'u2' }]);
    await enqueue([entry({ type: 'TEACHER_ABSENCE_REPORTED', meta: { teacherName: 'Karin Ek' } })]);
    await delivery.idle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Opted out like any other type, by user.
    const sql = tx.$queryRaw.mock.calls[0]![0] as { strings: string[]; values: unknown[] };
    expect(sql.values).toEqual([SCHOOL, ['u1', 'u2'], 'TEACHER_ABSENCE_REPORTED']);
    expect(bccOf(0)).toEqual(['u1@example.invalid']);
  });

  it('never pushes a teacher’s absence report, also when push is on: only its mail goes, and a notice with no mail is not even queued', async () => {
    const config = { get: (key: string) => (key === 'push' ? { enabled: true, apiUrl: 'https://x.invalid' } : undefined) };
    const expo = { send: jest.fn(async (messages: unknown[]) => messages.map(() => ({ status: 'ok', id: 'ticket-abcdefgh' }))), receipts: jest.fn() };
    const both = new NotificationDeliveryService(prisma as unknown as PrismaService, config as never, expo as never, undefined, store);
    both.emailIntervalMs = 0;
    both.pushIntervalMs = 0;
    expect(both.wants({ type: 'TEACHER_ABSENCE_REPORTED' })).toBe(false);
    expect(both.wants({ type: 'TEACHER_ABSENCE_REPORTED', email: { subject: 's', body: 'b' } })).toBe(true);
    withAddresses(store, [entry()]);
    await both.enqueue([entry({ type: 'TEACHER_ABSENCE_REPORTED', email: undefined })]);
    await both.idle();
    expect(store.rows).toHaveLength(0);
    await both.enqueue([entry({ type: 'TEACHER_ABSENCE_REPORTED' })]);
    await both.idle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(expo.send).not.toHaveBeenCalled();
    expect(tx.$queryRaw.mock.calls.map((call) => JSON.stringify((call[0] as { strings: string[] }).strings)).join(' ')).not.toContain('push_targets');
  });

  it('never mails nor queues anything for a notice with neither a mail nor push configured', async () => {
    delete process.env.RESEND_API_KEY;
    expect(delivery.wants({ type: 'TEACHER_ABSENCE_REPORTED', email: { subject: 's', body: 'b' } })).toBe(false);
    await enqueue([entry({ type: 'TEACHER_ABSENCE_REPORTED' })]);
    await delivery.idle();
    expect(store.rows).toHaveLength(0);
  });

  it('asks nothing of the opt-outs when no recipient has an address', async () => {
    await enqueue([entry({ email: { subject: 'S', body: 'B', recipients: [{ userId: 'u1', email: '' }] } })]);
    await delivery.idle();
    expect(prisma.withDeliveryService).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends one address once, whoever shares it', async () => {
    store.directory.set('u1', 'Same@Example.invalid');
    store.directory.set('u2', 'same@example.invalid');
    await delivery.enqueue([entry()]);
    await delivery.idle();
    expect(bccOf(0)).toEqual(['Same@Example.invalid']);
  });

  it('puts no address and no token in the queue: the people’s ids, and the mail’s own text, are all it holds of them', async () => {
    const written = jest.spyOn(store, 'enqueue');
    await enqueue([entry()]);
    await delivery.idle();
    expect(written).toHaveBeenCalledTimes(1);
    const text = JSON.stringify(written.mock.calls[0]![0]);
    expect(text).not.toMatch(/@|example\.invalid/);
    expect(JSON.parse(text)).toMatchObject({ schoolId: SCHOOL, urgent: false, recipientIds: ['u1', 'u2'], notificationIds: ['n1', 'n2'] });
  });

  it('delivers rows one after another, never two at once', async () => {
    let inFlight = 0;
    let most = 0;
    fetchMock.mockImplementation(async () => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return { ok: true, status: 200 };
    });
    for (let i = 0; i < 4; i++) await enqueue([entry({ meta: { i } })]);
    await delivery.idle();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(most).toBe(1);
  });

  describe('an alarm and a wave', () => {
    const waveOf = (subject: string) => wide(98, { email: { subject, body: 'B', recipients: Array.from({ length: 98 }, (_v, i) => ({ userId: `w${i}`, email: `w${i}@example.invalid` })) } });
    const alarm = (subject = 'ALARM') =>
      entry({ type: 'CRISIS_ALARM', meta: {}, email: { subject, body: 'B', recipients: [{ userId: 'u1', email: 'u1@example.invalid' }] } });

    it('lets an alarm go beside a wave that is in the middle of its mails, not after it', async () => {
      // A request to a whole school is some 4 000 notices and 82 mails; the alarm's push lives ten minutes.
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
        if ((JSON.parse(init.body) as { subject: string }).subject === 'WAVE') await held;
        return { ok: true, status: 200 };
      });
      await enqueue([waveOf('WAVE')]);
      await enqueue([waveOf('NEXT WAVE')]);
      await until(() => fetchMock.mock.calls.length === 1);
      await enqueue([alarm()]);
      await until(() => fetchMock.mock.calls.some((call) => subjectOf(call) === 'ALARM'));
      // The first wave is still held in its first mail, and the second has not started.
      expect(fetchMock.mock.calls.map(subjectOf)).toEqual(['WAVE', 'ALARM']);
      release();
      await delivery.idle();
      expect(fetchMock.mock.calls.map(subjectOf).filter((subject) => subject === 'NEXT WAVE')).toHaveLength(2);
    });

    it('splits a transaction’s notices by type: the alarm in it is a row of the urgent lane, the rest wait their turn', async () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
        if ((JSON.parse(init.body) as { subject: string }).subject === 'WAVE') await held;
        return { ok: true, status: 200 };
      });
      await enqueue([waveOf('WAVE')]);
      await until(() => fetchMock.mock.calls.length === 1);
      await enqueue([entry({ email: { subject: 'LESSON', body: 'B', recipients: [{ userId: 'u9', email: 'u9@example.invalid' }] } }), alarm()]);
      await until(() => fetchMock.mock.calls.some((call) => subjectOf(call) === 'ALARM'));
      expect(fetchMock.mock.calls.map(subjectOf)).toEqual(['WAVE', 'ALARM']);
      expect(store.rows.map((row) => row.urgent).sort()).toEqual([false, false, true]);
      release();
      await delivery.idle();
      expect(fetchMock.mock.calls.map(subjectOf)).toEqual(['WAVE', 'ALARM', 'WAVE', 'LESSON']);
    });

    it('is two rows for two schools, as an entry has one school', async () => {
      const OTHER = '44444444-4444-4444-8444-444444444444';
      await enqueue([entry(), entry({ schoolId: OTHER })]);
      await delivery.idle();
      expect(store.rows.map((row) => row.schoolId).sort()).toEqual([SCHOOL, OTHER].sort());
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('takes its place in the pace from the database for every mail, from whichever lane, and waits as long as it is told', async () => {
      delivery.emailIntervalMs = 40;
      // The database says: now, then 40 ms after, then 40 ms after that.
      store.slots = [0, 40, 40, 40];
      const sentAt: number[] = [];
      fetchMock.mockImplementation(async () => {
        sentAt.push(Date.now());
        return { ok: true, status: 200 };
      });
      await enqueue([waveOf('WAVE')]);
      await enqueue([alarm('A1')]);
      await enqueue([alarm('A2')]);
      await delivery.idle();
      expect(sentAt).toHaveLength(4);
      expect(store.slotCalls).toEqual(Array.from({ length: 4 }, () => ({ channel: 'EMAIL', intervalMs: 40 })));
    });

    it('keeps the pace itself, by its own clock, when the database cannot say', async () => {
      delivery.emailIntervalMs = 40;
      const slot = jest.spyOn(store, 'slot').mockRejectedValue(new Error('the database is down'));
      const sentAt: number[] = [];
      fetchMock.mockImplementation(async () => {
        sentAt.push(Date.now());
        return { ok: true, status: 200 };
      });
      await enqueue([wide(98)]);
      await delivery.idle();
      expect(slot).toHaveBeenCalledTimes(2);
      expect(sentAt).toHaveLength(2);
      expect(sentAt[1]! - sentAt[0]!).toBeGreaterThanOrEqual(35);
    });

    it('does not wait for a slot that is a long way off: at most thirty seconds, then it asks again', async () => {
      delivery.emailIntervalMs = 40;
      store.slots = [3_600_000];
      const timers = jest.spyOn(globalThis, 'setTimeout');
      await enqueue([entry()]);
      await until(() => timers.mock.calls.some(([, ms]) => ms === 30_000));
      expect(fetchMock).not.toHaveBeenCalled();
      // The row waits where it is; this spec does not wait the half minute out.
      timers.mockRestore();
    });
  });

  describe('the queue does not take the batch, or a row fails', () => {
    it('keeps going after a row fails to plan, hands it back for later and logs only the error’s name', async () => {
      const warn = jest.spyOn(logOf(delivery), 'warn').mockImplementation(() => undefined);
      prisma.withDeliveryService.mockRejectedValueOnce(new TypeError('boom with a secret'));
      await enqueue([entry()]);
      await enqueue([entry({ meta: { n: 2 }, type: 'ABSENCE_UNREPORTED' })]);
      await delivery.idle();
      expect(warn).toHaveBeenCalledWith('Notice delivery failed [TypeError, attempt=1]');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
      // The second row had no opt-out to ask for and went; the first waits to be tried again.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(store.count('PENDING')).toBe(1);
      expect(store.count('DONE')).toBe(1);
      // After its wait it is planned again and goes.
      store.forward(31_000);
      tx.$queryRaw.mockResolvedValue([]);
      delivery.kick();
      await delivery.idle();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(store.count('DONE')).toBe(2);
    });

    it('tries a write to the queue again, and says false only when it will not take it', async () => {
      const warn = jest.spyOn(logOf(delivery), 'warn').mockImplementation(() => undefined);
      store.failNext = 'enqueue';
      const told: boolean[] = [];
      await enqueue([entry()], (delivered) => told.push(delivered));
      await delivery.idle();
      expect(store.rows).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(told).toEqual([true]);

      jest.spyOn(store, 'enqueue').mockRejectedValue(new TypeError('the database is gone'));
      await enqueue([entry()], (delivered) => told.push(delivered));
      expect(told).toEqual([true, false]);
      expect(warn).toHaveBeenCalledWith('Delivery enqueue failed [TypeError, notices=1]');
    });

    it('refuses a batch for a full queue, says false and writes the rest of the work', async () => {
      const warn = jest.spyOn(logOf(delivery), 'warn').mockImplementation(() => undefined);
      store.limit = 0;
      const told: boolean[] = [];
      await enqueue([entry()], (delivered) => told.push(delivered));
      expect(told).toEqual([false]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Delivery queue full'));
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('ignores an empty batch, and one with no channel to go by', async () => {
      await enqueue([]);
      delete process.env.RESEND_API_KEY;
      await enqueue([entry()]);
      await delivery.idle();
      expect(store.rows).toHaveLength(0);
    });

    it('takes no row at all where there is no channel: it is left for a process that has one', async () => {
      await enqueue([entry()]);
      await delivery.idle();
      store.rows.push({ ...store.rows[0]!, id: 'later', status: 'PENDING', claim: null, leaseUntil: null, plan: null, mailDone: 0 });
      delete process.env.RESEND_API_KEY;
      delivery.kick();
      await delivery.idle();
      expect(store.rows.find((row) => row.id === 'later')!.status).toBe('PENDING');
    });

    it('leaves a row with mail in it for a process that has the key, when this one has not', async () => {
      const first = store.enqueue({ schoolId: SCHOOL, urgent: false, entries: [{ type: 'LESSON_CANCELLED', meta: {}, n: 1, email: { subject: 'S', body: 'B' } }], recipientIds: ['u1'], notificationIds: ['n1'] });
      await first;
      const config = { get: (key: string) => (key === 'push' ? { enabled: true } : undefined) };
      delete process.env.RESEND_API_KEY;
      const pushOnly = new NotificationDeliveryService(prisma as unknown as PrismaService, config as never, { send: jest.fn(async () => []) } as never, undefined, store);
      pushOnly.kick();
      await pushOnly.idle();
      expect(store.rows[0]!.status).toBe('PENDING');
      expect(store.rows[0]!.plan).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not use a row’s thirty tries up in minutes by looking at it again and again with nothing to send it with', async () => {
      await store.enqueue({ schoolId: SCHOOL, urgent: false, entries: [{ type: 'LESSON_CANCELLED', meta: {}, n: 1, email: { subject: 'S', body: 'B' } }], recipientIds: ['u1'], notificationIds: ['n1'] });
      const config = { get: (key: string) => (key === 'push' ? { enabled: true } : undefined) };
      delete process.env.RESEND_API_KEY;
      const pushOnly = new NotificationDeliveryService(prisma as unknown as PrismaService, config as never, { send: jest.fn(async () => []) } as never, undefined, store);
      pushOnly.kick();
      await pushOnly.idle();
      let waited = 0;
      while (store.rows[0]!.attempts < 30) {
        const wait = Math.max(0, store.rows[0]!.notBefore - store.now()) + 1;
        store.forward(wait);
        waited += wait;
        pushOnly.kick();
        await pushOnly.idle();
      }
      // The sweep gives a row up at its thirtieth try: a key that is missing for a few hours must not cost the mail, and the push with it.
      expect(store.rows[0]!.status).toBe('PENDING');
      expect(waited).toBeGreaterThanOrEqual(60 * 60_000);
    });
  });

  describe('the mails of a row', () => {
    it('go under a key made of the row and the packet, and a packet gets the same key every time it is tried', async () => {
      const { fetchMock: fake, requests } = resend();
      globalThis.fetch = fake as unknown as typeof fetch;
      await enqueue([wide(98)]);
      await delivery.idle();
      const id = store.rows[0]!.id;
      expect(requests.map((r) => r.key)).toEqual([`notice/${id}/mail/0`, `notice/${id}/mail/1`]);
      expect(requests.every((r) => r.key.length <= 256)).toBe(true);
    });

    it('are sent with the caller’s subject and body, the sender’s own address as `to` and the rest on BCC', async () => {
      process.env.EMAIL_FROM = 'SchemaPro <noreply@schemapro.test>';
      await enqueue([entry({ email: { subject: 'Decided', body: 'Your leave was approved.', recipients: [{ userId: 'u1', email: 'anna@school.se' }, { userId: 'u2', email: '' }] } })]);
      await delivery.idle();
      const [url, init] = fetchMock.mock.calls[0]! as [string, { method: string; headers: Record<string, string>; body: string }];
      expect(url).toBe('https://api.resend.com/emails');
      expect(init.method).toBe('POST');
      expect(init.headers['Authorization']).toBe('Bearer resend-key');
      expect(init.headers['Content-Type']).toBe('application/json');
      expect(JSON.parse(init.body)).toEqual({ from: 'SchemaPro <noreply@schemapro.test>', to: ['noreply@schemapro.test'], bcc: ['anna@school.se'], subject: 'Decided', text: 'Your leave was approved.' });
    });

    it('are 49 addresses each beside the sender’s own: 50, the provider’s documented cap', async () => {
      await enqueue([wide(120)]);
      await delivery.idle();
      const sizes = fetchMock.mock.calls.map((_call, i) => bccOf(i).length);
      expect(sizes).toEqual([49, 49, 22]);
    });
  });

  describe('a mail that does not go through', () => {
    /** A fetch that answers nothing, and rejects the way fetch does when its signal aborts. */
    const silent = (_url: string, init: { signal: AbortSignal }) =>
      new Promise<never>((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));

    it('that nobody answers is given up for now after the limit, and the lane goes on to the next row instead of waiting minutes', async () => {
      const warn = jest.spyOn(logOf(delivery), 'warn').mockImplementation(() => undefined);
      delivery.emailTimeoutMs = 25;
      fetchMock.mockImplementationOnce(silent);
      const started = Date.now();
      await enqueue([entry({ meta: { n: 'hangs' } })]);
      await enqueue([entry({ meta: { n: 'goes' } })]);
      await delivery.idle();
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith('Email dispatch failed [timeout 25 ms, will be tried again]');
      // Logged without an address, a subject or a text.
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/example\.invalid|"S"|"B"/);
      expect(store.count('PENDING')).toBe(1);
      expect(store.count('DONE')).toBe(1);
    });

    it('that is tried again goes as the same packet under the same key, and is told true when it has gone', async () => {
      const { fetchMock: fake, requests, delivered } = resend();
      const inner = fake.getMockImplementation()!;
      let failures = 1;
      fake.mockImplementation(async (url, init) => {
        if (failures-- > 0) return { ok: false, status: 503 } as never;
        return inner(url, init) as never;
      });
      globalThis.fetch = fake as unknown as typeof fetch;
      jest.spyOn(logOf(delivery), 'warn').mockImplementation(() => undefined);
      const told: boolean[] = [];
      await enqueue([wide(98)], (delivered) => told.push(delivered));
      await delivery.idle();
      // The first packet was refused for now: the row is handed back and nothing is told yet.
      expect(told).toEqual([]);
      expect(store.rows[0]!.status).toBe('PENDING');
      expect(store.rows[0]!.mailDone).toBe(0);
      store.forward(31_000);
      delivery.kick();
      await delivery.idle();
      expect(told).toEqual([true]);
      const id = store.rows[0]!.id;
      expect(fake.mock.calls).toHaveLength(3);
      expect([...delivered.keys()]).toEqual([`notice/${id}/mail/0`, `notice/${id}/mail/1`]);
      // The refused request and the one that went are the same packet.
      expect(requests[0]!.key).toBe(`notice/${id}/mail/0`);
      expect(requests[0]!.bcc).toEqual(delivered.get(`notice/${id}/mail/0`)!.bcc);
    });

    it.each([
      // The wait a provider names is the least it waits: the queue's own first backoff is half a minute.
      ['a rate limit with a wait shorter than the backoff', { ok: false, status: 429, headers: { get: (name: string) => (name === 'retry-after' ? '7' : null) } }, 30_000],
      ['a rate limit with a wait longer than the backoff', { ok: false, status: 429, headers: { get: (name: string) => (name === 'retry-after' ? '90' : null) } }, 90_000],
      ['a server that is down', { ok: false, status: 503 }, null],
      ['a request still being served under the key', { ok: false, status: 409, json: async () => ({ name: 'concurrent_idempotent_requests' }) }, 5_000],
      ['a day’s quota that is used up', { ok: false, status: 429, json: async () => ({ name: 'daily_quota_exceeded' }) }, 30 * 60_000],
      ['a key Resend refuses', { ok: false, status: 401 }, 15 * 60_000],
    ])('hands the row back for %s, after the wait', async (_name, answer, waitMs) => {
      jest.spyOn(logOf(delivery), 'warn').mockImplementation(() => undefined);
      fetchMock.mockResolvedValue(answer);
      const before = Date.now();
      await enqueue([entry()]);
      await delivery.idle();
      const row = store.rows[0]!;
      expect(row.status).toBe('PENDING');
      expect(row.mailDone).toBe(0);
      // The first retry of a row is half a minute off when the provider names no wait.
      const waits = row.notBefore - before;
      expect(waits).toBeGreaterThanOrEqual((waitMs ?? 30_000) - 50);
      expect(waits).toBeLessThanOrEqual((waitMs ?? 30_000) + 2_000);
    });

    it('gives a mail hours and not minutes under a rate limit that names a second: its thirty tries are spread over the backoff', async () => {
      jest.spyOn(logOf(delivery), 'warn').mockImplementation(() => undefined);
      fetchMock.mockResolvedValue({ ok: false, status: 429, headers: { get: (name: string) => (name === 'retry-after' ? '1' : null) } });
      await enqueue([entry()]);
      await delivery.idle();
      let waited = 0;
      while (store.rows[0]!.attempts < 30) {
        const wait = Math.max(0, store.rows[0]!.notBefore - store.now()) + 1;
        store.forward(wait);
        waited += wait;
        delivery.kick();
        await delivery.idle();
      }
      // The sweep gives a row up at its thirtieth try (app.outbound_sweep), so the tries must cover the provider's trouble
      // for hours: at one a poll (ten seconds) they covered five minutes.
      expect(store.rows[0]!.status).toBe('PENDING');
      expect(waited).toBeGreaterThanOrEqual(60 * 60_000);
    });

    it('that Resend will not take at all (a bad address) is counted failed, not tried again, and the rest of the row goes', async () => {
      const warn = jest.spyOn(logOf(delivery), 'warn').mockImplementation(() => undefined);
      fetchMock.mockResolvedValueOnce({ ok: false, status: 422, json: async () => ({ name: 'validation_error' }) });
      const told: boolean[] = [];
      await enqueue([wide(98)], (delivered) => told.push(delivered));
      await delivery.idle();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(bccOf(1)).toHaveLength(49);
      expect(bccOf(1)[0]).toBe('w49@example.invalid');
      expect(warn).toHaveBeenCalledWith('Email dispatch failed [status=422, validation_error]');
      expect(told).toEqual([false]);
      expect(store.rows[0]).toMatchObject({ status: 'DONE', mailsSent: 49, mailsFailed: 49 });
    });

    it('is sent with a signal of ten seconds unless the limit is changed', async () => {
      const timeout = jest.spyOn(AbortSignal, 'timeout');
      await enqueue([entry()]);
      await delivery.idle();
      expect(timeout).toHaveBeenCalledWith(EMAIL_TIMEOUT_MS);
      expect(EMAIL_TIMEOUT_MS).toBe(10_000);
      expect((fetchMock.mock.calls[0]![1] as { signal: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
    });

    it('is given up over a real socket too; and an answer that stalls after its headers holds nothing, since the mail does not read the body', async () => {
      let requests = 0;
      const server = createServer((_req, res) => {
        requests += 1;
        // The first mail is never answered; the second gets its headers and no body (all the delivery looks at is the status); the third is answered.
        if (requests === 1) return;
        if (requests === 2) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.write('{"id":');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"id":"mail"}');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      // The delivery posts to Resend's own address; the real fetch is pointed at the server instead.
      globalThis.fetch = ((url: string, init?: RequestInit) => realFetch(String(url).replace('https://api.resend.com', base), init)) as typeof fetch;
      try {
        const warn = jest.spyOn(logOf(delivery), 'warn').mockImplementation(() => undefined);
        delivery.emailTimeoutMs = 80;
        const started = Date.now();
        const told: boolean[] = [];
        await enqueue([entry({ meta: { n: 1 } })], (delivered) => told.push(delivered));
        await enqueue([entry({ meta: { n: 2 } })], (delivered) => told.push(delivered));
        await enqueue([entry({ meta: { n: 3 } })], (delivered) => told.push(delivered));
        await delivery.idle();
        expect(requests).toBe(3);
        // The first is still to be tried; the other two went.
        expect(told).toEqual([true, true]);
        expect(Date.now() - started).toBeLessThan(2_000);
        expect(warn).toHaveBeenCalledWith('Email dispatch failed [timeout 80 ms, will be tried again]');
        expect(store.count('PENDING')).toBe(1);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  describe('a process that stops, or dies, in the middle of a queue', () => {
    it('hands the row in hand back at a packet’s end when it is stopped, and the next process finishes it: every mail once', async () => {
      const { fetchMock: fake, delivered, requests } = resend();
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const inner = fake.getMockImplementation()!;
      let calls = 0;
      fake.mockImplementation(async (url, init) => {
        calls += 1;
        if (calls === 1) await held;
        return inner(url, init) as never;
      });
      globalThis.fetch = fake as unknown as typeof fetch;
      await enqueue([wide(147)]);
      await until(() => fake.mock.calls.length === 1);
      // A deploy's SIGTERM: the packet in hand finishes, the row is handed back with its place kept.
      const stopped = delivery.onModuleDestroy();
      release();
      await stopped;
      expect(store.rows[0]).toMatchObject({ status: 'PENDING', mailDone: 1 });

      const next = make();
      next.kick();
      await next.idle();
      expect(store.rows[0]!.status).toBe('DONE');
      const id = store.rows[0]!.id;
      expect([...delivered.keys()]).toEqual([0, 1, 2].map((i) => `notice/${id}/mail/${i}`));
      expect(requests).toHaveLength(3);
      expect(delivered.size).toBe(3);
    });

    it('is taken up by another after its lease has run out, from the packet that was on its way, which Resend answers as it did: every mail once', async () => {
      const { fetchMock: fake, delivered, requests } = resend();
      const inner = fake.getMockImplementation()!;
      const dead: Array<() => void> = [];
      let calls = 0;
      fake.mockImplementation(async (url, init) => {
        calls += 1;
        // The third mail reaches Resend, and the process dies before it hears: its answer never comes.
        if (calls === 3) {
          await inner(url, init);
          return new Promise<never>((resolve) => dead.push(() => resolve({ ok: true, status: 200 } as never)));
        }
        return inner(url, init) as never;
      });
      globalThis.fetch = fake as unknown as typeof fetch;
      await enqueue([wide(196)]);
      await until(() => calls === 3);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(store.rows[0]).toMatchObject({ status: 'CLAIMED', mailDone: 2 });

      // Nobody else may take it while the lease holds.
      const other = make();
      other.kick();
      await other.idle();
      expect(requests).toHaveLength(3);

      store.forward(NOTICE_LEASE_MS + 1_000);
      other.kick();
      await other.idle();
      const id = store.rows[0]!.id;
      expect(store.rows[0]!.status).toBe('DONE');
      // The packet that was on its way went again under its key, and the fourth after it.
      expect(requests.map((r) => r.key)).toEqual([0, 1, 2, 2, 3].map((i) => `notice/${id}/mail/${i}`));
      expect([...delivered.keys()]).toEqual([0, 1, 2, 3].map((i) => `notice/${id}/mail/${i}`));
      expect(delivered.get(`notice/${id}/mail/2`)!.bcc).toHaveLength(49);

      // The process that stood still wakes up, is told no at its next step and leaves the row alone.
      dead.forEach((resolve) => resolve());
      await delivery.idle();
      expect(requests).toHaveLength(5);
      expect(store.rows[0]).toMatchObject({ status: 'DONE', mailsSent: 196 });
    });

    it('says nothing of a row it lost at the last step, and the process that finishes it sends nothing again', async () => {
      const { fetchMock: fake, requests } = resend();
      globalThis.fetch = fake as unknown as typeof fetch;
      // Its claim is told no when it comes to finish: another process holds the row now.
      jest.spyOn(store, 'finish').mockResolvedValueOnce(false);
      const told: boolean[] = [];
      await enqueue([wide(49)], (delivered) => told.push(delivered));
      await delivery.idle();
      expect(told).toEqual([]);
      expect(requests).toHaveLength(1);
      expect(store.rows[0]).toMatchObject({ status: 'CLAIMED', mailDone: 1 });

      // The next process takes it up after the lease, sees every packet done and only finishes it.
      store.forward(NOTICE_LEASE_MS + 1_000);
      const other = make();
      other.kick();
      await other.idle();
      expect(requests).toHaveLength(1);
      expect(store.rows[0]!.status).toBe('DONE');
    });

    it('does not send a packet twice because two processes ask for it at once', async () => {
      const { fetchMock: fake, delivered, requests } = resend();
      globalThis.fetch = fake as unknown as typeof fetch;
      const other = make();
      await Promise.all([enqueue([wide(98)]), enqueue([wide(98, {}, 'x')])]);
      other.kick();
      delivery.kick();
      await Promise.all([delivery.idle(), other.idle()]);
      expect(requests).toHaveLength(4);
      expect(delivered.size).toBe(4);
      expect(store.count('DONE')).toBe(2);
    });
  });

  describe('telling the sender how the batch went', () => {
    it('says true when Resend took every mail, after the last one', async () => {
      const told: boolean[] = [];
      await enqueue([wide(98)], (delivered) => told.push(delivered));
      expect(told).toEqual([]);
      await delivery.idle();
      expect(told).toEqual([true]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('says true at once for a batch with nothing to deliver, and never twice', async () => {
      const told: boolean[] = [];
      await enqueue([], (delivered) => told.push(delivered));
      expect(told).toEqual([true]);
      // An opt-out of everybody leaves no mail: the inbox row is the whole delivery.
      tx.$queryRaw.mockResolvedValue([{ user_id: 'u1' }, { user_id: 'u2' }]);
      await enqueue([entry()], (delivered) => told.push(delivered));
      await delivery.idle();
      expect(told).toEqual([true, true]);
    });

    it('says false for a status Resend refuses with for good, although the lane goes on', async () => {
      jest.spyOn(logOf(delivery), 'warn').mockImplementation(() => undefined);
      fetchMock.mockResolvedValueOnce({ ok: false, status: 422 });
      const told: boolean[] = [];
      await enqueue([entry()], (delivered) => told.push(delivered));
      await enqueue([entry()], (delivered) => told.push(delivered));
      await delivery.idle();
      expect(told).toEqual([false, true]);
    });

    it('is told once for a batch that is split between the lanes, true only if both went', async () => {
      const told: boolean[] = [];
      const alarm = entry({ type: 'CRISIS_ALARM', meta: {}, email: { subject: 'A', body: 'B', recipients: [{ userId: 'u1', email: 'u1@example.invalid' }] } });
      await enqueue([alarm, entry()], (delivered) => told.push(delivered));
      await delivery.idle();
      expect(told).toEqual([true]);

      jest.spyOn(logOf(delivery), 'warn').mockImplementation(() => undefined);
      fetchMock.mockResolvedValueOnce({ ok: false, status: 400 });
      await enqueue([alarm, entry()], (delivered) => told.push(delivered));
      await delivery.idle();
      expect(told).toEqual([true, false]);
    });

    it('does not let a listener that throws stop the lane', async () => {
      const warn = jest.spyOn(logOf(delivery), 'warn').mockImplementation(() => undefined);
      await enqueue([entry()], () => {
        throw new RangeError('listener');
      });
      await enqueue([entry()]);
      await delivery.idle();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith('A delivery listener failed [RangeError]');
    });

    it('is not told by a process that did not write the batch: another’s row is delivered without a word', async () => {
      const told: boolean[] = [];
      await enqueue([entry()], (delivered) => told.push(delivered));
      // Another process takes the row before this one's lane does.
      const other = make();
      store.rows[0]!.createdAt -= 1;
      await Promise.all([other.tick(), delivery.idle()]);
      await delivery.idle();
      expect(store.count('DONE')).toBe(1);
      expect(told.length).toBeLessThanOrEqual(1);
    });
  });

  describe('the job', () => {
    it('is registered with the runner when something can be sent, and a pass counts what it did', async () => {
      const registered: Array<{ name: string; intervalMs: number }> = [];
      const settled: Array<{ name: string; counts: Record<string, number> }> = [];
      const jobs = {
        register: (definition: { name: string; intervalMs: number }) => registered.push(definition),
        unregister: jest.fn(),
        settled: (name: string, _at: Date, outcome: { counts?: Record<string, number> }) => settled.push({ name, counts: outcome.counts ?? {} }),
      };
      const withJobs = new NotificationDeliveryService(prisma as unknown as PrismaService, undefined, undefined, jobs as never, store);
      withJobs.emailIntervalMs = 0;
      withJobs.onModuleInit();
      expect(registered).toEqual([{ name: 'notice-delivery', intervalMs: 10_000, tick: expect.any(Function) }]);
      withAddresses(store, [entry()]);
      await store.enqueue({ schoolId: SCHOOL, urgent: false, entries: [{ type: 'LESSON_CANCELLED', meta: {}, n: 2, email: { subject: 'S', body: 'B' } }], recipientIds: ['u1', 'u2'], notificationIds: ['n1', 'n2'] });
      await withJobs.tick();
      // The first pass also sweeps, and says what it gave up and removed.
      expect(settled).toEqual([{ name: 'notice-delivery', counts: { claimed: 1, done: 1, gaveUp: 0, deleted: 0 } }]);
      await withJobs.onModuleDestroy();
      expect(jobs.unregister).toHaveBeenCalledWith('notice-delivery');
    });

    it('looks at the queue a moment after the start, for what the process before it left, and does not wait an interval', async () => {
      jest.useFakeTimers();
      try {
        const jobs = { register: jest.fn(), unregister: jest.fn(), settled: jest.fn() };
        const booted = new NotificationDeliveryService(prisma as unknown as PrismaService, undefined, undefined, jobs as never, store);
        booted.emailIntervalMs = 0;
        store.directory.set('u1', 'u1@example.invalid');
        await store.enqueue({ schoolId: SCHOOL, urgent: false, entries: [{ type: 'LESSON_CANCELLED', meta: {}, n: 1, email: { subject: 'S', body: 'B' } }], recipientIds: ['u1'], notificationIds: ['n1'] });
        booted.onModuleInit();
        expect(fetchMock).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(2_500);
        await booted.idle();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(store.rows[0]!.status).toBe('DONE');
      } finally {
        jest.useRealTimers();
      }
    });

    it('is registered where nothing can be sent too, and its pass takes no row but sweeps: what a key that is gone left is given up and emptied', async () => {
      delete process.env.RESEND_API_KEY;
      const registered: Array<{ name: string; tick: () => Promise<void> }> = [];
      const jobs = { register: (definition: { name: string; tick: () => Promise<void> }) => registered.push(definition), unregister: jest.fn(), settled: jest.fn() };
      new NotificationDeliveryService(prisma as unknown as PrismaService, undefined, undefined, jobs as never, store).onModuleInit();
      expect(registered.map((job) => job.name)).toEqual(['notice-delivery']);
      const claim = jest.spyOn(store, 'claim');
      const sweep = jest.spyOn(store, 'sweep');
      await registered[0]!.tick();
      expect(sweep).toHaveBeenCalledTimes(1);
      expect(claim).not.toHaveBeenCalled();
    });
  });
});

describe('NotificationDeliveryService (push)', () => {
  let tx: TxMock;
  let prisma: ReturnType<typeof createPrismaMock>;
  let store: MemoryOutbound;
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
    store = new MemoryOutbound();
    expo = {
      send: jest.fn(async (messages: unknown[]) => messages.map((_m, i) => ({ status: 'ok', id: `ticket-${i}-abc` }))),
      receipts: jest.fn(),
    };
    delivery = new NotificationDeliveryService(prisma as unknown as PrismaService, config as never, expo as never, undefined, store);
    delivery.pushIntervalMs = 0;
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
    delete process.env.RESEND_API_KEY;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    jest.restoreAllMocks();
  });

  const lesson = (overrides: Partial<OutboxEntry> = {}): OutboxEntry => entry({ email: undefined, ...overrides });

  it('does nothing about push while it is off: no query, no Expo call, no row', async () => {
    enabled = false;
    expect(delivery.pushEnabled()).toBe(false);
    expect(delivery.wants({ type: 'LESSON_CANCELLED' })).toBe(false);
    await delivery.enqueue([lesson()]);
    await delivery.idle();
    expect(prisma.withDeliveryService).not.toHaveBeenCalled();
    expect(expo.send).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.rows).toHaveLength(0);
  });

  it('wants every notice but a teacher’s absence report once push is on, even without e-mail', () => {
    expect(delivery.wants({ type: 'LESSON_CANCELLED' })).toBe(true);
    expect(delivery.wants({ type: 'TEACHER_ABSENCE_REPORTED' })).toBe(false);
    expect(new NotificationDeliveryService(prisma as unknown as PrismaService, config as never).pushEnabled()).toBe(false);
  });

  it('asks for a whole-school digest’s devices 500 people at a time, and pushes each of them once', async () => {
    const people = Array.from({ length: 1203 }, (_, i) => `p${i}`);
    targets = people.map((id) => ({ token_id: `t-${id}`, user_id: id, token: `ExponentPushToken[${id}aaaaaaaa]`, locale: 'sv', timezone: 'Europe/Stockholm' }));
    const chunk = (from: number, to: number) =>
      lesson({
        type: 'CANCELLATION_DIGEST',
        meta: { lessonCount: 2, startDate: '2026-10-19', endDate: '2026-10-20', name: 'Prao åk 9' },
        recipients: people.slice(from, to).map((userId) => ({ userId, notificationId: `n-${userId}` })),
      });
    await delivery.enqueue([chunk(0, 500), chunk(500, 1000), chunk(1000, 1203)]);
    await delivery.idle();
    expect(targetCalls.map((call) => (call.values[1] as string[]).length)).toEqual([500, 500, 203]);
    const sent = expo.send.mock.calls.flatMap(([messages]) => messages as Array<{ to: string; body: string }>);
    expect(sent).toHaveLength(1203);
    expect(new Set(sent.map((message) => message.to)).size).toBe(1203);
    expect(sent[0]!.body).toBe('2 lektioner 19 okt–20 okt är inställda.');
    // Expo takes a hundred in a request: thirteen of them, and the last holds the rest.
    expect(expo.send.mock.calls.map(([messages]) => (messages as unknown[]).length)).toEqual([...Array(12).fill(100), 3]);
  });

  it('gives each device its owner’s notices and no one else’s, in the order they arrived, once per device, and nothing to a row nobody asked about', async () => {
    // One group (the same type and opt-out rule) holding two kinds: a digest and its reversal.
    const digest = (extra: Record<string, unknown>, recipients: Array<{ userId: string; notificationId: string }>) =>
      lesson({ type: 'CANCELLATION_DIGEST', meta: { lessonCount: 2, startDate: '2026-10-19', endDate: '2026-10-20', ...extra }, recipients });
    const device = (id: string, user: string, locale: string) => ({ token_id: `t-${id}`, user_id: user, token: `ExponentPushToken[${id}]`, locale, timezone: 'Europe/Stockholm' });
    // The rows come back in an order of their own, with one for a person nobody asked about.
    targets = [device('u1-sv', 'u1', 'sv'), device('stray', 'stray', 'sv'), device('u2', 'u2', 'sv'), device('u1-en', 'u1', 'en'), device('u3', 'u3', 'en')];
    tx.$queryRaw.mockImplementation(async (sql: { strings: string[]; values: unknown[] }) => {
      if (!sql.strings.join('?').includes('app.push_targets(')) return [];
      targetCalls.push(sql);
      return targets;
    });
    await delivery.enqueue([
      digest({ reversed: true }, [{ userId: 'u1', notificationId: 'n-r1' }, { userId: 'u3', notificationId: 'n-r3' }]),
      digest({}, [{ userId: 'u1', notificationId: 'n-d1' }, { userId: 'u2', notificationId: 'n-d2' }, { userId: 'u1', notificationId: 'n-d1-again' }]),
    ]);
    await delivery.idle();
    expect(targetCalls.map((call) => call.values[1])).toEqual([['u1', 'u3', 'u2']]);
    const sent = expo.send.mock.calls.flatMap(([messages]) => messages as Array<{ to: string; title: string; data: { notificationId: string } }>);
    expect(sent.map((m) => [m.to, m.data.notificationId])).toEqual([
      ['ExponentPushToken[u1-sv]', 'n-r1'],
      ['ExponentPushToken[u1-sv]', 'n-d1'],
      ['ExponentPushToken[u2]', 'n-d2'],
      ['ExponentPushToken[u1-en]', 'n-r1'],
      ['ExponentPushToken[u1-en]', 'n-d1'],
      ['ExponentPushToken[u3]', 'n-r3'],
    ]);
    // Each in its device's language: the same two kinds, told twice.
    expect(sent.map((m) => m.title)).toEqual(['Lektioner blir av', 'Inställda lektioner', 'Inställda lektioner', 'Lessons back on', 'Lessons cancelled', 'Lessons back on']);
  });

  it('sends each device its language, with only the notice id and type as data', async () => {
    await delivery.enqueue([lesson()]);
    await delivery.idle();
    expect(targetCalls).toHaveLength(1);
    expect(targetCalls[0]!.values).toEqual([SCHOOL, ['u1', 'u2'], 'LESSON_CANCELLED', false]);
    expect(expo.send).toHaveBeenCalledTimes(1);
    expect(expo.send.mock.calls[0]![0]).toEqual([
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
    expect(JSON.stringify(expo.send.mock.calls[0]![0])).not.toContain('Matematik');
  });

  it('sends an alarm and its end as an alarm: high priority, a channel of its own, a short life and time-sensitive on iOS; nothing else is', async () => {
    const alarm = (type: 'CRISIS_ALARM' | 'CRISIS_ENDED', meta: Record<string, unknown>) =>
      lesson({ type, meta: { alarmId: 'a1', kind: 'EVACUATION', mode: 'LIVE', startedAt: '2027-01-12T09:10:00.000Z', ...meta }, recipients: [{ userId: 'u1', notificationId: `n-${type}` }] });
    tx.$queryRaw.mockImplementation(async (sql: { strings: string[]; values: unknown[] }) => {
      if (!sql.strings.join('?').includes('app.push_targets(')) return [];
      targetCalls.push(sql);
      return [{ token_id: 't-u1', user_id: 'u1', token: 'ExponentPushToken[u1aaaaaaaa]', locale: 'sv', timezone: 'Europe/Stockholm' }];
    });
    await delivery.enqueue([alarm('CRISIS_ALARM', {}), alarm('CRISIS_ENDED', { endedAt: '2027-01-12T09:40:00.000Z' }), lesson()]);
    await delivery.idle();
    const sent = expo.send.mock.calls.flatMap(([messages]) => messages as Array<Record<string, unknown>>);
    const by = (type: string) => sent.find((m) => (m['data'] as { type: string }).type === type)!;
    for (const type of ['CRISIS_ALARM', 'CRISIS_ENDED']) {
      expect(by(type)).toMatchObject({ priority: 'high', channelId: 'crisis', ttl: 600, interruptionLevel: 'time-sensitive' });
    }
    expect(by('LESSON_CANCELLED')).toMatchObject({ priority: 'default', channelId: 'default', ttl: 86_400 });
    expect(by('LESSON_CANCELLED')['interruptionLevel']).toBeUndefined();
    // The alarm is a row of its own, in the lane of its own.
    expect(store.rows.map((row) => row.urgent).sort()).toEqual([false, true]);
  });

  it('asks each school for its own rows’ phones, so a login with a row at two schools hears only from the school its phone is registered at, never named', async () => {
    // A phone has one owner row, the row the app claimed it under (the school
    // the request chose); push_targets answers a school's rows' tokens only.
    const OTHER = '44444444-4444-4444-8444-444444444444';
    targets = [{ token_id: 't-a', user_id: 'row-at-a', token: 'ExponentPushToken[phoneaaaa]', locale: 'sv', timezone: 'Europe/Stockholm' }];
    tx.$queryRaw.mockImplementation(async (sql: { strings: string[]; values: unknown[] }) => {
      if (!sql.strings.join('?').includes('app.push_targets(')) return [];
      targetCalls.push(sql);
      const users = sql.values[1] as string[];
      return sql.values[0] === SCHOOL ? targets.filter((t) => users.includes(t.user_id)) : [];
    });
    await delivery.enqueue([
      lesson({ recipients: [{ userId: 'row-at-a', notificationId: 'n-a' }] }),
      lesson({ schoolId: OTHER, recipients: [{ userId: 'row-at-b', notificationId: 'n-b' }] }),
    ]);
    await delivery.idle();
    expect(targetCalls.map((call) => call.values.slice(0, 2))).toEqual([
      [SCHOOL, ['row-at-a']],
      [OTHER, ['row-at-b']],
    ]);
    const sent = expo.send.mock.calls.flatMap(([messages]) => messages as Array<{ to: string; title: string; body: string; data: { notificationId: string } }>);
    expect(sent.map((m) => [m.to, m.data.notificationId])).toEqual([['ExponentPushToken[phoneaaaa]', 'n-a']]);
    expect(sent.map((m) => `${m.title} ${m.body}`).join(' ')).not.toMatch(/skola|school/i);
  });

  it('coalesces one person’s notices of a kind in one transaction into one push', async () => {
    await delivery.enqueue([lesson(), lesson({ recipients: [{ userId: 'u1', notificationId: 'n3' }] }), lesson({ recipients: [{ userId: 'u1', notificationId: 'n4' }] })]);
    await delivery.idle();
    const sent = expo.send.mock.calls[0]![0] as Array<{ to: string; body: string; data: { notificationId: string } }>;
    expect(sent.map((m) => [m.to, m.body, m.data.notificationId])).toEqual([
      ['ExponentPushToken[aaaaaaaa]', '3 lektioner är inställda.', 'n1'],
      ['ExponentPushToken[bbbbbbbb]', 'A lesson Tue 13 Oct 08:00 is cancelled.', 'n2'],
    ]);
  });

  it('asks for a substitute’s booking with opt-outs ignored, apart from the class’s notice', async () => {
    await delivery.enqueue([
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
    const bodies = (expo.send.mock.calls[0]![0] as Array<{ body: string }>).map((m) => m.body);
    expect(bodies).toEqual([
      'A lesson Tue 13 Oct 08:00 has a substitute.',
      'Du har ett vikariepass tis 13 okt 08:00.',
      'Ett vikariepass är avbokat.',
      'Unreported absence 13 Oct. Open the app to see more.',
    ]);
  });

  it('never pushes a teacher’s absence report', async () => {
    await delivery.enqueue([lesson({ type: 'TEACHER_ABSENCE_REPORTED', meta: { teacherName: 'Karin Lund' } })]);
    await delivery.idle();
    expect(targetCalls).toHaveLength(0);
    expect(expo.send).not.toHaveBeenCalled();
  });

  it('sends nothing to a person without a live token, and settles nothing', async () => {
    targets = [];
    await delivery.enqueue([lesson()]);
    await delivery.idle();
    expect(expo.send).not.toHaveBeenCalled();
    expect(settled).toHaveLength(0);
    expect(store.count('DONE')).toBe(1);
  });

  it('stores the ok tickets and revokes a device Expo says is gone, in the school it was sent for', async () => {
    const warn = jest.spyOn(logOf(delivery), 'warn').mockImplementation(() => undefined);
    expo.send.mockResolvedValue([
      { status: 'ok', id: 'ticket-ok-1' },
      { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
    ]);
    await delivery.enqueue([lesson()]);
    await delivery.idle();
    expect(settled).toHaveLength(1);
    expect(settled[0]!.values).toEqual([SCHOOL, ['t-u2'], JSON.stringify([{ id: 'ticket-ok-1', tokenId: 't-u1' }])]);
    expect(warn).toHaveBeenCalledWith('Push tickets with errors [DeviceNotRegistered=1, sent=2]');
  });

  it('logs other ticket errors by code and settles nothing for them', async () => {
    const warn = jest.spyOn(logOf(delivery), 'warn').mockImplementation(() => undefined);
    expo.send.mockResolvedValue([{ status: 'error', details: { error: 'MessageRateExceeded' } }, { status: 'error' }]);
    await delivery.enqueue([lesson()]);
    await delivery.idle();
    expect(settled).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith('Push tickets with errors [MessageRateExceeded=1, Unknown=1, sent=2]');
  });

  it('takes its place in Expo’s pace from the database before each request', async () => {
    delivery.pushIntervalMs = 200;
    const people = Array.from({ length: 150 }, (_, i) => `p${i}`);
    targets = people.map((id) => ({ token_id: `t-${id}`, user_id: id, token: `ExponentPushToken[${id}aaaaaaaa]`, locale: 'sv', timezone: 'Europe/Stockholm' }));
    await delivery.enqueue([lesson({ recipients: people.map((userId) => ({ userId, notificationId: `n-${userId}` })) })]);
    await delivery.idle();
    expect(store.slotCalls).toEqual([
      { channel: 'PUSH', intervalMs: 200 },
      { channel: 'PUSH', intervalMs: 200 },
    ]);
  });

  describe('a process that dies in the middle of a push', () => {
    it('does not send the packet that was on its way again, and goes on with the next: at most once', async () => {
      const people = Array.from({ length: 250 }, (_, i) => `p${i}`);
      targets = people.map((id) => ({ token_id: `t-${id}`, user_id: id, token: `ExponentPushToken[${id}aaaaaaaa]`, locale: 'sv', timezone: 'Europe/Stockholm' }));
      const dead: Array<() => void> = [];
      expo.send.mockImplementationOnce(async (messages: unknown[]) => messages.map((_m, i) => ({ status: 'ok', id: `a-${i}-abc` })));
      // The second packet is on its way when the process dies: Expo never answers.
      expo.send.mockImplementationOnce(() => new Promise((resolve) => dead.push(() => resolve([]))));
      await delivery.enqueue([lesson({ recipients: people.map((userId) => ({ userId, notificationId: `n-${userId}` })) })]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(expo.send).toHaveBeenCalledTimes(2);
      expect(store.rows[0]).toMatchObject({ status: 'CLAIMED', pushDone: 2, pushSent: 100 });

      store.forward(NOTICE_LEASE_MS + 1_000);
      const next = new NotificationDeliveryService(prisma as unknown as PrismaService, config as never, expo as never, undefined, store);
      next.pushIntervalMs = 0;
      next.kick();
      await next.idle();
      // The first packet was sent once, the second began once and is not begun again, the third (50 devices) goes.
      expect(expo.send).toHaveBeenCalledTimes(3);
      expect((expo.send.mock.calls[2]![0] as unknown[]).length).toBe(50);
      expect(store.rows[0]!.status).toBe('DONE');
      // The process that stood still hears no when it wakes, and does not settle what it sent.
      dead.forEach((resolve) => resolve());
      await delivery.idle();
      expect(store.rows[0]).toMatchObject({ status: 'DONE', pushSent: 150 });
    });
  });

  describe('telling the sender how the batch went', () => {
    const told = async (batch: OutboxEntry[]): Promise<boolean[]> => {
      const answers: boolean[] = [];
      await delivery.enqueue(batch, (delivered) => answers.push(delivered));
      await delivery.idle();
      return answers;
    };

    it('says true when Expo took the request, also when it refuses one device or says one is gone', async () => {
      jest.spyOn(logOf(delivery), 'warn').mockImplementation(() => undefined);
      expect(await told([lesson()])).toEqual([true]);
      expo.send.mockResolvedValue([
        { status: 'ok', id: 'ticket-ok-1' },
        { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
      ]);
      expect(await told([lesson()])).toEqual([true]);
      expo.send.mockResolvedValue([{ status: 'error', details: { error: 'MessageRateExceeded' } }, { status: 'ok', id: 'x' }]);
      expect(await told([lesson()])).toEqual([true]);
    });

    // Expo refuses our credentials for every device alike: the request was not taken by the channel, and a reminder
    // must not read "taken" for a push no phone will get. The client's own answer for a chunk it could not get
    // through is the same kind of word.
    it.each(['InvalidCredentials', 'MismatchSenderId', 'RequestFailed'])('says false when the channel itself refuses (%s), although another ticket was ok', async (code) => {
      jest.spyOn(logOf(delivery), 'warn').mockImplementation(() => undefined);
      expo.send.mockResolvedValue([{ status: 'ok', id: 'ticket-ok-1' }, { status: 'error', details: { error: code } }]);
      expect(await told([lesson()])).toEqual([false]);
      // What was taken is still stored: the answer does not undo the ok ticket.
      expect(settled).toHaveLength(1);
      expect(settled[0]!.values[2]).toBe(JSON.stringify([{ id: 'ticket-ok-1', tokenId: 't-u1' }]));
    });

    // One device or one message: the channel took the request, and sending it again would change nothing.
    it.each(['DeviceNotRegistered', 'MessageTooBig', 'MessageRateExceeded'])('says true when Expo refuses one device or message (%s), as it took the request', async (code) => {
      jest.spyOn(logOf(delivery), 'warn').mockImplementation(() => undefined);
      expo.send.mockResolvedValue([{ status: 'ok', id: 'ticket-ok-1' }, { status: 'error', details: { error: code } }]);
      expect(await told([lesson()])).toEqual([true]);
    });

    it('says false when the settling of the tickets failed, and goes on to the next batch', async () => {
      jest.spyOn(logOf(delivery), 'warn').mockImplementation(() => undefined);
      tx.$executeRaw.mockRejectedValueOnce(new Error('connection lost'));
      const answers: boolean[] = [];
      await delivery.enqueue([lesson()], (delivered) => answers.push(delivered));
      await delivery.enqueue([lesson()], (delivered) => answers.push(delivered));
      await delivery.idle();
      expect(answers).toEqual([false, true]);
    });

    it('says true at once for a notice the push has nothing to do with, when push is off and so is e-mail', async () => {
      enabled = false;
      expect(delivery.wants({ type: 'LESSON_CANCELLED' })).toBe(false);
      const answers: boolean[] = [];
      await delivery.enqueue([], (delivered) => answers.push(delivered));
      await delivery.enqueue([lesson()], (delivered) => answers.push(delivered));
      expect(answers).toEqual([true, true]);
    });
  });
});

// A row that goes out by both channels. The two are told apart in the answer (true only when both took it) but not
// in the work: for the crisis alarm the push is what counts (its life is ten minutes, and a phone in a pocket hears
// nothing of a mail), so a mail that Resend does not take, for good or for now, must never keep the same row's push from going.
describe('NotificationDeliveryService (mail and push in one batch)', () => {
  let tx: TxMock;
  let prisma: ReturnType<typeof createPrismaMock>;
  let store: MemoryOutbound;
  let expo: { send: jest.Mock; receipts: jest.Mock };
  let delivery: NotificationDeliveryService;
  const fetchMock = jest.fn();
  const realFetch = globalThis.fetch;
  const config = { get: (key: string) => (key === 'push' ? { enabled: true, apiUrl: 'https://x.invalid' } : undefined) };

  const alarm = (): OutboxEntry =>
    entry({
      type: 'CRISIS_ALARM',
      meta: {},
      recipients: [{ userId: 'u1', notificationId: 'n1' }],
      email: { subject: 'Larm', body: 'B', recipients: [{ userId: 'u1', email: 'u1@example.invalid' }] },
    });
  const told = async (batch: OutboxEntry[]): Promise<boolean[]> => {
    const answers: boolean[] = [];
    withAddresses(store, batch);
    await delivery.enqueue(batch, (delivered) => answers.push(delivered));
    await delivery.idle();
    return answers;
  };

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    store = new MemoryOutbound();
    expo = {
      send: jest.fn(async (messages: unknown[]) => messages.map((_m, i) => ({ status: 'ok', id: `ticket-${i}-abc` }))),
      receipts: jest.fn(),
    };
    delivery = new NotificationDeliveryService(prisma as unknown as PrismaService, config as never, expo as never, undefined, store);
    delivery.emailIntervalMs = 0;
    delivery.pushIntervalMs = 0;
    jest.spyOn(logOf(delivery), 'warn').mockImplementation(() => undefined);
    tx.$queryRaw.mockImplementation(async (sql: { strings: string[] }) =>
      sql.strings.join('?').includes('app.push_targets(')
        ? [{ token_id: 't-u1', user_id: 'u1', token: 'ExponentPushToken[aaaaaaaa]', locale: 'sv', timezone: 'Europe/Stockholm' }]
        : [],
    );
    tx.$executeRaw.mockResolvedValue(1);
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    process.env.RESEND_API_KEY = 'resend-key';
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.RESEND_API_KEY;
    jest.restoreAllMocks();
  });

  it('sends the push although the mail of the same row was refused for good, and tells the batch false, once', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 422 });
    expect(await told([alarm()])).toEqual([false]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(expo.send).toHaveBeenCalledTimes(1);
    expect(expo.send.mock.calls[0]![0]).toHaveLength(1);
  });

  it('sends the push although the mail must wait (Resend is down), and the row is handed back for the mail alone', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    // Nothing is told: the mail is still to go.
    expect(await told([alarm()])).toEqual([]);
    expect(expo.send).toHaveBeenCalledTimes(1);
    expect(store.rows[0]).toMatchObject({ status: 'PENDING', mailDone: 0, pushDone: 1 });

    // After its wait the mail goes, and the push is not sent again.
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    store.forward(31_000);
    delivery.kick();
    await delivery.idle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(expo.send).toHaveBeenCalledTimes(1);
    expect(store.rows[0]!.status).toBe('DONE');
  });

  it('sends the mail although the push was refused, and tells the batch false', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    expo.send.mockResolvedValue([{ status: 'error', details: { error: 'InvalidCredentials' } }]);
    expect(await told([alarm()])).toEqual([false]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('tells the batch true only when both channels took it', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    expect(await told([alarm()])).toEqual([true]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(expo.send).toHaveBeenCalledTimes(1);
  });

  // The order is today's, and it is pinned so that changing it is a decision and not a slip: the push comes after the
  // row's mails when both can go, so a Resend that does not answer holds an alarm's push for up to the mail timeout.
  // A mail that must wait for a retry does not hold it (above). Sending the push first would take the first wait away;
  // this test is the one to change with it.
  it('sends the row’s mails first and its push after them', async () => {
    const order: string[] = [];
    fetchMock.mockImplementation(async () => {
      order.push('mail');
      return { ok: true, status: 200 };
    });
    expo.send.mockImplementation(async (messages: unknown[]) => {
      order.push('push');
      return messages.map((_m, i) => ({ status: 'ok', id: `ticket-${i}-abc` }));
    });
    expect(await told([alarm()])).toEqual([true]);
    expect(order).toEqual(['mail', 'push']);
  });
});
