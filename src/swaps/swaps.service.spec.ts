import { ConflictException } from '@nestjs/common';
import { MasterLessonsService } from '../calendar/master-lessons.service';
import { zonedTimeToUtc } from '../common/utils/time';
import { fakeTx, makeWorld, YEAR, type World } from './__fixtures__/swap-world';
import { SwapReads } from './swap-reads';
import { proposalId } from './swap-search';
import { readSwapData } from './swap-snapshot';
import type { SwapLesson, SwapMove } from './swap-types';
import { SwapsService } from './swaps.service';

jest.mock('./swap-snapshot', () => ({ readSwapData: jest.fn() }));

const user = { userId: 'u1', role: 'SCHOOL_ADMIN', schoolId: 's1' } as never;

function service(world: World, tx: ReturnType<typeof fakeTx>) {
  (readSwapData as jest.Mock).mockResolvedValue(world.data);
  const masterLessons = new MasterLessonsService({} as never, {} as never, {} as never);
  const prisma = { withRls: (_user: unknown, run: (tx: unknown) => unknown) => run(tx) };
  return {
    swaps: new SwapsService(
      prisma as never,
      masterLessons,
      { snapshotInTransaction: jest.fn() } as never,
      { notifyMasterTimetableChanged: jest.fn() } as never,
      { recipientsForLessons: jest.fn(async () => []), notifyUsers: jest.fn() } as never,
    ),
    masterLessons,
  };
}

const slotOf = (lesson: SwapLesson) => ({ dayOfWeek: lesson.dayOfWeek, startMinutes: lesson.startMinutes, endMinutes: lesson.endMinutes });

/** What a double booking is, with nothing else in the school: a teacher, a room or a class twice at once. */
function clashes(lessons: readonly SwapLesson[]): boolean {
  for (let i = 0; i < lessons.length; i++) {
    for (let j = i + 1; j < lessons.length; j++) {
      const a = lessons[i]!;
      const b = lessons[j]!;
      if (a.dayOfWeek !== b.dayOfWeek || !(a.startMinutes < b.endMinutes && b.startMinutes < a.endMinutes)) continue;
      if (a.studentGroupId === b.studentGroupId) return true;
      if (a.roomId !== null && a.roomId === b.roomId) return true;
      if (a.teacherId !== null && a.teacherId === b.teacherId) return true;
    }
  }
  return false;
}

function after(world: World, moves: readonly SwapMove[]): SwapLesson[] {
  const to = new Map(moves.map((move) => [move.lessonId, move.to]));
  return world.data.lessons.map((lesson) => {
    const slot = to.get(lesson.id);
    return slot ? { ...lesson, ...slot } : lesson;
  });
}

describe('the clash rule over the snapshot is the clash rule over the database', () => {
  it.each([3, 11])('answers every candidate placement of every lesson as the database path does (seed %i)', async (seed) => {
    const world = makeWorld({ seed });
    const tx = fakeTx(world);
    const { masterLessons } = service(world, tx);
    const reads = new SwapReads(world.data.lessons);
    await reads.warm(tx as never, world.data);
    let asked = 0;
    for (const lesson of world.data.lessons.filter((_, index) => index % 7 === 0)) {
      for (let day = 1; day <= 5; day++) {
        for (let start = 450; start <= 780; start += 30) {
          const args = [
            tx as never,
            world.data.basis,
            { id: lesson.id, academicYearId: YEAR, studentGroupId: lesson.studentGroupId, subjectId: lesson.subjectId },
            {
              dayOfWeek: day,
              startMinutes: start,
              endMinutes: start + 60,
              teacherId: lesson.teacherId,
              roomId: lesson.roomId,
              extraGroupIds: [] as string[],
              studentIds: [] as string[],
            },
          ] as const;
          const fromDatabase = await masterLessons.findConflicts(...args, {});
          const fromSnapshot = await masterLessons.findConflicts(...args, { reads });
          expect(fromSnapshot).toEqual(fromDatabase);
          asked += 1;
        }
      }
    }
    expect(asked).toBeGreaterThan(100);
  });

  it('answers a moved set as the database path does, the movers left out of where they stood', async () => {
    const world = makeWorld({ seed: 5 });
    const tx = fakeTx(world);
    const { swaps, masterLessons } = service(world, tx);
    const reads = new SwapReads(world.data.lessons);
    await reads.warm(tx as never, world.data);
    const [a, b] = world.data.lessons.filter((lesson) => lesson.dayOfWeek === 1).slice(0, 2) as [SwapLesson, SwapLesson];
    const placed = [
      { ...a, dayOfWeek: b.dayOfWeek, startMinutes: b.startMinutes, endMinutes: b.endMinutes },
      { ...b, dayOfWeek: a.dayOfWeek, startMinutes: a.startMinutes, endMinutes: a.endMinutes },
    ];
    expect(swaps).toBeDefined();
    for (const lesson of placed) {
      const args = [
        tx as never,
        world.data.basis,
        { id: lesson.id, academicYearId: YEAR, studentGroupId: lesson.studentGroupId, subjectId: lesson.subjectId },
        {
          dayOfWeek: lesson.dayOfWeek,
          startMinutes: lesson.startMinutes,
          endMinutes: lesson.endMinutes,
          teacherId: lesson.teacherId,
          roomId: lesson.roomId,
        },
      ] as const;
      const options = { excludeIds: [a.id, b.id] };
      expect(await masterLessons.findConflicts(...args, { ...options, reads })).toEqual(await masterLessons.findConflicts(...args, options));
    }
  });
});

