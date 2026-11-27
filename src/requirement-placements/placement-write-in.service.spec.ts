import { ConflictException, NotFoundException } from '@nestjs/common';
import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import type { ScheduleVersionsService } from '../calendar/schedule-versions.service';
import type { PrismaService } from '../database/prisma.service';
import { regenerationSweepDay } from '../optimization/optimization-proxy.service';
import { lockYearForRegeneration, SCHEDULE_BUSY, scheduleBusy } from '../optimization/regeneration-lock';
import { enterGrundschemaWrite } from '../publication/publish-mode';
import type { RealtimeService } from '../realtime/realtime.service';
import { roomRefusalsOf } from './placement-room-refusal';
import { PlacementWriteInService } from './placement-write-in.service';
import type { RequirementPlacementsService } from './requirement-placements.service';

/*
 * SKRIV IN FÖRLÄGGNINGARNA (E4b), the service around the planner (placement-write-in.spec.ts holds what is written):
 *   - the write is one transaction in the order every rewrite of the year takes: the mode, then the year's regeneration lock, then the reads
 *     it decides by, then a restore point, then the sweep of the calendar, the replacing, the writing and the log;
 *   - a preview reads and writes nothing, and a write that changes nothing takes no version and says nothing to anyone;
 *   - in a draft the calendar is not swept, and what changed is told as a draft's.
 */

jest.mock('../publication/publish-mode', () => ({ ...jest.requireActual('../publication/publish-mode'), enterGrundschemaWrite: jest.fn() }));
jest.mock('../optimization/regeneration-lock', () => ({ ...jest.requireActual('../optimization/regeneration-lock'), lockYearForRegeneration: jest.fn() }));
jest.mock('./placement-room-refusal', () => ({ roomRefusalsOf: jest.fn(async () => new Map()) }));
jest.mock('../optimization/optimization-proxy.service', () => ({ ...jest.requireActual('../optimization/optimization-proxy.service'), regenerationSweepDay: jest.fn() }));

const YEAR = '99999999-9999-4999-8999-999999999999';
const SCHOOL = '33333333-3333-4333-8333-333333333333';
const G7A = '66666666-6666-4666-8666-666666666666';
const MATH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ANNA = '44444444-4444-4444-8444-444444444444';
const ROOM = '11111111-1111-4111-8111-111111111111';
const OLD_ROOM = '12121212-1212-4212-8212-121212121212';
const POST = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const BASIS = { kind: 'basis' };
const time = (value: string): Date => new Date(`1970-01-01T${value}:00.000Z`);

const post = {
  id: POST,
  subjectId: MATH,
  studentGroupId: G7A,
  teacherId: ANNA,
  coTeacherId: null,
  recurrence: 'ALL_WEEKS',
  startDate: new Date('2026-08-17T00:00:00.000Z'),
  endDate: null,
  shares: [],
  blockId: null,
};
const rowOf = (over: Record<string, unknown> = {}) => ({
  id: 'row-1',
  requirementId: POST,
  dayOfWeek: 1,
  startTime: time('09:00'),
  minutes: 60,
  roomId: ROOM,
  recurrence: 'ALL_WEEKS',
  teacherId: null,
  ...over,
});
const existingOf = (over: Record<string, unknown> = {}) => ({
  id: 'old-1',
  academicYearId: YEAR,
  subjectId: MATH,
  studentGroupId: G7A,
  teacherId: ANNA,
  coTeacherId: null,
  roomId: OLD_ROOM,
  dayOfWeek: 1,
  startTime: time('09:00'),
  endTime: time('10:00'),
  isLocked: true,
  isParked: false,
  exemptFrom: [],
  recurrence: 'ALL_WEEKS',
  startDate: new Date('2026-08-17T00:00:00.000Z'),
  endDate: null,
  extraGroups: [],
  participants: [],
  ...over,
});

