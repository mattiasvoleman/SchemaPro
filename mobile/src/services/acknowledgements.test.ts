import { getAccessToken, getSupabase } from './supabase';
import { ApiError } from './api';
import { noNetwork } from './network/deviceOffline';
import { translatorFor } from '../i18n';
import {
  confirmAck,
  fetchMyAcks,
  isStale,
  newestFirst,
  noteOf,
  waitingCount,
  type AckMine,
  type ConfirmOutcome,
} from './acknowledgements';

jest.mock('./supabase', () => ({ getAccessToken: jest.fn(), getSupabase: jest.fn() }));
jest.mock('./network/deviceOffline', () => ({ noNetwork: jest.fn(), deviceOffline: jest.fn() }));

/**
 * Kvittens from the guardian's side, through the real gateway client against
 * a stubbed fetch: the request the gateway receives (URL, method, and that
 * nothing is sent but the bearer), the page the list comes in (the query
 * for what is asked, the cursor that is answered) and its order, and what each
 * refusal code becomes for the screen. A confirmation is never queued: with
 * the phone joined to no network no request is made at all. Supabase fails
 * the test if asked: the messages are the gateway's to answer.
 */

const REQUEST = '3e8a1c52-7d4b-4f09-b6a2-1c9e5d7f8a34';
const BASE = 'https://api.example.test/api/v1/acknowledgements';

const fetchMock = jest.fn();
const answer = (status: number, body?: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => (body === undefined ? '' : JSON.stringify(body)),
});

const ack = (id: string, createdAt: string, over: Partial<AckMine> = {}): AckMine => ({
  id,
  title: 'Utflykten är på torsdag',
  body: 'Ta med matsäck.',
  rule: 'ANY',
  authorName: 'Anna Lind',
  createdAt,
  children: [{ id: 'c-1', name: 'Alva Elev' }],
  ackedAt: null,
  ...over,
});

beforeEach(() => {
  process.env['EXPO_PUBLIC_API_BASE_URL'] = 'https://api.example.test/';
  Object.defineProperty(global, 'fetch', { value: fetchMock, writable: true, configurable: true });
  fetchMock.mockReset();
  (getAccessToken as jest.Mock).mockResolvedValue('jwt-guardian');
  (getSupabase as jest.Mock).mockImplementation(() => {
    throw new Error('The messages are the gateway’s to answer.');
  });
  jest.mocked(noNetwork).mockResolvedValue(false);
});

const HEADERS = { 'X-SchemaPro-Client': 'app', Authorization: 'Bearer jwt-guardian' };
const NEXT = '9b2f4c10-5a6d-4e83-8c17-0d3e6a9f1b52';

