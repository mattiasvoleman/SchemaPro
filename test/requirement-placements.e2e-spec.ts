import { Prisma } from '@prisma/client';
import request from 'supertest';
import { Role } from '../src/auth/enums/role.enum';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

/**
 * Förlagda poster over HTTP: the routes resolve (the static list beside the
 * `:id` routes), the DTO refuses what the dialog must not send, and what a
 * client acts on survives the exception filter, which forwards only a
 * problem's `code` and flat `params` — a unit spec reads the exception
 * itself and cannot see what the filter dropped.
 */

const YEAR_ID = '44444444-4444-4444-8444-444444444444';
const POST_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const GROUP_ID = '55555555-5555-4555-8555-555555555555';
const SUBJECT_ID = '99999999-9999-4999-8999-999999999999';
const ROOM_ID = '66666666-6666-4666-8666-666666666666';
const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';

const wallClock = (time: string): Date => new Date(`1970-01-01T${time}:00.000Z`);

const POST = {
  id: POST_ID,
  schoolId: SCHOOL_ID,
  academicYearId: YEAR_ID,
  studentGroupId: GROUP_ID,
  subjectId: SUBJECT_ID,
  teacherId: null,
  coTeacherId: null,
  lessonsPerWeek: 1,
  minutesPerLesson: 60,
  lessonLengths: [],
  recurrence: 'ALL_WEEKS',
  blockId: null,
  startDate: null,
  endDate: null,
  shares: [],
  academicYear: { isActive: true, predecessorId: null, gradeNumbering: 'NIOARIG' },
};

const row = (over: Record<string, unknown> = {}) => ({
  id: '77777777-7777-4777-8777-777777777777',
  requirementId: POST_ID,
  dayOfWeek: 2,
  startTime: wallClock('10:00'),
  minutes: 60,
  roomId: ROOM_ID,
  recurrence: 'ALL_WEEKS',
  teacherId: null,
  room: { name: 'Simhallen' },
  updatedAt: new Date('2026-11-13T08:00:00.000Z'),
  ...over,
});

const body = (over: Record<string, unknown> = {}) => ({
  dayOfWeek: 2,
  startTime: '10:00',
  minutes: 60,
  roomId: ROOM_ID,
  recurrence: 'ALL_WEEKS',
  ...over,
});

