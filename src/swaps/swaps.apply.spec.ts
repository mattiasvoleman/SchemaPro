import { BadRequestException, ConflictException } from '@nestjs/common';
import { MasterLessonsService } from '../calendar/master-lessons.service';
import { propagateTemplateChange } from '../calendar/propagate-template';
import { fakeTx, makeWorld, rowOf, SCHOOL, YEAR, type World } from './__fixtures__/swap-world';
import { readSwapData } from './swap-snapshot';
import type { SwapLesson } from './swap-types';
import { SWAP_BREAKS_BOARD_RULE, SWAP_LOCKED, SWAP_SPLITS_PARALLEL, SWAP_STALE, SwapsService } from './swaps.service';

jest.mock('./swap-snapshot', () => ({ readSwapData: jest.fn() }));
jest.mock('../calendar/propagate-template', () => ({
  ...jest.requireActual('../calendar/propagate-template'),
  propagateTemplateChange: jest.fn(async () => ({ moved: 1, removed: 0 })),
}));

const user = { userId: 'u1', role: 'SCHOOL_ADMIN', schoolId: SCHOOL } as never;

const clockOf = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** The tx of an apply: the clash reads of the world, the row locks, the writes recorded. */
function applyTx(world: World, lessons: () => SwapLesson[] = () => world.data.lessons) {
  const base = fakeTx(world, lessons);
  const written: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const changeLog: Array<Record<string, unknown>> = [];
  const calls: string[] = [];
  const tx = {
    ...base,
    $queryRaw: jest.fn(async () => [{ mode: 'DIRECT' }]),
    masterLesson: {
      ...base.masterLesson,
      findMany: jest.fn(async (args: { where: Record<string, unknown> }) => {
        const ids = (args.where['id'] as { in?: string[] } | undefined)?.in;
        if (ids && !('dayOfWeek' in args.where)) {
          calls.push('read-rows');
          return lessons()
            .filter((lesson) => ids.includes(lesson.id))
            .map((lesson) => ({
              ...rowOf(lesson),
              isLocked: lesson.isLocked,
              school: { id: SCHOOL, timezone: 'Europe/Stockholm' },
            }))
            .sort((a, b) => (a.id < b.id ? -1 : 1));
        }
        return base.masterLesson.findMany(args as never);
      }),
      updateMany: jest.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        calls.push('write');
        written.push(args);
        return { count: 1 };
      }),
    },
    scheduleChangeLog: { create: jest.fn(async (args: { data: Record<string, unknown> }) => changeLog.push(args.data)) },
  };
  return { tx, written, changeLog, calls };
}

function build(world: World, tx: unknown) {
  (readSwapData as jest.Mock).mockResolvedValue(world.data);
  const snapshot = jest.fn(async () => ({ id: 'version-1' }));
  const realtime = { notifyMasterTimetableChanged: jest.fn() };
  const notifications = { recipientsForLessons: jest.fn(async () => ['pupil-1']), notifyUsers: jest.fn() };
  const swaps = new SwapsService(
    { withRls: (_user: unknown, run: (tx: unknown) => unknown) => run(tx) } as never,
    new MasterLessonsService({} as never, {} as never, {} as never),
    { snapshotInTransaction: snapshot } as never,
    realtime as never,
    notifications as never,
  );
  return { swaps, snapshot, realtime, notifications };
}

const body = (world: World, pairs: Array<[SwapLesson, SwapLesson]>, over: Record<string, unknown> = {}) => ({
  lessonId: pairs[0]![0].id,
  moves: pairs.flatMap(([from, to]) => [
    {
      lessonId: from.id,
      from: { dayOfWeek: from.dayOfWeek, startTime: clockOf(from.startMinutes), endTime: clockOf(from.endMinutes) },
      to: { dayOfWeek: to.dayOfWeek, startTime: clockOf(to.startMinutes), endTime: clockOf(to.endMinutes) },
    },
  ]),
  ...over,
});

