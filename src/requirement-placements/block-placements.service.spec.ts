import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import type { MasterLessonsService } from '../calendar/master-lessons.service';
import type { PrismaService } from '../database/prisma.service';
import { lockYearForGrundschemaEdit } from '../optimization/regeneration-lock';
import { readOtherSchoolHolds } from '../optimization/other-school-holds';
import { readBoardFacts } from '../swaps/board-rules';
import { rostersOfYear } from '../year-rollover/projected-rosters';
import { blockRowsKeyOf } from './block-placement-judge';
import { BlockPlacementsService } from './block-placements.service';
import type { ReplaceBlockPlacementsDto } from './dto/block-placements.dto';
import type { RequirementPlacementsService } from './requirement-placements.service';

jest.mock('../year-rollover/projected-rosters', () => ({ rostersOfYear: jest.fn() }));
jest.mock('../optimization/regeneration-lock', () => ({ lockYearForGrundschemaEdit: jest.fn() }));
jest.mock('../swaps/board-rules', () => ({ ...jest.requireActual('../swaps/board-rules'), readBoardFacts: jest.fn() }));
jest.mock('../optimization/other-school-holds', () => ({
  ...jest.requireActual('../optimization/other-school-holds'),
  readOtherSchoolHolds: jest.fn(),
}));

const SCHOOL = '33333333-3333-4333-8333-333333333333';
const YEAR = '99999999-9999-4999-8999-999999999999';
const BLOCK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const B = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002';
const C = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000003';
const ROOM_1 = '11111111-1111-4111-8111-111111111111';
const ROOM_2 = '22222222-2222-4222-8222-222222222222';
const BASIS = { kind: 'CURRENT' } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const time = (value: string): Date => new Date(`1970-01-01T${value}:00.000Z`);

/** A member as the block's read selects it: two lessons of 60 every week, its own class, subject and teacher. */
const memberRow = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  studentGroupId: `g-${id.slice(-1)}`,
  subjectId: `sub-${id.slice(-1)}`,
  teacherId: `t-${id.slice(-1)}`,
  coTeacherId: null,
  lessonsPerWeek: 2,
  minutesPerLesson: 60,
  lessonLengths: [] as number[],
  recurrence: 'ALL_WEEKS',
  blockId: BLOCK,
  startDate: null,
  endDate: null,
  shares: [] as { teacherId: string | null; lessons: number; minutes: number }[],
  ...over,
});

/** A stored lesson of the block as the read selects it. */
const storedRow = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  dayOfWeek: 2,
  startTime: time('10:00'),
  minutes: 60,
  recurrence: 'ALL_WEEKS',
  updatedAt: new Date('2026-11-16T08:00:00.000Z'),
  rooms: [] as { requirementId: string; roomId: string; room: { name: string } }[],
  ...over,
});

/** A lesson as the request states it. */
const input = (over: Record<string, unknown> = {}) => ({ dayOfWeek: 2, startTime: '10:00', minutes: 60, ...over });
const dto = (placements: unknown[], baseKey?: string): ReplaceBlockPlacementsDto =>
  ({ placements, ...(baseKey === undefined ? {} : { baseKey }) }) as unknown as ReplaceBlockPlacementsDto;

/** The key of the lessons the stored rows say, as a client reads it. */
const keyOf = (rows: ReturnType<typeof storedRow>[]): string =>
  blockRowsKeyOf(
    rows.map((row) => ({
      id: row.id,
      dayOfWeek: row.dayOfWeek,
      startMinutes: row.startTime.getUTCHours() * 60 + row.startTime.getUTCMinutes(),
      minutes: row.minutes,
      recurrence: row.recurrence as 'ALL_WEEKS',
      rooms: row.rooms.map(({ requirementId, roomId }) => ({ requirementId, roomId })),
    })),
  );

const blockError = (reason: string, originalCode = 'BP409'): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError('Database error', {
    code: 'P2039',
    clientVersion: Prisma.prismaVersion.client,
    meta: {
      driverAdapterError: {
        cause: {
          originalCode,
          originalMessage: `${reason}: blockets förläggningar passar inte blocket`,
          detail: `blockId=${BLOCK} reason=${reason}`,
        },
      },
    },
  });

interface World {
  /** The block's members; the default is three. */
  members?: ReturnType<typeof memberRow>[];
  /** The block's lessons as stored. */
  rows?: ReturnType<typeof storedRow>[];
  /** What a read AFTER the block's lock sees, when another writer committed while this one waited. */
  rowsAfterLock?: ReturnType<typeof storedRow>[];
  follows?: string | null;
  /** The block is not there (404). */
  block?: null;
  /** The block is gone when it is read the second time (after the lock). */
  goneAfterLock?: boolean;
  year?: null | { isActive: boolean; predecessorId: string | null; gradeNumbering: string };
  /** The rooms the school has. */
  rooms?: string[];
}

const NAMES: Record<string, string> = {
  'g-1': 'Spanska 7',
  'g-2': 'Tyska 7',
  'g-3': 'Franska 7',
  'sub-1': 'Spanska',
  'sub-2': 'Tyska',
  'sub-3': 'Franska',
};

