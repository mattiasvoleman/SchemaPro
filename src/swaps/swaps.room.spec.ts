import { BadRequestException, NotFoundException } from '@nestjs/common';
import { judgeLessons, type JudgeItem, type LessonVerdict } from '../calendar/lesson-judge';
import { MasterLessonsService } from '../calendar/master-lessons.service';
import { fakeTx, makeWorld, rowOf, YEAR, type World } from './__fixtures__/swap-world';
import { POSSIBLE_SCORE } from '../calendar/possible-times';
import { SwapContext } from './swap-context';
import { proposalId } from './swap-search';
import { recordRead } from '../access-log/access-log';
import { readSwapData } from './swap-snapshot';
import type { SwapLesson, SwapMove } from './swap-types';
import { SwapsService } from './swaps.service';

jest.mock('./swap-snapshot', () => ({ readSwapData: jest.fn() }));
jest.mock('../access-log/access-log', () => ({ recordRead: jest.fn(async () => undefined) }));
jest.mock('../calendar/lesson-judge', () => ({ ...jest.requireActual('../calendar/lesson-judge'), judgeLessons: jest.fn() }));

/*
 * E5a, the service half: Gör plats (POST /swaps/suggest with makeRoom) and Byt plats (POST /swaps/pair) over the swap tests' small
 * school. The search itself is held to an exhaustive check in swap-make-room.spec.ts; here is what the service puts round it: the
 * school as it reads it, the judge, the unplaced lessons, the shapes it answers in.
 *
 * THE JUDGE IS REPLACED by the plain rule it stands for on this grid (a teacher, a room or a class twice at once, asked of each
 * mover against what stays and against the others that land on its day), so that what the service offers can be held to a rule
 * that knows nothing of the service: `clashes` over the school as it stands after the moves.
 */

const user = { userId: 'u1', role: 'SCHOOL_ADMIN', schoolId: 's1' } as never;

const overlaps = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 && b0 < a1;
const minutesOfDate = (time: Date) => time.getUTCHours() * 60 + time.getUTCMinutes();

/** What a double booking is, with nothing else in the school. */
function clashes(lessons: ReadonlyArray<{ id: string; dayOfWeek: number; startMinutes: number; endMinutes: number; studentGroupId: string; roomId: string | null; teacherId: string | null }>): boolean {
  for (let i = 0; i < lessons.length; i++) {
    for (let j = i + 1; j < lessons.length; j++) {
      const a = lessons[i]!;
      const b = lessons[j]!;
      if (a.dayOfWeek !== b.dayOfWeek || !overlaps(a.startMinutes, a.endMinutes, b.startMinutes, b.endMinutes)) continue;
      if (a.studentGroupId === b.studentGroupId || (a.roomId !== null && a.roomId === b.roomId) || (a.teacherId !== null && a.teacherId === b.teacherId)) return true;
    }
  }
  return false;
}

function after(world: World, moves: readonly SwapMove[], extra: readonly SwapLesson[] = []): SwapLesson[] {
  const moved = new Map(moves.map((move) => [move.lessonId, move]));
  return [...world.data.lessons, ...extra].map((lesson) => {
    const move = moved.get(lesson.id);
    // The room a move gives a lesson is the room it stands in afterwards (Annan ledig sal).
    return move ? { ...lesson, ...move.to, roomId: move.room?.to ?? lesson.roomId } : lesson;
  });
}

/** The judge as a plain rule: each item against the lessons that stay and the movers beside it on its day. */
function plainJudge(world: World) {
  return async (_tx: unknown, _masters: unknown, _world: unknown, items: readonly JudgeItem[]): Promise<LessonVerdict[]> =>
    items.map((item) => {
      const moving = new Set(item.excludeIds ?? []);
      const here = { ...item.candidate, id: item.lesson.id ?? 'brick', studentGroupId: item.lesson.studentGroupId };
      const others = [
        ...world.data.lessons.filter((lesson) => !moving.has(lesson.id) && lesson.id !== item.lesson.id),
        ...(item.alongside ?? []).map((row) => ({
          id: row.id,
          dayOfWeek: item.candidate.dayOfWeek,
          startMinutes: minutesOfDate(row.startTime),
          endMinutes: minutesOfDate(row.endTime),
          studentGroupId: row.studentGroupId,
          roomId: row.roomId,
          teacherId: row.teacherId,
        })),
      ];
      const reasons = new Set<string>();
      for (const other of others) {
        if (other.dayOfWeek !== here.dayOfWeek || !overlaps(here.startMinutes, here.endMinutes, other.startMinutes, other.endMinutes)) continue;
        if (other.teacherId !== null && other.teacherId === here.teacherId) reasons.add('TEACHER');
        if (other.roomId !== null && other.roomId === here.roomId) reasons.add('ROOM');
        if (other.studentGroupId === here.studentGroupId) reasons.add('GROUP');
      }
      return { ok: reasons.size === 0, refusals: [...reasons].map((reason) => ({ reason: reason as 'TEACHER', params: {} })), exempted: [], exemptable: false };
    });
}

interface Set_ {
  world: World;
  parked?: ReadonlySet<string>;
  placed?: ReadonlySet<string>;
  exempt?: ReadonlySet<string>;
  /** A lesson that is on the tray: not in the snapshot (readSwapData leaves them out) but stored. */
  tray?: SwapLesson[];
  /** The school's RoomPreference rows of kind LOCK, as the service reads them. */
  locks?: Array<{ subjectId: string; minGradeLevel: number | null; maxGradeLevel: number | null; roomTypeId: string | null; rooms: Array<{ roomId: string }> }>;
}

