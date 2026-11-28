import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import type { MasterLessonsService } from '../calendar/master-lessons.service';
import type { PossibleTimesService } from '../calendar/possible-times.service';
import type { ScheduleVersionsService } from '../calendar/schedule-versions.service';
import type { BoardTrayService, TrayBrick } from '../board-tray/board-tray.service';
import type { PrismaService } from '../database/prisma.service';
import { judgeLessons } from '../calendar/lesson-judge';
import { lockYearForRegeneration } from '../optimization/regeneration-lock';
import { enterGrundschemaWrite } from '../publication/publish-mode';
import { lockPostForShares } from '../resources/requirement-shares';
import { makeWorld } from '../swaps/__fixtures__/swap-world';
import { readSwapData } from '../swaps/swap-snapshot';
import { BOARD_FILL_STALE, BOARD_FILL_TIMED_OUT, BoardFillService, FILL_APPLY_CEILING_MS, applyTimeoutMs } from './board-fill.service';

/*
 * LÄGG DET SOM GÅR, the service (E7a): what it reads and what it writes, with the tray, the judge and the world faked. The planner has its own spec
 * (fill-plan.spec.ts); the database probe (scripts/test/probe-lagg-det-som-gar.ts) holds the whole of it against real Postgres.
 */

jest.mock('../swaps/swap-snapshot', () => ({ ...jest.requireActual('../swaps/swap-snapshot'), readSwapData: jest.fn() }));
jest.mock('../calendar/lesson-judge', () => ({ ...jest.requireActual('../calendar/lesson-judge'), judgeLessons: jest.fn() }));
jest.mock('../publication/publish-mode', () => ({ ...jest.requireActual('../publication/publish-mode'), enterGrundschemaWrite: jest.fn() }));
jest.mock('../optimization/regeneration-lock', () => ({ ...jest.requireActual('../optimization/regeneration-lock'), lockYearForRegeneration: jest.fn() }));
jest.mock('../resources/requirement-shares', () => ({ ...jest.requireActual('../resources/requirement-shares'), lockPostForShares: jest.fn() }));
jest.mock('./fill-reads');

const YEAR = '99999999-9999-4999-8999-999999999999';
const POST_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const POST_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TEACHER = '44444444-4444-4444-8444-444444444444';
const SUBJECT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const brick = (over: Partial<TrayBrick> = {}): TrayBrick => ({
  postId: POST_A,
  nth: 1,
  partKey: 'p'.repeat(16),
  lessonId: null,
  studentGroupId: 'c1',
  subjectId: SUBJECT,
  teacherId: TEACHER,
  coTeacherId: null,
  minutes: 60,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  blockId: null,
  cannotPlace: null,
  possibleTimes: null,
  ...over,
});
const keyOf = (entry: TrayBrick): string => `${entry.postId}|${entry.teacherId ?? '-'}|${entry.minutes}|${entry.nth}`;

describe('the time a Ta in is given (g517 L-4)', () => {
  it('grows with the lessons, from 15 s, and stops at a ceiling that lies well under the 300 s the edge lets a silent request live', () => {
    expect(applyTimeoutMs(1)).toBe(15_000);
    expect(applyTimeoutMs(10)).toBe(16_000);
    expect(applyTimeoutMs(100)).toBe(70_000);
    // Up to the DTO's 600 lessons it never passes the ceiling, and the ceiling is under the edge with a margin of minutes.
    for (let lessons = 1; lessons <= 600; lessons += 1) expect(applyTimeoutMs(lessons)).toBeLessThanOrEqual(FILL_APPLY_CEILING_MS);
    expect(applyTimeoutMs(600)).toBe(FILL_APPLY_CEILING_MS);
    expect(FILL_APPLY_CEILING_MS).toBeLessThanOrEqual(150_000);
    expect(FILL_APPLY_CEILING_MS).toBeLessThan(300_000);
  });
});

