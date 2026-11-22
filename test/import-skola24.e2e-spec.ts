import request from 'supertest';
import posts from '../src/import/__fixtures__/skola24-posts.json';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

/**
 * A file from Skola24 over HTTP (Formatbeskrivare, X3).
 *
 * `body` is what web/lib reads out of a synthetic table as Skola24's page for the staff import describes it: the description,
 * X2's mapping with the row the confidential mark holds back left out, and the teachers' mapper. web/lib/skola24-posts.test.ts
 * REGENERATES it from the table in the fixture and requires equality, and this suite posts it through the real global pipe, the
 * controller and ImportService (the database is mocked, as in import.e2e-spec.ts). A change to either side fails the other: that
 * the web's mapper and the gateway's DTO agree on what a file from Skola24 becomes is a seam neither side's own tests can see.
 */

const post = (harness: TestHarness) => request(harness.app.getHttpServer()).post(posts.teachers.path).set('x-test-user', asUser({}));

describe('a file from Skola24, posted to the CSV import (e2e)', () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = await createTestApp();
  });
  afterAll(async () => {
    await harness.close();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    harness.tx['user']!['findFirst']!.mockResolvedValue(null);
    harness.tx['user']!['create']!.mockResolvedValueOnce({ id: 'u-asa' }).mockResolvedValueOnce({ id: 'u-erik' });
  });

  it.each([
    ['a personnummer file', posts.teachers],
    ["a file of TF numbers, as Skola24's own course files are", posts.teachersTf],
  ])('takes the body the web builds from %s, and creates the two people it names, without an invitation', async (_name, staff) => {
    const response = await post(harness).send(staff.body).expect(201);

    expect(response.body).toEqual({ created: 2, skipped: 0, errors: [] });
    const created = harness.tx['user']!['create']!.mock.calls.map((call) => (call[0] as { data: Record<string, unknown> }).data);
    expect(created.map((data) => [data['firstName'], data['lastName'], data['email']])).toEqual([
      ['Åsa', 'Provsson', 'asa.provsson@example.invalid'],
      ['Erik', 'Exempel', 'erik.exempel@example.invalid'],
    ]);
    // Roster preparation, not an invitation (import.e2e-spec.ts says why).
    expect(harness.supabase.inviteUser).not.toHaveBeenCalled();
    // The marked person is not in the body, so nothing of hers reaches the database.
    expect(JSON.stringify(harness.tx['user']!['create']!.mock.calls)).not.toMatch(/Maria|Fiktiv|TF0/);
  });

  it('refuses the same body with a personnummer riding on a row, under any name: the global pipe whitelists', async () => {
    for (const key of ['personalNumber', 'personnummer', 'ssn']) {
      const body = { ...posts.teachers.body, rows: posts.teachers.body.rows.map((row, at) => (at === 0 ? { ...row, [key]: '19000103-0001' } : row)) };
      await post(harness).send(body).expect(400);
    }
    expect(harness.tx['user']!['create']).not.toHaveBeenCalled();
  });

  it('refuses a body whose file row numbers are not whole numbers from 1: the web counts the file\'s rows, and so does the gateway', async () => {
    await post(harness).send({ ...posts.teachers.body, rowNumbers: [0, 3] }).expect(400);
    await post(harness).send({ ...posts.teachers.body, rowNumbers: [1.5, 3] }).expect(400);
    expect(harness.tx['user']!['create']).not.toHaveBeenCalled();
  });

  it('names a row by the number the file gives it, not by its place in the body', async () => {
    // The second person of the body is row 3 of the file (row 2 is the marked one the web left out). When that person cannot be created
    // the school is told "row 3", the number it sees in Excel, and not "row 2", the place in the body.
    harness.tx['user']!['create']!.mockReset().mockResolvedValueOnce({ id: 'u-asa' }).mockRejectedValueOnce(new Error('Databasen vägrade raden.'));
    const response = await post(harness).send(posts.teachers.body).expect(201);
    expect(response.body.created).toBe(1);
    expect((response.body.errors as { row: number }[]).map((error) => error.row)).toEqual([3]);
  });
});
