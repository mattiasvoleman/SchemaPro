import request from 'supertest';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

const ADMIN_PROFILES = ['FULL', 'REKTOR', 'SCHEMALAGGARE', 'EXPEDITION', 'LASARE'];
const WRITING_PROFILES = ['FULL', 'REKTOR', 'SCHEMALAGGARE', 'EXPEDITION'];

const day = (value: string) => new Date(`${value}T00:00:00.000Z`);
const statement = (call: unknown[]) => call[0] as { strings: string[]; values: unknown[] };

/**
 * Rapporteringsgrad's routes: who may reach them and what a request must be.
 * The mocks stand in for the database, so these hold the role and area gates,
 * the validation and the read log, and say nothing of row security; the RLS
 * sections and the adapter probe say who reads which day.
 */
describe('/api/v1/reporting-rate (e2e)', () => {
  let harness: TestHarness;
  const http = () => request(harness.app.getHttpServer());

  beforeAll(async () => {
    harness = await createTestApp();
  });
  afterAll(async () => {
    await harness.close();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    harness.tx['teacherReportingDay']!['groupBy']!.mockResolvedValue([]);
    harness.tx['teacherReportingDay']!['aggregate']!.mockResolvedValue({
      _sum: { held: 10, reported: 8 },
      _max: { day: day('2026-10-20') },
    });
    harness.tx['reportingSetting']!['findUnique']!.mockResolvedValue(null);
    harness.tx['reportingSetting']!['upsert']!.mockResolvedValue({});
    harness.tx['academicYear']!['findFirst']!.mockResolvedValue({
      name: '2026/2027',
      startDate: day('2026-08-17'),
      endDate: day('2027-06-11'),
    });
    harness.tx['user']!['findMany']!.mockResolvedValue([]);
    harness.tx.$queryRaw.mockImplementation(async (query: { strings?: string[] }) => {
      const text = (query.strings ?? []).join('?');
      if (text.includes('app.school_today()')) return [{ today: '2026-10-21' }];
      if (text.includes('app.reporting_open_lessons(')) {
        return [
          {
            lesson_id: '55555555-5555-4555-8555-555555555555',
            day: '2026-10-16',
            starts_at: new Date('2026-10-16T06:15:00Z'),
            ends_at: new Date('2026-10-16T07:00:00Z'),
            subject_name: 'Matematik',
            group_name: '7A',
            overdue: true,
          },
        ];
      }
      return [];
    });
  });

  describe('the school’s figures and the switches are the administrators', () => {
    it.each(['TEACHER', 'STUDENT', 'GUARDIAN'])('refuses %s the school’s view and the settings, read and written', async (role) => {
      const as = asUser({ role: role as never });
      await http().get('/api/v1/reporting-rate').set('x-test-user', as).expect(403);
      await http().get('/api/v1/reporting-rate/settings').set('x-test-user', as).expect(403);
      await http().put('/api/v1/reporting-rate/settings').set('x-test-user', as).send({ teacherReminders: true }).expect(403);
      expect(harness.tx['teacherReportingDay']!['groupBy']).not.toHaveBeenCalled();
      expect(harness.tx['reportingSetting']!['upsert']).not.toHaveBeenCalled();
      expect(harness.tx.$executeRaw).not.toHaveBeenCalled();
    });

    it.each(['STUDENT', 'GUARDIAN', 'SCHOOL_ADMIN'])('refuses %s a teacher’s own page', async (role) => {
      await http().get('/api/v1/reporting-rate/mine').set('x-test-user', asUser({ role: role as never })).expect(403);
      expect(harness.tx['teacherReportingDay']!['aggregate']).not.toHaveBeenCalled();
    });

    it('refuses nobody-in-particular without a token', async () => {
      await http().get('/api/v1/reporting-rate').expect(401);
      await http().get('/api/v1/reporting-rate/settings').expect(401);
      await http().put('/api/v1/reporting-rate/settings').send({}).expect(401);
      await http().get('/api/v1/reporting-rate/mine').expect(401);
    });

    it('lets every profile read the figures and the settings, and the Drift profiles write them; the läsare does not', async () => {
      for (const adminProfile of ADMIN_PROFILES) {
        const as = asUser({ adminProfile: adminProfile as never });
        const figures = await http().get('/api/v1/reporting-rate').set('x-test-user', as).expect(200);
        expect(figures.body).toMatchObject({ period: 'WEEK', total: { held: 0, reported: 0 }, teachers: [] });
        const settings = await http().get('/api/v1/reporting-rate/settings').set('x-test-user', as).expect(200);
        expect(settings.body).toEqual({ teacherReminders: false, rektorDigest: false, openAfterDays: 2 });
      }
      for (const adminProfile of WRITING_PROFILES) {
        await http()
          .put('/api/v1/reporting-rate/settings')
          .set('x-test-user', asUser({ adminProfile: adminProfile as never }))
          .send({ teacherReminders: true })
          .expect(200);
      }
      const lasare = asUser({ adminProfile: 'LASARE' as never });
      const refused = await http().put('/api/v1/reporting-rate/settings').set('x-test-user', lasare).send({ teacherReminders: true }).expect(403);
      expect(refused.body.code).toBe('AREA_NOT_YOURS');
      expect(refused.body.detail).toContain('Drift');
      expect(harness.tx['reportingSetting']!['upsert']).toHaveBeenCalledTimes(WRITING_PROFILES.length);
    });
  });

  describe('the school’s view', () => {
    const admin = asUser({});

    it('answers the contract’s shape: the period, the figures and the teachers, the lowest share first', async () => {
      harness.tx['teacherReportingDay']!['groupBy']!.mockResolvedValue([
        { teacherId: 't1', _sum: { held: 40, reported: 38 } },
        { teacherId: 't2', _sum: { held: 30, reported: 12 } },
      ]);
      harness.tx['user']!['findMany']!.mockResolvedValue([
        { id: 't1', firstName: 'Anna', lastName: 'Ek' },
        { id: 't2', firstName: 'Britt', lastName: 'Lind' },
      ]);
      const response = await http().get('/api/v1/reporting-rate?period=MONTH&anchor=2026-10-21').set('x-test-user', admin).expect(200);
      expect(response.body).toEqual({
        period: 'MONTH',
        anchor: '2026-10-21',
        from: '2026-10-01',
        to: '2026-10-31',
        yearName: null,
        previousAnchor: '2026-09-30',
        nextAnchor: '2026-11-01',
        through: '2026-10-20',
        total: { held: 70, reported: 50 },
        teachers: [
          { teacherId: 't2', firstName: 'Britt', lastName: 'Lind', held: 30, reported: 12 },
          { teacherId: 't1', firstName: 'Anna', lastName: 'Ek', held: 40, reported: 38 },
        ],
      });
    });

    it('reads the school’s week on its own today without a period, and a läsår with one', async () => {
      const week = await http().get('/api/v1/reporting-rate').set('x-test-user', admin).expect(200);
      expect(week.body).toMatchObject({ period: 'WEEK', anchor: '2026-10-21', from: '2026-10-19', to: '2026-10-25' });
      const year = await http().get('/api/v1/reporting-rate?period=YEAR').set('x-test-user', admin).expect(200);
      expect(year.body).toMatchObject({ period: 'YEAR', from: '2026-08-17', to: '2027-06-11', yearName: '2026/2027' });
    });

    it('writes the read to the read log, as employment and as people, about the teachers it handed out', async () => {
      harness.tx['teacherReportingDay']!['groupBy']!.mockResolvedValue([
        { teacherId: 't1', _sum: { held: 40, reported: 38 } },
        { teacherId: 't2', _sum: { held: 30, reported: 12 } },
      ]);
      harness.tx['user']!['findMany']!.mockResolvedValue([
        { id: 't1', firstName: 'Anna', lastName: 'Ek' },
        { id: 't2', firstName: 'Britt', lastName: 'Lind' },
      ]);
      await http().get('/api/v1/reporting-rate').set('x-test-user', admin).expect(200);
      const reads = harness.tx.$executeRaw.mock.calls.map((call) => statement(call));
      expect(reads.map((read) => read.values[0])).toEqual(['EMPLOYMENT', 'PEOPLE']);
      expect(reads.every((read) => read.strings.join('').includes('app.personal_data_read'))).toBe(true);
      expect(reads.map((read) => read.values[2])).toEqual([['t1', 't2'], ['t1', 't2']]);
    });

    it.each(['2000-01-01', '2100-12-31'])('takes the edge of the years it reckons in, %s, for every period', async (anchor) => {
      for (const period of ['WEEK', 'MONTH', 'YEAR']) {
        await http().get(`/api/v1/reporting-rate?period=${period}&anchor=${anchor}`).set('x-test-user', admin).expect(200);
      }
    });

    it('writes nothing to the read log for a period nobody taught in', async () => {
      await http().get('/api/v1/reporting-rate?period=WEEK&anchor=2026-07-01').set('x-test-user', admin).expect(200);
      expect(harness.tx.$executeRaw).not.toHaveBeenCalled();
    });

    it.each([
      ['a period it does not know', 'period=DAY'],
      ['a period in lower case', 'period=week'],
      ['an anchor that is not a date', 'anchor=yesterday'],
      ['an anchor with a time', 'anchor=2026-10-21T10:00:00Z'],
      ['an anchor that does not exist', 'anchor=2026-02-30'],
      ['an anchor of the wrong shape', 'anchor=21-10-2026'],
      ['an anchor before the years it reckons in', 'anchor=1999-12-31'],
      ['an anchor after them', 'anchor=2101-01-01'],
      ['an anchor at the end of time, whose week runs into year 10000', 'anchor=9999-12-29'],
      ['a parameter it does not know', 'period=WEEK&teacherId=t1'],
    ])('refuses %s with a 400 before the database, naming the field', async (_label, query) => {
      const response = await http().get(`/api/v1/reporting-rate?${query}`).set('x-test-user', admin).expect(400);
      expect(harness.tx['teacherReportingDay']!['groupBy']).not.toHaveBeenCalled();
      expect(JSON.stringify(response.body.errors)).toMatch(/period|anchor|teacherId/);
    });
  });

  describe('the settings', () => {
    const admin = asUser({});

    it('save what the request names and answer what is stored', async () => {
      harness.tx['reportingSetting']!['findUnique']!.mockResolvedValue({ teacherReminders: true, rektorDigest: true, openAfterDays: 5 });
      const response = await http()
        .put('/api/v1/reporting-rate/settings')
        .set('x-test-user', admin)
        .send({ teacherReminders: true, rektorDigest: true, openAfterDays: 5 })
        .expect(200);
      expect(response.body).toEqual({ teacherReminders: true, rektorDigest: true, openAfterDays: 5 });
      expect(harness.tx['reportingSetting']!['upsert']).toHaveBeenCalledWith({
        where: { schoolId: '33333333-3333-4333-8333-333333333333' },
        create: { schoolId: '33333333-3333-4333-8333-333333333333', teacherReminders: true, rektorDigest: true, openAfterDays: 5 },
        update: { teacherReminders: true, rektorDigest: true, openAfterDays: 5 },
      });
    });

    it('take a save of one field and the limits 1 and 30, and write nothing for an empty save', async () => {
      for (const body of [{ rektorDigest: false }, { openAfterDays: 1 }, { openAfterDays: 30 }]) {
        await http().put('/api/v1/reporting-rate/settings').set('x-test-user', admin).send(body).expect(200);
      }
      expect(harness.tx['reportingSetting']!['upsert']).toHaveBeenCalledTimes(3);
      const empty = await http().put('/api/v1/reporting-rate/settings').set('x-test-user', admin).send({}).expect(200);
      expect(empty.body).toEqual({ teacherReminders: false, rektorDigest: false, openAfterDays: 2 });
      expect(harness.tx['reportingSetting']!['upsert']).toHaveBeenCalledTimes(3);
    });

    it.each([
      ['a limit of 0 days', { openAfterDays: 0 }],
      ['a limit of 31 days', { openAfterDays: 31 }],
      ['a negative limit', { openAfterDays: -2 }],
      ['half a day', { openAfterDays: 2.5 }],
      ['a limit written as text', { openAfterDays: '3' }],
      ['a limit that is a switch', { openAfterDays: true }],
    ])('refuse %s with a 400 that names openAfterDays', async (_label, body) => {
      const response = await http().put('/api/v1/reporting-rate/settings').set('x-test-user', admin).send(body).expect(400);
      expect(response.body.errors.body.join(' ')).toContain('openAfterDays');
      expect(harness.tx['reportingSetting']!['upsert']).not.toHaveBeenCalled();
    });

    it.each([
      ['a reminder switch that is not a boolean', { teacherReminders: 'yes' }, 'teacherReminders'],
      ['a digest switch that is a number', { rektorDigest: 1 }, 'rektorDigest'],
      ['a field it does not know', { openAfterDay: 3 }, 'openAfterDay'],
      ['a date the database stamps', { teacherRemindersOn: '2026-10-01' }, 'teacherRemindersOn'],
      ['a school', { schoolId: '44444444-4444-4444-8444-444444444444' }, 'schoolId'],
    ])('refuse %s with a 400', async (_label, body, field) => {
      const response = await http().put('/api/v1/reporting-rate/settings').set('x-test-user', admin).send(body).expect(400);
      expect(response.body.errors.body.join(' ')).toContain(field);
      expect(harness.tx['reportingSetting']!['upsert']).not.toHaveBeenCalled();
    });
  });

  describe('a teacher’s own page', () => {
    const teacher = asUser({ role: 'TEACHER' as never, userId: '66666666-6666-4666-8666-666666666666' });

    it('answers the contract’s shape and writes nothing to the read log', async () => {
      harness.tx['reportingSetting']!['findUnique']!.mockResolvedValue({ openAfterDays: 3 });
      const response = await http().get('/api/v1/reporting-rate/mine').set('x-test-user', teacher).expect(200);
      expect(response.body).toEqual({
        openAfterDays: 3,
        through: '2026-10-20',
        open: [
          {
            lessonId: '55555555-5555-4555-8555-555555555555',
            date: '2026-10-16',
            startsAt: '2026-10-16T06:15:00.000Z',
            endsAt: '2026-10-16T07:00:00.000Z',
            subjectName: 'Matematik',
            groupName: '7A',
            overdue: true,
          },
        ],
        week: { from: '2026-10-19', to: '2026-10-25', held: 10, reported: 8 },
        month: { from: '2026-10-01', to: '2026-10-31', held: 10, reported: 8 },
        year: { name: '2026/2027', from: '2026-08-17', to: '2027-06-11', held: 10, reported: 8 },
      });
      expect(harness.tx.$executeRaw).not.toHaveBeenCalled();
    });

    it('reads only the teacher’s own days', async () => {
      await http().get('/api/v1/reporting-rate/mine').set('x-test-user', teacher).expect(200);
      const wheres = harness.tx['teacherReportingDay']!['aggregate']!.mock.calls.map(([args]) => (args as { where: { teacherId: string } }).where);
      expect(wheres.length).toBeGreaterThan(0);
      expect(wheres.every((where) => where.teacherId === '66666666-6666-4666-8666-666666666666')).toBe(true);
      expect(harness.tx['teacherReportingDay']!['groupBy']).not.toHaveBeenCalled();
    });

    it('takes no query: a teacher cannot ask for another’s days', async () => {
      // The route reads no query at all; the validation pipe refuses nothing it never binds, so the
      // answer is the teacher's own whatever the address says, and the days read are the caller's.
      await http().get('/api/v1/reporting-rate/mine?teacherId=77777777-7777-4777-8777-777777777777').set('x-test-user', teacher).expect(200);
      const wheres = harness.tx['teacherReportingDay']!['aggregate']!.mock.calls.map(([args]) => (args as { where: { teacherId: string } }).where);
      expect(wheres.every((where) => where.teacherId === '66666666-6666-4666-8666-666666666666')).toBe(true);
    });
  });
});
