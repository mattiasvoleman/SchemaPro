import request from 'supertest';
import { SchoolExportService } from '../src/school-export/school-export.service';
import { SubjectAccessService } from '../src/school-export/subject-access.service';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

/**
 * Hela skolans data through the whole app: what the routes and their guards
 * answer (the services are doubles; the database half is
 * scripts/test/probe-school-export.ts and the RLS suite). The decisions are
 * asked for on every write, the file is sent with the headers that let a client
 * tell a whole file from a cut one, and a file that breaks off after its
 * headers is broken off for the client too, not ended as if it were whole.
 */
describe('Whole-school export (e2e)', () => {
  let harness: TestHarness;
  const http = () => harness.app.getHttpServer();
  const ID = '44444444-4444-4444-8444-444444444444';
  const PERSON = '55555555-5555-4555-8555-555555555555';

  const view = { id: ID, status: 'QUEUED', fetchable: false };
  const service = {
    list: jest.fn(async () => [view]),
    order: jest.fn(async () => view),
    withdraw: jest.fn(async () => undefined),
    openFile: jest.fn(),
  };
  const access = { extract: jest.fn(async () => ({ filename: 'u.zip', contentType: 'application/zip', contentBase64: 'UEs=', subjectIsMarked: false, relatedIncluded: 0, relatedHeldOut: 0 })) };

  beforeAll(async () => {
    harness = await createTestApp({
      configure: (builder) => builder.overrideProvider(SchoolExportService).useValue(service).overrideProvider(SubjectAccessService).useValue(access),
    });
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => jest.clearAllMocks());

  describe('the decisions are asked for on every write', () => {
    it.each(['SCHEMALAGGARE', 'EXPEDITION', 'LASARE'])('refuses %s the order, the withdrawal and the extract with a 403 before the service is asked', async (adminProfile) => {
      const as = asUser({ adminProfile } as never);
      await request(http()).post('/api/v1/school-exports').set('x-test-user', as).expect(403);
      await request(http()).delete(`/api/v1/school-exports/${ID}`).set('x-test-user', as).expect(403);
      await request(http()).post('/api/v1/school-exports/subject-access').set('x-test-user', as).send({ personId: PERSON }).expect(403);
      expect(service.order).not.toHaveBeenCalled();
      expect(service.withdraw).not.toHaveBeenCalled();
      expect(access.extract).not.toHaveBeenCalled();
    });

    it.each(['FULL', 'REKTOR'])('lets %s order, withdraw and ask for an extract', async (adminProfile) => {
      const as = asUser({ adminProfile } as never);
      await request(http()).post('/api/v1/school-exports').set('x-test-user', as).expect(201);
      await request(http()).delete(`/api/v1/school-exports/${ID}`).set('x-test-user', as).expect(204);
      const extract = await request(http()).post('/api/v1/school-exports/subject-access').set('x-test-user', as).send({ personId: PERSON, withRelated: true }).expect(200);
      expect(extract.body).toMatchObject({ filename: 'u.zip', contentBase64: 'UEs=' });
      expect(access.extract).toHaveBeenCalledWith(expect.objectContaining({ adminProfile }), PERSON, true);
    });

    it('refuses the huvudman\'s reader every write, by the guard that refuses it everywhere', async () => {
      const reader = asUser({ adminProfile: 'LASARE', huvudman: { id: ID, name: 'K', memberId: ID, role: 'PLANERARE', firstName: 'a', lastName: 'b' } } as never);
      const response = await request(http()).post('/api/v1/school-exports').set('x-test-user', reader).expect(403);
      expect(response.body).toMatchObject({ code: 'HUVUDMAN_READS_ONLY' });
    });

    it('answers nobody without a login, and no teacher, pupil or guardian', async () => {
      await request(http()).get('/api/v1/school-exports').expect(401);
      for (const role of ['TEACHER', 'STUDENT', 'GUARDIAN']) {
        await request(http()).get('/api/v1/school-exports').set('x-test-user', asUser({ role } as never)).expect(403);
      }
      expect(service.list).not.toHaveBeenCalled();
    });
  });

  describe('input', () => {
    it('refuses an id that is not a UUID, and an extract body that names anything else', async () => {
      const as = asUser({});
      await request(http()).delete('/api/v1/school-exports/not-a-uuid').set('x-test-user', as).expect(400);
      await request(http()).get('/api/v1/school-exports/not-a-uuid/file').set('x-test-user', as).expect(400);
      await request(http()).post('/api/v1/school-exports/subject-access').set('x-test-user', as).send({ personId: 'x' }).expect(400);
      await request(http()).post('/api/v1/school-exports/subject-access').set('x-test-user', as).send({ personId: PERSON, schoolId: ID }).expect(400);
      await request(http()).post('/api/v1/school-exports/subject-access').set('x-test-user', as).send({ personId: PERSON, withRelated: 'yes' }).expect(400);
    });
  });

  describe('the file', () => {
    const pieces = (chunks: Buffer[], failAfter?: number) => async function* () {
      let sent = 0;
      for (const chunk of chunks) {
        if (failAfter !== undefined && sent >= failAfter) throw new Error('the file vanished');
        sent += 1;
        yield chunk;
      }
    };

    it('is sent whole, with its length, its checksum, a name and no cache', async () => {
      const bytes = [Buffer.from('abc'), Buffer.from('def')];
      service.openFile.mockResolvedValue({ id: ID, filename: 'rastra-skolexport-prov-2026-11-05.zip', byteSize: 6, sha256: 'f'.repeat(64), chunkCount: 2, pieces: pieces(bytes) });
      const response = await request(http()).get(`/api/v1/school-exports/${ID}/file`).set('x-test-user', asUser({})).buffer(true).parse((res, done) => {
        const parts: Buffer[] = [];
        res.on('data', (part: Buffer) => parts.push(part));
        res.on('end', () => done(null, Buffer.concat(parts)));
      }).expect(200);
      expect(response.body.toString()).toBe('abcdef');
      expect(response.headers).toMatchObject({
        'content-type': 'application/zip',
        'content-length': '6',
        'content-disposition': 'attachment; filename="rastra-skolexport-prov-2026-11-05.zip"',
        'cache-control': 'no-store',
        'x-content-sha256': 'f'.repeat(64),
        'x-content-type-options': 'nosniff',
      });
      expect(service.openFile).toHaveBeenCalledWith(ID, expect.objectContaining({ userId: expect.any(String) }));
    });

    it('is broken off for the client when it breaks off after its headers, not ended as whole', async () => {
      service.openFile.mockResolvedValue({ id: ID, filename: 'x.zip', byteSize: 9, sha256: 'a'.repeat(64), chunkCount: 3, pieces: pieces([Buffer.from('abc'), Buffer.from('def'), Buffer.from('ghi')], 1) });
      const outcome = await request(http()).get(`/api/v1/school-exports/${ID}/file`).set('x-test-user', asUser({})).buffer(true).then(
        (response) => ({ ok: true, length: response.body.length }),
        (error: Error) => ({ ok: false, message: error.message }),
      );
      expect(outcome.ok).toBe(false);
    });

    it('answers the service\'s refusal as a status when nothing has been sent yet', async () => {
      const { GoneException } = await import('@nestjs/common');
      service.openFile.mockRejectedValue(new GoneException({ message: 'Filen har gått ut', code: 'SCHOOL_EXPORT_EXPIRED' }));
      const response = await request(http()).get(`/api/v1/school-exports/${ID}/file`).set('x-test-user', asUser({})).expect(410);
      expect(response.body).toMatchObject({ code: 'SCHOOL_EXPORT_EXPIRED' });
    });
  });
});