describe('Förlagda poster (e2e)', () => {
  let harness: TestHarness;
  const http = () => harness.app.getHttpServer();
  const admin = () => asUser({});
  const placements = () => harness.tx['teachingRequirementPlacement']!;

  /** The kept lessons the judge reads by weekday and the post's locks it reads by class and subject. */
  const givenKept = (kept: Array<Record<string, unknown>>): void => {
    harness.tx['masterLesson']!['findMany']!.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      kept.filter(
        (lesson) =>
          (where['studentGroupId'] === undefined || lesson['studentGroupId'] === where['studentGroupId']) &&
          (where['dayOfWeek'] === undefined || (where['dayOfWeek'] as { in: number[] }).in.includes(lesson['dayOfWeek'] as number)),
      ),
    );
  };

  beforeAll(async () => {
    harness = await createTestApp();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    harness.tx['teachingRequirement']!['findUnique']!.mockResolvedValue(POST);
    harness.tx['room']!['findMany']!.mockResolvedValue([{ id: ROOM_ID }]);
    givenKept([]);
    // The year's list and the post's own rows; the year's other posts' have none.
    placements()['findMany']!.mockImplementation(async ({ where }: { where: { requirementId?: unknown } }) =>
      where.requirementId === undefined || where.requirementId === POST_ID ? [row()] : [],
    );
    placements()['deleteMany']!.mockResolvedValue({ count: 1 });
    placements()['createMany']!.mockResolvedValue({ count: 1 });
  });

  describe('reading', () => {
    it('lists the year\'s rows on the static route, which the `:id` routes do not swallow', async () => {
      const response = await request(http()).get(`/api/v1/teaching-requirements/placements?academicYearId=${YEAR_ID}`).set('x-test-user', admin()).expect(200);
      expect(response.body).toEqual([
        {
          id: '77777777-7777-4777-8777-777777777777',
          requirementId: POST_ID,
          dayOfWeek: 2,
          startTime: '10:00',
          endTime: '11:00',
          minutes: 60,
          roomId: ROOM_ID,
          roomName: 'Simhallen',
          recurrence: 'ALL_WEEKS',
          teacherId: null,
        },
      ]);
    });

    it('refuses a year that is no uuid', async () => {
      await request(http()).get('/api/v1/teaching-requirements/placements?academicYearId=x').set('x-test-user', admin()).expect(400);
    });

    it('lists one post\'s rows, each judged now', async () => {
      const response = await request(http()).get(`/api/v1/teaching-requirements/${POST_ID}/placements`).set('x-test-user', admin()).expect(200);
      expect(response.body.placements).toHaveLength(1);
      expect(response.body.verdicts).toEqual([{ index: 0, ok: true }]);
    });

    it('answers 404 for a post the caller cannot see', async () => {
      harness.tx['teachingRequirement']!['findUnique']!.mockResolvedValue(null);
      await request(http()).get(`/api/v1/teaching-requirements/${POST_ID}/placements`).set('x-test-user', admin()).expect(404);
    });

    describe('the year\'s week of förläggningar', () => {
      const board = (year = YEAR_ID) => request(http()).get(`/api/v1/teaching-requirements/placements/board?academicYearId=${year}`);
      const KEPT = {
        id: 'k-1',
        dayOfWeek: 3,
        teacherId: '88888888-8888-4888-8888-888888888888',
        coTeacherId: null,
        roomId: null,
        studentGroupId: GROUP_ID,
        subjectId: SUBJECT_ID,
        startTime: wallClock('13:00'),
        endTime: wallClock('14:00'),
        recurrence: 'ALL_WEEKS',
        startDate: null,
        endDate: null,
        isLocked: true,
        isGenerated: false,
        subject: { name: 'Idrott' },
        studentGroup: { name: '7A' },
        extraGroups: [],
        participants: [{ studentId: 'a-pupil' }],
      };

      beforeEach(() => {
        harness.tx['academicYear']!['findUnique']!.mockResolvedValue({ isActive: true, predecessorId: null, gradeNumbering: 'NIOARIG' });
        const { academicYear: _year, ...post } = POST;
        harness.tx['teachingRequirement']!['findMany']!.mockResolvedValue([post]);
        harness.tx['lunchSitting']!['findMany']!.mockResolvedValue([]);
        givenKept([KEPT]);
      });

      // Mocks outlive a test: what the week read must not stand in for what the rest of the file reads.
      afterEach(() => {
        harness.tx['academicYear']!['findUnique']!.mockReset();
        harness.tx['teachingRequirement']!['findMany']!.mockResolvedValue([]);
        harness.tx['lunchSitting']!['findMany']!.mockResolvedValue([]);
      });

      it('is answered on its own route, with the rows judged, the post counted and what the rows are held against', async () => {
        const response = await board().set('x-test-user', admin()).expect(200);
        expect(Object.keys(response.body).sort()).toEqual(['academicYearId', 'kept', 'meals', 'placements', 'posts']);
        expect(response.body.placements).toEqual([
          // The lock already answers the post's one lesson, so the row is over the demand: the judge says so, and
          // the count agrees (the row places nothing).
          expect.objectContaining({
            id: '77777777-7777-4777-8777-777777777777',
            roomName: 'Simhallen',
            verdict: { ok: false, reason: 'OVER_DEMAND' },
            changedAt: '2026-11-13T08:00:00.000Z',
          }),
        ]);
        // One lesson a week: the kept lesson of its class and subject answers it, so the post has none left.
        expect(response.body.posts).toEqual([
          expect.objectContaining({ id: POST_ID, cannotPlace: null, parts: [expect.objectContaining({ count: 1, locked: 1, placed: 0, left: 0 })] }),
        ]);
        expect(response.body.kept).toEqual([expect.objectContaining({ id: 'k-1', startTime: '13:00', locked: true })]);
        // A kept lesson says its class and subject by id and no pupil at all.
        expect(JSON.stringify(response.body)).not.toContain('a-pupil');
      });

      it('refuses a year that is no uuid, and answers 404 for one the caller cannot see', async () => {
        await board('x').set('x-test-user', admin()).expect(400);
        harness.tx['academicYear']!['findUnique']!.mockResolvedValue(null);
        await board().set('x-test-user', admin()).expect(404);
      });

      it('is every administrator\'s to read and no teacher\'s', async () => {
        await board().set('x-test-user', asUser({ adminProfile: 'LASARE' as never })).expect(200);
        await board().set('x-test-user', asUser({ role: Role.TEACHER })).expect(403);
      });
    });

    it('is every administrator\'s to read, and no teacher\'s', async () => {
      await request(http())
        .get(`/api/v1/teaching-requirements/${POST_ID}/placements`)
        .set('x-test-user', asUser({ adminProfile: 'LASARE' as never }))
        .expect(200);
      await request(http())
        .get(`/api/v1/teaching-requirements/${POST_ID}/placements`)
        .set('x-test-user', asUser({ role: Role.TEACHER }))
        .expect(403);
    });
  });

  describe('replacing', () => {
    const put = (payload: unknown, user = admin()) =>
      request(http()).put(`/api/v1/teaching-requirements/${POST_ID}/placements`).set('x-test-user', user).send(payload as object);

    it('saves the rows and answers them with a verdict each', async () => {
      const response = await put({ placements: [body()] }).expect(200);
      expect(response.body.placements).toHaveLength(1);
      expect(response.body.verdicts).toEqual([{ index: 0, ok: true }]);
      expect(placements()['deleteMany']).toHaveBeenCalledWith({ where: { requirementId: POST_ID } });
      const data = (placements()['createMany']!.mock.calls[0]![0] as { data: Array<{ schoolId: string }> }).data;
      expect(data[0]!.schoolId).toBe(SCHOOL_ID);
    });

    it('removes every row on an empty list', async () => {
      placements()['findMany']!.mockResolvedValue([]);
      const response = await put({ placements: [] }).expect(200);
      expect(response.body).toEqual({ placements: [], verdicts: [] });
      expect(placements()['createMany']).not.toHaveBeenCalled();
    });

    it('refuses what the DTO does not allow, writing nothing', async () => {
      await put({ placements: [body({ dayOfWeek: 6 })] }).expect(400);
      await put({ placements: [body({ startTime: '9:00' })] }).expect(400);
      await put({ placements: 'x' }).expect(400);
      await put({}).expect(400);
      expect(placements()['deleteMany']).not.toHaveBeenCalled();
    });

    it('answers a row that does not fit the post with the code and the rule in params, which the filter forwards', async () => {
      const response = await put({ placements: [body({ minutes: 45 })] }).expect(409);
      expect(response.body.code).toBe('REQUIREMENT_PLACEMENTS_DO_NOT_FIT');
      expect(response.body.params).toEqual({ reason: 'LENGTH' });
      expect(placements()['createMany']).not.toHaveBeenCalled();
    });

    it('answers a row the week does not hold with its index, the reason and the other lesson, flat, and no person', async () => {
      givenKept([
        {
          id: 'k-1',
          dayOfWeek: 2,
          teacherId: '88888888-8888-4888-8888-888888888888',
          coTeacherId: null,
          roomId: ROOM_ID,
          studentGroupId: '12121212-1212-4121-8121-121212121212',
          subjectId: 'sub-ma',
          startTime: wallClock('10:30'),
          endTime: wallClock('11:30'),
          recurrence: 'ALL_WEEKS',
          startDate: null,
          endDate: null,
          subject: { name: 'Matematik' },
          studentGroup: { name: '7B' },
          extraGroups: [],
          participants: [],
        },
      ]);

      const response = await put({ placements: [body()] }).expect(409);

      expect(response.body.code).toBe('REQUIREMENT_PLACEMENT_REFUSED');
      expect(response.body.params).toEqual({
        index: 0,
        reason: 'ROOM',
        otherKind: 'LESSON',
        className: '7B',
        subjectName: 'Matematik',
        day: 2,
        start: '10:30',
        end: '11:30',
      });
      expect(JSON.stringify(response.body)).not.toContain('88888888-8888');
      expect(placements()['deleteMany']).not.toHaveBeenCalled();
    });

    it('answers the trigger\'s FP409, which no pre-check foresaw, as the same 409 and not a 500', async () => {
      placements()['createMany']!.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Database error', {
          code: 'P2039',
          clientVersion: Prisma.prismaVersion.client,
          meta: {
            driverAdapterError: {
              cause: { originalCode: 'FP409', originalMessage: 'COUNT: fler lektioner', detail: `requirementId=${POST_ID} reason=COUNT` },
            },
          },
        }),
      );
      const response = await put({ placements: [body()] }).expect(409);
      expect(response.body.code).toBe('REQUIREMENT_PLACEMENTS_DO_NOT_FIT');
      // The post the trigger's DETAIL names, flat (review of #298, LÅG-8).
      expect(response.body.params).toEqual({ reason: 'COUNT', requirementId: POST_ID });
    });

    describe('on a post with delade lektioner', () => {
      const BO = '55555555-5555-4555-8555-555555555555';
      beforeEach(() => {
        harness.tx['teachingRequirement']!['findUnique']!.mockResolvedValue({
          ...POST,
          lessonsPerWeek: 3,
          shares: [{ teacherId: BO, lessons: 1, minutes: 60 }],
        });
      });

      it('saves a row with its teacher', async () => {
        await put({ placements: [body({ teacherId: BO })] }).expect(200);
        const data = (placements()['createMany']!.mock.calls[0]![0] as { data: Array<{ teacherId: string }> }).data;
        expect(data[0]!.teacherId).toBe(BO);
      });

      it('answers a row that names nobody with NO_TEACHER and the row’s index, flat in params, and writes nothing', async () => {
        const response = await put({ placements: [body({ teacherId: BO }), body({ dayOfWeek: 4 })] }).expect(409);
        expect(response.body.code).toBe('REQUIREMENT_PLACEMENTS_DO_NOT_FIT');
        expect(response.body.params).toEqual({ reason: 'NO_TEACHER', index: 1 });
        expect(placements()['deleteMany']).not.toHaveBeenCalled();
      });

      it('answers more of Bo’s lessons than Bo has with TEACHER_COUNT at the row, and names no person', async () => {
        const response = await put({ placements: [body({ teacherId: BO }), body({ dayOfWeek: 4, teacherId: BO })] }).expect(409);
        expect(response.body.params).toEqual({ reason: 'TEACHER_COUNT', index: 1 });
        expect(JSON.stringify(response.body)).not.toContain(BO);
      });

      it('refuses a teacher that is no uuid', async () => {
        await put({ placements: [body({ teacherId: 'bo' })] }).expect(400);
      });
    });

    it('is Planering\'s write: not a teacher\'s, not a reader\'s', async () => {
      await put({ placements: [body()] }, asUser({ role: Role.TEACHER })).expect(403);
      await put({ placements: [body()] }, asUser({ adminProfile: 'LASARE' as never })).expect(403);
      expect(placements()['deleteMany']).not.toHaveBeenCalled();
    });
  });
});
