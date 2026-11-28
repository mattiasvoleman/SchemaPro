import request from 'supertest';
import { Role } from '../src/auth/enums/role.enum';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

/**
 * Lägg det som går (E7a) over HTTP: the two routes resolve with their pipes and guards. A unit spec calls the service as a plain method and skips exactly
 * what makes a route a route (the guards, the pipes, the filter), so what the doors say is held here: an administrator of the schedule may ask and take in,
 * nobody else may, and a request that names what it fills badly is refused before anything is read.
 */

const YEAR_ID = '44444444-4444-4444-8444-444444444444';
const POST_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const KEY = `${POST_ID}|-|60|1`;
const BASIS = 'a'.repeat(32);

describe('Lägg det som går (e2e)', () => {
  let harness: TestHarness;
  const http = () => harness.app.getHttpServer();
  const propose = (body: unknown) => request(http()).post('/api/v1/board-fill/propose').send(body as object);
  const apply = (body: unknown) => request(http()).post('/api/v1/board-fill/apply').send(body as object);
  const item = { key: KEY, dayOfWeek: 2, startTime: '09:00' };

  beforeAll(async () => {
    harness = await createTestApp();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('is nobody\'s without a login', async () => {
    await propose({ academicYearId: YEAR_ID, scope: 'SCHOOL' }).expect(401);
    await apply({ academicYearId: YEAR_ID, basis: BASIS, items: [item] }).expect(401);
  });

  it('is an administrator\'s and no teacher\'s, no pupil\'s, and not that of the one who only reads', async () => {
    const body = { academicYearId: YEAR_ID, scope: 'CLASS' };
    for (const role of [Role.TEACHER, Role.STUDENT, Role.GUARDIAN]) {
      await propose(body).set('x-test-user', asUser({ role })).expect(403);
      await apply({ academicYearId: YEAR_ID, basis: BASIS, items: [item] }).set('x-test-user', asUser({ role })).expect(403);
    }
    // A läsare reads every administrator's pages and writes none of them: the proposal is a door of the schedule's writers (Schemaläggning, Drift).
    await propose(body).set('x-test-user', asUser({ adminProfile: 'LASARE' as never })).expect(403);
    await apply({ academicYearId: YEAR_ID, basis: BASIS, items: [item] }).set('x-test-user', asUser({ adminProfile: 'LASARE' as never })).expect(403);
  });

  it('refuses a request that names what it fills badly, before anything is read', async () => {
    const as = { 'x-test-user': asUser({}) };
    const refused = async (body: unknown) => {
      await propose(body).set(as).expect(400);
    };
    await refused({});
    await refused({ academicYearId: 'x', scope: 'SCHOOL' });
    await refused({ academicYearId: YEAR_ID, scope: 'EVERYTHING' });
    await refused({ academicYearId: YEAR_ID, scope: 'CLASS' });
    await refused({ academicYearId: YEAR_ID, scope: 'CLASS', studentGroupId: 'x' });
    await refused({ academicYearId: YEAR_ID, scope: 'GRADE' });
    await refused({ academicYearId: YEAR_ID, scope: 'GRADE', gradeLevel: 0 });
    await refused({ academicYearId: YEAR_ID, scope: 'BRICKS' });
    await refused({ academicYearId: YEAR_ID, scope: 'BRICKS', bricks: [] });
    await refused({ academicYearId: YEAR_ID, scope: 'BRICKS', bricks: [{ postId: 'x', minutes: 60, nth: 1 }] });
    await refused({ academicYearId: YEAR_ID, scope: 'BRICKS', bricks: [{ postId: POST_ID, minutes: 60, nth: 0 }] });
    expect(harness.tx['teachingRequirement']!['findMany']).not.toHaveBeenCalled();
  });

  it('refuses a Ta in that is not a proposal as it was read: the basis, the keys, the times, a brick named twice', async () => {
    const as = { 'x-test-user': asUser({}) };
    const refused = async (body: unknown) => {
      await apply(body).set(as).expect(400);
    };
    await refused({});
    await refused({ academicYearId: YEAR_ID, items: [item] });
    await refused({ academicYearId: YEAR_ID, basis: 'short', items: [item] });
    await refused({ academicYearId: YEAR_ID, basis: BASIS, items: [] });
    await refused({ academicYearId: YEAR_ID, basis: BASIS, items: [{ ...item, key: 'not a key' }] });
    await refused({ academicYearId: YEAR_ID, basis: BASIS, items: [{ ...item, dayOfWeek: 6 }] });
    await refused({ academicYearId: YEAR_ID, basis: BASIS, items: [{ ...item, startTime: '25:00' }] });
    await refused({ academicYearId: YEAR_ID, basis: BASIS, items: [{ ...item, roomId: 'x' }] });
    await refused({ academicYearId: YEAR_ID, basis: BASIS, items: [item, item] });
    await refused({ academicYearId: YEAR_ID, basis: BASIS, items: [item], versionName: 'x'.repeat(81) });
  });
});