describe('fetchMyAcks', () => {
  it('asks the gateway for the guardian’s own messages, with nothing but the bearer, and no query when nothing is set', async () => {
    fetchMock.mockResolvedValue(answer(200, { items: [ack('a-1', '2026-11-02T08:00:00.000Z')], next: null }));
    const page = await fetchMyAcks();
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/mine`, { method: 'GET', headers: HEADERS });
    expect(page).toEqual({ items: [ack('a-1', '2026-11-02T08:00:00.000Z')], next: null });
    expect(getSupabase).not.toHaveBeenCalled();
  });

  it.each([
    ['only the message to continue after', { after: NEXT }, `?after=${NEXT}`],
    ['only how many', { limit: 25 }, '?limit=25'],
    ['both', { after: NEXT, limit: 100 }, `?after=${NEXT}&limit=100`],
    ['nothing, for an empty query', {}, ''],
  ])('puts %s in the query string', async (_name, query, suffix) => {
    fetchMock.mockResolvedValue(answer(200, { items: [], next: null }));
    await fetchMyAcks(query);
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/mine${suffix}`);
    expect(fetchMock.mock.calls[0][1]).toEqual({ method: 'GET', headers: HEADERS });
  });

  it('escapes a cursor that is not a plain uuid, so it cannot add a parameter of its own', async () => {
    fetchMock.mockResolvedValue(answer(200, { items: [], next: null }));
    await fetchMyAcks({ after: 'x&limit=100' });
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/mine?after=x%26limit%3D100`);
  });

  it('hands back the cursor the gateway answers, for the older page', async () => {
    fetchMock.mockResolvedValue(answer(200, { items: [ack('a-1', '2026-11-02T08:00:00.000Z')], next: NEXT }));
    await expect(fetchMyAcks()).resolves.toMatchObject({ next: NEXT });
  });

  it('keeps a page with no messages that still has an older one behind it: only the cursor says there is no more', async () => {
    fetchMock.mockResolvedValue(answer(200, { items: [], next: NEXT }));
    await expect(fetchMyAcks()).resolves.toEqual({ items: [], next: NEXT });
  });

  it('puts the newest first within the page, whatever order the gateway answers in', async () => {
    fetchMock.mockResolvedValue(
      answer(200, {
        items: [
          ack('old', '2026-10-01T08:00:00.000Z'),
          ack('newest', '2026-11-04T08:00:00.000Z'),
          ack('middle', '2026-10-20T08:00:00.000Z'),
        ],
        next: null,
      }),
    );
    expect((await fetchMyAcks()).items.map((row) => row.id)).toEqual(['newest', 'middle', 'old']);
  });

  it('reads an answer from before the route paged, a bare array, as the one page it is', async () => {
    fetchMock.mockResolvedValue(answer(200, [ack('old', '2026-10-01T08:00:00.000Z'), ack('new', '2026-11-04T08:00:00.000Z')]));
    await expect(fetchMyAcks()).resolves.toEqual({
      items: [ack('new', '2026-11-04T08:00:00.000Z'), ack('old', '2026-10-01T08:00:00.000Z')],
      next: null,
    });
  });

  it('reads an empty answer, or one with no cursor or a cursor that is not an id, as no messages and no more', async () => {
    fetchMock.mockResolvedValue(answer(204));
    await expect(fetchMyAcks()).resolves.toEqual({ items: [], next: null });
    fetchMock.mockResolvedValue(answer(200, {}));
    await expect(fetchMyAcks()).resolves.toEqual({ items: [], next: null });
    fetchMock.mockResolvedValue(answer(200, { items: [], next: 7 }));
    await expect(fetchMyAcks()).resolves.toEqual({ items: [], next: null });
  });

  it('reads a gateway with no such route (a 404 without a code) as nothing to confirm, not as an error', async () => {
    fetchMock.mockResolvedValue(answer(404, { message: 'Cannot GET /api/v1/acknowledgements/mine' }));
    await expect(fetchMyAcks()).resolves.toEqual({ items: [], next: null });
    await expect(fetchMyAcks({ after: NEXT })).resolves.toEqual({ items: [], next: null });
  });

  it('throws a refusal that carries a code, and any other failure, as it came', async () => {
    fetchMock.mockResolvedValue(answer(404, { code: 'ACK_NOT_FOUND', message: 'Meddelandet finns inte.' }));
    await expect(fetchMyAcks()).rejects.toMatchObject({ name: 'ApiError', status: 404, code: 'ACK_NOT_FOUND' });
    fetchMock.mockResolvedValue(answer(500));
    const error = await fetchMyAcks().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 500 });
  });
});

describe('confirmAck', () => {
  it('posts to the message’s confirm route with no body, and hands back the time the gateway answered', async () => {
    fetchMock.mockResolvedValue(answer(200, { ackedAt: '2026-11-04T09:30:00.000Z' }));
    await expect(confirmAck(REQUEST)).resolves.toEqual({ kind: 'CONFIRMED', ackedAt: '2026-11-04T09:30:00.000Z' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/${REQUEST}/confirm`);
    expect(init).toEqual({
      method: 'POST',
      headers: { 'X-SchemaPro-Client': 'app', Authorization: 'Bearer jwt-guardian' },
    });
    expect(getSupabase).not.toHaveBeenCalled();
  });

  it('reads an answer without a time as now, which the next read of the list corrects', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-04T10:00:00.000Z'), doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'setTimeout'] });
    try {
      fetchMock.mockResolvedValue(answer(200, {}));
      await expect(confirmAck(REQUEST)).resolves.toEqual({ kind: 'CONFIRMED', ackedAt: '2026-11-04T10:00:00.000Z' });
      fetchMock.mockResolvedValue(answer(204));
      await expect(confirmAck(REQUEST)).resolves.toEqual({ kind: 'CONFIRMED', ackedAt: '2026-11-04T10:00:00.000Z' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('escapes an id that is not a plain uuid, so it cannot reach another route', async () => {
    fetchMock.mockResolvedValue(answer(200, { ackedAt: '2026-11-04T09:30:00.000Z' }));
    await confirmAck('../settings');
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/..%2Fsettings/confirm`);
  });

  it.each([
    [409, 'ACK_CUSTODY_ENDED', 'ENDED'],
    [404, 'ACK_NOT_FOUND', 'GONE'],
    [403, 'ACK_NOT_A_GUARDIAN', 'NOT_GUARDIAN'],
  ] as const)('reads a %s with the code %s as %s', async (status, code, kind) => {
    fetchMock.mockResolvedValue(answer(status, { code, message: 'Svenska meningen.' }));
    await expect(confirmAck(REQUEST)).resolves.toEqual({ kind });
  });

  it.each([
    ['a 500 with no code', answer(500)],
    ['a 401', answer(401, { message: 'Unauthorized' })],
    ['a 409 with another code', answer(409, { code: 'SOMETHING_ELSE' })],
    ['a 404 with no code', answer(404, { message: 'Not Found' })],
  ])('reads %s as a failure', async (_name, response) => {
    fetchMock.mockResolvedValue(response);
    await expect(confirmAck(REQUEST)).resolves.toEqual({ kind: 'FAILED' });
  });

  it('says OFFLINE without asking when the phone is joined to no network, and keeps nothing', async () => {
    jest.mocked(noNetwork).mockResolvedValue(true);
    await expect(confirmAck(REQUEST)).resolves.toEqual({ kind: 'OFFLINE' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says OFFLINE for a request that never reached the gateway, and a failure for any other thrown error', async () => {
    fetchMock.mockRejectedValue(new TypeError('Network request failed'));
    await expect(confirmAck(REQUEST)).resolves.toEqual({ kind: 'OFFLINE' });
    const aborted = new Error('Aborted');
    aborted.name = 'AbortError';
    fetchMock.mockRejectedValue(aborted);
    await expect(confirmAck(REQUEST)).resolves.toEqual({ kind: 'OFFLINE' });
    fetchMock.mockRejectedValue(new Error('boom'));
    await expect(confirmAck(REQUEST)).resolves.toEqual({ kind: 'FAILED' });
  });

  it('tries when the phone only doubts its network: the gateway may well be reachable', async () => {
    // noNetwork is false for a network the phone has not validated (deviceOffline.ts).
    fetchMock.mockResolvedValue(answer(200, { ackedAt: '2026-11-04T09:30:00.000Z' }));
    await expect(confirmAck(REQUEST)).resolves.toMatchObject({ kind: 'CONFIRMED' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('the list', () => {
  it('sorts newest first and breaks a tie by id, without touching the array it was given', () => {
    const rows = [ack('b', '2026-11-01T08:00:00.000Z'), ack('a', '2026-11-01T08:00:00.000Z'), ack('c', '2026-11-03T08:00:00.000Z')];
    expect(newestFirst(rows).map((row) => row.id)).toEqual(['c', 'a', 'b']);
    expect(rows.map((row) => row.id)).toEqual(['b', 'a', 'c']);
  });

  it('counts the messages that still wait for the guardian', () => {
    expect(waitingCount([])).toBe(0);
    expect(
      waitingCount([ack('a', '2026-11-01T08:00:00.000Z'), ack('b', '2026-11-02T08:00:00.000Z', { ackedAt: '2026-11-02T09:00:00.000Z' })]),
    ).toBe(1);
  });
});

describe('what the screen says of an outcome', () => {
  const sv = translatorFor('sv');
  const en = translatorFor('en');

  it.each([
    [{ kind: 'OFFLINE' }, 'warning', 'Det gick inte att bekräfta. Kontrollera nätet och försök igen.', 'Could not confirm. Check your connection and try again.'],
    [{ kind: 'FAILED' }, 'danger', 'Det gick inte att bekräfta. Försök igen.', 'Could not confirm. Try again.'],
    [{ kind: 'ENDED' }, 'neutral', 'Meddelandet gäller inte längre dig, så du behöver inte bekräfta det.', 'The message no longer concerns you, so you do not need to confirm it.'],
    [{ kind: 'GONE' }, 'neutral', 'Meddelandet finns inte längre.', 'The message no longer exists.'],
    [{ kind: 'NOT_GUARDIAN' }, 'danger', 'Bara en vårdnadshavare kan bekräfta.', 'Only a guardian can confirm.'],
  ] as Array<[ConfirmOutcome, string, string, string]>)('words %j in both languages', (outcome, tone, svText, enText) => {
    expect(noteOf(outcome, sv)).toEqual({ tone, text: svText });
    expect(noteOf(outcome, en)).toEqual({ tone, text: enText });
  });

  it('has no sentence for a confirmation: the card itself turns into one', () => {
    expect(noteOf({ kind: 'CONFIRMED', ackedAt: '2026-11-04T09:30:00.000Z' }, sv)).toBeNull();
  });

  it('calls only a refusal about the message itself stale, which is when the list is read again', () => {
    expect(isStale({ kind: 'ENDED' })).toBe(true);
    expect(isStale({ kind: 'GONE' })).toBe(true);
    for (const kind of ['OFFLINE', 'FAILED', 'NOT_GUARDIAN'] as const) expect(isStale({ kind })).toBe(false);
    expect(isStale({ kind: 'CONFIRMED', ackedAt: '2026-11-04T09:30:00.000Z' })).toBe(false);
  });
});
