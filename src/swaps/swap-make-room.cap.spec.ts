import type { RoomFact } from '../calendar/possible-times';
import type { RoomNeeds } from '../optimization/room-eligibility';
import { makeWorld } from './__fixtures__/swap-world';
import { SwapContext } from './swap-context';
import { searchMakeRoom } from './swap-make-room';
import { makeRoomWorldOf } from './swap-rooms';
import type { SwapLesson } from './swap-types';

/*
 * E5a, ANNAN LEDIG SAL: THE CAP ON THE SETS IS SHARED BY THE TWO WAYS TO THE PICKED LESSON (g524).
 *
 * The picked lesson is asked to a time where its own room is held by a lesson that is in the way of nothing else. There are two ways to that time: the
 * lesson in its own room (the holder has to go: as many sets as the holder has places to go to) and in another room (no one has to go: one set). The
 * search took the ways one after the other under one cap, so a school whose first way filled the cap offered nothing of the second, which is the
 * best proposal there is. The exhaustive check runs with no cap and cannot see it.
 */

const base = makeWorld({ seed: 11 });
const NEEDS: RoomNeeds = { studentGroupSize: 3, minGradeLevel: 7, maxGradeLevel: 7, requiredRoomTypeId: null };
const room = (id: string): RoomFact => ({ id, name: id, capacity: 30, roomTypeId: 'klass', minGradeLevel: null, maxGradeLevel: null, building: 'A' });
const lessonOf = (id: string, over: Partial<SwapLesson>): SwapLesson => ({
  id, subjectId: 's1', subjectName: 'Ämne', studentGroupId: 'c1', groupName: 'C1', teacherId: 't1', coTeacherId: null, roomId: 'r1', dayOfWeek: 1, startMinutes: 480, endMinutes: 540,
  recurrence: 'ALL_WEEKS', startDate: null, endDate: null, isLocked: false, isGenerated: true, extraGroupIds: [], studentIds: [], ...over,
});

// P (c1, t1, r1) is asked to Tuesday 09:00, where H (c2, t2) stands in r1 and in the way of nothing but the room. H has nineteen places to go to.
const p = lessonOf('p', { studentGroupId: 'c1', teacherId: 't1', roomId: 'r1', dayOfWeek: 1, startMinutes: 480, endMinutes: 540 });
const h = lessonOf('h', { studentGroupId: 'c2', groupName: 'C2', teacherId: 't2', roomId: 'r1', dayOfWeek: 2, startMinutes: 540, endMinutes: 600 });

function ask(maxCandidates: number, otherRooms: boolean) {
  const context = new SwapContext({ ...base.data, lessons: [p, h] });
  const world = makeRoomWorldOf({ context, rooms: ['r1', 'r2', 'r3'].map(room), needsOf: () => NEEDS }, { otherRooms });
  return searchMakeRoom({
    picked: context.unitOf.get('p')!,
    placed: true,
    target: { dayOfWeek: 2, startMinutes: 540 },
    unitOf: context.unitOf,
    starts: [480, 540, 600, 660],
    days: [1, 2, 3, 4, 5],
    world,
    soft: (moves) => ({ costs: [], score: moves.length + 0.1 * moves.filter((move) => move.room).length }),
    judge: async (sets) => sets.map(() => true),
    limit: 100,
    budgetMs: 1_000_000,
    depth: 2,
    maxUnits: 3,
    maxCandidates,
  });
}

describe('the cap on the sets, with two ways to the picked lesson', () => {
  it('with room to spare the best proposal is the picked lesson alone in another room, and it is first', async () => {
    const open = await ask(Number.POSITIVE_INFINITY, true);
    expect(open.truncated).toBe(false);
    expect(open.candidates).toBe(21);
    expect(open.proposals[0]!.moves).toEqual([expect.objectContaining({ lessonId: 'p', room: { from: 'r1', to: 'r2' } })]);
  });

  it('under a cap the first way fills, the second way is still tried: the picked lesson alone in another room is among the proposals', async () => {
    for (const cap of [2, 3, 5, 11]) {
      const capped = await ask(cap, true);
      expect(capped.truncated).toBe(true);
      expect(capped.candidates).toBeLessThanOrEqual(cap);
      expect(capped.proposals.some((proposal) => proposal.moves.length === 1 && proposal.moves[0]!.room?.to === 'r2')).toBe(true);
    }
  });

  it('changes nothing for a cap that is not reached, and gives the whole cap to a single way, as it always did', async () => {
    // Both ways fit: every set of both is made, truncated says no.
    const wide = await ask(24, true);
    expect(wide.candidates).toBe(21);
    expect(wide.truncated).toBe(false);
    // One way (no other room asked for): the cap is the cap.
    for (const cap of [1, 5, 19]) {
      const one = await ask(cap, false);
      expect(one.candidates).toBe(cap);
      expect(one.truncated).toBe(cap < 19);
    }
    const all = await ask(100, false);
    expect(all.candidates).toBe(19);
    expect(all.truncated).toBe(false);
  });
});
