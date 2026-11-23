import request from 'supertest';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

/**
 * A NUL in the note. PostgreSQL's text cannot hold one (SQLSTATE 22021, "invalid byte sequence for encoding UTF8: 0x00"), so a note
 * with a U+0000 in it reached the database and came back as a 500 "An unexpected database error occurred" (the same on the posts'
 * note). It is a 400 at the DTO, with the field's own sentence, and nothing is written.
 */
describe('Scope assessments: a NUL in the note (e2e)', () => {
  let harness: TestHarness;
  const USER_ID = '66666666-6666-4666-8666-666666666666';
  const YEAR_ID = '99999999-9999-4999-8999-999999999999';

  beforeAll(async () => {
    harness = await createTestApp();
  });

  afterAll(async () => {
    await harness.close();
  });

  it('is refused at the DTO as a 400, and writes nothing', async () => {
    const response = await request(harness.app.getHttpServer())
      .put(`/api/v1/scope-assessments/${USER_ID}?academicYearId=${YEAR_ID}`)
      .set('x-test-user', asUser({}))
      .send({ teachingLevelHours: 600, note: 'a\u0000b' })
      .expect(400);
    expect(response.body.errors.body).toContain('Anteckningen kan inte innehålla nolltecken (U+0000).');
    expect(harness.tx['assignmentScopeAssessment']!['upsert']).not.toHaveBeenCalled();
  });
});
