import { getAccessToken, getSupabase } from './supabase';
import { ApiError } from './api';
import { translatorFor } from '../i18n';
import {
  DEFAULT_LEAVE_POLICY,
  answerLeaveConsent,
  asksForContact,
  consentErrorText,
  deciderOf,
  fetchLeavePolicy,
  fetchLeaveRequests,
  filingErrorText,
  omitKey,
  requestLeave,
  withConsentAnswer,
} from './leaveRequests';
import type { LeaveRequestRow } from '../types';

jest.mock('./supabase', () => ({ getAccessToken: jest.fn(), getSupabase: jest.fn() }));

/**
 * Leave requests, through the real gateway client against a stubbed fetch:
 * the request the gateway receives (URL, method, body) and what the screen is
 * handed back. Supabase fails the test if asked: the screen read LeaveRequests,
 * and the child's Users row for its school, itself until the read log needed
 * every read of a child to pass the gateway.
 */

const CHILD = '5f0c6a2e-1b7d-4c3e-9a51-2d8e4f6b7c90';
const REQUEST = '3e8a1c52-7d4b-4f09-b6a2-1c9e5d7f8a34';
const BASE = 'https://api.example.test/api/v1/leave-requests';

const fetchMock = jest.fn();
const answer = (status: number, body?: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => (body === undefined ? '' : JSON.stringify(body)),
});

const leave = (id: string, createdAt: string) => ({
  id,
  studentId: CHILD,
  requestedById: 'g-1',
  startDate: '2026-11-02',
  endDate: '2026-11-06',
  reason: 'Familjeresa',
  status: 'PENDING',
  decidedById: null,
  decidedAt: null,
  decisionNote: null,
  createdAt,
  decidedAs: null,
});

beforeEach(() => {
  process.env['EXPO_PUBLIC_API_BASE_URL'] = 'https://api.example.test/';
  Object.defineProperty(global, 'fetch', { value: fetchMock, writable: true, configurable: true });
  fetchMock.mockReset();
  (getAccessToken as jest.Mock).mockResolvedValue('jwt-guardian');
  (getSupabase as jest.Mock).mockImplementation(() => {
    throw new Error('Leave requests are the gateway’s to answer, and to log.');
  });
});

describe('fetchLeaveRequests', () => {
  it('asks the gateway, and shows the newest 50 in the gateway’s order', async () => {
    const rows = Array.from({ length: 60 }, (_, i) =>
      leave(`l-${i}`, new Date(Date.UTC(2026, 9, 13, 12) - i * 3_600_000).toISOString()),
    );
    fetchMock.mockResolvedValue(answer(200, rows));
    const shown = await fetchLeaveRequests();
    expect(fetchMock).toHaveBeenCalledWith(BASE, {
      method: 'GET',
      headers: { 'X-SchemaPro-Client': 'app', Authorization: 'Bearer jwt-guardian' },
    });
    expect(shown).toHaveLength(50);
    expect(shown.map((row) => row.id)).toEqual(rows.slice(0, 50).map((row) => row.id));
    expect(shown[0]).toEqual(rows[0]);
    expect(getSupabase).not.toHaveBeenCalled();
  });

  it('hands the screen the role each decision was made in', async () => {
    const decided = { ...leave('decided', '2026-10-13T08:00:00.000Z'), status: 'APPROVED', decidedAs: 'MENTOR' };
    fetchMock.mockResolvedValue(answer(200, [decided]));
    const [row] = await fetchLeaveRequests();
    expect(row).toMatchObject({ id: 'decided', status: 'APPROVED', decidedAs: 'MENTOR' });
    expect(deciderOf(row!)).toBe('MENTOR');
  });

  it('shows a short answer whole', async () => {
    fetchMock.mockResolvedValue(answer(200, [leave('only', '2026-10-13T08:00:00.000Z')]));
    await expect(fetchLeaveRequests()).resolves.toHaveLength(1);
  });

  it('throws the gateway’s refusal as it came', async () => {
    fetchMock.mockResolvedValue(answer(500));
    const error = await fetchLeaveRequests().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 500 });
  });
});

