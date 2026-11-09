import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from '@nestjs/common';
import { createPrismaMock, createTxMock, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { EMAIL_TIMEOUT_MS, MAX_PENDING_BATCHES, NotificationDeliveryService } from './notification-delivery.service';
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
    // The provider's pacing is its own test (notifications.service.spec.ts).
    delivery.emailIntervalMs = 0;
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

  describe('an alarm and a wave', () => {
    const waveOf = (subject: string) =>
      entry({
        email: { subject, body: 'B', recipients: Array.from({ length: 98 }, (_, i) => ({ userId: `u${i}`, email: `u${i}@example.invalid` })) },
      });
    const alarm = (subject = 'ALARM') =>
      entry({ type: 'CRISIS_ALARM', meta: {}, email: { subject, body: 'B', recipients: [{ userId: 'u1', email: 'u1@example.invalid' }] } });
    const subjectOf = (call: unknown[]) => (JSON.parse((call[1] as { body: string }).body) as { subject: string }).subject;
    const until = async (condition: () => boolean) => {
      for (let i = 0; i < 500 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 2));
      expect(condition()).toBe(true);
    };

    it('lets an alarm go beside a wave that is in the middle of its mails, not after it', async () => {
      // A request to a whole school is some 4 000 notices and 82 mails; the alarm's push lives ten minutes.
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
        if ((JSON.parse(init.body) as { subject: string }).subject === 'WAVE') await held;
        return { ok: true, status: 200 };
      });
      delivery.enqueue([waveOf('WAVE')]);
      delivery.enqueue([waveOf('NEXT WAVE')]);
      await until(() => fetchMock.mock.calls.length === 1);
      delivery.enqueue([alarm()]);
      await until(() => fetchMock.mock.calls.some((call) => subjectOf(call) === 'ALARM'));
      // The first wave is still held in its first mail, and the second has not started.
      expect(fetchMock.mock.calls.map(subjectOf)).toEqual(['WAVE', 'ALARM']);
      release();
      await delivery.idle();
      expect(fetchMock.mock.calls.map(subjectOf).filter((subject) => subject === 'NEXT WAVE')).toHaveLength(2);
    });

    it('splits a transaction’s notices by type: the alarm in it goes the urgent way, the rest wait their turn', async () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
        if ((JSON.parse(init.body) as { subject: string }).subject === 'WAVE') await held;
        return { ok: true, status: 200 };
      });
      delivery.enqueue([waveOf('WAVE')]);
      await until(() => fetchMock.mock.calls.length === 1);
      delivery.enqueue([entry({ email: { subject: 'LESSON', body: 'B', recipients: [{ userId: 'u9', email: 'u9@example.invalid' }] } }), alarm()]);
      await until(() => fetchMock.mock.calls.some((call) => subjectOf(call) === 'ALARM'));
      expect(fetchMock.mock.calls.map(subjectOf)).toEqual(['WAVE', 'ALARM']);
      release();
      await delivery.idle();
      expect(fetchMock.mock.calls.map(subjectOf)).toEqual(['WAVE', 'ALARM', 'WAVE', 'LESSON']);
    });

    it('keeps the provider’s pace across both lanes: one mail at most every interval, whichever lane sends it', async () => {
      delivery.emailIntervalMs = 40;
      const sentAt: number[] = [];
      fetchMock.mockImplementation(async () => {
        sentAt.push(Date.now());
        return { ok: true, status: 200 };
      });
      delivery.enqueue([waveOf('WAVE')]);
      delivery.enqueue([alarm('A1')]);
      delivery.enqueue([alarm('A2')]);
      await delivery.idle();
      expect(sentAt).toHaveLength(4);
      const gaps = sentAt.slice(1).map((at, i) => at - sentAt[i]!);
      for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(35);
    });

    it('counts the interval from when a mail really went, not from when it was planned: a late timer does not bring two mails closer', async () => {
      delivery.emailIntervalMs = 40;
      const sentAt: number[] = [];
      fetchMock.mockImplementation(async () => {
        sentAt.push(Date.now());
        return { ok: true, status: 200 };
      });
      // A wave of two mails; its second waits 40 ms for its turn. While it waits the event loop is stuck for 60 ms (a busy host),
      // so that timer fires late, at about 65 ms, and an alarm queued meanwhile must not go at 80 as the wave's planned slots say.
      delivery.enqueue([waveOf('WAVE')]);
      await until(() => sentAt.length === 1);
      setTimeout(() => {
        const stuckUntil = Date.now() + 60;
        while (Date.now() < stuckUntil) {
          /* a busy host */
        }
      }, 5);
      delivery.enqueue([alarm()]);
      await delivery.idle();
      expect(sentAt).toHaveLength(3);
      const gaps = sentAt.slice(1).map((at, i) => at - sentAt[i]!);
      for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(37);
    });

    it('bounds each lane on its own: a full ordinary lane does not refuse an alarm', async () => {
      const warn = jest.spyOn((delivery as unknown as { logger: Logger }).logger, 'warn').mockImplementation(() => undefined);
      fetchMock.mockImplementation(() => new Promise(() => undefined));
      for (let i = 0; i <= MAX_PENDING_BATCHES + 1; i++) delivery.enqueue([entry()]);
      warn.mockClear();
      delivery.enqueue([alarm()]);
      expect(warn).not.toHaveBeenCalled();
      for (let i = 0; i <= MAX_PENDING_BATCHES + 1; i++) delivery.enqueue([alarm()]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('lane=urgent'));
    });
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

  describe('a turn in the mail chain that throws', () => {
    it('costs the mail it was for and not the process’s e-mail: the next mail goes', async () => {
      const warn = jest.spyOn((delivery as unknown as { logger: Logger }).logger, 'warn').mockImplementation(() => undefined);
      // A BigInt interval makes the turn's arithmetic throw (a TypeError), once the interval is back to a number nothing does.
      delivery.emailIntervalMs = 10n as unknown as number;
      delivery.enqueue([entry({ meta: { n: 'refused' } })]);
      await delivery.idle();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith('Email dispatch skipped [turn, TypeError]');

      delivery.emailIntervalMs = 0;
      delivery.enqueue([entry({ meta: { n: 'next' } })]);
      await delivery.idle();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(bccOf(0)).toEqual(['u1@example.invalid', 'u2@example.invalid']);
    });

    it('goes on to the next mail of the same batch, and the mails behind it in the queue', async () => {
      let turns = 0;
      const turn = jest.spyOn(Date, 'now').mockImplementation(() => {
        turns += 1;
        // The first turn's first reading throws; everything else reads the clock as usual.
        if (turns === 1) throw new RangeError('clock');
        return performance.timeOrigin + performance.now();
      });
      try {
        const wide = entry({ email: { subject: 'S', body: 'B', recipients: Array.from({ length: 98 }, (_v, i) => ({ userId: `w${i}`, email: `w${i}@example.invalid` })) } });
        delivery.enqueue([wide]);
        delivery.enqueue([entry({ meta: { n: 'after' } })]);
        await delivery.idle();
      } finally {
        turn.mockRestore();
      }
      // Two mails for the wide entry (the first turn threw, so one is lost) and one for the batch after it.
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('a mail Resend does not answer', () => {
    /** A fetch that answers nothing, and rejects the way fetch does when its signal aborts. */
    const silent = (_url: string, init: { signal: AbortSignal }) =>
      new Promise<never>((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));

    it('is given up after the limit, so the lane goes on to the next mail instead of waiting minutes', async () => {
      const warn = jest.spyOn((delivery as unknown as { logger: Logger }).logger, 'warn').mockImplementation(() => undefined);
      delivery.emailTimeoutMs = 25;
      fetchMock.mockImplementationOnce(silent);
      const started = Date.now();
      delivery.enqueue([entry({ meta: { n: 'hangs' } })]);
      delivery.enqueue([entry({ meta: { n: 'goes' } })]);
      await delivery.idle();
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith('Email dispatch failed [timeout 25 ms]');
      // Logged without an address, a subject or a text.
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/example\.invalid|"S"|"B"/);
    });

    it('is sent with a signal of ten seconds unless the limit is changed', async () => {
      const timeout = jest.spyOn(AbortSignal, 'timeout');
      delivery.enqueue([entry()]);
      await delivery.idle();
      expect(timeout).toHaveBeenCalledWith(EMAIL_TIMEOUT_MS);
      expect(EMAIL_TIMEOUT_MS).toBe(10_000);
      expect((fetchMock.mock.calls[0][1] as { signal: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
      timeout.mockRestore();
    });

    it('is given up over a real socket too; and an answer that stalls after its headers holds nothing, since the mail does not read the body', async () => {
      const server = createServer((req, res) => {
        requests += 1;
        // The first mail is never answered; the second gets its headers and no body (all the service looks at is the status); the third is answered.
        if (requests === 1) return;
        if (requests === 2) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.write('{"id":');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"id":"mail"}');
      });
      let requests = 0;
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      // The service posts to Resend's own address; the real fetch is pointed at the server instead.
      globalThis.fetch = ((url: string, init?: RequestInit) => realFetch(String(url).replace('https://api.resend.com', base), init)) as typeof fetch;
      try {
        const warn = jest.spyOn((delivery as unknown as { logger: Logger }).logger, 'warn').mockImplementation(() => undefined);
        delivery.emailTimeoutMs = 80;
        const started = Date.now();
        const told: boolean[] = [];
        delivery.enqueue([entry({ meta: { n: 1 } })], (delivered) => told.push(delivered));
        delivery.enqueue([entry({ meta: { n: 2 } })], (delivered) => told.push(delivered));
        delivery.enqueue([entry({ meta: { n: 3 } })], (delivered) => told.push(delivered));
        await delivery.idle();
        expect(requests).toBe(3);
        expect(told).toEqual([false, true, true]);
        expect(Date.now() - started).toBeLessThan(2_000);
        expect(warn).toHaveBeenCalledWith('Email dispatch failed [timeout 80 ms]');
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('is a refused mail like any other: not sent again, and the rest of the batch goes', async () => {
      delivery.emailTimeoutMs = 25;
      fetchMock.mockImplementationOnce(silent);
      const wide = entry({ email: { subject: 'S', body: 'B', recipients: Array.from({ length: 98 }, (_v, i) => ({ userId: `w${i}`, email: `w${i}@example.invalid` })) } });
      delivery.enqueue([wide]);
      await delivery.idle();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(bccOf(1)).toHaveLength(49);
      expect(bccOf(1)[0]).toBe('w49@example.invalid');
    });
  });

  describe('telling the sender how the batch went', () => {
    it('says true when Resend took every mail, after the last one', async () => {
      const told: boolean[] = [];
      const wide = entry({ email: { subject: 'S', body: 'B', recipients: Array.from({ length: 98 }, (_v, i) => ({ userId: `w${i}`, email: `w${i}@example.invalid` })) } });
      delivery.enqueue([wide], (delivered) => told.push(delivered));
      expect(told).toEqual([]);
      await delivery.idle();
      expect(told).toEqual([true]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('says true at once for a batch with nothing to deliver, and never twice', async () => {
      const told: boolean[] = [];
      delivery.enqueue([], (delivered) => told.push(delivered));
      expect(told).toEqual([true]);
      // An opt-out of everybody leaves no mail: the inbox row is the whole delivery.
      tx.$queryRaw.mockResolvedValue([{ user_id: 'u1' }, { user_id: 'u2' }]);
      delivery.enqueue([entry()], (delivered) => told.push(delivered));
      await delivery.idle();
      expect(told).toEqual([true, true]);
    });

    it.each([
      ['a status Resend refuses with', () => fetchMock.mockResolvedValueOnce({ ok: false, status: 422 })],
      ['a connection that fails', () => fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'))],
      ['no answer in time', () => fetchMock.mockImplementationOnce((_u: string, init: { signal: AbortSignal }) => new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))))],
    ])('says false for %s, although the lane goes on', async (_name, fail) => {
      jest.spyOn((delivery as unknown as { logger: Logger }).logger, 'warn').mockImplementation(() => undefined);
      delivery.emailTimeoutMs = 25;
      fail();
      const told: boolean[] = [];
      delivery.enqueue([entry()], (delivered) => told.push(delivered));
      delivery.enqueue([entry()], (delivered) => told.push(delivered));
      await delivery.idle();
      expect(told).toEqual([false, true]);
    });

    it('says false for a batch whose delivery threw, and for one the full queue refused', async () => {
      jest.spyOn((delivery as unknown as { logger: Logger }).logger, 'warn').mockImplementation(() => undefined);
      prisma.withDeliveryService.mockRejectedValueOnce(new TypeError('boom'));
      const told: boolean[] = [];
      delivery.enqueue([entry()], (delivered) => told.push(delivered));
      await delivery.idle();
      expect(told).toEqual([false]);

      fetchMock.mockImplementation(() => new Promise(() => undefined));
      for (let i = 0; i <= MAX_PENDING_BATCHES; i++) delivery.enqueue([entry()]);
      delivery.enqueue([entry()], (delivered) => told.push(delivered));
      expect(told).toEqual([false, false]);
    });

    it('is told once for a batch that is split between the lanes, true only if both went', async () => {
      const told: boolean[] = [];
      const alarm = entry({ type: 'CRISIS_ALARM', meta: {}, email: { subject: 'A', body: 'B', recipients: [{ userId: 'u1', email: 'u1@example.invalid' }] } });
      delivery.enqueue([alarm, entry()], (delivered) => told.push(delivered));
      await delivery.idle();
      expect(told).toEqual([true]);

      jest.spyOn((delivery as unknown as { logger: Logger }).logger, 'warn').mockImplementation(() => undefined);
      fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
      delivery.enqueue([alarm, entry()], (delivered) => told.push(delivered));
      await delivery.idle();
      expect(told).toEqual([true, false]);
    });

    it('does not let a listener that throws stop the lane', async () => {
      const warn = jest.spyOn((delivery as unknown as { logger: Logger }).logger, 'warn').mockImplementation(() => undefined);
      delivery.enqueue([entry()], () => {
        throw new RangeError('listener');
      });
      delivery.enqueue([entry()]);
      await delivery.idle();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith('A delivery listener failed [RangeError]');
    });
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

  it('asks for a whole-school digest’s devices 500 people at a time, and pushes each of them once', async () => {
    const people = Array.from({ length: 1203 }, (_, i) => `p${i}`);
    targets = people.map((id) => ({ token_id: `t-${id}`, user_id: id, token: `ExponentPushToken[${id}aaaaaaaa]`, locale: 'sv', timezone: 'Europe/Stockholm' }));
    const chunk = (from: number, to: number) =>
      lesson({
        type: 'CANCELLATION_DIGEST',
        meta: { lessonCount: 2, startDate: '2026-10-19', endDate: '2026-10-20', name: 'Prao åk 9' },
        recipients: people.slice(from, to).map((userId) => ({ userId, notificationId: `n-${userId}` })),
      });
    delivery.enqueue([chunk(0, 500), chunk(500, 1000), chunk(1000, 1203)]);
    await delivery.idle();
    expect(targetCalls.map((call) => (call.values[1] as string[]).length)).toEqual([500, 500, 203]);
    const sent = expo.send.mock.calls.flatMap(([messages]) => messages as Array<{ to: string; body: string }>);
    expect(sent).toHaveLength(1203);
    expect(new Set(sent.map((message) => message.to)).size).toBe(1203);
    expect(sent[0]!.body).toBe('2 lektioner 19 okt–20 okt är inställda.');
  });

  it('gives each device its owner’s notices and no one else’s, in the order they arrived, once per device, and nothing to a row nobody asked about', async () => {
    // One group (the same school, type and opt-out rule) holding two kinds: a digest and its reversal.
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
    delivery.enqueue([
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

  it('sends an alarm and its end as an alarm: high priority, a channel of its own, a short life and time-sensitive on iOS; nothing else is', async () => {
    const alarm = (type: 'CRISIS_ALARM' | 'CRISIS_ENDED', meta: Record<string, unknown>) =>
      lesson({ type, meta: { alarmId: 'a1', kind: 'EVACUATION', mode: 'LIVE', startedAt: '2027-01-12T09:10:00.000Z', ...meta }, recipients: [{ userId: 'u1', notificationId: `n-${type}` }] });
    tx.$queryRaw.mockImplementation(async (sql: { strings: string[]; values: unknown[] }) => {
      if (!sql.strings.join('?').includes('app.push_targets(')) return [];
      targetCalls.push(sql);
      return [{ token_id: 't-u1', user_id: 'u1', token: 'ExponentPushToken[u1aaaaaaaa]', locale: 'sv', timezone: 'Europe/Stockholm' }];
    });
    delivery.enqueue([alarm('CRISIS_ALARM', {}), alarm('CRISIS_ENDED', { endedAt: '2027-01-12T09:40:00.000Z' }), lesson()]);
    await delivery.idle();
    const sent = expo.send.mock.calls.flatMap(([messages]) => messages as Array<Record<string, unknown>>);
    const by = (type: string) => sent.find((m) => (m['data'] as { type: string }).type === type)!;
    for (const type of ['CRISIS_ALARM', 'CRISIS_ENDED']) {
      expect(by(type)).toMatchObject({ priority: 'high', channelId: 'crisis', ttl: 600, interruptionLevel: 'time-sensitive' });
    }
    expect(by('LESSON_CANCELLED')).toMatchObject({ priority: 'default', channelId: 'default', ttl: 86_400 });
    expect(by('LESSON_CANCELLED')['interruptionLevel']).toBeUndefined();
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
    delivery.enqueue([
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
      'Unreported absence 13 Oct. Open the app to see more.',
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

  describe('telling the sender how the batch went', () => {
    const told = async (batch: OutboxEntry[]): Promise<boolean[]> => {
      const answers: boolean[] = [];
      delivery.enqueue(batch, (delivered) => answers.push(delivered));
      await delivery.idle();
      return answers;
    };

    it('says true when Expo took the request, also when it refuses one device or says one is gone', async () => {
      jest.spyOn((delivery as unknown as { logger: Logger }).logger, 'warn').mockImplementation(() => undefined);
      expect(await told([lesson()])).toEqual([true]);
      expo.send.mockResolvedValue([
        { status: 'ok', id: 'ticket-ok-1' },
        { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
      ]);
      expect(await told([lesson()])).toEqual([true]);
      expo.send.mockResolvedValue([{ status: 'error', details: { error: 'MessageRateExceeded' } }, { status: 'ok', id: 'x' }]);
      expect(await told([lesson()])).toEqual([true]);
    });

    it('says false when the client could not get a chunk through (it answers RequestFailed, as it does after a timeout)', async () => {
      jest.spyOn((delivery as unknown as { logger: Logger }).logger, 'warn').mockImplementation(() => undefined);
      expo.send.mockResolvedValue([{ status: 'ok', id: 'ticket-ok-1' }, { status: 'error', details: { error: 'RequestFailed' } }]);
      expect(await told([lesson()])).toEqual([false]);
    });

    // Expo refuses our credentials for every device alike: the request was not taken by the channel, and a reminder
    // must not read "taken" for a push no phone will get. The client's own answer for a chunk it could not get
    // through is the same kind of word.
    it.each(['InvalidCredentials', 'MismatchSenderId', 'RequestFailed'])('says false when the channel itself refuses (%s), although another ticket was ok', async (code) => {
      jest.spyOn((delivery as unknown as { logger: Logger }).logger, 'warn').mockImplementation(() => undefined);
      expo.send.mockResolvedValue([{ status: 'ok', id: 'ticket-ok-1' }, { status: 'error', details: { error: code } }]);
      expect(await told([lesson()])).toEqual([false]);
      // What was taken is still stored: the answer does not undo the ok ticket.
      expect(settled).toHaveLength(1);
      expect(settled[0]!.values[2]).toBe(JSON.stringify([{ id: 'ticket-ok-1', tokenId: 't-u1' }]));
    });

    // One device or one message: the channel took the request, and sending it again would change nothing.
    it.each(['DeviceNotRegistered', 'MessageTooBig', 'MessageRateExceeded'])('says true when Expo refuses one device or message (%s), as it took the request', async (code) => {
      jest.spyOn((delivery as unknown as { logger: Logger }).logger, 'warn').mockImplementation(() => undefined);
      expo.send.mockResolvedValue([{ status: 'ok', id: 'ticket-ok-1' }, { status: 'error', details: { error: code } }]);
      expect(await told([lesson()])).toEqual([true]);
    });

    it('says false for a channel refusal among device refusals, and true when only the device ones are there', async () => {
      jest.spyOn((delivery as unknown as { logger: Logger }).logger, 'warn').mockImplementation(() => undefined);
      expo.send.mockResolvedValue([{ status: 'error', details: { error: 'MessageRateExceeded' } }, { status: 'error', details: { error: 'InvalidCredentials' } }]);
      expect(await told([lesson()])).toEqual([false]);
      expo.send.mockResolvedValue([{ status: 'error', details: { error: 'MessageTooBig' } }, { status: 'error', details: { error: 'DeviceNotRegistered' } }]);
      expect(await told([lesson()])).toEqual([true]);
    });

    it('says false when the settling of the tickets failed, and goes on to the next batch', async () => {
      jest.spyOn((delivery as unknown as { logger: Logger }).logger, 'warn').mockImplementation(() => undefined);
      tx.$executeRaw.mockRejectedValueOnce(new Error('connection lost'));
      const answers: boolean[] = [];
      delivery.enqueue([lesson()], (delivered) => answers.push(delivered));
      delivery.enqueue([lesson()], (delivered) => answers.push(delivered));
      await delivery.idle();
      expect(answers).toEqual([false, true]);
    });

    it('says true at once for a notice the push has nothing to do with, when push is off and so is e-mail', async () => {
      enabled = false;
      expect(delivery.wants({ type: 'LESSON_CANCELLED' })).toBe(false);
      const answers: boolean[] = [];
      delivery.enqueue([], (delivered) => answers.push(delivered));
      expect(answers).toEqual([true]);
    });
  });
});

// A batch that goes out by both channels. The two are told apart in the answer (true only when both took it) but not
// in the work: for the crisis alarm the push is what counts (its life is ten minutes, and a phone in a pocket hears
// nothing of a mail), so a mail that Resend refuses must never keep the same batch's push from going. These tests need
// no socket and no clock, which the two that read an answer over a real one do.
describe('NotificationDeliveryService (mail and push in one batch)', () => {
  let tx: TxMock;
  let prisma: ReturnType<typeof createPrismaMock>;
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
    delivery.enqueue(batch, (delivered) => answers.push(delivered));
    await delivery.idle();
    return answers;
  };

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    expo = {
      send: jest.fn(async (messages: unknown[]) => messages.map((_m, i) => ({ status: 'ok', id: `ticket-${i}-abc` }))),
      receipts: jest.fn(),
    };
    delivery = new NotificationDeliveryService(prisma as unknown as PrismaService, config as never, expo as never);
    delivery.emailIntervalMs = 0;
    jest.spyOn((delivery as unknown as { logger: Logger }).logger, 'warn').mockImplementation(() => undefined);
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

  it('sends the push although the mail of the same batch was refused, and tells the batch false, once', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429 });
    expect(await told([alarm()])).toEqual([false]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(expo.send).toHaveBeenCalledTimes(1);
    expect(expo.send.mock.calls[0]![0]).toHaveLength(1);
  });

  it('sends the push although the mail could not be sent at all (the connection failed)', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    expect(await told([alarm()])).toEqual([false]);
    expect(expo.send).toHaveBeenCalledTimes(1);
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
  // batch's mails, so a Resend that does not answer holds an alarm's push for up to the mail timeout and the turn in
  // the mail chain (the push's own life is ten minutes). Sending the push first would take that wait away; this test
  // is the one to change with it.
  it('sends the batch’s mails first and its push after them', async () => {
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
