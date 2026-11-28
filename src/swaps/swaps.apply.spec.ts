import { BadRequestException, ConflictException } from '@nestjs/common';
import { MasterLessonsService } from '../calendar/master-lessons.service';
import { propagateTemplateChange } from '../calendar/propagate-template';
import { fakeTx, makeWorld, rowOf, SCHOOL, YEAR, type World } from './__fixtures__/swap-world';
import { readSwapData } from './swap-snapshot';
import type { SwapLesson, SwapMove } from './swap-types';
import { SWAP_BREAKS_BOARD_RULE, SWAP_LOCKED, SWAP_SPLITS_PARALLEL, SWAP_STALE, SwapsService } from './swaps.service';

jest.mock('./swap-snapshot', () => ({ readSwapData: jest.fn() }));
jest.mock('../calendar/propagate-template', () => ({
  ...jest.requireActual('../calendar/propagate-template'),
  propagateTemplateChange: jest.fn(async () => ({ moved: 1, removed: 0 })),
}));

const user = { userId: 'u1', role: 'SCHOOL_ADMIN', schoolId: SCHOOL } as never;

/** What app.direct_reach_facts answers (P5): no publication of the year holds, as it is for a school that has published nothing. */
const directReach: { facts: unknown[] } = { facts: [] };
const publicationHolds = (answered: boolean) => [
  {
    publishedAt: new Date('2026-08-01T10:00:00Z'),
    validFrom: new Date('2026-08-01T00:00:00Z'),
    validTo: new Date('2027-06-11T00:00:00Z'),
    acknowledgedAt: answered ? new Date('2026-08-02T10:00:00Z') : null,
    answered,
  },
];

const clockOf = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** The tx of an apply: the clash reads of the world, the row locks, the writes recorded. */
function applyTx(
  world: World,
  lessons: () => SwapLesson[] = () => world.data.lessons,
  parked: ReadonlySet<string> = new Set(),
  exempt: ReadonlyMap<string, string[]> = new Map(),
  /** The change log's latest row of a lesson, as the write path reads it to see whether a request takes the last move back. */
  lastLog: (lessonId: string) => Record<string, unknown> | null = () => null,
) {
  const base = fakeTx(world, lessons);
  const written: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const changeLog: Array<Record<string, unknown>> = [];
  const calls: string[] = [];
  const tx = {
    ...base,
    $queryRaw: jest.fn(async (query?: { sql?: string }) => (/direct_reach_facts/.test(query?.sql ?? '') ? directReach.facts : [{ mode: 'DIRECT' }])),
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
              exemptFrom: exempt.get(lesson.id) ?? [],
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
    scheduleChangeLog: {
      create: jest.fn(async (args: { data: Record<string, unknown> }) => changeLog.push(args.data)),
      findFirst: jest.fn(async (args: { where: { masterLessonId: string } }) => lastLog(args.where.masterLessonId)),
    },
  };
  return { tx, written, changeLog, calls };
}

/**
 * PrismaService as far as a swap uses it: `withRls` runs the work and then, only if it did not throw, the hooks `onCommit` was given, as the
 * real one runs them once the transaction has COMMITTED; a rolled-back run drops them unrun. `heard` is what a hook did and when.
 */
function committing() {
  const hooks: Array<() => Promise<void>> = [];
  const seen: { committed: boolean; hooksRegistered: number; sentAfterCommit?: boolean } = { committed: false, hooksRegistered: 0 };
  const prisma = {
    withRls: async (_user: unknown, run: (tx: unknown) => unknown, ..._rest: unknown[]) => {
      hooks.length = 0;
      seen.committed = false;
      const result = await run(txOf.current);
      seen.committed = true;
      for (const hook of hooks.splice(0)) await hook();
      return result;
    },
    onCommit: (_tx: unknown, hook: () => Promise<void>) => {
      hooks.push(hook);
      seen.hooksRegistered += 1;
      return true;
    },
  };
  return { prisma, seen };
}
/** The transaction the next `withRls` hands its work: one at a time, as the specs run one request at a time. */
const txOf: { current: unknown } = { current: null };