describe('requestLeave', () => {
  it('posts the child, the days and the trimmed reason, and nothing the gateway or the school decides', async () => {
    fetchMock.mockResolvedValue(answer(201, { id: REQUEST, studentId: CHILD, status: 'PENDING' }));
    await expect(
      requestLeave({ studentId: CHILD, startDate: '2026-11-02', endDate: '2026-11-06', reason: '  Familjeresa \n' }),
    ).resolves.toEqual({ id: REQUEST, studentId: CHILD, status: 'PENDING' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(BASE);
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        'X-SchemaPro-Client': 'app',
        Authorization: 'Bearer jwt-guardian',
        'Content-Type': 'application/json',
      },
    });
    // No schoolId or requestedById (the gateway's), no status (the school's).
    expect(JSON.parse(init.body)).toEqual({
      studentId: CHILD,
      startDate: '2026-11-02',
      endDate: '2026-11-06',
      reason: 'Familjeresa',
    });
  });

  it('throws a refusal with its status and sentence', async () => {
    fetchMock.mockResolvedValue(answer(400, { message: 'endDate must not be before startDate.' }));
    await expect(
      requestLeave({ studentId: CHILD, startDate: '2026-11-06', endDate: '2026-11-02', reason: 'Familjeresa' }),
    ).rejects.toMatchObject({ name: 'ApiError', status: 400, message: 'endDate must not be before startDate.' });
  });
});

describe('deciderOf', () => {
  it('says who decided only for a decided request with a recorded role', () => {
    expect(deciderOf({ status: 'APPROVED', decidedAs: 'MENTOR' })).toBe('MENTOR');
    expect(deciderOf({ status: 'REJECTED', decidedAs: 'ADMIN' })).toBe('ADMIN');
    expect(deciderOf({ status: 'APPROVED', decidedAs: null })).toBeNull();
    expect(deciderOf({ status: 'PENDING', decidedAs: null })).toBeNull();
  });
});

/**
 * Ledighetspolicy: the school's three choices, the contact on a request, the
 * guardian's consent and the refusals worded in the reader's language.
 */

const sv = translatorFor('sv');
const en = translatorFor('en');
const refusal = (status: number, code: string, params?: Record<string, string | number>) =>
  answer(status, { code, message: 'Gatewayns egen mening.', ...(params ? { params } : {}) });

describe('a leave request row from Ledighetspolicy', () => {
  it('hands the screen the consent, the contact, the flag and the new status as they came', async () => {
    const ended = {
      ...leave('ended', '2026-10-13T08:00:00.000Z'),
      status: 'GUARDIAN_DECLINED',
      shortNotice: true,
      contact: { name: 'Anna Lind', phone: '070-123 45 67', relation: 'Faster' },
      consent: { required: true, state: 'REFUSED', mine: 'REFUSED', asked: null, given: null, waiting: null },
    };
    fetchMock.mockResolvedValue(answer(200, [ended]));
    const [row] = await fetchLeaveRequests();
    expect(row).toEqual(ended);
    expect(row).toMatchObject({ status: 'GUARDIAN_DECLINED', shortNotice: true, consent: { mine: 'REFUSED' }, contact: { relation: 'Faster' } });
  });

  it('shows an old gateway’s row, which carries none of it, as it always was', async () => {
    fetchMock.mockResolvedValue(answer(200, [leave('old', '2026-10-13T08:00:00.000Z')]));
    const [row] = await fetchLeaveRequests();
    expect(row).not.toHaveProperty('consent');
    expect(row).not.toHaveProperty('contact');
    expect(row).not.toHaveProperty('shortNotice');
  });
});

describe('fetchLeavePolicy', () => {
  it('asks the gateway for the school’s policy and hands it back whole', async () => {
    const policy = { requireAllGuardians: true, minDaysAhead: 14, shortNotice: 'FLAG', contact: 'REQUIRED' };
    fetchMock.mockResolvedValue(answer(200, policy));
    await expect(fetchLeavePolicy()).resolves.toEqual(policy);
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.test/api/v1/leave-policy', {
      method: 'GET',
      headers: { 'X-SchemaPro-Client': 'app', Authorization: 'Bearer jwt-guardian' },
    });
  });

  it('is all off for a school that chose nothing', async () => {
    fetchMock.mockResolvedValue(answer(200, { requireAllGuardians: false, minDaysAhead: null, shortNotice: 'REFUSE', contact: 'OFF' }));
    await expect(fetchLeavePolicy()).resolves.toEqual(DEFAULT_LEAVE_POLICY);
    expect(DEFAULT_LEAVE_POLICY).toEqual({ requireAllGuardians: false, minDaysAhead: null, shortNotice: 'REFUSE', contact: 'OFF' });
  });

  it.each([
    ['a value this build does not know', { requireAllGuardians: 'yes', minDaysAhead: '7', shortNotice: 'SHRUG', contact: 'MAYBE' }],
    ['a minimum that is not a whole day', { requireAllGuardians: false, minDaysAhead: 2.5, shortNotice: 'REFUSE', contact: 'OFF' }],
    ['a minimum of nothing', { requireAllGuardians: false, minDaysAhead: 0, shortNotice: 'REFUSE', contact: 'OFF' }],
    ['no body', undefined],
    ['an empty one', {}],
  ])('reads %s as off', async (_name, body) => {
    fetchMock.mockResolvedValue(answer(200, body));
    await expect(fetchLeavePolicy()).resolves.toEqual(DEFAULT_LEAVE_POLICY);
  });

  it('is the all-off policy from a gateway with no such route, a 404 without a code', async () => {
    fetchMock.mockResolvedValue(answer(404, { message: 'Cannot GET /api/v1/leave-policy' }));
    await expect(fetchLeavePolicy()).resolves.toEqual(DEFAULT_LEAVE_POLICY);
  });

  it.each([
    [404, { code: 'SCHOOL_NOT_FOUND', message: 'x' }],
    [500, undefined],
    [403, { code: 'FORBIDDEN', message: 'x' }],
  ])('throws a refusal with its own %i as it came', async (status, body) => {
    fetchMock.mockResolvedValue(answer(status, body));
    await expect(fetchLeavePolicy()).rejects.toMatchObject({ name: 'ApiError', status });
  });
});

