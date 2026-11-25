import type { RoomNeeds } from '../optimization/room-eligibility';
import type { Landing, SwapContext } from '../swaps/swap-context';
import type { SoftCost, SwapLesson, SwapMove, SwapSlot, SwapUnit } from '../swaps/swap-types';

/*
 * E3, MÖJLIGA TIDER: WHERE CAN THIS LESSON STAND, AND WHICH IS BEST?
 *
 * The pure half of POST /master-lessons/possible-times: it holds no database and no clock, only the school as the swap search
 * reads it (SwapContext, one snapshot of the year) and the facts a few of its questions need (the rooms, the wishes). The service
 * (possible-times.service.ts) reads those, asks the judge about what survives here, and answers.
 *
 * EVERY START TIME OF THE WEEK GETS ONE OF FIVE ANSWERS, the first that applies:
 *
 *   STANDS      where the lesson already stands.
 *   CLOSED      a rule shuts the stretch whatever else is there: the stage's ramtid (FRAME), the class's meal (LUNCH), a weekly
 *               rule on the årskurs (GRADE_RULE), another school's hold on a shared teacher or a room (OTHER_SCHOOL), or a
 *               weekly row that makes the teacher, the room or the class unavailable (AVAILABILITY). The board paints it hatched,
 *               once per stretch, with the rule's name.
 *   CANDIDATE   nothing holds the teacher, the class or (a free one is found for) the room: the judge is asked, and a yes makes
 *               it FREE, or CHANGE when the room had to be another.
 *   IN_THE_WAY  exactly one lesson that is free to move holds it (the unit it belongs to, a block as a whole): the board offers
 *               to make room (E5a). Named by class, subject, day and time.
 *   CROWDED     several lessons, or one that is locked, hold it: nothing is painted, and the panel says how many.
 *
 * THE PRUNE HOLDS NO VERDICT. CLOSED, IN_THE_WAY and CROWDED are statements about what the snapshot shows; only a CANDIDATE the
 * judge accepts is ever called free, and nothing is offered that the judge refuses (the same rule as the swap search:
 * swap-search.ts, "the search holds no rule"). A time the judge had no time left for is not painted at all.
 *
 * THE ORDER IS THE WRITTEN COST. Each accepted candidate is costed with the swap search's own soft measure (the pupils' and the
 * teachers' idle minutes, the subject's distribution, the teacher's day: swap-soft.ts), plus what the school has said it would
 * rather have (PREFERRED_FREE / PREFERRED_BUSY rows) and a small price for another room. The lowest score is first; a tie goes
 * to the earlier time. The rank is that order, and a test holds it against an exhaustive evaluation.
 */

/** What the figures are weighed with, besides swap-soft.ts's own SCORE. Heuristic ordering only: the figures shown are the real ones. */
export const POSSIBLE_SCORE = {
  /** A wish for a free hour that the time breaks, and a wish for a busy one that it meets: of the order of one idle half hour. */
  WISH: 12,
  /** Another room than the lesson has: small, so that a room change never beats a better time, only a tie. */
  ROOM_CHANGE: 4,
} as const;

/** The rules that close a stretch of start times. */
export type ClosedCode = 'FRAME' | 'LUNCH' | 'GRADE_RULE' | 'OTHER_SCHOOL' | 'AVAILABILITY';

/** A weekly wish of the school: a time a resource would rather be free, or busy. */
export interface WishRow {
  resourceType: 'TEACHER' | 'ROOM' | 'STUDENT_GROUP';
  userId: string | null;
  roomId: string | null;
  studentGroupId: string | null;
  dayOfWeek: number;
  startMinutes: number;
  endMinutes: number;
  type: 'PREFERRED_FREE' | 'PREFERRED_BUSY';
}

/** A room as the choice of one needs it. */
export interface RoomFact {
  id: string;
  name: string;
  capacity: number | null;
  roomTypeId: string | null;
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
  building: string | null;
}

/** What the generator holds a room to (optimization-engine scheduler_solver.py `_room_allowed`, `_grade_allowed`). */
export function roomAllowed(room: RoomFact, needs: RoomNeeds): boolean {
  if (room.capacity !== null && room.capacity < needs.studentGroupSize) return false;
  if (needs.requiredRoomTypeId !== null && room.roomTypeId !== needs.requiredRoomTypeId) return false;
  if (room.minGradeLevel === null && room.maxGradeLevel === null) return true;
  // A group whose years are unknown is let through: there is nothing to check it against.
  if (needs.minGradeLevel === null || needs.maxGradeLevel === null) return true;
  if (room.minGradeLevel !== null && needs.minGradeLevel < room.minGradeLevel) return false;
  if (room.maxGradeLevel !== null && needs.maxGradeLevel > room.maxGradeLevel) return false;
  return true;
}