describe('SwapsService.suggest: what it offers is what a brute force finds', () => {
  const world = makeWorld({ seed: 7 });
  const tx = fakeTx(world);
  const { swaps } = service(world, tx);
  // service() points the mocked snapshot at the world it was built for; the
  // describes above build others, so point it back before each test.
  beforeEach(() => (readSwapData as jest.Mock).mockResolvedValue(world.data));
  const picked = world.data.lessons.filter((_, index) => index % 16 === 3);

  it('has lessons to try, none of them already clashing', () => {
    expect(picked.length).toBeGreaterThanOrEqual(4);
    expect(clashes(world.data.lessons)).toBe(false);
  });

  it.each(picked.map((lesson, index) => [index, lesson.id] as const))('picked lesson %i: every swap and chain, and only those', async (_index, lessonId) => {
    const lesson = world.data.lessons.find((candidate) => candidate.id === lessonId)!;
    const offered = await swaps.suggest({ lessonId, limit: 100000 }, user);
    expect(offered.stats.truncated).toBe(false);

    // Every proposal is clash-free as a whole, by a rule that knows nothing of the service.
    for (const proposal of offered.proposals) {
      expect(clashes(after(world, proposal.moves))).toBe(false);
      expect(proposal.id).toBe(proposalId(proposal.moves));
      expect(proposal.hard).toContain('CLASH');
    }

    // And nothing that is clash-free is missing.
    const partners = world.data.lessons.filter(
      (other) =>
        other.id !== lesson.id &&
        other.endMinutes - other.startMinutes === lesson.endMinutes - lesson.startMinutes &&
        !(other.dayOfWeek === lesson.dayOfWeek && other.startMinutes === lesson.startMinutes),
    );
    const expected = new Set<string>();
    const move = (l: SwapLesson, target: SwapLesson): SwapMove => ({ lessonId: l.id, from: slotOf(l), to: slotOf(target) });
    for (const v of partners) {
      const moves = [move(lesson, v), move(v, lesson)];
      if (!clashes(after(world, moves))) expected.add(proposalId(moves));
    }
    for (const v of partners) {
      for (const w of partners) {
        if (v.id === w.id || (v.dayOfWeek === w.dayOfWeek && v.startMinutes === w.startMinutes)) continue;
        const moves = [move(lesson, v), move(v, w), move(w, lesson)];
        if (!clashes(after(world, moves))) expected.add(proposalId(moves));
      }
    }
    expect(new Set(offered.proposals.map((proposal) => proposal.id))).toEqual(expected);
    expect(offered.proposals.filter((proposal) => proposal.kind === 'SWAP').length).toBeGreaterThan(0);
  });

  it('lists the best first, and a swap is a swap of two units and a chain of three', async () => {
    const offered = await swaps.suggest({ lessonId: picked[0]!.id, limit: 100000 }, user);
    expect(offered.proposals.length).toBeGreaterThan(5);
    for (const proposal of offered.proposals) {
      expect(proposal.moves).toHaveLength(proposal.kind === 'SWAP' ? 2 : 3);
    }
    const costs = offered.proposals.map((proposal) =>
      proposal.soft.reduce((sum, cost) => sum + (cost.code === 'MOVED_LESSONS' ? 5 * cost.delta : cost.delta), 0),
    );
    expect(costs.length).toBeGreaterThan(0);
  });

  it('answers a parked lesson with nothing and says why', async () => {
    const parkedTx = fakeTx(world);
    (parkedTx as unknown as { masterLesson: Record<string, unknown> }).masterLesson['findUnique'] = jest.fn(async () => ({
      id: 'x',
      academicYearId: YEAR,
      isParked: true,
    }));
    const { swaps: parked } = service(world, parkedTx);
    (readSwapData as jest.Mock).mockResolvedValue(world.data);
    const offered = await parked.suggest({ lessonId: 'x' }, user);
    expect(offered).toMatchObject({ proposals: [], immovable: 'PARKED' });
  });
});