describe('requestLeave with a contact', () => {
  const base = { studentId: CHILD, startDate: '2026-11-02', endDate: '2026-11-06', reason: 'Familjeresa' };
  const body = () => JSON.parse(fetchMock.mock.calls[0][1].body);

  it('posts the three contact fields trimmed, and hands back what the gateway said about consent and a late request', async () => {
    fetchMock.mockResolvedValue(answer(201, { id: REQUEST, studentId: CHILD, status: 'PENDING', consentRequired: true, shortNotice: true }));
    await expect(
      requestLeave({ ...base, contactName: '  Anna Lind ', contactPhone: ' 070-123 45 67 ', contactRelation: 'Faster\n' }),
    ).resolves.toEqual({ id: REQUEST, studentId: CHILD, status: 'PENDING', consentRequired: true, shortNotice: true });
    expect(body()).toEqual({ ...base, contactName: 'Anna Lind', contactPhone: '070-123 45 67', contactRelation: 'Faster' });
  });

  it('sends none of the three keys for a request without a contact, or with empty fields', async () => {
    fetchMock.mockResolvedValue(answer(201, { id: REQUEST, studentId: CHILD, status: 'PENDING' }));
    await requestLeave(base);
    expect(Object.keys(body()).sort()).toEqual(['endDate', 'reason', 'startDate', 'studentId']);
    fetchMock.mockClear();
    await requestLeave({ ...base, contactName: '', contactPhone: '   ', contactRelation: '' });
    expect(Object.keys(body()).sort()).toEqual(['endDate', 'reason', 'startDate', 'studentId']);
  });

  it('sends a part of a contact as it is, and leaves the verdict to the gateway', async () => {
    fetchMock.mockResolvedValue(answer(201, { id: REQUEST, studentId: CHILD, status: 'PENDING' }));
    await requestLeave({ ...base, contactName: 'Anna Lind' });
    expect(body()).toEqual({ ...base, contactName: 'Anna Lind' });
  });

  it('throws the refusals of the policy with their code and params', async () => {
    fetchMock.mockResolvedValue(refusal(400, 'LEAVE_REQUEST_TOO_LATE', { days: 7 }));
    const error = await requestLeave(base).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'ApiError', status: 400, code: 'LEAVE_REQUEST_TOO_LATE', params: { days: 7 } });
  });
});