function build(world: World, tx: unknown) {
  (readSwapData as jest.Mock).mockResolvedValue(world.data);
  const snapshot = jest.fn(async () => ({ id: 'version-1' }));
  const { prisma, seen } = committing();
  txOf.current = tx;
  // What the hook sees of the commit: said while the transaction is still open, it would say "false".
  const realtime = {
    notifyMasterTimetableChanged: jest.fn((..._args: unknown[]) => {
      seen.sentAfterCommit = seen.committed;
    }),
  };
  const notifications = { recipientsForLessons: jest.fn(async () => ['pupil-1']), notifyUsers: jest.fn() };
  const swaps = new SwapsService(
    prisma as never,
    new MasterLessonsService({} as never, {} as never, {} as never),
    { snapshotInTransaction: snapshot } as never,
    realtime as never,
    notifications as never,
  );
  return { swaps, snapshot, realtime, notifications, seen };
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

  beforeEach(() => {
    (propagateTemplateChange as jest.Mock).mockClear();
    directReach.facts = [];
  });

  it('writes a proposal as one move: a safety version first, then every lesson, the calendar following, a log row each', async () => {
    const { lesson, swap } = await aGoodSwap(world);
    const { tx, written, changeLog, calls } = applyTx(world);
    const { swaps, snapshot, realtime, notifications, seen } = build(world, tx);
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
    // g465 L-3: said once the transaction has committed, and with the lessons that moved, so that a collaborator's page reads those and not the year.
    expect(seen.sentAfterCommit).toBe(true);
    expect(realtime.notifyMasterTimetableChanged).toHaveBeenCalledTimes(1);
    expect(realtime.notifyMasterTimetableChanged).toHaveBeenCalledWith(SCHOOL, { lessonIds: swap.moves.map((move) => move.lessonId).sort() });
    expect(notifications.notifyUsers).toHaveBeenCalledTimes(2);
    expect(result.versionId).toBe('version-1');
    expect(result.propagatedLessons).toBe(2);
    // The undo is the same moves reversed.
    expect(result.undo).toEqual(swap.moves.map((move) => ({ lessonId: move.lessonId, from: move.to, to: move.from })));
  });

  it('says what a swap took away: the picked lesson stood outside its ramtid on purpose, and the answer and the log name the exemption it lost (Undantag med flit)', async () => {
    const { lesson, swap } = await aGoodSwap(world);
    const { tx, changeLog } = applyTx(world, undefined, undefined, new Map([[lesson.id, ['FRAME']]]));
    const { swaps } = build(world, tx);
    const result = await swaps.apply(
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
    expect(result.exemptionsEnded).toEqual([{ lessonId: lesson.id, rules: 'FRAME' }]);
    const log = changeLog.find((row) => row['masterLessonId'] === lesson.id) as { before: Record<string, unknown>; after: Record<string, unknown> };
    expect(log.before['exemptFrom']).toEqual(['FRAME']);
    expect('exemptFrom' in log.after).toBe(false);
    expect(result.lessons.every((moved) => !('exemptFrom' in moved))).toBe(true);
    // A swap of lessons that have none says nothing of the kind.
    const plain = applyTx(world);
    const again = await build(world, plain.tx).swaps.apply(
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
    expect(again.exemptionsEnded).toEqual([]);
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
    expect(draft.realtime.notifyMasterTimetableChanged).toHaveBeenCalledWith(SCHOOL, { draft: true, lessonIds: swap.moves.map((move) => move.lessonId).sort() });
  });

  it('P5: refuses a swap that moved published lessons before the school has answered the question about Direkt, and tells nobody', async () => {
    const { lesson, swap } = await aGoodSwap(world);
    const request = {
      lessonId: lesson.id,
      moves: swap.moves.map((move) => ({
        lessonId: move.lessonId,
        from: { dayOfWeek: move.from.dayOfWeek, startTime: clockOf(move.from.startMinutes), endTime: clockOf(move.from.endMinutes) },
        to: { dayOfWeek: move.to.dayOfWeek, startTime: clockOf(move.to.startMinutes), endTime: clockOf(move.to.endMinutes) },
      })),
    };
    directReach.facts = publicationHolds(false);
    const refused = build(world, applyTx(world).tx);
    await expect(refused.swaps.apply(request, user)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'DIRECT_REACH_UNANSWERED', params: { validFrom: '2026-08-01', validTo: '2027-06-11' } }),
    });
    // The throw is inside the transaction that wrote the version and the moves, so they go with it; nothing is announced or sent.
    expect(refused.notifications.notifyUsers).not.toHaveBeenCalled();
    expect(refused.realtime.notifyMasterTimetableChanged).not.toHaveBeenCalled();

    directReach.facts = publicationHolds(true);
    const answered = build(world, applyTx(world).tx);
    await expect(answered.swaps.apply(request, user)).resolves.toMatchObject({ propagatedLessons: 2 });
    expect(answered.notifications.notifyUsers).toHaveBeenCalledTimes(2);

    // A swap that leaves the calendar alone reached nobody, so it asks nothing, answered or not.
    directReach.facts = publicationHolds(false);
    const quiet = build(world, applyTx(world).tx);
    await expect(quiet.swaps.apply({ ...request, propagate: false }, user)).resolves.toMatchObject({ propagatedLessons: 0 });
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

  it('refuses a double booking as a hand edit’s refusal is told, MASTER_LESSON_REFUSED, naming the other lesson, and writes nothing', async () => {
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
    // The code and the flat params a hand edit's refusal carries (lesson-refusal.ts), not a bare sentence: the reason, and the lesson in
    // the way by class, subject, day and clock.
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'MASTER_LESSON_REFUSED',
      params: {
        reason: expect.stringMatching(/^(TEACHER|ROOM|GROUP|PUPILS|AVAILABILITY)$/),
        requirement: expect.any(String),
      },
    });
    const params = ((error as ConflictException).getResponse() as { params: Record<string, unknown> }).params;
    if (params['reason'] !== 'AVAILABILITY') {
      expect(params).toMatchObject({ otherKind: 'LESSON', className: expect.any(String), subjectName: expect.any(String), day: expect.any(Number), start: expect.stringMatching(/^\d\d:\d\d$/), end: expect.stringMatching(/^\d\d:\d\d$/) });
    }
    expect((error as ConflictException).message).toEqual(expect.stringContaining(String(params['requirement'])));
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

describe('SwapsService.apply locks what it moves (E4, låset vid flytt)', () => {
  const clock = (lesson: Pick<SwapLesson, 'startMinutes' | 'endMinutes'>) => ({ startTime: clockOf(lesson.startMinutes), endTime: clockOf(lesson.endMinutes) });
  const requestOf = (lessonId: string, moves: ReadonlyArray<{ lessonId: string; from: SwapLesson | { dayOfWeek: number; startMinutes: number; endMinutes: number }; to: { dayOfWeek: number; startMinutes: number; endMinutes: number } }>) => ({
    lessonId,
    moves: moves.map((move) => ({
      lessonId: move.lessonId,
      from: { dayOfWeek: move.from.dayOfWeek, ...clock(move.from) },
      to: { dayOfWeek: move.to.dayOfWeek, ...clock(move.to) },
    })),
  });

  beforeEach(() => (propagateTemplateChange as jest.Mock).mockClear());

  it('locks every lesson the swap moves, in the same write, and says so in the answer and the log: next Generera keeps the pair where the hand put it', async () => {
    const world = makeWorld({ seed: 7 });
    const { lesson, swap } = await aGoodSwap(world);
    const { tx, written, changeLog } = applyTx(world);
    const result = await build(world, tx).swaps.apply(requestOf(lesson.id, swap.moves), user);
    expect(written).toHaveLength(2);
    for (const entry of written) expect(entry.data).toMatchObject({ isLocked: true });
    expect(result.lockedByMove).toBe(true);
    expect([...result.lockedLessonIds].sort()).toEqual(swap.moves.map((move) => move.lessonId).sort());
    expect(result.lessons.every((moved) => moved.isLocked)).toBe(true);
    // Nothing was locked before the swap, so there is no lock to ask the log about.
    expect(tx.scheduleChangeLog.findFirst).not.toHaveBeenCalled();
    for (const row of changeLog) {
      expect((row['before'] as Record<string, unknown>)['isLocked']).toBe(false);
      expect((row['after'] as Record<string, unknown>)['isLocked']).toBe(true);
    }
  });

  it('does not call a lock the lesson already had the move\'s: a locked picked lesson stays locked and is left out of lockedLessonIds', async () => {
    const world = makeWorld({ seed: 7 });
    const { lesson, swap } = await aGoodSwap(world);
    const partnerId = swap.moves.find((move) => move.lessonId !== lesson.id)!.lessonId;
    world.data.lessons = world.data.lessons.map((l) => (l.id === lesson.id ? { ...l, isLocked: true } : l));
    const { tx, written } = applyTx(world);
    const result = await build(world, tx).swaps.apply(requestOf(lesson.id, swap.moves), user);
    expect(result.lockedLessonIds).toEqual([partnerId]);
    expect(result.lockedByMove).toBe(true);
    expect(written.find((entry) => entry.where['id'] === lesson.id)!.data).not.toHaveProperty('isLocked');
    expect(written.find((entry) => entry.where['id'] === partnerId)!.data).toMatchObject({ isLocked: true });
  });

  describe('Ångra: the same moves reversed take the lock off what the swap locked', () => {
    /** The world as the swap left it: the moved lessons where they went, and locked. */
    async function afterTheSwap() {
      const world = makeWorld({ seed: 7 });
      const { lesson, swap } = await aGoodSwap(world);
      const original = makeWorld({ seed: 7 });
      const moved = new Map(swap.moves.map((move) => [move.lessonId, move]));
      const now = original.data.lessons.map((l) => {
        const move = moved.get(l.id);
        return move ? { ...l, dayOfWeek: move.to.dayOfWeek, startMinutes: move.to.startMinutes, endMinutes: move.to.endMinutes, isLocked: true } : l;
      });
      const logOf = (lessonId: string): Record<string, unknown> | null => {
        const move = moved.get(lessonId);
        if (!move) return null;
        const at = (slot: { dayOfWeek: number; startMinutes: number; endMinutes: number }, isLocked: boolean) => ({ dayOfWeek: slot.dayOfWeek, ...clock(slot), isLocked });
        return { action: 'UPDATE', before: at(move.from, false), after: at(move.to, true) };
      };
      return { world: original, now, swap, lesson, logOf, moved };
    }

    it('moves the locked partner back and unlocks it, and the picked lesson too: nothing is refused as SWAP_LOCKED', async () => {
      const { world, now, swap, lesson, logOf } = await afterTheSwap();
      world.data.lessons = now;
      const { tx, written } = applyTx(world, () => now, new Set(), new Map(), logOf);
      const undo = swap.moves.map((move) => ({ lessonId: move.lessonId, from: move.to, to: move.from }));
      const result = await build(world, tx).swaps.apply(requestOf(lesson.id, undo), user);
      expect(written).toHaveLength(2);
      for (const entry of written) expect(entry.data).toMatchObject({ isLocked: false });
      // The lesson's own latest row is the one asked for.
      expect(tx.scheduleChangeLog.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { masterLessonId: expect.any(String) }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
      );
      expect(result.lockedLessonIds).toEqual([]);
      expect(result).not.toHaveProperty('lockedByMove');
      expect(result.lessons.every((moved) => !moved.isLocked)).toBe(true);
    });

    it('does not take a lock off when the last thing done to the lesson was not the move that locked it (a hand lock later, or none logged): the partner is still SWAP_LOCKED', async () => {
      const { world, now, swap, lesson, logOf } = await afterTheSwap();
      world.data.lessons = now;
      const undo = swap.moves.map((move) => ({ lessonId: move.lessonId, from: move.to, to: move.from }));
      const partnerId = swap.moves.find((move) => move.lessonId !== lesson.id)!.lessonId;
      for (const lastLog of [
        () => null,
        // Locked by hand after the move: the log's last row was already locked before it.
        (lessonId: string) => {
          const row = logOf(lessonId);
          return row ? { ...row, before: { ...(row['before'] as object), isLocked: true } } : null;
        },
        // The last row left the lesson somewhere else than where this request finds it.
        (lessonId: string) => {
          const row = logOf(lessonId);
          return row ? { ...row, before: { ...(row['before'] as object), startTime: '23:00', endTime: '23:45' } } : null;
        },
        // The last row put the lesson somewhere else than where it stands now: it has been moved since.
        (lessonId: string) => {
          const row = logOf(lessonId);
          return row ? { ...row, after: { ...(row['after'] as object), startTime: '23:00', endTime: '23:45' } } : null;
        },
        // The last row left the lesson unlocked (it was locked by something the log does not show).
        (lessonId: string) => {
          const row = logOf(lessonId);
          return row ? { ...row, after: { ...(row['after'] as object), isLocked: false } } : null;
        },
        // The last row is not an update of the lesson's lock and place at all.
        (lessonId: string) => {
          const row = logOf(lessonId);
          return row ? { ...row, action: 'DELETE' } : null;
        },
        // The last row says nothing of whether the lesson was locked before.
        (lessonId: string) => {
          const row = logOf(lessonId);
          return row ? { ...row, before: { dayOfWeek: (row['before'] as { dayOfWeek: number }).dayOfWeek } } : null;
        },
      ]) {
        const { tx, written } = applyTx(world, () => now, new Set(), new Map(), lastLog);
        await expect(build(world, tx).swaps.apply(requestOf(lesson.id, undo), user)).rejects.toMatchObject({ response: { code: SWAP_LOCKED, lessonIds: [partnerId] } });
        expect(written).toHaveLength(0);
      }
    });
  });
});

describe('SwapsService.apply does not lock one card of a parallel block (g505, M-1)', () => {
  beforeEach(() => (propagateTemplateChange as jest.Mock).mockClear());

  const lessonAt = (n: number, group: string, subject: string, teacher: string, room: string, day: number, startMinutes: number): SwapLesson => ({
    id: `00000000-0000-4000-8000-${String(900 + n).padStart(12, '0')}`,
    subjectId: subject,
    subjectName: `Ämne ${subject}`,
    studentGroupId: group,
    groupName: group.toUpperCase(),
    teacherId: teacher,
    coTeacherId: null,
    roomId: room,
    dayOfWeek: day,
    startMinutes,
    endMinutes: startMinutes + 60,
    recurrence: 'ALL_WEEKS',
    startDate: null,
    endDate: null,
    isLocked: false,
    isGenerated: true,
    extraGroupIds: [],
    studentIds: [],
  });
  const post = (lesson: SwapLesson, blockId: string | null) => ({
    studentGroupId: lesson.studentGroupId,
    subjectId: lesson.subjectId,
    blockId,
    minutesBefore: 0,
    minutesAfter: 0,
    distribution: { maxLessonsPerDay: null, minDaysBetween: null },
  });

  /** A block of two members with a card on Monday 08:00 (first, second) and, when asked, a second card on Wednesday 10:00; a plain lesson on Tuesday 08:00 to change places with. */
  function blockedWorld(otherCard: boolean) {
    const world = makeWorld({ seed: 7 });
    const first = lessonAt(1, 'c1', 's1', 't1', 'r1', 1, 480);
    const second = lessonAt(2, 'c2', 's2', 't2', 'r2', 1, 480);
    const plain = lessonAt(3, 'c3', 's3', 't3', 'r3', 2, 480);
    const first2 = lessonAt(4, 'c1', 's1', 't1', 'r1', 3, 600);
    const second2 = lessonAt(5, 'c2', 's2', 't2', 'r2', 3, 600);
    world.data.lessons = otherCard ? [first, second, plain, first2, second2] : [first, second, plain];
    world.data.posts = [post(first, 'block-1'), post(second, 'block-1'), post(plain, null)];
    world.data.blocks = [{ id: 'block-1', sameTimesAsBlockId: null }];
    return { world, first, second, plain };
  }

  const requestOf = (lessonId: string, moves: Array<{ lessonId: string; from: SwapLesson; to: SwapLesson }>) => ({
    lessonId,
    moves: moves.map((move) => ({
      lessonId: move.lessonId,
      from: { dayOfWeek: move.from.dayOfWeek, startTime: clockOf(move.from.startMinutes), endTime: clockOf(move.from.endMinutes) },
      to: { dayOfWeek: move.to.dayOfWeek, startTime: clockOf(move.to.startMinutes), endTime: clockOf(move.to.endMinutes) },
    })),
  });
  const swapOf = (first: SwapLesson, second: SwapLesson, plain: SwapLesson) =>
    requestOf(first.id, [
      { lessonId: first.id, from: first, to: plain },
      { lessonId: second.id, from: second, to: plain },
      { lessonId: plain.id, from: plain, to: first },
    ]);

  it('moves the card and leaves its lessons unlocked when the block has another card that stays: Generera would refuse a partly locked block', async () => {
    const { world, first, second, plain } = blockedWorld(true);
    const { tx, written } = applyTx(world);
    const result = await build(world, tx).swaps.apply(swapOf(first, second, plain), user);
    const ofCard = written.filter((entry) => [first.id, second.id].includes(entry.where['id'] as string));
    expect(ofCard).toHaveLength(2);
    for (const entry of ofCard) expect(entry.data).not.toHaveProperty('isLocked');
    expect(result.lockedLessonIds).toEqual([plain.id]);
    // What is not the block's is locked as before.
    expect(written.find((entry) => entry.where['id'] === plain.id)!.data).toMatchObject({ isLocked: true });
  });

  it('locks the card when it is all the block has', async () => {
    const { world, first, second, plain } = blockedWorld(false);
    const { tx, written } = applyTx(world);
    const result = await build(world, tx).swaps.apply(swapOf(first, second, plain), user);
    expect(written).toHaveLength(3);
    for (const entry of written) expect(entry.data).toMatchObject({ isLocked: true });
    expect([...result.lockedLessonIds].sort()).toEqual([first.id, second.id, plain.id].sort());
  });
});

describe('SwapsService.apply: the staff room is told after the commit, with the lessons that moved (g465 L-3)', () => {
  const world = makeWorld({ seed: 7 });
  const requestOf = (lessonId: string, moves: readonly SwapMove[]) => ({
    lessonId,
    moves: moves.map((move) => ({
      lessonId: move.lessonId,
      from: { dayOfWeek: move.from.dayOfWeek, startTime: clockOf(move.from.startMinutes), endTime: clockOf(move.from.endMinutes) },
      to: { dayOfWeek: move.to.dayOfWeek, startTime: clockOf(move.to.startMinutes), endTime: clockOf(move.to.endMinutes) },
    })),
  });

  beforeEach(() => {
    (propagateTemplateChange as jest.Mock).mockClear();
    directReach.facts = [];
  });

  it('says it once, when the transaction has committed, and says which lessons', async () => {
    const { lesson, swap } = await aGoodSwap(world);
    const { swaps, realtime, seen } = build(world, applyTx(world).tx);
    await swaps.apply(requestOf(lesson.id, swap.moves), user);
    expect(seen.hooksRegistered).toBe(1);
    expect(seen.sentAfterCommit).toBe(true);
    expect(realtime.notifyMasterTimetableChanged).toHaveBeenCalledTimes(1);
    expect(realtime.notifyMasterTimetableChanged).toHaveBeenCalledWith(SCHOOL, { lessonIds: swap.moves.map((move) => move.lessonId).sort() });
  });

  it('says nothing for a swap that rolled back after the point where it used to be said', async () => {
    // The notice to the class comes after the old announcement: a failing one rolled the swap back, and the page had been told it moved.
    const { lesson, swap } = await aGoodSwap(world);
    const { swaps, realtime, notifications } = build(world, applyTx(world).tx);
    notifications.notifyUsers.mockRejectedValueOnce(new Error('the notice failed'));
    await expect(swaps.apply(requestOf(lesson.id, swap.moves), user)).rejects.toThrow('the notice failed');
    expect(realtime.notifyMasterTimetableChanged).not.toHaveBeenCalled();
  });

  it('says it to the admins alone, and with the lessons, for a draft', async () => {
    const { lesson, swap } = await aGoodSwap(world);
    const drafted = applyTx(world);
    drafted.tx.$queryRaw.mockResolvedValue([{ mode: 'DRAFT' }]);
    const { swaps, realtime } = build(world, drafted.tx);
    await swaps.apply(requestOf(lesson.id, swap.moves), user);
    expect(realtime.notifyMasterTimetableChanged).toHaveBeenCalledWith(SCHOOL, { draft: true, lessonIds: swap.moves.map((move) => move.lessonId).sort() });
  });
});

describe('SwapsService.apply: a swap of two marked lessons, and the moves that make room for a lesson that stands nowhere (E5a)', () => {
  const clock = (slot: { startMinutes: number; endMinutes: number }) => ({ startTime: clockOf(slot.startMinutes), endTime: clockOf(slot.endMinutes) });
  const moveOf = (lesson: SwapLesson, to: { dayOfWeek: number; startMinutes: number; endMinutes: number }) => ({
    lessonId: lesson.id,
    from: { dayOfWeek: lesson.dayOfWeek, ...clock(lesson) },
    to: { dayOfWeek: to.dayOfWeek, ...clock(to) },
  });
  beforeEach(() => {
    (propagateTemplateChange as jest.Mock).mockClear();
    directReach.facts = [];
  });

  it('lets two lessons the schemaläggare marked be locked, which only the picked one may be on a swap that was found for them', async () => {
    const lockedBoth = makeWorld({ seed: 7 });
    const { lesson, swap } = await aGoodSwap(makeWorld({ seed: 7 }));
    const partnerId = swap.moves.find((move) => move.lessonId !== lesson.id)!.lessonId;
    lockedBoth.data.lessons = lockedBoth.data.lessons.map((l) => (l.id === partnerId || l.id === lesson.id ? { ...l, isLocked: true } : l));
    const request = {
      lessonId: lesson.id,
      moves: swap.moves.map((move) => ({
        lessonId: move.lessonId,
        from: { dayOfWeek: move.from.dayOfWeek, ...clock(move.from) },
        to: { dayOfWeek: move.to.dayOfWeek, ...clock(move.to) },
      })),
    };
    // Without the other named, the locked partner is an automat's move: refused.
    await expect(build(lockedBoth, applyTx(lockedBoth).tx).swaps.apply(request, user)).rejects.toMatchObject({ response: { code: SWAP_LOCKED } });
    // Named, it is the person's own, as a PATCH of it would be.
    const { tx, written } = applyTx(lockedBoth);
    const result = await build(lockedBoth, tx).swaps.apply({ ...request, alsoPicked: [partnerId] }, user);
    expect(written.map((entry) => entry.where['id']).sort()).toEqual([lesson.id, partnerId].sort());
    expect(result.undo).toHaveLength(2);
  });

  it('refuses a named lesson that is not among the moves, before anything is read', async () => {
    const world = makeWorld({ seed: 7 });
    const { lesson, swap } = await aGoodSwap(world);
    const { tx } = applyTx(world);
    const request = {
      lessonId: lesson.id,
      alsoPicked: [world.data.lessons.find((l) => !swap.moves.some((move) => move.lessonId === l.id))!.id],
      moves: swap.moves.map((move) => ({ lessonId: move.lessonId, from: { dayOfWeek: move.from.dayOfWeek, ...clock(move.from) }, to: { dayOfWeek: move.to.dayOfWeek, ...clock(move.to) } })),
    };
    await expect(build(world, tx).swaps.apply(request, user)).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.masterLesson.updateMany).not.toHaveBeenCalled();
  });

  it('takes one move as a proposal when it makes room for a lesson that stands nowhere, and says a swap of one is not one', async () => {
    const world = makeWorld({ seed: 7 });
    const [mover] = world.data.lessons as [SwapLesson];
    const { tx, written } = applyTx(world);
    const single = { forBrick: true, moves: [moveOf(mover, { dayOfWeek: 5, startMinutes: 19 * 60, endMinutes: 20 * 60 })] };
    const result = await build(world, tx).swaps.apply(single as never, user);
    expect(written).toHaveLength(1);
    expect(result.lockedLessonIds).toEqual([mover.id]);
    // Without forBrick one move is no swap, and the answer is said before the transaction is opened.
    const plain = applyTx(world);
    await expect(build(world, plain.tx).swaps.apply({ lessonId: mover.id, moves: single.moves } as never, user)).rejects.toBeInstanceOf(BadRequestException);
    expect(plain.tx.masterLesson.findMany).not.toHaveBeenCalled();
    expect(plain.tx.masterLesson.updateMany).not.toHaveBeenCalled();
  });

  it('moves no locked lesson to make room: nobody chose it', async () => {
    const world = makeWorld({ seed: 7 });
    const locked = world.data.lessons[0]!;
    world.data.lessons = world.data.lessons.map((l) => (l.id === locked.id ? { ...l, isLocked: true } : l));
    const { tx, written } = applyTx(world);
    const request = { forBrick: true, moves: [moveOf(locked, { dayOfWeek: 5, startMinutes: 19 * 60, endMinutes: 20 * 60 })] };
    await expect(build(world, tx).swaps.apply(request as never, user)).rejects.toMatchObject({ response: { code: SWAP_LOCKED, lessonIds: [locked.id] } });
    expect(written).toHaveLength(0);
  });
});

describe('SwapsService.apply: a lesson is moved to a school day and no other (g514)', () => {
  const clock = (slot: { startMinutes: number; endMinutes: number }) => ({ startTime: clockOf(slot.startMinutes), endTime: clockOf(slot.endMinutes) });

  it.each([6, 7])('refuses a move to day %i, for one move that makes room for a brick and for a swap, and writes nothing', async (day) => {
    const world = makeWorld({ seed: 7 });
    const [mover] = world.data.lessons as [SwapLesson];
    const move = {
      lessonId: mover.id,
      from: { dayOfWeek: mover.dayOfWeek, ...clock(mover) },
      to: { dayOfWeek: day, startTime: '09:00', endTime: '10:00' },
    };
    const brick = applyTx(world);
    await expect(build(world, brick.tx).swaps.apply({ forBrick: true, moves: [move] } as never, user)).rejects.toBeInstanceOf(BadRequestException);
    expect(brick.written).toHaveLength(0);
    const { lesson, swap } = await aGoodSwap(world);
    const request = {
      lessonId: lesson.id,
      moves: swap.moves.map((m, index) => ({
        lessonId: m.lessonId,
        from: { dayOfWeek: m.from.dayOfWeek, ...clock(m.from) },
        to: index === 0 ? { dayOfWeek: day, ...clock(m.to) } : { dayOfWeek: m.to.dayOfWeek, ...clock(m.to) },
      })),
    };
    const pair = applyTx(world);
    await expect(build(world, pair.tx).swaps.apply(request as never, user)).rejects.toBeInstanceOf(BadRequestException);
    expect(pair.written).toHaveLength(0);
  });

  it('still takes Friday', async () => {
    const world = makeWorld({ seed: 7 });
    const [mover] = world.data.lessons as [SwapLesson];
    const { tx, written } = applyTx(world);
    const move = { lessonId: mover.id, from: { dayOfWeek: mover.dayOfWeek, ...clock(mover) }, to: { dayOfWeek: 5, startTime: '19:00', endTime: '20:00' } };
    await build(world, tx).swaps.apply({ forBrick: true, moves: [move] } as never, user);
    expect(written).toHaveLength(1);
  });
});
