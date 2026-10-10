import request from 'supertest';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';
import { NotificationDeliveryService } from '../src/notifications/notification-delivery.service';

const LESSON_ID = '44444444-4444-4444-8444-444444444444';
const STUDENT_A = '55555555-5555-4555-8555-555555555555';
const STUDENT_B = '66666666-6666-4666-8666-666666666666';
const TEACHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const PRIMARY_GROUP = '11111111-1111-4111-8111-aaaaaaaaaaaa';

/**
 * A lesson as the service selects it. `startsAt`/`endsAt` are instants for a
 * 09:00–09:45 Stockholm wall clock, which is what CalendarService writes.
 */
const LESSON = {
  id: LESSON_ID,
  schoolId: SCHOOL_ID,
  studentGroupId: PRIMARY_GROUP,
  date: new Date('2026-09-02T00:00:00.000Z'),
  startsAt: new Date('2026-09-02T07:00:00.000Z'),
  endsAt: new Date('2026-09-02T07:45:00.000Z'),
  subject: { name: 'Matematik' },
  school: { timezone: 'Europe/Stockholm' },
  extraGroups: [],
};

describe('POST /api/v1/attendance/report (e2e)', () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = await createTestApp();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  /** Puts `studentIds` on the lesson roster via the home-class membership. */
  const arrangeRoster = (studentIds: string[]) => {
    harness.tx['user']!['findMany']!.mockResolvedValue(
      studentIds.map((id) => ({ id })),
    );
  };

  it('rejects unauthenticated requests', async () => {
    await request(harness.app.getHttpServer())
      .post('/api/v1/attendance/report')
      .send({ calendarLessonId: LESSON_ID, records: [] })
      .expect(401);
  });

  it('rejects students (RBAC)', async () => {
    await request(harness.app.getHttpServer())
      .post('/api/v1/attendance/report')
      .set('x-test-user', asUser({ role: 'STUDENT' as never }))
      .send({
        calendarLessonId: LESSON_ID,
        records: [{ studentId: STUDENT_A, status: 'PRESENT' }],
      })
      .expect(403);
  });

  it('rejects malformed payloads (validation pipe)', async () => {
    await request(harness.app.getHttpServer())
      .post('/api/v1/attendance/report')
      .set('x-test-user', asUser({ role: 'TEACHER' as never }))
      .send({ calendarLessonId: 'not-a-uuid', records: [] })
      .expect(400);
  });

  it('accepts a batch from an assigned teacher and upserts records', async () => {
    const now = new Date();
    harness.tx['calendarLesson']!['findUnique']!.mockResolvedValue(LESSON);
    harness.tx['calendarLessonTeacher']!['findUnique']!.mockResolvedValue({
      id: '77777777-7777-4777-8777-777777777777',
    });
    arrangeRoster([STUDENT_A, STUDENT_B]);
    // First record is new (createdAt == updatedAt), second is an update.
    harness.tx['attendanceRecord']!['upsert']!
      .mockResolvedValueOnce({ createdAt: now, updatedAt: now })
      .mockResolvedValueOnce({
        createdAt: now,
        updatedAt: new Date(now.getTime() + 60_000),
      });

    const response = await request(harness.app.getHttpServer())
      .post('/api/v1/attendance/report')
      .set('x-test-user', asUser({ role: 'TEACHER' as never, userId: TEACHER_USER_ID }))
      .send({
        calendarLessonId: LESSON_ID,
        records: [
          { studentId: STUDENT_A, status: 'PRESENT' },
          { studentId: STUDENT_B, status: 'LATE', note: 'Bus delay' },
        ],
      })
      .expect(200);

    expect(response.body).toEqual({ created: 1, updated: 1 });
    expect(harness.tx['attendanceRecord']!['upsert']).toHaveBeenCalledTimes(2);
  });

  it('a teacher’s submit that marks a pupil absent answers 200, writes the guardian’s notice without reading it back, and mails once after the response', async () => {
    const realFetch = globalThis.fetch;
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    process.env.RESEND_API_KEY = 'resend-key';
    try {
      const now = new Date();
      harness.tx['calendarLesson']!['findUnique']!.mockResolvedValue(LESSON);
      harness.tx['calendarLessonTeacher']!['findUnique']!.mockResolvedValue({ id: '77777777-7777-4777-8777-777777777777' });
      // The roster, the pupil's name and the guardian's address, as each read asks.
      harness.tx['user']!['findMany']!.mockResolvedValue([
        { id: STUDENT_A, firstName: 'Ella', lastName: 'Ek', email: 'vh@example.invalid' },
      ]);
      harness.tx['attendanceRecord']!['upsert']!.mockResolvedValue({ createdAt: now, updatedAt: now });
      harness.tx['absenceReport']!['findMany']!.mockResolvedValue([]);
      harness.tx['guardianStudent']!['findMany']!.mockResolvedValue([{ guardianId: '88888888-8888-4888-8888-888888888888' }]);

      await request(harness.app.getHttpServer())
        .post('/api/v1/attendance/report')
        .set('x-test-user', asUser({ role: 'TEACHER' as never, userId: TEACHER_USER_ID }))
        .send({ calendarLessonId: LESSON_ID, records: [{ studentId: STUDENT_A, status: 'ABSENT' }] })
        .expect(200);

      const { data } = harness.tx['notification']!['createMany']!.mock.calls[0]![0] as { data: Array<{ id: string; type: string }> };
      expect(data).toEqual([expect.objectContaining({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), type: 'ABSENCE_UNREPORTED' })]);
      expect(harness.tx['notification']!['createManyAndReturn']).not.toHaveBeenCalled();

      await new Promise((resolve) => setImmediate(resolve));
      await harness.app.get(NotificationDeliveryService).idle();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]![0]).toBe('https://api.resend.com/emails');
      expect(JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body).bcc).toEqual(['vh@example.invalid']);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.RESEND_API_KEY;
    }
  });

  it('returns 403 when the teacher is not assigned to the lesson', async () => {
    harness.tx['calendarLesson']!['findUnique']!.mockResolvedValue(LESSON);
    harness.tx['calendarLessonTeacher']!['findUnique']!.mockResolvedValue(null);

    await request(harness.app.getHttpServer())
      .post('/api/v1/attendance/report')
      .set('x-test-user', asUser({ role: 'TEACHER' as never, userId: TEACHER_USER_ID }))
      .send({
        calendarLessonId: LESSON_ID,
        records: [{ studentId: STUDENT_A, status: 'PRESENT' }],
      })
      .expect(403);
  });

  it('returns 403 for a student who is not on the lesson roster', async () => {
    harness.tx['calendarLesson']!['findUnique']!.mockResolvedValue(LESSON);
    harness.tx['calendarLessonTeacher']!['findUnique']!.mockResolvedValue({
      id: '77777777-7777-4777-8777-777777777777',
    });
    // Nobody is a member of anything — the payload names a stranger.
    arrangeRoster([]);

    const response = await request(harness.app.getHttpServer())
      .post('/api/v1/attendance/report')
      .set('x-test-user', asUser({ role: 'TEACHER' as never, userId: TEACHER_USER_ID }))
      .send({
        calendarLessonId: LESSON_ID,
        records: [{ studentId: STUDENT_B, status: 'ABSENT' }],
      })
      .expect(403);

    expect(response.body.detail).toContain(STUDENT_B);
    expect(harness.tx['attendanceRecord']!['upsert']).not.toHaveBeenCalled();
  });

  it('applies the roster check to admins as well as teachers', async () => {
    harness.tx['calendarLesson']!['findUnique']!.mockResolvedValue(LESSON);
    arrangeRoster([]);

    await request(harness.app.getHttpServer())
      .post('/api/v1/attendance/report')
      .set('x-test-user', asUser({ role: 'SCHOOL_ADMIN' as never }))
      .send({
        calendarLessonId: LESSON_ID,
        records: [{ studentId: STUDENT_B, status: 'PRESENT' }],
      })
      .expect(403);

    expect(harness.tx['attendanceRecord']!['upsert']).not.toHaveBeenCalled();
  });

  it('returns 404 for a lesson outside the caller school (RLS semantics)', async () => {
    harness.tx['calendarLesson']!['findUnique']!.mockResolvedValue(null);

    await request(harness.app.getHttpServer())
      .post('/api/v1/attendance/report')
      .set('x-test-user', asUser({ role: 'SCHOOL_ADMIN' as never }))
      .send({
        calendarLessonId: LESSON_ID,
        records: [{ studentId: STUDENT_A, status: 'PRESENT' }],
      })
      .expect(404);
  });
});