describe('answerLeaveConsent', () => {
  it('posts the guardian’s yes to the request’s consent, and hands back what was recorded', async () => {
    fetchMock.mockResolvedValue(answer(201, { id: REQUEST, answer: 'GIVEN', state: 'WAITING' }));
    await expect(answerLeaveConsent(REQUEST, true)).resolves.toEqual({ id: REQUEST, answer: 'GIVEN', state: 'WAITING' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/${REQUEST}/consent`);
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'X-SchemaPro-Client': 'app', Authorization: 'Bearer jwt-guardian', 'Content-Type': 'application/json' },
    });
    expect(JSON.parse(init.body)).toEqual({ consent: true });
  });

  it('posts a no as false, and never anything but the answer', async () => {
    fetchMock.mockResolvedValue(answer(201, { id: REQUEST, answer: 'REFUSED', state: 'REFUSED' }));
    await expect(answerLeaveConsent(REQUEST, false)).resolves.toMatchObject({ answer: 'REFUSED', state: 'REFUSED' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ consent: false });
  });

  it('keeps an id that is not a path segment out of the path', async () => {
    fetchMock.mockResolvedValue(answer(201, { id: 'x', answer: 'GIVEN', state: 'GIVEN' }));
    await answerLeaveConsent('a/b?c', true);
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/a%2Fb%3Fc/consent`);
  });

  it.each([
    [403, 'LEAVE_CONSENT_NOT_A_GUARDIAN'],
    [404, 'LEAVE_CONSENT_NOT_FOUND'],
    [409, 'LEAVE_CONSENT_REQUEST_ENDED'],
    [409, 'LEAVE_CONSENT_CUSTODY_ENDED'],
    [409, 'LEAVE_CONSENT_ANSWERED'],
  ])('throws the gateway’s %i %s as it came', async (status, code) => {
    fetchMock.mockResolvedValue(refusal(status, code));
    await expect(answerLeaveConsent(REQUEST, true)).rejects.toMatchObject({ name: 'ApiError', status, code });
  });
});

describe('withConsentAnswer', () => {
  const asked = {
    ...(leave('l-1', '2026-10-13T08:00:00.000Z') as unknown as LeaveRequestRow),
    consent: { required: true, state: 'WAITING', mine: 'WAITING', asked: null, given: null, waiting: null },
  } as LeaveRequestRow;

  it('turns a yes into the guardian’s own part and where the request stands, and leaves the status', () => {
    const row = withConsentAnswer(asked, { answer: 'GIVEN', state: 'GIVEN' });
    expect(row.consent).toMatchObject({ mine: 'GIVEN', state: 'GIVEN', required: true });
    expect(row.status).toBe('PENDING');
  });

  it('ends the request on a no, as the gateway does', () => {
    const row = withConsentAnswer(asked, { answer: 'REFUSED', state: 'REFUSED' });
    expect(row).toMatchObject({ status: 'GUARDIAN_DECLINED', consent: { mine: 'REFUSED', state: 'REFUSED' } });
  });

  it('keeps where the request stood when the answer did not say', () => {
    expect(withConsentAnswer(asked, { answer: 'GIVEN' }).consent).toMatchObject({ mine: 'GIVEN', state: 'WAITING' });
  });

  it('leaves a row with no consent, and the row it was given, as they are', () => {
    const plain = leave('l-2', '2026-10-13T08:00:00.000Z') as unknown as LeaveRequestRow;
    expect(withConsentAnswer(plain, { answer: 'REFUSED', state: 'REFUSED' })).toBe(plain);
    expect(asked.consent?.mine).toBe('WAITING');
  });
});

describe('filingErrorText', () => {
  const refused = async (code: string, params?: Record<string, string | number>): Promise<unknown> => {
    fetchMock.mockResolvedValue(refusal(400, code, params));
    return requestLeave({ studentId: CHILD, startDate: '2026-11-02', endDate: '2026-11-06', reason: 'Familjeresa' }).catch((e: unknown) => e);
  };

  it('words the school’s minimum with the days the gateway named, in both languages', async () => {
    const error = await refused('LEAVE_REQUEST_TOO_LATE', { days: 7 });
    expect(filingErrorText(error, sv)).toBe('Ansökan kom för sent. Skolan vill ha den minst 7 dagar före första dagen.');
    expect(filingErrorText(error, en)).toBe('The request came too late. The school wants it at least 7 days before the first day.');
  });

  it('says a single day in the singular', async () => {
    const error = await refused('LEAVE_REQUEST_TOO_LATE', { days: 1 });
    expect(filingErrorText(error, sv)).toBe('Ansökan kom för sent. Skolan vill ha den minst 1 dag före första dagen.');
    expect(filingErrorText(error, en)).toBe('The request came too late. The school wants it at least 1 day before the first day.');
  });

  it('takes the policy’s own minimum when the refusal named none, and says so without a number when neither did', async () => {
    const bare = await refused('LEAVE_REQUEST_TOO_LATE');
    expect(filingErrorText(bare, sv, 14)).toBe('Ansökan kom för sent. Skolan vill ha den minst 14 dagar före första dagen.');
    expect(filingErrorText(bare, sv)).toBe('Ansökan kom för sent. Skolan vill ha den längre i förväg.');
    expect(filingErrorText(bare, en)).toBe('The request came too late. The school wants it further ahead.');
    const nonsense = await refused('LEAVE_REQUEST_TOO_LATE', { days: 0 });
    expect(filingErrorText(nonsense, sv, 3)).toBe('Ansökan kom för sent. Skolan vill ha den minst 3 dagar före första dagen.');
  });

  it('words a required and a partly given contact, never with the gateway’s own sentence', async () => {
    const required = await refused('LEAVE_CONTACT_REQUIRED');
    const incomplete = await refused('LEAVE_CONTACT_INCOMPLETE');
    expect(filingErrorText(required, sv)).toBe('Skolan ber om en kontakt under ledigheten. Fyll i namn, telefonnummer och relation.');
    expect(filingErrorText(required, en)).toBe('The school asks for a contact during the leave. Fill in a name, a phone number and a relation.');
    expect(filingErrorText(incomplete, sv)).toBe('En kontakt behöver namn, telefonnummer och relation. Fyll i alla tre eller töm alla.');
    expect(filingErrorText(incomplete, en)).toBe('A contact needs a name, a phone number and a relation. Fill in all three or clear all of them.');
    expect(filingErrorText(required, sv)).not.toContain('Gatewayns');
  });

  it('asks the form to show the contact only for the two contact refusals', async () => {
    expect(asksForContact(await refused('LEAVE_CONTACT_REQUIRED'))).toBe(true);
    expect(asksForContact(await refused('LEAVE_CONTACT_INCOMPLETE'))).toBe(true);
    expect(asksForContact(await refused('LEAVE_REQUEST_TOO_LATE', { days: 7 }))).toBe(false);
    expect(asksForContact(new Error('x'))).toBe(false);
    expect(asksForContact(undefined)).toBe(false);
  });

  it('says the generic sentence for any other refusal, and that the network failed for a phone with none', async () => {
    const other = await refused('LEAVE_REQUEST_TOO_LONG');
    expect(filingErrorText(other, sv)).toBe('Ansökan gick inte att skicka.');
    expect(filingErrorText(other, en)).toBe('The request could not be submitted.');
    expect(filingErrorText(new TypeError('Network request failed'), sv)).toBe('Ansökan gick inte att skicka. Kontrollera anslutningen och försök igen.');
    expect(filingErrorText(new Error('boom'), en)).toBe('The request could not be submitted.');
  });
});

describe('consentErrorText', () => {
  const refused = async (status: number, code?: string): Promise<unknown> => {
    fetchMock.mockResolvedValue(code ? refusal(status, code) : answer(status));
    return answerLeaveConsent(REQUEST, true).catch((e: unknown) => e);
  };

  it.each([
    ['LEAVE_CONSENT_REQUEST_ENDED', 409, 'Ansökan är redan beslutad eller avslutad, så den väntar inte längre på ditt svar.', 'The request is already decided or ended, so it is no longer waiting for your answer.', true],
    ['LEAVE_CONSENT_CUSTODY_ENDED', 409, 'Din vårdnad har upphört, så du kan inte svara på ansökan.', 'Your custody has ended, so you cannot answer the request.', true],
    ['LEAVE_CONSENT_ANSWERED', 409, 'Du har redan svarat på ansökan, och svaret kan inte ändras.', 'You have already answered the request, and the answer cannot be changed.', true],
    ['LEAVE_CONSENT_NOT_FOUND', 404, 'Du har inte fått frågan om den här ansökan.', 'You have not been asked about this request.', true],
    ['LEAVE_CONSENT_NOT_A_GUARDIAN', 403, 'Bara en vårdnadshavare kan svara på ansökan.', 'Only a guardian can answer the request.', false],
  ])('words %s in both languages, and says whether the request has moved on', async (code, status, swedish, english, moved) => {
    const error = await refused(status, code);
    expect(consentErrorText(error, sv)).toEqual({ text: swedish, moved });
    expect(consentErrorText(error, en)).toEqual({ text: english, moved });
  });

  it('asks to try again, and leaves the list, for a phone with no network and for any other failure', async () => {
    expect(consentErrorText(new TypeError('Network request failed'), sv)).toEqual({
      text: 'Svaret gick inte att skicka. Kontrollera anslutningen och försök igen.',
      moved: false,
    });
    expect(consentErrorText(await refused(500), sv)).toEqual({ text: 'Svaret gick inte att skicka. Försök igen.', moved: false });
    expect(consentErrorText(await refused(409, 'SOMETHING_NEW'), en)).toEqual({ text: 'The answer could not be sent. Try again.', moved: false });
    expect(consentErrorText('boom', en).text).toBe('The answer could not be sent. Try again.');
  });
});

describe('omitKey', () => {
  it('takes one request off a per-request record and leaves the record it was given alone', () => {
    const before = { a: true, b: false };
    expect(omitKey(before, 'a')).toEqual({ b: false });
    expect(before).toEqual({ a: true, b: false });
    expect(omitKey(before, 'zzz')).toEqual(before);
  });
});