function txFor({ world, parked = new Set(), placed = new Set(), exempt = new Set(), tray = [], locks = [] }: Set_) {
  const base = fakeTx(world);
  const everyone = () => [...world.data.lessons, ...tray];
  const stored = (lesson: SwapLesson) => ({
    ...rowOf(lesson),
    isLocked: lesson.isLocked,
    isParked: parked.has(lesson.id) || tray.some((entry) => entry.id === lesson.id),
    isGenerated: true,
    fromPlacement: placed.has(lesson.id),
    exemptFrom: exempt.has(lesson.id) ? ['FRAME'] : [],
    studentGroup: { name: lesson.groupName },
    extraGroups: [],
    participants: [],
  });
  return {
    ...base,
    masterLesson: {
      ...base.masterLesson,
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const found = everyone().find((lesson) => lesson.id === where.id);
        return found ? stored(found) : null;
      }),
      findMany: jest.fn(async (args: { where: Record<string, unknown> }) => {
        const ids = (args.where['id'] as { in?: string[] } | undefined)?.in;
        if (ids && !('dayOfWeek' in args.where)) return everyone().filter((lesson) => ids.includes(lesson.id)).map(stored);
        return base.masterLesson.findMany(args as never);
      }),
    },
    school: { findUnique: jest.fn(async () => ({ timezone: 'Europe/Stockholm' })) },
    subject: { findUnique: jest.fn(async () => ({ name: 'Nytt ämne' })), findMany: jest.fn(async () => []) },
    studentGroup: { ...base.studentGroup, findFirst: jest.fn(async () => ({ name: 'C1' })) },
    room: { findMany: jest.fn(async () => ['r1', 'r2', 'r3', 'r4', 'r5'].map((id) => ({ id, name: id, capacity: 30, roomTypeId: null, minGradeLevel: null, maxGradeLevel: null, building: null }))) },
    academicYear: { findUnique: jest.fn(async () => null) },
    roomPreference: { findMany: jest.fn(async () => locks) },
  };
}

function service(setup: Set_) {
  (readSwapData as jest.Mock).mockReset();
  (readSwapData as jest.Mock).mockResolvedValue(setup.world.data);
  (judgeLessons as jest.Mock).mockReset();
  (judgeLessons as jest.Mock).mockImplementation(plainJudge(setup.world));
  const tx = txFor(setup);
  const prisma = { withRls: (_user: unknown, run: (tx: unknown) => unknown) => run(tx), onCommit: () => false };
  const swaps = new SwapsService(
    prisma as never,
    new MasterLessonsService({} as never, {} as never, {} as never),
    { snapshotInTransaction: jest.fn() } as never,
    { notifyMasterTimetableChanged: jest.fn() } as never,
    { recipientsForLessons: jest.fn(async () => []), notifyUsers: jest.fn() } as never,
  );
  return { swaps, tx };
}

const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

