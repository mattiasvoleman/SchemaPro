import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { applyReinstatement, cancelInto, digestLessonsOf, pendingLessons, reversePlan } from './cancellation-core';
import { CancellationBatchesService } from './cancellation-batches.service';
import { digestAudience, sendDigest } from './cancellation-digest';

/**
 * What the service decides when a batch is taken back, as opposed to what the plan itself holds (cancellation-core.reverse-plan.spec.ts)
 * and what the database does (scripts/test/prisma-adapter-probe.ts, which runs this service against a real one): who is told, which
 * lessons the board and the clients hear of, what the batch says it put back, and the order of the writes. The lessons carried to the
 * template's slot (a DIRECT edit moved the grundschema after the batch) are the ones this spec is for: the review of #319 found
 * that nothing here saw them.
 */
jest.mock('./cancellation-core', () => ({
  ...jest.requireActual('./cancellation-core'),
  reversePlan: jest.fn(),
  applyReinstatement: jest.fn(),
  digestLessonsOf: jest.fn(),
  pendingLessons: jest.fn(),
  cancelInto: jest.fn(),
}));
jest.mock('./cancellation-digest', () => ({
  ...jest.requireActual('./cancellation-digest'),
  digestAudience: jest.fn(),
  sendDigest: jest.fn(),
}));

const planOf = reversePlan as jest.MockedFunction<typeof reversePlan>;
const apply = applyReinstatement as jest.MockedFunction<typeof applyReinstatement>;
const lessonsOf = digestLessonsOf as jest.MockedFunction<typeof digestLessonsOf>;
const pending = pendingLessons as jest.MockedFunction<typeof pendingLessons>;
const take = cancelInto as jest.MockedFunction<typeof cancelInto>;
const audienceOf = digestAudience as jest.MockedFunction<typeof digestAudience>;
const digest = sendDigest as jest.MockedFunction<typeof sendDigest>;

const YEAR = 'year-1';
const BATCH = 'batch-1';
const OTHER = 'batch-2';
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const batchRow = (over: Record<string, unknown> = {}) => ({
  id: BATCH,
  academicYearId: YEAR,
  name: 'Prao åk 7',
  cause: 'EVENT',
  fromDate: day('2026-11-09'),
  toDate: day('2026-11-10'),
  startTime: null,
  endTime: null,
  scope: 'GROUPS',
  minGradeLevel: null,
  maxGradeLevel: null,
  groupIds: ['g7a'],
  cancelled: 3,
  createdAt: new Date('2026-11-01T08:00:00.000Z'),
  createdByUserId: null,
  reversedAt: null,
  reinstated: 0,
  skippedRoomTaken: 0,
  notifies: true,
  _count: { credits: 0 },
  ...over,
});

const move = (id: string, from: string, to: string) => ({
  id,
  previousNote: null,
  from,
  to,
  startsAt: new Date(`${to}T07:00:00.000Z`),
  endsAt: new Date(`${to}T08:00:00.000Z`),
  roomId: null,
  leadId: null,
});

/** What a plan holds: the lessons that come back where they stood, and the ones carried to the template's slot. */
const plan = (over: Record<string, unknown> = {}) =>
  ({
    reinstate: [{ id: 'back', previousNote: null }],
    relocate: [move('carried', '2026-11-09', '2026-11-12')],
    skipped: [],
    templateMoved: [],
    notReinstatable: 0,
    creditIds: [],
    ...over,
  }) as unknown as Awaited<ReturnType<typeof reversePlan>>;

