import { getAccessToken } from './supabase';
import { deviceOffline } from './network/deviceOffline';
import { translatorFor } from '../i18n';
import {
  PAST_SHOWN,
  answerCoverRequest,
  answerable,
  confirmCoverPass,
  fetchMyCover,
  keepsButtons,
  lessonsByDay,
  loadProblem,
  noteOf,
  splitRequests,
  untilText,
  type CoverLesson,
  type MyCoverPass,
  type MyCoverRequest,
  type MyRequestState,
} from './coverRequests';

jest.mock('./supabase', () => ({ getAccessToken: jest.fn(), getSupabase: jest.fn() }));
jest.mock('./network/deviceOffline', () => ({ deviceOffline: jest.fn() }));

/**
 * Vikariefrågan from the teacher's side, through the real gateway client
 * against a stubbed fetch: the request the gateway receives (URL, method, and
 * that nothing is sent but the bearer), and what each refusal code becomes for
 * the screen. A yes is never queued: with the device offline no request is
 * made at all. Under TZ=UTC, so the instants read as written.
 */

const REQUEST = '3e8a1c52-7d4b-4f09-b6a2-1c9e5d7f8a34';
const LESSON = '5f0c6a2e-1b7d-4c3e-9a51-2d8e4f6b7c90';
const BASE = 'https://api.example.test/api/v1/cover-requests';

const fetchMock = jest.fn();
const answer = (status: number, body?: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => (body === undefined ? '' : JSON.stringify(body)),
});

const lesson = (over: Partial<CoverLesson> = {}): CoverLesson => ({
  lessonId: LESSON,
  date: '2026-10-13',
  startsAt: '2026-10-13T08:10:00.000Z',
  endsAt: '2026-10-13T09:00:00.000Z',
  subjectName: 'Matematik',
  groupName: '7A',
  roomName: 'B204',
  cancelled: false,
  ...over,
});

const request = (id: string, state: MyRequestState = 'OPEN', lessons: CoverLesson[] = [lesson()], createdAt = '2026-10-12T10:00:00.000Z'): MyCoverRequest => ({
  id,
  state,
  createdAt,
  expiresAt: '2026-10-13T07:30:00.000Z',
  lessons,
});

const pass: MyCoverPass = {
  lessonId: LESSON,
  date: '2026-10-14',
  startsAt: '2026-10-14T08:10:00.000Z',
  endsAt: '2026-10-14T09:00:00.000Z',
  subjectName: 'Svenska',
  groupName: '8B',
  roomName: null,
  confirmedAt: null,
};

beforeEach(() => {
  process.env['EXPO_PUBLIC_API_BASE_URL'] = 'https://api.example.test/';
  Object.defineProperty(global, 'fetch', { value: fetchMock, writable: true, configurable: true });
  fetchMock.mockReset();
  (getAccessToken as jest.Mock).mockResolvedValue('jwt-teacher');
  (deviceOffline as jest.Mock).mockResolvedValue(false);
});

