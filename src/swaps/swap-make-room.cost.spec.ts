import { searchMakeRoom, type MakeRoomInput } from './swap-make-room';
import type { SwapLesson, SwapMove, SwapSlot, SwapUnit } from './swap-types';

/*
 * g514: COSTING THE SETS IS ONE STRETCH OF THE EVENT LOOP unless the search gives it back. On a school of six hundred lessons the 1 200 sets the
 * cap allows cost 0.25 to 1.1 s to cost (the judge is then asked of twelve), in which the API answers nobody else. The search now gives the loop
 * back every `costSlice` sets and stops costing at the time budget, like the judging after it.
 */

const HOUR = 60;
const DAYS = [1, 2, 3, 4, 5];
const STARTS = [480, 540, 600, 660, 720, 780];

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

/** One class with a lesson at every start of Monday and Tuesday: asking for Monday 08:00 for a lesson of Wednesday displaces one lesson, which has many places to go. */
function school() {
  const lessons: SwapLesson[] = [];
  for (const day of [1, 2]) for (const start of STARTS) lessons.push(lesson(`m${day}-${start}`, day, start, 'c1'));
  const picked = lesson('picked', 3, 480, 'c1');
  lessons.push(picked);
  const units = new Map(lessons.map((l) => [l.id, unitOf(l)]));
  return { lessons, picked, units };
}

function ask(over: Partial<MakeRoomInput> = {}): MakeRoomInput {
  const { lessons, picked, units } = school();
  const group = (l: SwapLesson) => l.studentGroupId;
  return {
    picked: units.get(picked.id)!,
    placed: true,
    target: { dayOfWeek: 1, startMinutes: 480 },
    unitOf: units,
    starts: STARTS,
    days: DAYS,
    world: {
      inTheWay: (moving, to) => {
        const own = new Set(moving.members.map((m) => m.id));
        const hit = lessons.filter((o) => !own.has(o.id) && moving.members.some((m) => group(m) === group(o) && o.dayOfWeek === to.dayOfWeek && o.startMinutes < to.endMinutes && to.startMinutes < o.endMinutes));
        return { lessons: hit, closed: false };
      },
      landingsClash: (a, b) => a.to.dayOfWeek === b.to.dayOfWeek && a.to.startMinutes < b.to.endMinutes && b.to.startMinutes < a.to.endMinutes,
    },
    soft: (moves: readonly SwapMove[]) => ({ costs: [], score: moves.length }),
    judge: async (sets) => sets.map(() => true),
    limit: 5,
    budgetMs: 1_000_000,
    depth: 3,
    maxUnits: 4,
    ...over,
  };
}

describe('searchMakeRoom: costing the sets does not hold the event loop, and stops at the budget (g514)', () => {
  it('gives the event loop back while it costs: something already waiting for it runs before the answer', async () => {
    let ran = false;
    setImmediate(() => {
      ran = true;
    });
    const answer = await searchMakeRoom(ask({ costSlice: 4 }));
    expect(answer.candidates).toBeGreaterThan(8);
    expect(ran).toBe(true);
  });

  it('stops costing when the time is up, says so, and judges what it has costed', async () => {
    const clock = { at: 0 };
    const answer = await searchMakeRoom(
      ask({
        costSlice: 5,
        budgetMs: 12,
        now: () => clock.at,
        // Every set costs a millisecond of the clock.
        soft: (moves) => {
          clock.at += 1;
          return { costs: [], score: moves.length };
        },
      }),
    );
    // Slices of five: 5 costed (5 ms), 10 (10 ms), 15 (15 ms > 12): the third slice is the one that finds the time up.
    expect(answer.candidates).toBe(15);
    expect(answer.truncated).toBe(true);
    expect(answer.judged).toBeGreaterThan(0);
  });

  it('costs every set when there is time, and the answer is the same as with a slice larger than the list', async () => {
    const sliced = await searchMakeRoom(ask({ costSlice: 3, limit: 30 }));
    const whole = await searchMakeRoom(ask({ costSlice: 100_000, limit: 30 }));
    expect(sliced.candidates).toBe(whole.candidates);
    expect(sliced.truncated).toBe(false);
    expect(sliced.proposals.map((p) => p.moves.map((m) => `${m.lessonId}>${m.to.dayOfWeek}|${m.to.startMinutes}`).join(';'))).toEqual(
      whole.proposals.map((p) => p.moves.map((m) => `${m.lessonId}>${m.to.dayOfWeek}|${m.to.startMinutes}`).join(';')),
    );
  });
});
