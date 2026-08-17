import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import type { HttpService } from '@nestjs/axios';
import type { ConfigService } from '@nestjs/config';
import { AxiosError } from 'axios';
import { of, throwError, timer } from 'rxjs';
import { mergeMap } from 'rxjs/operators';
import type { PrismaClient } from '@prisma/client';
import {
  createPrismaMock,
  createTxMock,
  testUser,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import type {
  AiEngineScheduleRequest,
  AiEngineScheduleResponse,
} from './interfaces/ai-engine-payload.interface';
import { OptimizationProxyService } from './optimization-proxy.service';

const ACADEMIC_YEAR = '44444444-4444-4444-8444-444444444444';

const makeConfigService = () =>
  ({
    getOrThrow: jest.fn().mockReturnValue({
      baseUrl: 'http://solver.test',
      apiKey: 'k'.repeat(32),
      timeoutMs: 50,
    }),
  }) as unknown as ConfigService;

describe('OptimizationProxyService', () => {
  let service: OptimizationProxyService;
  let tx: TxMock;
  let http: { post: jest.Mock };

  beforeEach(() => {
    tx = createTxMock();
    http = { post: jest.fn() };

    service = new OptimizationProxyService(
      {} as unknown as PrismaService,
      http as unknown as HttpService,
      makeConfigService(),
    );
  });

  /**
   * `persistMasterLessons` is private, and reaching it through
   * `triggerScheduling` would mean mocking the entire fetch-and-anonymize
   * pipeline. It is exercised directly because what it guards is the most
   * destructive path in the codebase: a delete-and-recreate of a school's
   * timetable. Testing it through six layers of setup would obscure that.
   */
  const persist = (response: Partial<AiEngineScheduleResponse>, user = testUser()) =>
    (
      service as unknown as {
        persistMasterLessons: (
          tx: PrismaClient,
          academicYearId: string,
          user: unknown,
          response: AiEngineScheduleResponse,
          requirementAnonMap: Map<string, string>,
          roomAnonMap: Map<string, string>,
        ) => Promise<void>;
      }
    ).persistMasterLessons(
      tx as unknown as PrismaClient,
      ACADEMIC_YEAR,
      user,
      { status: 'FEASIBLE', lessons: [], ...response } as AiEngineScheduleResponse,
      new Map(),
      new Map(),
    );

  describe('persistMasterLessons — destructive-path guards', () => {
    it.each(['INFEASIBLE', 'TIMEOUT'])(
      'writes nothing and deletes nothing when the solver returns %s',
      async (status) => {
        await persist({ status: status as AiEngineScheduleResponse['status'] });

        // The regression this guards: a run that produced no lessons must not
        // wipe the school's existing unlocked timetable on its way out.
        expect(tx.masterLesson.deleteMany).not.toHaveBeenCalled();
        expect(tx.masterLesson.createMany).not.toHaveBeenCalled();
        expect(tx.masterLesson.create).not.toHaveBeenCalled();
      },
    );

    it('refuses to persist when the principal carries no tenant', async () => {
      await expect(
        persist({ status: 'FEASIBLE' }, testUser({ schoolId: undefined })),
      ).rejects.toThrow('schoolId missing from JWT');

      expect(tx.masterLesson.deleteMany).not.toHaveBeenCalled();
    });

    it('checks the tenant before deleting anything', async () => {
      // Ordering matters: the schoolId guard sits after the status check but
      // before deleteMany, so a tokenless request cannot destroy data either.
      tx.teachingRequirement.findMany.mockResolvedValue([]);

      await expect(
        persist({ status: 'OPTIMAL' }, testUser({ schoolId: undefined })),
      ).rejects.toThrow();
      expect(tx.masterLesson.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('persistMasterLessons — non-destructive regeneration', () => {
    beforeEach(() => {
      tx.teachingRequirement.findMany.mockResolvedValue([]);
      tx.masterLesson.deleteMany.mockResolvedValue({ count: 3 });
      tx.masterLesson.count.mockResolvedValue(2);
    });

    it('preserves locked lessons and manual multi-class constructs', async () => {
      await persist({ status: 'FEASIBLE', lessons: [] });

      const preserved = {
        OR: [
          { isLocked: true },
          { extraGroups: { some: {} } },
          { participants: { some: {} } },
        ],
      };
      // Machine-owned lessons are replaced; anything a human locked or built
      // by hand is excluded from the delete.
      expect(tx.masterLesson.deleteMany).toHaveBeenCalledWith({
        where: { academicYearId: ACADEMIC_YEAR, NOT: preserved },
      });
      expect(tx.masterLesson.count).toHaveBeenCalledWith({
        where: { academicYearId: ACADEMIC_YEAR, ...preserved },
      });
    });

    it('scopes the delete to the requested academic year only', async () => {
      await persist({ status: 'FEASIBLE', lessons: [] });

      const call = tx.masterLesson.deleteMany.mock.calls[0]![0] as {
        where: { academicYearId: string };
      };
      expect(call.where.academicYearId).toBe(ACADEMIC_YEAR);
    });
  });

  describe('callAiEngine — failure mapping', () => {
    const call = (payload = {}) =>
      (
        service as unknown as {
          callAiEngine: (p: unknown) => Promise<AiEngineScheduleResponse>;
        }
      ).callAiEngine(payload);

    it('returns the engine payload on success', async () => {
      http.post.mockReturnValue(
        of({ data: { status: 'OPTIMAL', lessons: [] } }),
      );

      await expect(call()).resolves.toEqual({ status: 'OPTIMAL', lessons: [] });
    });

    it('maps a slow engine to 503 rather than hanging the request', async () => {
      // Emits after the configured 50ms timeout, so the timeout operator wins.
      http.post.mockReturnValue(timer(500).pipe(mergeMap(() => of({ data: {} }))));

      await expect(call()).rejects.toThrow(ServiceUnavailableException);
      await expect(call()).rejects.toThrow('did not respond in time');
    });

    it('propagates the engine status code on an HTTP error', async () => {
      const axiosError = new AxiosError('boom');
      axiosError.response = { status: 422 } as never;
      http.post.mockReturnValue(throwError(() => axiosError));

      await expect(call()).rejects.toThrow(HttpException);
      await expect(call()).rejects.toMatchObject({ status: 422 });
    });

    it('falls back to 502 when the engine error carries no status', async () => {
      http.post.mockReturnValue(throwError(() => new AxiosError('no response')));

      await expect(call()).rejects.toMatchObject({ status: 502 });
    });

    it('maps an unrecognised transport failure to 503', async () => {
      http.post.mockReturnValue(throwError(() => new Error('socket closed')));

      await expect(call()).rejects.toThrow(ServiceUnavailableException);
    });

    it('never leaks the API key in the thrown error', async () => {
      http.post.mockReturnValue(throwError(() => new Error('kkkk')));

      await expect(call()).rejects.not.toThrow(/k{32}/);
    });
  });

  describe('triggerScheduling — PII-stripping pipeline', () => {
    const REQ_ID = '11111111-aaaa-4aaa-8aaa-111111111111';
    const SUBJECT_ID = '22222222-aaaa-4aaa-8aaa-222222222222';
    const GROUP_ID = '33333333-aaaa-4aaa-8aaa-333333333333';
    const TEACHER_ID = '44444444-aaaa-4aaa-8aaa-444444444444';
    const ROOM_ID = '55555555-aaaa-4aaa-8aaa-555555555555';
    const EXTRA_GROUP_ID = '66666666-aaaa-4aaa-8aaa-666666666666';

    const eightAm = new Date('1970-01-01T08:00:00.000Z');
    const nineAm = new Date('1970-01-01T09:00:00.000Z');

    let prisma: PrismaMock;

    beforeEach(() => {
      prisma = createPrismaMock(tx);
      service = new OptimizationProxyService(
        prisma as unknown as PrismaService,
        http as unknown as HttpService,
        makeConfigService(),
      );
    });

    const requirement = (overrides: Record<string, unknown> = {}) => ({
      id: REQ_ID,
      subjectId: SUBJECT_ID,
      studentGroupId: GROUP_ID,
      teacherId: TEACHER_ID,
      coTeacherId: null,
      lessonsPerWeek: 3,
      minutesPerLesson: 60,
      subject: { requiredRoomType: 'LABORATORY' },
      ...overrides,
    });

    const lockedLesson = (overrides: Record<string, unknown> = {}) => ({
      id: 'locked-1',
      subjectId: SUBJECT_ID,
      studentGroupId: GROUP_ID,
      teacherId: TEACHER_ID,
      coTeacherId: null,
      roomId: ROOM_ID,
      dayOfWeek: 2,
      startTime: eightAm,
      endTime: nineAm,
      extraGroups: [],
      ...overrides,
    });

    const constraintRow = (overrides: Record<string, unknown> = {}) => ({
      id: 'constraint-real-id',
      resourceType: 'TEACHER',
      userId: null,
      roomId: null,
      studentGroupId: null,
      dayOfWeek: 1,
      date: null,
      startTime: eightAm,
      endTime: nineAm,
      type: 'UNAVAILABLE',
      ...overrides,
    });

    type Arrangement = {
      requirements?: unknown[];
      /** Rows of { id, studentGroupId }: students whose HOME class is the group. */
      homeMembers?: unknown[];
      /** Rows of { studentId, studentGroupId }: teaching-group memberships. */
      teachingMembers?: unknown[];
      lockedLessons?: unknown[];
      unlockedLessons?: unknown[];
      rooms?: unknown[];
      constraints?: unknown[];
    };

    const arrange = (overrides: Arrangement = {}) => {
      tx.teachingRequirement.findMany.mockResolvedValue(
        overrides.requirements ?? [requirement()],
      );
      // Group sizes and the group-conflict relation both derive from the two
      // membership queries: home-class students and teaching-group rows.
      tx.user.findMany.mockResolvedValue(
        overrides.homeMembers ??
          Array.from({ length: 24 }, (_, i) => ({
            id: `00000000-0000-4000-8000-9000000000${String(i).padStart(2, '0')}`,
            studentGroupId: GROUP_ID,
          })),
      );
      tx.studentGroupMember.findMany.mockResolvedValue(
        overrides.teachingMembers ?? [],
      );
      const locked = overrides.lockedLessons ?? [];
      const unlocked = overrides.unlockedLessons ?? [];
      // fetchAndAnonymize queries masterLesson twice: the locked/manual set
      // (where.OR) and the previous unlocked placements (where.isLocked=false).
      tx.masterLesson.findMany.mockImplementation(({ where }: any) =>
        Promise.resolve(where?.isLocked === false ? unlocked : locked),
      );
      tx.room.findMany.mockResolvedValue(
        overrides.rooms ?? [{ id: ROOM_ID, capacity: 30, type: 'CLASSROOM' }],
      );
      tx.availabilityConstraint.findMany.mockResolvedValue(
        overrides.constraints ?? [],
      );
      tx.masterLesson.deleteMany.mockResolvedValue({ count: 2 });
      tx.masterLesson.count.mockResolvedValue(1);
      tx.masterLesson.create.mockResolvedValue({});
      tx.scheduleChangeLog.create.mockResolvedValue({});
    };

    /** Engine echo: places every forwarded requirement in the first room. */
    const echoEngine = (
      status: AiEngineScheduleResponse['status'] = 'OPTIMAL',
    ) => {
      http.post.mockImplementation((_url: string, payload: any) =>
        of({
          data: {
            requestId: payload.requestId,
            status,
            lessons: payload.requirements.map((r: any) => ({
              requirementId: r.id,
              roomId: payload.rooms[0]?.id ?? null,
              dayOfWeek: 1,
              startTime: '08:00:00',
              endTime: '09:15:00',
            })),
            conflicts: null,
          },
        }),
      );
    };

    const postedPayload = (): AiEngineScheduleRequest =>
      http.post.mock.calls[0][1] as AiEngineScheduleRequest;

    it('forwards no real database id — every resource is re-keyed anonymously', async () => {
      arrange({
        lockedLessons: [lockedLesson()],
        constraints: [
          constraintRow({ userId: TEACHER_ID, resourceType: 'TEACHER' }),
        ],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      const serialized = JSON.stringify(postedPayload());
      for (const realId of [
        REQ_ID,
        SUBJECT_ID,
        GROUP_ID,
        TEACHER_ID,
        ROOM_ID,
        'constraint-real-id',
        'locked-1',
      ]) {
        expect(serialized).not.toContain(realId);
      }
    });

    it('keeps the non-PII scheduling facts on the anonymized requirement', async () => {
      arrange();
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(postedPayload().requirements[0]).toMatchObject({
        lessonsPerWeek: 3,
        minutesPerLesson: 60,
        studentGroupSize: 24,
        requiredRoomType: 'LABORATORY',
        coTeacherId: null,
      });
    });

    it('maps each real resource to one stable anonymous id across the payload', async () => {
      arrange({
        lockedLessons: [lockedLesson()],
        constraints: [
          constraintRow({ userId: TEACHER_ID, resourceType: 'TEACHER' }),
          constraintRow({ roomId: ROOM_ID, resourceType: 'ROOM' }),
        ],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());
      const payload = postedPayload();
      const [req] = payload.requirements;
      const [fixed] = payload.fixedLessons;
      const [room] = payload.rooms;
      const [teacherConstraint, roomConstraint] = payload.constraints;

      // The engine can only respect "same teacher / same room" collisions if
      // one real id always maps to the same anonymous id within a request.
      expect(fixed.teacherId).toBe(req.teacherId);
      expect(fixed.studentGroupId).toBe(req.studentGroupId);
      expect(fixed.roomId).toBe(room.id);
      expect(teacherConstraint.resourceId).toBe(req.teacherId);
      expect(roomConstraint.resourceId).toBe(room.id);
    });

    it('subtracts locked lessons from the weekly demand sent to the engine', async () => {
      arrange({ lockedLessons: [lockedLesson()] });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(postedPayload().requirements[0].lessonsPerWeek).toBe(2);
    });

    it('skips the engine when locked lessons already cover all demand', async () => {
      arrange({
        requirements: [requirement({ lessonsPerWeek: 1 })],
        lockedLessons: [lockedLesson()],
      });

      const result = await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(http.post).not.toHaveBeenCalled();
      expect(result).toMatchObject({ status: 'FEASIBLE', lessons: [] });
      // The persist phase still runs so stale unlocked leftovers are removed.
      expect(tx.masterLesson.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ academicYearId: ACADEMIC_YEAR }),
        }),
      );
    });

    it('forwards locked lessons as fixed placements with HH:MM:SS times', async () => {
      arrange({
        lockedLessons: [
          lockedLesson({ extraGroups: [{ studentGroupId: EXTRA_GROUP_ID }] }),
        ],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());
      const [fixed] = postedPayload().fixedLessons;

      expect(fixed).toMatchObject({
        dayOfWeek: 2,
        startTime: '08:00:00',
        endTime: '09:00:00',
      });
      expect(fixed.extraGroupIds).toHaveLength(1);
      expect(fixed.extraGroupIds).not.toContain(EXTRA_GROUP_ID); // anonymized
    });

    it('forwards previous unlocked slots for minimal disruption, dropping orphans', async () => {
      arrange({
        unlockedLessons: [
          {
            subjectId: SUBJECT_ID,
            studentGroupId: GROUP_ID,
            dayOfWeek: 4,
            startTime: eightAm,
          },
          {
            // No requirement exists for this subject — must be skipped.
            subjectId: 'retired-subject',
            studentGroupId: GROUP_ID,
            dayOfWeek: 5,
            startTime: nineAm,
          },
        ],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());
      const payload = postedPayload();

      expect(payload.previousLessons).toEqual([
        {
          requirementId: payload.requirements[0].id,
          dayOfWeek: 4,
          startTime: '08:00:00',
        },
      ]);
    });

    it('forwards weights and rules only when the caller supplied them', async () => {
      arrange();
      echoEngine();

      await service.triggerScheduling(
        ACADEMIC_YEAR,
        testUser(),
        { spread: 7 },
        { lunchMinutes: 30 },
      );
      expect(postedPayload()).toMatchObject({
        weights: { spread: 7 },
        rules: { lunchMinutes: 30 },
      });

      http.post.mockClear();
      await service.triggerScheduling(ACADEMIC_YEAR, testUser(), null, null);
      expect(postedPayload()).not.toHaveProperty('weights');
      expect(postedPayload()).not.toHaveProperty('rules');
    });

    it('authenticates to the engine with the service key at the configured URL', async () => {
      arrange();
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(http.post).toHaveBeenCalledWith(
        'http://solver.test/v1/schedule',
        expect.anything(),
        expect.objectContaining({
          headers: expect.objectContaining({ 'X-API-Key': 'k'.repeat(32) }),
        }),
      );
    });

    it('translates the anonymous solution back to real ids before persisting', async () => {
      arrange();
      echoEngine('OPTIMAL');

      await service.triggerScheduling(
        ACADEMIC_YEAR,
        testUser({ schoolId: 'school-A' }),
      );

      expect(tx.masterLesson.create).toHaveBeenCalledTimes(1);
      expect(tx.masterLesson.create).toHaveBeenCalledWith({
        data: {
          schoolId: 'school-A',
          academicYearId: ACADEMIC_YEAR,
          subjectId: SUBJECT_ID,
          studentGroupId: GROUP_ID,
          teacherId: TEACHER_ID,
          coTeacherId: null,
          roomId: ROOM_ID,
          dayOfWeek: 1,
          startTime: new Date('1970-01-01T08:00:00.000Z'),
          endTime: new Date('1970-01-01T09:15:00.000Z'),
        },
      });
    });

    it('drops solution lessons whose anonymous requirement is unknown', async () => {
      arrange();
      http.post.mockImplementation(() =>
        of({
          data: {
            requestId: 'r',
            status: 'FEASIBLE',
            lessons: [
              {
                requirementId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
                roomId: null,
                dayOfWeek: 1,
                startTime: '08:00:00',
                endTime: '09:00:00',
              },
            ],
            conflicts: null,
          },
        }),
      );

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(tx.masterLesson.create).not.toHaveBeenCalled();
      expect(tx.scheduleChangeLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            after: expect.objectContaining({ lessonsCreated: 0 }),
          }),
        }),
      );
    });

    it('appends a REGENERATE audit entry with the replacement counts', async () => {
      arrange();
      echoEngine('OPTIMAL');
      const user = testUser({ schoolId: 'school-A', userId: 'admin-1' });

      await service.triggerScheduling(ACADEMIC_YEAR, user);

      expect(tx.scheduleChangeLog.create).toHaveBeenCalledWith({
        data: {
          schoolId: 'school-A',
          academicYearId: ACADEMIC_YEAR,
          masterLessonId: null,
          actorId: 'admin-1',
          action: 'REGENERATE',
          after: {
            solverStatus: 'OPTIMAL',
            lessonsCreated: 1,
            unlockedReplaced: 2,
            lockedPreserved: 1,
          },
        },
      });
    });

    it('runs the fetch and persist phases under the caller RLS session', async () => {
      arrange();
      echoEngine();
      const user = testUser();

      await service.triggerScheduling(ACADEMIC_YEAR, user);

      expect(prisma.withRls).toHaveBeenCalledTimes(2);
      expect(prisma.withRls.mock.calls[0][0]).toBe(user);
      expect(prisma.withRls.mock.calls[1][0]).toBe(user);
    });

    it('defaults an empty group to size 1 rather than zero', async () => {
      arrange({ homeMembers: [], teachingMembers: [] });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(postedPayload().requirements[0].studentGroupSize).toBe(1);
    });

    it('derives group-conflict pairs from students shared across groups', async () => {
      // Two scheduled groups: home class 7A and teaching group Ma71. Student
      // S1 has 7A as home class AND a Ma71 membership -> exactly one pair.
      const CLASS_7A = GROUP_ID;
      const MA71 = '99999999-9999-4999-8999-999999999999';
      arrange({
        requirements: [
          requirement(),
          requirement({ id: '88888888-8888-4888-8888-888888888888', studentGroupId: MA71 }),
        ],
        homeMembers: [
          { id: 'aaaaaaa1-0000-4000-8000-000000000001', studentGroupId: CLASS_7A },
          { id: 'aaaaaaa2-0000-4000-8000-000000000002', studentGroupId: CLASS_7A },
        ],
        teachingMembers: [
          { studentId: 'aaaaaaa1-0000-4000-8000-000000000001', studentGroupId: MA71 },
        ],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      const payload = postedPayload();
      expect(payload.groupConflicts).toHaveLength(1);
      const [a, b] = payload.groupConflicts[0];
      // The pair uses the SAME anonymous ids as the requirements do…
      const anonGroups = payload.requirements.map((r) => r.studentGroupId);
      expect(anonGroups).toContain(a);
      expect(anonGroups).toContain(b);
      expect(a).not.toBe(b);
      // …and no real id leaks through the pair list.
      const serialized = JSON.stringify(payload.groupConflicts);
      expect(serialized).not.toContain(CLASS_7A);
      expect(serialized).not.toContain(MA71);
    });

    it('emits no pair for groups without shared students', async () => {
      const OTHER = '99999999-9999-4999-8999-999999999999';
      arrange({
        requirements: [
          requirement(),
          requirement({ id: '88888888-8888-4888-8888-888888888888', studentGroupId: OTHER }),
        ],
        homeMembers: [
          { id: 'aaaaaaa1-0000-4000-8000-000000000001', studentGroupId: GROUP_ID },
          { id: 'aaaaaaa2-0000-4000-8000-000000000002', studentGroupId: OTHER },
        ],
        teachingMembers: [],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(postedPayload().groupConflicts).toEqual([]);
    });

    it('counts a teaching group size as its distinct members, not zero', async () => {
      // Ma71 has no home-class members at all — its size must come from the
      // membership rows, and a student in both kinds must not count twice for
      // the home class either.
      const MA71 = '99999999-9999-4999-8999-999999999999';
      arrange({
        requirements: [
          requirement({ studentGroupId: MA71 }),
        ],
        homeMembers: [],
        teachingMembers: [
          { studentId: 'aaaaaaa1-0000-4000-8000-000000000001', studentGroupId: MA71 },
          { studentId: 'aaaaaaa2-0000-4000-8000-000000000002', studentGroupId: MA71 },
          { studentId: 'aaaaaaa3-0000-4000-8000-000000000003', studentGroupId: MA71 },
        ],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());

      expect(postedPayload().requirements[0].studentGroupSize).toBe(3);
    });

    it('formats date-bound constraints as YYYY-MM-DD and anonymizes unlinked ones', async () => {
      arrange({
        constraints: [
          constraintRow({ date: new Date('2026-12-24T00:00:00.000Z') }),
        ],
      });
      echoEngine();

      await service.triggerScheduling(ACADEMIC_YEAR, testUser());
      const [constraint] = postedPayload().constraints;

      expect(constraint).toMatchObject({
        date: '2026-12-24',
        startTime: '08:00:00',
        endTime: '09:00:00',
        kind: 'UNAVAILABLE',
      });
      expect(constraint.id).not.toBe('constraint-real-id');
      // No linked user/room/group: the resource still gets a fresh UUID.
      expect(constraint.resourceId).toMatch(/^[0-9a-f-]{36}$/);
    });
  });
});
