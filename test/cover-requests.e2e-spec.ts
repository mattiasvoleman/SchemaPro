import request from 'supertest';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

/**
 * Vikariefrågan over HTTP: the routes resolve and refuse who they must (the
 * school's side is an administrator's, Drift's; the colleague's side is a
 * teacher's and nobody else's), the DTOs take what the board sends and refuse
 * what they must not (no free text: a question names lessons and colleagues,
 * never a reason or a message), a läsare reads and writes nothing, and a yes
 * with no sender to place it as is refused with its code.
 *
 * The database is mocked, as in every e2e spec; what the rows do under RLS is
 * sections 315–319 of scripts/test/rls-policies.sql, and the first yes against
 * Postgres, six connections at once, is the adapter probe's (cr-a to cr-j).
 */

const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const TEACHER_ID = '66666666-6666-4666-8666-666666666666';
const OTHER_ID = '77777777-7777-4777-8777-777777777777';
const COLLEAGUE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const LESSON = '44444444-4444-4444-8444-444444444444';
const ABSENCE = '55555555-5555-4555-8555-555555555555';
const REQUEST = '88888888-8888-4888-8888-888888888888';

const admin = () => asUser({ role: 'SCHOOL_ADMIN' as never, userId: ADMIN_ID });
const reader = () => asUser({ role: 'SCHOOL_ADMIN' as never, userId: ADMIN_ID, adminProfile: 'LASARE' as never });
const teacher = () => asUser({ role: 'TEACHER' as never, userId: TEACHER_ID });
const student = () => asUser({ role: 'STUDENT' as never, userId: OTHER_ID });
const guardian = () => asUser({ role: 'GUARDIAN' as never, userId: OTHER_ID });