describe('POST /swaps/suggest with makeRoom: what has to move for a lesson to stand at a time', () => {
  const world = makeWorld({ seed: 7 });

  it('answers sets of moves that put the lesson at the time, hold every rule as one move and move nothing that stood clear', async () => {
    const { swaps } = service({ world });
    let asked = 0;
    let withProposals = 0;
    let deepest = 0;
    for (const picked of world.data.lessons.filter((_, index) => index % 9 === 4)) {
      for (const [dayOfWeek, startMinutes] of [[1, 540], [3, 600], [5, 480]] as const) {
        if (picked.dayOfWeek === dayOfWeek && picked.startMinutes === startMinutes) continue;
        const answer = await swaps.suggest({ lessonId: picked.id, makeRoom: { dayOfWeek, startTime: clock(startMinutes), depth: 2 }, limit: 30 }, user);
        asked += 1;
        expect(answer.makeRoom).toMatchObject({ target: { dayOfWeek, startMinutes, endMinutes: startMinutes + 60 }, depth: 2 });
        expect(answer.lessonId).toBe(picked.id);
        // The school's whole rule holds after every proposal, asked by a rule that knows nothing of the service.
        for (const proposal of answer.proposals) {
          expect(proposal.kind).toBe('MAKE_ROOM');
          expect(clashes(after(world, proposal.moves))).toBe(false);
          expect(proposal.id).toBe(proposalId(proposal.moves));
          // The picked lesson is where it was asked to be, and the first of the moves.
          expect(proposal.moves[0]).toMatchObject({ lessonId: picked.id, to: { dayOfWeek, startMinutes } });
          expect(proposal.levels?.[picked.id]).toBe(0);
          expect(Math.max(...Object.values(proposal.levels!))).toBe(proposal.depth);
          expect(proposal.depth).toBeLessThanOrEqual(2);
          expect(proposal.hard).toContain('CLASH');
          // Priset före och efter: the figures the order is made of, said for the lessons moved.
          expect(proposal.soft.find((cost) => cost.code === 'MOVED_LESSONS')).toMatchObject({ before: 0, after: proposal.moves.length });
          expect(proposal.lay).toBeUndefined();
          deepest = Math.max(deepest, proposal.depth ?? 0);
        }
        if (answer.proposals.length > 0) withProposals += 1;
        // The prune is exact on this grid: the judge refuses nothing it let through.
        expect(answer.stats.refused).toBe(0);
      }
    }
    expect(asked).toBeGreaterThan(5);
    expect(withProposals).toBeGreaterThan(3);
    expect(deepest).toBeGreaterThan(0);
  }, 120_000);

  it('names what stands at the time, and says so when a locked lesson is what is in the way', async () => {
    const plain = makeWorld({ seed: 7 });
    const target = plain.data.lessons.find((l) => l.dayOfWeek === 2 && l.startMinutes === 540)!;
    const picked = plain.data.lessons.find((l) => l.dayOfWeek === 4 && l.startMinutes === 600 && l.studentGroupId === target.studentGroupId)
      ?? plain.data.lessons.find((l) => l.studentGroupId === target.studentGroupId && l.id !== target.id)!;
    plain.data.lessons = plain.data.lessons.map((l) => (l.id === target.id ? { ...l, isLocked: true } : l));
    const { swaps } = service({ world: plain });
    const answer = await swaps.suggest({ lessonId: picked.id, makeRoom: { dayOfWeek: 2, startTime: '09:00' } }, user);
    expect(answer.proposals).toEqual([]);
    expect(answer.makeRoom!.stuck).toBe('LOCKED_IN_THE_WAY');
    expect(answer.makeRoom!.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ lessonIds: [target.id], isLocked: true, groupName: target.groupName, subjectName: target.subjectName })]));
  });

  it('moves a lesson to an empty place and into a place another leaves, and never a locked one', async () => {
    const locked = makeWorld({ seed: 11 });
    locked.data.lessons = locked.data.lessons.map((l, index) => (index % 4 === 0 ? { ...l, isLocked: true } : l));
    const lockedIds = new Set(locked.data.lessons.filter((l) => l.isLocked).map((l) => l.id));
    const { swaps } = service({ world: locked });
    let seen = 0;
    let toEmpty = 0;
    for (const picked of locked.data.lessons.filter((l) => !l.isLocked).slice(0, 20)) {
      for (const [dayOfWeek, startMinutes] of [[2, 600], [4, 540]] as const) {
        const answer = await swaps.suggest({ lessonId: picked.id, makeRoom: { dayOfWeek, startTime: clock(startMinutes), depth: 3 }, limit: 30 }, user);
        for (const proposal of answer.proposals) {
          seen += 1;
          for (const move of proposal.moves) if (move.lessonId !== picked.id) expect(lockedIds.has(move.lessonId)).toBe(false);
          const vacated = new Set(proposal.moves.map((move) => `${move.from.dayOfWeek}|${move.from.startMinutes}`));
          if (proposal.moves.some((move) => move.lessonId !== picked.id && !vacated.has(`${move.to.dayOfWeek}|${move.to.startMinutes}`))) toEmpty += 1;
        }
      }
    }
    expect(seen).toBeGreaterThan(20);
    expect(toEmpty).toBeGreaterThan(0);
  }, 120_000);

  it('answers a free time with the single move, and a lesson no place stands in with nothing and says why', async () => {
    const sparse = makeWorld({ seed: 7, perClass: 6 });
    const picked = sparse.data.lessons[0]!;
    const { swaps } = service({ world: sparse });
    let single = 0;
    for (const [dayOfWeek, startMinutes] of [[1, 480], [2, 540], [3, 600], [4, 660], [5, 720]] as const) {
      const answer = await swaps.suggest({ lessonId: picked.id, makeRoom: { dayOfWeek, startTime: clock(startMinutes) } }, user);
      if (answer.makeRoom!.blockers.length === 0 && answer.proposals.length > 0) {
        single += 1;
        expect(answer.proposals[0]!.moves).toHaveLength(1);
        expect(answer.proposals[0]).toMatchObject({ kind: 'MAKE_ROOM', depth: 0 });
      }
    }
    expect(single).toBeGreaterThan(0);
    const gone = service({ world: sparse, placed: new Set([picked.id]) });
    expect(await gone.swaps.suggest({ lessonId: picked.id, makeRoom: { dayOfWeek: 1, startTime: '08:00' } }, user)).toMatchObject({ proposals: [], immovable: 'PLACED' });
    const kept = service({ world: sparse, exempt: new Set([picked.id]) });
    expect(await kept.swaps.suggest({ lessonId: picked.id, makeRoom: { dayOfWeek: 1, startTime: '08:00' } }, user)).toMatchObject({ proposals: [], immovable: 'EXEMPT' });
  });

  it('makes room for a lesson on the tray: its own id, and where it is laid', async () => {
    const full = makeWorld({ seed: 7 });
    const [first] = full.data.lessons as [SwapLesson];
    // A lesson of the school that stands nowhere: the first one's class and teacher, an hour, on the tray.
    const parkedLesson: SwapLesson = { ...first, id: '00000000-0000-4000-8000-0000000000ff', dayOfWeek: 1, startMinutes: 0, endMinutes: 60 };
    const { swaps } = service({ world: full, tray: [parkedLesson] });
    const answer = await swaps.suggest({ lessonId: parkedLesson.id, makeRoom: { dayOfWeek: 2, startTime: '10:00', depth: 2 }, limit: 30 }, user);
    expect(answer.lessonId).toBe(parkedLesson.id);
    expect(answer.proposals.length).toBeGreaterThan(0);
    for (const proposal of answer.proposals) {
      expect(proposal.lay).toMatchObject({ lessonId: parkedLesson.id, slot: { dayOfWeek: 2, startMinutes: 600, endMinutes: 660 } });
      // The parked lesson is laid, not moved: it is not among the moves, and the lessons that stand are the ones that go.
      expect(proposal.moves.every((move) => move.lessonId !== parkedLesson.id)).toBe(true);
      expect(clashes(after(full, proposal.moves, [{ ...parkedLesson, dayOfWeek: 2, startMinutes: 600, endMinutes: 660 }]))).toBe(false);
      expect(proposal.soft.find((cost) => cost.code === 'MOVED_LESSONS')).toMatchObject({ after: proposal.moves.length });
      expect(proposal.id).toBe(proposalId([...proposal.moves, { lessonId: parkedLesson.id, from: { dayOfWeek: 1, startMinutes: 0, endMinutes: 60 }, to: { dayOfWeek: 2, startMinutes: 600, endMinutes: 660 } }]));
    }
  }, 60_000);

  it('makes room for a brick, which is no lesson: no id, the lay says where, and the lessons that go are the school’s own', async () => {
    const full = makeWorld({ seed: 7 });
    const { swaps } = service({ world: full });
    const brick = { academicYearId: YEAR, studentGroupId: 'c1', subjectId: 'sx', minutes: 60, teacherId: 't1', roomId: 'r1' };
    const answer = await swaps.suggest({ brick, makeRoom: { dayOfWeek: 3, startTime: '10:00', depth: 3 }, limit: 30 } as never, user);
    expect(answer.lessonId).toBe('');
    expect(answer.unit.lessonIds).toEqual([]);
    expect(answer.proposals.length).toBeGreaterThan(0);
    for (const proposal of answer.proposals) {
      expect(proposal.lay).toMatchObject({ lessonId: null, subjectName: 'Nytt ämne', slot: { dayOfWeek: 3, startMinutes: 600, endMinutes: 660 } });
      expect(proposal.moves.length).toBeGreaterThan(0);
      // The room it is laid in is the lay's: its own, or another that the proposal found for it (Annan ledig sal).
      const brickAt = { id: 'brick', subjectId: 'sx', subjectName: 'Nytt ämne', studentGroupId: 'c1', groupName: 'C1', teacherId: 't1', coTeacherId: null, roomId: proposal.lay!.roomId, dayOfWeek: 3, startMinutes: 600, endMinutes: 660 } as SwapLesson;
      expect(clashes(after(full, proposal.moves, [brickAt]))).toBe(false);
      // Level 1 is what stood in the brick's way: nothing is level 0 among the lessons that stood.
      expect(Object.values(proposal.levels!).every((level) => level >= 1)).toBe(true);
    }
  }, 60_000);

  it('is asked of one lesson or one brick, and a brick only with a time', async () => {
    const { swaps } = service({ world });
    const lessonId = world.data.lessons[0]!.id;
    const brick = { academicYearId: YEAR, studentGroupId: 'c1', subjectId: 'sx', minutes: 60 };
    await expect(swaps.suggest({} as never, user)).rejects.toBeInstanceOf(BadRequestException);
    await expect(swaps.suggest({ lessonId, brick } as never, user)).rejects.toBeInstanceOf(BadRequestException);
    await expect(swaps.suggest({ brick } as never, user)).rejects.toBeInstanceOf(BadRequestException);
    const missing = service({ world });
    await expect(missing.swaps.suggest({ lessonId: '00000000-0000-4000-8000-000000009999', makeRoom: { dayOfWeek: 1, startTime: '08:00' } }, user)).rejects.toBeInstanceOf(NotFoundException);
    // What it was, it still is: no makeRoom, the swaps and chains of three.
    const plain = await swaps.suggest({ lessonId, limit: 5 }, user);
    expect(plain.makeRoom).toBeUndefined();
    expect(plain.proposals.every((proposal) => proposal.kind === 'SWAP' || proposal.kind === 'CHAIN')).toBe(true);
  });

  it('judges every proposal through E1’s judge, as one move, and reads the board’s facts through it once per call', async () => {
    const { swaps } = service({ world });
    const picked = world.data.lessons[7]!;
    await swaps.suggest({ lessonId: picked.id, makeRoom: { dayOfWeek: 3, startTime: '10:00' }, limit: 5 }, user);
    expect(judgeLessons).toHaveBeenCalled();
    const items = (judgeLessons as jest.Mock).mock.calls.flatMap((call) => call[3] as JudgeItem[]);
    expect(items.length).toBeGreaterThan(0);
    // Every set's items name every mover as left out of where it stood, and a mover that stands is asked "låt stå" from where it stands.
    for (const item of items) {
      expect(item.excludeIds).toContain(picked.id);
      expect(item.stands).not.toBeNull();
      expect(item.exempt).toBeUndefined();
    }
  });
});

