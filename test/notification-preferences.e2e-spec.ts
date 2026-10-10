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