describe('Vikariefrågan (e2e)', () => {
  let harness: TestHarness;
  const http = () => harness.app.getHttpServer();

  beforeAll(async () => {
    harness = await createTestApp();
  });
  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    harness.tx.school.findUnique.mockResolvedValue({ timezone: 'Europe/Stockholm' });
    harness.tx.$queryRaw.mockResolvedValue([]);
    harness.tx.coverRequestRecipient.groupBy.mockResolvedValue([]);
  });

  const body = (overrides: Record<string, unknown> = {}) => ({
    lessons: [{ lessonId: LESSON, absenceId: ABSENCE }],
    recipientIds: [COLLEAGUE],
    ...overrides,
  });
  const send = (method: string, url: string, who: string, payload?: Record<string, unknown> | null) => {
    const call = (request(http()) as unknown as Record<string, (u: string) => request.Test>)[method]!(url).set('x-test-user', who);
    return payload ? call.send(payload) : call;
  };
  const codeOf = (response: request.Response) => (response.body as { code?: string }).code;

  describe('who reaches what', () => {
    const schools: Array<readonly [string, string, Record<string, unknown> | null]> = [
      ['post', '/api/v1/cover/requests', body()],
      ['post', `/api/v1/cover/requests/${REQUEST}/withdraw`, null],
      ['get', '/api/v1/cover/fairness?from=2026-09-01&to=2026-09-30', null],
    ];
    const colleagues: Array<readonly [string, string, Record<string, unknown> | null]> = [
      ['get', '/api/v1/cover-requests/mine', null],
      ['post', `/api/v1/cover-requests/${REQUEST}/accept`, null],
      ['post', `/api/v1/cover-requests/${REQUEST}/decline`, null],
      ['post', `/api/v1/cover-requests/lessons/${LESSON}/confirm`, null],
    ];

    it.each(schools)('%s %s refuses a teacher, a pupil and a guardian', async (method, url, payload) => {
      for (const who of [teacher(), student(), guardian()]) {
        await send(method, url, who, payload).expect(403);
      }
    });

    it.each(colleagues)('%s %s is a teacher’s alone: an administrator, a pupil and a guardian are refused', async (method, url, payload) => {
      for (const who of [admin(), student(), guardian()]) {
        await send(method, url, who, payload).expect(403);
      }
    });

    it.each(schools.slice(0, 2).concat(colleagues.slice(1) as never))('%s %s needs a login', async (method, url, payload) => {
      await send(method, url, '', payload).expect(401);
    });

    it('a läsare reads the fairness view and sends and withdraws nothing, by name', async () => {
      await send('get', '/api/v1/cover/fairness?from=2026-09-01&to=2026-09-30', reader()).expect(200);
      const sent = await send('post', '/api/v1/cover/requests', reader(), body()).expect(403);
      expect(codeOf(sent)).toBeDefined();
      await send('post', `/api/v1/cover/requests/${REQUEST}/withdraw`, reader()).expect(403);
      expect(harness.tx.coverRequest.create).not.toHaveBeenCalled();
    });
  });

  describe('what the DTOs take', () => {
    it.each([
      ['no lessons', body({ lessons: [] })],
      ['thirteen lessons', body({ lessons: Array.from({ length: 13 }, (_, i) => ({ lessonId: LESSON.replace(/4$/, String(i % 10)), absenceId: ABSENCE })) })],
      ['no colleagues', body({ recipientIds: [] })],
      ['a colleague twice', body({ recipientIds: [COLLEAGUE, COLLEAGUE] })],
      ['a colleague that is not an id', body({ recipientIds: ['anna'] })],
      ['a lesson that is not an id', body({ lessons: [{ lessonId: 'x', absenceId: ABSENCE }] })],
      ['four minutes', body({ expiresInMinutes: 4 })],
      ['a day and a half', body({ expiresInMinutes: 721 })],
      ['half a minute', body({ expiresInMinutes: 0.5 })],
      // No free text anywhere: a message would be read by every colleague asked.
      ['a note', body({ note: 'Sjukskriven, kan du ta den?' })],
      ['a message', body({ message: 'Snälla' })],
      ['a reason', body({ reason: 'sjuk' })],
    ])('refuses %s', async (_label, payload) => {
      await send('post', '/api/v1/cover/requests', admin(), payload).expect(400);
      expect(harness.tx.coverRequest.create).not.toHaveBeenCalled();
    });

    it.each(['2026-9-01', '01-09-2026', 'idag', ''])('refuses the fairness period starting %j', async (from) => {
      await send('get', `/api/v1/cover/fairness?from=${from}&to=2026-09-30`, admin()).expect(400);
    });

    it('refuses an id that is not one on the routes that take one', async () => {
      await send('post', '/api/v1/cover/requests/not-an-id/withdraw', admin()).expect(400);
      await send('post', '/api/v1/cover-requests/not-an-id/accept', teacher()).expect(400);
      await send('post', '/api/v1/cover-requests/not-an-id/decline', teacher()).expect(400);
      await send('post', '/api/v1/cover-requests/lessons/not-an-id/confirm', teacher()).expect(400);
    });
  });

  describe('what the routes answer', () => {
    it('lists nothing for a colleague who was asked nothing', async () => {
      const response = await send('get', '/api/v1/cover-requests/mine', teacher()).expect(200);
      expect(response.body).toEqual({ requests: [], passes: [] });
    });

    it('refuses a yes when the database names no sender to place it as, with its code', async () => {
      const response = await send('post', `/api/v1/cover-requests/${REQUEST}/accept`, teacher()).expect(409);
      expect(codeOf(response)).toBe('COVER_REQUEST_SENDER_GONE');
      expect(harness.tx.coverRequest.update).not.toHaveBeenCalled();
    });

    it('answers the fairness view with what the recipient rows count, for the period asked', async () => {
      harness.tx.coverRequestRecipient.groupBy.mockResolvedValue([
        { userId: COLLEAGUE, answer: 'ACCEPTED', _count: { _all: 2 } },
        { userId: COLLEAGUE, answer: 'DECLINED', _count: { _all: 1 } },
      ]);
      const response = await send('get', '/api/v1/cover/fairness?from=2026-09-01&to=2026-09-30', admin()).expect(200);
      expect(response.body).toEqual({
        from: '2026-09-01',
        to: '2026-09-30',
        rows: [{ userId: COLLEAGUE, received: 3, accepted: 2, declined: 1, unanswered: 0 }],
      });
    });

    it('refuses a fairness period over a year, and one that ends before it starts', async () => {
      const long = await send('get', '/api/v1/cover/fairness?from=2025-01-01&to=2026-12-31', admin()).expect(400);
      expect(codeOf(long)).toBe('COVER_RANGE');
      const backwards = await send('get', '/api/v1/cover/fairness?from=2026-09-30&to=2026-09-01', admin()).expect(400);
      expect(codeOf(backwards)).toBe('COVER_RANGE');
    });
  });
});
