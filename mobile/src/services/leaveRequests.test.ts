import { getAccessToken, getSupabase } from './supabase';
import { ApiError } from './api';
import { deciderOf, fetchLeaveRequests, requestLeave } from './leaveRequests';

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
