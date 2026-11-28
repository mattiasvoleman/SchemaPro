import { searchMakeRoom, type MakeRoomInput } from './swap-make-room';
import type { SwapLesson, SwapMove, SwapSlot, SwapUnit } from './swap-types';

/*
 * g514: TWO QUESTIONS THAT HAVE NO ANSWER. A lesson asked to stand where it stands is no move at all, and a landing that runs past midnight is no
 * place. Both were answered with a proposal (the first a move from a place to itself, which apply would have locked and logged, the second a
 * lesson ending at 24:30 that no clock of apply can name).
 */

const HOUR = 60;
const STARTS = [480, 540, 600, 660];

const lesson = (id: string, day: number, start: number, group: string): SwapLesson => ({
  id,
  subjectId: `s-${id}`,
  subjectName: id,
  studentGroupId: group,
  groupName: group,
  teacherId: null,
  coTeacherId: null,
  roomId: null,
  dayOfWeek: day,
  startMinutes: start,
  endMinutes: start + HOUR,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  isLocked: false,
  isGenerated: true,
  extraGroupIds: [],
  studentIds: [],
});
const slotOf = (l: SwapLesson): SwapSlot => ({ dayOfWeek: l.dayOfWeek, startMinutes: l.startMinutes, endMinutes: l.endMinutes });
const unitOf = (l: SwapLesson): SwapUnit => ({ id: l.id, members: [l], links: [], slot: slotOf(l), locked: false });

function ask(target: { dayOfWeek: number; startMinutes: number }, over: Partial<MakeRoomInput> = {}): MakeRoomInput {
  const lessons = [lesson('a', 1, 480, 'c1'), lesson('b', 1, 540, 'c1'), lesson('c', 2, 480, 'c2')];
  const units = new Map(lessons.map((l) => [l.id, unitOf(l)]));
  return {
    picked: units.get('a')!,
    placed: true,
    target,
    unitOf: units,
    starts: STARTS,
    days: [1, 2, 3],
    world: {
      inTheWay: (moving, to) => {
        const own = new Set(moving.members.map((m) => m.id));
        return {
          lessons: lessons.filter((o) => !own.has(o.id) && moving.members.some((m) => m.studentGroupId === o.studentGroupId && o.dayOfWeek === to.dayOfWeek && o.startMinutes < to.endMinutes && to.startMinutes < o.endMinutes)),
          closed: false,
        };
      },
      landingsClash: (x, y) => x.to.dayOfWeek === y.to.dayOfWeek && x.to.startMinutes < y.to.endMinutes && y.to.startMinutes < x.to.endMinutes,
    },
    soft: (moves: readonly SwapMove[]) => ({ costs: [], score: moves.length }),
    judge: async (sets) => sets.map(() => true),
    limit: 10,
    budgetMs: 1_000_000,
    depth: 3,
    maxUnits: 4,
    ...over,
  };
}

describe('searchMakeRoom: a lesson asked to stand where it stands, and a landing past midnight (g514)', () => {
  it('makes room for nothing when the lesson already stands at the time asked: no proposal, no move from a place to itself', async () => {
    const answer = await searchMakeRoom(ask({ dayOfWeek: 1, startMinutes: 480 }));
    expect(answer.proposals).toEqual([]);
    expect(answer.candidates).toBe(0);
    // Asked of another time it still answers: the guard is for the place the lesson stands at.
    const elsewhere = await searchMakeRoom(ask({ dayOfWeek: 3, startMinutes: 480 }));
    expect(elsewhere.proposals.length).toBeGreaterThan(0);
  });

  it('a lesson that stands nowhere (a brick, the tray) may be laid at any time, the placeholder place it carries being no place', async () => {
    const brick = unitOf(lesson('brick', 1, 480, 'c1'));
    const answer = await searchMakeRoom({ ...ask({ dayOfWeek: 1, startMinutes: 480 }), picked: brick, placed: false });
    expect(answer.proposals.length).toBeGreaterThan(0);
  });

  it('says the time is closed when the lesson would end after midnight, and offers nothing', async () => {
    const answer = await searchMakeRoom(ask({ dayOfWeek: 3, startMinutes: 23 * 60 + 30 }));
    expect(answer.stuck).toBe('CLOSED');
    expect(answer.proposals).toEqual([]);
    const justFits = await searchMakeRoom(ask({ dayOfWeek: 3, startMinutes: 23 * 60 }));
    expect(justFits.stuck).toBeUndefined();
    expect(justFits.proposals.length).toBeGreaterThan(0);
  });

  it('lands a displaced lesson at no start that would end it after midnight', async () => {
    // `a` asked for Monday 09:00, where `b` of the same class stands: b has to go, and the only place the school offers it is Wednesday 23:30.
    const lateOnly = await searchMakeRoom(ask({ dayOfWeek: 1, startMinutes: 540 }, { starts: [23 * 60 + 30], days: [3] }));
    expect(lateOnly.blockers.map((unit) => unit.id)).toEqual(['b']);
    expect(lateOnly.proposals).toEqual([]);
    // With an ordinary start beside it, the lesson goes there and never to the late one.
    const both = await searchMakeRoom(ask({ dayOfWeek: 1, startMinutes: 540 }, { starts: [480, 23 * 60 + 30], days: [3] }));
    expect(both.proposals.length).toBeGreaterThan(0);
    for (const proposal of both.proposals) for (const move of proposal.moves) expect(move.to.endMinutes).toBeLessThanOrEqual(24 * 60);
  });
});