describe('Gör plats: a displaced lesson may take another room that fits and is free (E5a, Annan ledig sal)', () => {
  const world = makeWorld({ seed: 7 });
  const roomOf = (lessonId: string) => world.data.lessons.find((l) => l.id === lessonId)!.roomId;

  /** Every question over some lessons and targets, with the answers that carry a room change. */
  async function changes(limit = 40) {
    const { swaps } = service({ world });
    const out: Array<{ pickedId: string; proposal: Awaited<ReturnType<typeof swaps.suggest>>['proposals'][number]; answer: Awaited<ReturnType<typeof swaps.suggest>> }> = [];
    for (const picked of world.data.lessons.filter((_, index) => index % 7 === 3)) {
      for (const [dayOfWeek, startMinutes] of [[1, 540], [3, 600], [5, 480], [2, 660]] as const) {
        if (picked.dayOfWeek === dayOfWeek && picked.startMinutes === startMinutes) continue;
        const answer = await swaps.suggest({ lessonId: picked.id, makeRoom: { dayOfWeek, startTime: clock(startMinutes), depth: 3, otherRooms: true }, limit }, user);
        for (const proposal of answer.proposals) if (proposal.moves.some((move) => move.room)) out.push({ pickedId: picked.id, proposal, answer });
      }
    }
    return out;
  }

  it('offers no room change unless it is asked for, reads none of the school’s rooms, and answers a page that does not know the field as it always did', async () => {
    const { swaps, tx } = service({ world });
    let asked = 0;
    let offeredWhenAsked = 0;
    for (const picked of world.data.lessons.filter((_, index) => index % 7 === 3)) {
      for (const [dayOfWeek, startMinutes] of [[1, 540], [3, 600], [5, 480], [2, 660]] as const) {
        if (picked.dayOfWeek === dayOfWeek && picked.startMinutes === startMinutes) continue;
        const plain = await swaps.suggest({ lessonId: picked.id, makeRoom: { dayOfWeek, startTime: clock(startMinutes), depth: 3 }, limit: 40 }, user);
        const off = await swaps.suggest({ lessonId: picked.id, makeRoom: { dayOfWeek, startTime: clock(startMinutes), depth: 3, otherRooms: false }, limit: 40 }, user);
        expect(plain.proposals.every((proposal) => proposal.moves.every((move) => move.room === undefined))).toBe(true);
        expect(off.proposals.map((proposal) => proposal.id)).toEqual(plain.proposals.map((proposal) => proposal.id));
        const asking = await swaps.suggest({ lessonId: picked.id, makeRoom: { dayOfWeek, startTime: clock(startMinutes), depth: 3, otherRooms: true }, limit: 40 }, user);
        if (asking.proposals.some((proposal) => proposal.moves.some((move) => move.room))) offeredWhenAsked += 1;
        asked += 1;
      }
    }
    expect(asked).toBeGreaterThan(10);
    expect(offeredWhenAsked).toBeGreaterThan(0);
    // The school's rooms are read for the questions that asked for them and for no other.
    expect(tx.room.findMany).toHaveBeenCalledTimes(asked);
  }, 120_000);

  it('names the room each moved lesson leaves and takes, the school’s other room, with no double booking afterwards, and the lesson’s own room stays what the view says it is', async () => {
    const found = await changes();
    expect(found.length).toBeGreaterThan(10);
    const rooms = new Set(['r1', 'r2', 'r3', 'r4', 'r5']);
    for (const { proposal } of found) {
      for (const move of proposal.moves) {
        if (!move.room) continue;
        expect(move.room.from).toBe(roomOf(move.lessonId));
        expect(move.room.to).not.toBe(move.room.from);
        expect(rooms.has(move.room.to)).toBe(true);
      }
      expect(clashes(after(world, proposal.moves))).toBe(false);
      // The lessons the view names stand in the room they stand in now; the room they are given is in the move.
      for (const view of proposal.lessons) expect(view.roomId).toBe(roomOf(view.id));
      // The name of a proposal tells the same times in another room apart.
      expect(proposal.id).toBe(proposalId(proposal.moves));
    }
  }, 120_000);

  it('asks the judge for the room the lesson is given, and for the room it stands in as its “låt stå”', async () => {
    const { swaps } = service({ world });
    const found = await changes(8);
    const sample = found[0]!;
    (judgeLessons as jest.Mock).mockClear();
    await swaps.suggest({ lessonId: sample.pickedId, makeRoom: { dayOfWeek: sample.proposal.moves[0]!.to.dayOfWeek, startTime: clock(sample.proposal.moves[0]!.to.startMinutes), depth: 3, otherRooms: true }, limit: 40 }, user);
    const items = (judgeLessons as jest.Mock).mock.calls.flatMap((call) => call[3] as JudgeItem[]);
    const changed = sample.proposal.moves.find((move) => move.room)!;
    const asked = items.filter((item) => item.lesson.id === changed.lessonId && item.candidate.roomId === changed.room!.to);
    expect(asked.length).toBeGreaterThan(0);
    for (const item of asked) expect(item.stands!.roomId).toBe(changed.room!.from);
    // No item asks for a lesson in a room that is neither the one it stands in nor one the search gave it.
    for (const item of items) expect([roomOf(item.lesson.id!), ...['r1', 'r2', 'r3', 'r4', 'r5']]).toContain(item.candidate.roomId);
  }, 120_000);

  it('is cheapest without a room change: of two proposals of the same times the one that keeps the rooms comes first, and no two are of the same times', async () => {
    const { swaps } = service({ world });
    let seen = 0;
    for (const picked of world.data.lessons.filter((_, index) => index % 7 === 3)) {
      for (const [dayOfWeek, startMinutes] of [[1, 540], [3, 600]] as const) {
        const answer = await swaps.suggest({ lessonId: picked.id, makeRoom: { dayOfWeek, startTime: clock(startMinutes), depth: 3, otherRooms: true }, limit: 40 }, user);
        const times = answer.proposals.map((proposal) => proposal.moves.map((move) => `${move.lessonId}>${move.to.dayOfWeek}|${move.to.startMinutes}`).sort().join(';'));
        expect(new Set(times).size).toBe(times.length);
        seen += answer.proposals.filter((proposal) => proposal.moves.some((move) => move.room)).length;
      }
    }
    expect(seen).toBeGreaterThan(0);
  }, 120_000);

  it('orders by the swap search’s own figures with a room change as a small cost on top, so that a room change never beats a better time, only a tie', async () => {
    const { swaps } = service({ world });
    const context = new SwapContext(world.data);
    const price = (moves: readonly SwapMove[]) => context.soft.evaluate(moves).score + POSSIBLE_SCORE.ROOM_CHANGE * moves.filter((move) => move.room !== undefined).length;
    let lists = 0;
    let crossings = 0;
    for (const picked of world.data.lessons.filter((_, index) => index % 7 === 3)) {
      for (const [dayOfWeek, startMinutes] of [[1, 540], [3, 600], [5, 480], [2, 660]] as const) {
        if (picked.dayOfWeek === dayOfWeek && picked.startMinutes === startMinutes) continue;
        const answer = await swaps.suggest({ lessonId: picked.id, makeRoom: { dayOfWeek, startTime: clock(startMinutes), depth: 3, otherRooms: true }, limit: 40 }, user);
        const prices = answer.proposals.map((proposal) => price(proposal.moves));
        for (let at = 1; at < prices.length; at += 1) expect(prices[at - 1]!).toBeLessThanOrEqual(prices[at]!);
        // A list in which a proposal with a room change stands ahead of one without: the cost is a tie-breaker and not a ban.
        const changed = answer.proposals.map((proposal) => proposal.moves.some((move) => move.room !== undefined));
        if (changed.some((flag, at) => flag && changed.slice(at + 1).some((later) => !later))) crossings += 1;
        lists += 1;
      }
    }
    expect(lists).toBeGreaterThan(10);
    expect(crossings).toBeGreaterThan(0);
  }, 120_000);

  it('gives a lesson no room its subject’s LOCK rule leaves out (g524): the generator would not put it there, and `apply` would write it and lock it', async () => {
    // Every subject of the school is locked to r1 and r2, in every year: a lesson changes room only into one of them.
    const subjects = [...new Set(world.data.lessons.map((lesson) => lesson.subjectId))];
    const locks = subjects.map((subjectId) => ({ subjectId, minGradeLevel: null, maxGradeLevel: null, roomTypeId: null, rooms: [{ roomId: 'r1' }, { roomId: 'r2' }] }));
    const open = service({ world });
    const locked = service({ world, locks });
    let givenOpen = 0;
    let givenLocked = 0;
    for (const picked of world.data.lessons.filter((_, index) => index % 7 === 3)) {
      for (const [dayOfWeek, startMinutes] of [[1, 540], [3, 600], [5, 480], [2, 660]] as const) {
        if (picked.dayOfWeek === dayOfWeek && picked.startMinutes === startMinutes) continue;
        const body = { lessonId: picked.id, makeRoom: { dayOfWeek, startTime: clock(startMinutes), depth: 3, otherRooms: true }, limit: 40 };
        for (const proposal of (await open.swaps.suggest(body, user)).proposals) {
          for (const move of proposal.moves) if (move.room && !['r1', 'r2'].includes(move.room.to)) givenOpen += 1;
        }
        const answer = await locked.swaps.suggest(body, user);
        for (const proposal of answer.proposals) {
          for (const move of proposal.moves) {
            if (!move.room) continue;
            givenLocked += 1;
            expect(['r1', 'r2']).toContain(move.room.to);
          }
        }
      }
    }
    // Without the rule rooms outside r1 and r2 are given (the test would stand on nothing otherwise); with it some room change is still offered.
    expect(givenOpen).toBeGreaterThan(0);
    expect(givenLocked).toBeGreaterThan(0);
    // The rules are read for the questions that asked for another room, and not for any other.
    expect(locked.tx.roomPreference.findMany).toHaveBeenCalled();
    const plain = service({ world, locks });
    await plain.swaps.suggest({ lessonId: world.data.lessons[3]!.id, makeRoom: { dayOfWeek: 1, startTime: '09:00', depth: 3 }, limit: 40 }, user);
    expect(plain.tx.roomPreference.findMany).not.toHaveBeenCalled();
  }, 120_000);

  it('lays a brick in another room when its own is held and another is free, and the lay names it', async () => {
    const full = makeWorld({ seed: 7 });
    const { swaps } = service({ world: full });
    const brick = { academicYearId: YEAR, studentGroupId: 'c1', subjectId: 'sx', minutes: 60, teacherId: 't1', roomId: 'r1' };
    let moved = 0;
    for (const [dayOfWeek, startTime] of [[1, '08:00'], [2, '09:00'], [3, '10:00'], [4, '11:00'], [5, '12:00']] as const) {
      const answer = await swaps.suggest({ brick, makeRoom: { dayOfWeek, startTime, depth: 3, otherRooms: true }, limit: 40 } as never, user);
      for (const proposal of answer.proposals) {
        // The brick is laid, so its move is not among the moves of lessons that stand; its room is the lay's.
        expect(proposal.moves.every((move) => move.lessonId !== 'brick')).toBe(true);
        if (proposal.lay!.roomId !== 'r1') moved += 1;
        expect(['r1', 'r2', 'r3', 'r4', 'r5']).toContain(proposal.lay!.roomId);
      }
    }
    expect(moved).toBeGreaterThan(0);
  }, 120_000);
});

