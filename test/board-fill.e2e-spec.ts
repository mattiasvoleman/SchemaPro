import request from 'supertest';
import { Role } from '../src/auth/enums/role.enum';
import { BoardTrayService } from '../src/board-tray/board-tray.service';
import { ScheduleVersionsService } from '../src/calendar/schedule-versions.service';
import { directReachUnanswered } from '../src/publication/direct-reach';
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
const GROUP_ID = '55555555-5555-4555-8555-555555555555';
const SUBJECT_ID = '99999999-9999-4999-8999-999999999999';
const TEACHER_ID = '88888888-8888-4888-8888-888888888888';
const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const ROOM_ID = '77777777-7777-4777-8777-777777777777';

/** A post as the tray reads it: `lessonsPerWeek` of an hour, taught by one teacher, so that each lesson is a brick that can be laid. */
const post = (over: Record<string, unknown> = {}) => ({
  id: POST_ID,
  studentGroupId: GROUP_ID,
  subjectId: SUBJECT_ID,
  teacherId: TEACHER_ID,
  coTeacherId: null,
  lessonsPerWeek: 2,
  minutesPerLesson: 60,
  lessonLengths: [],
  recurrence: 'ALL_WEEKS',
  blockId: null,
  startDate: null,
  endDate: null,
  minutesBefore: 0,
  minutesAfter: 0,
  shares: [],
  ...over,
});

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

  /*
   * Through the door (g517 L-6). The rows above stop at the guard, the pipe or a service that reads nothing; these let an administrator of each profile that writes the
   * schedule through to the service and out again, so that the answer's shape and the problem JSON's `code` and flat `params` are held over HTTP: a 403 row covers no
   * handler. The tray, the year and the world are the transaction mock's; the version and the write of a lesson are stubbed (the database probe, scripts/test/probe-lagg-det-som-gar.ts,
   * holds the real ones), so the rest of Ta in (the mode, the locks, the tray, the basis) runs as it does.
   */
  describe('through the door', () => {
    const as = (adminProfile: string) => ({ 'x-test-user': asUser({ adminProfile: adminProfile as never }) });
    const BRICK_KEY = `${POST_ID}|${TEACHER_ID}|60|1`;
    const spies: Array<{ mockRestore: () => void }> = [];

    beforeEach(() => {
      harness.tx['academicYear']!['findUnique']!.mockResolvedValue({ id: YEAR_ID, schoolId: SCHOOL_ID, gradeNumbering: 'NIOARIG', startDate: new Date('2026-08-01'), endDate: new Date('2027-06-30') });
      harness.tx['teachingRequirement']!['findMany']!.mockResolvedValue([post()]);
      harness.tx['teachingRequirementPlacement']!['findMany']!.mockResolvedValue([]);
      harness.tx['masterLesson']!['findMany']!.mockResolvedValue([]);
      harness.tx['teachingBlock']!['findMany']!.mockResolvedValue([]);
      harness.tx['masterLesson']!['aggregate']!.mockResolvedValue({ _count: { _all: 0 }, _max: { updatedAt: null } });
      harness.tx['teachingRequirement']!['aggregate']!.mockResolvedValue({ _count: { _all: 1 }, _max: { updatedAt: new Date('2026-10-01T10:00:00Z') } });
      // The world has no other school's holds (readSwapData reads them through a raw query, whose rows are the holds), and the mode is read by another.
      harness.tx.$queryRaw.mockResolvedValue([]);
    });

    afterEach(() => {
      while (spies.length > 0) spies.pop()!.mockRestore();
    });

    /** A basis the tray gives for these mocks: a proposal for a class that has no bricks asks nothing of the planner and names the grundschema it read. */
    const basisNow = async (): Promise<string> => {
      const asked = await propose({ academicYearId: YEAR_ID, scope: 'CLASS', studentGroupId: '66666666-6666-4666-8666-666666666666' }).set(as('FULL')).expect(200);
      return asked.body.basis as string;
    };

    it.each(['FULL', 'REKTOR', 'SCHEMALAGGARE'])('lets an administrator with the profile %s ask, and answers who answered and that nothing moved', async (profile) => {
      const response = await propose({ academicYearId: YEAR_ID, scope: 'CLASS', studentGroupId: '66666666-6666-4666-8666-666666666666' }).set(as(profile)).expect(200);
      expect(response.body).toMatchObject({ academicYearId: YEAR_ID, answeredBy: 'FILL', asked: 0, placed: [], left: [], moved: [], truncated: false });
      expect(response.body.basis).toMatch(/^[0-9a-f]{32}$/);
    });

    it.each(['FULL', 'REKTOR', 'SCHEMALAGGARE'])('lets an administrator with the profile %s take in, and answers the version and each lesson laid', async (profile) => {
      const tray = harness.app.get(BoardTrayService);
      const versions = harness.app.get(ScheduleVersionsService);
      const write = jest.spyOn(tray, 'writeBrick').mockResolvedValue({ lesson: { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', isLocked: true, warnings: [] }, noRoom: false } as never);
      const version = jest.spyOn(versions, 'snapshotInTransaction').mockResolvedValue({ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' } as never);
      spies.push(write, version);
      const response = await apply({ academicYearId: YEAR_ID, basis: await basisNow(), items: [{ key: BRICK_KEY, dayOfWeek: 2, startTime: '09:00', roomId: ROOM_ID }] }).set(as(profile)).expect(200);
      expect(response.body).toEqual({
        academicYearId: YEAR_ID,
        versionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        laid: [{ key: BRICK_KEY, lessonId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', created: true, noRoom: false }],
      });
      // The version is named for what it is, and is taken before the lesson is written.
      expect(version).toHaveBeenCalledWith(expect.anything(), YEAR_ID, 'Före påfyllning', expect.objectContaining({ role: 'SCHOOL_ADMIN' }));
      expect(version.mock.invocationCallOrder[0]!).toBeLessThan(write.mock.invocationCallOrder[0]!);
      // What was written is what the request said: the brick, the day and the clock as the pipe made them, and no exemption.
      // The room is the proposal's, passed on as it came (a request that names none is the "Utan sal" of the unit spec): a Ta in that dropped it would lay every lesson without a room.
      expect(write.mock.calls[0]![2]).toMatchObject({ academicYearId: YEAR_ID, postId: POST_ID, dayOfWeek: 2, startTime: '09:00', roomId: ROOM_ID });
    });

    // @Area('SCHEMALAGGNING', 'DRIFT') asks for every one of the areas (area.decorator.ts), as the board's tray and the hand edit do; the expedition writes Drift and Personal and
    // not Schemaläggning, and the database says the same of MasterLessons. Both routes name the area it lacks.
    it('refuses the expedition, who writes Drift and Personal and not Schemaläggning, on both routes, saying which area', async () => {
      const asked = await propose({ academicYearId: YEAR_ID, scope: 'SCHOOL' }).set(as('EXPEDITION')).expect(403);
      expect(asked.body).toMatchObject({ code: 'AREA_NOT_YOURS' });
      expect(asked.body.detail).toMatch(/schemaläggning/i);
      const taken = await apply({ academicYearId: YEAR_ID, basis: BASIS, items: [{ key: BRICK_KEY, dayOfWeek: 2, startTime: '09:00' }] }).set(as('EXPEDITION')).expect(403);
      expect(taken.body).toMatchObject({ code: 'AREA_NOT_YOURS' });
      expect(taken.body.detail).toMatch(/schemaläggning/i);
    });

    it('answers a question about more bricks than Ta in takes in with 400, the code, and the two figures flat', async () => {
      harness.tx['teachingRequirement']!['findMany']!.mockResolvedValue([post({ lessonsPerWeek: 601 })]);
      const response = await propose({ academicYearId: YEAR_ID, scope: 'SCHOOL' }).set(as('FULL')).expect(400);
      expect(response.body).toMatchObject({ status: 400, code: 'BOARD_FILL_TOO_MANY', params: { asked: 601, max: 600 } });
      expect(response.body.detail).toMatch(/601/);
    });

    it('answers a Ta in on another basis with 409 and the code alone: nothing to say but that it is old', async () => {
      const response = await apply({ academicYearId: YEAR_ID, basis: BASIS, items: [{ key: BRICK_KEY, dayOfWeek: 2, startTime: '09:00' }] }).set(as('SCHEMALAGGARE')).expect(409);
      expect(response.body).toMatchObject({ status: 409, code: 'BOARD_FILL_STALE' });
      expect(response.body).not.toHaveProperty('params');
    });

    it('lets the school\'s question in Direkt through as it is: 409, its code, and the two dates flat', async () => {
      const tray = harness.app.get(BoardTrayService);
      const versions = harness.app.get(ScheduleVersionsService);
      spies.push(
        jest.spyOn(versions, 'snapshotInTransaction').mockResolvedValue({ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' } as never),
        jest.spyOn(tray, 'writeBrick').mockRejectedValue(directReachUnanswered({ validFrom: '2026-08-17', validTo: '2026-12-18' })),
      );
      const response = await apply({ academicYearId: YEAR_ID, basis: await basisNow(), items: [{ key: BRICK_KEY, dayOfWeek: 2, startTime: '09:00' }] }).set(as('FULL')).expect(409);
      expect(response.body).toMatchObject({ code: 'DIRECT_REACH_UNANSWERED', params: { validFrom: '2026-08-17', validTo: '2026-12-18' } });
    });
  });
});