describe('PlacementWriteInService', () => {
  let tx: TxMock;
  let service: PlacementWriteInService;
  let judgedYear: jest.Mock;
  let snapshot: jest.Mock;
  let realtime: { notifyMasterTimetableChanged: jest.Mock };
  let existing: Record<string, unknown>[];
  let rows: Record<string, unknown>[];
  let verdicts: Record<string, unknown>[];
  const order: string[] = [];
  const user = testUser();

  beforeEach(() => {
    order.length = 0;
    tx = createTxMock();
    rows = [rowOf()];
    verdicts = [{ index: 0, ok: true }];
    existing = [];
    judgedYear = jest.fn(async () => {
      order.push('judge');
      return { posts: [post], rows, verdicts, ofBlocks: [], basis: BASIS, year: { gradeNumbering: 'NIOARIG' } };
    });
    snapshot = jest.fn(async () => {
      order.push('version');
      return { id: 'version-1' };
    });
    realtime = { notifyMasterTimetableChanged: jest.fn() };
    service = new PlacementWriteInService(
      createPrismaMock(tx) as unknown as PrismaService,
      { judgedYear } as unknown as RequirementPlacementsService,
      { snapshotInTransaction: snapshot } as unknown as ScheduleVersionsService,
      realtime as unknown as RealtimeService,
    );
    tx['academicYear']!['findUnique']!.mockResolvedValue({ id: YEAR });
    tx['masterLesson']!['findMany']!.mockImplementation(async () => existing);
    tx['masterLesson']!['deleteMany']!.mockImplementation(async (args: { where: { id: { in: string[] } } }) => {
      order.push('delete');
      return { count: args.where.id.in.length };
    });
    tx['masterLesson']!['createManyAndReturn']!.mockImplementation(async (args: { data: Record<string, unknown>[] }) => {
      order.push('create');
      return args.data.map((data, index) => ({ id: `new-${index}`, isLocked: true, isParked: false, ...data }));
    });
    tx['calendarLesson']!['deleteMany']!.mockImplementation(async () => {
      order.push('sweep');
      return { count: 3 };
    });
    tx['scheduleChangeLog']!['createMany']!.mockImplementation(async () => void order.push('log'));
    (enterGrundschemaWrite as jest.Mock).mockReset().mockImplementation(async () => {
      order.push('mode');
      return 'DIRECT';
    });
    (lockYearForRegeneration as jest.Mock).mockReset().mockImplementation(async () => void order.push('lock'));
    (regenerationSweepDay as jest.Mock).mockReset().mockResolvedValue(new Date('2026-11-26T00:00:00.000Z'));
    (roomRefusalsOf as jest.Mock).mockReset().mockResolvedValue(new Map());
  });

  it('writes in the order a rewrite of the year takes: the mode, the year\'s lock, the reads, a restore point, the sweep, the replacing, the writing, the log', async () => {
    existing = [existingOf()];
    const result = await service.write(YEAR, user);
    expect(order).toEqual(['mode', 'lock', 'judge', 'version', 'sweep', 'delete', 'create', 'log']);
    expect(result).toMatchObject({ preview: false, lessonsWritten: 1, lessonsReplaced: 1, calendarLessonsRemoved: 3, postsWritten: 1, safetyVersionId: 'version-1', notWritten: [] });
    // The lesson as Generera writes it: locked, the run's own, marked from a förläggning.
    expect(tx['masterLesson']!['createManyAndReturn']).toHaveBeenCalledWith(
      expect.objectContaining({ data: [expect.objectContaining({ roomId: ROOM, isLocked: true, isGenerated: true, fromPlacement: true, dayOfWeek: 1 })] }),
    );
    // The dated lessons swept are those of the replaced masters, and only theirs.
    expect(tx['calendarLesson']!['deleteMany']).toHaveBeenCalledWith({
      where: expect.objectContaining({ masterLessonId: { in: ['old-1'] }, status: 'SCHEDULED' }),
    });
    expect(tx['masterLesson']!['deleteMany']).toHaveBeenCalledWith({ where: { academicYearId: YEAR, fromPlacement: true, id: { in: ['old-1'] } } });
    // A log row for the lesson that went and one for the lesson that came, each in the shape a hand edit logs.
    const logged = (tx['scheduleChangeLog']!['createMany']!.mock.calls[0]![0] as { data: Record<string, unknown>[] }).data;
    expect(logged.map((entry) => [entry['action'], entry['masterLessonId']])).toEqual([['DELETE', 'old-1'], ['CREATE', 'new-0']]);
    expect(logged[0]!['before']).toMatchObject({ id: 'old-1', roomId: OLD_ROOM, startTime: '09:00' });
    expect(logged[1]!['after']).toMatchObject({ id: 'new-0', roomId: ROOM, isLocked: true, extraGroupIds: [], studentIds: [] });
    // Told after the commit, as a change of the master timetable.
    expect(realtime.notifyMasterTimetableChanged).toHaveBeenCalledWith(SCHOOL);
  });

  it('writes and replaces nothing, takes no version and tells no one when the lessons already are what the rows say', async () => {
    existing = [existingOf({ roomId: ROOM })];
    const result = await service.write(YEAR, user);
    expect(result).toMatchObject({ lessonsWritten: 0, lessonsReplaced: 0, safetyVersionId: null, postsWritten: 1 });
    expect(order).toEqual(['mode', 'lock', 'judge']);
    expect(snapshot).not.toHaveBeenCalled();
    expect(realtime.notifyMasterTimetableChanged).not.toHaveBeenCalled();
  });

  it('names the förläggningar it leaves, and writes the ones that hold', async () => {
    rows = [rowOf({ id: 'a' }), rowOf({ id: 'b', dayOfWeek: 2 }), rowOf({ id: 'c', dayOfWeek: 3, roomId: null })];
    verdicts = [{ index: 0, ok: true }, { index: 1, ok: false, reason: 'GROUP', params: { other: 'Svenska 7A' } }, { index: 2, ok: true }];
    const result = await service.write(YEAR, user);
    expect(result.lessonsWritten).toBe(1);
    expect(result.notWritten).toEqual([
      { rowId: 'b', requirementId: POST, reason: 'REFUSED', verdict: { reason: 'GROUP', params: { other: 'Svenska 7A' } } },
      { rowId: 'c', requirementId: POST, reason: 'NO_ROOM' },
    ]);
  });

  it('reads the verdicts of the posts\' rows and not of the blocks\' that follow them', async () => {
    judgedYear.mockImplementation(async () => ({
      posts: [post],
      rows,
      verdicts: [{ index: 0, ok: true }, { index: 1, ok: false, reason: 'GROUP' }],
      ofBlocks: [{ block: { id: 'block-1', rows: [{ id: 'block-row-1' }] } }],
    }));
    const result = await service.write(YEAR, user);
    expect(result.lessonsWritten).toBe(1);
    expect(result.notWritten).toEqual([{ rowId: 'block-row-1', blockId: 'block-1', reason: 'BLOCK' }]);
  });

  it('asks the generator\'s room rule of the rows the week holds and that name a room, and only of them, and leaves the one it refuses, named', async () => {
    rows = [rowOf({ id: 'a' }), rowOf({ id: 'b', dayOfWeek: 2 }), rowOf({ id: 'c', dayOfWeek: 3, roomId: null }), rowOf({ id: 'd', dayOfWeek: 4 })];
    verdicts = [{ index: 0, ok: true }, { index: 1, ok: true }, { index: 2, ok: true }, { index: 3, ok: false, reason: 'GROUP' }];
    (roomRefusalsOf as jest.Mock).mockResolvedValue(new Map([['b', { roomId: ROOM, reason: 'TYPE' }]]));
    const result = await service.write(YEAR, user);
    expect(roomRefusalsOf).toHaveBeenCalledWith(tx, { id: YEAR, gradeNumbering: 'NIOARIG' }, BASIS, [
      { id: 'a', roomId: ROOM, studentGroupId: G7A, subjectId: MATH },
      { id: 'b', roomId: ROOM, studentGroupId: G7A, subjectId: MATH },
    ]);
    expect(result.lessonsWritten).toBe(1);
    expect(result.notWritten).toEqual([
      { rowId: 'b', requirementId: POST, reason: 'REFUSED', verdict: { reason: 'BOARD_ROOM_NOT_ALLOWED', params: { roomId: ROOM, reason: 'TYPE' } } },
      { rowId: 'c', requirementId: POST, reason: 'NO_ROOM' },
      { rowId: 'd', requirementId: POST, reason: 'REFUSED', verdict: { reason: 'GROUP' } },
    ]);
  });

  it('asks no room of a year with no rows to judge: there are no pupils read for it', async () => {
    judgedYear.mockImplementation(async () => ({ posts: [post], rows: [], verdicts: [], ofBlocks: [], basis: null, year: { gradeNumbering: 'NIOARIG' } }));
    const result = await service.write(YEAR, user);
    expect(roomRefusalsOf).not.toHaveBeenCalled();
    expect(result.lessonsWritten).toBe(0);
  });

  it('writes nothing for a preview, and says what a write would do', async () => {
    existing = [existingOf()];
    const result = await service.preview(YEAR, user);
    expect(result).toMatchObject({ preview: true, lessonsWritten: 1, lessonsReplaced: 1, calendarLessonsRemoved: 0, safetyVersionId: null });
    expect(order).toEqual(['judge']);
    expect(enterGrundschemaWrite).not.toHaveBeenCalled();
    expect(lockYearForRegeneration).not.toHaveBeenCalled();
    expect(realtime.notifyMasterTimetableChanged).not.toHaveBeenCalled();
  });

  it('does not sweep the calendar in a draft, and tells a draft\'s change', async () => {
    (enterGrundschemaWrite as jest.Mock).mockImplementation(async () => {
      order.push('mode');
      return 'DRAFT';
    });
    existing = [existingOf()];
    const result = await service.write(YEAR, user);
    expect(order).toEqual(['mode', 'lock', 'judge', 'version', 'delete', 'create', 'log']);
    expect(result.calendarLessonsRemoved).toBe(0);
    expect(regenerationSweepDay).not.toHaveBeenCalled();
    expect(realtime.notifyMasterTimetableChanged).toHaveBeenCalledWith(SCHOOL, { draft: true });
  });

  it('is a 404 for a year that is not the school\'s, before anything is locked', async () => {
    tx['academicYear']!['findUnique']!.mockResolvedValue(null);
    await expect(service.write(YEAR, user)).rejects.toBeInstanceOf(NotFoundException);
    expect(enterGrundschemaWrite).not.toHaveBeenCalled();
  });

  it('is a 409 SCHEDULE_BUSY, writing nothing, while another rewrite holds the year', async () => {
    (lockYearForRegeneration as jest.Mock).mockImplementation(async () => {
      throw scheduleBusy();
    });
    await expect(service.write(YEAR, user)).rejects.toMatchObject({ response: { code: SCHEDULE_BUSY } });
    expect(judgedYear).not.toHaveBeenCalled();
    expect(tx['masterLesson']!['createManyAndReturn']).not.toHaveBeenCalled();
  });

  it('is a 409 when a lesson it read to replace is gone by the time it deletes, and tells no one', async () => {
    existing = [existingOf()];
    tx['masterLesson']!['deleteMany']!.mockResolvedValue({ count: 0 });
    await expect(service.write(YEAR, user)).rejects.toBeInstanceOf(ConflictException);
    expect(realtime.notifyMasterTimetableChanged).not.toHaveBeenCalled();
  });
});
