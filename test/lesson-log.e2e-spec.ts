import request from 'supertest';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

/**
 * Lektionslogg over HTTP (20261203090000): the doors take what the pages
 * send and refuse what they must not. Who may read and write which row is
 * the database's (RLS sections 230–235, the adapter probe's (ll-*)); here,
 * which roles reach which route, what the DTOs refuse before a service runs,
 * and that an administrator's write is DRIFT's.
 */

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const LESSON_ID = '44444444-4444-4444-8444-444444444444';
const GROUP_ID = '55555555-5555-4555-8555-555555555555';
const EDITED = new Date('2026-10-20T09:15:00.000Z');

/** The SQL of a $queryRaw call, tagged template or Prisma.sql alike. */
const sqlOf = (args: unknown[]): string => {
  const [first] = args as [unknown];
  if (Array.isArray(first)) return (first as string[]).join('?');
  return ((first as { strings?: string[] }).strings ?? []).join('?');
};

describe('Lektionslogg (e2e)', () => {
  let harness: TestHarness;
  const http = () => harness.app.getHttpServer();
  const as = (role: string, extra: Record<string, unknown> = {}) => asUser({ role: role as never, schoolId: SCHOOL_ID, ...extra });
  let role: string | null;

  beforeAll(async () => {
    harness = await createTestApp();
  });
  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    role = 'REGULAR';
    harness.tx.$queryRaw.mockImplementation(async (...args: unknown[]) =>
      sqlOf(args).includes('app.lesson_teacher_role(') ? [{ role }] : [],
    );
    harness.tx.school.findUnique.mockResolvedValue({ timezone: 'Europe/Stockholm', name: 'Demoskolan' });
    harness.tx.calendarLesson.findUnique.mockResolvedValue({
      id: LESSON_ID,
      date: new Date('2026-10-20T00:00:00.000Z'),
      startsAt: new Date('2026-10-20T06:00:00.000Z'),
      endsAt: new Date('2026-10-20T06:45:00.000Z'),
      status: 'SCHEDULED',
      subject: { name: 'Matematik', color: null },
      studentGroup: { name: '7A' },
      extraGroups: [],
      room: null,
      teachers: [],
    });
    harness.tx.lessonLog.findUnique.mockResolvedValue(null);
    harness.tx.lessonSubstituteNote.findUnique.mockResolvedValue(null);
    harness.tx.lessonLog.create.mockResolvedValue({ topic: 'Bråk', homework: null, updatedAt: EDITED, writtenBy: null });
    harness.tx.lessonSubstituteNote.create.mockResolvedValue({ body: 'Läs högt', updatedAt: EDITED, writtenBy: null });
  });

  it('opens a lesson for its teacher and an administrator, never for a pupil or a guardian', async () => {
    const page = await request(http()).get(`/api/v1/lesson-logs/lessons/${LESSON_ID}`).set('x-test-user', as('TEACHER')).expect(200);
    expect(page.body).toMatchObject({ role: 'REGULAR', may: { writeLog: true, readNote: true, writeNote: true }, log: null, note: null });
    await request(http()).get(`/api/v1/lesson-logs/lessons/${LESSON_ID}`).set('x-test-user', as('SCHOOL_ADMIN')).expect(200);
    for (const who of ['STUDENT', 'GUARDIAN']) {
      await request(http()).get(`/api/v1/lesson-logs/lessons/${LESSON_ID}`).set('x-test-user', as(who)).expect(403);
    }
    await request(http()).get('/api/v1/lesson-logs/lessons/not-a-uuid').set('x-test-user', as('TEACHER')).expect(400);
  });

  it('writes the log for the lesson’s teacher, and answers it', async () => {
    const saved = await request(http())
      .put(`/api/v1/lesson-logs/lessons/${LESSON_ID}`)
      .set('x-test-user', as('TEACHER'))
      .send({ topic: 'Bråk', homework: null, basis: null })
      .expect(200);
    expect(saved.body).toEqual({ log: { topic: 'Bråk', homework: null, writtenBy: null, updatedAt: EDITED.toISOString() } });
  });

  it('refuses before the service what the DTO does not take: a topic past 200, a basis that is no instant, a field of another type', async () => {
    for (const body of [
      { topic: 'x'.repeat(201) },
      { homework: 'x'.repeat(1001) },
      { topic: 'x', basis: 'igår' },
      // ISO 8601 that Date cannot read: refused here, never a RangeError's 500.
      { topic: 'x', basis: '2026-W43' },
      { topic: 'x', basis: '20261020' },
      { topic: 'x', basis: '2026-10-20T09:15:00,5Z' },
      { topic: 42 },
    ]) {
      await request(http()).put(`/api/v1/lesson-logs/lessons/${LESSON_ID}`).set('x-test-user', as('TEACHER')).send(body).expect(400);
    }
    await request(http())
      .put(`/api/v1/lesson-logs/lessons/${LESSON_ID}/substitute-note`)
      .set('x-test-user', as('TEACHER'))
      .send({ body: 'x'.repeat(2001) })
      .expect(400);
    expect(harness.tx.lessonLog.create).not.toHaveBeenCalled();
    expect(harness.tx.lessonSubstituteNote.create).not.toHaveBeenCalled();
  });

  it('refuses the substitute the note with the code that says whose it is', async () => {
    role = 'SUBSTITUTE';
    const refused = await request(http())
      .put(`/api/v1/lesson-logs/lessons/${LESSON_ID}/substitute-note`)
      .set('x-test-user', as('TEACHER'))
      .send({ body: 'Tack!' })
      .expect(403);
    expect(refused.body).toMatchObject({ code: 'SUBSTITUTE_NOTE_NOT_YOURS' });
    expect(harness.tx.lessonSubstituteNote.create).not.toHaveBeenCalled();
  });

  it('holds an administrator’s writes to DRIFT: the läsare, who writes no area, is refused; the expedition writes', async () => {
    const reader = await request(http())
      .put(`/api/v1/lesson-logs/lessons/${LESSON_ID}`)
      .set('x-test-user', as('SCHOOL_ADMIN', { adminProfile: 'LASARE' }))
      .send({ topic: 'x' })
      .expect(403);
    expect(reader.body).toMatchObject({ code: 'AREA_NOT_YOURS' });
    await request(http())
      .put(`/api/v1/lesson-logs/lessons/${LESSON_ID}/substitute-note`)
      .set('x-test-user', as('SCHOOL_ADMIN', { adminProfile: 'LASARE' }))
      .send({ body: 'x' })
      .expect(403);
    await request(http())
      .put(`/api/v1/lesson-logs/lessons/${LESSON_ID}`)
      .set('x-test-user', as('SCHOOL_ADMIN', { adminProfile: 'EXPEDITION' }))
      .send({ topic: 'Bråk' })
      .expect(200);
  });

  it('lists the caller’s own lessons for a pupil and a teacher, not for a guardian or an administrator, and refuses a bad range', async () => {
    for (const who of ['STUDENT', 'TEACHER']) {
      await request(http()).get('/api/v1/lesson-logs?from=2026-10-19&to=2026-10-25').set('x-test-user', as(who)).expect(200);
    }
    for (const who of ['GUARDIAN', 'SCHOOL_ADMIN']) {
      await request(http()).get('/api/v1/lesson-logs?from=2026-10-19&to=2026-10-25').set('x-test-user', as(who)).expect(403);
    }
    const bad = await request(http()).get('/api/v1/lesson-logs?from=2026-10-25&to=2026-10-19').set('x-test-user', as('TEACHER')).expect(400);
    expect(bad.body).toMatchObject({ code: 'LESSON_LOG_RANGE' });
    await request(http()).get('/api/v1/lesson-logs?from=igår&to=2026-10-19').set('x-test-user', as('TEACHER')).expect(400);
  });

  it('lists a teacher’s handed-over lessons for the teacher alone', async () => {
    await request(http()).get('/api/v1/lesson-logs/handed-over?from=2026-10-19&to=2026-10-25').set('x-test-user', as('TEACHER')).expect(200);
    for (const who of ['STUDENT', 'GUARDIAN', 'SCHOOL_ADMIN']) {
      await request(http()).get('/api/v1/lesson-logs/handed-over?from=2026-10-19&to=2026-10-25').set('x-test-user', as(who)).expect(403);
    }
  });

  it('prints the klassbok for staff, never for a pupil or a guardian', async () => {
    harness.tx.studentGroup.findFirst.mockResolvedValue({ id: GROUP_ID, name: '7A', kind: 'CLASS', school: { name: 'Demoskolan' } });
    const book = await request(http())
      .get(`/api/v1/lesson-logs/class-book?groupId=${GROUP_ID}&from=2026-10-19&to=2026-10-25`)
      .set('x-test-user', as('TEACHER'))
      .expect(200);
    expect(book.body).toMatchObject({ school: 'Demoskolan', group: { id: GROUP_ID, name: '7A' }, lessons: [] });
    await request(http())
      .get(`/api/v1/lesson-logs/class-book?groupId=${GROUP_ID}&from=2026-10-19&to=2026-10-25`)
      .set('x-test-user', as('SCHOOL_ADMIN', { adminProfile: 'LASARE' }))
      .expect(200);
    for (const who of ['STUDENT', 'GUARDIAN']) {
      await request(http())
        .get(`/api/v1/lesson-logs/class-book?groupId=${GROUP_ID}&from=2026-10-19&to=2026-10-25`)
        .set('x-test-user', as(who))
        .expect(403);
    }
    await request(http())
      .get('/api/v1/lesson-logs/class-book?groupId=nope&from=2026-10-19&to=2026-10-25')
      .set('x-test-user', as('TEACHER'))
      .expect(400);
  });
});