/** The rooms that may take a lesson, the best to give it first: its own kind of room, the smallest that is big enough, its own building. */
export function roomsByFit(rooms: readonly RoomFact[], needs: RoomNeeds, own: RoomFact | undefined): RoomFact[] {
  const kept = rooms.filter((room) => roomAllowed(room, needs));
  const key = (room: RoomFact): [number, number, number] => [
    own !== undefined && room.roomTypeId === own.roomTypeId ? 0 : 1,
    room.capacity === null ? Number.MAX_SAFE_INTEGER : room.capacity - needs.studentGroupSize,
    own !== undefined && room.building === own.building ? 0 : 1,
  ];
  return kept.sort((a, b) => {
    const left = key(a);
    const right = key(b);
    for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return left[index]! - right[index]!;
    return a.name.localeCompare(b.name, 'sv') || (a.id < b.id ? -1 : 1);
  });
}

/** The lessons that move together, and the one the schemaläggare asked about. */
export interface PossibleSubject {
  unit: SwapUnit;
  /** The unit's member the question is about. */
  lesson: SwapLesson;
  /** Stands nowhere yet: a brick, or a lesson on the tray. */
  unplaced: boolean;
}

export interface PossibleWindow {
  days: readonly number[];
  fromMinutes: number;
  toMinutes: number;
  stepMinutes: number;
}

/** What the prune found for one start time. */
export type Probe =
  | { kind: 'STANDS' }
  | { kind: 'CLOSED'; code: ClosedCode; params: Record<string, string | number> }
  | { kind: 'CANDIDATE'; /** The room each member would stand in, by lesson id. */ rooms: ReadonlyMap<string, string | null>; roomChanged: boolean }
  | { kind: 'IN_THE_WAY'; blocker: SwapLesson }
  | { kind: 'CROWDED'; units: number; locked: boolean };

export interface ProbedStart {
  dayOfWeek: number;
  startMinutes: number;
  probe: Probe;
}

export interface PossibleWorld {
  context: SwapContext;
  rooms: readonly RoomFact[];
  /** What a lesson's room must satisfy, or null when the school's rooms are not the question. */
  needsOf: (lesson: SwapLesson) => RoomNeeds | null;
  wishes: readonly WishRow[];
}

const lengthOf = (lesson: Pick<SwapSlot, 'startMinutes' | 'endMinutes'>): number => lesson.endMinutes - lesson.startMinutes;
const overlaps = (a0: number, a1: number, b0: number, b1: number): boolean => a0 < b1 && b0 < a1;

/** The start times asked about, day by day. */
export function startsOf(window: PossibleWindow, longest: number): Array<{ dayOfWeek: number; startMinutes: number }> {
  const out: Array<{ dayOfWeek: number; startMinutes: number }> = [];
  for (const dayOfWeek of [...window.days].sort((a, b) => a - b)) {
    for (let start = window.fromMinutes; start + longest <= window.toMinutes; start += window.stepMinutes) {
      out.push({ dayOfWeek, startMinutes: start });
    }
  }
  return out;
}

/** A unit's members laid at a start: each keeps its own length. */
function landingsAt(context: SwapContext, unit: SwapUnit, dayOfWeek: number, startMinutes: number): Landing[] {
  return context.landingsOf(unit, { dayOfWeek, startMinutes, endMinutes: startMinutes + lengthOf(unit.slot) });
}

