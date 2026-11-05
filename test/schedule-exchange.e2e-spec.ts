import request from 'supertest';
import { Role } from '../src/auth/enums/role.enum';
import { ScheduleExchangeService } from '../src/schedule-exchange/exchange.service';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

/**
 * Schemat som tabell och i öppna format over HTTP: what the page sends
 * survives routing, the global whitelist validation and the areas' guard on
 * the way in, and what the page reads comes back in the shape it draws. The
 * service is replaced by a stand-in here (its rows and rules are the service
 * spec's, and a real database's probe); this spec is the door.
 */

const YEAR_ID = '99999999-9999-4999-8999-999999999999';
const FINGERPRINT = 'a'.repeat(32);

const file = (text: string, name = 'schema.csv') => ({ name, contentBase64: Buffer.from(text, 'utf8').toString('base64') });

describe('Schedule exchange (e2e)', () => {
  let harness: TestHarness;
  const http = () => harness.app.getHttpServer();
  const service = {
    summary: jest.fn(),
    export: jest.fn(),
    preview: jest.fn(),
    apply: jest.fn(),
  };
  const as = (adminProfile: string) => asUser({ adminProfile } as never);

  beforeAll(async () => {
    harness = await createTestApp({ configure: (builder) => builder.overrideProvider(ScheduleExchangeService).useValue(service) });
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    service.summary.mockResolvedValue({ lessons: 3 });
    service.export.mockResolvedValue({ filename: 'a.csv', contentType: 'text/csv; charset=utf-8', body: Buffer.from('Á;B', 'utf8'), notes: ['Signaturen ”A,B” skrevs som ”A B”.'] });
    service.preview.mockResolvedValue({ canApply: true, fingerprint: FINGERPRINT });
    service.apply.mockResolvedValue({ created: 2 });
  });

  describe('summary', () => {
    it('answers an administrator for a year, and asks for a year', async () => {
      const response = await request(http()).get('/api/v1/schedule-exchange/summary').query({ academicYearId: YEAR_ID }).set('x-test-user', asUser({})).expect(200);
      expect(response.body).toEqual({ lessons: 3 });
      expect(service.summary).toHaveBeenCalledWith(YEAR_ID, expect.objectContaining({ role: 'SCHOOL_ADMIN' }));
      await request(http()).get('/api/v1/schedule-exchange/summary').set('x-test-user', asUser({})).expect(400);
      await request(http()).get('/api/v1/schedule-exchange/summary').query({ academicYearId: 'nope' }).set('x-test-user', asUser({})).expect(400);
    });

    it('is no teacher’s', async () => {
      await request(http()).get('/api/v1/schedule-exchange/summary').query({ academicYearId: YEAR_ID }).set('x-test-user', asUser({ role: Role.TEACHER })).expect(403);
      expect(service.summary).not.toHaveBeenCalled();
    });
  });

  describe('export', () => {
    it('hands the file back as JSON with its bytes in base64, for the page’s client', async () => {
      const response = await request(http())
        .post('/api/v1/schedule-exchange/export')
        .set('x-test-user', asUser({}))
        .send({ academicYearId: YEAR_ID, format: 'TABLE_CSV' })
        .expect(201);
      expect(response.body).toEqual({
        filename: 'a.csv',
        contentType: 'text/csv; charset=utf-8',
        contentBase64: Buffer.from('Á;B', 'utf8').toString('base64'),
        notes: ['Signaturen ”A,B” skrevs som ”A B”.'],
      });
      expect(service.export).toHaveBeenCalledWith(YEAR_ID, 'TABLE_CSV', expect.anything());
    });

    it('is open to a läsare, who changes nothing, and refuses a format that is none of the four', async () => {
      await request(http()).post('/api/v1/schedule-exchange/export').set('x-test-user', as('LASARE')).send({ academicYearId: YEAR_ID, format: 'ASC_XML' }).expect(201);
      await request(http()).post('/api/v1/schedule-exchange/export').set('x-test-user', asUser({})).send({ academicYearId: YEAR_ID, format: 'PDF' }).expect(400);
      await request(http()).post('/api/v1/schedule-exchange/export').set('x-test-user', asUser({ role: Role.TEACHER })).send({ academicYearId: YEAR_ID, format: 'ASC_XML' }).expect(403);
    });
  });

  describe('preview', () => {
    it('passes the uploaded bytes, decoded, to the service', async () => {
      const response = await request(http())
        .post('/api/v1/schedule-exchange/import/preview')
        .set('x-test-user', asUser({}))
        .send({ academicYearId: YEAR_ID, format: 'UNTIS_GPU', files: [file('1;7A', 'GPU001.TXT'), file('x', 'GPU011.TXT')] })
        .expect(201);
      expect(response.body).toEqual({ canApply: true, fingerprint: FINGERPRINT });
      const sent = service.preview.mock.calls[0]![0] as { files: { name: string; bytes: Buffer }[]; format: string };
      expect(sent.format).toBe('UNTIS_GPU');
      expect(sent.files.map((f) => [f.name, f.bytes.toString('utf8')])).toEqual([['GPU001.TXT', '1;7A'], ['GPU011.TXT', 'x']]);
    });

    it('is open to a läsare, and refuses what is not a file or not base64', async () => {
      const body = { academicYearId: YEAR_ID, format: 'TABLE_CSV', files: [file('a')] };
      await request(http()).post('/api/v1/schedule-exchange/import/preview').set('x-test-user', as('LASARE')).send(body).expect(201);
      await request(http()).post('/api/v1/schedule-exchange/import/preview').set('x-test-user', asUser({})).send({ ...body, files: [] }).expect(400);
      await request(http()).post('/api/v1/schedule-exchange/import/preview').set('x-test-user', asUser({})).send({ ...body, files: [file('a'), file('b'), file('c'), file('d'), file('e')] }).expect(400);
      await request(http()).post('/api/v1/schedule-exchange/import/preview').set('x-test-user', asUser({})).send({ ...body, files: [{ name: 'a.csv', contentBase64: '***' }] }).expect(400);
      await request(http()).post('/api/v1/schedule-exchange/import/preview').set('x-test-user', asUser({})).send({ ...body, format: 'DOCX' }).expect(400);
      await request(http()).post('/api/v1/schedule-exchange/import/preview').set('x-test-user', asUser({})).send({ ...body, extra: 1 }).expect(400);
      expect(service.preview).toHaveBeenCalledTimes(1);
    });
  });

  describe('apply', () => {
    const body = { academicYearId: YEAR_ID, format: 'TABLE_CSV', files: [file('a')], fingerprint: FINGERPRINT };

    it('writes for an administrator who changes both Schemaläggning and Planering', async () => {
      for (const profile of ['FULL', 'REKTOR', 'SCHEMALAGGARE']) {
        await request(http()).post('/api/v1/schedule-exchange/import/apply').set('x-test-user', as(profile)).send(body).expect(201);
      }
      expect(service.apply).toHaveBeenCalledTimes(3);
      expect(service.apply.mock.calls[0]![0]).toMatchObject({ academicYearId: YEAR_ID, fingerprint: FINGERPRINT });
    });

    it('is refused, naming the area, to the expedition and the läsare, and writes nothing', async () => {
      for (const profile of ['EXPEDITION', 'LASARE']) {
        const response = await request(http()).post('/api/v1/schedule-exchange/import/apply').set('x-test-user', as(profile)).send(body).expect(403);
        expect(response.body).toMatchObject({ code: 'AREA_NOT_YOURS' });
      }
      await request(http()).post('/api/v1/schedule-exchange/import/apply').set('x-test-user', asUser({ role: Role.TEACHER })).send(body).expect(403);
      expect(service.apply).not.toHaveBeenCalled();
    });

    it('wants the preview’s fingerprint', async () => {
      const { fingerprint, ...without } = body;
      void fingerprint;
      await request(http()).post('/api/v1/schedule-exchange/import/apply').set('x-test-user', asUser({})).send(without).expect(400);
      await request(http()).post('/api/v1/schedule-exchange/import/apply').set('x-test-user', asUser({})).send({ ...body, fingerprint: 'short' }).expect(400);
      expect(service.apply).not.toHaveBeenCalled();
    });
  });
});
