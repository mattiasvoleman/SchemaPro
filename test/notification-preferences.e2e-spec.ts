import request from 'supertest';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

/**
 * GET and PUT /api/v1/notification-preferences per role: each person reads and
 * replaces their own set, a required or foreign type is a 400, and every
 * write names the caller. That the rows are really own-only is RLS 29e.
 */

const SCHOOL = '33333333-3333-4333-8333-333333333333';
const ME = '22222222-2222-4222-8222-222222222222';
const who = (role: string) => asUser({ role: role as never, userId: ME, schoolId: SCHOOL });

describe('notification preferences (e2e)', () => {
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
    harness.tx.notificationOptOut.findMany.mockResolvedValue([]);
  });

  it.each(['GUARDIAN', 'STUDENT', 'TEACHER', 'SCHOOL_ADMIN'])('lets a %s read and replace their own set', async (role) => {
    const listed = await request(http()).get('/api/v1/notification-preferences').set('x-test-user', who(role)).expect(200);
    const optional = (listed.body.types as Array<{ type: string; required: boolean; enabled: boolean }>).filter((t) => !t.required);
    expect(optional.length).toBeGreaterThan(0);
    expect(listed.body.types.every((t: { enabled: boolean }) => t.enabled)).toBe(true);

    const put = await request(http())
      .put('/api/v1/notification-preferences')
      .set('x-test-user', who(role))
      .send({ optOut: [optional[0]!.type] })
      .expect(200);
    expect(put.body.types.find((t: { type: string }) => t.type === optional[0]!.type).enabled).toBe(false);
    expect(harness.tx.notificationOptOut.deleteMany).toHaveBeenCalledWith({ where: { userId: ME } });
    expect(harness.tx.notificationOptOut.createMany).toHaveBeenCalledWith({
      data: [{ userId: ME, schoolId: SCHOOL, type: optional[0]!.type }],
    });
  });

  it.each([
    ['a guardian', 'GUARDIAN', ['ABSENCE_UNREPORTED'], 'NOTIFICATION_TYPE_REQUIRED'],
    ['a teacher', 'TEACHER', ['LESSON_COVER_WITHDRAWN'], 'NOTIFICATION_TYPE_REQUIRED'],
    ['an admin', 'SCHOOL_ADMIN', ['LESSON_COVER_WITHDRAWN'], 'NOTIFICATION_TYPE_REQUIRED'],
    ['a pupil', 'STUDENT', ['ROOM_BOOKING_DECIDED'], 'NOTIFICATION_TYPE_NOT_OFFERED'],
    ['an admin', 'SCHOOL_ADMIN', ['TEACHER_ABSENCE_REPORTED'], 'NOTIFICATION_TYPE_NOT_OFFERED'],
  ])('refuses %s opting out of %s', async (_name, role, optOut, code) => {
    const response = await request(http()).put('/api/v1/notification-preferences').set('x-test-user', who(role)).send({ optOut }).expect(400);
    expect(response.body.code).toBe(code);
    expect(harness.tx.notificationOptOut.deleteMany).not.toHaveBeenCalled();
  });

  // Administratör som lärare (Users.teaches): the teacher's three notices are the person's to turn off, and the cover request is not
  // theirs to receive (SP409). Whether the switch is offered is the principal's mark, the one the guard reads from the login.
  describe('an administrator who teaches (Users.teaches)', () => {
    const THREE = ['LESSON_PUPIL_MOVED', 'LEAVE_REQUESTED', 'LESSON_REPORT_REMINDER'];
    const admin = (extra: Record<string, unknown>) => asUser({ role: 'SCHOOL_ADMIN' as never, userId: ME, schoolId: SCHOOL, adminProfile: 'REKTOR' as never, ...extra });
    const typesOf = (body: { types: Array<{ type: string }> }) => body.types.map((t) => t.type);

    it('sees the three beside the administrator’s own, and an unmarked administrator does not', async () => {
      const marked = await request(http()).get('/api/v1/notification-preferences').set('x-test-user', admin({ teaches: true })).expect(200);
      for (const type of THREE) expect(typesOf(marked.body)).toContain(type);
      expect(typesOf(marked.body)).not.toContain('COVER_REQUESTED');
      for (const extra of [{ teaches: false }, {}]) {
        const plain = await request(http()).get('/api/v1/notification-preferences').set('x-test-user', admin(extra)).expect(200);
        for (const type of THREE) expect(typesOf(plain.body)).not.toContain(type);
      }
    });

    it('turns the three off and gets the answer back with them off', async () => {
      const put = await request(http()).put('/api/v1/notification-preferences').set('x-test-user', admin({ teaches: true })).send({ optOut: THREE }).expect(200);
      expect(put.body.types.filter((t: { type: string }) => THREE.includes(t.type)).map((t: { enabled: boolean }) => t.enabled)).toEqual([false, false, false]);
      expect(harness.tx.notificationOptOut.createMany).toHaveBeenCalledWith({ data: THREE.map((type) => ({ userId: ME, schoolId: SCHOOL, type })) });
    });

    it.each([
      ['an administrator who does not teach', { teaches: false }, 'LEAVE_REQUESTED'],
      ['an administrator who does not teach', {}, 'LESSON_REPORT_REMINDER'],
      ['an administrator who does not teach', { teaches: false }, 'LESSON_PUPIL_MOVED'],
      ['an administrator who teaches', { teaches: true }, 'COVER_REQUESTED'],
    ])('refuses %s choosing %s: 400 NOTIFICATION_TYPE_NOT_OFFERED, writing nothing', async (_who, extra, type) => {
      const response = await request(http()).put('/api/v1/notification-preferences').set('x-test-user', admin(extra)).send({ optOut: [type] }).expect(400);
      expect(response.body.code).toBe('NOTIFICATION_TYPE_NOT_OFFERED');
      expect(harness.tx.notificationOptOut.deleteMany).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['an unknown type', { optOut: ['LUNCH'] }],
    ['a type twice', { optOut: ['LESSON_CANCELLED', 'LESSON_CANCELLED'] }],
    ['no list', {}],
    ['somebody else', { optOut: [], userId: '99999999-9999-4999-8999-999999999999' }],
  ])('refuses %s with 400', async (_name, body) => {
    await request(http()).put('/api/v1/notification-preferences').set('x-test-user', who('GUARDIAN')).send(body).expect(400);
    expect(harness.tx.notificationOptOut.deleteMany).not.toHaveBeenCalled();
  });

  it('refuses a caller without a principal', async () => {
    await request(http()).get('/api/v1/notification-preferences').expect(401);
  });
});
