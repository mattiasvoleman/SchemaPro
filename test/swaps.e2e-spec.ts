import request from 'supertest';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

/**
 * Byten och flyttar (G1) over HTTP: who may ask, what the door refuses before
 * the service, and that an administrator's request reaches both handlers. The
 * search and the write are the services' (src/swaps/*.spec.ts); a 403 row
 * stops at the guard and covers no handler, so each route also has an
 * administrator's round trip here.
 */

const YEAR_ID = '44444444-4444-4444-8444-444444444444';
const A = '55555555-5555-4555-8555-555555555555';
const B = '66666666-6666-4666-8666-666666666666';

const slot = (dayOfWeek: number) => ({ dayOfWeek, startTime: '08:00', endTime: '09:00' });
const move = (lessonId: string, from: number, to: number) => ({ lessonId, from: slot(from), to: slot(to) });

describe('Byten och flyttar (e2e)', () => {
  let harness: TestHarness;
  const http = () => harness.app.getHttpServer();
  const admin = () => asUser({});

  beforeAll(async () => {
    harness = await createTestApp();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/v1/swaps/suggest', () => {
    it('is the scheduler’s: a teacher and a signed-out caller are refused', async () => {
      await request(http()).post('/api/v1/swaps/suggest').send({ lessonId: A }).expect(401);
      await request(http())
        .post('/api/v1/swaps/suggest')
        .set('x-test-user', asUser({ role: 'TEACHER' as never }))
        .send({ lessonId: A })
        .expect(403);
    });

    it('refuses what is not a lesson id, and a limit outside 1-30, before the service', async () => {
      for (const body of [{}, { lessonId: 'nope' }, { lessonId: A, limit: 0 }, { lessonId: A, limit: 31 }, { lessonId: A, extra: 1 }]) {
        await request(http()).post('/api/v1/swaps/suggest').set('x-test-user', admin()).send(body).expect(400);
      }
      expect(harness.tx['masterLesson']!['findUnique']).not.toHaveBeenCalled();
    });

    it('answers 404 for a lesson that is not there', async () => {
      harness.tx['masterLesson']!['findUnique']!.mockResolvedValue(null);
      await request(http()).post('/api/v1/swaps/suggest').set('x-test-user', admin()).send({ lessonId: A }).expect(404);
    });

    it('reaches the handler for an administrator: a lesson on the tray has nothing to offer, and says why', async () => {
      harness.tx['masterLesson']!['findUnique']!.mockResolvedValue({ id: A, academicYearId: YEAR_ID, isParked: true });
      const response = await request(http()).post('/api/v1/swaps/suggest').set('x-test-user', admin()).send({ lessonId: A }).expect(200);
      expect(response.body).toMatchObject({ lessonId: A, academicYearId: YEAR_ID, proposals: [], immovable: 'PARKED' });
    });
  });

  describe('POST /api/v1/swaps/apply', () => {
    it('is the scheduler’s: a teacher and a signed-out caller are refused', async () => {
      const body = { lessonId: A, moves: [move(A, 1, 2), move(B, 2, 1)] };
      await request(http()).post('/api/v1/swaps/apply').send(body).expect(401);
      await request(http())
        .post('/api/v1/swaps/apply')
        .set('x-test-user', asUser({ role: 'TEACHER' as never }))
        .send(body)
        .expect(403);
    });

    it('refuses a move set that is not two or more well-formed moves, before the service', async () => {
      const bad = [
        {},
        { lessonId: A, moves: [] },
        { lessonId: A, moves: [move(A, 1, 2)] },
        { lessonId: A, moves: [move(A, 1, 2), { lessonId: B, from: slot(2), to: { dayOfWeek: 9, startTime: '08:00', endTime: '09:00' } }] },
        { lessonId: A, moves: [move(A, 1, 2), { lessonId: B, from: slot(2), to: { dayOfWeek: 1, startTime: '8:00', endTime: '09:00' } }] },
        { lessonId: A, moves: [move(A, 1, 2), move('nope', 2, 1)] },
        { lessonId: A, propagate: 'yes', moves: [move(A, 1, 2), move(B, 2, 1)] },
      ];
      for (const body of bad) {
        await request(http()).post('/api/v1/swaps/apply').set('x-test-user', admin()).send(body).expect(400);
      }
      expect(harness.tx['masterLesson']!['updateMany']).not.toHaveBeenCalled();
    });

    /*
     * parseTimeString wraps an hour past 23 into the next day, so "34:00" used
     * to be judged on minute 2040 and stored as 10:00: a teacher booked twice by
     * a request the clash rule had cleared. It is a 400 at the door now, with
     * nothing read or written.
     */
    it.each(['24:00', '25:00', '34:00', '12:60', '8:00'])('refuses the clock %s, as the new start, the new end and the old start: a 400, never a double booking', async (clock) => {
      harness.tx.$queryRaw.mockResolvedValue([{ mode: 'DIRECT' }]);
      const bodies = [
        { lessonId: A, moves: [{ lessonId: A, from: slot(1), to: { dayOfWeek: 2, startTime: clock, endTime: '09:00' } }, move(B, 2, 1)] },
        { lessonId: A, moves: [{ lessonId: A, from: slot(1), to: { dayOfWeek: 2, startTime: '08:00', endTime: clock } }, move(B, 2, 1)] },
        { lessonId: A, moves: [{ lessonId: A, from: { dayOfWeek: 1, startTime: clock, endTime: '09:00' }, to: slot(2) }, move(B, 2, 1)] },
      ];
      for (const body of bodies) {
        await request(http()).post('/api/v1/swaps/apply').set('x-test-user', admin()).send(body).expect(400);
      }
      expect(harness.tx['masterLesson']!['findMany']).not.toHaveBeenCalled();
      expect(harness.tx['masterLesson']!['updateMany']).not.toHaveBeenCalled();
    });

    it('reaches the handler for an administrator: a lesson named twice is the service’s 400', async () => {
      harness.tx.$queryRaw.mockResolvedValue([{ mode: 'DIRECT' }]);
      await request(http())
        .post('/api/v1/swaps/apply')
        .set('x-test-user', admin())
        .send({ lessonId: A, moves: [move(A, 1, 2), move(A, 2, 1)] })
        .expect(400);
    });

    it('answers SWAP_STALE when a lesson is not there to move, and writes nothing', async () => {
      harness.tx.$queryRaw.mockResolvedValue([{ mode: 'DIRECT' }]);
      harness.tx['masterLesson']!['findMany']!.mockResolvedValue([]);
      const response = await request(http())
        .post('/api/v1/swaps/apply')
        .set('x-test-user', admin())
        .send({ lessonId: A, moves: [move(A, 1, 2), move(B, 2, 1)] })
        .expect(409);
      expect(response.body).toMatchObject({ code: 'SWAP_STALE' });
      expect(harness.tx['masterLesson']!['updateMany']).not.toHaveBeenCalled();
    });
  });
});
