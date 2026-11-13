import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import type { MasterLessonsService } from '../calendar/master-lessons.service';
import type { PrismaService } from '../database/prisma.service';
import { keptMastersWhere } from '../optimization/preserved-lessons';
import { lockYearForGrundschemaEdit } from '../optimization/regeneration-lock';
import { readOtherSchoolHolds } from '../optimization/other-school-holds';
import { readBoardFacts } from '../swaps/board-rules';
import { rostersOfYear } from '../year-rollover/projected-rosters';
import * as placementJudge from './placement-judge';
import { RequirementPlacementsService } from './requirement-placements.service';

jest.mock('../year-rollover/projected-rosters', () => ({ rostersOfYear: jest.fn() }));
jest.mock('../optimization/regeneration-lock', () => ({ lockYearForGrundschemaEdit: jest.fn() }));
jest.mock('../swaps/board-rules', () => ({ ...jest.requireActual('../swaps/board-rules'), readBoardFacts: jest.fn() }));
jest.mock('../optimization/other-school-holds', () => ({
  ...jest.requireActual('../optimization/other-school-holds'),
  readOtherSchoolHolds: jest.fn(),
}));

const SCHOOL = '33333333-3333-4333-8333-333333333333';
const YEAR = '99999999-9999-4999-8999-999999999999';
const REQ = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_REQ = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const GROUP = '66666666-6666-4666-8666-666666666666';
const SUBJECT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TEACHER = '44444444-4444-4444-8444-444444444444';
const ROOM_1 = '11111111-1111-4111-8111-111111111111';
const ROOM_2 = '22222222-2222-4222-8222-222222222222';
const BASIS = { kind: 'CURRENT' } as const;

const time = (value: string): Date => new Date(`1970-01-01T${value}:00.000Z`);

const POST = {
  id: REQ,
  schoolId: SCHOOL,
  academicYearId: YEAR,
  studentGroupId: GROUP,
  subjectId: SUBJECT,
  teacherId: TEACHER,
  coTeacherId: null,
  lessonsPerWeek: 2,
  minutesPerLesson: 60,
  lessonLengths: [] as number[],
  recurrence: 'ALL_WEEKS',
  blockId: null,
  startDate: null,
  endDate: null,
  shares: [] as { teacherId: string | null; lessons: number; minutes: number }[],
  academicYear: { isActive: true, predecessorId: null, gradeNumbering: 'NIOARIG' },
};

const stored = (over: Record<string, unknown> = {}) => ({
  id: 'p-1',
  requirementId: REQ,
  dayOfWeek: 2,
  startTime: time('10:00'),
  minutes: 60,
  roomId: ROOM_1,
  recurrence: 'ALL_WEEKS',
  teacherId: null as string | null,
  room: { name: 'Simhallen' },
  updatedAt: new Date('2026-11-13T08:00:00.000Z'),
  ...over,
});

const input = (over: Record<string, unknown> = {}) => ({
  dayOfWeek: 2,
  startTime: '10:00',
  minutes: 60,
  roomId: ROOM_1,
  recurrence: 'ALL_WEEKS' as const,
  ...over,
});

const fkError = (reason: string): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError('Database error', {
    code: 'P2039',
    clientVersion: Prisma.prismaVersion.client,
    meta: {
      driverAdapterError: {
        cause: {
          originalCode: 'FP409',
          originalMessage: `${reason}: udda och jämna veckor av samma längd måste förläggas i par`,
          detail: `requirementId=${REQ} reason=${reason}`,
        },
      },
    },
  });

interface World {
  post?: typeof POST | null;
  /** The post's own rows. */
  rows?: ReturnType<typeof stored>[];
  /** The year's other posts' rows. */
  beside?: unknown[];
  /** Lessons the next Generera keeps, for the post and for the judge's day read. */
  kept?: Array<Record<string, unknown>>;
  rooms?: string[];
}

function setup(world: World = {}) {
  const tx: TxMock = createTxMock();
  const prisma = createPrismaMock(tx) as unknown as PrismaService;
  const masters = { findConflicts: jest.fn().mockResolvedValue([]) };
  tx['teachingRequirement']!['findUnique']!.mockResolvedValue(world.post === undefined ? POST : world.post);
  tx['teachingRequirementPlacement']!['findMany']!.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    const requirementId = where['requirementId'];
    if (requirementId === REQ) return world.rows ?? [];
    if (typeof requirementId === 'object') return world.beside ?? [];
    return world.rows ?? []; // the year's list
  });
  // The judge reads the kept lessons of some weekdays; the post's locks are the kept lessons of its class and subject.
  tx['masterLesson']!['findMany']!.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
    (world.kept ?? []).filter(
      (lesson) =>
        (where['studentGroupId'] === undefined || lesson['studentGroupId'] === where['studentGroupId']) &&
        (where['subjectId'] === undefined || lesson['subjectId'] === where['subjectId']) &&
        (where['dayOfWeek'] === undefined || (where['dayOfWeek'] as { in: number[] }).in.includes(lesson['dayOfWeek'] as number)),
    ),
  );
  const names: Record<string, string> = { [SUBJECT]: 'Idrott och hälsa', 'sub-ma': 'Matematik', [GROUP]: '7A', 'g-7b': '7B' };
  const named = async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => ({ id, name: names[id] ?? id }));
  tx['subject']!['findMany']!.mockImplementation(named);
  tx['studentGroup']!['findMany']!.mockImplementation(named);
  tx['room']!['findMany']!.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
    where.id.in.filter((id) => (world.rooms ?? [ROOM_1, ROOM_2]).includes(id)).map((id) => ({ id })),
  );
  tx['teachingRequirementPlacement']!['deleteMany']!.mockResolvedValue({ count: 0 });
  tx['teachingRequirementPlacement']!['createMany']!.mockResolvedValue({ count: 0 });
  const service = new RequirementPlacementsService(prisma, masters as unknown as MasterLessonsService);
  return { tx, prisma, masters, service };
}