/** The prune, for every start of the window. See the file's first paragraphs for what each answer means. */
export function probeStarts(world: PossibleWorld, subject: PossibleSubject, window: PossibleWindow): ProbedStart[] {
  const { context } = world;
  const { unit } = subject;
  const vacating = new Set(unit.members.map((member) => member.id));
  const longest = Math.max(...unit.members.map(lengthOf));
  const own = new Map(world.rooms.map((room) => [room.id, room]));
  const single = unit.members.length === 1;

  const probes: ProbedStart[] = [];
  for (const { dayOfWeek, startMinutes } of startsOf(window, longest)) {
    const put = (probe: Probe) => probes.push({ dayOfWeek, startMinutes, probe });
    if (!subject.unplaced && unit.slot.dayOfWeek === dayOfWeek && unit.slot.startMinutes === startMinutes) {
      put({ kind: 'STANDS' });
      continue;
    }
    const landings = landingsAt(context, unit, dayOfWeek, startMinutes);

    // The room is a question of its own: closed or held by the rules that do not name it first, then lessons, then the room.
    let closed: Probe | null = null;
    const blockers = new Map<string, SwapLesson>();
    for (const landing of landings) {
      const roomless: Landing = { lesson: { ...landing.lesson, roomId: null }, to: landing.to };
      const board = context.boardRefusal(roomless);
      if (board !== null) {
        closed = { kind: 'CLOSED', code: board, params: board === 'OTHER_SCHOOL' ? { schools: context.holdSchoolsAt(roomless).join(', ') } : {} };
        break;
      }
      const way = context.inTheWay(roomless, vacating);
      if (way.closures.length > 0) {
        closed = { kind: 'CLOSED', code: 'AVAILABILITY', params: { resource: way.closures[0]! } };
        break;
      }
      for (const other of way.lessons) blockers.set(other.id, other);
    }
    if (closed !== null) {
      put(closed);
      continue;
    }
    if (blockers.size > 0) {
      put(blockedBy(context, blockers.values()));
      continue;
    }

    // The teacher and the class are free. The room: keep it if it is free, else the best free one that fits.
    const rooms = new Map<string, string | null>();
    let roomChanged = false;
    let roomBlockers = new Map<string, SwapLesson>();
    let stuck = false;
    for (const landing of landings) {
      const room = landing.lesson.roomId;
      if (room === null) {
        rooms.set(landing.lesson.id, null);
        continue;
      }
      const way = context.inTheWay(landing, vacating);
      if (way.lessons.length === 0 && way.closures.length === 0 && context.boardRefusal(landing) === null) {
        rooms.set(landing.lesson.id, room);
        continue;
      }
      const needs = single ? world.needsOf(landing.lesson) : null;
      const alternative =
        needs === null
          ? undefined
          : roomsByFit(world.rooms, needs, own.get(room)).find((candidate) => {
              if (candidate.id === room) return false;
              const moved: Landing = { lesson: { ...landing.lesson, roomId: candidate.id }, to: landing.to };
              const there = context.inTheWay(moved, vacating);
              return there.lessons.length === 0 && there.closures.length === 0 && context.boardRefusal(moved) === null;
            });
      if (alternative === undefined) {
        stuck = true;
        roomBlockers = new Map([...roomBlockers, ...way.lessons.map((other): [string, SwapLesson] => [other.id, other])]);
        break;
      }
      rooms.set(landing.lesson.id, alternative.id);
      roomChanged = true;
    }
    if (stuck) {
      // A room held by a hold or a closure and by no lesson has no one to make room: nothing is painted.
      put(roomBlockers.size > 0 ? blockedBy(context, roomBlockers.values()) : { kind: 'CROWDED', units: 0, locked: false });
      continue;
    }
    put({ kind: 'CANDIDATE', rooms, roomChanged });
  }
  return probes;
}

/** The lessons in the way: one unit that can be moved is "a lesson in the way", anything else is crowded. */
function blockedBy(context: SwapContext, blockers: Iterable<SwapLesson>): Probe {
  const units = new Map<string, SwapUnit>();
  const first = new Map<string, SwapLesson>();
  for (const lesson of blockers) {
    const unit = context.unitOf.get(lesson.id);
    const id = unit?.id ?? lesson.id;
    if (unit) units.set(id, unit);
    if (!first.has(id)) first.set(id, lesson);
  }
  const count = Math.max(units.size, first.size);
  const locked = [...units.values()].some((unit) => unit.locked) || [...first.values()].some((lesson) => lesson.isLocked);
  if (count === 1 && !locked) return { kind: 'IN_THE_WAY', blocker: [...first.values()][0]! };
  return { kind: 'CROWDED', units: count, locked };
}

/** What the school's wishes say of a lesson laid at a slot: the wishes it meets and the ones it breaks. */
export function wishesOf(wishes: readonly WishRow[], lesson: SwapLesson, room: string | null, to: SwapSlot): { met: number; avoided: number } {
  let met = 0;
  let avoided = 0;
  const groups = [lesson.studentGroupId, ...lesson.extraGroupIds];
  for (const wish of wishes) {
    if (wish.dayOfWeek !== to.dayOfWeek || !overlaps(to.startMinutes, to.endMinutes, wish.startMinutes, wish.endMinutes)) continue;
    const mine =
      (wish.resourceType === 'TEACHER' && wish.userId !== null && (wish.userId === lesson.teacherId || wish.userId === lesson.coTeacherId)) ||
      (wish.resourceType === 'ROOM' && room !== null && wish.roomId === room) ||
      (wish.resourceType === 'STUDENT_GROUP' && wish.studentGroupId !== null && groups.includes(wish.studentGroupId));
    if (!mine) continue;
    if (wish.type === 'PREFERRED_BUSY') met += 1;
    else avoided += 1;
  }
  return { met, avoided };
}

