import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import type { MasterLessonsService } from '../calendar/master-lessons.service';
import type { PrismaService } from '../database/prisma.service';
import { keptMastersWhere } from '../optimization/preserved-lessons';
import { lockYearForGrundschemaEdit } from '../optimization/regeneration-lock';
import { readOtherSchoolHolds } from '../optimization/other-school-holds';
import { readBoardFacts } from '../swaps/board-rules';
import { rostersOfYear } from '../year-rollover/projected-rosters';
import * as placementJudge from './placement-judge';
import { rowsKeyOf } from './placement-rows-key';
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
  academicYear: { isActive: true, predecessorId: null, gradeNumbering: 'NIOARIG', startDate: new Date('2026-08-17T00:00:00.000Z'), endDate: new Date('2027-06-11T00:00:00.000Z') },
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
  /** D1: the teachers' caps, the posts' limits, the school's lunch, the subjects that need a room type, and every room with its type. */
  workRules?: Array<{ userId: string; maxTeachingMinutesPerDay: number | null }>;
  limits?: Array<{ userId: string; maxTeachingDaysPerWeek: number | null; maxConsecutiveTeachingMinutes: number | null; consecutiveBreakMinutes: number | null }>;
  lunch?: { lunchEnabled: boolean; lunchStartTime: Date; lunchEndTime: Date; lunchMinutes: number } | null;
  classes?: string[];
  needsType?: Record<string, string>;
  everyRoom?: Array<{ id: string; roomTypeId: string | null; roomType: { name: string } | null }>;
  /** The lessons the grundschema has from a förläggning: how many, and when the newest was written. */
  written?: { count: number; at: Date | null };
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
  // What the grundschema holds of the förläggningar (the board's `timetable`): nothing written, unless a world says so.
  tx['masterLesson']!['aggregate']!.mockResolvedValue({ _count: { _all: world.written?.count ?? 0 }, _max: { createdAt: world.written?.at ?? null } });
  const names: Record<string, string> = { [SUBJECT]: 'Idrott och hälsa', 'sub-ma': 'Matematik', [GROUP]: '7A', 'g-7b': '7B' };
  const named = async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => ({ id, name: names[id] ?? id }));
  // The subjects that need a room type (D1) are asked by a filter on the column; every other read is for the names.
  tx['subject']!['findMany']!.mockImplementation(async (args: { where: { id: { in: string[] }; requiredRoomTypeId?: unknown } }) =>
    args.where.requiredRoomTypeId === undefined
      ? named(args)
      : args.where.id.in.filter((id) => world.needsType?.[id] !== undefined).map((id) => ({ id, requiredRoomTypeId: world.needsType![id] })),
  );
  // The groups that eat (D1) are asked by kind: the classes a world names, among those asked; every other read is for the names.
  tx['studentGroup']!['findMany']!.mockImplementation(async (args: { where: { id: { in: string[] }; kind?: unknown } }) =>
    args.where.kind === undefined ? named(args) : args.where.id.in.filter((id) => (world.classes ?? []).includes(id)).map((id) => ({ id })),
  );
  // The rooms the school names in a save (a filter on ids), and every room with its type (D1, no filter).
  tx['room']!['findMany']!.mockImplementation(async (args: { where?: { id: { in: string[] } } }) =>
    args.where === undefined
      ? (world.everyRoom ?? [])
      : args.where.id.in.filter((id) => (world.rooms ?? [ROOM_1, ROOM_2]).includes(id)).map((id) => ({ id })),
  );
  tx['teacherWorkRule']!['findMany']!.mockResolvedValue(world.workRules ?? []);
  tx['teacherEmployment']!['findMany']!.mockResolvedValue(world.limits ?? []);
  tx['lunchSetting']!['findUnique']!.mockResolvedValue(world.lunch ?? null);
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
      await expect(service.listOfPost(REQ, testUser())).resolves.toEqual({ placements: [], verdicts: [], rowsKey: rowsKeyOf([]), warnings: [] });
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

    describe('a row with no room (the engine chooses it, 20270213090000)', () => {
      it('writes it with no room, left out or null alike, asks the school for no room, and judges it against none', async () => {
        const written = [stored({ id: 'n-1', roomId: null, room: null }), stored({ id: 'n-2', dayOfWeek: 4, roomId: null, room: null })];
        const { tx, masters, service } = setup({ rows: written });
        const result = await service.replace(REQ, { placements: [input({ roomId: null }), input({ dayOfWeek: 4, roomId: undefined })] }, user);

        expect(tx['teachingRequirementPlacement']!['createMany']).toHaveBeenCalledWith({
          data: [
            { schoolId: SCHOOL, requirementId: REQ, dayOfWeek: 2, startTime: time('10:00'), minutes: 60, roomId: null, recurrence: 'ALL_WEEKS', teacherId: null },
            { schoolId: SCHOOL, requirementId: REQ, dayOfWeek: 4, startTime: time('10:00'), minutes: 60, roomId: null, recurrence: 'ALL_WEEKS', teacherId: null },
          ],
        });
        // No room to look for, so no room is looked for.
        expect(tx['room']!['findMany']).not.toHaveBeenCalled();
        expect(masters.findConflicts.mock.calls.map((call) => (call[3] as { roomId: string | null }).roomId)).toEqual([null, null]);
        // And answered with no room, and no name.
        expect(result.placements.map((row) => [row.roomId, row.roomName])).toEqual([[null, null], [null, null]]);
        expect(result.verdicts.every((verdict) => verdict.ok)).toBe(true);
      });

      it('asks for the rooms of the rows that have one, and only those', async () => {
        const { tx, service } = setup({ rooms: [ROOM_1] });
        await service.replace(REQ, { placements: [input(), input({ dayOfWeek: 4, roomId: null })] }, user);
        expect(tx['room']!['findMany']).toHaveBeenCalledWith({ where: { id: { in: [ROOM_1] } }, select: { id: true } });
      });

      it('still refuses a room the school does not have, beside a row with none', async () => {
        const { tx, service } = setup({ rooms: [ROOM_1] });
        await expect(service.replace(REQ, { placements: [input({ roomId: null }), input({ dayOfWeek: 4, roomId: ROOM_2 })] }, user)).rejects.toMatchObject({ status: 400 });
        expect(tx['teachingRequirementPlacement']!['deleteMany']).not.toHaveBeenCalled();
      });

      it('lets a pair with a room on both halves through, and says PAIR_ROOM about one that has none on a half, with the half’s index', async () => {
        const ok = setup();
        await ok.service.replace(REQ, { placements: [input({ recurrence: 'ODD_WEEKS' }), input({ dayOfWeek: 4, recurrence: 'EVEN_WEEKS', roomId: ROOM_2 })] }, user);
        expect(ok.tx['teachingRequirementPlacement']!['createMany']).toHaveBeenCalledTimes(1);

        const refused = setup();
        const result = refused.service.replace(REQ, { placements: [input({ recurrence: 'ODD_WEEKS' }), input({ dayOfWeek: 4, recurrence: 'EVEN_WEEKS', roomId: null })] }, user);
        await expect(result).rejects.toMatchObject({ response: { code: 'REQUIREMENT_PLACEMENTS_DO_NOT_FIT', params: { reason: 'PAIR_ROOM', index: 1 } } });
        await expect(result).rejects.toMatchObject({ response: { message: expect.stringContaining('båda platserna måste ha en sal') } });
        expect(refused.tx['teachingRequirementPlacement']!['deleteMany']).not.toHaveBeenCalled();
      });
    });

    it('removes every row on an empty list, judges nothing and reads no classes', async () => {
      const { tx, masters, service } = setup({ rows: [] });
      const result = await service.replace(REQ, { placements: [] }, user);
      expect(tx['teachingRequirementPlacement']!['deleteMany']).toHaveBeenCalledWith({ where: { requirementId: REQ } });
      expect(tx['teachingRequirementPlacement']!['createMany']).not.toHaveBeenCalled();
      expect(masters.findConflicts).not.toHaveBeenCalled();
      expect(rostersOfYear).not.toHaveBeenCalled();
      expect(lockYearForGrundschemaEdit).toHaveBeenCalledWith(tx, YEAR);
      expect(result).toEqual({ placements: [], verdicts: [], rowsKey: rowsKeyOf([]), warnings: [] });
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
        // A pair is a lesson in two places, and the engine cannot choose the room of half a lesson: both halves name a room.
        ['PAIR_ROOM', {}, [input({ recurrence: 'ODD_WEEKS' }), input({ dayOfWeek: 4, recurrence: 'EVEN_WEEKS', roomId: null })]],
        ['PAIR_ROOM', {}, [input({ recurrence: 'ODD_WEEKS', roomId: undefined }), input({ dayOfWeek: 4, recurrence: 'EVEN_WEEKS', roomId: undefined })]],
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
  const YEAR_ROW = { isActive: true, predecessorId: null, gradeNumbering: 'NIOARIG', startDate: new Date('2026-08-17T00:00:00.000Z'), endDate: new Date('2027-06-11T00:00:00.000Z') };
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

  describe('timetable: what the grundschema holds of the förläggningar (A3)', () => {
    it('is nothing written, and no time, for a year Generera never wrote a förläggning in', async () => {
      const { service } = board();
      expect((await service.boardOfYear(YEAR, user)).timetable).toEqual({ placedLessons: 0, writtenAt: null });
    });

    it('counts the year\'s lessons that are a förläggning, and says when the newest was written, as an ISO time', async () => {
      const { service } = board({ written: { count: 3, at: new Date('2026-11-16T09:30:00.000Z') } });
      expect((await service.boardOfYear(YEAR, user)).timetable).toEqual({ placedLessons: 3, writtenAt: '2026-11-16T09:30:00.000Z' });
    });

    it('asks the grundschema and nothing else: this year\'s lessons marked fromPlacement, their count and newest createdAt (never updatedAt: a lock moves that)', async () => {
      const { tx, service } = board();
      await service.boardOfYear(YEAR, user);
      expect(tx['masterLesson']!['aggregate']).toHaveBeenCalledTimes(1);
      expect(tx['masterLesson']!['aggregate']).toHaveBeenCalledWith({
        where: { academicYearId: YEAR, fromPlacement: true },
        _count: { _all: true },
        _max: { createdAt: true },
      });
    });

    it('counts the lessons written, not the rows now stored: a row removed after the run leaves its lesson counted', async () => {
      // One stored row, two lessons written from rows (the second row was removed since): the count is the grundschema's.
      const { service } = board({ rows: [stored()], written: { count: 2, at: new Date('2026-11-16T09:30:00.000Z') } });
      const answer = await service.boardOfYear(YEAR, user);
      expect(answer.placements).toHaveLength(1);
      expect(answer.timetable.placedLessons).toBe(2);
    });
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

  it('shows a row with no room as one: no room and no name, judged against none, and counted as placed by the school', async () => {
    const { masters, service } = board({
      rows: [stored({ id: 'p-1', roomId: null, room: null }), stored({ id: 'p-2', dayOfWeek: 4 })],
    });
    const answer = await service.boardOfYear(YEAR, user);
    expect(answer.placements.map((row) => [row.id, row.roomId, row.roomName])).toEqual([
      ['p-1', null, null],
      ['p-2', ROOM_1, 'Simhallen'],
    ]);
    expect(answer.placements.every((row) => row.verdict.ok)).toBe(true);
    expect(masters.findConflicts.mock.calls.map((call) => (call[3] as { roomId: string | null }).roomId)).toEqual([null, ROOM_1]);
    // Both are lessons the school placed: a pinned one is still placed by hand, though the engine holds it as the post's own.
    expect(answer.posts[0]!.parts[0]).toMatchObject({ count: 2, placed: 2, left: 0 });
  });

  it('says PAIR_ROOM for a half of a pair another writer stored with no room, and BLOCK for a row on a post in a block', async () => {
    const pair = board({
      rows: [stored({ id: 'p-1', recurrence: 'ODD_WEEKS' }), stored({ id: 'p-2', dayOfWeek: 4, recurrence: 'EVEN_WEEKS', roomId: null, room: null })],
    });
    expect((await pair.service.boardOfYear(YEAR, user)).placements.map((row) => row.verdict)).toEqual([{ ok: true }, { ok: false, reason: 'PAIR_ROOM' }]);
    const block = board({ posts: [boardPost({ blockId: 'b-1' })], rows: [stored({ id: 'p-1', roomId: null, room: null })] });
    expect((await block.service.boardOfYear(YEAR, user)).placements[0]!.verdict).toEqual({ ok: false, reason: 'BLOCK' });
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

  describe('warnings: what the fixed week says of each row (D1)', () => {
    const CAP_90 = [{ userId: TEACHER, maxTeachingMinutesPerDay: 90 }];
    /** An hour on Tuesday at 08:00 that the teacher keeps, and the row below at 10:00: two hours on the day. */
    const keptTuesday = () => keptLesson({ id: 'k-8', startTime: time('08:00'), endTime: time('09:00') });
    const OVER = { code: 'TEACHER_DAY_TOO_LONG', refuses: false, params: { day: 2, minutes: 120, cap: 90 } };

    it('says a day over the teacher’s cap on the row, by the row’s own id, with its post, and refuses nothing', async () => {
      const { service } = board({ rows: [stored({ id: 'p-1', startTime: time('10:00') })], kept: [keptTuesday()], workRules: CAP_90 });
      const answer = await service.boardOfYear(YEAR, user);
      expect(answer.warnings).toEqual([{ rowId: 'p-1', requirementId: REQ, ...OVER }]);
      expect(answer.placements[0]!.verdict).toEqual({ ok: true });
    });

    it('is an empty list for a school with no rule, no lunch and no row without a room, and reads only the two rule statements', async () => {
      const { tx, service } = board({ rows: [stored()], kept: [keptTuesday()] });
      const answer = await service.boardOfYear(YEAR, user);
      expect(answer.warnings).toEqual([]);
      expect(tx['teacherWorkRule']!['findMany']).toHaveBeenCalledTimes(1);
      expect(tx['teacherEmployment']!['findMany']).toHaveBeenCalledTimes(1);
      expect(tx['room']!['findMany']).not.toHaveBeenCalled();
      expect(tx['subject']!['findMany']).toHaveBeenCalledTimes(1);
      expect(tx['studentGroup']!['findMany']).toHaveBeenCalledTimes(1);
    });

    it('counts the lessons the board has read, and asks the database for no kept lesson of its own', async () => {
      const { tx, service } = board({ rows: [stored({ id: 'p-1', startTime: time('10:00') })], kept: [keptTuesday()], workRules: CAP_90 });
      await service.boardOfYear(YEAR, user);
      // The kept lessons are read once, for the board; the warnings add no read of them.
      const keptReads = tx['masterLesson']!['findMany']!.mock.calls.filter((call) => JSON.stringify((call[0] as { where: unknown }).where) === JSON.stringify(keptMastersWhere(YEAR)));
      expect(keptReads).toHaveLength(1);
    });

    it('words the post’s days for the reader and tells the läslogg that the post was read, for a reader without HR-läs as for one with it', async () => {
      const limits = [{ userId: TEACHER, maxTeachingDaysPerWeek: 1, maxConsecutiveTeachingMinutes: null, consecutiveBreakMinutes: null }];
      const world = { rows: [stored({ id: 'p-1', dayOfWeek: 2 })], kept: [keptLesson({ id: 'k-3', dayOfWeek: 3 })], limits };
      const shown = board(world);
      const full = await shown.service.boardOfYear(YEAR, testUser());
      expect(full.warnings).toEqual([{ rowId: 'p-1', requirementId: REQ, code: 'TEACHER_WEEK_TOO_MANY_DAYS', refuses: false, params: { days: 2, max: 1 } }]);
      expect(shown.tx.$executeRaw).toHaveBeenCalledTimes(1);
      const hidden = board(world);
      const reader = await hidden.service.boardOfYear(YEAR, testUser({ adminProfile: 'SCHEMALAGGARE', hrRead: false }));
      expect(reader.warnings).toEqual([{ rowId: 'p-1', requirementId: REQ, code: 'TEACHER_WEEK_TOO_MANY_DAYS_HIDDEN', refuses: false }]);
      expect(hidden.tx.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it('answers the other schools’ holds as bands: the resource, the day and the clock without seconds, and the schools by name', async () => {
      (readOtherSchoolHolds as jest.Mock).mockResolvedValue({
        holds: [
          { holdId: 'h-1', kind: 'TEACHER_BUSY', resourceKind: 'TEACHER', resourceId: TEACHER, dayOfWeek: 2, startTime: '10:00:00', endTime: '11:15:00', schools: ['Skola B'], walked: true },
          { holdId: 'h-2', kind: 'ROOM_LENT', resourceKind: 'ROOM', resourceId: ROOM_1, dayOfWeek: 4, startTime: '08:00:00', endTime: '09:00:00', schools: ['Skola B', 'Skola C'] },
        ],
      });
      const { service } = board();
      expect((await service.boardOfYear(YEAR, user)).holds).toEqual([
        { kind: 'TEACHER_BUSY', resourceKind: 'TEACHER', resourceId: TEACHER, dayOfWeek: 2, startTime: '10:00', endTime: '11:15', schools: ['Skola B'] },
        { kind: 'ROOM_LENT', resourceKind: 'ROOM', resourceId: ROOM_1, dayOfWeek: 4, startTime: '08:00', endTime: '09:00', schools: ['Skola B', 'Skola C'] },
      ]);
    });

    it('asks a row with no room of the rooms of its subject’s type, and says a pin that no room of the type is free for', async () => {
      const TYPE = 'type-slojd';
      const { service } = board({
        rows: [stored({ id: 'p-1', roomId: null, room: null, startTime: time('08:00') })],
        kept: [keptLesson({ id: 'k-s', startTime: time('08:00'), endTime: time('09:00'), roomId: ROOM_2 })],
        needsType: { [SUBJECT]: TYPE },
        everyRoom: [{ id: ROOM_2, roomTypeId: TYPE, roomType: { name: 'Slöjdsal' } }],
      });
      const { warnings } = await service.boardOfYear(YEAR, user);
      expect(warnings).toEqual([{ rowId: 'p-1', requirementId: REQ, code: 'NO_ROOM_FREE', refuses: true, params: { day: 2, start: '08:00', end: '09:00', roomType: 'Slöjdsal' } }]);
    });

    it('says a class that has no lunch left, and is quiet when the school has the lunch off', async () => {
      const lunch = { lunchEnabled: true, lunchStartTime: time('10:30'), lunchEndTime: time('13:00'), lunchMinutes: 30 };
      const rows = [stored({ id: 'p-1', startTime: time('10:30'), minutes: 150, roomId: ROOM_1 })];
      const on = board({ rows, lunch, classes: [GROUP] });
      expect((await on.service.boardOfYear(YEAR, user)).warnings).toEqual([
        { rowId: 'p-1', requirementId: REQ, code: 'CLASS_HAS_NO_LUNCH', refuses: true, params: { day: 2, windowStart: '10:30', windowEnd: '13:00', minutes: 30 } },
      ]);
      const off = board({ rows, lunch: { ...lunch, lunchEnabled: false }, classes: [GROUP] });
      expect((await off.service.boardOfYear(YEAR, user)).warnings).toEqual([]);
      // A meal the school placed by hand for the class that day rescues it.
      const meal = { id: 'm-1', studentGroupId: GROUP, dayOfWeek: 2, startTime: time('12:30'), endTime: time('13:00'), startDate: null, endDate: null };
      const rescued = board({ rows, lunch, classes: [GROUP], meals: [meal] });
      expect((await rescued.service.boardOfYear(YEAR, user)).warnings).toEqual([]);
    });
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

/*
 * FÖRLAGDA BLOCK ON THE POSTS' SIDE (block-placement-judge.ts): a parallel block's lessons are the rows of its members.
 * An ordinary post is judged beside them (besideOf), and the week of förläggningar lists the blocks of the year with a verdict
 * for each lesson and member (boardOfYear, `blocks`) and counts a block's lessons as lessons placed for each member.
 */
describe('RequirementPlacementsService, förlagda block', () => {
  const user = testUser();
  const BLOCK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const BLOCK_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
  const MEMBER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
  const MEMBER_B = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002';
  const MEMBER_C = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000003';
  const MEMBER_D = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000004';
  const YEAR_ROW = { isActive: true, predecessorId: null, gradeNumbering: 'NIOARIG', startDate: new Date('2026-08-17T00:00:00.000Z'), endDate: new Date('2027-06-11T00:00:00.000Z') };

  /** A member post as the block's read and the week's read select it: one lesson of 60, its own class, subject and teacher. */
  const member = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    studentGroupId: `g-${id.slice(-1)}`,
    subjectId: `sub-${id.slice(-1)}`,
    teacherId: `t-${id.slice(-1)}`,
    coTeacherId: null,
    lessonsPerWeek: 1,
    minutesPerLesson: 60,
    lessonLengths: [] as number[],
    recurrence: 'ALL_WEEKS',
    blockId: BLOCK,
    startDate: null,
    endDate: null,
    shares: [] as { teacherId: string | null; lessons: number; minutes: number }[],
    ...over,
  });

  /** A block as the year's read selects it. */
  const blockRead = (over: Record<string, unknown> = {}) => ({
    id: BLOCK,
    name: 'Språkval åk 7',
    sameTimesAsBlockId: null,
    requirements: [member(MEMBER_A), member(MEMBER_B)],
    placements: [blockLesson('r-1')],
    ...over,
  });

  function blockLesson(id: string, over: Record<string, unknown> = {}) {
    return {
      id,
      dayOfWeek: 2,
      startTime: time('10:00'),
      minutes: 60,
      recurrence: 'ALL_WEEKS',
      updatedAt: new Date('2026-11-16T08:00:00.000Z'),
      rooms: [] as { requirementId: string; roomId: string; room: { name: string } }[],
      ...over,
    };
  }

  /** The judge's hits: the lessons of the groups named, on the days named, clash with the first lesson beside them. */
  const clashing = (hits: Array<{ group: string; day: number }>) =>
    async (
      _tx: unknown,
      _basis: unknown,
      lesson: { studentGroupId: string },
      candidate: { dayOfWeek: number },
      options: { against: Array<{ id: string }> },
    ) =>
      hits.some((hit) => hit.group === lesson.studentGroupId && hit.day === candidate.dayOfWeek)
        ? [{ kind: 'TEACHER', message: 'x', masterLessonId: options.against[0]!.id }]
        : [];

  describe('besideOf: the lessons of the year\'s blocks are rows beside a post', () => {
    const otherPostRow = {
      id: 'p-9',
      requirementId: OTHER_REQ,
      dayOfWeek: 4,
      startTime: time('13:00'),
      minutes: 60,
      roomId: ROOM_2,
      recurrence: 'ALL_WEEKS',
      teacherId: null,
      requirement: { studentGroupId: 'g-7b', subjectId: 'sub-ma', teacherId: 'T-9', coTeacherId: null, startDate: null, endDate: null, _count: { shares: 0 } },
    };

    it('lists the other posts\' rows first and then each block lesson as one row per member, with the stored row\'s id and the member\'s own room', async () => {
      const { tx, service } = setup({ beside: [otherPostRow] });
      tx['teachingBlock']!['findMany']!.mockResolvedValue([
        blockRead({ placements: [blockLesson('r-1', { rooms: [{ requirementId: MEMBER_B, roomId: ROOM_2, room: { name: 'Sal 2' } }] })] }),
      ]);
      const beside = await service.besideOf(tx as unknown as PrismaClient, { id: REQ, academicYearId: YEAR });

      expect(beside.map((row) => row.id)).toEqual(['p-9', `r-1:${MEMBER_A}`, `r-1:${MEMBER_B}`]);
      expect(beside[1]).toMatchObject({
        requirementId: MEMBER_A,
        studentGroupId: 'g-1',
        subjectId: 'sub-1',
        teacherId: 't-1',
        dayOfWeek: 2,
        startMinutes: 600,
        minutes: 60,
        roomId: null,
        recurrence: 'ALL_WEEKS',
        inBlock: false,
        blockFit: null,
      });
      expect(beside[2]).toMatchObject({ requirementId: MEMBER_B, roomId: ROOM_2 });
    });

    it('is the other posts\' rows alone when the year has no block with a lesson', async () => {
      const { tx, service } = setup({ beside: [otherPostRow] });
      const beside = await service.besideOf(tx as unknown as PrismaClient, { id: REQ, academicYearId: YEAR });
      expect(beside.map((row) => row.id)).toEqual(['p-9']);
    });

    it('asks only for the blocks that have a lesson, and leaves out the block being written when it is named', async () => {
      const { tx, service } = setup();
      await service.besideOf(tx as unknown as PrismaClient, { id: REQ, academicYearId: YEAR });
      await service.besideOf(tx as unknown as PrismaClient, { id: BLOCK, academicYearId: YEAR }, BLOCK);
      const wheres = tx['teachingBlock']!['findMany']!.mock.calls.map((call) => (call[0] as { where: unknown }).where);
      expect(wheres).toEqual([
        { academicYearId: YEAR, placements: { some: {} } },
        { academicYearId: YEAR, placements: { some: {} }, id: { not: BLOCK } },
      ]);
    });

    it('still leaves out the post itself, whether or not a block is named: the block is judged beside a post as the post is beside the block', async () => {
      const { tx, service } = setup();
      await service.besideOf(tx as unknown as PrismaClient, { id: REQ, academicYearId: YEAR });
      const read = tx['teachingRequirementPlacement']!['findMany']!.mock.calls[0]![0] as { where: Record<string, unknown> };
      expect(read.where).toEqual({ requirement: { academicYearId: YEAR }, requirementId: { not: REQ } });
    });

    it('is what a post\'s own rows are read against: the dialog\'s read and save both hold a lesson to a member\'s lesson, naming the member\'s class', async () => {
      const member7b = member(MEMBER_A, { studentGroupId: 'g-7b', subjectId: 'sub-ma', teacherId: TEACHER });
      const lesson = blockRead({ requirements: [member7b], placements: [blockLesson('r-1')] });

      const read = setup({ rows: [stored()] });
      read.tx['teachingBlock']!['findMany']!.mockResolvedValue([lesson]);
      await read.service.listOfPost(REQ, user);
      const against = (read.masters.findConflicts.mock.calls[0]![4] as { against: Array<{ id: string }> }).against.map((one) => one.id);
      expect(against).toEqual([`placement:r-1:${MEMBER_A}`]);

      const save = setup();
      save.tx['teachingBlock']!['findMany']!.mockResolvedValue([lesson]);
      save.masters.findConflicts.mockImplementation(clashing([{ group: GROUP, day: 2 }]));
      await expect(save.service.replace(REQ, { placements: [input()] }, user)).rejects.toMatchObject({
        status: 409,
        response: {
          code: 'REQUIREMENT_PLACEMENT_REFUSED',
          params: { index: 0, reason: 'TEACHER', otherKind: 'PLACEMENT', className: '7B', subjectName: 'Matematik', day: 2, start: '10:00', end: '11:00' },
        },
      });
      expect(save.tx['teachingRequirementPlacement']!['createMany']).not.toHaveBeenCalled();
    });

    it('says a block lesson that no longer fits its block by name beside the post\'s own rows, as the block says it itself', async () => {
      const { tx, service } = setup();
      tx['teachingBlock']!['findMany']!.mockResolvedValue([blockRead({ placements: [blockLesson('r-1', { minutes: 45 })] })]);
      const beside = await service.besideOf(tx as unknown as PrismaClient, { id: REQ, academicYearId: YEAR });
      expect(beside.map((row) => row.blockFit)).toEqual(['LENGTH', 'LENGTH']);
    });
  });

  describe('boardOfYear: the field `blocks`', () => {
    const post = (over: Record<string, unknown> = {}) => {
      const { academicYear: _academicYear, schoolId: _schoolId, academicYearId: _year, ...rest } = POST;
      return { ...rest, ...over };
    };

    function board(world: World & { posts?: Array<Record<string, unknown>>; blocks?: Array<Record<string, unknown>>; meals?: unknown[] } = {}) {
      const made = setup(world);
      made.tx['academicYear']!['findUnique']!.mockResolvedValue(YEAR_ROW);
      made.tx['teachingRequirement']!['findMany']!.mockResolvedValue(world.posts ?? [post()]);
      made.tx['lunchSitting']!['findMany']!.mockResolvedValue(world.meals ?? []);
      made.tx['teachingBlock']!['findMany']!.mockResolvedValue(world.blocks ?? []);
      return made;
    }

    const memberPosts = [member(MEMBER_A), member(MEMBER_B)];

    it('answers an empty list for a year with no block, and reads the blocks of the year once', async () => {
      const { tx, service } = board();
      const answer = await service.boardOfYear(YEAR, user);
      expect(answer.blocks).toEqual([]);
      expect(tx['teachingBlock']!['findMany']).toHaveBeenCalledTimes(1);
      expect((tx['teachingBlock']!['findMany']!.mock.calls[0]![0] as { where: unknown }).where).toEqual({ academicYearId: YEAR });
    });

    it('lists a block with its members, lengths, weeks and lessons, and a verdict for each member of each lesson', async () => {
      const { service } = board({
        posts: memberPosts,
        blocks: [blockRead({ placements: [blockLesson('r-1', { rooms: [{ requirementId: MEMBER_B, roomId: ROOM_1, room: { name: 'Simhallen' } }] })] })],
      });
      const [one] = (await service.boardOfYear(YEAR, user)).blocks;
      expect(one).toMatchObject({
        id: BLOCK,
        name: 'Språkval åk 7',
        memberIds: [MEMBER_A, MEMBER_B],
        lengths: [60],
        recurrence: 'ALL_WEEKS',
        followsBlockId: null,
        cannotPlace: null,
      });
      expect(one!.rows).toEqual([
        {
          id: 'r-1',
          dayOfWeek: 2,
          startTime: '10:00',
          endTime: '11:00',
          minutes: 60,
          recurrence: 'ALL_WEEKS',
          rooms: [{ requirementId: MEMBER_B, roomId: ROOM_1, roomName: 'Simhallen' }],
          changedAt: '2026-11-16T08:00:00.000Z',
          verdicts: [
            { requirementId: MEMBER_A, ok: true },
            { requirementId: MEMBER_B, ok: true },
          ],
        },
      ]);
      expect(one!.rowsKey).toMatch(/^[0-9a-f]{32}$/);
    });

    it('says which member a lesson is refused for, and why, on that lesson', async () => {
      const two = [member(MEMBER_A, { lessonsPerWeek: 2 }), member(MEMBER_B, { lessonsPerWeek: 2 })];
      const { masters, service } = board({
        posts: two,
        blocks: [blockRead({ requirements: two, placements: [blockLesson('r-1'), blockLesson('r-2', { dayOfWeek: 4, startTime: time('13:30') })] })],
      });
      masters.findConflicts.mockImplementation(clashing([{ group: 'g-2', day: 4 }]));
      const [one] = (await service.boardOfYear(YEAR, user)).blocks;
      expect(one!.rows[0]!.verdicts).toEqual([
        { requirementId: MEMBER_A, ok: true },
        { requirementId: MEMBER_B, ok: true },
      ]);
      expect(one!.rows[1]!.verdicts).toEqual([
        { requirementId: MEMBER_A, ok: true },
        { requirementId: MEMBER_B, ok: false, reason: 'TEACHER', params: expect.objectContaining({ otherKind: 'PLACEMENT', day: 4, start: '13:30', end: '14:30' }) },
      ]);
    });

    it('judges the posts\' rows and the blocks\' rows in ONE call, the posts\' first and one row per lesson and member, beside nothing', async () => {
      const spy = jest.spyOn(placementJudge, 'judgePlacements');
      try {
        const { service, masters } = board({ posts: [post(), ...memberPosts], rows: [stored({ id: 'p-1' })], blocks: [blockRead()] });
        await service.boardOfYear(YEAR, user);
        expect(spy).toHaveBeenCalledTimes(1);
        const asked = spy.mock.calls[0]![2];
        expect(asked.rows.map((row) => row.id)).toEqual(['p-1', `r-1:${MEMBER_A}`, `r-1:${MEMBER_B}`]);
        expect(asked.beside).toEqual([]);
        expect(masters.findConflicts).toHaveBeenCalledTimes(3);
        expect(rostersOfYear).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
    });

    it('judges a year whose only förläggningar are a block\'s', async () => {
      const { masters, service } = board({ posts: memberPosts, blocks: [blockRead()] });
      await service.boardOfYear(YEAR, user);
      expect(masters.findConflicts).toHaveBeenCalledTimes(2);
      expect(rostersOfYear).toHaveBeenCalledTimes(1);
    });

    it('lists a block with no lesson, which judges nothing and reads no classes', async () => {
      const { masters, service } = board({ posts: memberPosts, blocks: [blockRead({ placements: [] })] });
      const answer = await service.boardOfYear(YEAR, user);
      expect(answer.blocks).toEqual([expect.objectContaining({ id: BLOCK, rows: [], cannotPlace: null })]);
      expect(masters.findConflicts).not.toHaveBeenCalled();
      expect(rostersOfYear).not.toHaveBeenCalled();
      expect(readBoardFacts).not.toHaveBeenCalled();
    });

    it('gives each block its own verdicts when there are several, after the posts\' rows: a refusal is never read on another block', async () => {
      const second = blockRead({
        id: BLOCK_2,
        name: 'Språkval åk 8',
        requirements: [member(MEMBER_C, { blockId: BLOCK_2 }), member(MEMBER_D, { blockId: BLOCK_2 })],
        placements: [blockLesson('r-2', { dayOfWeek: 3 })],
      });
      const { masters, service } = board({
        posts: [post(), ...memberPosts, member(MEMBER_C, { blockId: BLOCK_2 }), member(MEMBER_D, { blockId: BLOCK_2 })],
        rows: [stored({ id: 'p-1' })],
        blocks: [blockRead(), second],
      });
      // Only the second block's last member is refused.
      masters.findConflicts.mockImplementation(clashing([{ group: 'g-4', day: 3 }]));
      const answer = await service.boardOfYear(YEAR, user);
      expect(answer.placements.map((row) => row.verdict.ok)).toEqual([true]);
      expect(answer.blocks.map((one) => one.id)).toEqual([BLOCK, BLOCK_2]);
      expect(answer.blocks[0]!.rows[0]!.verdicts.map((verdict) => verdict.ok)).toEqual([true, true]);
      expect(answer.blocks[1]!.rows[0]!.verdicts).toEqual([
        { requirementId: MEMBER_C, ok: true },
        { requirementId: MEMBER_D, ok: false, reason: 'TEACHER', params: expect.objectContaining({ day: 3 }) },
      ]);
      // And the post's own row is not read as a block's: the refusal on the first block would have come from here.
      expect(answer.placements[0]!.verdict).toEqual({ ok: true });
    });

    it('does the same for a refusal of the first block, so that the offset of the second is not luck', async () => {
      const second = blockRead({
        id: BLOCK_2,
        requirements: [member(MEMBER_C, { blockId: BLOCK_2 }), member(MEMBER_D, { blockId: BLOCK_2 })],
        placements: [blockLesson('r-2', { dayOfWeek: 3 })],
      });
      const { masters, service } = board({
        posts: [post(), ...memberPosts, member(MEMBER_C, { blockId: BLOCK_2 }), member(MEMBER_D, { blockId: BLOCK_2 })],
        rows: [stored({ id: 'p-1' }), stored({ id: 'p-2', dayOfWeek: 5 })],
        blocks: [blockRead(), second],
      });
      masters.findConflicts.mockImplementation(clashing([{ group: 'g-1', day: 2 }, { group: 'g-5', day: 5 }]));
      const answer = await service.boardOfYear(YEAR, user);
      expect(answer.blocks[0]!.rows[0]!.verdicts.map((verdict) => [verdict.requirementId, verdict.ok])).toEqual([[MEMBER_A, false], [MEMBER_B, true]]);
      expect(answer.blocks[1]!.rows[0]!.verdicts.map((verdict) => verdict.ok)).toEqual([true, true]);
      expect(answer.placements.map((row) => row.verdict.ok)).toEqual([true, true]);
    });

    it('counts a block\'s lessons as lessons placed for each of its members: the post\'s `placed` and `left`', async () => {
      const posts = [member(MEMBER_A, { lessonsPerWeek: 2 }), member(MEMBER_B, { lessonsPerWeek: 2 })];
      const { service } = board({ posts, blocks: [blockRead({ requirements: posts })] });
      const answer = await service.boardOfYear(YEAR, user);
      expect(answer.posts.map((one) => one.parts[0])).toEqual([
        expect.objectContaining({ count: 2, locked: 0, placed: 1, left: 1 }),
        expect.objectContaining({ count: 2, locked: 0, placed: 1, left: 1 }),
      ]);
    });

    it('counts a lesson of an odd-weeks block for a member of odd weeks, and leaves a post of a block with no lesson as it was', async () => {
      const odd = [member(MEMBER_A, { recurrence: 'ODD_WEEKS' }), member(MEMBER_B, { recurrence: 'ODD_WEEKS' })];
      const { service } = board({ posts: [...odd, member(MEMBER_C, { blockId: BLOCK_2 })], blocks: [blockRead({ requirements: odd, placements: [blockLesson('r-1', { recurrence: 'ODD_WEEKS' })] }), blockRead({ id: BLOCK_2, requirements: [member(MEMBER_C, { blockId: BLOCK_2 })], placements: [] })] });
      const answer = await service.boardOfYear(YEAR, user);
      expect(answer.posts.map((one) => one.parts[0]!.placed)).toEqual([1, 1, 0]);
      expect(answer.blocks[0]!.recurrence).toBe('ODD_WEEKS');
    });

    it('adds a block\'s lessons to a member\'s own: a member that is also placed by hand (stored before it joined the block) counts both', async () => {
      const posts = [member(MEMBER_A, { lessonsPerWeek: 3 }), member(MEMBER_B, { lessonsPerWeek: 3 })];
      const { service } = board({
        posts,
        rows: [stored({ id: 'p-own', requirementId: MEMBER_A, dayOfWeek: 5 })],
        blocks: [blockRead({ requirements: posts })],
      });
      const answer = await service.boardOfYear(YEAR, user);
      expect(answer.posts.map((one) => one.parts[0]!.placed)).toEqual([2, 1]);
      // The post's own row is still said to be a row of a post in a block.
      expect(answer.placements[0]!.verdict).toEqual({ ok: false, reason: 'BLOCK' });
    });

    it('refuses a member whose locks already answer its lessons the lesson the block places (OVER_DEMAND), by member', async () => {
      const lock = {
        id: 'k-1',
        dayOfWeek: 5,
        startTime: time('13:00'),
        endTime: time('14:00'),
        studentGroupId: 'g-1',
        subjectId: 'sub-1',
        teacherId: 't-1',
        coTeacherId: null,
        roomId: null,
        recurrence: 'ALL_WEEKS',
        startDate: null,
        endDate: null,
        isLocked: true,
        isGenerated: false,
        subject: { name: 'Spanska' },
        studentGroup: { name: '7A' },
        extraGroups: [],
        participants: [],
      };
      const { service } = board({ posts: memberPosts, kept: [lock], blocks: [blockRead()] });
      const [one] = (await service.boardOfYear(YEAR, user)).blocks;
      expect(one!.rows[0]!.verdicts).toEqual([
        { requirementId: MEMBER_A, ok: false, reason: 'OVER_DEMAND' },
        { requirementId: MEMBER_B, ok: true },
      ]);
    });

    it('warns a block lesson on the block’s own row: its id, the member whose teacher it is about, and the block (D1)', async () => {
      const keptHour = {
        id: 'k-1',
        dayOfWeek: 2,
        startTime: time('08:00'),
        endTime: time('09:00'),
        studentGroupId: 'g-9',
        subjectId: 'sub-9',
        teacherId: 't-1',
        coTeacherId: null,
        roomId: null,
        recurrence: 'ALL_WEEKS',
        startDate: null,
        endDate: null,
        isLocked: true,
        isGenerated: false,
        subject: { name: 'Matematik' },
        studentGroup: { name: '9A' },
        extraGroups: [],
        participants: [],
      };
      // Member A's teacher (t-1) keeps an hour on Tuesday and the block puts its lesson there at 10:00: two hours against a cap of 90.
      const withRoom = blockLesson('r-1', { rooms: [{ requirementId: MEMBER_A, roomId: ROOM_1, room: { name: 'Simhallen' } }] });
      const { tx, service } = board({ posts: memberPosts, kept: [keptHour], blocks: [blockRead({ placements: [withRoom] })] });
      tx['teacherWorkRule']!['findMany']!.mockResolvedValue([{ userId: 't-1', maxTeachingMinutesPerDay: 90 }]);
      const answer = await service.boardOfYear(YEAR, user);
      // A lesson with the member's room is a lock to the engine: the week is the school's own, and Generera takes it.
      expect(answer.warnings).toEqual([
        { rowId: 'r-1', requirementId: MEMBER_A, blockId: BLOCK, code: 'TEACHER_DAY_TOO_LONG', refuses: false, params: { day: 2, minutes: 120, cap: 90 } },
      ]);
      // The lesson of member B (another teacher, no rule) says nothing.
      expect(answer.warnings.some((warning) => warning.requirementId === MEMBER_B)).toBe(false);
      // The same lesson with no room for the member is a pinned lesson, which the engine holds to the cap: it refuses.
      const pinned = board({ posts: memberPosts, kept: [keptHour], blocks: [blockRead({ placements: [blockLesson('r-1')] })] });
      pinned.tx['teacherWorkRule']!['findMany']!.mockResolvedValue([{ userId: 't-1', maxTeachingMinutesPerDay: 90 }]);
      expect((await pinned.service.boardOfYear(YEAR, user)).warnings[0]).toMatchObject({ rowId: 'r-1', refuses: true });
    });

    it('says a block that cannot be placed, with the lessons it holds still listed', async () => {
      const { service } = board({ posts: memberPosts, blocks: [blockRead({ sameTimesAsBlockId: 'leader' })] });
      const [one] = (await service.boardOfYear(YEAR, user)).blocks;
      expect(one).toMatchObject({ cannotPlace: 'FOLLOWER', followsBlockId: 'leader' });
      expect(one!.rows).toHaveLength(1);
      expect(one!.rows[0]!.verdicts.every((verdict) => !verdict.ok && verdict.reason === 'BLOCK_FIT' && verdict.params?.['rule'] === 'FOLLOWER')).toBe(true);
    });
  });
});

describe('RequirementPlacementsService: warnings on a save and a read of one post (D1)', () => {
  const user = testUser({ schoolId: 'the-callers-school' });
  const CAP_90 = [{ userId: TEACHER, maxTeachingMinutesPerDay: 90 }];
  const keptTuesday = {
    id: 'k-8',
    dayOfWeek: 2,
    startTime: time('08:00'),
    endTime: time('09:00'),
    studentGroupId: GROUP,
    subjectId: SUBJECT,
    teacherId: TEACHER,
    coTeacherId: null,
    roomId: ROOM_2,
    recurrence: 'ALL_WEEKS',
    startDate: null,
    endDate: null,
    subject: { name: 'Idrott och hälsa' },
    studentGroup: { name: '7A' },
    extraGroups: [],
    participants: [],
  };
  const OVER = { code: 'TEACHER_DAY_TOO_LONG', refuses: false, params: { day: 2, minutes: 120, cap: 90 } };

  it('saves a row that takes the teacher over the cap, and says so at the row the answer has it at', async () => {
    const { tx, service } = setup({ kept: [keptTuesday], workRules: CAP_90, rows: [stored({ id: 'p-new', startTime: time('10:00') })] });
    const answer = await service.replace(REQ, { placements: [input({ startTime: '10:00' })] }, user);
    // Nothing is refused: the row is written and the verdict is clean.
    expect(tx['teachingRequirementPlacement']!['createMany']).toHaveBeenCalledTimes(1);
    expect(answer.verdicts).toEqual([{ index: 0, ok: true }]);
    expect(answer.warnings).toEqual([{ rowId: 'p-new', requirementId: REQ, ...OVER }]);
  });

  it('states each warning at the place of its row in the answer, which is the stored order and not the order sent', async () => {
    const writtenOrder = [stored({ id: 'p-a', dayOfWeek: 2, startTime: time('10:00') }), stored({ id: 'p-b', dayOfWeek: 4, startTime: time('09:00') })];
    const { service } = setup({ kept: [keptTuesday], workRules: CAP_90, rows: writtenOrder });
    // Sent with Thursday first; stored with Tuesday first. The warning is about Tuesday's row, the first of the answer.
    const answer = await service.replace(REQ, { placements: [input({ dayOfWeek: 4, startTime: '09:00' }), input({ dayOfWeek: 2, startTime: '10:00' })] }, user);
    expect(answer.warnings).toEqual([{ rowId: 'p-a', requirementId: REQ, ...OVER }]);
  });

  it('says it again when the post is read, so that a row seen later carries the same words', async () => {
    const { service } = setup({ kept: [keptTuesday], workRules: CAP_90, rows: [stored({ id: 'p-1', startTime: time('10:00') })] });
    const read = await service.listOfPost(REQ, user);
    expect(read.warnings).toEqual([{ rowId: 'p-1', requirementId: REQ, ...OVER }]);
  });

  it('reads no kept lesson of its own for a school with no rule, lunch or row without a room', async () => {
    const { tx, service } = setup({ kept: [keptTuesday], rows: [stored({ id: 'p-1' })] });
    await service.listOfPost(REQ, user);
    // The judge's two reads (the day's lessons and the post's locks), and none for the warnings.
    expect(tx['masterLesson']!['findMany']).toHaveBeenCalledTimes(2);
  });

  it('asks the kept lessons of the ruled teachers only when a rule is there', async () => {
    const { tx, service } = setup({ kept: [keptTuesday], workRules: CAP_90, rows: [stored({ id: 'p-1', startTime: time('10:00') })] });
    await service.listOfPost(REQ, user);
    expect(tx['masterLesson']!['findMany']).toHaveBeenCalledTimes(3);
    const arms = (tx['masterLesson']!['findMany']!.mock.calls[2]![0] as { where: { AND: [unknown, { OR: unknown[] }] } }).where.AND[1].OR;
    expect(arms).toEqual([{ teacherId: { in: [TEACHER] } }, { coTeacherId: { in: [TEACHER] } }]);
  });
});