beforeEach(() => {
  (rostersOfYear as jest.Mock).mockReset().mockResolvedValue(BASIS);
  (lockYearForGrundschemaEdit as jest.Mock).mockReset().mockResolvedValue(undefined);
  (readBoardFacts as jest.Mock).mockReset().mockResolvedValue({ frames: [], sittings: new Map(), gradeRules: [], spans: new Map() });
  (readOtherSchoolHolds as jest.Mock).mockReset().mockResolvedValue({ holds: [] });
});

describe('RequirementPlacementsService', () => {
  describe('listOfYear', () => {
    it('lists the year\'s rows through the caller\'s RLS, as the views the timplan marks them with', async () => {
      const { tx, prisma, service } = setup({ rows: [stored()] });
      const user = testUser();

      await expect(service.listOfYear(YEAR, user)).resolves.toEqual([
        {
          id: 'p-1',
          requirementId: REQ,
          dayOfWeek: 2,
          startTime: '10:00',
          endTime: '11:00',
          minutes: 60,
          roomId: ROOM_1,
          roomName: 'Simhallen',
          recurrence: 'ALL_WEEKS',
          teacherId: null,
        },
      ]);
      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx['teachingRequirementPlacement']!['findMany']).toHaveBeenCalledWith(
        expect.objectContaining({ where: { requirement: { academicYearId: YEAR } } }),
      );
      expect(rostersOfYear).not.toHaveBeenCalled();
    });
  });

  describe('listOfPost', () => {
    it('answers 404 for a post the caller cannot see', async () => {
      const { service } = setup({ post: null });
      await expect(service.listOfPost(REQ, testUser())).rejects.toBeInstanceOf(NotFoundException);
    });

    it('answers a post with no row without reading the year\'s classes', async () => {
      const { service } = setup();
      await expect(service.listOfPost(REQ, testUser())).resolves.toEqual({ placements: [], verdicts: [] });
      expect(rostersOfYear).not.toHaveBeenCalled();
    });

    it('judges every row now, on the year\'s own roster basis, beside the year\'s other posts\' rows', async () => {
      const beside = [
        {
          id: 'p-9',
          requirementId: OTHER_REQ,
          dayOfWeek: 2,
          startTime: time('10:00'),
          minutes: 60,
          roomId: ROOM_2,
          recurrence: 'ALL_WEEKS',
          teacherId: null,
          requirement: {
            studentGroupId: 'g-7b',
            subjectId: 'sub-ma',
            teacherId: 'T-9',
            coTeacherId: null,
            startDate: null,
            endDate: null,
            _count: { shares: 0 },
          },
        },
      ];
      const { masters, service } = setup({ rows: [stored(), stored({ id: 'p-2', dayOfWeek: 4 })], beside });
      masters.findConflicts.mockImplementation(async (_tx, _basis, _lesson, candidate: { dayOfWeek: number }, options: { against: Array<{ id: string }> }) =>
        candidate.dayOfWeek === 2 ? [{ kind: 'ROOM', message: 'Room is already booked', masterLessonId: options.against[0]!.id }] : [],
      );

      const result = await service.listOfPost(REQ, testUser());

      expect(result.placements.map((row) => row.id)).toEqual(['p-1', 'p-2']);
      expect(result.verdicts).toEqual([
        {
          index: 0,
          ok: false,
          reason: 'ROOM',
          params: { otherKind: 'PLACEMENT', className: '7B', subjectName: 'Matematik', day: 2, start: '10:00', end: '11:00' },
        },
        { index: 1, ok: true },
      ]);
      expect(rostersOfYear).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ role: 'SCHOOL_ADMIN' }), YEAR, {
        isActive: true,
        predecessorId: null,
      });
      const options = masters.findConflicts.mock.calls[0]![4] as { against: Array<{ id: string }> };
      expect(options.against.map((lesson) => lesson.id)).toEqual(['placement:p-9']);
    });
  });

  describe('replace', () => {
    const user = testUser({ schoolId: 'the-callers-school' });

    it('replaces the rows: the year\'s lock first, then the old rows out and the new ones in one flat insert', async () => {
      // What the table holds after the write is what the answer lists.
      const written = [stored({ id: 'n-1' }), stored({ id: 'n-2', dayOfWeek: 4, startTime: time('13:30'), roomId: ROOM_2 })];
      const { tx, service } = setup({ rows: written });
      const result = await service.replace(
        REQ,
        { placements: [input(), input({ dayOfWeek: 4, startTime: '13:30', roomId: ROOM_2 })] },
        user,
      );

      expect(lockYearForGrundschemaEdit).toHaveBeenCalledWith(tx, YEAR);
      const lock = (lockYearForGrundschemaEdit as jest.Mock).mock.invocationCallOrder[0]!;
      const remove = tx['teachingRequirementPlacement']!['deleteMany']!.mock.invocationCallOrder[0]!;
      const insert = tx['teachingRequirementPlacement']!['createMany']!.mock.invocationCallOrder[0]!;
      expect(lock).toBeLessThan(remove);
      expect(remove).toBeLessThan(insert);
      // The post's row before the rows, as every other writer of its förläggningar takes them (review of #298, LÅG-1).
      const postLock = tx['$queryRaw'].mock.calls.findIndex((call) =>
        /SELECT "id" FROM "TeachingRequirements" WHERE "id" = \?::uuid FOR NO KEY UPDATE/.test((call[0] as TemplateStringsArray).join('?')),
      );
      expect(postLock).toBeGreaterThanOrEqual(0);
      expect(tx['$queryRaw'].mock.calls[postLock]![1]).toBe(REQ);
      expect(tx['$queryRaw'].mock.invocationCallOrder[postLock]!).toBeLessThan(remove);
      expect(tx['teachingRequirementPlacement']!['deleteMany']).toHaveBeenCalledWith({ where: { requirementId: REQ } });
      // schoolId is the post's, not the caller's; startTime is the @db.Time the table stores.
      expect(tx['teachingRequirementPlacement']!['createMany']).toHaveBeenCalledWith({
        data: [
          { schoolId: SCHOOL, requirementId: REQ, dayOfWeek: 2, startTime: time('10:00'), minutes: 60, roomId: ROOM_1, recurrence: 'ALL_WEEKS', teacherId: null },
          { schoolId: SCHOOL, requirementId: REQ, dayOfWeek: 4, startTime: time('13:30'), minutes: 60, roomId: ROOM_2, recurrence: 'ALL_WEEKS', teacherId: null },
        ],
      });
      expect(result.placements.map((row) => row.id)).toEqual(['n-1', 'n-2']);
      expect(result.verdicts).toEqual([
        { index: 0, ok: true },
        { index: 1, ok: true },
      ]);
    });

    it('judges the rows as drafts, each in the order of the request, with the callers school for the board', async () => {
      const { masters, service } = setup();
      await service.replace(REQ, { placements: [input(), input({ dayOfWeek: 4 })] }, user);
      expect(masters.findConflicts).toHaveBeenCalledTimes(2);
      expect(masters.findConflicts.mock.calls[0]![3]).toMatchObject({ dayOfWeek: 2, startMinutes: 600, endMinutes: 660, teacherId: TEACHER, roomId: ROOM_1 });
      expect(readBoardFacts).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ schoolId: 'the-callers-school', academicYearId: YEAR }));
    });

    it('writes an odd and an even row of one length together, as one insert', async () => {
      const { tx, service } = setup();
      await service.replace(
        REQ,
        { placements: [input({ recurrence: 'ODD_WEEKS' }), input({ dayOfWeek: 4, recurrence: 'EVEN_WEEKS' })] },
        user,
      );
      const call = tx['teachingRequirementPlacement']!['createMany']!.mock.calls;
      expect(call).toHaveLength(1);
      expect((call[0]![0] as { data: unknown[] }).data).toHaveLength(2);
    });

    it('removes every row on an empty list, judges nothing and reads no classes', async () => {
      const { tx, masters, service } = setup({ rows: [] });
      const result = await service.replace(REQ, { placements: [] }, user);
      expect(tx['teachingRequirementPlacement']!['deleteMany']).toHaveBeenCalledWith({ where: { requirementId: REQ } });
      expect(tx['teachingRequirementPlacement']!['createMany']).not.toHaveBeenCalled();
      expect(masters.findConflicts).not.toHaveBeenCalled();
      expect(rostersOfYear).not.toHaveBeenCalled();
      expect(lockYearForGrundschemaEdit).toHaveBeenCalledWith(tx, YEAR);
      expect(result).toEqual({ placements: [], verdicts: [] });
    });

    it('answers 404 for an unknown post, taking no lock and writing nothing', async () => {
      const { tx, service } = setup({ post: null });
      await expect(service.replace(REQ, { placements: [input()] }, user)).rejects.toBeInstanceOf(NotFoundException);
      expect(lockYearForGrundschemaEdit).not.toHaveBeenCalled();
      expect(tx['teachingRequirementPlacement']!['deleteMany']).not.toHaveBeenCalled();
    });

    it('answers 400 for a room the school does not have, and writes nothing', async () => {
      const { tx, service } = setup({ rooms: [ROOM_1] });
      await expect(service.replace(REQ, { placements: [input({ roomId: ROOM_2 })] }, user)).rejects.toMatchObject({ status: 400 });
      expect(tx['teachingRequirementPlacement']!['deleteMany']).not.toHaveBeenCalled();
    });

    describe('409 REQUIREMENT_PLACEMENTS_DO_NOT_FIT, before the week is asked', () => {
      it.each([
        ['LENGTH', {}, [input({ minutes: 45 })]],
        ['COUNT', {}, [input(), input({ dayOfWeek: 3 }), input({ dayOfWeek: 4 })]],
        ['PAIRS', {}, [input({ recurrence: 'ODD_WEEKS' })]],
        ['WEEKS', { recurrence: 'EVEN_WEEKS' }, [input({ recurrence: 'ODD_WEEKS' })]],
        ['BLOCK', { blockId: 'b-1' }, [input()]],
        // A post that shares nothing names no teacher on a row (the post's teacher is the lesson's).
        ['TEACHER', {}, [input({ teacherId: TEACHER })]],
      ])('%s', async (reason, postOver, placements) => {
        const { tx, masters, service } = setup({ post: { ...POST, ...postOver } as typeof POST });
        const refused = service.replace(REQ, { placements }, user);
        await expect(refused).rejects.toBeInstanceOf(ConflictException);
        await expect(refused).rejects.toMatchObject({ response: { code: 'REQUIREMENT_PLACEMENTS_DO_NOT_FIT', params: { reason } } });
        expect(masters.findConflicts).not.toHaveBeenCalled();
        expect(tx['teachingRequirementPlacement']!['deleteMany']).not.toHaveBeenCalled();
        expect(tx['teachingRequirementPlacement']!['createMany']).not.toHaveBeenCalled();
      });
    });

    describe('409 REQUIREMENT_PLACEMENT_REFUSED, nothing written', () => {
      it('names the first row that does not hold: its index in the request, the reason and the other lesson, flat', async () => {
        const { tx, masters, service } = setup({
          kept: [
            {
              id: 'k-1',
              dayOfWeek: 4,
              teacherId: 'someone',
              coTeacherId: null,
              roomId: null,
              studentGroupId: 'g-7b',
              subjectId: 'sub-ma',
              startTime: time('13:30'),
              endTime: time('14:30'),
              recurrence: 'ALL_WEEKS',
              startDate: null,
              endDate: null,
              subject: { name: 'Matematik' },
              studentGroup: { name: '7B' },
              extraGroups: [],
              participants: [],
            },
          ],
        });
        masters.findConflicts.mockImplementation(async (_tx, _basis, _lesson, candidate: { dayOfWeek: number }, options: { against: Array<{ id: string }> }) =>
          candidate.dayOfWeek === 4 ? [{ kind: 'TEACHER', message: 'x', masterLessonId: options.against[0]!.id }] : [],
        );

        const refused = service.replace(
          REQ,
          { placements: [input(), input({ dayOfWeek: 4, startTime: '13:30' })] },
          user,
        );

        await expect(refused).rejects.toMatchObject({
          status: 409,
          response: {
            code: 'REQUIREMENT_PLACEMENT_REFUSED',
            params: { index: 1, reason: 'TEACHER', otherKind: 'LESSON', className: '7B', subjectName: 'Matematik', day: 4, start: '13:30', end: '14:30' },
          },
        });
        expect(tx['teachingRequirementPlacement']!['deleteMany']).not.toHaveBeenCalled();
        expect(tx['teachingRequirementPlacement']!['createMany']).not.toHaveBeenCalled();
      });

      it('refuses a lesson outside the school day, with no params', async () => {
        const { tx, service } = setup();
        await expect(service.replace(REQ, { placements: [input({ startTime: '07:00' })] }, user)).rejects.toMatchObject({
          response: { code: 'REQUIREMENT_PLACEMENT_REFUSED', params: { index: 0, reason: 'SCHOOL_DAY' } },
        });
        expect(tx['teachingRequirementPlacement']!['createMany']).not.toHaveBeenCalled();
      });

      it('refuses rows over the demand the post\'s locks already answer (kept lessons that cover it)', async () => {
        const lock = (id: string, day: number) => ({
          id,
          dayOfWeek: day,
          teacherId: null,
          coTeacherId: null,
          roomId: null,
          studentGroupId: GROUP,
          subjectId: SUBJECT,
          startTime: time('08:00'),
          endTime: time('09:00'),
          recurrence: 'ALL_WEEKS',
          startDate: null,
          endDate: null,
          subject: { name: 'Idrott och hälsa' },
          studentGroup: { name: '7A' },
          extraGroups: [],
          participants: [],
        });
        const { tx, service } = setup({ kept: [lock('k-1', 1), lock('k-2', 3)] });
        await expect(service.replace(REQ, { placements: [input()] }, user)).rejects.toMatchObject({
          response: { code: 'REQUIREMENT_PLACEMENT_REFUSED', params: { index: 0, reason: 'OVER_DEMAND' } },
        });
        expect(tx['teachingRequirementPlacement']!['createMany']).not.toHaveBeenCalled();
      });

      it('lets a lock beside the row through when the post has a lesson left for it', async () => {
        const { tx, service } = setup({
          kept: [
            {
              id: 'k-1',
              dayOfWeek: 1,
              teacherId: null,
              coTeacherId: null,
              roomId: null,
              studentGroupId: GROUP,
              subjectId: SUBJECT,
              startTime: time('08:00'),
              endTime: time('09:00'),
              recurrence: 'ALL_WEEKS',
              startDate: null,
              endDate: null,
              subject: { name: 'Idrott och hälsa' },
              studentGroup: { name: '7A' },
              extraGroups: [],
              participants: [],
            },
          ],
        });
        await service.replace(REQ, { placements: [input()] }, user);
        expect(tx['teachingRequirementPlacement']!['createMany']).toHaveBeenCalledTimes(1);
      });
    });

    it('stops at the year\'s lock when a rewrite holds it, writing nothing', async () => {
      const { tx, service } = setup();
      (lockYearForGrundschemaEdit as jest.Mock).mockRejectedValue(new ConflictException({ code: 'SCHEDULE_BUSY' }));
      await expect(service.replace(REQ, { placements: [input()] }, user)).rejects.toMatchObject({ response: { code: 'SCHEDULE_BUSY' } });
      expect(tx['teachingRequirementPlacement']!['deleteMany']).not.toHaveBeenCalled();
    });

    it('does not save a year two steps ahead: the roster basis refuses it first', async () => {
      const { tx, service } = setup();
      (rostersOfYear as jest.Mock).mockRejectedValue(new ConflictException({ code: 'ROLLOVER_NOT_ACTIVATED' }));
      await expect(service.replace(REQ, { placements: [input()] }, user)).rejects.toMatchObject({ response: { code: 'ROLLOVER_NOT_ACTIVATED' } });
      expect(tx['teachingRequirementPlacement']!['deleteMany']).not.toHaveBeenCalled();
    });

    it('answers a trigger refusal the gateway did not foresee (FP409) as the 409 naming the rule, not a 500', async () => {
      const { tx, service } = setup();
      tx['teachingRequirementPlacement']!['createMany']!.mockRejectedValue(fkError('PAIRS'));
      await expect(service.replace(REQ, { placements: [input()] }, user)).rejects.toMatchObject({
        status: 409,
        response: { code: 'REQUIREMENT_PLACEMENTS_DO_NOT_FIT', params: { reason: 'PAIRS' } },
      });
    });

    it('asks the database for the rules per teacher at its last write, and answers its refusal as the 409', async () => {
      const { tx, service } = setup();
      await service.replace(REQ, { placements: [input()] }, user);
      const insert = tx['teachingRequirementPlacement']!['createMany']!.mock.invocationCallOrder[0]!;
      const judged = tx['$executeRaw'].mock.invocationCallOrder;
      expect(judged).toHaveLength(2);
      expect(judged[0]).toBeGreaterThan(insert);
      const statements = tx['$executeRaw'].mock.calls.map((call) => (call[0] as TemplateStringsArray).join('?'));
      expect(statements[0]).toBe(
          'SET CONSTRAINTS "TeachingRequirementPlacements_teachers_fit", "TeachingRequirementShares_placement_teachers_fit", "TeachingRequirements_placement_teachers_fit" IMMEDIATE',
      );
      expect(statements[1]).toMatch(/ DEFERRED$/);

      const second = setup();
      second.tx['$executeRaw'].mockRejectedValueOnce(fkError('TEACHER_COUNT'));
      await expect(second.service.replace(REQ, { placements: [input()] }, user)).rejects.toMatchObject({
        status: 409,
        response: { code: 'REQUIREMENT_PLACEMENTS_DO_NOT_FIT', params: { reason: 'TEACHER_COUNT' } },
      });
    });

    describe('on a post with delade lektioner (Anna two of 60, Bo one)', () => {
      const BO = '55555555-5555-4555-8555-555555555555';
      const SHARED = { ...POST, lessonsPerWeek: 3, shares: [{ teacherId: BO, lessons: 1, minutes: 60 }] };

      it('writes each row with its teacher, and judges it against that teacher’s week', async () => {
        const { tx, masters, service } = setup({ post: SHARED });
        await service.replace(
          REQ,
          { placements: [input({ teacherId: BO }), input({ dayOfWeek: 4, teacherId: TEACHER })] },
          user,
        );
        const data = (tx['teachingRequirementPlacement']!['createMany']!.mock.calls[0]![0] as { data: Array<{ teacherId: string }> }).data;
        expect(data.map((row) => row.teacherId)).toEqual([BO, TEACHER]);
        expect(masters.findConflicts.mock.calls.map((call) => (call[3] as { teacherId: string }).teacherId)).toEqual([BO, TEACHER]);
      });

      it.each([
        ['NO_TEACHER', [input({ teacherId: BO }), input({ dayOfWeek: 4 })], 1],
        ['TEACHER', [input({ teacherId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' })], 0],
        ['TEACHER_COUNT', [input({ teacherId: BO }), input({ dayOfWeek: 3, teacherId: TEACHER }), input({ dayOfWeek: 4, teacherId: BO })], 2],
        ['TEACHER_PAIRS', [input({ recurrence: 'ODD_WEEKS', teacherId: BO }), input({ dayOfWeek: 4, recurrence: 'EVEN_WEEKS', teacherId: TEACHER })], 0],
      ])('refuses %s with the row it is said of, before the week is asked', async (reason, placements, index) => {
        const { tx, masters, service } = setup({ post: SHARED });
        await expect(service.replace(REQ, { placements }, user)).rejects.toMatchObject({
          status: 409,
          response: { code: 'REQUIREMENT_PLACEMENTS_DO_NOT_FIT', params: { reason, index } },
        });
        expect(masters.findConflicts).not.toHaveBeenCalled();
        expect(tx['teachingRequirementPlacement']!['createMany']).not.toHaveBeenCalled();
      });

      it('lets Bo’s own lock answer Bo’s lesson: his förläggning is over the demand, Anna’s is not', async () => {
        const lock = {
          id: 'k-1',
          dayOfWeek: 1,
          teacherId: BO,
          coTeacherId: null,
          roomId: null,
          studentGroupId: GROUP,
          subjectId: SUBJECT,
          startTime: time('08:00'),
          endTime: time('09:00'),
          recurrence: 'ALL_WEEKS',
          startDate: null,
          endDate: null,
          subject: { name: 'Idrott och hälsa' },
          studentGroup: { name: '7A' },
          extraGroups: [],
          participants: [],
        };
        const bo = setup({ post: SHARED, kept: [lock] });
        await expect(bo.service.replace(REQ, { placements: [input({ teacherId: BO })] }, user)).rejects.toMatchObject({
          response: { code: 'REQUIREMENT_PLACEMENT_REFUSED', params: { index: 0, reason: 'OVER_DEMAND' } },
        });
        const anna = setup({ post: SHARED, kept: [lock] });
        await anna.service.replace(REQ, { placements: [input({ teacherId: TEACHER })] }, user);
        expect(anna.tx['teachingRequirementPlacement']!['createMany']).toHaveBeenCalledTimes(1);
      });

      it('judges another post’s förläggning beside it with that row’s own teacher when that post shares', async () => {
        const beside = [
          {
            id: 'p-9',
            requirementId: OTHER_REQ,
            dayOfWeek: 2,
            startTime: time('10:00'),
            minutes: 60,
            roomId: ROOM_2,
            recurrence: 'ALL_WEEKS',
            teacherId: BO,
            requirement: {
              studentGroupId: 'g-7b',
              subjectId: 'sub-ma',
              teacherId: 'T-9',
              coTeacherId: null,
              startDate: null,
              endDate: null,
              _count: { shares: 1 },
            },
          },
        ];
        const { masters, service } = setup({ post: SHARED, beside });
        await service.replace(REQ, { placements: [input({ teacherId: TEACHER })] }, user);
        const options = masters.findConflicts.mock.calls[0]![4] as { against: Array<{ id: string; teacherId: string }> };
        expect(options.against.map((lesson) => [lesson.id, lesson.teacherId])).toEqual([['placement:p-9', BO]]);
      });
    });
  });
});