describe('POST /swaps/pair: Byt plats, two marked lessons that each take the other’s start', () => {
  /** A school where some lessons are three quarters of an hour: the swap of two of different lengths is the case. */
  function shortWorld() {
    const world = makeWorld({ seed: 7 });
    world.data.lessons = world.data.lessons.map((l, index) => (index % 5 === 2 ? { ...l, endMinutes: l.startMinutes + 45 } : l));
    return world;
  }

  it('goes when both fit where the other stands and is refused with the reasons otherwise, for every pair of different length', async () => {
    const world = shortWorld();
    const { swaps } = service({ world });
    const lengthOf = (l: SwapLesson) => l.endMinutes - l.startMinutes;
    const pairs: Array<[SwapLesson, SwapLesson]> = [];
    const lessons = world.data.lessons;
    for (let i = 0; i < lessons.length; i += 3) {
      for (let j = 1; j < lessons.length; j += 4) {
        const a = lessons[i]!;
        const b = lessons[j]!;
        if (a.id !== b.id && lengthOf(a) !== lengthOf(b) && !(a.dayOfWeek === b.dayOfWeek && a.startMinutes === b.startMinutes)) pairs.push([a, b]);
      }
    }
    let goes = 0;
    let refused = 0;
    for (const [a, b] of pairs) {
      const answer = await swaps.pair({ lessonId: a.id, otherLessonId: b.id }, user);
      // Each takes the other's start and keeps its own length.
      const moves: SwapMove[] = [
        { lessonId: a.id, from: { dayOfWeek: a.dayOfWeek, startMinutes: a.startMinutes, endMinutes: a.endMinutes }, to: { dayOfWeek: b.dayOfWeek, startMinutes: b.startMinutes, endMinutes: b.startMinutes + lengthOf(a) } },
        { lessonId: b.id, from: { dayOfWeek: b.dayOfWeek, startMinutes: b.startMinutes, endMinutes: b.endMinutes }, to: { dayOfWeek: a.dayOfWeek, startMinutes: a.startMinutes, endMinutes: a.startMinutes + lengthOf(b) } },
      ];
      const fits = !clashes(after(world, moves));
      expect(answer.ok).toBe(fits);
      if (fits) {
        goes += 1;
        expect(answer.proposal!.moves).toEqual(moves);
        expect(answer.proposal!.kind).toBe('SWAP');
        expect(answer.proposal!.id).toBe(proposalId(moves));
        expect(answer.refusals).toEqual([]);
      } else {
        refused += 1;
        expect(answer.proposal).toBeUndefined();
        expect(answer.refusals.length).toBeGreaterThan(0);
        for (const refusal of answer.refusals) {
          expect([a.id, b.id]).toContain(refusal.lessonId);
          expect(['TEACHER', 'ROOM', 'GROUP']).toContain(refusal.reason);
          expect(refusal.text.length).toBeGreaterThan(10);
        }
      }
    }
    expect(pairs.length).toBeGreaterThan(100);
    expect(goes).toBeGreaterThan(5);
    expect(refused).toBeGreaterThan(5);
  }, 120_000);

  it('says what a swap costs, and what it would take out of the published calendar', async () => {
    const world = shortWorld();
    const { swaps } = service({ world });
    for (const a of world.data.lessons.slice(0, 40)) {
      for (const b of world.data.lessons.slice(40, 80)) {
        const answer = await swaps.pair({ lessonId: a.id, otherLessonId: b.id }, user);
        if (!answer.ok) continue;
        expect(answer.proposal!.soft.map((cost) => cost.code)).toEqual(expect.arrayContaining(['PUPIL_GAPS', 'TEACHER_GAPS', 'MOVED_LESSONS']));
        expect(answer.proposal!.removedCalendarLessons).toBe(0);
        expect(answer.proposal!.lessons.map((l) => l.id).sort()).toEqual([a.id, b.id].sort());
        return;
      }
    }
    throw new Error('no pair of the world could swap');
  });

  it('swaps lessons the generation keeps: they are the person’s own to move', async () => {
    const world = shortWorld();
    world.data.lessons = world.data.lessons.map((l) => ({ ...l, isLocked: true }));
    const { swaps } = service({ world });
    let ok = 0;
    for (const a of world.data.lessons.slice(0, 20)) {
      for (const b of world.data.lessons.slice(20, 40)) {
        if ((await swaps.pair({ lessonId: a.id, otherLessonId: b.id }, user)).ok) ok += 1;
      }
    }
    expect(ok).toBeGreaterThan(0);
  });

  it('says SAME_PLACE for an hour and a three-quarter lesson that start together, and offers no swap of each to where it stands (g514)', async () => {
    const world = shortWorld();
    const [a] = world.data.lessons as [SwapLesson];
    // Another class's lesson at the same day and start, three quarters of an hour long: its own teacher, room and class.
    const short: SwapLesson = { ...a, id: '00000000-0000-4000-8000-0000000000fd', dayOfWeek: a.dayOfWeek, startMinutes: a.startMinutes, endMinutes: a.startMinutes + 45, studentGroupId: 'c9', teacherId: 'tx', roomId: 'rx' };
    const withShort = { ...world, data: { ...world.data, lessons: [...world.data.lessons, short] } };
    const answer = await service({ world: withShort }).swaps.pair({ lessonId: a.id, otherLessonId: short.id }, user);
    expect(answer).toMatchObject({ ok: false, immovable: 'SAME_PLACE' });
    expect(answer.proposal).toBeUndefined();
    // The same two the other way round.
    expect(await service({ world: withShort }).swaps.pair({ lessonId: short.id, otherLessonId: a.id }, user)).toMatchObject({ ok: false, immovable: 'SAME_PLACE' });
  });

  it('says why there is nothing to judge: a lesson on the tray or from a förläggning, lessons that are one unit or stand at one start, the same lesson twice', async () => {
    const world = shortWorld();
    const [a, b] = world.data.lessons as [SwapLesson, SwapLesson];
    const request = { lessonId: a.id, otherLessonId: b.id };
    expect(await service({ world, parked: new Set([b.id]) }).swaps.pair(request, user)).toMatchObject({ ok: false, immovable: 'PARKED', immovableLessonId: b.id });
    expect(await service({ world, placed: new Set([a.id]) }).swaps.pair(request, user)).toMatchObject({ ok: false, immovable: 'PLACED', immovableLessonId: a.id });
    const twin = { ...b, id: '00000000-0000-4000-8000-0000000000fe', dayOfWeek: a.dayOfWeek, startMinutes: a.startMinutes, endMinutes: a.startMinutes + 60, studentGroupId: 'c9', teacherId: 'tx', roomId: 'rx' };
    const same = { ...world, data: { ...world.data, lessons: [...world.data.lessons, twin] } };
    expect(await service({ world: same }).swaps.pair({ lessonId: a.id, otherLessonId: twin.id }, user)).toMatchObject({ ok: false, immovable: 'SAME_PLACE' });
    await expect(service({ world }).swaps.pair({ lessonId: a.id, otherLessonId: a.id }, user)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service({ world }).swaps.pair({ lessonId: a.id, otherLessonId: '00000000-0000-4000-8000-000000009999' }, user)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('the läslogg: a post read by Gör plats and Byt plats is a row (EMPLOYMENT), as it is for the swaps and chains of three (g514)', () => {
  /** The teacher of a lesson, made the holder of a post with a limit in the snapshot (the read that counts the breaches a proposal makes). */
  const limited = (world: World, lesson: SwapLesson) => {
    world.data.postLimited = new Set([lesson.teacherId!]);
    return lesson.teacherId!;
  };
  const employmentReads = () => (recordRead as jest.Mock).mock.calls.filter((call) => call[1] === 'EMPLOYMENT').map((call) => [...(call[2] as string[])].sort());

  beforeEach(() => (recordRead as jest.Mock).mockClear());

  it('a make-room answer with proposals records the posts of the limited teachers it names, and one with none records nothing', async () => {
    const world = makeWorld({ seed: 7 });
    const { swaps } = service({ world });
    let named = 0;
    for (const picked of world.data.lessons.filter((_, index) => index % 9 === 4)) {
      const teacher = limited(world, picked);
      (recordRead as jest.Mock).mockClear();
      const answer = await swaps.suggest({ lessonId: picked.id, makeRoom: { dayOfWeek: 3, startTime: '10:00', depth: 2 }, limit: 5 }, user);
      if (answer.proposals.length === 0) {
        expect(employmentReads()).toEqual([]);
        continue;
      }
      // The picked lesson is in every proposal, so its teacher is the one post named.
      expect(employmentReads()).toEqual([[teacher]]);
      named += 1;
    }
    expect(named).toBeGreaterThan(0);
  }, 120_000);

  it('a swap of two that goes records the posts of the limited teachers of the two, and a refused one records nothing', async () => {
    const world = makeWorld({ seed: 7 });
    const { swaps } = service({ world });
    let goes = 0;
    let refused = 0;
    const lessons = world.data.lessons;
    for (let i = 0; i < lessons.length && (goes < 3 || refused < 3); i += 3) {
      for (let j = 1; j < lessons.length && (goes < 3 || refused < 3); j += 7) {
        const [a, b] = [lessons[i]!, lessons[j]!];
        if (a.id === b.id || (a.dayOfWeek === b.dayOfWeek && a.startMinutes === b.startMinutes)) continue;
        const teacher = limited(world, a);
        (recordRead as jest.Mock).mockClear();
        const answer = await swaps.pair({ lessonId: a.id, otherLessonId: b.id }, user);
        if (answer.ok) {
          goes += 1;
          expect(employmentReads()).toContainEqual([teacher]);
        } else {
          refused += 1;
          expect(employmentReads()).toEqual([]);
        }
      }
    }
    expect(goes).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
  }, 120_000);
});

describe('Gör plats offers a displaced lesson the school’s own start clocks, not one clock (g514)', () => {
  it('lets a displaced lesson land at a clock that is neither the picked lesson’s nor the target’s', async () => {
    const world = makeWorld({ seed: 11 });
    const { swaps } = service({ world });
    let elsewhere = 0;
    let asked = 0;
    for (const picked of world.data.lessons.filter((_, index) => index % 7 === 2)) {
      for (const [dayOfWeek, startMinutes] of [[2, 600], [4, 540]] as const) {
        const answer = await swaps.suggest({ lessonId: picked.id, makeRoom: { dayOfWeek, startTime: clock(startMinutes), depth: 2 }, limit: 30 }, user);
        asked += 1;
        for (const proposal of answer.proposals) {
          for (const move of proposal.moves) {
            if (move.lessonId !== picked.id && move.to.startMinutes !== picked.startMinutes && move.to.startMinutes !== startMinutes) elsewhere += 1;
          }
        }
      }
    }
    expect(asked).toBeGreaterThan(5);
    expect(elsewhere).toBeGreaterThan(0);
  }, 120_000);
});
