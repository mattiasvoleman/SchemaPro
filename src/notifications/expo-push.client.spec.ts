import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
import {
  ExpoPushClient,
  MIN_REQUEST_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
  resetExpoPacing,
  type ExpoMessage,
} from './expo-push.client';

const API = 'https://push.example.invalid/--/api/v2/push';

const message = (n: number): ExpoMessage => ({
  to: `ExponentPushToken[token${String(n).padStart(4, '0')}]`,
  title: 'Inställd lektion',
  body: 'En lektion är inställd.',
  data: { notificationId: `n${n}`, type: 'LESSON_CANCELLED' },
  ttl: 86_400,
  channelId: 'default',
  sound: 'default',
  priority: 'default',
});

const respond = (status: number, body?: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

describe('ExpoPushClient', () => {
  let fetchMock: jest.Mock;
  let sleeps: number[];
  let clock: number;

  beforeEach(() => {
    resetExpoPacing();
    sleeps = [];
    clock = 1_000_000;
    fetchMock = jest.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as unknown;
      if (Array.isArray(body)) return respond(200, { data: body.map((_m, i) => ({ status: 'ok', id: `ticket-${i}` })) });
      return respond(200, { data: {} });
    });
  });

  const client = (accessToken?: string, timeoutMs?: number) =>
    new ExpoPushClient({
      apiUrl: API,
      accessToken,
      timeoutMs,
      fetch: fetchMock as unknown as typeof fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock,
      random: () => 0.5,
    });

  it('posts JSON with Expo’s headers, and a Bearer only when a token is configured', async () => {
    await client().send([message(1)]);
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; headers: Record<string, string> }];
    expect(url).toBe(`${API}/send`);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ accept: 'application/json', 'accept-encoding': 'gzip, deflate', 'content-type': 'application/json' });

    await client('expo-access-token-of-twenty').send([message(1)]);
    expect((fetchMock.mock.calls[1][1] as { headers: Record<string, string> }).headers.authorization).toBe('Bearer expo-access-token-of-twenty');
  });

  it('sends in chunks of 100, in order, and returns one ticket per message', async () => {
    const tickets = await client().send(Array.from({ length: 250 }, (_v, i) => message(i)));
    expect(fetchMock.mock.calls.map((call) => JSON.parse((call[1] as { body: string }).body).length)).toEqual([100, 100, 50]);
    expect(tickets).toHaveLength(250);
    expect(tickets[0]).toEqual({ status: 'ok', id: 'ticket-0' });
  });

  it('starts at most five requests a second, process-wide', async () => {
    await client().send(Array.from({ length: 300 }, (_v, i) => message(i)));
    await client().send([message(1)]);
    // Four requests on a clock that only moves when the client waits: the
    // first goes at once, each later one waits for its 200 ms slot.
    expect(sleeps).toEqual([MIN_REQUEST_INTERVAL_MS, MIN_REQUEST_INTERVAL_MS, MIN_REQUEST_INTERVAL_MS]);
  });

  it.each([429, 500, 503])('retries a %d after 1, 2 and 4 s, then answers RequestFailed per message', async (status) => {
    fetchMock.mockResolvedValue(respond(status));
    const tickets = await client().send([message(1), message(2)]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(sleeps.filter((ms) => ms >= 1000)).toEqual([1125, 2125, 4125]);
    expect(tickets).toEqual([
      { status: 'error', details: { error: 'RequestFailed' } },
      { status: 'error', details: { error: 'RequestFailed' } },
    ]);
  });

  it('retries a network error and succeeds', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    const tickets = await client().send([message(1)]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(tickets).toEqual([{ status: 'ok', id: 'ticket-0' }]);
  });

  it('does not retry a 400, and goes on to the next chunk', async () => {
    fetchMock.mockResolvedValueOnce(respond(400, { errors: [{ code: 'VALIDATION_ERROR' }] }));
    const tickets = await client().send(Array.from({ length: 101 }, (_v, i) => message(i)));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(tickets.slice(0, 100).every((t) => t.status === 'error')).toBe(true);
    expect(tickets[100]).toEqual({ status: 'ok', id: 'ticket-0' });
  });

  it('answers RequestFailed when Expo’s answer does not match the chunk', async () => {
    fetchMock.mockResolvedValueOnce(respond(200, { data: [{ status: 'ok', id: 'only-one' }] }));
    const tickets = await client().send([message(1), message(2)]);
    expect(tickets.map((t) => t.status)).toEqual(['error', 'error']);
  });

  it('asks for receipts in chunks of 1000 and keeps only the ids Expo answered', async () => {
    fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
      const { ids } = JSON.parse(init.body) as { ids: string[] };
      return respond(200, {
        data: Object.fromEntries(
          ids
            .filter((_id, i) => i % 2 === 0)
            .map((id) => [id, id.endsWith('0') ? { status: 'error', details: { error: 'DeviceNotRegistered' } } : { status: 'ok' }]),
        ),
      });
    });
    const ids = Array.from({ length: 1500 }, (_v, i) => `receipt-${i}`);
    const receipts = await client().receipts(ids);
    expect(fetchMock.mock.calls.map((call) => (call[0] as string))).toEqual([`${API}/getReceipts`, `${API}/getReceipts`]);
    expect(fetchMock.mock.calls.map((call) => JSON.parse((call[1] as { body: string }).body).ids.length)).toEqual([1000, 500]);
    expect(Object.keys(receipts)).toHaveLength(750);
    expect(receipts['receipt-0']).toEqual({ status: 'error', details: { error: 'DeviceNotRegistered' } });
    expect(receipts['receipt-2']).toEqual({ status: 'ok' });
    expect(receipts['receipt-1']).toBeUndefined();
  });

  it('answers no receipts when the request fails', async () => {
    fetchMock.mockResolvedValue(respond(403));
    await expect(client().receipts(['a1234567'])).resolves.toEqual({});
    fetchMock.mockResolvedValue(respond(200, { data: ['not', 'a', 'map'] }));
    await expect(client().receipts(['a1234567'])).resolves.toEqual({});
  });
  describe('a request Expo does not answer', () => {
    /** A fetch that answers nothing, and rejects the way fetch does when its signal aborts. */
    const silent = (_url: string, init: { signal: AbortSignal }) =>
      new Promise<never>((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
    let warn: jest.SpyInstance;
    beforeEach(() => {
      warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => warn.mockRestore());

    it('gives every request a signal that aborts after the limit, ten seconds unless told otherwise', async () => {
      const timeout = jest.spyOn(AbortSignal, 'timeout');
      await client().send([message(1)]);
      await client(undefined, 250).send([message(1)]);
      expect(timeout.mock.calls).toEqual([[REQUEST_TIMEOUT_MS], [250]]);
      expect(REQUEST_TIMEOUT_MS).toBe(10_000);
      expect((fetchMock.mock.calls[0][1] as { signal: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
      timeout.mockRestore();
    });

    it('gives up on it, retries it like a network error, and answers RequestFailed per message when none gets through', async () => {
      fetchMock.mockImplementation(silent);
      const tickets = await client(undefined, 15).send([message(1), message(2)]);
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(sleeps.filter((ms) => ms >= 1000)).toEqual([1125, 2125, 4125]);
      expect(tickets).toEqual([
        { status: 'error', details: { error: 'RequestFailed' } },
        { status: 'error', details: { error: 'RequestFailed' } },
      ]);
      expect(warn).toHaveBeenCalledWith('Expo did not answer in time [path=send, limit=15 ms]');
      // Nothing of the content is logged: no token, no title, no body.
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/ExponentPushToken|Inställd|lektion/);
    });

    it('goes on with the next chunk after a chunk that timed out for good', async () => {
      let calls = 0;
      fetchMock.mockImplementation(async (url: string, init: { body: string; signal: AbortSignal }) => {
        calls += 1;
        if (calls <= 4) return silent(url, init);
        return respond(200, { data: (JSON.parse(init.body) as unknown[]).map((_m, i) => ({ status: 'ok', id: `t${i}` })) });
      });
      const tickets = await client(undefined, 10).send(Array.from({ length: 101 }, (_v, i) => message(i)));
      expect(tickets.slice(0, 100).every((t) => t.status === 'error')).toBe(true);
      expect(tickets[100]).toEqual({ status: 'ok', id: 't0' });
    });

    it('retries an answer whose body timed out, and does not retry one that is not JSON', async () => {
      const cutOff = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => Promise.reject(cutOff) });
      await expect(client().send([message(1)])).resolves.toEqual([{ status: 'ok', id: 'ticket-0' }]);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      fetchMock.mockClear();
      fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => Promise.reject(new SyntaxError('Unexpected token')) });
      const tickets = await client().send([message(1)]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(tickets).toEqual([{ status: 'error', details: { error: 'RequestFailed' } }]);
    });

    describe('over a real socket', () => {
      let server: Server;
      let behave: (res: import('node:http').ServerResponse) => void;
      let requests: number;
      beforeEach(async () => {
        requests = 0;
        server = createServer((_req, res) => {
          requests += 1;
          behave(res);
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      });
      afterEach(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      });
      const real = () =>
        new ExpoPushClient({
          apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          timeoutMs: 80,
          sleep: async () => undefined,
          random: () => 0,
        });

      it('stops waiting for a server that takes the request and never answers', async () => {
        behave = () => undefined;
        const started = Date.now();
        const tickets = await real().send([message(1)]);
        expect(tickets).toEqual([{ status: 'error', details: { error: 'RequestFailed' } }]);
        expect(requests).toBe(4);
        expect(Date.now() - started).toBeLessThan(2_000);
      });

      it('stops waiting for a server that answers the headers and stalls in the body', async () => {
        behave = (res) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.write('{"data":[');
        };
        const started = Date.now();
        const tickets = await real().send([message(1)]);
        expect(tickets).toEqual([{ status: 'error', details: { error: 'RequestFailed' } }]);
        expect(requests).toBe(4);
        expect(Date.now() - started).toBeLessThan(2_000);
      });

      it('still reads an answer that comes in time', async () => {
        behave = (res) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: [{ status: 'ok', id: 'on-time' }] }));
        };
        await expect(real().send([message(1)])).resolves.toEqual([{ status: 'ok', id: 'on-time' }]);
        expect(requests).toBe(1);
      });
    });
  });
});