describe('RequirementPlacementsService.boardOfYear', () => {
  const user = testUser();
  const YEAR_ROW = { isActive: true, predecessorId: null, gradeNumbering: 'NIOARIG' };
  const SECOND_REQ = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const BO = '55555555-5555-4555-8555-555555555555';

  /** A post as the board reads it (BOARD_POST_SELECT). */
  const boardPost = (over: Record<string, unknown> = {}) => {
    const { academicYear: _academicYear, schoolId: _schoolId, academicYearId: _year, ...post } = POST;
    return { ...post, ...over };
  };

  /** A lesson Generera keeps, with what the board selects of it and what the judge selects of it. */
  const keptLesson = (over: Record<string, unknown> = {}) => ({
    id: 'k-1',
    dayOfWeek: 2,
    startTime: time('13:00'),
    endTime: time('14:00'),
    studentGroupId: GROUP,
    subjectId: SUBJECT,
    teacherId: TEACHER,
    coTeacherId: null,
    roomId: ROOM_2,
    recurrence: 'ALL_WEEKS',
    startDate: null,
    endDate: null,
    isLocked: true,
    isGenerated: false,
    subject: { name: 'Idrott och hälsa' },
    studentGroup: { name: '7A' },
    extraGroups: [],
    participants: [],
    ...over,
  });

  function board(world: World & { posts?: Array<Record<string, unknown>>; year?: unknown; meals?: unknown[] } = {}) {
    const made = setup(world);
    made.tx['academicYear']!['findUnique']!.mockResolvedValue(world.year === undefined ? YEAR_ROW : world.year);
    made.tx['teachingRequirement']!['findMany']!.mockResolvedValue(world.posts ?? [boardPost()]);
    made.tx['lunchSitting']!['findMany']!.mockResolvedValue(world.meals ?? []);
    return made;
  }

  it('answers 404 for a year the caller cannot see, and reads nothing else', async () => {
    const { tx, service } = board({ year: null });
    await expect(service.boardOfYear(YEAR, user)).rejects.toBeInstanceOf(NotFoundException);
    expect(tx['teachingRequirement']!['findMany']).not.toHaveBeenCalled();
  });

  it('answers a year with no row without judging anything or reading the year\'s classes', async () => {
    const { masters, service } = board();
    const answer = await service.boardOfYear(YEAR, user);
    expect(answer.placements).toEqual([]);
    expect(answer.posts).toEqual([
      expect.objectContaining({ id: REQ, cannotPlace: null, parts: [expect.objectContaining({ count: 2, locked: 0, placed: 0, left: 2 })] }),
    ]);
    expect(masters.findConflicts).not.toHaveBeenCalled();
    expect(rostersOfYear).not.toHaveBeenCalled();
    expect(readBoardFacts).not.toHaveBeenCalled();
  });

  it('judges every row of the year once, as Generera\'s pre-flight does, and gives each its own verdict', async () => {
    const { masters, service } = board({
      posts: [boardPost(), boardPost({ id: SECOND_REQ, subjectId: 'sub-ma', lessonsPerWeek: 1 })],
      rows: [
        stored({ id: 'p-1', updatedAt: new Date('2026-11-13T08:00:00.000Z') }),
        stored({ id: 'p-2', dayOfWeek: 4, updatedAt: new Date('2026-11-13T08:00:00.000Z') }),
        stored({ id: 'p-3', requirementId: SECOND_REQ, dayOfWeek: 3, updatedAt: new Date('2026-11-13T09:30:00.000Z') }),
      ],
    });
    masters.findConflicts.mockImplementation(async (_tx, _basis, _lesson, candidate: { dayOfWeek: number }, options: { against: Array<{ id: string }> }) =>
      candidate.dayOfWeek === 4 ? [{ kind: 'ROOM', message: 'Room is already booked', masterLessonId: options.against[0]?.id }] : [],
    );

    const answer = await service.boardOfYear(YEAR, user);

    expect(masters.findConflicts).toHaveBeenCalledTimes(3);
    expect(rostersOfYear).toHaveBeenCalledTimes(1);
    expect(answer.placements.map((row) => [row.id, row.verdict.ok, row.verdict.reason ?? null, row.changedAt])).toEqual([
      ['p-1', true, null, '2026-11-13T08:00:00.000Z'],
      ['p-2', false, 'ROOM', '2026-11-13T08:00:00.000Z'],
      ['p-3', true, null, '2026-11-13T09:30:00.000Z'],
    ]);
    // Each row is held against the other rows of the year (here: none on its day but its own).
    expect(answer.placements[0]).toMatchObject({ requirementId: REQ, roomName: 'Simhallen', startTime: '10:00', endTime: '11:00' });
  });

  it('counts each post with the locks Generera keeps and the rows the year places: the figure Generera sends', async () => {
    const { service } = board({
      kept: [keptLesson()],
      rows: [stored({ id: 'p-1' })],
    });
    const [post] = (await service.boardOfYear(YEAR, user)).posts;
    // Two lessons of 60: the kept lesson of 7A in the subject answers one, the förläggning the other.
    expect(post!.parts).toEqual([{ teacherId: TEACHER, minutes: 60, count: 2, locked: 1, placed: 1, left: 0, cannotPlace: null }]);
  });

  it('holds a shared post\'s rows to their own teacher\'s lessons', async () => {
    const shared = boardPost({ lessonsPerWeek: 3, shares: [{ teacherId: BO, lessons: 1, minutes: 60 }] });
    const { masters, service } = board({ posts: [shared], rows: [stored({ id: 'p-1', teacherId: BO })] });
    const answer = await service.boardOfYear(YEAR, user);
    expect(answer.posts[0]!.parts).toEqual([
      { teacherId: TEACHER, minutes: 60, count: 2, locked: 0, placed: 0, left: 2, cannotPlace: null },
      { teacherId: BO, minutes: 60, count: 1, locked: 0, placed: 1, left: 0, cannotPlace: null },
    ]);
    // The clash rule is asked about Bo's week, since the lesson is Bo's.
    expect(masters.findConflicts.mock.calls[0]![3]).toMatchObject({ teacherId: BO });
  });

  it('says what the rows are held against: the kept lessons with ids only, and the meals placed by hand', async () => {
    const { tx, service } = board({
      kept: [keptLesson({ participants: [{ studentId: 'secret-pupil' }], extraGroups: [{ studentGroupId: 'g-7b' }] })],
      meals: [
        {
          id: 'm-1',
          studentGroupId: GROUP,
          dayOfWeek: 2,
          startTime: time('11:00'),
          endTime: time('11:30'),
          startDate: null,
          endDate: null,
        },
      ],
    });
    const answer = await service.boardOfYear(YEAR, user);
    expect(answer.kept).toEqual([
      expect.objectContaining({ id: 'k-1', startTime: '13:00', endTime: '14:00', extraGroupIds: ['g-7b'], locked: true, generated: false }),
    ]);
    expect(JSON.stringify(answer)).not.toContain('secret-pupil');
    expect(answer.meals).toEqual([{ id: 'm-1', studentGroupId: GROUP, dayOfWeek: 2, startTime: '11:00', endTime: '11:30', startDate: null, endDate: null }]);
    // The same filter as Generera's and the judge's (a kept lesson, not parked), and only the meals the school placed.
    const keptRead = tx['masterLesson']!['findMany']!.mock.calls[0]![0] as { where: Record<string, unknown>; select: Record<string, unknown> };
    // Exactly the read of Generera's fetch and the judge (keptMastersWhere): every arm of the rule, the year, not parked.
    expect(keptRead.where).toEqual(keptMastersWhere(YEAR));
    expect(keptRead.select).not.toHaveProperty('participants');
    expect(tx['lunchSitting']!['findMany']).toHaveBeenCalledWith(expect.objectContaining({ where: { academicYearId: YEAR, isGenerated: false } }));
  });

  describe('asks the judge what the dialog asks it (review of #315, MEDEL-1)', () => {
    const BO_LOCK = () => keptLesson({ id: 'k-bo', teacherId: BO });
    const sharedPost = () => ({ ...POST, lessonsPerWeek: 3, shares: [{ teacherId: BO, lessons: 1, minutes: 60 }] });

    /** The post's demand entry as the judge reads it: the post by the fields it counts with (the two reads select different extras). */
    const demandOf = (asked: placementJudge.JudgePlacementsInput) => {
      const { post, ...rest } = asked.demand!.get(REQ)!;
      return { ...rest, post: { lessonsPerWeek: post.lessonsPerWeek, minutesPerLesson: post.minutesPerLesson, lessonLengths: post.lessonLengths, teacherId: post.teacherId, shares: post.shares } };
    };

    /** What judgePlacements was handed by the week and by the dialog's read of the same post. */
    async function askedByBoth(world: World) {
      const spy = jest.spyOn(placementJudge, 'judgePlacements');
      try {
        const { service } = board({ ...world, posts: [boardPost(world.post ?? {})] });
        await service.boardOfYear(YEAR, user);
        await service.listOfPost(REQ, user);
        const [week, dialog] = spy.mock.calls.map(([, , asked]) => asked);
        return { week: week!, dialog: dialog!, demandOf: demandOf(week!), dialogDemandOf: demandOf(dialog!) };
      } finally {
        spy.mockRestore();
      }
    }

    it('hands over the same rows, each as the post and its own slot make it', async () => {
      const rows = [stored({ id: 'p-1' }), stored({ id: 'p-2', dayOfWeek: 4, recurrence: 'ODD_WEEKS' })];
      const { week, dialog } = await askedByBoth({ rows, post: { ...POST, startDate: new Date('2026-08-24T00:00:00.000Z') } as never });
      expect(week.rows.map((row) => ({ ...row, id: null }))).toEqual(dialog.rows);
      expect(week.rows.map((row) => row.id)).toEqual(['p-1', 'p-2']);
      expect(week.rows[0]).toMatchObject({ requirementId: REQ, studentGroupId: GROUP, subjectId: SUBJECT, teacherId: TEACHER, startDate: expect.any(Date) });
    });

    it('hands over the same demand for a post that shares nothing: the lock, and the lessons the rows place', async () => {
      const { demandOf: week, dialogDemandOf: dialog } = await askedByBoth({ kept: [keptLesson()], rows: [stored({ id: 'p-1' })] });
      expect(week).toEqual(dialog);
      expect(week).toMatchObject({ lockedMinutes: [60], placed: [60] });
      expect(week).not.toHaveProperty('taught');
    });

    it('hands over the same demand for a shared post: Bo\'s lock answers Bo\'s lesson, each row takes one of its teacher\'s', async () => {
      const post = sharedPost();
      const rows = [stored({ id: 'p-1', teacherId: TEACHER }), stored({ id: 'p-2', dayOfWeek: 4, teacherId: BO })];
      const { demandOf: week, dialogDemandOf: dialog } = await askedByBoth({ post, kept: [BO_LOCK()], rows });
      expect(week).toEqual(dialog);
      expect(week).toMatchObject({
        lockedMinutes: [60],
        placed: [60, 60],
        taught: {
          locked: [{ minutes: 60, teacherId: BO }],
          placed: [
            { minutes: 60, teacherId: TEACHER },
            { minutes: 60, teacherId: BO },
          ],
        },
      });
    });

    it('holds a lesson that has a second class or named pupils against the row, as the dialog does', async () => {
      const lessons = [
        keptLesson({ id: 'k-extra', isLocked: false, isGenerated: true, extraGroups: [{ studentGroupId: 'g-7b' }] }),
        keptLesson({ id: 'k-pupils', isLocked: false, isGenerated: true, participants: [{ studentId: 'pupil-1' }] }),
      ];
      const { demandOf: week, dialogDemandOf: dialog } = await askedByBoth({ kept: lessons, rows: [stored({ id: 'p-1' })] });
      expect(week).toEqual(dialog);
      // Both answer a lesson of the post (the post has two), so a lock of 60 per lesson is counted twice.
      expect(week).toMatchObject({ lockedMinutes: [60, 60], placed: [60] });
    });
  });

  it('is read through the caller\'s RLS and never asks for the caller\'s own person', async () => {
    const { prisma, service } = board();
    await service.boardOfYear(YEAR, user);
    expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
  });
});
