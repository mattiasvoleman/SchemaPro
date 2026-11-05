import request from 'supertest';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

/**
 * Krisläge over HTTP: the routes resolve and refuse who they must (the
 * school's side is an administrator's, Drift's, and the settings are for those
 * who decide; the teacher's side is a teacher's and nobody else's; a pupil and
 * a guardian reach none of it), the DTOs take what a phone sends and refuse
 * what they must not (a mark names a pupil, a group and a state; there is no
 * free text but the note an administrator writes when ending an alarm), and a
 * läsare reads and writes nothing, by name.
 *
 * The database is mocked, as in every e2e spec; what the rows do under RLS is
 * sections 350-354 of scripts/test/rls-policies.sql, and the snapshot of a
 * school day, the vikarie, the replacement lesson and the alarm in a break
 * against Postgres are the adapter probe's (kl-a to kl-g).
 */

const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const TEACHER_ID = '66666666-6666-4666-8666-666666666666';
const OTHER_ID = '77777777-7777-4777-8777-777777777777';
const ALARM = '88888888-8888-4888-8888-888888888888';
const CALL = '99999999-9999-4999-8999-999999999999';
const PUPIL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MARK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const LESSON = '44444444-4444-4444-8444-444444444444';

const admin = () => asUser({ role: 'SCHOOL_ADMIN' as never, userId: ADMIN_ID });
const planner = () => asUser({ role: 'SCHOOL_ADMIN' as never, userId: ADMIN_ID, adminProfile: 'SCHEMALAGGARE' as never });
const reader = () => asUser({ role: 'SCHOOL_ADMIN' as never, userId: ADMIN_ID, adminProfile: 'LASARE' as never });
const teacher = () => asUser({ role: 'TEACHER' as never, userId: TEACHER_ID });
const student = () => asUser({ role: 'STUDENT' as never, userId: OTHER_ID });
const guardian = () => asUser({ role: 'GUARDIAN' as never, userId: OTHER_ID });