function setup(world: World = {}) {
  const tx: TxMock = createTxMock();
  const prisma = createPrismaMock(tx) as unknown as PrismaService;
  const masters = { findConflicts: jest.fn().mockResolvedValue([]) };
  const posts = { besideOf: jest.fn().mockResolvedValue([]), locksOf: jest.fn().mockResolvedValue([]) };
  const state = { rows: world.rows ?? [], reads: 0 };

  tx['teachingBlock']!['findUnique']!.mockImplementation(async () => {
    state.reads++;
    if (world.block === null) return null;
    if (world.goneAfterLock && state.reads >= 2) return null;
    const rows = world.rowsAfterLock !== undefined && state.reads === 2 ? world.rowsAfterLock : state.rows;
    return {
      id: BLOCK,
      name: 'Språkval åk 7',
      academicYearId: YEAR,
      schoolId: SCHOOL,
      sameTimesAsBlockId: world.follows ?? null,
      requirements: world.members ?? [memberRow(A), memberRow(B), memberRow(C)],
      placements: rows,
    };
  });
  tx['academicYear']!['findUnique']!.mockResolvedValue(
    world.year === undefined ? { isActive: true, predecessorId: null, gradeNumbering: 'NIOARIG' } : world.year,
  );
  const named = async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => ({ id, name: NAMES[id] ?? id }));
  tx['subject']!['findMany']!.mockImplementation(named);
  tx['studentGroup']!['findMany']!.mockImplementation(named);
  tx['room']!['findMany']!.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
    where.id.in.filter((id) => (world.rooms ?? [ROOM_1, ROOM_2]).includes(id)).map((id) => ({ id })),
  );
  // The table keeps what is written, so that the answer after the write lists it: the old lessons go, the new ones come in.
  tx['teachingBlockPlacement']!['deleteMany']!.mockImplementation(async () => {
    state.rows = [];
    return { count: 0 };
  });
  tx['teachingBlockPlacement']!['createMany']!.mockImplementation(async ({ data }: { data: Array<Record<string, unknown>> }) => {
    state.rows = [
      ...state.rows,
      ...data.map((row) =>
        storedRow(row['id'] as string, {
          dayOfWeek: row['dayOfWeek'],
          startTime: row['startTime'],
          minutes: row['minutes'],
          recurrence: row['recurrence'],
          updatedAt: new Date('2026-11-16T09:00:00.000Z'),
        }),
      ),
    ];
    return { count: data.length };
  });
  tx['teachingBlockPlacementRoom']!['createMany']!.mockImplementation(async ({ data }: { data: Array<Record<string, unknown>> }) => {
    for (const room of data) {
      const row = state.rows.find((one) => one.id === room['placementId']);
      row?.rooms.push({ requirementId: room['requirementId'] as string, roomId: room['roomId'] as string, room: { name: `Sal ${(room['roomId'] as string).slice(0, 1)}` } });
      row?.rooms.sort((x, y) => (x.requirementId < y.requirementId ? -1 : 1));
    }
    return { count: data.length };
  });
  const service = new BlockPlacementsService(prisma, masters as unknown as MasterLessonsService, posts as unknown as RequirementPlacementsService);
  return { tx, prisma, masters, posts, service, state };
}

beforeEach(() => {
  (rostersOfYear as jest.Mock).mockReset().mockResolvedValue(BASIS);
  (lockYearForGrundschemaEdit as jest.Mock).mockReset().mockResolvedValue(undefined);
  (readBoardFacts as jest.Mock).mockReset().mockResolvedValue({ frames: [], sittings: new Map(), gradeRules: [], spans: new Map() });
  (readOtherSchoolHolds as jest.Mock).mockReset().mockResolvedValue({ holds: [] });
});

/** The week holds every lesson but the ones a test names: findConflicts' hits by (class, day). */
const clashing = (hits: Array<{ group: string; day: number; kind?: 'TEACHER' | 'ROOM' }>) =>
  async (
    _tx: unknown,
    _basis: unknown,
    lesson: { studentGroupId: string },
    candidate: { dayOfWeek: number },
    options: { against: Array<{ id: string }> },
  ) => {
    const hit = hits.find((one) => one.group === lesson.studentGroupId && one.day === candidate.dayOfWeek);
    return hit === undefined ? [] : [{ kind: hit.kind ?? 'TEACHER', message: 'x', masterLessonId: options.against[0]!.id }];
  };