/** A pair whose swap leaves nothing double-booked: found by asking the service. */
async function aGoodSwap(world: World) {
  const tx = applyTx(world).tx;
  const { swaps } = build(world, tx);
  for (const lesson of world.data.lessons) {
    const offered = await swaps.suggest({ lessonId: lesson.id, limit: 50 }, user);
    const swap = offered.proposals.find((proposal) => proposal.kind === 'SWAP');
    if (swap) return { lesson, swap };
  }
  throw new Error('the world has no swap');
}

describe('SwapsService.apply', () => {
  const world = makeWorld({ seed: 7 });

  beforeEach(() => (propagateTemplateChange as jest.Mock).mockClear());

  it('writes a proposal as one move: a safety version first, then every lesson, the calendar following, a log row each', async () => {
    const { lesson, swap } = await aGoodSwap(world);
    const { tx, written, changeLog, calls } = applyTx(world);
    const { swaps, snapshot, realtime, notifications } = build(world, tx);
    snapshot.mockImplementation(async () => {
      calls.push('snapshot');
      return { id: 'version-1' };
    });

    const result = await swaps.apply(
      {
        lessonId: lesson.id,
        moves: swap.moves.map((move) => ({
          lessonId: move.lessonId,
          from: { dayOfWeek: move.from.dayOfWeek, startTime: clockOf(move.from.startMinutes), endTime: clockOf(move.from.endMinutes) },
          to: { dayOfWeek: move.to.dayOfWeek, startTime: clockOf(move.to.startMinutes), endTime: clockOf(move.to.endMinutes) },
        })),
        versionName: 'Före byte av 7A matematik',
      },
      user,
    );

    expect(calls.indexOf('snapshot')).toBeLessThan(calls.indexOf('write'));
    expect(snapshot).toHaveBeenCalledWith(tx, YEAR, 'Före byte av 7A matematik', user);
    expect(written).toHaveLength(2);
    for (const move of swap.moves) {
      const row = written.find((entry) => entry.where['id'] === move.lessonId)!;
      expect(row.data['dayOfWeek']).toBe(move.to.dayOfWeek);
      // The write is held to where the lesson stood.
      expect(row.where['isParked']).toBe(false);
    }
    expect(changeLog).toHaveLength(2);
    expect(changeLog[0]).toMatchObject({ action: 'UPDATE', schoolId: SCHOOL, academicYearId: YEAR });
    expect(propagateTemplateChange).toHaveBeenCalledTimes(2);
    expect(realtime.notifyMasterTimetableChanged).toHaveBeenCalledWith(SCHOOL);
    expect(notifications.notifyUsers).toHaveBeenCalledTimes(2);
    expect(result.versionId).toBe('version-1');
    expect(result.propagatedLessons).toBe(2);
    // The undo is the same moves reversed.
    expect(result.undo).toEqual(swap.moves.map((move) => ({ lessonId: move.lessonId, from: move.to, to: move.from })));
  });

  it('leaves the published calendar alone when asked to, and in a draft', async () => {
    const { lesson, swap } = await aGoodSwap(world);
    const request = {
      lessonId: lesson.id,
      propagate: false,
      moves: swap.moves.map((move) => ({
        lessonId: move.lessonId,
        from: { dayOfWeek: move.from.dayOfWeek, startTime: clockOf(move.from.startMinutes), endTime: clockOf(move.from.endMinutes) },
        to: { dayOfWeek: move.to.dayOfWeek, startTime: clockOf(move.to.startMinutes), endTime: clockOf(move.to.endMinutes) },
      })),
    };
    const { tx } = applyTx(world);
    const { swaps, notifications } = build(world, tx);
    await swaps.apply(request, user);
    expect(propagateTemplateChange).not.toHaveBeenCalled();
    expect(notifications.notifyUsers).not.toHaveBeenCalled();

    const drafted = applyTx(world);
    drafted.tx.$queryRaw.mockResolvedValue([{ mode: 'DRAFT' }]);
    const draft = build(world, drafted.tx);
    await draft.swaps.apply({ ...request, propagate: undefined }, user);
    expect(propagateTemplateChange).not.toHaveBeenCalled();
    expect(draft.realtime.notifyMasterTimetableChanged).toHaveBeenCalledWith(SCHOOL, { draft: true });
  });

  it('is a 409 SWAP_STALE when a lesson no longer stands where the page saw it, and writes nothing', async () => {
    const { lesson, swap } = await aGoodSwap(world);
    const moved = world.data.lessons.map((l) => (l.id === swap.moves[1]!.lessonId ? { ...l, startMinutes: l.startMinutes + 60, endMinutes: l.endMinutes + 60 } : l));
    const { tx, written } = applyTx(world, () => moved);
    const { swaps, snapshot } = build(world, tx);
    await expect(
      swaps.apply(
        {
          lessonId: lesson.id,
          moves: swap.moves.map((move) => ({
            lessonId: move.lessonId,
            from: { dayOfWeek: move.from.dayOfWeek, startTime: clockOf(move.from.startMinutes), endTime: clockOf(move.from.endMinutes) },
            to: { dayOfWeek: move.to.dayOfWeek, startTime: clockOf(move.to.startMinutes), endTime: clockOf(move.to.endMinutes) },
          })),
        },
        user,
      ),
    ).rejects.toMatchObject({ response: { code: SWAP_STALE } });
    expect(written).toHaveLength(0);
    expect(snapshot).not.toHaveBeenCalled();
  });

  it('refuses a double booking with the clash rule’s own sentence, and writes nothing', async () => {
    // Two lessons of one teacher whose swap leaves someone else's lesson in the way.
    let found: [SwapLesson, SwapLesson] | null = null;
    const probe = applyTx(world);
    const { swaps: prober } = build(world, probe.tx);
    for (const a of world.data.lessons) {
      const offered = await prober.suggest({ lessonId: a.id, limit: 100000 }, user);
      const ids = new Set(offered.proposals.filter((p) => p.kind === 'SWAP').map((p) => p.moves[1]!.lessonId));
      const refused = world.data.lessons.find(
        (b) => b.id !== a.id && !ids.has(b.id) && b.dayOfWeek !== a.dayOfWeek && b.endMinutes - b.startMinutes === a.endMinutes - a.startMinutes,
      );
      if (refused) {
        found = [a, refused];
        break;
      }
    }
    expect(found).not.toBeNull();
    const [a, b] = found!;
    const { tx, written } = applyTx(world);
    const { swaps } = build(world, tx);
    const error = await swaps.apply(body(world, [[a, b], [b, a]]), user).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).message).toMatch(/already|group|Teacher|Room/);
    expect(written).toHaveLength(0);
  });

  it('refuses a lesson named twice, a picked lesson outside the moves and a single unit', async () => {
    const [a, b] = world.data.lessons as [SwapLesson, SwapLesson];
    const { swaps } = build(world, applyTx(world).tx);
    await expect(swaps.apply(body(world, [[a, b], [a, b]]), user)).rejects.toBeInstanceOf(BadRequestException);
    await expect(swaps.apply({ ...body(world, [[a, b], [b, a]]), lessonId: world.data.lessons[5]!.id }, user)).rejects.toBeInstanceOf(BadRequestException);
    await expect(swaps.apply(body(world, [[a, a]], { moves: [] }), user)).rejects.toBeDefined();
  });

  it('refuses to change a lesson’s length', async () => {
    const [a, b] = world.data.lessons as [SwapLesson, SwapLesson];
    const request = body(world, [[a, b], [b, a]]);
    request.moves[0]!.to.endTime = clockOf(b.endMinutes + 30);
    const { swaps } = build(world, applyTx(world).tx);
    await expect(swaps.apply(request, user)).rejects.toBeInstanceOf(BadRequestException);
  });

  describe('a unit goes whole, or not at all', () => {
    // Two lessons of one block standing in one slot, and a third lesson elsewhere.
    const blocked = makeWorld({ seed: 7 });
    const [first] = blocked.data.lessons;
    const second = blocked.data.lessons.find(
      (l) => l.id !== first!.id && l.dayOfWeek === first!.dayOfWeek && l.startMinutes === first!.startMinutes,
    )!;
    const elsewhere = blocked.data.lessons.find((l) => l.dayOfWeek !== first!.dayOfWeek && l.studentGroupId !== first!.studentGroupId)!;
    blocked.data.posts = [first!, second].map((l) => ({
      studentGroupId: l.studentGroupId,
      subjectId: l.subjectId,
      blockId: 'block-1',
      minutesBefore: 0,
      minutesAfter: 0,
      distribution: { maxLessonsPerDay: null, minDaysBetween: null },
    }));
    blocked.data.blocks = [{ id: 'block-1', sameTimesAsBlockId: null }];

    it('has two lessons laid together', () => {
      expect(second).toBeDefined();
    });

    it('is a 409 SWAP_SPLITS_PARALLEL when the moves would part the block, naming the lessons left behind', async () => {
      const { tx, written } = applyTx(blocked);
      const { swaps } = build(blocked, tx);
      const error = await swaps.apply(body(blocked, [[first!, elsewhere], [elsewhere, first!]]), user).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({ code: SWAP_SPLITS_PARALLEL, lessonIds: [second.id] });
      expect(written).toHaveLength(0);
    });
  });

  it('is a 409 SWAP_LOCKED for a locked lesson that was not the picked one, and lets the picked one be locked', async () => {
    const { lesson, swap } = await aGoodSwap(world);
    const partnerId = swap.moves.find((move) => move.lessonId !== lesson.id)!.lessonId;
    const request = {
      lessonId: lesson.id,
      moves: swap.moves.map((move) => ({
        lessonId: move.lessonId,
        from: { dayOfWeek: move.from.dayOfWeek, startTime: clockOf(move.from.startMinutes), endTime: clockOf(move.from.endMinutes) },
        to: { dayOfWeek: move.to.dayOfWeek, startTime: clockOf(move.to.startMinutes), endTime: clockOf(move.to.endMinutes) },
      })),
    };
    const lockedPartner = makeWorld({ seed: 7 });
    lockedPartner.data.lessons = lockedPartner.data.lessons.map((l) => (l.id === partnerId ? { ...l, isLocked: true } : l));
    const partner = applyTx(lockedPartner);
    await expect(build(lockedPartner, partner.tx).swaps.apply(request, user)).rejects.toMatchObject({ response: { code: SWAP_LOCKED } });
    expect(partner.written).toHaveLength(0);

    const lockedPicked = makeWorld({ seed: 7 });
    lockedPicked.data.lessons = lockedPicked.data.lessons.map((l) => (l.id === lesson.id ? { ...l, isLocked: true } : l));
    const picked = applyTx(lockedPicked);
    await expect(build(lockedPicked, picked.tx).swaps.apply(request, user)).resolves.toMatchObject({ versionId: 'version-1' });
    expect(picked.written).toHaveLength(2);
  });

  it('is a 409 SWAP_BREAKS_BOARD_RULE when a lesson would land outside its stage’s ramtid', async () => {
    const { lesson, swap } = await aGoodSwap(world);
    const framed = makeWorld({ seed: 7 });
    // Nothing is taught after 08:00 + 1 h for years 7: any swap puts one outside.
    framed.data.frames = [{ min: 7, max: 9, day: null, start: 480, end: 540 }];
    const request = {
      lessonId: lesson.id,
      moves: swap.moves.map((move) => ({
        lessonId: move.lessonId,
        from: { dayOfWeek: move.from.dayOfWeek, startTime: clockOf(move.from.startMinutes), endTime: clockOf(move.from.endMinutes) },
        to: { dayOfWeek: move.to.dayOfWeek, startTime: clockOf(move.to.startMinutes), endTime: clockOf(move.to.endMinutes) },
      })),
    };
    const { tx, written } = applyTx(framed);
    const outside = swap.moves.some((move) => move.to.startMinutes !== 480);
    expect(outside).toBe(true);
    await expect(build(framed, tx).swaps.apply(request, user)).rejects.toMatchObject({ response: { code: SWAP_BREAKS_BOARD_RULE, rule: 'FRAME' } });
    expect(written).toHaveLength(0);
  });
});