describe('Krisläge (e2e)', () => {
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
  });

  const mark = (overrides: Record<string, unknown> = {}) => ({
    id: MARK,
    callId: CALL,
    studentId: PUPIL,
    state: 'FOUND',
    at: '2027-01-12T09:14:03Z',
    ...overrides,
  });
  const send = (method: string, url: string, who: string, payload?: Record<string, unknown> | null) => {
    const call = (request(http()) as unknown as Record<string, (u: string) => request.Test>)[method]!(url).set('x-test-user', who);
    return payload ? call.send(payload) : call;
  };
  const codeOf = (response: request.Response) => (response.body as { code?: string }).code;

  describe('who reaches what', () => {
    const schools: Array<readonly [string, string, Record<string, unknown> | null]> = [
      ['get', '/api/v1/crisis/settings', null],
      ['put', '/api/v1/crisis/settings', { startProfiles: ['FULL'], notifyGuardiansAfter: false }],
      ['get', '/api/v1/crisis/alarms', null],
      ['post', '/api/v1/crisis/alarms', { kind: 'EVACUATION', mode: 'DRILL' }],
      ['get', `/api/v1/crisis/alarms/${ALARM}`, null],
      ['get', `/api/v1/crisis/alarms/${ALARM}/protocol`, null],
      ['post', `/api/v1/crisis/alarms/${ALARM}/end`, {}],
      ['post', `/api/v1/crisis/alarms/${ALARM}/marks`, { marks: [mark()] }],
    ];
    const teachers: Array<readonly [string, string, Record<string, unknown> | null]> = [
      ['get', '/api/v1/crisis/mine', null],
      ['post', '/api/v1/crisis/mine/marks', { marks: [mark()] }],
    ];

    it.each(schools)('%s %s is the administration\'s: a teacher, a pupil and a guardian are refused', async (method, url, payload) => {
      for (const who of [teacher(), student(), guardian()]) {
        await send(method, url, who, payload).expect(403);
      }
    });

    it.each(teachers)('%s %s is a teacher\'s alone: an administrator, a pupil and a guardian are refused', async (method, url, payload) => {
      for (const who of [admin(), student(), guardian()]) {
        await send(method, url, who, payload).expect(403);
      }
    });

    it.each([...schools, ...teachers])('%s %s needs a login', async (method, url, payload) => {
      await send(method, url, '', payload).expect(401);
    });

    it('a läsare reads and starts, ends, marks and decides nothing, by name', async () => {
      await send('get', '/api/v1/crisis/settings', reader()).expect(200);
      await send('get', '/api/v1/crisis/alarms', reader()).expect(200);
      await send('post', '/api/v1/crisis/alarms', reader(), { kind: 'EVACUATION', mode: 'DRILL' }).expect(403);
      await send('post', `/api/v1/crisis/alarms/${ALARM}/end`, reader(), {}).expect(403);
      await send('post', `/api/v1/crisis/alarms/${ALARM}/marks`, reader(), { marks: [mark()] }).expect(403);
      await send('put', '/api/v1/crisis/settings', reader(), { startProfiles: ['FULL'], notifyGuardiansAfter: false }).expect(403);
      expect(harness.tx.crisisAlarm.create).not.toHaveBeenCalled();
      expect(harness.tx.crisisSettings.upsert).not.toHaveBeenCalled();
    });

    it('the settings are for those who decide: a schemaläggare reads them and writes nothing', async () => {
      await send('get', '/api/v1/crisis/settings', planner()).expect(200);
      await send('put', '/api/v1/crisis/settings', planner(), { startProfiles: ['SCHEMALAGGARE'], notifyGuardiansAfter: true }).expect(403);
      expect(harness.tx.crisisSettings.upsert).not.toHaveBeenCalled();
      harness.tx.crisisSettings.upsert.mockResolvedValue({ startProfiles: ['EXPEDITION'], notifyGuardiansAfter: true });
      const saved = await send('put', '/api/v1/crisis/settings', admin(), { startProfiles: ['EXPEDITION'], notifyGuardiansAfter: true }).expect(200);
      expect(saved.body).toEqual({ startProfiles: ['EXPEDITION'], notifyGuardiansAfter: true });
    });
  });

  describe('what the DTOs take', () => {
    it.each([
      ['no kind', { mode: 'DRILL' }],
      ['no mode', { kind: 'EVACUATION' }],
      ['a kind that is not one', { kind: 'FIRE', mode: 'DRILL' }],
      ['a mode that is not one', { kind: 'EVACUATION', mode: 'TEST' }],
      ['a message', { kind: 'EVACUATION', mode: 'DRILL', message: 'Brand i hus B' }],
    ])('refuses to start an alarm with %s', async (_label, payload) => {
      await send('post', '/api/v1/crisis/alarms', admin(), payload).expect(400);
      expect(harness.tx.crisisAlarm.create).not.toHaveBeenCalled();
    });

    it.each([
      ['a note over 300 characters', { note: 'x'.repeat(301) }],
      ['an empty note', { note: '' }],
      ['anything but a note', { reason: 'falsklarm' }],
    ])('refuses to end an alarm with %s', async (_label, payload) => {
      await send('post', `/api/v1/crisis/alarms/${ALARM}/end`, admin(), payload).expect(400);
    });

    it.each([
      ['no marks', { marks: [] }],
      ['more than 400', { marks: Array.from({ length: 401 }, () => mark()) }],
      ['a mark with no id', { marks: [mark({ id: undefined })] }],
      ['a mark that names a group twice over', { marks: [mark({ lessonId: LESSON })] }],
      ['a state that is not one', { marks: [mark({ state: 'ABSENT' })] }],
      ['a time that is no time', { marks: [mark({ at: 'nu' })] }],
      ['a pupil that is not an id', { marks: [mark({ studentId: 'anna' })] }],
      // No free text: a mark names a pupil and a state and nothing a person types.
      ['a note', { marks: [mark({ note: 'Hittad vid gymnastiksalen' })] }],
      ['a mark from someone else', { marks: [mark({ byUserId: OTHER_ID })] }],
    ])('refuses a teacher\'s %s', async (_label, payload) => {
      await send('post', '/api/v1/crisis/mine/marks', teacher(), payload).expect(400);
      expect(harness.tx.crisisReport.createMany).not.toHaveBeenCalled();
    });

    it('takes a mark by lesson too, for a phone that built its list from its own schedule', async () => {
      harness.tx.crisisCall.findMany.mockResolvedValue([]);
      const response = await send('post', '/api/v1/crisis/mine/marks', teacher(), { marks: [mark({ callId: undefined, lessonId: LESSON })] }).expect(200);
      expect(response.body).toEqual({ stored: 0, duplicates: 0, unresolved: [MARK] });
    });

    it('refuses an id that is not one on the routes that take one', async () => {
      await send('get', '/api/v1/crisis/alarms/not-an-id', admin()).expect(400);
      await send('get', '/api/v1/crisis/alarms/not-an-id/protocol', admin()).expect(400);
      await send('post', '/api/v1/crisis/alarms/not-an-id/end', admin(), {}).expect(400);
      await send('post', '/api/v1/crisis/alarms/not-an-id/marks', admin(), { marks: [mark()] }).expect(400);
    });
  });

  describe('what the routes answer', () => {
    it('starts nothing for an administrator the school did not let start an alarm, with its code', async () => {
      harness.tx.$queryRaw.mockResolvedValue([{ allowed: false }]);
      const response = await send('post', '/api/v1/crisis/alarms', planner(), { kind: 'EVACUATION', mode: 'LIVE' }).expect(403);
      expect(codeOf(response)).toBe('CRISIS_NOT_YOURS');
      expect(harness.tx.crisisAlarm.create).not.toHaveBeenCalled();
    });

    it('is a 409 with a code for a second alarm of one kind', async () => {
      harness.tx.$queryRaw.mockResolvedValue([{ allowed: true }]);
      harness.tx.crisisAlarm.findFirst.mockResolvedValue({ id: ALARM });
      const response = await send('post', '/api/v1/crisis/alarms', admin(), { kind: 'EVACUATION', mode: 'DRILL' }).expect(409);
      expect(codeOf(response)).toBe('CRISIS_ALARM_OPEN');
      expect((response.body as { params?: { alarmId?: string } }).params?.alarmId).toBe(ALARM);
    });

    it('says a teacher has no alarm when none is going, with the moment it asked', async () => {
      harness.tx.crisisAlarm.findMany.mockResolvedValue([]);
      const response = await send('get', '/api/v1/crisis/mine', teacher()).expect(200);
      expect(response.body.alarms).toEqual([]);
      expect(new Date(response.body.asOf).getTime()).toBeGreaterThan(0);
    });

    it('is a 404 with a code for an alarm that is not the school\'s', async () => {
      harness.tx.crisisAlarm.findFirst.mockResolvedValue(null);
      const response = await send('get', `/api/v1/crisis/alarms/${ALARM}`, admin()).expect(404);
      expect(codeOf(response)).toBe('CRISIS_ALARM_NOT_FOUND');
    });

    it('lists the school\'s alarms newest first, an exercise apart from a real one when asked', async () => {
      harness.tx.crisisAlarm.findMany.mockResolvedValue([]);
      await send('get', '/api/v1/crisis/alarms?mode=DRILL&limit=5', admin()).expect(200);
      expect(harness.tx.crisisAlarm.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ mode: 'DRILL' }), take: 5, orderBy: [{ startedAt: 'desc' }, { id: 'desc' }] }),
      );
      await send('get', '/api/v1/crisis/alarms?mode=TEST', admin()).expect(400);
      await send('get', '/api/v1/crisis/alarms?limit=101', admin()).expect(400);
    });
  });
});
