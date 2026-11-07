import request from 'supertest';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

const ADMIN_PROFILES = ['FULL', 'REKTOR', 'SCHEMALAGGARE', 'EXPEDITION', 'LASARE'];
const DECIDING = ['FULL', 'REKTOR'];
const NOT_DECIDING = ['SCHEMALAGGARE', 'EXPEDITION', 'LASARE'];

/**
 * Skolans dag's routes: who may reach them and what a request must be. The
 * mocks stand in for the database, so these hold the role and area gates, the
 * validation and the shape of the answer, and say nothing of row security; the
 * RLS sections 365–367 and the adapter probe say who reads which row.
 */
describe('/api/v1/school-day (e2e)', () => {
  let harness: TestHarness;
  const http = () => request(harness.app.getHttpServer());
  const get = (path: string, as: string) => http().get(`/api/v1/school-day${path}`).set('x-test-user', as);

  const setView = (view: string | null) =>
    harness.tx['schoolDaySettings']!['findUnique']!.mockResolvedValue(view === null ? null : { teacherView: view });

  beforeAll(async () => {
    harness = await createTestApp();
  });
  afterAll(async () => {
    await harness.close();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    setView(null);
    harness.tx['schoolDaySettings']!['upsert']!.mockResolvedValue({});
    harness.tx['school']!['findUnique']!.mockResolvedValue({ timezone: 'Europe/Stockholm' });
    harness.tx['room']!['findMany']!.mockResolvedValue([{ id: 'r1', name: 'Sal 1', code: null }]);
    harness.tx.$queryRaw.mockResolvedValue([]);
  });

  describe('who reaches what', () => {
    it.each(['STUDENT', 'GUARDIAN'])('gives %s nothing: no grid, no search, no settings, read or written', async (role) => {
      const as = asUser({ role: role as never });
      await get('?from=2027-03-29', as).expect(403);
      await get('/free?date=2027-03-29&from=10:00&to=11:00', as).expect(403);
      await get('/settings', as).expect(403);
      await http().put('/api/v1/school-day/settings').set('x-test-user', as).send({ teacherView: 'ALL' }).expect(403);
      expect(harness.tx['calendarLesson']!['findMany']).not.toHaveBeenCalled();
      expect(harness.tx['schoolDaySettings']!['upsert']).not.toHaveBeenCalled();
    });

    it('refuses nobody-in-particular without a token', async () => {
      await http().get('/api/v1/school-day?from=2027-03-29').expect(401);
      await http().get('/api/v1/school-day/free?date=2027-03-29&from=10:00&to=11:00').expect(401);
      await http().get('/api/v1/school-day/settings').expect(401);
      await http().put('/api/v1/school-day/settings').send({ teacherView: 'ALL' }).expect(401);
    });

    it('lets every administrator profile read the grid, the search and the decision, the läsare too', async () => {
      for (const adminProfile of ADMIN_PROFILES) {
        const as = asUser({ adminProfile: adminProfile as never });
        const grid = await get('?from=2027-03-29', as).expect(200);
        expect(grid.body).toMatchObject({ from: '2027-03-29', to: '2027-03-29', access: { admin: true, grids: true, freeTeachers: true } });
        const free = await get('/free?date=2027-03-29&from=10:00&to=11:00', as).expect(200);
        expect(free.body).toMatchObject({ date: '2027-03-29', from: '10:00', to: '11:00', rooms: [{ id: 'r1', name: 'Sal 1', code: null }] });
        await get('/settings', as).expect(200, { teacherView: 'NONE' });
      }
    });

    it('lets those who decide write the teachers’ share, and nobody else: not the planner, the expedition or the läsare', async () => {
      for (const adminProfile of DECIDING) {
        await http()
          .put('/api/v1/school-day/settings')
          .set('x-test-user', asUser({ adminProfile: adminProfile as never }))
          .send({ teacherView: 'ROOMS' })
          .expect(200);
      }
      for (const adminProfile of NOT_DECIDING) {
        const refused = await http()
          .put('/api/v1/school-day/settings')
          .set('x-test-user', asUser({ adminProfile: adminProfile as never }))
          .send({ teacherView: 'ROOMS' })
          .expect(403);
        expect(refused.body.code).toBe('DECISION_NOT_YOURS');
      }
      expect(harness.tx['schoolDaySettings']!['upsert']).toHaveBeenCalledTimes(DECIDING.length);
    });

    it('lets a teacher write nothing', async () => {
      await http().put('/api/v1/school-day/settings').set('x-test-user', asUser({ role: 'TEACHER' as never })).send({ teacherView: 'ALL' }).expect(403);
      expect(harness.tx['schoolDaySettings']!['upsert']).not.toHaveBeenCalled();
    });
  });

  describe('what a teacher has', () => {
    const teacher = asUser({ role: 'TEACHER' as never });

    it('reads the decision, to know whether to show the page', async () => {
      await get('/settings', teacher).expect(200, { teacherView: 'NONE' });
      setView('ROOMS');
      await get('/settings', teacher).expect(200, { teacherView: 'ROOMS' });
    });

    it('is refused with SCHOOL_DAY_NOT_OPEN while the school has not decided', async () => {
      const grid = await get('?from=2027-03-29', teacher).expect(403);
      expect(grid.body.code).toBe('SCHOOL_DAY_NOT_OPEN');
      const free = await get('/free?date=2027-03-29&from=10:00&to=11:00', teacher).expect(403);
      expect(free.body.code).toBe('SCHOOL_DAY_NOT_OPEN');
      expect(harness.tx['calendarLesson']!['findMany']).not.toHaveBeenCalled();
    });

    it('gets the rooms with ROOMS, and no teachers in the search', async () => {
      setView('ROOMS');
      const grid = await get('?from=2027-03-29', teacher).expect(200);
      expect(grid.body.access).toEqual({ admin: false, grids: false, freeTeachers: false });
      const free = await get('/free?date=2027-03-29&from=10:00&to=11:00', teacher).expect(200);
      expect(free.body).toMatchObject({ teachers: null, busyTeachers: null, busyRooms: null });
    });

    it('gets the classes and the teachers with ALL, and asks for the marked staff to leave out', async () => {
      setView('ALL');
      harness.tx.$queryRaw.mockResolvedValue([{ id: '99999999-9999-4999-8999-999999999999' }]);
      const grid = await get('?from=2027-03-29', teacher).expect(200);
      expect(grid.body.access).toEqual({ admin: false, grids: true, freeTeachers: false });
      expect(harness.tx.$queryRaw).toHaveBeenCalled();
    });
  });

  describe('what a request must be', () => {
    const admin = asUser({});

    it.each([
      ['no from', ''],
      ['a date that does not exist', '?from=2027-02-30'],
      ['a text', '?from=igår'],
      ['a year out of range', '?from=1999-03-29'],
      ['a to that does not exist', '?from=2027-03-29&to=2027-04-31'],
    ])('answers 400 for %s', async (_label, query) => {
      await get(query, admin).expect(400);
    });

    it('answers 400 for a range backwards or longer than a week, and names the field', async () => {
      const backwards = await get('?from=2027-03-29&to=2027-03-28', admin).expect(400);
      expect(JSON.stringify(backwards.body)).toContain('to:');
      const long = await get('?from=2027-03-22&to=2027-03-29', admin).expect(400);
      expect(JSON.stringify(long.body)).toContain('högst 7 dagar');
      await get('?from=2027-03-22&to=2027-03-28', admin).expect(200);
    });

    it.each([
      ['a time that does not exist', '?date=2027-03-29&from=25:00&to=26:00'],
      ['no interval', '?date=2027-03-29'],
      ['a date that does not exist', '?date=2027-02-30&from=10:00&to=11:00'],
      ['an interval that ends first', '?date=2027-03-29&from=11:00&to=10:00'],
    ])('answers 400 for the search with %s', async (_label, query) => {
      await get(`/free${query}`, admin).expect(400);
    });

    it('refuses a form that does not exist', async () => {
      const refused = await http().put('/api/v1/school-day/settings').set('x-test-user', admin).send({ teacherView: 'DETTA' }).expect(400);
      expect(JSON.stringify(refused.body)).toContain('teacherView');
      await http().put('/api/v1/school-day/settings').set('x-test-user', admin).send({}).expect(400);
    });
  });
});
