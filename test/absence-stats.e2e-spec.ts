import { Prisma } from '@prisma/client';
import request from 'supertest';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

const ADMIN_PROFILES = ['FULL', 'REKTOR', 'SCHEMALAGGARE', 'EXPEDITION', 'LASARE'];
const CLASS = '44444444-4444-4444-8444-444444444444';
const PUPIL = '55555555-5555-4555-8555-555555555555';

const statement = (call: unknown[]) => call[0] as { strings: string[]; values: unknown[] };
const text = (call: unknown[]) => statement(call).strings.join('?');

/** What the driver adapter hands over for a raw call the database refused: the SQLSTATE under meta.driverAdapterError.cause. */
const refusal = (originalCode: string, originalMessage: string) =>
  new Prisma.PrismaClientKnownRequestError('Raw query failed.', {
    code: 'P2010',
    clientVersion: Prisma.prismaVersion.client,
    meta: { driverAdapterError: { cause: { originalCode, originalMessage } } },
  });

const WINDOW = { first_month: '2024-08-01', today: '2026-11-07', year_name: '2026/27', year_start: '2026-08-01', year_end: '2027-07-31' };

/**
 * Frånvarostatistik's routes: who may reach them, what a request must be and
 * what the gateway records. The mocks stand in for the database, so these hold
 * the role gates, the validation, the huvudman's reader and the read log, and
 * say nothing of which rows a mentor reads; the RLS sections (390-394) and the
 * adapter probe say that.
 */
