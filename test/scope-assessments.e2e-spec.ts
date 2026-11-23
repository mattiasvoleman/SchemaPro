import request from 'supertest';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

/**
 * Rektorns bedömning av lärarens omfattning, through the whole app: what the route's guard lets in and what its DTO lets through to
 * the service. The service's own spec calls the service with a body already shaped, so the DTO's rules (a whole number of hours between
 * 1 and 1500, the exception's kind, a real day, a note of at most 500 characters that is trimmed, nothing the database sets) are held
 * here, by a request that goes through the pipe, and the roles of the route by a request from each of them.
 */
describe('Scope assessments (e2e)', () => {
  let harness: TestHarness;
  const http = () => harness.app.getHttpServer();
  const USER_ID = '66666666-6666-4666-8666-666666666666';
  const YEAR_ID = '99999999-9999-4999-8999-999999999999';
  const PUT = `/api/v1/scope-assessments/${USER_ID}?academicYearId=${YEAR_ID}`;
  const LIST = `/api/v1/scope-assessments?academicYearId=${YEAR_ID}`;

  beforeAll(async () => {
    harness = await createTestApp();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  /** The transaction a good body reaches: the person is a teacher, the year begins after the ordinance does, the lydelse has its bands. */
  const givenAYearTheOrdinanceReaches = () => {
    (harness.tx as unknown as { $queryRaw: jest.Mock }).$queryRaw.mockResolvedValue([{ role: 'TEACHER' }]);
    harness.tx['academicYear']!['findUnique']!.mockResolvedValue({ startDate: new Date('2027-08-16T00:00:00.000Z'), gradeNumbering: 'NIOARIG' });
    harness.tx['assignmentScopeVersion']!['findFirst']!.mockResolvedValue({
      id: 'v1', code: 'SFS2026:1487', sfs: 'SFS 2026:1487', title: 'Förordning', validFrom: new Date('2027-07-01T00:00:00.000Z'), validTo: null, source: 'https://example.invalid',
    });
    harness.tx['assignmentScopeBand']!['findMany']!.mockResolvedValue([
      { schoolForm: 'GRUNDSKOLA', gradeNumbering: 'NIOARIG', gradeFrom: 1, gradeTo: 6, teachingHoursLow: 550, teachingHoursHigh: 650, planningFloorPercent: 100, teachingSection: '3 § p. 1', planningSection: '4 §', note: null },
    ]);
    harness.tx['assignmentScopeAssessment']!['upsert']!.mockImplementation(({ create }: { create: Record<string, unknown> }) =>
      Promise.resolve({ id: 'a1', ...create, decidedById: null, decidedAt: new Date('2027-03-05T08:00:00.000Z'), createdAt: new Date(), updatedAt: new Date() }),
    );
  };

  it('is the administrators\' route: a teacher, a pupil and a guardian are refused every verb at the guard, and nothing is read or written', async () => {
    for (const role of ['TEACHER', 'STUDENT', 'GUARDIAN']) {
      const as = asUser({ role: role as never });
      await request(http()).get(LIST).set('x-test-user', as).expect(403);
      await request(http()).put(PUT).set('x-test-user', as).send({ teachingLevelHours: 600 }).expect(403);
      await request(http()).delete(PUT).set('x-test-user', as).expect(403);
    }
    expect(harness.tx['assignmentScopeAssessment']!['findMany']).not.toHaveBeenCalled();
    expect(harness.tx['assignmentScopeAssessment']!['upsert']).not.toHaveBeenCalled();
    expect(harness.tx['assignmentScopeAssessment']!['delete']).not.toHaveBeenCalled();
  });

  it('holds the body to what the DTO says, in its own words, and writes nothing', async () => {
    givenAYearTheOrdinanceReaches();
    const refused: [string, Record<string, unknown>][] = [
      ['minst 1 timme', { teachingLevelHours: 0 }],
      ['minst 1 timme', { teachingLevelHours: -5 }],
      ['högst 1500 timmar', { teachingLevelHours: 1501 }],
      ['hela timmar', { teachingLevelHours: 600.5 }],
      ['hela timmar', { teachingLevelHours: '600' }],
      ['OWN_INITIATIVE', { exceptionKind: 'VIKARIE' }],
      ['ÅÅÅÅ-MM-DD', { exceptionKind: 'OWN_INITIATIVE', ownInitiativeOn: '2027-02-30' }],
      ['ÅÅÅÅ-MM-DD', { exceptionKind: 'OWN_INITIATIVE', ownInitiativeOn: '2027-8-1' }],
      ['högst 500 tecken', { teachingLevelHours: 600, note: 'x'.repeat(501) }],
      ['anges som text', { teachingLevelHours: 600, note: 5 }],
      // What the database sets, and what the URL names, are not the caller's to send.
      ['property decidedById should not exist', { teachingLevelHours: 600, decidedById: USER_ID }],
      ['property decidedAt should not exist', { teachingLevelHours: 600, decidedAt: '2027-03-05T08:00:00.000Z' }],
      ['property schoolId should not exist', { teachingLevelHours: 600, schoolId: USER_ID }],
      ['property userId should not exist', { teachingLevelHours: 600, userId: USER_ID }],
    ];
    for (const [said, body] of refused) {
      const response = await request(http()).put(PUT).set('x-test-user', asUser({})).send(body).expect(400);
      const messages: string[] = response.body.errors?.body ?? [];
      expect({ body, said: messages.some((message) => message.includes(said)) }).toEqual({ body, said: true });
    }
    expect(harness.tx['assignmentScopeAssessment']!['upsert']).not.toHaveBeenCalled();
  });

  it('lets the edges of the DTO through: 1 and 1500 hours, a note of 500 characters', async () => {
    givenAYearTheOrdinanceReaches();
    // 1 hour is the DTO's lowest; the ordinance's own edge (650 here) is the service's, so 1500 is refused THERE (400, no `errors`).
    await request(http()).put(PUT).set('x-test-user', asUser({})).send({ teachingLevelHours: 1, note: 'x'.repeat(500) }).expect(200);
    const over = await request(http()).put(PUT).set('x-test-user', asUser({})).send({ teachingLevelHours: 1500 }).expect(400);
    expect(over.body.errors).toBeUndefined();
    expect(harness.tx['assignmentScopeAssessment']!['upsert']).toHaveBeenCalledTimes(1);
  });

  it('writes a note trimmed, and a note of nothing but blanks as no note', async () => {
    givenAYearTheOrdinanceReaches();
    const noteOf = () => {
      const call = harness.tx['assignmentScopeAssessment']!['upsert']!.mock.calls.at(-1) as [{ create: { note: string | null } }];
      return call[0].create.note;
    };
    await request(http()).put(PUT).set('x-test-user', asUser({})).send({ teachingLevelHours: 600, note: '  skäl  ' }).expect(200);
    expect(noteOf()).toBe('skäl');
    await request(http()).put(PUT).set('x-test-user', asUser({})).send({ teachingLevelHours: 600, note: '   ' }).expect(200);
    expect(noteOf()).toBeNull();
  });
});
