import request from 'supertest';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

/**
 * Transport limits versus declared limits.
 *
 * Every import DTO declares a row cap with @ArrayMaxSize, and a school fills
 * its file up to that cap. If the body parser refuses the payload first, the
 * declared cap is a promise the API cannot keep — and the caller sees it as a
 * server fault rather than as "your file is too big". Both halves are asserted
 * here because both were wrong: 2000 membership rows (~130 kB) exceeded the
 * 100 kB Express default, and the resulting error was reported as a 500.
 */

const YEAR = '44444444-4444-4444-8444-444444444444';

const membershipRows = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    groupName: 'Ma71',
    email: `elev.efternamn${i}@exempelskolan.se`,
  }));

/**
 * A timplan row is the widest of the import shapes — two addresses, a period
 * and a recurrence on top of the identifying pair — so its declared cap is the
 * one most likely to outgrow the transport even though the row count is lower
 * than the membership cap.
 */
const requirementRows = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    groupName: `Undervisningsgrupp ${i}`,
    subject: 'Samhällsorientering',
    lessonsPerWeek: 3,
    minutesPerLesson: 60,
    teacherEmail: `larare.efternamn${i}@exempelskolan.se`,
    coTeacherEmail: `medlarare.efternamn${i}@exempelskolan.se`,
    recurrence: 'ODD_WEEKS',
    startDate: '2026-08-17',
    endDate: '2027-06-11',
  }));

describe('Import payload limits (e2e)', () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = await createTestApp();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('accepts a membership import filled right up to the declared cap', async () => {
    const body = { academicYearId: YEAR, rows: membershipRows(2000) };
    // Guards the test itself: if the payload ever shrinks below the old 100 kB
    // default, this stops proving anything.
    expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(100 * 1024);

    harness.tx['user']!['findMany']!.mockResolvedValue([]);
    harness.tx['studentGroup']!['findMany']!.mockResolvedValue([]);

    await request(harness.app.getHttpServer())
      .post('/api/v1/import/group-members')
      .set('x-test-user', asUser({}))
      .send(body)
      .expect(201);
  });

  it('accepts a timplan import filled right up to the declared cap', async () => {
    // The kind added last, and the one this file exists to keep honest: a cap
    // the body parser refuses is a promise the API cannot keep.
    const body = { academicYearId: YEAR, rows: requirementRows(1000) };
    expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(100 * 1024);

    harness.tx['studentGroup']!['findMany']!.mockResolvedValue([]);
    harness.tx['subject']!['findMany']!.mockResolvedValue([]);
    harness.tx['user']!['findMany']!.mockResolvedValue([]);
    harness.tx['teachingRequirement']!['findMany']!.mockResolvedValue([]);
    // Every row states a period, so the import reads the year's bounds FOR
    // SHARE, as a raw query. The shared mock would hand back a model proxy for
    // `$queryRaw`, which is not callable; no row is what a year the caller
    // cannot see reads as.
    Object.assign(harness.tx, { $queryRaw: jest.fn().mockResolvedValue([]) });

    await request(harness.app.getHttpServer())
      .post('/api/v1/import/requirements')
      .set('x-test-user', asUser({}))
      .send(body)
      .expect(201);
  });

  it('rejects one timplan row past the cap as a 400', async () => {
    await request(harness.app.getHttpServer())
      .post('/api/v1/import/requirements')
      .set('x-test-user', asUser({}))
      .send({ academicYearId: YEAR, rows: requirementRows(1001) })
      .expect(400);
  });

  it('rejects one row past the cap as a 400, naming the field', async () => {
    const response = await request(harness.app.getHttpServer())
      .post('/api/v1/import/group-members')
      .set('x-test-user', asUser({}))
      .send({ academicYearId: YEAR, rows: membershipRows(2001) })
      .expect(400);

    expect(JSON.stringify(response.body)).toContain('rows');
  });

  it('answers 413 — not 500 — when the body itself is too large', async () => {
    // A school's real file: 5400 memberships is ~350 kB. The caller must be
    // told the request was too big, not that the server broke.
    const response = await request(harness.app.getHttpServer())
      .post('/api/v1/import/group-members')
      .set('x-test-user', asUser({}))
      .send({ academicYearId: YEAR, rows: membershipRows(20_000) })
      .expect(413);

    expect(response.body).toMatchObject({
      status: 413,
      title: 'Payload Too Large',
    });
    expect(String(response.body.detail)).toMatch(/too large/i);
  });

  it('answers 400 on a body that is not valid JSON', async () => {
    const response = await request(harness.app.getHttpServer())
      .post('/api/v1/import/room-types')
      .set('x-test-user', asUser({}))
      .set('Content-Type', 'application/json')
      .send('{"rows": [')
      .expect(400);

    expect(response.body).toMatchObject({ status: 400 });
  });
});
