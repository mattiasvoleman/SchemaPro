import { Prisma } from '@prisma/client';
import request from 'supertest';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

/**
 * A pool with no connection to give, through the real pipeline (the review of #419, L-5; and L-1, the Retry-After).
 * The filter's own spec calls it with a stand-in response; this one drives the application over supertest, so what is
 * shown is what a client gets: a 503 problem+json with the code `DATABASE_BUSY` and a `Retry-After` in whole seconds,
 * where it used to be a 500, and nothing written. Prisma is the e2e suite's mock, so the refusal is thrown as the one
 * Prisma 7 throws when a transaction found no connection within its maxWait (P2028, "Unable to start a transaction").
 */
describe('A database with no connection to give (e2e)', () => {
  let harness: TestHarness;
  const USER_ID = '66666666-6666-4666-8666-666666666666';
  const YEAR_ID = '99999999-9999-4999-8999-999999999999';

  beforeAll(async () => {
    harness = await createTestApp();
  });

  afterAll(async () => {
    await harness.close();
  });

  const neverStarted = (): Prisma.PrismaClientKnownRequestError =>
    new Prisma.PrismaClientKnownRequestError('Transaction API error: Unable to start a transaction in the given time.', {
      code: 'P2028',
      clientVersion: Prisma.prismaVersion.client,
    });

  const put = () =>
    request(harness.app.getHttpServer())
      .put(`/api/v1/scope-assessments/${USER_ID}?academicYearId=${YEAR_ID}`)
      .set('x-test-user', asUser({}))
      .send({ teachingLevelHours: 600 });

  it('is a 503 DATABASE_BUSY problem with a Retry-After, and writes nothing', async () => {
    harness.prisma.withRls.mockRejectedValueOnce(neverStarted());

    const response = await put().expect(503);

    expect(response.headers['retry-after']).toBe('5');
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body).toMatchObject({ status: 503, title: 'Service Unavailable', code: 'DATABASE_BUSY' });
    expect(JSON.stringify(response.body)).not.toContain('Transaction API error');
    expect(harness.tx['assignmentScopeAssessment']!['upsert']).not.toHaveBeenCalled();
  });

  it('sends no Retry-After with the 500 of a transaction that started and then expired', async () => {
    harness.prisma.withRls.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Transaction API error: Transaction already closed: A query cannot be executed on an expired transaction.', {
        code: 'P2028',
        clientVersion: Prisma.prismaVersion.client,
      }),
    );

    const response = await put().expect(500);

    expect(response.headers['retry-after']).toBeUndefined();
    expect(response.body).not.toHaveProperty('code');
  });
});