describe('CancellationBatchesService, taking a batch back', () => {
  let tx: TxMock;
  let service: CancellationBatchesService;
  let realtime: { notifyCoverBoardChanged: jest.Mock; notifyLessonsChanged: jest.Mock };
  const user = testUser();
  const SCHOOL = user.schoolId as string;
  let row: ReturnType<typeof batchRow>;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    row = batchRow();
    tx = createTxMock();
    realtime = { notifyCoverBoardChanged: jest.fn(), notifyLessonsChanged: jest.fn().mockResolvedValue(undefined) };
    service = new CancellationBatchesService(
      createPrismaMock(tx) as unknown as PrismaService,
      realtime as unknown as RealtimeService,
      {} as unknown as NotificationsService,
    );
    tx.cancellationBatch.findUnique.mockImplementation(async () => row);
    tx.scheduleActivity.findFirst.mockResolvedValue(null);
    tx.academicYear.findUnique.mockResolvedValue({ school: { timezone: 'Europe/Stockholm' } });
    tx.cancellationBatch.findMany.mockResolvedValue([]);
    planOf.mockResolvedValue(plan());
    apply.mockResolvedValue(undefined);
    // The digest reads the lessons by id: the spec lets the ids through so that what is asked about can be read off the calls.
    lessonsOf.mockImplementation(async (_tx, rows) => rows.map((entry) => ({ id: entry.id, date: '2026-11-12' }) as never));
    audienceOf.mockImplementation(async (_tx, lessons) => ({
      people: new Map(lessons.map((entry) => [`person-of-${entry.id}`, { lessons: new Set([entry.id]), first: entry.date, last: entry.date }])),
      counts: { pupils: lessons.length, guardians: 0, teachers: 0 },
    }));
    digest.mockResolvedValue(7);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  const idsAskedOfTheDigest = (call = 0): string[] => lessonsOf.mock.calls[call]![1].map((entry) => entry.id);

  describe('the preview', () => {
    it('says what comes back, the lessons carried to the template’s slot and who the digest would reach: the carried ones are people too', async () => {
      const preview = await service.reversePreview(BATCH, user);
      expect(preview).toEqual({
        reinstate: 1,
        notify: 2,
        skippedRoomTaken: [],
        removedTemplateMoved: [],
        relocated: [{ lessonId: 'carried', from: '2026-11-09', to: '2026-11-12' }],
        notReinstatable: 0,
        creditsDeleted: 0,
      });
      // Both kinds of lesson are asked about, in this order: the one that comes back and the one that is carried.
      expect(idsAskedOfTheDigest()).toEqual(['back', 'carried']);
    });

    it('reaches nobody for a batch that told nobody, and asks nobody', async () => {
      row = batchRow({ notifies: false });
      expect((await service.reversePreview(BATCH, user)).notify).toBe(0);
      expect(audienceOf).not.toHaveBeenCalled();
    });

    it('writes nothing', async () => {
      await service.reversePreview(BATCH, user);
      expect(apply).not.toHaveBeenCalled();
      expect(tx.cancellationBatch.update).not.toHaveBeenCalled();
      expect(digest).not.toHaveBeenCalled();
    });

    it.each([
      ['a batch already reversed', () => batchRow({ reversedAt: new Date('2026-11-04T00:00:00.000Z') }), 'CANCELLATION_REVERSED'],
    ])('refuses %s', async (_label, make, expected) => {
      row = make();
      const error = await service.reversePreview(BATCH, user).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({ code: expected });
    });

    it('refuses a batch that is not there, and one an activity owns', async () => {
      tx.cancellationBatch.findUnique.mockResolvedValue(null);
      await expect(service.reversePreview(BATCH, user)).rejects.toBeInstanceOf(NotFoundException);
      tx.cancellationBatch.findUnique.mockResolvedValue(row);
      tx.scheduleActivity.findFirst.mockResolvedValue({ id: 'activity-1' });
      const error = await service.reversePreview(BATCH, user).catch((e: unknown) => e);
      expect((error as ConflictException).getResponse()).toMatchObject({ code: 'ACTIVITY_OWNS_BATCH' });
    });
  });

  describe('the reversal', () => {
    it('writes the plan, and the batch says it put back the lessons that were carried as well as the ones that came back where they stood', async () => {
      const result = await service.reverse(BATCH, user);
      expect(apply).toHaveBeenCalledWith(tx, 'EVENT', expect.objectContaining({ reinstate: [expect.anything()], relocate: [expect.anything()] }));
      expect(tx.cancellationBatch.update).toHaveBeenCalledWith({
        where: { id: BATCH },
        data: { reversedAt: expect.any(Date), reversedByUserId: user.userId, reinstated: 2, skippedRoomTaken: 0 },
      });
      expect(result).toMatchObject({
        reinstate: 1,
        relocated: [{ lessonId: 'carried', from: '2026-11-09', to: '2026-11-12' }],
        removedTemplateMoved: [],
        notReinstatable: 0,
        creditsDeleted: 0,
      });
    });

    it('tells the people of every lesson that comes back, the carried ones too, in one digest that says it is a reversal', async () => {
      const result = await service.reverse(BATCH, user);
      expect(idsAskedOfTheDigest()).toEqual(['back', 'carried']);
      expect(digest).toHaveBeenCalledTimes(1);
      expect(digest.mock.calls[0]![2]).toBe(SCHOOL);
      expect(digest.mock.calls[0]![3]).toEqual({ id: BATCH, name: 'Prao åk 7' });
      expect([...digest.mock.calls[0]![4].people.keys()].sort()).toEqual(['person-of-back', 'person-of-carried']);
      expect(digest.mock.calls[0]![5]).toBe(true);
      // The answer says how many were told: what the digest said, not what the preview guessed.
      expect(result.notify).toBe(7);
    });

    it('tells nobody for a batch that told nobody', async () => {
      row = batchRow({ notifies: false });
      const result = await service.reverse(BATCH, user);
      expect(digest).not.toHaveBeenCalled();
      expect(audienceOf).not.toHaveBeenCalled();
      expect(result.notify).toBe(0);
    });

    it('lets the clients hear of every lesson that came back, the carried ones too', async () => {
      await service.reverse(BATCH, user);
      expect(realtime.notifyLessonsChanged).toHaveBeenCalledTimes(1);
      expect(realtime.notifyLessonsChanged).toHaveBeenCalledWith(tx, ['back', 'carried']);
    });

    it('lets the board hear of the days it changed on: the batch’s own, and the day a lesson left and the day it came to', async () => {
      // The batch is the 9th and the 10th. One lesson left the 3rd for the 4th (before it), another the 11th for the 13th (after it).
      planOf.mockResolvedValue(plan({ relocate: [move('early', '2026-11-03', '2026-11-04'), move('late', '2026-11-11', '2026-11-13')] }));
      await service.reverse(BATCH, user);
      expect(realtime.notifyCoverBoardChanged).toHaveBeenCalledWith(SCHOOL, '2026-11-03', '2026-11-13');
    });

    it('lets the board hear of the batch’s own days when nothing is carried', async () => {
      planOf.mockResolvedValue(plan({ relocate: [] }));
      await service.reverse(BATCH, user);
      expect(realtime.notifyCoverBoardChanged).toHaveBeenCalledWith(SCHOOL, '2026-11-09', '2026-11-10');
    });

    it('lets the board hear of the batch’s own days, and the day a lesson came to, when that lies inside them', async () => {
      planOf.mockResolvedValue(plan({ relocate: [move('inside', '2026-11-09', '2026-11-10')] }));
      await service.reverse(BATCH, user);
      expect(realtime.notifyCoverBoardChanged).toHaveBeenCalledWith(SCHOOL, '2026-11-09', '2026-11-10');
    });

    it('deletes the credits ahead, and only when there are some', async () => {
      await service.reverse(BATCH, user);
      expect(tx.timplanCredit.deleteMany).not.toHaveBeenCalled();
      planOf.mockResolvedValue(plan({ creditIds: ['c1', 'c2'] }));
      await service.reverse(BATCH, user);
      expect(tx.timplanCredit.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['c1', 'c2'] } } });
    });

    it('is done once, and not for an activity’s batch', async () => {
      row = batchRow({ reversedAt: new Date('2026-11-04T00:00:00.000Z') });
      expect(((await service.reverse(BATCH, user).catch((e: unknown) => e)) as ConflictException).getResponse()).toMatchObject({ code: 'CANCELLATION_REVERSED' });
      row = batchRow();
      tx.scheduleActivity.findFirst.mockResolvedValue({ id: 'activity-1' });
      expect(((await service.reverse(BATCH, user).catch((e: unknown) => e)) as ConflictException).getResponse()).toMatchObject({ code: 'ACTIVITY_OWNS_BATCH' });
      expect(apply).not.toHaveBeenCalled();
    });

    it('is done even when the broadcasts fail', async () => {
      realtime.notifyLessonsChanged.mockRejectedValue(new Error('no clients'));
      realtime.notifyCoverBoardChanged.mockImplementation(() => {
        throw new Error('no board');
      });
      await expect(service.reverse(BATCH, user)).resolves.toMatchObject({ reinstate: 1 });
    });
  });

  /**
   * A lesson carried to another day may land in a day another batch still holds: that one takes it (S7), as it takes a row a
   * template change moves there. It is held after this batch is marked reversed, so that this one does not take its own lesson back.
   */
  describe('the lessons carried to a day another batch holds', () => {
    it('asks every batch still on over the span of the days the lessons were carried to, from the first of them to the last', async () => {
      planOf.mockResolvedValue(plan({ relocate: [move('tue', '2026-11-09', '2026-11-10'), move('thu', '2026-11-09', '2026-11-12'), move('wed', '2026-11-09', '2026-11-11')] }));
      await service.reverse(BATCH, user);
      expect(tx.cancellationBatch.findMany).toHaveBeenCalledWith({
        where: { academicYearId: YEAR, reversedAt: null, fromDate: { lte: day('2026-11-12') }, toDate: { gte: day('2026-11-10') } },
        select: expect.anything(),
      });
    });

    it('asks after the batch is marked reversed', async () => {
      await service.reverse(BATCH, user);
      const marked = tx.cancellationBatch.update.mock.invocationCallOrder[0]!;
      const asked = tx.cancellationBatch.findMany.mock.invocationCallOrder[0]!;
      expect(marked).toBeLessThan(asked);
    });

    it('asks nothing when nothing was carried', async () => {
      planOf.mockResolvedValue(plan({ relocate: [] }));
      await service.reverse(BATCH, user);
      expect(tx.cancellationBatch.findMany).not.toHaveBeenCalled();
    });

    describe('and that one takes it', () => {
      beforeEach(() => {
        tx.cancellationBatch.findMany.mockResolvedValue([batchRow({ id: OTHER, name: 'Studiedag', fromDate: day('2026-11-12'), toDate: day('2026-11-12') })]);
        pending.mockResolvedValue([{ id: 'carried' }] as never);
        take.mockResolvedValue(1);
      });

      it('leaves the lesson out of the digest, which would say that it is back when it is cancelled again, and out of nothing else', async () => {
        const result = await service.reverse(BATCH, user);
        expect(take).toHaveBeenCalledWith(tx, SCHOOL, OTHER, expect.anything(), [{ id: 'carried' }]);
        expect(idsAskedOfTheDigest()).toEqual(['back']);
        expect([...digest.mock.calls[0]![4].people.keys()]).toEqual(['person-of-back']);
        expect(result.notify).toBe(7);
        // The clients and the board hear of it all the same: the lesson changed, twice.
        expect(realtime.notifyLessonsChanged).toHaveBeenCalledWith(tx, ['back', 'carried']);
        // And the answer still says the lesson was carried: that is what the reversal did.
        expect(result.relocated).toEqual([{ lessonId: 'carried', from: '2026-11-09', to: '2026-11-12' }]);
      });
    });

    describe('and none does', () => {
      it('tells of the carried lesson as of any that comes back', async () => {
        pending.mockResolvedValue([]);
        await service.reverse(BATCH, user);
        expect(idsAskedOfTheDigest()).toEqual(['back', 'carried']);
      });
    });
  });
});
