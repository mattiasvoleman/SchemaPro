import request from 'supertest';
import { PER_LOGIN_INVITATIONS } from '../src/users/invitation-throttler.guard';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

/**
 * POST /api/v1/users/invitations and GET /api/v1/users/invitation-channel (Första veckan utan operatören), with the production rate
 * limiter on. The web sends a mass invitation in parts of twenty, one part at a time, from the browser of whoever pressed the button; a
 * school is one address. The route was five a minute per ADDRESS, so a run of fifteen parts was refused at the sixth and every other
 * administrator of the school was refused with it.
 */
describe('the mass invitation under the rate limiter (e2e)', () => {
  let harness: TestHarness;
  const http = () => harness.app.getHttpServer();
  const PERSON = '44444444-4444-4444-8444-444444444444';
  const administrator = (n: number) =>
    asUser({ authId: `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`, userId: `00000000-0000-4000-9000-${n.toString(16).padStart(12, '0')}` });
  const part = (user: string, extra: Record<string, unknown> = {}) =>
    request(http()).post('/api/v1/users/invitations').set('x-test-user', user).send({ userIds: [PERSON], ...extra });

  beforeAll(async () => {
    harness = await createTestApp({ throttle: true });
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    harness.tx['user']!['findUnique']!.mockResolvedValue({ id: PERSON, email: 'elev@example.com', isActive: true, authId: PERSON, invitedAt: null, role: 'STUDENT' });
    harness.tx['user']!['update']!.mockResolvedValue({ id: PERSON });
  });

  it('answers a run of fifteen parts from one login, which the five a minute per address refused at the sixth', async () => {
    const rektor = administrator(1);
    for (let n = 1; n <= 15; n += 1) await part(rektor).expect(200);
  });

  it('stops one login past its own limit, and only that login: the school\'s other administrators are not blocked with it', async () => {
    const rektor = administrator(2);
    for (let n = 0; n < PER_LOGIN_INVITATIONS.limit; n += 1) await part(rektor).expect(200);
    await part(rektor).expect(429);
    // The same address, other logins.
    await part(administrator(3)).expect(200);
    await part(administrator(4)).expect(200);
  });

  it('takes `resend`, and nothing that is not a boolean', async () => {
    await part(administrator(5), { resend: true }).expect(200);
    await part(administrator(5), { resend: 'yes' }).expect(400);
    await part(administrator(5), { somethingElse: true }).expect(400);
  });

  it('skips a person invited already and says so, over the real pipe', async () => {
    // The person is read after being claimed, one at a time (UsersService.inviteMany), not from a list read before the part began.
    harness.tx['user']!['findUnique']!.mockResolvedValue({ id: PERSON, email: 'elev@example.com', isActive: true, authId: PERSON, invitedAt: new Date('2026-11-25T09:00:00.000Z'), role: 'STUDENT' });
    harness.supabase.inviteUser.mockClear();

    const response = await part(administrator(6)).expect(200);

    expect(response.body).toMatchObject({ sent: 0, alreadyInvited: 1, noAddress: 0, errors: [] });
    expect(harness.supabase.inviteUser).not.toHaveBeenCalled();
  });

  it('says what the operator has said of the sender, and nothing of any person', async () => {
    const response = await request(http()).get('/api/v1/users/invitation-channel').set('x-test-user', administrator(7)).expect(200);

    // The test environment says nothing (AUTH_SMTP is not set), and the harness's Supabase stand-in is a configured one.
    expect(response.body).toEqual({ configured: true, smtp: 'NOT_STATED', perHour: null });
  });

  it('is an administrator\'s to ask, and no teacher\'s', async () => {
    await request(http()).get('/api/v1/users/invitation-channel').set('x-test-user', asUser({ role: 'TEACHER' as never })).expect(403);
  });
});
