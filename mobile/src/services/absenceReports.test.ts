import { getAccessToken, getSupabase } from './supabase';
import { ApiError } from './api';
import { fetchAbsenceReports, removeAbsenceReport, reportAbsence } from './absenceReports';

jest.mock('./supabase', () => ({ getAccessToken: jest.fn(), getSupabase: jest.fn() }));

/**
 * A guardian's absence reports, through the real gateway client against a
 * stubbed fetch: the request the gateway receives (URL, method, body) and what
 * the home screen is handed back. Supabase fails the test if asked: the screen
 * read AbsenceReports, and the child's Users row for its school, itself until
 * the read log needed every read of a child to pass the gateway.
 */

const CHILD = '5f0c6a2e-1b7d-4c3e-9a51-2d8e4f6b7c90';
const REPORT = '9b2d7e41-3c5a-4f8b-8e16-7a0c2d4f5e63';
const BASE = 'https://api.example.test/api/v1/absence-reports';

const fetchMock = jest.fn();
const answer = (status: number, body?: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => (body === undefined ? '' : JSON.stringify(body)),
});

const report = (id: string, date: string, createdAt: string) => ({
  id,
  studentId: CHILD,
  reportedById: 'g-1',
  date,
  startTime: null,
  endTime: null,
  type: 'SICK',
  note: null,
  createdAt,
});

beforeEach(() => {
  process.env['EXPO_PUBLIC_API_BASE_URL'] = 'https://api.example.test/';
  Object.defineProperty(global, 'fetch', { value: fetchMock, writable: true, configurable: true });
  fetchMock.mockReset();
  (getAccessToken as jest.Mock).mockResolvedValue('jwt-guardian');
  (getSupabase as jest.Mock).mockImplementation(() => {
    throw new Error('Absence reports are the gateway’s to answer, and to log.');
  });
});

describe('fetchAbsenceReports', () => {
  it('asks the gateway, and shows the first 30 in the gateway’s order', async () => {
    // Newest day first, two reports on one day newest first: the order a
    // re-sort by date alone would be free to swap.
    const rows = [
      report('same-day-later', '2026-11-30', '2026-11-29T18:00:00.000Z'),
      report('same-day-earlier', '2026-11-30', '2026-11-29T07:00:00.000Z'),
      ...Array.from({ length: 43 }, (_, i) =>
        report(`r-${i}`, `2026-10-${String(29 - Math.floor(i / 2)).padStart(2, '0')}`, '2026-10-01T08:00:00.000Z'),
      ),
    ];
    fetchMock.mockResolvedValue(answer(200, rows));
    const shown = await fetchAbsenceReports();
    expect(fetchMock).toHaveBeenCalledWith(BASE, {
      method: 'GET',
      headers: { 'X-SchemaPro-Client': 'app', Authorization: 'Bearer jwt-guardian' },
    });
    expect(shown).toHaveLength(30);
    expect(shown.map((row) => row.id)).toEqual(rows.slice(0, 30).map((row) => row.id));
    expect(shown[0]).toEqual(rows[0]);
    expect(getSupabase).not.toHaveBeenCalled();
  });

  it('shows a short answer whole', async () => {
    fetchMock.mockResolvedValue(answer(200, [report('only', '2026-10-14', '2026-10-13T06:00:00.000Z')]));
    await expect(fetchAbsenceReports()).resolves.toHaveLength(1);
  });

  it('throws the gateway’s refusal as it came', async () => {
    fetchMock.mockResolvedValue(answer(503));
    const error = await fetchAbsenceReports().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 503 });
  });
});

describe('reportAbsence', () => {
  it('posts the child, the day and the reason, and nothing the gateway derives itself', async () => {
    // The gateway answers the stored day as a timestamp at UTC midnight.
    fetchMock.mockResolvedValue(answer(201, { id: REPORT, studentId: CHILD, date: '2026-10-14T00:00:00.000Z' }));
    await expect(reportAbsence({ studentId: CHILD, date: '2026-10-14', type: 'APPOINTMENT' })).resolves.toEqual({
      id: REPORT,
      studentId: CHILD,
      date: '2026-10-14T00:00:00.000Z',
    });
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
    // No schoolId and no reportedById: the gateway takes them from the pupil
    // and the bearer. No hours and no note: the screen asks for neither.
    expect(JSON.parse(init.body)).toEqual({ studentId: CHILD, date: '2026-10-14', type: 'APPOINTMENT' });
  });

  it('throws a refusal with its status: another family’s child, a malformed day', async () => {
    fetchMock.mockResolvedValueOnce(answer(403, { message: 'Not a guardian of this student.' }));
    await expect(reportAbsence({ studentId: CHILD, date: '2026-10-14', type: 'SICK' })).rejects.toMatchObject({
      name: 'ApiError',
      status: 403,
    });
    fetchMock.mockResolvedValueOnce(answer(400, { message: 'date must be YYYY-MM-DD.' }));
    await expect(reportAbsence({ studentId: CHILD, date: '14/10', type: 'SICK' })).rejects.toMatchObject({
      name: 'ApiError',
      status: 400,
    });
  });
});

describe('removeAbsenceReport', () => {
  it('deletes the one report by its id, through the gateway', async () => {
    fetchMock.mockResolvedValue(answer(200, { id: REPORT }));
    await expect(removeAbsenceReport(REPORT)).resolves.toEqual({ id: REPORT });
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/${REPORT}`, {
      method: 'DELETE',
      headers: { 'X-SchemaPro-Client': 'app', Authorization: 'Bearer jwt-guardian' },
    });
  });

  it('keeps an id inside its own path segment', async () => {
    fetchMock.mockResolvedValue(answer(200, { id: 'x' }));
    await removeAbsenceReport('../leave-requests/x');
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/..%2Fleave-requests%2Fx`);
  });

  it('throws the gateway’s refusal of a past report with its sentence', async () => {
    fetchMock.mockResolvedValue(answer(400, { message: 'Past absence reports cannot be removed.' }));
    await expect(removeAbsenceReport(REPORT)).rejects.toMatchObject({
      name: 'ApiError',
      status: 400,
      message: 'Past absence reports cannot be removed.',
    });
  });
});
