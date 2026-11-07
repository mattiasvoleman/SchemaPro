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
function applyTx(world: World, lessons: () => SwapLesson[] = () => world.data.lessons, parked: ReadonlySet<string> = new Set()) {
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
              isParked: parked.has(lesson.id),
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

  /*
   * THE VERSION CHECK. A proposal is about the timetable the page saw. Each of
   * the four things that can have moved since — the day, the start, the end,
   * the tray — is a condition of its own, and each has a test of its own: with
   * the start and the end moved together (a lesson an hour later) they cover
   * for one another, and the day and the tray were not asked at all.
   */
  describe('is a 409 SWAP_STALE for a lesson that has moved since the proposal, whichever way', () => {
    const stale = async (changed: (lesson: SwapLesson) => SwapLesson, parked = false) => {
      const { lesson, swap } = await aGoodSwap(world);
      const victim = swap.moves[1]!.lessonId;
      const lessons = world.data.lessons.map((l) => (l.id === victim ? changed(l) : l));
      const { tx, written } = applyTx(world, () => lessons, parked ? new Set([victim]) : undefined);
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
    };

    it('on another day at the same clock', () => stale((l) => ({ ...l, dayOfWeek: l.dayOfWeek === 5 ? 4 : l.dayOfWeek + 1 })));
    it('from the same start to another end', () => stale((l) => ({ ...l, endMinutes: l.endMinutes + 30 })));
    it('to the same end from another start', () => stale((l) => ({ ...l, startMinutes: l.startMinutes + 30 })));
    it('onto the tray since the proposal', () => stale((l) => l, true));
  });

  /*
   * A CLOCK THE DTO'S PATTERN WOULD HAVE STOPPED, for the caller that does not
   * pass through it. parseTimeString wraps an hour past 23 into the next day, so
   * "34:00" is stored as 10:00; judged by the string it was minute 2040, where
   * nothing stands, and a teacher was booked twice. The clock is read from the
   * parsed time, and what does not survive the parse is a 400 before anything
   * is judged or written.
   */
  describe('a clock past the end of the day', () => {
    /** A lesson, another lesson of its teacher on another day, and a third lesson that moves nowhere. */
    function aTeacherWhoseOtherLessonStandsThere() {
      for (const a of world.data.lessons) {
        const b = world.data.lessons.find(
          (l) => l.id !== a.id && l.teacherId === a.teacherId && l.dayOfWeek !== a.dayOfWeek && l.endMinutes - l.startMinutes === a.endMinutes - a.startMinutes,
        );
        const c = world.data.lessons.find((l) => l.teacherId !== a.teacherId && l.studentGroupId !== a.studentGroupId && l.id !== b?.id);
        if (b && c) return { a, b, c };
      }
      throw new Error('the world has no such teacher');
    }

    const request = (a: SwapLesson, c: SwapLesson, to: { dayOfWeek: number; startTime: string; endTime: string }) => ({
      lessonId: a.id,
      moves: [
        { lessonId: a.id, from: { dayOfWeek: a.dayOfWeek, startTime: clockOf(a.startMinutes), endTime: clockOf(a.endMinutes) }, to },
        // An unrelated lesson that stays where it is: the second unit a swap must have.
        { lessonId: c.id, from: { dayOfWeek: c.dayOfWeek, startTime: clockOf(c.startMinutes), endTime: clockOf(c.endMinutes) }, to: { dayOfWeek: c.dayOfWeek, startTime: clockOf(c.startMinutes), endTime: clockOf(c.endMinutes) } },
      ],
    });

    it('is a 400 that writes nothing, not a double booking: 34:00 lands where the teacher’s other lesson stands', async () => {
      const { a, b, c } = aTeacherWhoseOtherLessonStandsThere();
      // 34:00 is 10:00 once the day has wrapped — b's own clock, plus 24 hours.
      const wrapped = { dayOfWeek: b.dayOfWeek, startTime: clockOf(b.startMinutes + 24 * 60), endTime: clockOf(b.endMinutes + 24 * 60) };
      expect(Number(wrapped.startTime.slice(0, 2))).toBeGreaterThan(23);
      const { tx, written } = applyTx(world);
      const { swaps, snapshot } = build(world, tx);
      await expect(swaps.apply(request(a, c, wrapped), user)).rejects.toBeInstanceOf(BadRequestException);
      expect(written).toHaveLength(0);
      expect(snapshot).not.toHaveBeenCalled();
    });

    // Hours of an hour's length, so that only the clock is wrong and the length rule is not what refuses them.
    it.each([
      ['24:00', '25:00'],
      ['32:30', '33:30'],
      ['12:60', '13:60'],
      ['08:75', '09:75'],
    ])('is a 400 for %s–%s, which wraps to an hour where nothing stands', async (startTime, endTime) => {
      const { a, c } = aTeacherWhoseOtherLessonStandsThere();
      expect(a.endMinutes - a.startMinutes).toBe(60);
      const { tx, written } = applyTx(world);
      const { swaps } = build(world, tx);
      await expect(swaps.apply(request(a, c, { dayOfWeek: 1, startTime, endTime }), user)).rejects.toBeInstanceOf(BadRequestException);
      expect(written).toHaveLength(0);
    });

    it('reads the clock it judges from the clock it writes: a good request is judged and written on the same minutes', async () => {
      const { lesson, swap } = await aGoodSwap(world);
      const { tx, written } = applyTx(world);
      const { swaps } = build(world, tx);
      await swaps.apply(
        {
          lessonId: lesson.id,
          moves: swap.moves.map((move) => ({
            lessonId: move.lessonId,
            from: { dayOfWeek: move.from.dayOfWeek, startTime: clockOf(move.from.startMinutes), endTime: clockOf(move.from.endMinutes) },
            to: { dayOfWeek: move.to.dayOfWeek, startTime: clockOf(move.to.startMinutes), endTime: clockOf(move.to.endMinutes) },
          })),
        },
        user,
      );
      for (const move of swap.moves) {
        const row = written.find((entry) => entry.where['id'] === move.lessonId)!;
        const stored = row.data['startTime'] as Date;
        expect(stored.getUTCHours() * 60 + stored.getUTCMinutes()).toBe(move.to.startMinutes);
      }
    });
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

    it('is the same 409 whichever member of the card is left out, the first by id included', async () => {
      const { tx, written } = applyTx(blocked);
      const { swaps } = build(blocked, tx);
      // Name only the SECOND member of the card: the first one is left behind.
      const error = await swaps.apply(body(blocked, [[second, elsewhere], [elsewhere, second]], { lessonId: second.id }), user).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({ code: SWAP_SPLITS_PARALLEL, lessonIds: [first!.id] });
      expect(written).toHaveLength(0);
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