describe('BlockPlacementsService', () => {
  const user = testUser({ schoolId: 'the-callers-school' });

  describe('listOfBlock', () => {
    it('answers 404 for a block the caller cannot see, and reads nothing else', async () => {
      const { tx, prisma, service } = setup({ block: null });
      await expect(service.listOfBlock(BLOCK, user)).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx['academicYear']!['findUnique']).not.toHaveBeenCalled();
      expect(rostersOfYear).not.toHaveBeenCalled();
    });

    it('answers a block with no lesson without judging anything or reading the year\'s classes: its key, and the lengths the dialog offers', async () => {
      const { tx, masters, posts, service } = setup();
      await expect(service.listOfBlock(BLOCK, user)).resolves.toEqual({ placements: [], verdicts: [], rowsKey: blockRowsKeyOf([]), lengths: [60, 60] });
      expect(masters.findConflicts).not.toHaveBeenCalled();
      expect(rostersOfYear).not.toHaveBeenCalled();
      expect(tx['academicYear']!['findUnique']).not.toHaveBeenCalled();
      expect(posts.besideOf).not.toHaveBeenCalled();
    });

    it('lists the lessons as the views the dialog shows, and the lengths longest first', async () => {
      const members = [memberRow(A, { lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40] }), memberRow(B, { lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40] })];
      const rows = [storedRow('r-1', { startTime: time('09:05'), minutes: 80, rooms: [{ requirementId: B, roomId: ROOM_1, room: { name: 'Simhallen' } }] })];
      const { service } = setup({ members, rows });
      const answer = await service.listOfBlock(BLOCK, user);
      expect(answer.placements).toEqual([
        {
          id: 'r-1',
          blockId: BLOCK,
          dayOfWeek: 2,
          startTime: '09:05',
          endTime: '10:25',
          minutes: 80,
          recurrence: 'ALL_WEEKS',
          rooms: [{ requirementId: B, roomId: ROOM_1, roomName: 'Simhallen' }],
        },
      ]);
      expect(answer.lengths).toEqual([80, 40]);
      expect(answer.rowsKey).toBe(keyOf(rows));
    });

    it('judges every lesson now, one verdict per lesson and member in the members\' id order, and says the member and the other lesson', async () => {
      const rows = [storedRow('r-1'), storedRow('r-2', { dayOfWeek: 4, startTime: time('13:30') })];
      const { masters, service } = setup({ rows });
      masters.findConflicts.mockImplementation(clashing([{ group: 'g-2', day: 4 }]));

      const answer = await service.listOfBlock(BLOCK, user);

      expect(masters.findConflicts).toHaveBeenCalledTimes(6);
      expect(answer.verdicts).toEqual([
        { index: 0, requirementId: A, ok: true },
        { index: 0, requirementId: B, ok: true },
        { index: 0, requirementId: C, ok: true },
        { index: 1, requirementId: A, ok: true },
        {
          index: 1,
          requirementId: B,
          ok: false,
          reason: 'TEACHER',
          params: expect.objectContaining({ otherKind: 'PLACEMENT', day: 4, start: '13:30', end: '14:30' }),
        },
        { index: 1, requirementId: C, ok: true },
      ]);
    });

    it('holds each member\'s row as its own post\'s: its class, subject and teacher, and the room that member chose', async () => {
      const rows = [storedRow('r-1', { rooms: [{ requirementId: B, roomId: ROOM_2, room: { name: 'Sal 2' } }] })];
      const { masters, service } = setup({ rows });
      await service.listOfBlock(BLOCK, user);
      const asked = masters.findConflicts.mock.calls.map(([, , lesson, candidate]) => ({ lesson, candidate }));
      expect(asked.map((call) => call.lesson)).toEqual([
        { id: null, academicYearId: YEAR, studentGroupId: 'g-1', subjectId: 'sub-1' },
        { id: null, academicYearId: YEAR, studentGroupId: 'g-2', subjectId: 'sub-2' },
        { id: null, academicYearId: YEAR, studentGroupId: 'g-3', subjectId: 'sub-3' },
      ]);
      expect(asked.map((call) => [call.candidate.teacherId, call.candidate.roomId, call.candidate.dayOfWeek, call.candidate.startMinutes, call.candidate.endMinutes])).toEqual([
        ['t-1', null, 2, 600, 660],
        ['t-2', ROOM_2, 2, 600, 660],
        ['t-3', null, 2, 600, 660],
      ]);
    });

    it('judges on the year\'s own roster basis, as the school the caller is in, and hands the judge the year\'s grade numbering', async () => {
      const { service } = setup({ rows: [storedRow('r-1')], year: { isActive: false, predecessorId: 'old-year', gradeNumbering: 'TIOARIG' } });
      await service.listOfBlock(BLOCK, user);
      expect(rostersOfYear).toHaveBeenCalledWith(expect.anything(), user, YEAR, { isActive: false, predecessorId: 'old-year' });
      expect(readBoardFacts).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ schoolId: 'the-callers-school', academicYearId: YEAR, gradeNumbering: 'TIOARIG', basis: BASIS }));
    });

    it('asks for the year\'s other förläggningar leaving the block itself out, and holds the block against what comes back', async () => {
      const beside = {
        id: 'p-9',
        requirementId: 'req-9',
        studentGroupId: 'g-9',
        subjectId: 'sub-9',
        teacherId: 'T-9',
        coTeacherId: null,
        dayOfWeek: 2,
        startMinutes: 600,
        minutes: 60,
        roomId: null,
        recurrence: 'ALL_WEEKS',
        startDate: null,
        endDate: null,
      };
      const { masters, posts, tx, service } = setup({ rows: [storedRow('r-1')] });
      posts.besideOf.mockResolvedValue([beside]);
      await service.listOfBlock(BLOCK, user);
      expect(posts.besideOf).toHaveBeenCalledWith(tx, { id: BLOCK, academicYearId: YEAR }, BLOCK);
      const against = (masters.findConflicts.mock.calls[0]![4] as { against: Array<{ id: string }> }).against.map((lesson) => lesson.id);
      expect(against).toContain('placement:p-9');
    });

    it('asks each member\'s covering locks and refuses the member whose locks already answer the lessons the block places (OVER_DEMAND)', async () => {
      const { masters, posts, tx, service } = setup({ rows: [storedRow('r-1')] });
      posts.locksOf.mockImplementation(async (_tx: unknown, post: { id: string }) =>
        post.id === A ? [{ minutes: 60, teacherId: 't-1' }, { minutes: 60, teacherId: 't-1' }] : [],
      );
      const answer = await service.listOfBlock(BLOCK, user);
      expect(posts.locksOf).toHaveBeenCalledTimes(3);
      expect(posts.locksOf).toHaveBeenCalledWith(tx, expect.objectContaining({ id: A, academicYearId: YEAR, studentGroupId: 'g-1', subjectId: 'sub-1', recurrence: 'ALL_WEEKS' }));
      expect(answer.verdicts.map((verdict) => [verdict.requirementId, verdict.reason ?? 'ok'])).toEqual([[A, 'OVER_DEMAND'], [B, 'ok'], [C, 'ok']]);
      // The refused row is not asked the week.
      expect(masters.findConflicts).toHaveBeenCalledTimes(2);
    });

    it('says by name a stored set that no longer fits the block (BLOCK_FIT, and the rule), and asks the week nothing', async () => {
      const { masters, service } = setup({ rows: [storedRow('r-1', { minutes: 45 })] });
      const answer = await service.listOfBlock(BLOCK, user);
      expect(answer.verdicts).toEqual([A, B, C].map((requirementId) => ({ index: 0, requirementId, ok: false, reason: 'BLOCK_FIT', params: { rule: 'LENGTH' } })));
      expect(masters.findConflicts).not.toHaveBeenCalled();
    });

    it('lists the lessons of a block with no member and judges none of them', async () => {
      const { masters, service } = setup({ members: [], rows: [storedRow('r-1')] });
      const answer = await service.listOfBlock(BLOCK, user);
      expect(answer.placements.map((row) => row.id)).toEqual(['r-1']);
      expect(answer).toMatchObject({ verdicts: [], lengths: [] });
      expect(masters.findConflicts).not.toHaveBeenCalled();
      expect(rostersOfYear).not.toHaveBeenCalled();
    });

    it('answers 404 for a year it cannot see, and does not judge a year two steps ahead: the roster basis refuses it first', async () => {
      await expect(setup({ rows: [storedRow('r-1')], year: null }).service.listOfBlock(BLOCK, user)).rejects.toBeInstanceOf(NotFoundException);
      const ahead = setup({ rows: [storedRow('r-1')] });
      (rostersOfYear as jest.Mock).mockRejectedValue(new ConflictException({ code: 'ROLLOVER_NOT_ACTIVATED' }));
      await expect(ahead.service.listOfBlock(BLOCK, user)).rejects.toMatchObject({ response: { code: 'ROLLOVER_NOT_ACTIVATED' } });
    });

    it('only reads: no lock is taken and nothing is written', async () => {
      const { tx, service } = setup({ rows: [storedRow('r-1')] });
      await service.listOfBlock(BLOCK, user);
      expect(lockYearForGrundschemaEdit).not.toHaveBeenCalled();
      expect(tx['$queryRaw']).not.toHaveBeenCalled();
      expect(tx['teachingBlockPlacement']!['deleteMany']).not.toHaveBeenCalled();
      expect(tx['teachingBlockPlacement']!['createMany']).not.toHaveBeenCalled();
    });
  });

  describe('replace', () => {
    it('takes the year\'s lock first, then the block\'s row, and reads the lessons after both: a second writer waits and reads what the first committed', async () => {
      const { tx, service } = setup();
      await service.replace(BLOCK, dto([input()]), user);

      expect(lockYearForGrundschemaEdit).toHaveBeenCalledWith(tx, YEAR);
      const blockLock = tx['$queryRaw']!.mock.calls.findIndex((call) =>
        /SELECT "id" FROM "TeachingBlocks" WHERE "id" = \?::uuid FOR NO KEY UPDATE/.test((call[0] as TemplateStringsArray).join('?')),
      );
      expect(blockLock).toBeGreaterThanOrEqual(0);
      expect(tx['$queryRaw']!.mock.calls[blockLock]![1]).toBe(BLOCK);

      const year = (lockYearForGrundschemaEdit as jest.Mock).mock.invocationCallOrder[0]!;
      const row = tx['$queryRaw']!.mock.invocationCallOrder[blockLock]!;
      const [firstRead, secondRead] = tx['teachingBlock']!['findUnique']!.mock.invocationCallOrder as [number, number];
      const remove = tx['teachingBlockPlacement']!['deleteMany']!.mock.invocationCallOrder[0]!;
      const insert = tx['teachingBlockPlacement']!['createMany']!.mock.invocationCallOrder[0]!;
      // The first read only finds the year to lock; the block's lessons are read once the block's row is held.
      expect(firstRead).toBeLessThan(year);
      expect(year).toBeLessThan(row);
      expect(row).toBeLessThan(secondRead);
      expect(secondRead).toBeLessThan(remove);
      expect(remove).toBeLessThan(insert);
    });

    it('answers 404 for an unknown block, taking no lock and writing nothing', async () => {
      const { tx, service } = setup({ block: null });
      await expect(service.replace(BLOCK, dto([input()]), user)).rejects.toBeInstanceOf(NotFoundException);
      expect(lockYearForGrundschemaEdit).not.toHaveBeenCalled();
      expect(tx['$queryRaw']).not.toHaveBeenCalled();
      expect(tx['teachingBlockPlacement']!['deleteMany']).not.toHaveBeenCalled();
    });

    it('answers 404, and writes nothing, for a block that went while the writer waited for its row', async () => {
      const { tx, service } = setup({ goneAfterLock: true });
      await expect(service.replace(BLOCK, dto([input()]), user)).rejects.toBeInstanceOf(NotFoundException);
      expect(tx['$queryRaw']).toHaveBeenCalledTimes(1);
      expect(tx['teachingBlockPlacement']!['deleteMany']).not.toHaveBeenCalled();
      expect(tx['teachingBlockPlacement']!['createMany']).not.toHaveBeenCalled();
    });

    it('stops at the year\'s lock when a rewrite holds it (409), taking not even the block\'s row and writing nothing', async () => {
      const { tx, service } = setup();
      (lockYearForGrundschemaEdit as jest.Mock).mockRejectedValue(new ConflictException({ code: 'SCHEDULE_BUSY' }));
      await expect(service.replace(BLOCK, dto([input()]), user)).rejects.toMatchObject({ status: 409, response: { code: 'SCHEDULE_BUSY' } });
      expect(tx['$queryRaw']).not.toHaveBeenCalled();
      expect(tx['teachingBlockPlacement']!['deleteMany']).not.toHaveBeenCalled();
    });

    describe('409 BLOCK_PLACEMENTS_STALE: a save on a read that is no longer the stored one', () => {
      const first = [storedRow('r-1')];
      const second = [storedRow('r-2', { dayOfWeek: 4 })];

      it('is refused when the key is not the stored lessons\', and nothing is written', async () => {
        const { tx, masters, service } = setup({ rows: second });
        const refused = service.replace(BLOCK, dto([input()], keyOf(first)), user);
        await expect(refused).rejects.toBeInstanceOf(ConflictException);
        await expect(refused).rejects.toMatchObject({ status: 409, response: { code: 'BLOCK_PLACEMENTS_STALE' } });
        expect(tx['teachingBlockPlacement']!['deleteMany']).not.toHaveBeenCalled();
        expect(tx['teachingBlockPlacement']!['createMany']).not.toHaveBeenCalled();
        expect(masters.findConflicts).not.toHaveBeenCalled();
      });

      it('compares the key with what is stored AFTER the block\'s row is held, not with the read before it', async () => {
        // Before the lock the lessons are the ones the client read; while the writer waited, another writer replaced them.
        const { tx, service } = setup({ rows: first, rowsAfterLock: second });
        await expect(service.replace(BLOCK, dto([input()], keyOf(first)), user)).rejects.toMatchObject({ response: { code: 'BLOCK_PLACEMENTS_STALE' } });
        expect(tx['teachingBlockPlacement']!['deleteMany']).not.toHaveBeenCalled();
        // And the other way round: a key that matches only the read after the lock is not stale.
        const later = setup({ rows: first, rowsAfterLock: second });
        await expect(later.service.replace(BLOCK, dto([input()], keyOf(second)), user)).resolves.toBeDefined();
      });

      it('is not asked when the key is left out: the save replaces whatever is stored', async () => {
        const { tx, service } = setup({ rows: second });
        await service.replace(BLOCK, dto([input()]), user);
        expect(tx['teachingBlockPlacement']!['deleteMany']).toHaveBeenCalledTimes(1);
      });

      it('lets a save through on the key it read, and the empty key for a block with no lesson', async () => {
        const read = setup({ rows: first });
        await read.service.replace(BLOCK, dto([input({ dayOfWeek: 3 })], keyOf(first)), user);
        expect(read.tx['teachingBlockPlacement']!['createMany']).toHaveBeenCalledTimes(1);
        const none = setup();
        await none.service.replace(BLOCK, dto([input()], blockRowsKeyOf([])), user);
        expect(none.tx['teachingBlockPlacement']!['createMany']).toHaveBeenCalledTimes(1);
      });

      it('is refused for an empty list too: removing lessons on a stale read is as wrong as adding', async () => {
        const { tx, service } = setup({ rows: second });
        await expect(service.replace(BLOCK, dto([], keyOf(first)), user)).rejects.toMatchObject({ response: { code: 'BLOCK_PLACEMENTS_STALE' } });
        expect(tx['teachingBlockPlacement']!['deleteMany']).not.toHaveBeenCalled();
      });
    });

    describe('400, before the block is asked', () => {
      it('refuses a lesson that names one member\'s room twice, with the lesson\'s number, and writes nothing', async () => {
        const { tx, service } = setup();
        const placements = [input(), input({ dayOfWeek: 3, rooms: [{ requirementId: A, roomId: ROOM_1 }, { requirementId: A, roomId: ROOM_2 }] })];
        const refused = service.replace(BLOCK, dto(placements), user);
        await expect(refused).rejects.toMatchObject({ status: 400 });
        await expect(refused).rejects.toMatchObject({ response: { message: 'placements: förläggning 2 anger två salar för en post.' } });
        expect(tx['room']!['findMany']).not.toHaveBeenCalled();
        expect(tx['teachingBlockPlacement']!['deleteMany']).not.toHaveBeenCalled();
      });

      it('refuses a room the school does not have (another school\'s room reads as absent), and writes nothing', async () => {
        const { tx, masters, service } = setup({ rooms: [ROOM_1] });
        const refused = service.replace(BLOCK, dto([input({ rooms: [{ requirementId: A, roomId: ROOM_2 }] })]), user);
        await expect(refused).rejects.toMatchObject({ status: 400, response: { message: 'placements: en sal finns inte i skolan.' } });
        expect(tx['teachingBlockPlacement']!['deleteMany']).not.toHaveBeenCalled();
        expect(masters.findConflicts).not.toHaveBeenCalled();
      });

      it('asks for each room once, the rooms of every lesson together, and does not ask when no room is named', async () => {
        const { tx, service } = setup();
        await service.replace(
          BLOCK,
          dto([
            input({ rooms: [{ requirementId: A, roomId: ROOM_1 }, { requirementId: B, roomId: ROOM_1 }] }),
            input({ dayOfWeek: 3, rooms: [{ requirementId: A, roomId: ROOM_2 }] }),
          ]),
          user,
        );
        expect(tx['room']!['findMany']).toHaveBeenCalledTimes(1);
        expect(tx['room']!['findMany']).toHaveBeenCalledWith({ where: { id: { in: [ROOM_1, ROOM_2] } }, select: { id: true } });
        const none = setup();
        await none.service.replace(BLOCK, dto([input(), input({ dayOfWeek: 3, rooms: [] })]), user);
        expect(none.tx['room']!['findMany']).not.toHaveBeenCalled();
      });

      it('asks the rooms before the rules of the block: a bad room is told even on a lesson that does not fit', async () => {
        const { service } = setup({ rooms: [] });
        await expect(service.replace(BLOCK, dto([input({ minutes: 45, rooms: [{ requirementId: A, roomId: ROOM_1 }] })]), user)).rejects.toMatchObject({ status: 400 });
      });
    });

    describe('409 BLOCK_PLACEMENTS_DO_NOT_FIT, before the week is asked', () => {
      const shared = [memberRow(A, { shares: [{ teacherId: 'bo', lessons: 1, minutes: 60 }] }), memberRow(B)];
      const stranger = 'aaaaaaaa-aaaa-4aaa-8aaa-0000000000ff';
      it.each<[string, World, unknown[], Record<string, unknown>]>([
        ['FOLLOWER', { follows: 'leader' }, [input()], { reason: 'FOLLOWER', blockId: BLOCK }],
        ['EMPTY', { members: [] }, [input()], { reason: 'EMPTY', blockId: BLOCK }],
        ['SHARES', { members: shared }, [input()], { reason: 'SHARES', blockId: BLOCK }],
        ['LENGTH', {}, [input(), input({ dayOfWeek: 3, minutes: 45 })], { reason: 'LENGTH', index: 1, blockId: BLOCK }],
        ['COUNT', {}, [input(), input({ dayOfWeek: 3 }), input({ dayOfWeek: 4 })], { reason: 'COUNT', index: 2, blockId: BLOCK }],
        ['MEMBER', {}, [input(), input({ dayOfWeek: 3, rooms: [{ requirementId: stranger, roomId: ROOM_1 }] })], { reason: 'MEMBER', index: 1, blockId: BLOCK }],
      ])('%s, said by name with the lesson where it is about one, and the block', async (_rule, world, placements, params) => {
        const { tx, masters, service } = setup(world);
        const refused = service.replace(BLOCK, dto(placements), user);
        await expect(refused).rejects.toBeInstanceOf(ConflictException);
        await expect(refused).rejects.toMatchObject({ status: 409, response: { code: 'BLOCK_PLACEMENTS_DO_NOT_FIT', reason: params['reason'], params } });
        // Exactly these params: a rule about the block alone names no lesson.
        const response = ((await refused.catch((error: ConflictException) => error)) as ConflictException).getResponse() as { params: Record<string, unknown> };
        expect(Object.keys(response.params).sort()).toEqual(Object.keys(params).sort());
        expect(masters.findConflicts).not.toHaveBeenCalled();
        expect(rostersOfYear).not.toHaveBeenCalled();
        expect(tx['teachingBlockPlacement']!['deleteMany']).not.toHaveBeenCalled();
        expect(tx['teachingBlockPlacement']!['createMany']).not.toHaveBeenCalled();
      });

      it('says a sentence that tells what to change, and the lessons\' length in particular', async () => {
        const { service } = setup();
        await expect(service.replace(BLOCK, dto([input({ minutes: 45 })]), user)).rejects.toMatchObject({
          response: { message: expect.stringContaining('längd som blockets poster inte har') },
        });
      });

      it('never says WEEKS about a request: the weeks are the block\'s and are set here, so a lesson cannot be of other weeks than the block\'s', async () => {
        const odd = [memberRow(A, { recurrence: 'ODD_WEEKS' }), memberRow(B, { recurrence: 'ODD_WEEKS' })];
        const { tx, service } = setup({ members: odd });
        // A request that states weeks (which the DTO does not admit) is stamped with the block's.
        await service.replace(BLOCK, dto([input({ recurrence: 'EVEN_WEEKS' }), input({ dayOfWeek: 3, recurrence: 'ALL_WEEKS' })]), user);
        const written = (tx['teachingBlockPlacement']!['createMany']!.mock.calls[0]![0] as { data: Array<{ recurrence: string }> }).data;
        expect(written.map((row) => row.recurrence)).toEqual(['ODD_WEEKS', 'ODD_WEEKS']);
      });
    });

    describe('409 BLOCK_PLACEMENT_REFUSED, nothing written', () => {
      it('names the first lesson that does not hold: its place in the request, the member it is found on, the reason and the other lesson, flat', async () => {
        const { tx, masters, service } = setup();
        masters.findConflicts.mockImplementation(clashing([{ group: 'g-2', day: 4 }]));
        const refused = service.replace(BLOCK, dto([input(), input({ dayOfWeek: 4, startTime: '13:30' })]), user);
        await expect(refused).rejects.toMatchObject({
          status: 409,
          response: {
            code: 'BLOCK_PLACEMENT_REFUSED',
            params: { index: 1, requirementId: B, reason: 'TEACHER', otherKind: 'PLACEMENT', day: 4, start: '13:30', end: '14:30' },
          },
        });
        expect(tx['teachingBlockPlacement']!['deleteMany']).not.toHaveBeenCalled();
        expect(tx['teachingBlockPlacement']!['createMany']).not.toHaveBeenCalled();
        expect(tx['teachingBlockPlacementRoom']!['createMany']).not.toHaveBeenCalled();
      });

      it('tells the first refused row in the order lesson by lesson, and within a lesson by the members\' id order', async () => {
        const { masters, service } = setup();
        // The second lesson's first member and the first lesson's last member both clash: the first lesson's is told.
        masters.findConflicts.mockImplementation(clashing([{ group: 'g-1', day: 4 }, { group: 'g-3', day: 2 }]));
        await expect(service.replace(BLOCK, dto([input(), input({ dayOfWeek: 4 })]), user)).rejects.toMatchObject({
          response: { params: { index: 0, requirementId: C } },
        });
        const both = setup();
        both.masters.findConflicts.mockImplementation(clashing([{ group: 'g-1', day: 2 }, { group: 'g-3', day: 2 }]));
        await expect(both.service.replace(BLOCK, dto([input()]), user)).rejects.toMatchObject({ response: { params: { index: 0, requirementId: A } } });
      });

      it('says a room clash with the room\'s own reason', async () => {
        const { masters, service } = setup();
        masters.findConflicts.mockImplementation(clashing([{ group: 'g-1', day: 2, kind: 'ROOM' }]));
        await expect(service.replace(BLOCK, dto([input({ rooms: [{ requirementId: A, roomId: ROOM_1 }] })]), user)).rejects.toMatchObject({
          response: { code: 'BLOCK_PLACEMENT_REFUSED', params: { index: 0, requirementId: A, reason: 'ROOM' } },
        });
      });

      it('refuses a lesson outside the school day, with the lesson\'s place and no other figure', async () => {
        const { tx, service } = setup();
        await expect(service.replace(BLOCK, dto([input(), input({ dayOfWeek: 3, startTime: '07:00' })]), user)).rejects.toMatchObject({
          response: { code: 'BLOCK_PLACEMENT_REFUSED', params: { index: 1, requirementId: A, reason: 'SCHOOL_DAY' } },
        });
        expect(tx['teachingBlockPlacement']!['createMany']).not.toHaveBeenCalled();
      });

      it('refuses a member whose locks already answer the lessons the block places (OVER_DEMAND)', async () => {
        const { posts, tx, service } = setup();
        posts.locksOf.mockImplementation(async (_tx: unknown, post: { id: string }) => (post.id === B ? [{ minutes: 60, teacherId: 't-2' }, { minutes: 60, teacherId: 't-2' }] : []));
        await expect(service.replace(BLOCK, dto([input()]), user)).rejects.toMatchObject({ response: { params: { index: 0, requirementId: B, reason: 'OVER_DEMAND' } } });
        expect(tx['teachingBlockPlacement']!['deleteMany']).not.toHaveBeenCalled();
      });

      it('judges the request\'s lessons, not the stored ones, beside the year\'s other förläggningar without this block\'s own', async () => {
        const { posts, tx, masters, service } = setup({ rows: [storedRow('old-1', { dayOfWeek: 5 })] });
        await service.replace(BLOCK, dto([input(), input({ dayOfWeek: 3 })]), user);
        expect(posts.besideOf).toHaveBeenCalledWith(tx, { id: BLOCK, academicYearId: YEAR }, BLOCK);
        const days = masters.findConflicts.mock.calls.map(([, , , candidate]) => (candidate as { dayOfWeek: number }).dayOfWeek);
        expect(days).toEqual([2, 2, 2, 3, 3, 3]);
        const against = (masters.findConflicts.mock.calls[0]![4] as { against: Array<{ id: string }> }).against.map((lesson) => lesson.id);
        expect(against.some((id) => id.startsWith('placement:old-1'))).toBe(false);
      });

      it('answers a year two steps ahead with the roster basis\' refusal, writing nothing', async () => {
        const { tx, service } = setup();
        (rostersOfYear as jest.Mock).mockRejectedValue(new ConflictException({ code: 'ROLLOVER_NOT_ACTIVATED' }));
        await expect(service.replace(BLOCK, dto([input()]), user)).rejects.toMatchObject({ response: { code: 'ROLLOVER_NOT_ACTIVATED' } });
        expect(tx['teachingBlockPlacement']!['deleteMany']).not.toHaveBeenCalled();
      });
    });

    describe('the write', () => {
      it('replaces the lessons as one list: the old ones out, the new ones in ONE flat insert, the room rows in another', async () => {
        const { tx, service } = setup({ rows: [storedRow('old-1')] });
        await service.replace(
          BLOCK,
          dto([
            input({ rooms: [{ requirementId: A, roomId: ROOM_1 }, { requirementId: C, roomId: ROOM_2 }] }),
            input({ dayOfWeek: 4, startTime: '13:30' }),
          ]),
          user,
        );

        expect(tx['teachingBlockPlacement']!['deleteMany']).toHaveBeenCalledWith({ where: { blockId: BLOCK } });
        expect(tx['teachingBlockPlacement']!['createMany']).toHaveBeenCalledTimes(1);
        // schoolId and the year are the block's, not the caller's; startTime is the @db.Time the table stores.
        const { data } = tx['teachingBlockPlacement']!['createMany']!.mock.calls[0]![0] as { data: Array<Record<string, unknown>> };
        expect(data).toEqual([
          { id: expect.stringMatching(UUID), schoolId: SCHOOL, blockId: BLOCK, academicYearId: YEAR, dayOfWeek: 2, startTime: time('10:00'), minutes: 60, recurrence: 'ALL_WEEKS' },
          { id: expect.stringMatching(UUID), schoolId: SCHOOL, blockId: BLOCK, academicYearId: YEAR, dayOfWeek: 4, startTime: time('13:30'), minutes: 60, recurrence: 'ALL_WEEKS' },
        ]);
        expect(data[0]!['id']).not.toBe(data[1]!['id']);
        // The room rows name the new lessons by the ids generated for them, flat, one per named member.
        expect(tx['teachingBlockPlacementRoom']!['createMany']).toHaveBeenCalledTimes(1);
        expect(tx['teachingBlockPlacementRoom']!['createMany']).toHaveBeenCalledWith({
          data: [
            { schoolId: SCHOOL, placementId: data[0]!['id'], requirementId: A, roomId: ROOM_1 },
            { schoolId: SCHOOL, placementId: data[0]!['id'], requirementId: C, roomId: ROOM_2 },
          ],
        });
        const remove = tx['teachingBlockPlacement']!['deleteMany']!.mock.invocationCallOrder[0]!;
        const insert = tx['teachingBlockPlacement']!['createMany']!.mock.invocationCallOrder[0]!;
        const rooms = tx['teachingBlockPlacementRoom']!['createMany']!.mock.invocationCallOrder[0]!;
        expect(remove).toBeLessThan(insert);
        expect(insert).toBeLessThan(rooms);
      });

      it('never writes a nested create: a plain row carries no `rooms`, and no single create is used', async () => {
        const { tx, service } = setup();
        await service.replace(BLOCK, dto([input({ rooms: [{ requirementId: A, roomId: ROOM_1 }] })]), user);
        const { data } = tx['teachingBlockPlacement']!['createMany']!.mock.calls[0]![0] as { data: Array<Record<string, unknown>> };
        expect(data.every((row) => !('rooms' in row))).toBe(true);
        expect(tx['teachingBlockPlacement']!['create']).not.toHaveBeenCalled();
        expect(tx['teachingBlockPlacement']!['upsert']).not.toHaveBeenCalled();
        expect(tx['teachingBlockPlacementRoom']!['create']).not.toHaveBeenCalled();
      });

      it('sets the weeks from the block\'s, not from the request', async () => {
        const even = [memberRow(A, { recurrence: 'EVEN_WEEKS' }), memberRow(B, { recurrence: 'EVEN_WEEKS' })];
        const { tx, masters, service } = setup({ members: even });
        await service.replace(BLOCK, dto([input({ recurrence: 'ODD_WEEKS' })]), user);
        expect((tx['teachingBlockPlacement']!['createMany']!.mock.calls[0]![0] as { data: Array<{ recurrence: string }> }).data[0]!.recurrence).toBe('EVEN_WEEKS');
        expect((masters.findConflicts.mock.calls[0]![3] as { recurrence: string }).recurrence).toBe('EVEN_WEEKS');
      });

      it('writes no room row for lessons that name no room, and leaves the school\'s rooms unread', async () => {
        const { tx, service } = setup();
        await service.replace(BLOCK, dto([input(), input({ dayOfWeek: 3, rooms: [] })]), user);
        expect(tx['teachingBlockPlacementRoom']!['createMany']).not.toHaveBeenCalled();
        expect(tx['room']!['findMany']).not.toHaveBeenCalled();
      });

      it('answers with the lessons as written: their views, an ok verdict per lesson and member, the new key and the lengths', async () => {
        const { service } = setup({ rows: [storedRow('old-1')] });
        const answer = await service.replace(
          BLOCK,
          dto([input({ rooms: [{ requirementId: B, roomId: ROOM_2 }] }), input({ dayOfWeek: 4, startTime: '13:30' })]),
          user,
        );
        expect(answer.placements).toEqual([
          expect.objectContaining({ id: expect.stringMatching(UUID), blockId: BLOCK, dayOfWeek: 2, startTime: '10:00', endTime: '11:00', rooms: [{ requirementId: B, roomId: ROOM_2, roomName: 'Sal 2' }] }),
          expect.objectContaining({ dayOfWeek: 4, startTime: '13:30', endTime: '14:30', rooms: [] }),
        ]);
        expect(answer.placements.map((row) => row.id)).not.toContain('old-1');
        expect(answer.verdicts).toEqual([
          { index: 0, requirementId: A, ok: true },
          { index: 0, requirementId: B, ok: true },
          { index: 0, requirementId: C, ok: true },
          { index: 1, requirementId: A, ok: true },
          { index: 1, requirementId: B, ok: true },
          { index: 1, requirementId: C, ok: true },
        ]);
        expect(answer.lengths).toEqual([60, 60]);
        expect(answer.rowsKey).toMatch(/^[0-9a-f]{32}$/);
        // The key is of the lessons written, so a client that carries it back is not stale.
        expect(answer.rowsKey).not.toBe(blockRowsKeyOf([]));
      });

      it('answers with a key that the next save accepts as the base, and that a read of the block gives too', async () => {
        const first = setup();
        const answer = await first.service.replace(BLOCK, dto([input()]), user);
        const again = await first.service.listOfBlock(BLOCK, user);
        expect(again.rowsKey).toBe(answer.rowsKey);
        await expect(first.service.replace(BLOCK, dto([input({ dayOfWeek: 3 })], answer.rowsKey), user)).resolves.toBeDefined();
      });
    });

    describe('an empty list', () => {
      it('removes every lesson, writes none, judges nothing and reads no classes', async () => {
        const { tx, masters, posts, service } = setup({ rows: [storedRow('r-1')] });
        const answer = await service.replace(BLOCK, dto([]), user);
        expect(tx['teachingBlockPlacement']!['deleteMany']).toHaveBeenCalledWith({ where: { blockId: BLOCK } });
        expect(tx['teachingBlockPlacement']!['createMany']).not.toHaveBeenCalled();
        expect(tx['teachingBlockPlacementRoom']!['createMany']).not.toHaveBeenCalled();
        expect(masters.findConflicts).not.toHaveBeenCalled();
        expect(rostersOfYear).not.toHaveBeenCalled();
        expect(posts.besideOf).not.toHaveBeenCalled();
        expect(lockYearForGrundschemaEdit).toHaveBeenCalledWith(tx, YEAR);
        expect(answer).toEqual({ placements: [], verdicts: [], rowsKey: blockRowsKeyOf([]), lengths: [60, 60] });
      });

      it('removes a follower\'s, an empty block\'s and a sharing block\'s lessons too: the rules are about lessons that are placed', async () => {
        const worlds: World[] = [{ follows: 'leader' }, { members: [] }, { members: [memberRow(A, { shares: [{ teacherId: 'bo', lessons: 1, minutes: 60 }] })] }];
        for (const world of worlds) {
          const { tx, service } = setup({ ...world, rows: [storedRow('r-1')] });
          await expect(service.replace(BLOCK, dto([]), user)).resolves.toMatchObject({ placements: [] });
          expect(tx['teachingBlockPlacement']!['deleteMany']).toHaveBeenCalledTimes(1);
        }
      });
    });

    describe('what the database refuses that the gateway did not foresee', () => {
      it.each(['FOLLOWER', 'EMPTY', 'SHARES', 'LENGTH', 'WEEKS', 'COUNT', 'MEMBER'])(
        'answers BP409 %s from the lessons\' insert as the 409 naming the rule and the block, not a 500',
        async (reason) => {
          const { tx, service } = setup();
          tx['teachingBlockPlacement']!['createMany']!.mockRejectedValue(blockError(reason));
          await expect(service.replace(BLOCK, dto([input()]), user)).rejects.toMatchObject({
            status: 409,
            response: { code: 'BLOCK_PLACEMENTS_DO_NOT_FIT', reason, params: { reason, blockId: BLOCK } },
          });
        },
      );

      it('answers it from the room rows\' insert too (MEMBER: a post that left the block meanwhile)', async () => {
        const { tx, service } = setup();
        tx['teachingBlockPlacementRoom']!['createMany']!.mockRejectedValue(blockError('MEMBER'));
        await expect(service.replace(BLOCK, dto([input({ rooms: [{ requirementId: A, roomId: ROOM_1 }] })]), user)).rejects.toMatchObject({
          status: 409,
          response: { code: 'BLOCK_PLACEMENTS_DO_NOT_FIT', params: { reason: 'MEMBER', blockId: BLOCK } },
        });
      });

      it('answers a raw driver refusal (a failed COMMIT) as the same 409', async () => {
        const { tx, service } = setup();
        const failed = Object.assign(new Error('commit failed'), {
          name: 'DriverAdapterError',
          cause: { originalCode: 'BP409', originalMessage: 'COUNT: fler lektioner än blocket har', detail: `blockId=${BLOCK} reason=COUNT` },
        });
        tx['teachingBlockPlacement']!['createMany']!.mockRejectedValue(failed);
        await expect(service.replace(BLOCK, dto([input()]), user)).rejects.toMatchObject({
          status: 409,
          response: { code: 'BLOCK_PLACEMENTS_DO_NOT_FIT', params: { reason: 'COUNT', blockId: BLOCK } },
        });
      });

      it('answers a rule it has no sentence for (ISOLATION) as the 409 with no rule named', async () => {
        const { tx, service } = setup();
        tx['teachingBlockPlacement']!['createMany']!.mockRejectedValue(blockError('ISOLATION'));
        const refused = await service.replace(BLOCK, dto([input()]), user).catch((error: ConflictException) => error);
        expect(refused).toBeInstanceOf(ConflictException);
        expect((refused as ConflictException).getResponse()).toMatchObject({ code: 'BLOCK_PLACEMENTS_DO_NOT_FIT' });
        expect((refused as ConflictException).getResponse()).not.toHaveProperty('params');
      });

      it('lets an error it does not know pass, unchanged', async () => {
        const { tx, service } = setup();
        const boom = new Error('boom');
        tx['teachingBlockPlacement']!['createMany']!.mockRejectedValue(boom);
        await expect(service.replace(BLOCK, dto([input()]), user)).rejects.toBe(boom);
      });

      it('lets the refusals it raises itself through the same door unchanged', async () => {
        const { service } = setup();
        const refused = await service.replace(BLOCK, dto([input({ minutes: 45 })]), user).catch((error: ConflictException) => error);
        expect((refused as ConflictException).getStatus()).toBe(409);
        expect((refused as ConflictException).getResponse()).toMatchObject({ code: 'BLOCK_PLACEMENTS_DO_NOT_FIT', params: { reason: 'LENGTH', index: 0 } });
      });
    });
  });
});
