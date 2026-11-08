import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import type { MasterLessonsService } from '../calendar/master-lessons.service';
import type { PrismaService } from '../database/prisma.service';
import { lockYearForGrundschemaEdit } from '../optimization/regeneration-lock';
import { readOtherSchoolHolds } from '../optimization/other-school-holds';
import { readBoardFacts } from '../swaps/board-rules';
import { rostersOfYear } from '../year-rollover/projected-rosters';
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
  _count: { shares: 0 },
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
  room: { name: 'Simhallen' },
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
          requirement: { studentGroupId: 'g-7b', subjectId: 'sub-ma', teacherId: 'T-9', coTeacherId: null, startDate: null, endDate: null },
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
      expect(tx['teachingRequirementPlacement']!['deleteMany']).toHaveBeenCalledWith({ where: { requirementId: REQ } });
      // schoolId is the post's, not the caller's; startTime is the @db.Time the table stores.
      expect(tx['teachingRequirementPlacement']!['createMany']).toHaveBeenCalledWith({
        data: [
          { schoolId: SCHOOL, requirementId: REQ, dayOfWeek: 2, startTime: time('10:00'), minutes: 60, roomId: ROOM_1, recurrence: 'ALL_WEEKS' },
          { schoolId: SCHOOL, requirementId: REQ, dayOfWeek: 4, startTime: time('13:30'), minutes: 60, roomId: ROOM_2, recurrence: 'ALL_WEEKS' },
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
        ['SHARES', { _count: { shares: 1 } }, [input()]],
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
  });
});