describe('/api/v1/absence-stats (e2e)', () => {
  let harness: TestHarness;
  const http = () => request(harness.app.getHttpServer());
  const reader = () =>
    asUser({ userId: undefined, adminProfile: 'LASARE' as never, huvudman: { id: 'h1', name: 'Kommunen', memberId: 'm1', role: 'PLANERARE' } as never });

  beforeAll(async () => {
    harness = await createTestApp();
  });
  afterAll(async () => {
    await harness.close();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    harness.tx.$queryRaw.mockImplementation(async (query: { strings?: string[] }) => {
      const sql = (query.strings ?? []).join('?');
      if (sql.includes('app.absence_stats_window(')) return [WINDOW];
      if (sql.includes('app.absence_stats_pupil_head(')) {
        return [{ student_id: PUPIL, first_name: 'Elev', last_name: 'Ett', class_id: CLASS, class_name: '8A', first_day: '2024-09-02', last_day: '2026-11-06', is_protected: false }];
      }
      if (sql.includes('app.absence_stats_class_pupils(')) {
        return [{ student_id: PUPIL, first_name: 'Elev', last_name: 'Ett', is_protected: false, recorded_minutes: 100, valid_minutes: 0, absent_minutes: 10, late_minutes: 0, late_count: 0 }];
      }
      return [];
    });
  });

  describe('who may reach it', () => {
    it.each(['STUDENT', 'GUARDIAN'])('refuses %s every route', async (role) => {
      const as = asUser({ role: role as never });
      for (const path of [
        '/api/v1/absence-stats/window',
        '/api/v1/absence-stats/school',
        '/api/v1/absence-stats/classes',
        `/api/v1/absence-stats/classes/${CLASS}`,
        `/api/v1/absence-stats/classes/${CLASS}/pupils`,
        `/api/v1/absence-stats/pupils/${PUPIL}`,
      ]) {
        await http().get(path).set('x-test-user', as).expect(403);
      }
      expect(harness.tx.$queryRaw).not.toHaveBeenCalled();
      expect(harness.tx.$executeRaw).not.toHaveBeenCalled();
    });

    it('refuses nobody-in-particular without a token', async () => {
      await http().get('/api/v1/absence-stats/window').expect(401);
      await http().get('/api/v1/absence-stats/school').expect(401);
      await http().get(`/api/v1/absence-stats/pupils/${PUPIL}`).expect(401);
    });

    it('lets an administrator of every profile and a teacher through the guards: which rows is the database’s question', async () => {
      for (const adminProfile of ADMIN_PROFILES) {
        await http().get('/api/v1/absence-stats/window').set('x-test-user', asUser({ adminProfile: adminProfile as never })).expect(200);
      }
      const teacher = asUser({ role: 'TEACHER' as never, userId: '66666666-6666-4666-8666-666666666666' });
      await http().get('/api/v1/absence-stats/window').set('x-test-user', teacher).expect(200);
      await http().get('/api/v1/absence-stats/classes').set('x-test-user', teacher).expect(200);
      await http().get(`/api/v1/absence-stats/classes/${CLASS}`).set('x-test-user', teacher).expect(200);
    });

    it('turns the database’s refusal of a teacher into a 403 that says why', async () => {
      harness.tx.$queryRaw.mockImplementation(async (query: { strings?: string[] }) => {
        if ((query.strings ?? []).join('?').includes('app.absence_stats_window(')) return [WINDOW];
        throw refusal('AS403', 'ABSENCE_STATS_NOT_YOURS');
      });
      const response = await http().get(`/api/v1/absence-stats/pupils/${PUPIL}`).set('x-test-user', asUser({ role: 'TEACHER' as never })).expect(403);
      expect(response.body.code).toBe('ABSENCE_STATS_NOT_YOURS');
      expect(response.body.detail).toMatch(/mentorns för sina egna elever/);
    });

    it('turns a read the database gave up on into a 503 with a code the web can say calmly, not a 500 without one', async () => {
      harness.tx.$queryRaw.mockImplementation(async (query: { strings?: string[] }) => {
        if ((query.strings ?? []).join('?').includes('app.absence_stats_window(')) return [WINDOW];
        throw refusal('57014', 'canceling statement due to statement timeout');
      });
      const response = await http().get(`/api/v1/absence-stats/classes/${CLASS}/pupils`).set('x-test-user', asUser({ role: 'SCHOOL_ADMIN' as never })).expect(503);
      expect(response.body.code).toBe('ABSENCE_STATS_TOO_SLOW');
      expect(response.body.detail).toMatch(/Försök igen/);
    });
  });

  describe('the huvudman’s reader', () => {
    it('reads the school’s and the classes’ sums', async () => {
      await http().get('/api/v1/absence-stats/school').set('x-test-user', reader()).expect(200);
      await http().get('/api/v1/absence-stats/classes').set('x-test-user', reader()).expect(200);
      await http().get(`/api/v1/absence-stats/classes/${CLASS}`).set('x-test-user', reader()).expect(200);
    });

    it('is refused a class’s pupils and a pupil before the database is asked, with the code the web reads', async () => {
      const list = await http().get(`/api/v1/absence-stats/classes/${CLASS}/pupils`).set('x-test-user', reader()).expect(403);
      expect(list.body.code).toBe('ABSENCE_STATS_NO_PUPILS_FOR_THE_READER');
      const one = await http().get(`/api/v1/absence-stats/pupils/${PUPIL}`).set('x-test-user', reader()).expect(403);
      expect(one.body.code).toBe('ABSENCE_STATS_NO_PUPILS_FOR_THE_READER');
      expect(harness.tx.$queryRaw).not.toHaveBeenCalled();
      expect(harness.tx.$executeRaw).not.toHaveBeenCalled();
    });
  });

  describe('what a request must be', () => {
    const admin = asUser({});

    it('wants uuids for a class and a pupil', async () => {
      await http().get('/api/v1/absence-stats/classes/not-a-uuid').set('x-test-user', admin).expect(400);
      await http().get('/api/v1/absence-stats/classes/not-a-uuid/pupils').set('x-test-user', admin).expect(400);
      await http().get('/api/v1/absence-stats/pupils/not-a-uuid').set('x-test-user', admin).expect(400);
    });

    it.each(['2026-02-30', '1999-12-31', 'yesterday', '2026-1-1', '2101-01-01'])('refuses %s as a date, naming the field', async (value) => {
      const response = await http().get(`/api/v1/absence-stats/classes?from=${value}`).set('x-test-user', admin).expect(400);
      expect(JSON.stringify(response.body)).toContain('from');
      const to = await http().get(`/api/v1/absence-stats/classes/${CLASS}?to=${value}`).set('x-test-user', admin).expect(400);
      expect(JSON.stringify(to.body)).toContain('to');
    });

    it('takes a period of two dates that exist, and asks the database for exactly them', async () => {
      await http().get('/api/v1/absence-stats/classes?from=2025-08-18&to=2025-12-19').set('x-test-user', admin).expect(200);
      const call = harness.tx.$queryRaw.mock.calls.find((c) => text(c).includes('app.absence_stats_classes('));
      expect(statement(call as unknown[]).values).toEqual(['2025-08-18', '2025-12-19']);
    });

    it('does not take a school id from the request: the school is the caller’s, and no statement carries another', async () => {
      await http().get('/api/v1/absence-stats/school?schoolId=99999999-9999-4999-8999-999999999999').set('x-test-user', admin).expect(200);
      const carried = harness.tx.$queryRaw.mock.calls.flatMap((call) => statement(call).values);
      expect(carried).not.toContain('99999999-9999-4999-8999-999999999999');
    });
  });

  describe('what is recorded in the read log', () => {
    const admin = asUser({});

    it('names the pupils of a class list, as ATTENDANCE and PEOPLE, and nothing for sums', async () => {
      await http().get(`/api/v1/absence-stats/classes/${CLASS}/pupils`).set('x-test-user', admin).expect(200);
      const kinds = harness.tx.$executeRaw.mock.calls.map((call) => statement(call).values[0]);
      expect(kinds).toEqual(['ATTENDANCE', 'PEOPLE']);
      harness.tx.$executeRaw.mockClear();
      await http().get('/api/v1/absence-stats/school').set('x-test-user', admin).expect(200);
      await http().get('/api/v1/absence-stats/classes').set('x-test-user', admin).expect(200);
      await http().get(`/api/v1/absence-stats/classes/${CLASS}`).set('x-test-user', admin).expect(200);
      expect(harness.tx.$executeRaw).not.toHaveBeenCalled();
    });

    it('names the pupil of a card, as ATTENDANCE and PEOPLE', async () => {
      const response = await http().get(`/api/v1/absence-stats/pupils/${PUPIL}`).set('x-test-user', admin).expect(200);
      expect(response.body.student).toMatchObject({ id: PUPIL, firstName: 'Elev', className: '8A', isProtected: false });
      const reads = harness.tx.$executeRaw.mock.calls.map((call) => ({ kind: statement(call).values[0], ids: statement(call).values[2] }));
      expect(reads).toEqual([
        { kind: 'ATTENDANCE', ids: [PUPIL] },
        { kind: 'PEOPLE', ids: [PUPIL] },
      ]);
    });
  });
});