describe('fetchMyCover', () => {
  it('asks the gateway for the teacher’s own questions and passes, and hands both back', async () => {
    fetchMock.mockResolvedValue(answer(200, { requests: [request(REQUEST)], passes: [pass] }));
    await expect(fetchMyCover()).resolves.toEqual({ requests: [request(REQUEST)], passes: [pass] });
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/mine`, {
      method: 'GET',
      headers: { 'X-SchemaPro-Client': 'app', Authorization: 'Bearer jwt-teacher' },
    });
  });

  it('reads an answer without lists as none', async () => {
    fetchMock.mockResolvedValue(answer(200, {}));
    await expect(fetchMyCover()).resolves.toEqual({ requests: [], passes: [] });
    fetchMock.mockResolvedValue(answer(204));
    await expect(fetchMyCover()).resolves.toEqual({ requests: [], passes: [] });
  });

  it('reads a gateway without the route (a 404 without a code) as nothing to ask, and any other refusal as one', async () => {
    fetchMock.mockResolvedValue(answer(404, { message: 'Cannot GET /api/v1/cover-requests/mine' }));
    await expect(fetchMyCover()).resolves.toEqual({ requests: [], passes: [] });
    fetchMock.mockResolvedValue(answer(404, { message: 'x', code: 'COVER_REQUEST_NOT_FOUND' }));
    await expect(fetchMyCover()).rejects.toMatchObject({ name: 'ApiError', status: 404, code: 'COVER_REQUEST_NOT_FOUND' });
    fetchMock.mockResolvedValue(answer(403, { message: 'Forbidden' }));
    await expect(fetchMyCover()).rejects.toMatchObject({ status: 403 });
    fetchMock.mockResolvedValue(answer(500));
    await expect(fetchMyCover()).rejects.toMatchObject({ status: 500 });
  });
});

describe('splitRequests', () => {
  const soon = request('a', 'OPEN', [lesson({ startsAt: '2026-10-13T08:10:00.000Z' })]);
  const later = request('b', 'OPEN', [lesson({ lessonId: 'l2', startsAt: '2026-10-14T08:10:00.000Z' })]);
  const earliestOfMany = request('c', 'OPEN', [
    lesson({ lessonId: 'l3', startsAt: '2026-10-15T08:10:00.000Z' }),
    lesson({ lessonId: 'l4', startsAt: '2026-10-12T08:10:00.000Z' }),
  ]);

  it('puts the open questions first, soonest lesson first, whatever order the gateway sent', () => {
    const { open, past } = splitRequests([later, earliestOfMany, soon, request('d', 'TAKEN')]);
    expect(open.map((r) => r.id)).toEqual(['c', 'a', 'b']);
    expect(past.map((r) => r.id)).toEqual(['d']);
  });

  it('keeps the gateway’s order, newest question first, for the ones that ended', () => {
    const ended = ['ACCEPTED_BY_ME', 'DECLINED_BY_ME', 'TAKEN', 'WITHDRAWN', 'EXPIRED', 'CLOSED'] as const;
    const { open, past } = splitRequests(ended.map((state, i) => request(`e${i}`, state)));
    expect(open).toEqual([]);
    expect(past.map((r) => r.id)).toEqual(['e0', 'e1', 'e2', 'e3', 'e4', 'e5']);
  });

  it('shows no more than the last twenty that ended', () => {
    const many = Array.from({ length: PAST_SHOWN + 5 }, (_, i) => request(`p${i}`, 'EXPIRED'));
    expect(splitRequests(many).past).toHaveLength(PAST_SHOWN);
  });

  it('keeps a question the teacher has just answered with the open ones while it is held, so its confirmation is read where the buttons were', () => {
    const answered = request('x', 'ACCEPTED_BY_ME', [lesson({ startsAt: '2026-10-13T07:00:00.000Z' })]);
    expect(splitRequests([answered, soon]).open.map((r) => r.id)).toEqual(['a']);
    expect(splitRequests([answered, soon], new Set(['x'])).open.map((r) => r.id)).toEqual(['x', 'a']);
  });

  it('puts a question without lessons last rather than lose it', () => {
    const none = request('0', 'OPEN', []);
    expect(splitRequests([none, soon, later]).open.map((r) => r.id)).toEqual(['a', 'b', '0']);
  });
});

describe('answerable', () => {
  it('is an open question with lessons that are all still held', () => {
    expect(answerable(request('a'))).toBe(true);
    expect(answerable(request('a', 'TAKEN'))).toBe(false);
    expect(answerable(request('a', 'OPEN', []))).toBe(false);
    expect(answerable(request('a', 'OPEN', [lesson(), lesson({ lessonId: 'l2', cancelled: true })]))).toBe(false);
  });
});

describe('lessonsByDay', () => {
  it('heads each day once, and keeps the order given', () => {
    const days = lessonsByDay([
      lesson({ lessonId: '1' }),
      lesson({ lessonId: '2' }),
      lesson({ lessonId: '3', date: '2026-10-14' }),
      lesson({ lessonId: '4', date: '2026-10-13' }),
    ]);
    expect(days.map((d) => [d.date, d.lessons.map((l) => l.lessonId)])).toEqual([
      ['2026-10-13', ['1', '2']],
      ['2026-10-14', ['3']],
      ['2026-10-13', ['4']],
    ]);
    expect(lessonsByDay([])).toEqual([]);
  });
});

describe('untilText', () => {
  const noon = new Date('2026-10-13T12:00:00.000Z');
  it('says only the time when the question closes today on the phone', () => {
    expect(untilText('2026-10-13T08:30:00.000Z', 'sv', noon)).toBe('08:30');
    expect(untilText('2026-10-13T20:05:00.000Z', 'en', noon)).toBe('20:05');
  });

  it('says the day too when it closes on another, so tomorrow’s deadline does not read as this morning’s', () => {
    expect(untilText('2026-10-14T08:30:00.000Z', 'sv', noon)).toBe('ons 14 okt 08:30');
    expect(untilText('2026-10-14T08:30:00.000Z', 'en', noon)).toBe('Wed 14 Oct 08:30');
  });

  it('says nothing for an instant it cannot read', () => {
    expect(untilText('not a date', 'sv', noon)).toBe('');
  });
});

describe('answerCoverRequest', () => {
  it('posts a yes to the question’s accept route, with nothing but the bearer, and reports the lessons it placed', async () => {
    fetchMock.mockResolvedValue(answer(200, { requestId: REQUEST, lessons: 3 }));
    await expect(answerCoverRequest(REQUEST, 'YES')).resolves.toEqual({ kind: 'ACCEPTED', lessons: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/${REQUEST}/accept`, {
      method: 'POST',
      headers: { 'X-SchemaPro-Client': 'app', Authorization: 'Bearer jwt-teacher' },
    });
  });

  it('posts a no to the decline route', async () => {
    fetchMock.mockResolvedValue(answer(200, { requestId: REQUEST }));
    await expect(answerCoverRequest(REQUEST, 'NO')).resolves.toEqual({ kind: 'DECLINED' });
    expect(fetchMock.mock.calls[0]![0]).toBe(`${BASE}/${REQUEST}/decline`);
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: 'POST' });
  });

  it('does not queue: a phone that says it is offline sends nothing at all', async () => {
    (deviceOffline as jest.Mock).mockResolvedValue(true);
    await expect(answerCoverRequest(REQUEST, 'YES')).resolves.toEqual({ kind: 'OFFLINE' });
    await expect(answerCoverRequest(REQUEST, 'NO')).resolves.toEqual({ kind: 'OFFLINE' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calls a request that never reached the gateway offline, and keeps nothing for later', async () => {
    fetchMock.mockRejectedValue(new TypeError('Network request failed'));
    await expect(answerCoverRequest(REQUEST, 'YES')).resolves.toEqual({ kind: 'OFFLINE' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const cut = new Error('aborted');
    cut.name = 'AbortError';
    fetchMock.mockRejectedValue(cut);
    await expect(answerCoverRequest(REQUEST, 'NO')).resolves.toEqual({ kind: 'OFFLINE' });
  });

  it('tells a yes that came second: another colleague was first', async () => {
    fetchMock.mockResolvedValue(
      answer(409, { message: 'Uppdraget är redan tillsatt: en kollega hann tacka ja före dig.', code: 'COVER_REQUEST_TAKEN' }),
    );
    await expect(answerCoverRequest(REQUEST, 'YES')).resolves.toEqual({ kind: 'TAKEN' });
  });

  it('hands a yes that breaks a rule back with the gateway’s sentence, which names the rule', async () => {
    const message = 'Du kan inte ta uppdraget (tis 13 okt 08:10) eftersom du skulle överskrida dagens tak för undervisning.';
    fetchMock.mockResolvedValue(answer(409, { message, code: 'COVER_REQUEST_RULE', params: { lessonId: LESSON, rules: 'DAILY_CAP' } }));
    await expect(answerCoverRequest(REQUEST, 'YES')).resolves.toEqual({ kind: 'REFUSED', code: 'COVER_REQUEST_RULE', message });
  });

  it('hands the rule back without a sentence when the gateway sent none', async () => {
    fetchMock.mockResolvedValue(answer(409, { code: 'COVER_REQUEST_RULE' }));
    await expect(answerCoverRequest(REQUEST, 'YES')).resolves.toEqual({ kind: 'REFUSED', code: 'COVER_REQUEST_RULE', message: null });
  });

  it('hands back a question whose sender has left', async () => {
    fetchMock.mockResolvedValue(answer(409, { message: 'Den som skickade förfrågan kan inte längre tillsätta uppdraget.', code: 'COVER_REQUEST_SENDER_GONE' }));
    await expect(answerCoverRequest(REQUEST, 'YES')).resolves.toMatchObject({ kind: 'REFUSED', code: 'COVER_REQUEST_SENDER_GONE' });
  });

  it.each([
    [409, 'COVER_REQUEST_GONE'],
    [409, 'COVER_REQUEST_ANSWERED'],
    [404, 'COVER_REQUEST_NOT_FOUND'],
    [409, 'COVER_REQUEST_LESSON_CANCELLED'],
    [409, 'COVER_REQUEST_LESSON_COVERED'],
  ])('reads a %i %s as a question that has moved on, so the list is read again', async (status, code) => {
    fetchMock.mockResolvedValue(answer(status, { message: 'x', code }));
    await expect(answerCoverRequest(REQUEST, 'YES')).resolves.toEqual({ kind: 'STALE', code });
    fetchMock.mockResolvedValue(answer(status, { message: 'x', code }));
    await expect(answerCoverRequest(REQUEST, 'NO')).resolves.toEqual({ kind: 'STALE', code });
  });

  it.each([
    ['a server error', answer(500)],
    ['a refusal of the role', answer(403, { message: 'Forbidden resource' })],
    ['an expired session', answer(401, { message: 'Unauthorized' })],
    ['a code this build does not know', answer(409, { message: 'x', code: 'FROM_A_NEWER_GATEWAY' })],
  ])('says it failed on %s, and nothing more', async (_name, response) => {
    fetchMock.mockResolvedValue(response);
    await expect(answerCoverRequest(REQUEST, 'YES')).resolves.toEqual({ kind: 'FAILED' });
  });

  it('says it failed, not offline, for a fault that is not the network’s', async () => {
    fetchMock.mockRejectedValue(new RangeError('bug'));
    await expect(answerCoverRequest(REQUEST, 'YES')).resolves.toEqual({ kind: 'FAILED' });
  });
});

describe('confirmCoverPass', () => {
  it('posts the tap on a pass to its lesson’s confirm route', async () => {
    fetchMock.mockResolvedValue(answer(200, { lessonId: LESSON, confirmed: 1 }));
    await expect(confirmCoverPass(LESSON)).resolves.toEqual({ kind: 'CONFIRMED' });
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/lessons/${LESSON}/confirm`, {
      method: 'POST',
      headers: { 'X-SchemaPro-Client': 'app', Authorization: 'Bearer jwt-teacher' },
    });
  });

  it('is a pass that is no longer theirs when the gateway says so, and the list is read again', async () => {
    fetchMock.mockResolvedValue(answer(404, { message: 'Passet är inte ditt att bekräfta.', code: 'COVER_PASS_NOT_FOUND' }));
    await expect(confirmCoverPass(LESSON)).resolves.toEqual({ kind: 'STALE', code: 'COVER_PASS_NOT_FOUND' });
  });

  it('sends nothing offline, and fails quietly on a server error', async () => {
    (deviceOffline as jest.Mock).mockResolvedValue(true);
    await expect(confirmCoverPass(LESSON)).resolves.toEqual({ kind: 'OFFLINE' });
    expect(fetchMock).not.toHaveBeenCalled();
    (deviceOffline as jest.Mock).mockResolvedValue(false);
    fetchMock.mockResolvedValue(answer(500));
    await expect(confirmCoverPass(LESSON)).resolves.toEqual({ kind: 'FAILED' });
    fetchMock.mockRejectedValue(new TypeError('Network request failed'));
    await expect(confirmCoverPass(LESSON)).resolves.toEqual({ kind: 'OFFLINE' });
  });
});

describe('loadProblem', () => {
  it('is offline for a request that never reached the gateway, and for a phone that says it is offline', async () => {
    await expect(loadProblem(new TypeError('Network request failed'))).resolves.toBe('OFFLINE');
    (deviceOffline as jest.Mock).mockResolvedValue(true);
    await expect(loadProblem(new Error('Not authenticated.'))).resolves.toBe('OFFLINE');
  });

  it('is a failure for the gateway’s own refusal on a phone that is online', async () => {
    await expect(loadProblem(new Error('HTTP 500'))).resolves.toBe('FAILED');
  });
});

describe('what the screen says of an outcome', () => {
  const sv = translatorFor('sv');
  const en = translatorFor('en');

  it('says a taken question in the reader’s language', () => {
    expect(noteOf({ kind: 'TAKEN' }, sv)).toEqual({ tone: 'warning', text: 'Uppdraget är redan tillsatt – en kollega hann före' });
    expect(noteOf({ kind: 'TAKEN' }, en)).toEqual({ tone: 'warning', text: 'The assignment is already filled – a colleague was first' });
  });

  it('shows a rule’s sentence as the gateway wrote it, in either language, and its own words only when there is none', () => {
    const message = 'Du kan inte ta uppdraget (tis 13 okt 08:10) eftersom du skulle överskrida dagens tak för undervisning.';
    expect(noteOf({ kind: 'REFUSED', code: 'COVER_REQUEST_RULE', message }, sv)).toEqual({ tone: 'danger', text: message });
    expect(noteOf({ kind: 'REFUSED', code: 'COVER_REQUEST_RULE', message }, en)).toEqual({ tone: 'danger', text: message });
    expect(noteOf({ kind: 'REFUSED', code: 'COVER_REQUEST_RULE', message: null }, sv)?.text).toBe('Du kan inte ta uppdraget just nu.');
    expect(noteOf({ kind: 'REFUSED', code: 'COVER_REQUEST_SENDER_GONE', message: null }, en)?.text).toContain('school office');
  });

  it('words every question that moved on', () => {
    for (const code of [
      'COVER_REQUEST_GONE',
      'COVER_REQUEST_ANSWERED',
      'COVER_REQUEST_NOT_FOUND',
      'COVER_REQUEST_LESSON_CANCELLED',
      'COVER_REQUEST_LESSON_COVERED',
      'COVER_PASS_NOT_FOUND',
    ] as const) {
      const note = noteOf({ kind: 'STALE', code }, sv);
      expect(note?.tone).toBe('neutral');
      expect(note?.text).not.toMatch(/^coverRequests\./);
    }
  });

  it('says plainly that the phone is offline, and that nothing is kept for later', () => {
    expect(noteOf({ kind: 'OFFLINE' }, sv)).toEqual({
      tone: 'warning',
      text: 'Du är offline. Ett svar skickas direkt och sparas inte till senare. Anslut och försök igen.',
    });
    expect(noteOf({ kind: 'OFFLINE' }, en)?.text).toContain('You are offline');
    expect(noteOf({ kind: 'FAILED' }, sv)).toEqual({ tone: 'danger', text: 'Det gick inte att skicka. Försök igen.' });
  });

  it('has no line for an answer that went through: the card itself is its confirmation', () => {
    expect(noteOf({ kind: 'ACCEPTED', lessons: 2 }, sv)).toBeNull();
    expect(noteOf({ kind: 'DECLINED' }, sv)).toBeNull();
    expect(noteOf({ kind: 'CONFIRMED' }, sv)).toBeNull();
  });

  it('keeps the buttons for a refusal by rule, no connection or a failure, and for nothing else', () => {
    expect(keepsButtons(undefined)).toBe(true);
    expect(keepsButtons({ kind: 'REFUSED', code: 'COVER_REQUEST_RULE', message: null })).toBe(true);
    expect(keepsButtons({ kind: 'OFFLINE' })).toBe(true);
    expect(keepsButtons({ kind: 'FAILED' })).toBe(true);
    expect(keepsButtons({ kind: 'TAKEN' })).toBe(false);
    expect(keepsButtons({ kind: 'STALE', code: 'COVER_REQUEST_GONE' })).toBe(false);
    expect(keepsButtons({ kind: 'ACCEPTED', lessons: 1 })).toBe(false);
    expect(keepsButtons({ kind: 'DECLINED' })).toBe(false);
  });
});