export interface CostedStart {
  dayOfWeek: number;
  startMinutes: number;
  endMinutes: number;
  rooms: ReadonlyMap<string, string | null>;
  roomChanged: boolean;
  costs: SoftCost[];
  wishes: { met: number; avoided: number };
  /** Lower is better. */
  score: number;
}

/** What laying the unit at a start costs: the soft figures of the move, the wishes and the room. */
export function costOf(
  world: PossibleWorld,
  subject: PossibleSubject,
  start: { dayOfWeek: number; startMinutes: number; rooms: ReadonlyMap<string, string | null>; roomChanged: boolean },
): CostedStart {
  const moves: SwapMove[] = subject.unit.members.map((member) => ({
    lessonId: member.id,
    from: { dayOfWeek: member.dayOfWeek, startMinutes: member.startMinutes, endMinutes: member.endMinutes },
    to: { dayOfWeek: start.dayOfWeek, startMinutes: start.startMinutes, endMinutes: start.startMinutes + lengthOf(member) },
  }));
  const { costs, score: soft } = world.context.soft.evaluate(moves);
  let met = 0;
  let avoided = 0;
  for (const move of moves) {
    const member = subject.unit.members.find((candidate) => candidate.id === move.lessonId)!;
    const found = wishesOf(world.wishes, member, start.rooms.get(member.id) ?? null, move.to);
    met += found.met;
    avoided += found.avoided;
  }
  const score = soft + POSSIBLE_SCORE.WISH * (avoided - met) + (start.roomChanged ? POSSIBLE_SCORE.ROOM_CHANGE : 0);
  return {
    dayOfWeek: start.dayOfWeek,
    startMinutes: start.startMinutes,
    endMinutes: start.startMinutes + lengthOf(subject.unit.slot),
    rooms: start.rooms,
    roomChanged: start.roomChanged,
    costs,
    wishes: { met, avoided },
    score,
  };
}

/** The best first; a tie goes to the earlier day and time. */
export function byScore(a: CostedStart, b: CostedStart): number {
  return a.score - b.score || a.dayOfWeek - b.dayOfWeek || a.startMinutes - b.startMinutes;
}

/** One stretch of start times with one answer: what the board paints once. */
export interface Run {
  dayOfWeek: number;
  /** The first start of the run and the last (inclusive); `stepMinutes` apart. */
  fromMinutes: number;
  toMinutes: number;
  kind: 'FREE' | 'CHANGE' | 'CLOSED' | 'IN_THE_WAY' | 'CROWDED' | 'STANDS';
  code?: ClosedCode;
  params?: Record<string, string | number>;
  /** IN_THE_WAY: the lesson that holds it. */
  blockerId?: string;
  /** CROWDED: how many units hold it, and whether one of them is locked. */
  units?: number;
  locked?: boolean;
}

/** The final answer of one start, before runs are cut. */
export type Settled =
  | { kind: 'FREE' | 'CHANGE' | 'STANDS' }
  | { kind: 'CLOSED'; code: ClosedCode; params: Record<string, string | number> }
  | { kind: 'IN_THE_WAY'; blockerId: string }
  | { kind: 'CROWDED'; units: number; locked: boolean }
  /** Not asked of the judge in time: painted as nothing. */
  | { kind: 'UNJUDGED' };

const sameAnswer = (a: Settled, b: Settled): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Cuts the starts into runs of one answer, per day, in time order. UNJUDGED starts are left out. */
export function runsOf(settled: ReadonlyArray<{ dayOfWeek: number; startMinutes: number; answer: Settled }>, stepMinutes: number): Run[] {
  const runs: Run[] = [];
  let open: { run: Run; answer: Settled } | null = null;
  for (const { dayOfWeek, startMinutes, answer } of settled) {
    if (answer.kind === 'UNJUDGED') {
      open = null;
      continue;
    }
    if (open && open.run.dayOfWeek === dayOfWeek && open.run.toMinutes + stepMinutes === startMinutes && sameAnswer(open.answer, answer)) {
      open.run.toMinutes = startMinutes;
      continue;
    }
    const run: Run = { dayOfWeek, fromMinutes: startMinutes, toMinutes: startMinutes, kind: answer.kind };
    if (answer.kind === 'CLOSED') {
      run.code = answer.code;
      run.params = answer.params;
    } else if (answer.kind === 'IN_THE_WAY') {
      run.blockerId = answer.blockerId;
    } else if (answer.kind === 'CROWDED') {
      run.units = answer.units;
      run.locked = answer.locked;
    }
    runs.push(run);
    open = { run, answer };
  }
  return runs;
}