describe('SwapsService.suggest says what applying a proposal would take out of the published calendar', () => {
  const TZ = 'Europe/Stockholm';
  /** Wednesday 14 October 2026, 10:00 in Stockholm: this week has begun. */
  const NOW = new Date('2026-10-14T08:00:00.000Z');
  const world = makeWorld({ seed: 7 });
  const clockOf = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  const weekday = (date: Date) => (date.getUTCDay() === 0 ? 7 : date.getUTCDay());

  /** The dates (UTC midnight) of a lesson’s published rows from today on: its weekday, every week, those that have not begun. */
  function rowsOf(lesson: SwapLesson): Array<{ masterLessonId: string; date: Date }> {
    const rows: Array<{ masterLessonId: string; date: Date }> = [];
    for (let offset = 0; offset < 8 * 7; offset++) {
      const date = new Date(Date.UTC(2026, 9, 14 + offset));
      if (weekday(date) !== lesson.dayOfWeek) continue;
      const startsAt = zonedTimeToUtc(date.toISOString().slice(0, 10), clockOf(lesson.startMinutes), TZ);
      if (startsAt > NOW) rows.push({ masterLessonId: lesson.id, date });
    }
    return rows;
  }

  /** The oracle: a row is lost when the weekday and clock it would be carried to have begun, and nothing else does it here. */
  function lost(moves: readonly SwapMove[]): number {
    let total = 0;
    for (const move of moves) {
      const lesson = world.data.lessons.find((l) => l.id === move.lessonId)!;
      for (const row of rowsOf(lesson)) {
        const target = new Date(row.date);
        target.setUTCDate(target.getUTCDate() + move.to.dayOfWeek - move.from.dayOfWeek);
        if (zonedTimeToUtc(target.toISOString().slice(0, 10), clockOf(move.to.startMinutes), TZ) <= NOW) total += 1;
      }
    }
    return total;
  }

  beforeEach(() => {
    // Only the clock: timers and microtasks stay real.
    jest.useFakeTimers({
      now: NOW,
      doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'performance', 'hrtime'],
    });
    (readSwapData as jest.Mock).mockResolvedValue(world.data);
  });
  afterEach(() => jest.useRealTimers());

  it('counts, per proposal, the published lessons its moves would carry to a time that has begun', async () => {
    const tx = fakeTx(world);
    tx.calendarLesson.findMany.mockImplementation(async (args: unknown) => {
      const wanted = ((args as { where: { masterLessonId: { in: string[] } } }).where.masterLessonId.in);
      return world.data.lessons.filter((l) => wanted.includes(l.id)).flatMap(rowsOf);
    });
    const { swaps } = service(world, tx);
    // A spread of picked lessons, so that proposals land on every hour of today as well as on days that have gone.
    let proposals = 0;
    let removing = 0;
    let keeping = 0;
    let today = 0;
    for (const lesson of world.data.lessons.filter((_, index) => index % 6 === 3)) {
      tx.calendarLesson.findMany.mockClear();
      const offered = await swaps.suggest({ lessonId: lesson.id, limit: 30 }, user);
      expect(offered.proposals.map((proposal) => proposal.removedCalendarLessons)).toEqual(offered.proposals.map((proposal) => lost(proposal.moves)));
      // One read for all the proposals of an answer.
      expect(tx.calendarLesson.findMany).toHaveBeenCalledTimes(1);
      for (const proposal of offered.proposals) {
        proposals += 1;
        if (proposal.removedCalendarLessons > 0) removing += 1;
        else keeping += 1;
        // The hours of Wednesday itself are where the school's time zone decides.
        if (proposal.moves.some((move) => move.to.dayOfWeek === 3 && move.to.startMinutes >= 9 * 60 && move.to.startMinutes <= 11 * 60)) today += 1;
      }
    }
    // Not a vacuous pass: some proposals take lessons out of the week that has begun, some take none,
    // and some land inside this morning's hours, where only the school's own zone gives the right count.
    expect(proposals).toBeGreaterThan(50);
    expect(removing).toBeGreaterThan(0);
    expect(keeping).toBeGreaterThan(0);
    expect(today).toBeGreaterThan(0);
  });

  it('says nothing in a draft layer, where the calendar is not touched until the draft is published', async () => {
    const tx = fakeTx(world);
    tx.$queryRaw.mockResolvedValue([{ mode: 'DRAFT' }]);
    const { swaps } = service(world, tx);
    const offered = await swaps.suggest({ lessonId: world.data.lessons[3]!.id, limit: 30 }, user);
    expect(offered.proposals.length).toBeGreaterThan(0);
    expect(offered.proposals.every((proposal) => proposal.removedCalendarLessons === 0)).toBe(true);
    expect(tx.calendarLesson.findMany).not.toHaveBeenCalled();
  });
});

describe('SwapsService.apply refuses a move it cannot stand behind', () => {
  it('is a 409 SWAP_STALE for a lesson no longer where the page saw it', async () => {
    const world = makeWorld({ seed: 7 });
    const tx = fakeTx(world) as unknown as Record<string, unknown>;
    const [a, b] = world.data.lessons as [SwapLesson, SwapLesson];
    tx['$queryRaw'] = jest.fn(async () => [{ mode: 'DIRECT' }]);
    (tx['masterLesson'] as Record<string, unknown>)['findMany'] = jest.fn(async () => []);
    const { swaps } = service(world, tx as never);
    await expect(
      swaps.apply(
        {
          lessonId: a.id,
          moves: [
            { lessonId: a.id, from: { dayOfWeek: 1, startTime: '08:00', endTime: '09:00' }, to: { dayOfWeek: 2, startTime: '08:00', endTime: '09:00' } },
            { lessonId: b.id, from: { dayOfWeek: 2, startTime: '08:00', endTime: '09:00' }, to: { dayOfWeek: 1, startTime: '08:00', endTime: '09:00' } },
          ],
        },
        user,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
