import request from 'supertest';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

const TODAY = '2027-02-04';
type Statement = { strings: string[]; values: unknown[] };
const sql = (statement: unknown) => (statement as Statement).strings.join('?');
const time = (value: string) => new Date(`1970-01-01T${value}:00.000Z`);

const doc = {
  cutoff: '08:30',
  staffModelled: true,
  classes: [
    { day: '2027-02-04', groupId: 'g1', name: '7A', start: '10:30', end: '11:00', pupils: 24, absentBefore: 1, absentAfter: 0, underActivity: false },
    { day: '2027-02-04', groupId: 'g2', name: 'Åk 7ö', start: '10:30', end: '11:00', pupils: 25, absentBefore: 0, absentAfter: 2, underActivity: true },
  ],
  staff: [{ day: '2027-02-04', start: '10:30', end: '11:00', staff: 2 }],
};

/**
 * Måltidskollen's routes: who may reach them and what a request must be. The mocks stand in for the database,
 * so these hold the role and area gates, the validation and the file, and say nothing of the counts themselves:
 * the RLS sections 400-404 and the adapter probe run app.meal_counts against a real database.
 */
describe('/api/v1/meal-counts (e2e)', () => {
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
    harness.tx.$queryRaw = jest.fn(async (statement: unknown) => {
      const text = sql(statement);
      if (text.includes('app.school_today()')) return [{ today: new Date(`${TODAY}T00:00:00Z`) }];
      if (text.includes('app.meal_counts_for_me(')) return [{ doc }];
      if (text.includes('app.meal_letter_last_for_me()')) return [{ day: null }];
      return [];
    });
    harness.tx['kitchenSetting']!['findUnique']!.mockResolvedValue(null);
  });

  describe('who', () => {
    it.each(['TEACHER', 'STUDENT', 'GUARDIAN'])('refuses %s every route', async (role) => {
      const as = asUser({ role: role as never });
      await http().get('/api/v1/meal-counts').set('x-test-user', as).expect(403);
      await http().get('/api/v1/meal-counts/csv').set('x-test-user', as).expect(403);
      await http().get('/api/v1/meal-counts/settings').set('x-test-user', as).expect(403);
      await http().put('/api/v1/meal-counts/settings').set('x-test-user', as).send({ cutoffTime: '08:30' }).expect(403);
      expect(harness.tx['kitchenSetting']!['upsert']).not.toHaveBeenCalled();
    });

    it('refuses nobody-in-particular without a token', async () => {
      await http().get('/api/v1/meal-counts').expect(401);
      await http().get('/api/v1/meal-counts/csv').expect(401);
      await http().put('/api/v1/meal-counts/settings').send({}).expect(401);
    });

    it('lets every profile read the counts and the settings, and the Drift profiles write them; the läsare does not', async () => {
      for (const adminProfile of ['FULL', 'REKTOR', 'SCHEMALAGGARE', 'EXPEDITION', 'LASARE']) {
        const as = asUser({ adminProfile: adminProfile as never });
        const read = await http().get(`/api/v1/meal-counts?from=${TODAY}`).set('x-test-user', as).expect(200);
        expect(read.body.days[0].totals.portions).toBe(50);
        await http().get('/api/v1/meal-counts/csv').set('x-test-user', as).expect(200);
        await http().get('/api/v1/meal-counts/settings').set('x-test-user', as).expect(200);
      }
      for (const adminProfile of ['FULL', 'REKTOR', 'SCHEMALAGGARE', 'EXPEDITION']) {
        await http().put('/api/v1/meal-counts/settings').set('x-test-user', asUser({ adminProfile: adminProfile as never })).send({ cutoffTime: '08:30' }).expect(200);
      }
      const refused = await http().put('/api/v1/meal-counts/settings').set('x-test-user', asUser({ adminProfile: 'LASARE' as never })).send({ cutoffTime: '08:30' }).expect(403);
      expect(refused.body.code).toBe('AREA_NOT_YOURS');
      expect(refused.body.detail).toContain('Drift');
    });
  });

  describe('the counts', () => {
    const admin = asUser({});

    it('answers the days from today with their sittings, classes and totals', async () => {
      const response = await http().get(`/api/v1/meal-counts?from=${TODAY}&to=2027-02-05`).set('x-test-user', admin).expect(200);
      expect(response.body).toMatchObject({ from: TODAY, to: '2027-02-05', cutoff: '08:30', staffModelled: true });
      expect(response.body.days).toHaveLength(2);
      expect(response.body.days[0]).toMatchObject({
        date: TODAY,
        weekday: 4,
        totals: { pupils: 49, absentBefore: 1, staff: 2, portions: 50, absentAfter: 2, underActivity: 25 },
      });
      expect(response.body.days[0].sittings[0].classes.map((c: { name: string }) => c.name)).toEqual(['7A', 'Åk 7ö']);
      expect(response.body.days[1].sittings).toEqual([]);
    });

    it('answers the week ahead for days=7, from today, and refuses days it cannot count', async () => {
      const week = await http().get('/api/v1/meal-counts?days=7').set('x-test-user', admin).expect(200);
      expect([week.body.from, week.body.to, week.body.days.length]).toEqual([TODAY, '2027-02-10', 7]);
      await http().get('/api/v1/meal-counts/csv?days=7').set('x-test-user', admin).expect(200);
      for (const bad of ['days=0', 'days=15', 'days=1.5', 'days=week', `days=2&to=${TODAY}`]) {
        await http().get(`/api/v1/meal-counts?${bad}`).set('x-test-user', admin).expect(400);
      }
    });

    it('is today, for one day, without a period', async () => {
      const response = await http().get('/api/v1/meal-counts').set('x-test-user', admin).expect(200);
      expect(response.body).toMatchObject({ from: TODAY, to: TODAY });
    });

    it('carries no pupil: the answer is numbers and the names of classes', async () => {
      const response = await http().get(`/api/v1/meal-counts?from=${TODAY}`).set('x-test-user', admin).expect(200);
      expect(Object.keys(response.body).sort()).toEqual(['cutoff', 'days', 'from', 'staffModelled', 'to']);
      expect(JSON.stringify(response.body)).not.toMatch(/studentId|email|firstName|lastName/);
    });

    it.each([
      ['a date that does not exist', 'from=2027-02-30'],
      ['a date in the wrong form', 'from=4-2-2027'],
      ['a year out of range', 'from=1999-12-31'],
      ['an end that does not exist', `from=${TODAY}&to=2027-13-01`],
      ['text for a date', 'from=today'],
    ])('refuses %s with a 400 before the database', async (_label, query) => {
      await http().get(`/api/v1/meal-counts?${query}`).set('x-test-user', admin).expect(400);
      await http().get(`/api/v1/meal-counts/csv?${query}`).set('x-test-user', admin).expect(400);
      expect(harness.tx.$queryRaw).not.toHaveBeenCalled();
    });

    it('refuses a period of 15 days, one that ends first, and a day before today, each with its code', async () => {
      const long = await http().get(`/api/v1/meal-counts?from=${TODAY}&to=2027-02-18`).set('x-test-user', admin).expect(400);
      expect(long.body.code).toBe('MEAL_COUNTS_RANGE');
      const backwards = await http().get(`/api/v1/meal-counts?from=2027-02-05&to=${TODAY}`).set('x-test-user', admin).expect(400);
      expect(backwards.body.code).toBe('MEAL_COUNTS_RANGE');
      const past = await http().get('/api/v1/meal-counts?from=2027-02-03').set('x-test-user', admin).expect(400);
      expect(past.body.code).toBe('MEAL_COUNTS_PAST');
      await http().get(`/api/v1/meal-counts?from=${TODAY}&to=2027-02-17`).set('x-test-user', admin).expect(200);
    });
  });

  describe('the file', () => {
    it('is windows-1252 for Excel, named for the period, never cached', async () => {
      const response = await http()
        .get(`/api/v1/meal-counts/csv?from=${TODAY}&to=2027-02-05`)
        .set('x-test-user', asUser({}))
        .buffer(true)
        .parse((res, done) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => done(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(response.headers['content-type']).toBe('text/csv; charset=windows-1252');
      expect(response.headers['content-disposition']).toBe('attachment; filename="portioner-2027-02-04-2027-02-05.csv"');
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      const bytes = response.body as Buffer;
      expect(Number(response.headers['content-length'])).toBe(bytes.length);
      const lines = new TextDecoder('windows-1252').decode(bytes).split('\r\n');
      expect(lines[0]!.startsWith('Datum;Veckodag;Sittning från;')).toBe(true);
      expect(lines[1]).toBe('2027-02-04;torsdag;10:30;11:00;"7A 23, Åk 7ö 25";49;1;2;50;2;25');
      // "Åk" is the two bytes 0xC5 0x6B, not UTF-8's three.
      expect(bytes.includes(Buffer.from([0xc5, 0x6b, 0x20, 0x37, 0xf6]))).toBe(true);
    });
  });

  describe('the settings', () => {
    const admin = asUser({});

    it('says none for a school that has set nothing, and the last letter for one that has had one', async () => {
      const none = await http().get('/api/v1/meal-counts/settings').set('x-test-user', admin).expect(200);
      expect(none.body).toEqual({ cutoffTime: null, letterEnabled: false, kitchenEmail: null, lastLetterOn: null });
      harness.tx['kitchenSetting']!['findUnique']!.mockResolvedValue({ cutoffTime: time('08:30'), letterEnabled: true, kitchenEmail: 'kok@skolan.se' });
      harness.tx.$queryRaw = jest.fn(async () => [{ day: new Date('2027-02-03T00:00:00Z') }]);
      const had = await http().get('/api/v1/meal-counts/settings').set('x-test-user', admin).expect(200);
      expect(had.body).toEqual({ cutoffTime: '08:30', letterEnabled: true, kitchenEmail: 'kok@skolan.se', lastLetterOn: '2027-02-03' });
    });

    it('saves the cut-off, the address and the switch, and a blank address is none', async () => {
      await http().put('/api/v1/meal-counts/settings').set('x-test-user', admin).send({ cutoffTime: '08:30', kitchenEmail: '  kok@skolan.se ', letterEnabled: true }).expect(200);
      expect(harness.tx['kitchenSetting']!['upsert']).toHaveBeenLastCalledWith({
        where: { schoolId: '33333333-3333-4333-8333-333333333333' },
        create: { schoolId: '33333333-3333-4333-8333-333333333333', cutoffTime: time('08:30'), letterEnabled: true, kitchenEmail: 'kok@skolan.se' },
        update: { cutoffTime: time('08:30'), letterEnabled: true, kitchenEmail: 'kok@skolan.se' },
      });
      await http().put('/api/v1/meal-counts/settings').set('x-test-user', admin).send({ kitchenEmail: '', letterEnabled: false }).expect(200);
      expect(harness.tx['kitchenSetting']!['upsert']).toHaveBeenLastCalledWith(
        expect.objectContaining({ update: { cutoffTime: null, letterEnabled: false, kitchenEmail: null } }),
      );
    });

    it('refuses the letter on without an address or an hour, with its code', async () => {
      const refused = await http().put('/api/v1/meal-counts/settings').set('x-test-user', admin).send({ letterEnabled: true }).expect(400);
      expect(refused.body.code).toBe('MEAL_LETTER_NEEDS_ADDRESS_AND_HOUR');
      expect(harness.tx['kitchenSetting']!['upsert']).not.toHaveBeenCalled();
    });

    it.each([
      ['a cut-off of 24:00', { cutoffTime: '24:00' }],
      ['a cut-off of 29:59', { cutoffTime: '29:59' }],
      ['a cut-off of 8:30', { cutoffTime: '8:30' }],
      ['a cut-off with seconds', { cutoffTime: '08:30:00' }],
      ['two addresses with a comma', { kitchenEmail: 'a@skolan.se, b@skolan.se' }],
      ['two addresses with a semicolon', { kitchenEmail: 'a@skolan.se;b@skolan.se' }],
      ['an address with a name', { kitchenEmail: 'Köket <kok@skolan.se>' }],
      ['an address with no dot in the host', { kitchenEmail: 'kok@skolan' }],
      ['an address over 254 characters', { kitchenEmail: `${'a'.repeat(250)}@skolan.se` }],
      ['a switch that is not a boolean', { letterEnabled: 'ja' }],
      ['a field it does not know', { cutoffTime: '08:30', diet: 'vegetarisk' }],
    ])('refuses %s with a 400 before the database', async (_label, body) => {
      await http().put('/api/v1/meal-counts/settings').set('x-test-user', admin).send(body).expect(400);
      expect(harness.tx['kitchenSetting']!['upsert']).not.toHaveBeenCalled();
    });

    it('takes null for the cut-off, to clear it', async () => {
      await http().put('/api/v1/meal-counts/settings').set('x-test-user', admin).send({ cutoffTime: null }).expect(200);
      expect(harness.tx['kitchenSetting']!['upsert']).toHaveBeenCalledTimes(1);
    });
  });
});
