import request from 'supertest';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

const ADMIN_PROFILES = ['FULL', 'REKTOR', 'SCHEMALAGGARE', 'EXPEDITION', 'LASARE'];
const DECIDING = ['FULL', 'REKTOR'];
const NOT_DECIDING = ['SCHEMALAGGARE', 'EXPEDITION', 'LASARE'];
const YEAR = '99999999-9999-4999-8999-999999999999';
const PART = '44444444-4444-4444-8444-444444444444';

/**
 * Analys och planering's routes: who may reach them and what a request must
 * be. The mocks stand in for the database, so these hold the role and area
 * gates, the validation and the shape of the answer, and say nothing of row
 * security; the RLS sections 435–439 say who reads and writes which row.
 */
describe('/api/v1/analysis (e2e)', () => {
  let harness: TestHarness;
  const http = () => request(harness.app.getHttpServer());
  const get = (path: string, as: string) => http().get(`/api/v1/analysis${path}`).set('x-test-user', as);
  const send = (verb: 'post' | 'put' | 'patch' | 'delete', path: string, as: string, body?: object) => {
    const call = http()[verb](`/api/v1/analysis${path}`).set('x-test-user', as);
    return body === undefined ? call : call.send(body);
  };

  beforeAll(async () => {
    harness = await createTestApp();
  });
  afterAll(async () => {
    await harness.close();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    // An active year the reads can be made in; every other table an empty one.
    harness.tx['academicYear']!['findUnique']!.mockResolvedValue({
      startDate: new Date('2026-08-17T00:00:00.000Z'),
      endDate: new Date('2027-06-11T00:00:00.000Z'),
      isActive: true,
      predecessorId: null,
      gradeNumbering: 'NIOARIG',
      _count: { supervisionShifts: 0 },
      school: { timezone: 'Europe/Stockholm' },
    });
    harness.tx['schoolPart']!['create']!.mockResolvedValue({ id: PART, name: 'Lågstadiet', account: '4010', gradeFrom: 0, gradeTo: 3 });
    harness.tx['schoolPart']!['update']!.mockResolvedValue({ id: PART, name: 'Lågstadiet', account: '4011', gradeFrom: 0, gradeTo: 3 });
    harness.tx['schoolPart']!['findMany']!.mockResolvedValue([{ id: PART, name: 'Lågstadiet', account: '4010', gradeFrom: 0, gradeTo: 3 }]);
    harness.tx['schoolPart']!['deleteMany']!.mockResolvedValue({ count: 1 });
    harness.tx['staffCostRate']!['upsert']!.mockResolvedValue({ category: 'TEACHER', hourlyCost: '420.00' });
    harness.tx['staffCostRate']!['deleteMany']!.mockResolvedValue({ count: 1 });
    harness.tx.$queryRaw.mockResolvedValue([]);
  });

  describe('who reaches what', () => {
    it.each(['STUDENT', 'GUARDIAN', 'TEACHER'])('gives %s none of it: no view, no skoldel, no rate, no file', async (role) => {
      const as = asUser({ role: role as never });
      await get(`/key-figures?academicYearId=${YEAR}`, as).expect(403);
      await get(`/cost-basis?academicYearId=${YEAR}`, as).expect(403);
      await get(`/payroll-basis?academicYearId=${YEAR}&from=2026-11-01&to=2026-11-30`, as).expect(403);
      await send('post', '/payroll-basis/export', as, { academicYearId: YEAR, from: '2026-11-01', to: '2026-11-30', format: 'CSV' }).expect(403);
      await get('/school-parts', as).expect(403);
      await get('/cost-rates', as).expect(403);
      await send('post', '/school-parts', as, { name: 'x', account: '1', gradeFrom: 0, gradeTo: 3 }).expect(403);
      await send('put', '/cost-rates/TEACHER', as, { hourlyCost: 400 }).expect(403);
      expect(harness.tx['schoolPart']!['create']).not.toHaveBeenCalled();
      expect(harness.tx['staffCostRate']!['upsert']).not.toHaveBeenCalled();
    });

    it('refuses nobody-in-particular without a token', async () => {
      await http().get(`/api/v1/analysis/key-figures?academicYearId=${YEAR}`).expect(401);
      await http().get(`/api/v1/analysis/cost-basis?academicYearId=${YEAR}`).expect(401);
      await http().post('/api/v1/analysis/payroll-basis/export').send({}).expect(401);
      await http().get('/api/v1/analysis/school-parts').expect(401);
      await http().put('/api/v1/analysis/cost-rates/TEACHER').send({ hourlyCost: 1 }).expect(401);
    });

    it('lets every administrator profile read the key figures, the skoldelar and the rates, the läsare too', async () => {
      for (const adminProfile of ADMIN_PROFILES) {
        const as = asUser({ adminProfile: adminProfile as never });
        const key = await get(`/key-figures?academicYearId=${YEAR}`, as).expect(200);
        expect(key.body).toMatchObject({ academicYearId: YEAR, school: { pupils: 0, teachers: 0 }, teachers: [] });
        await get('/school-parts', as).expect(200);
        await get('/cost-rates', as).expect(200);
      }
    });

    it('reads the report over the grundschema only when asked', async () => {
      await get(`/key-figures?academicYearId=${YEAR}&schedule=true`, asUser({})).expect(200);
      await get(`/key-figures?academicYearId=${YEAR}&schedule=false`, asUser({})).expect(200);
      await get(`/key-figures?academicYearId=${YEAR}&schedule=1`, asUser({})).expect(200);
    });

    it('leaves tjänstgöringsgrad out for a profile without HR-läs and says so', async () => {
      const hidden = await get(`/key-figures?academicYearId=${YEAR}`, asUser({ adminProfile: 'SCHEMALAGGARE' as never })).expect(200);
      expect(hidden.body.hrHidden).toBe(true);
      const shown = await get(`/key-figures?academicYearId=${YEAR}`, asUser({ adminProfile: 'EXPEDITION' as never, hrRead: true })).expect(200);
      expect(shown.body.hrHidden).toBeUndefined();
    });

    it('gives the cost basis to those who read HR data and refuses the rest with ANALYSIS_COST_NOT_YOURS', async () => {
      for (const as of [asUser({ adminProfile: 'REKTOR' as never }), asUser({ adminProfile: 'EXPEDITION' as never, hrRead: true })]) {
        const cost = await get(`/cost-basis?academicYearId=${YEAR}`, as).expect(200);
        expect(cost.body).toMatchObject({ academicYearId: YEAR, substitutes: expect.anything() });
      }
      const refused = await get(`/cost-basis?academicYearId=${YEAR}`, asUser({ adminProfile: 'SCHEMALAGGARE' as never })).expect(403);
      expect(refused.body.code).toBe('ANALYSIS_COST_NOT_YOURS');
    });

    it('gives the payroll to those who read HR data and refuses the rest with HR_NOT_YOURS, before it reads anything', async () => {
      const path = `/payroll-basis?academicYearId=${YEAR}&from=2026-11-01&to=2026-11-30`;
      const refused = await get(path, asUser({ adminProfile: 'SCHEMALAGGARE' as never })).expect(403);
      expect(refused.body.code).toBe('HR_NOT_YOURS');
      const file = await send('post', '/payroll-basis/export', asUser({ adminProfile: 'LASARE' as never }), {
        academicYearId: YEAR,
        from: '2026-11-01',
        to: '2026-11-30',
        format: 'CSV',
      }).expect(403);
      expect(file.body.code).toBe('HR_NOT_YOURS');
      expect(harness.tx.$queryRaw).not.toHaveBeenCalled();
      await get(path, asUser({ adminProfile: 'FULL' as never })).expect(200);
    });

    it('hands over the payroll file as JSON with the bytes in base64, named by its period', async () => {
      const csv = await send('post', '/payroll-basis/export', asUser({}), { academicYearId: YEAR, from: '2026-11-01', to: '2026-11-30', format: 'CSV' }).expect(201);
      expect(csv.body).toMatchObject({ filename: 'loneunderlag-2026-11-01-2026-11-30.csv', contentType: 'text/csv; charset=windows-1252', protectedInFile: 0 });
      expect(Buffer.from(csv.body.contentBase64, 'base64').toString('latin1')).toMatch(/^Signatur;Löne-id;Efternamn/);
      const xlsx = await send('post', '/payroll-basis/export', asUser({}), { academicYearId: YEAR, from: '2026-11-01', to: '2026-11-30', format: 'XLSX' }).expect(201);
      expect(Buffer.from(xlsx.body.contentBase64, 'base64').subarray(0, 2).toString('latin1')).toBe('PK');
    });
  });

  describe('who writes what', () => {
    const part = { name: 'Lågstadiet', account: '4010', gradeFrom: 0, gradeTo: 3 };

    it('lets those who decide make, change and remove a skoldel and state and remove a rate, and nobody else', async () => {
      for (const adminProfile of DECIDING) {
        const as = asUser({ adminProfile: adminProfile as never });
        harness.tx['schoolPart']!['findMany']!.mockResolvedValueOnce([]);
        await send('post', '/school-parts', as, part).expect(201);
        await send('patch', `/school-parts/${PART}`, as, { account: '4011' }).expect(200);
        await send('delete', `/school-parts/${PART}`, as).expect(204);
        await send('put', '/cost-rates/TEACHER', as, { hourlyCost: 420 }).expect(200);
        await send('delete', '/cost-rates/TEACHER', as).expect(204);
      }
      for (const adminProfile of NOT_DECIDING) {
        const as = asUser({ adminProfile: adminProfile as never });
        for (const refused of [
          await send('post', '/school-parts', as, part),
          await send('patch', `/school-parts/${PART}`, as, { account: '4011' }),
          await send('delete', `/school-parts/${PART}`, as),
          await send('put', '/cost-rates/TEACHER', as, { hourlyCost: 420 }),
          await send('delete', '/cost-rates/TEACHER', as),
        ]) {
          expect(refused.status).toBe(403);
          expect(refused.body.code).toBe('DECISION_NOT_YOURS');
        }
      }
      expect(harness.tx['schoolPart']!['create']).toHaveBeenCalledTimes(DECIDING.length);
      expect(harness.tx['staffCostRate']!['upsert']).toHaveBeenCalledTimes(DECIDING.length);
    });
  });

  describe('what a request must be', () => {
    const admin = asUser({});

    it.each([
      ['no academicYearId', '/key-figures'],
      ['an academicYearId that is no id', '/key-figures?academicYearId=igår'],
      ['a schedule that is neither true nor false', `/key-figures?academicYearId=${YEAR}&schedule=kanske`],
      ['no academicYearId for the cost basis', '/cost-basis'],
      ['half a range for the cost basis', `/cost-basis?academicYearId=${YEAR}&from=2026-09-01`],
      ['a date that does not exist', `/cost-basis?academicYearId=${YEAR}&from=2026-02-30&to=2026-03-01`],
      ['a payroll without a period', `/payroll-basis?academicYearId=${YEAR}`],
      ['a payroll that ends first', `/payroll-basis?academicYearId=${YEAR}&from=2026-11-30&to=2026-11-01`],
      ['a payroll longer than 93 days', `/payroll-basis?academicYearId=${YEAR}&from=2026-08-17&to=2026-12-31`],
    ])('answers 400 for %s', async (_label, path) => {
      await get(path, admin).expect(400);
    });

    it('answers 400 for an export of a format that does not exist, and names the field', async () => {
      const refused = await send('post', '/payroll-basis/export', admin, { academicYearId: YEAR, from: '2026-11-01', to: '2026-11-30', format: 'PDF' }).expect(400);
      expect(JSON.stringify(refused.body)).toContain('format');
    });

    it.each([
      ['a blank name', { name: ' ', account: '1', gradeFrom: 0, gradeTo: 3 }],
      ['no konto', { name: 'Låg', gradeFrom: 0, gradeTo: 3 }],
      ['an årskurs above 9', { name: 'Låg', account: '1', gradeFrom: 0, gradeTo: 10 }],
      ['an årskurs below 0', { name: 'Låg', account: '1', gradeFrom: -1, gradeTo: 3 }],
      ['a half årskurs', { name: 'Låg', account: '1', gradeFrom: 0.5, gradeTo: 3 }],
      ['a backwards span', { name: 'Låg', account: '1', gradeFrom: 5, gradeTo: 3 }],
      ['a konto of 31 characters', { name: 'Låg', account: '9'.repeat(31), gradeFrom: 0, gradeTo: 3 }],
    ])('refuses a skoldel with %s', async (_label, body) => {
      await send('post', '/school-parts', admin, body).expect(400);
      expect(harness.tx['schoolPart']!['create']).not.toHaveBeenCalled();
    });

    it('refuses an id that is no id, and a category that does not exist', async () => {
      await send('patch', '/school-parts/inte-ett-id', admin, { account: '1' }).expect(400);
      await send('delete', '/school-parts/inte-ett-id', admin).expect(400);
      await send('put', '/cost-rates/PRINCIPAL', admin, { hourlyCost: 1 }).expect(400);
      await send('delete', '/cost-rates/PRINCIPAL', admin).expect(400);
    });

    it.each([
      ['a negative rate', { hourlyCost: -1 }],
      ['more than 100 000', { hourlyCost: 100001 }],
      ['three decimals', { hourlyCost: 1.234 }],
      ['a text', { hourlyCost: '420' }],
      ['nothing', {}],
    ])('refuses a rate of %s', async (_label, body) => {
      await send('put', '/cost-rates/TEACHER', admin, body).expect(400);
      expect(harness.tx['staffCostRate']!['upsert']).not.toHaveBeenCalled();
    });
  });
});