describe('BoardFillService', () => {
  let tx: TxMock;
  let prisma: ReturnType<typeof createPrismaMock>;
  let service: BoardFillService;
  let tray: { trayIn: jest.Mock; writeBrick: jest.Mock };
  let versions: { snapshotInTransaction: jest.Mock };
  let possible: { worldFactsOf: jest.Mock; worldOf: jest.Mock };
  let bricks: TrayBrick[];
  const world = makeWorld({ seed: 3, classes: 3, perClass: 0 });
  const order: string[] = [];
  const asAdmin = testUser();

  beforeEach(() => {
    order.length = 0;
    tx = createTxMock();
    bricks = [brick(), brick({ nth: 2 }), brick({ postId: POST_B, studentGroupId: 'c2', teacherId: null, cannotPlace: 'NO_TEACHER' })];
    tray = {
      trayIn: jest.fn(async () => ({ academicYearId: YEAR, bricks, tally: { lessons: 3, laid: 0, placedByRow: 0, left: 3 }, groups: [] })),
      writeBrick: jest.fn(async (_tx: unknown, entry: TrayBrick) => ({ lesson: { id: `lesson-${entry.nth}`, isLocked: true, warnings: [] }, noRoom: true })),
    };
    versions = { snapshotInTransaction: jest.fn(async () => (order.push('version'), { id: 'version-1' })) };
    possible = {
      worldFactsOf: jest.fn(async () => ({ closedWeeks: null, sharedRooms: new Set<string>() })),
      worldOf: jest.fn(async () => ({ rooms: [], wishes: [], needsOf: () => null })),
    };
    tx['masterLesson']!['aggregate']!.mockResolvedValue({ _count: { _all: 10 }, _max: { updatedAt: new Date('2026-11-01T10:00:00Z') } });
    tx['teachingRequirement']!['aggregate']!.mockResolvedValue({ _count: { _all: 4 }, _max: { updatedAt: new Date('2026-10-01T10:00:00Z') } });
    (readSwapData as jest.Mock).mockReset().mockResolvedValue({ ...world.data, lessons: [], posts: [] });
    (judgeLessons as jest.Mock).mockReset().mockResolvedValue([{ ok: true, refusals: [], exempted: [], exemptable: false }]);
    (enterGrundschemaWrite as jest.Mock).mockReset().mockImplementation(async () => (order.push('mode'), 'DIRECT'));
    (lockYearForRegeneration as jest.Mock).mockReset().mockImplementation(async () => void order.push('year'));
    tx['academicYear']!['findUnique']!.mockResolvedValue({ id: YEAR });
    (lockPostForShares as jest.Mock).mockReset().mockImplementation(async (_tx: unknown, postId: string) => void order.push(`post:${postId === POST_A ? 'A' : 'B'}`));
    prisma = createPrismaMock(tx);
    service = new BoardFillService(
      prisma as unknown as PrismaService,
      tray as unknown as BoardTrayService,
      {} as MasterLessonsService,
      possible as unknown as PossibleTimesService,
      versions as unknown as ScheduleVersionsService,
    );
  });

  describe('propose', () => {
    it('lays the bricks it can and leaves the one nobody teaches, says who answered, and writes and saves nothing', async () => {
      const proposal = await service.propose({ academicYearId: YEAR, scope: 'SCHOOL' }, asAdmin);
      expect(proposal).toMatchObject({ academicYearId: YEAR, answeredBy: 'FILL', asked: 3, moved: [], truncated: false });
      expect(proposal.placed.map((entry) => entry.key)).toEqual([keyOf(bricks[0]!), keyOf(bricks[1]!)]);
      expect(proposal.left).toEqual([expect.objectContaining({ key: keyOf(bricks[2]!), reason: 'NO_TEACHER', postId: POST_B })]);
      expect(proposal.basis).toMatch(/^[0-9a-f]{32}$/);
      expect(tray.writeBrick).not.toHaveBeenCalled();
      expect(versions.snapshotInTransaction).not.toHaveBeenCalled();
      expect(enterGrundschemaWrite).not.toHaveBeenCalled();
    });

    it('names a brick by ids and by where it lies, and nobody by name', async () => {
      const proposal = await service.propose({ academicYearId: YEAR, scope: 'CLASS', studentGroupId: 'c1' }, asAdmin);
      const first = proposal.placed[0]!;
      expect(first).toMatchObject({ postId: POST_A, studentGroupId: 'c1', subjectId: SUBJECT, teacherId: TEACHER, minutes: 60, lessonId: null, noRoom: true, roomId: null, rank: 1 });
      expect(first.endMinutes - first.startMinutes).toBe(60);
      expect(JSON.stringify(proposal)).not.toMatch(/firstName|lastName|email/);
    });

    it('asks the judge about every start it chooses, with no exemption, and tells the judge nothing it did not lay', async () => {
      await service.propose({ academicYearId: YEAR, scope: 'CLASS', studentGroupId: 'c1' }, asAdmin);
      const items = (judgeLessons as jest.Mock).mock.calls.flatMap((call) => call[3] as Array<Record<string, unknown>>);
      expect(items.length).toBe(2);
      for (const item of items) {
        expect(item).toMatchObject({ lesson: { id: null, studentGroupId: 'c1', subjectId: SUBJECT }, stands: null });
        expect(item).not.toHaveProperty('exempt');
      }
    });

    it('leaves a brick the judge refuses every start of, as JUDGE, and never says it cannot be laid', async () => {
      (judgeLessons as jest.Mock).mockResolvedValue([{ ok: false, refusals: [{ reason: 'TEACHER', params: {} }], exempted: [], exemptable: false }]);
      const proposal = await service.propose({ academicYearId: YEAR, scope: 'CLASS', studentGroupId: 'c1' }, asAdmin);
      expect(proposal.placed).toEqual([]);
      expect(proposal.left.map((entry) => entry.reason)).toEqual(['JUDGE', 'JUDGE']);
      expect(JSON.stringify(proposal)).not.toMatch(/går inte|cannot|impossible/i);
    });

    it('says the time ran out when it did, and keeps what it had laid', async () => {
      service.budgetMs = -1;
      const proposal = await service.propose({ academicYearId: YEAR, scope: 'CLASS', studentGroupId: 'c1' }, asAdmin);
      expect(proposal.truncated).toBe(true);
      expect(proposal.left.map((entry) => entry.reason)).toEqual(['TIME', 'TIME']);
    });

    it('answers a question about nothing with nothing, without building a world', async () => {
      const proposal = await service.propose({ academicYearId: YEAR, scope: 'CLASS', studentGroupId: 'nobody' }, asAdmin);
      expect(proposal).toMatchObject({ asked: 0, placed: [], left: [] });
      expect(possible.worldOf).not.toHaveBeenCalled();
    });

    it('asks for the class of a CLASS scope, the year of a GRADE scope and the bricks of a BRICKS scope, and is refused without them', async () => {
      await expect(service.propose({ academicYearId: YEAR, scope: 'CLASS' }, asAdmin)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.propose({ academicYearId: YEAR, scope: 'GRADE' }, asAdmin)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.propose({ academicYearId: YEAR, scope: 'BRICKS' }, asAdmin)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('asks for the classes whose pupils are in the year when the scope is GRADE', async () => {
      // The swap tests' school has three classes, all of year 7: every brick of the tray is theirs, the one nobody teaches among them.
      expect((await service.propose({ academicYearId: YEAR, scope: 'GRADE', gradeLevel: 7 }, asAdmin)).asked).toBe(3);
      expect((await service.propose({ academicYearId: YEAR, scope: 'GRADE', gradeLevel: 8 }, asAdmin)).asked).toBe(0);
    });

    it('asks for the bricks named, and is told by a 409 when one is not a brick of the tray as it is now', async () => {
      const refs = [{ postId: POST_A, teacherId: TEACHER, minutes: 60, nth: 2 }];
      expect((await service.propose({ academicYearId: YEAR, scope: 'BRICKS', bricks: refs }, asAdmin)).asked).toBe(1);
      await expect(service.propose({ academicYearId: YEAR, scope: 'BRICKS', bricks: [{ ...refs[0]!, nth: 9 }] }, asAdmin)).rejects.toMatchObject({ response: { code: BOARD_FILL_STALE } });
    });

    it('makes a basis that is the same for the same year and another for any lesson or post that changed or any part that the tray keys differently', async () => {
      const first = (await service.propose({ academicYearId: YEAR, scope: 'SCHOOL' }, asAdmin)).basis;
      expect((await service.propose({ academicYearId: YEAR, scope: 'SCHOOL' }, asAdmin)).basis).toBe(first);
      tx['masterLesson']!['aggregate']!.mockResolvedValue({ _count: { _all: 10 }, _max: { updatedAt: new Date('2026-11-01T10:00:01Z') } });
      const moved = (await service.propose({ academicYearId: YEAR, scope: 'SCHOOL' }, asAdmin)).basis;
      expect(moved).not.toBe(first);
      tx['masterLesson']!['aggregate']!.mockResolvedValue({ _count: { _all: 10 }, _max: { updatedAt: new Date('2026-11-01T10:00:00Z') } });
      bricks[0] = brick({ partKey: 'q'.repeat(16) });
      expect((await service.propose({ academicYearId: YEAR, scope: 'SCHOOL' }, asAdmin)).basis).not.toBe(first);
    });
  });

  describe('apply (Ta in)', () => {
    const items = () => [
      { key: keyOf(bricks[0]!), dayOfWeek: 2, startTime: '09:00', roomId: null },
      { key: keyOf(bricks[1]!), dayOfWeek: 3, startTime: '10:15' },
    ];
    const basisNow = async (): Promise<string> => (await service.propose({ academicYearId: YEAR, scope: 'SCHOOL' }, asAdmin)).basis;

    it('takes the school\'s mode, the year\'s lock (exclusive: one Ta in at a time) and the posts\' locks in id order, reads the tray under them, saves a version, and then writes each lesson', async () => {
      const dto = { academicYearId: YEAR, basis: await basisNow(), items: items() };
      const result = await service.apply(dto, asAdmin);
      expect(order).toEqual(['mode', 'year', 'post:A', 'version']);
      expect(versions.snapshotInTransaction).toHaveBeenCalledWith(tx, YEAR, 'Före påfyllning', asAdmin);
      expect(tray.writeBrick).toHaveBeenCalledTimes(2);
      expect(tray.writeBrick.mock.calls[0]).toEqual([tx, bricks[0], { academicYearId: YEAR, postId: POST_A, dayOfWeek: 2, startTime: '09:00', roomId: null, ownLessonIds: new Set() }, asAdmin]);
      expect(tray.writeBrick.mock.calls[1]![2]).toMatchObject({ dayOfWeek: 3, startTime: '10:15', roomId: null });
      expect(result).toEqual({
        academicYearId: YEAR,
        versionId: 'version-1',
        laid: [
          { key: keyOf(bricks[0]!), lessonId: 'lesson-1', created: true, noRoom: true },
          { key: keyOf(bricks[1]!), lessonId: 'lesson-2', created: true, noRoom: true },
        ],
      });
    });

    it('names a version as asked, and moves a lesson on the tray back as itself, saying which lessons on the tray the part has', async () => {
      bricks = [brick({ lessonId: 'parked-1' }), brick({ nth: 2, lessonId: 'parked-2' })];
      const result = await service.apply({ academicYearId: YEAR, basis: await basisNow(), items: items(), versionName: '  Före klass 7A  ' }, asAdmin);
      expect(versions.snapshotInTransaction).toHaveBeenCalledWith(tx, YEAR, 'Före klass 7A', asAdmin);
      expect(tray.writeBrick.mock.calls[0]![2]).toMatchObject({ lessonId: 'parked-1', ownLessonIds: new Set(['parked-1', 'parked-2']) });
      expect(result.laid.map((entry) => entry.created)).toEqual([false, false]);
    });

    it('does not take the lock of a year that is not the school\'s: 404 before any lock, so that a stranger\'s request never queues the owner\'s edits', async () => {
      tx['academicYear']!['findUnique']!.mockResolvedValue(null);
      await expect(service.apply({ academicYearId: YEAR, basis: 'a'.repeat(32), items: items() }, asAdmin)).rejects.toMatchObject({ status: 404 });
      expect(lockYearForRegeneration).not.toHaveBeenCalled();
      expect(lockPostForShares).not.toHaveBeenCalled();
      expect(versions.snapshotInTransaction).not.toHaveBeenCalled();
    });

    it('gives the transaction the time of its lessons, under the ceiling: a Ta in of 600 lessons does not ask for 370 s', async () => {
      const refs = Array.from({ length: 600 }, (_, index) => ({ key: `${POST_A}|${TEACHER}|60|${index + 1}`, dayOfWeek: 2, startTime: '09:00' }));
      await expect(service.apply({ academicYearId: YEAR, basis: 'a'.repeat(32), items: refs }, asAdmin)).rejects.toMatchObject({ response: { code: BOARD_FILL_STALE } });
      const calls = prisma.withRls.mock.calls as unknown as Array<[unknown, unknown, { timeoutMs: number }]>;
      expect(calls.at(-1)![2]).toEqual({ timeoutMs: FILL_APPLY_CEILING_MS });
      await service.apply({ academicYearId: YEAR, basis: await basisNow(), items: items() }, asAdmin);
      expect((prisma.withRls.mock.calls as unknown as Array<[unknown, unknown, { timeoutMs: number }]>).at(-1)![2]).toEqual({ timeoutMs: applyTimeoutMs(2) });
    });

    it('answers 409 BOARD_FILL_TIMED_OUT, in words, when the transaction runs out of its time: nothing was written, and fewer at a time is the way on (g523)', async () => {
      const expired = new Prisma.PrismaClientKnownRequestError('Transaction API error: A query cannot be executed on an expired transaction. The timeout for this transaction was 15000 ms.', { code: 'P2028', clientVersion: 'test' });
      tray.writeBrick.mockRejectedValue(expired);
      const refused = await service.apply({ academicYearId: YEAR, basis: await basisNow(), items: items() }, asAdmin).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(ConflictException);
      const body = (refused as ConflictException).getResponse() as { message: string; code: string; params: Record<string, number> };
      expect(body.code).toBe(BOARD_FILL_TIMED_OUT);
      expect(body.params).toEqual({ lessons: 2, seconds: 15 });
      expect(body.message).toMatch(/ingenting skrevs/);
      expect(body.message).toMatch(/färre åt gången/);
    });

    it('leaves a connection that never came free to the filter (503 DATABASE_BUSY), and any other failure as it is', async () => {
      const never = new Prisma.PrismaClientKnownRequestError('Unable to start a transaction in the given time.', { code: 'P2028', clientVersion: 'test' });
      tray.writeBrick.mockRejectedValueOnce(never);
      await expect(service.apply({ academicYearId: YEAR, basis: await basisNow(), items: items() }, asAdmin)).rejects.toBe(never);
      const other = new Error('boom');
      tray.writeBrick.mockRejectedValueOnce(other);
      await expect(service.apply({ academicYearId: YEAR, basis: await basisNow(), items: items() }, asAdmin)).rejects.toBe(other);
    });

    it('writes nothing and saves no version when the grundschema is not the one the proposal was made on', async () => {
      const basis = await basisNow();
      tx['masterLesson']!['aggregate']!.mockResolvedValue({ _count: { _all: 11 }, _max: { updatedAt: new Date('2026-11-01T10:00:00Z') } });
      await expect(service.apply({ academicYearId: YEAR, basis, items: items() }, asAdmin)).rejects.toMatchObject({ response: { code: BOARD_FILL_STALE } });
      expect(versions.snapshotInTransaction).not.toHaveBeenCalled();
      expect(tray.writeBrick).not.toHaveBeenCalled();
    });

    it('is stale for a brick that is no brick of the tray now, and for a brick that cannot be laid on its own', async () => {
      const basis = await basisNow();
      await expect(service.apply({ academicYearId: YEAR, basis, items: [{ key: `${POST_A}|${TEACHER}|60|7`, dayOfWeek: 2, startTime: '09:00' }] }, asAdmin)).rejects.toMatchObject({ response: { code: BOARD_FILL_STALE } });
      await expect(service.apply({ academicYearId: YEAR, basis, items: [{ key: keyOf(bricks[2]!), dayOfWeek: 2, startTime: '09:00' }] }, asAdmin)).rejects.toMatchObject({ response: { code: BOARD_FILL_STALE } });
      expect(tray.writeBrick).not.toHaveBeenCalled();
    });

    it('refuses a brick named twice before anything is taken', async () => {
      await expect(service.apply({ academicYearId: YEAR, basis: 'x', items: [items()[0]!, items()[0]!] }, asAdmin)).rejects.toBeInstanceOf(BadRequestException);
      expect(enterGrundschemaWrite).not.toHaveBeenCalled();
    });

    it('lets the hand edit\'s own refusal of a time through, which rolls the whole write back', async () => {
      tray.writeBrick.mockRejectedValueOnce(new ConflictException({ code: 'MASTER_LESSON_REFUSED' }));
      await expect(service.apply({ academicYearId: YEAR, basis: await basisNow(), items: items() }, asAdmin)).rejects.toMatchObject({ response: { code: 'MASTER_LESSON_REFUSED' } });
      expect(tray.writeBrick).toHaveBeenCalledTimes(1);
    });
  });
});
