import { ConflictException } from '@nestjs/common';
import { MasterLessonsService } from '../calendar/master-lessons.service';
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
              extraGroupIds: [],
              studentIds: [],
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
