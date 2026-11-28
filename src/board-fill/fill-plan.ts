import { byScore, costOf, prepare, probeAt, roomsByFit, type CostedStart, type PossibleSubject, type PossibleWorld, type RoomFact, type WishRow } from '../calendar/possible-times';
import type { ClosedWeeks } from '../calendar/school-weeks';
import type { RoomNeeds } from '../optimization/room-eligibility';
import { SwapContext } from '../swaps/swap-context';
import type { SwapData } from '../swaps/swap-snapshot';
import type { SoftCost, SwapLesson, SwapUnit } from '../swaps/swap-types';

/*
 * LÄGG DET SOM GÅR (E7a), THE PURE HALF: bricks laid one at a time, the hardest first, each on the best free time it has, with a room.
 *
 * It holds no database and no clock of its own, only what the possible-times question holds (possible-times.ts): the school as the swap
 * search reads it (SwapContext, one snapshot of the year), the rooms, the wishes. The service (board-fill.service.ts) reads those, lets the
 * judge have the last word on every time this chooses, and says the result. The provet on the corpus's weeks (scripts/bench/fill-corpus.ts)
 * runs this very function over a witness week with lessons taken out, so the figures it gives are the function's and not a model of it.
 *
 * WHAT IT NEVER DOES. It moves no lesson that stands (a brick is laid in the free; "får flytta" is E5a's search and a later PR), it gives no
 * exemption (a time the prune closes for FRAME or LUNCH is closed; there is no `exempt` here), and it says nothing of what it cannot lay
 * except that it did not: `left` is "not laid by this", never "cannot be laid".
 *
 * ONE GREEDY STEP: the prune says which starts are free (probeAt: the clash rule's plain overlaps, the board's rules); for each a room is found
 * that the generator's rule allows and nothing holds (roomsByFit, inTheWay); the free starts are costed as the board costs them
 * (costOf: the pupils' and teachers' idle minutes, the subject's distribution, the teacher's day, the school's wishes); the judge is asked
 * about them in the order of the cost until one is let through. The brick is then a lesson, locked, and the world is read again with it in.
 */

/** A lesson that is still to be laid: the lesson it would be, standing nowhere (dayOfWeek and the clock are a placeholder nothing reads). */
export interface FillBrick {
  /** The brick's own name, the same in the answer: the tray's postId|teacherId|minutes|nth. */
  key: string;
  lesson: SwapLesson;
}

/** What the world is read with besides the snapshot: the facts E3's question reads for the same purpose. */
export interface FillWorld {
  data: SwapData;
  rooms: readonly RoomFact[];
  wishes: readonly WishRow[];
  needsOf: (lesson: SwapLesson) => RoomNeeds | null;
  closedWeeks: ClosedWeeks | null;
  sharedRooms: ReadonlySet<string>;
}

/**
 * In what order the bricks are taken.
 *   LONGEST        the tray's own order: the longest first, then in a fixed order. Static.
 *   FEWEST_ONCE    the brick with the fewest free starts first, counted once on the world as it is before anything is laid. Static.
 *   FEWEST_EXACT   the brick with the fewest free starts first, every brick counted again, rooms included, before every brick laid. The reference:
 *                  its cost grows with the square of the bricks, and the provet measures what the cheaper FEWEST gives up of it.
 *   FEWEST         the same, counted again only for the bricks a laid lesson can have taken a start from (the same teacher, a group that shares a pupil
 *                  with its class, a scarce room), and without rooms in the count except for those. The order the service uses.
 */
export type FillOrder = 'LONGEST' | 'FEWEST_ONCE' | 'FEWEST_EXACT' | 'FEWEST';

/**
 * Which of the free starts a brick is laid on.
 *   COST      the lowest written cost (costOf), a tie to the earlier time: the order the board ranks by.
 *   EARLIEST  the earliest free start of the week, with no cost counted: the price of the cost, for the provet.
 *   KEEP_OPEN of the few lowest-cost starts, the one that takes the fewest last starts from the other bricks (the same teacher or a group that shares a
 *             pupil, overlapping), the lowest cost among those. It needs the counts of the order FEWEST and is COST under any other.
 */
export type FillChoice = 'COST' | 'EARLIEST' | 'KEEP_OPEN';

/** How many of the lowest-cost starts KEEP_OPEN weighs. */
const KEEP_OPEN_WIDTH = 12;

export interface FillOptions {
  order: FillOrder;
  choice: FillChoice;
  /** The start times asked about, in minutes apart. */
  stepMinutes: number;
  /**
   * Which starts are asked. STEP: every `stepMinutes` of the frame. POINTS: only where something begins or ends in the school (a lesson, a meal, a
   * closed stretch, the frame) and where a lesson of the brick's length would end at such a point: a school whose lessons begin at five past is asked at
   * five past, and no start is asked that no one can tell from its neighbour. Absent: STEP.
   */
  starts?: 'STEP' | 'POINTS';
  /** After this long no new brick is begun: the rest are `left` with the reason TIME. Absent: no limit. */
  budgetMs?: number;
  /** How many of the best starts the judge is asked about before the brick is given up on. */
  judgeTries?: number;
  /** The judge's word on a start: true lets it through. Absent: the prune's word stands (the provet; the service always gives one). */
  judge?: (candidate: FillCandidate) => Promise<boolean>;
  /** Told of every brick as it is laid, before the next is asked about: the service gives the judge the lessons laid so far through it. */
  onPlaced?: (placed: FillPlaced) => void;
  /** The clock, for the budget and the figures; a test gives its own. */
  now?: () => number;
}

export interface FillCandidate {
  brick: FillBrick;
  dayOfWeek: number;
  startMinutes: number;
  endMinutes: number;
  roomId: string | null;
}

export interface FillPlaced extends FillCandidate {
  /** The written cost of the time it was laid on, and its parts. */
  score: number;
  costs: SoftCost[];
  /** How many starts were free for it when it was taken, and which of them (1 = the best) it was laid on after the judge's refusals. */
  freeStarts: number;
  rank: number;
}

export type FillLeftReason =
  /** No start is free for it, with a room: nothing that stands can be moved by this, so it says that and no more. */
  | 'NO_FREE_START'
  /** Every start it tried the judge refused. */
  | 'JUDGE'
  /** The time was out before it was begun. */
  | 'TIME';

export interface FillLeft {
  brick: FillBrick;
  reason: FillLeftReason;
  freeStarts: number;
}

export interface FillPlan {
  /** In the order they were laid: each was judged with the ones before it standing. */
  placed: FillPlaced[];
  left: FillLeft[];
  stats: {
    bricks: number;
    /** Worlds built (SwapContext): one at the start and one after every brick laid. */
    worlds: number;
    elapsedMs: number;
    worldMs: number;
    probeMs: number;
    costMs: number;
    judgeMs: number;
    /** The free starts counted to choose the order, in all. */
    orderingProbes: number;
  };
}

/** The days and the clock the school has a frame for: the starts asked about. Days without a frame are closed whatever the clock. */
export function windowOfFrames(data: SwapData): { days: number[]; fromMinutes: number; toMinutes: number } {
  const days = new Set<number>();
  let from = Number.POSITIVE_INFINITY;
  let to = 0;
  for (const frame of data.frames) {
    if (frame.day === null) for (const day of [1, 2, 3, 4, 5]) days.add(day);
    else days.add(frame.day);
    from = Math.min(from, frame.start);
    to = Math.max(to, frame.end);
  }
  if (days.size === 0 || !Number.isFinite(from)) return { days: [1, 2, 3, 4, 5], fromMinutes: 7 * 60, toMinutes: 18 * 60 };
  return { days: [...days].sort((a, b) => a - b), fromMinutes: from, toMinutes: to };
}

interface Start {
  dayOfWeek: number;
  startMinutes: number;
  roomId: string | null;
}

/** The world the planner reads: the placed lessons, and the bricks not yet laid as lessons that stand nowhere. */
function worldOf(world: FillWorld, placed: readonly SwapLesson[], remaining: readonly FillBrick[]): PossibleWorld {
  const data: SwapData = placed.length === 0 ? world.data : { ...world.data, lessons: [...world.data.lessons, ...placed] };
  const context = new SwapContext(data, { unplaced: remaining.map((brick) => brick.lesson), closedWeeks: world.closedWeeks, sharedRooms: world.sharedRooms });
  return { context, rooms: world.rooms, wishes: world.wishes, needsOf: world.needsOf };
}

/** The room a brick is laid in at a start: the best the generator's rule allows that nothing holds, or null when the school has none that may. */
function roomAt(possible: PossibleWorld, allowed: readonly RoomFact[], lesson: SwapLesson, to: { dayOfWeek: number; startMinutes: number; endMinutes: number }): { roomId: string | null } | undefined {
  if (allowed.length === 0) return { roomId: null };
  const { context } = possible;
  for (const room of allowed) {
    const landing = { lesson: { ...lesson, roomId: room.id }, to };
    if (context.isSharedRoom(room.id)) return { roomId: room.id };
    const way = context.inTheWay(landing, new Set(), true);
    if (way.lessons.length === 0 && way.closures.length === 0 && context.boardRefusal(landing) === null) return { roomId: room.id };
  }
  return undefined;
}

const minutesOfClock = (clock: string): number => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

/** The times of the day at which something in the school begins or ends: the starts a brick can be told apart on. */
export function pointsOf(data: SwapData, window: { fromMinutes: number; toMinutes: number }): number[] {
  const points = new Set<number>([window.fromMinutes, window.toMinutes]);
  for (const lesson of data.lessons) {
    points.add(lesson.startMinutes);
    points.add(lesson.endMinutes);
  }
  for (const sitting of data.sittings) {
    points.add(sitting.startMinutes);
    points.add(sitting.endMinutes);
  }
  for (const row of data.constraints) {
    points.add(row.startMinutes);
    points.add(row.endMinutes);
  }
  for (const frame of data.frames) {
    points.add(frame.start);
    points.add(frame.end);
  }
  // Another school's hold on a room or a teacher (Delade lokaler) shuts a stretch as a closed hour does: the first start after it and the last that ends before it
  // are starts like any other, and no lesson of this school has to begin or end there.
  for (const hold of data.holds) {
    points.add(minutesOfClock(hold.startTime));
    points.add(minutesOfClock(hold.endTime));
  }
  return [...points].filter((point) => point >= window.fromMinutes && point <= window.toMinutes).sort((a, b) => a - b);
}

/** The start times of a brick of this length: the grid, or the points where it begins at one or ends at one. */
function startTimesOf(points: readonly number[] | null, window: { fromMinutes: number; toMinutes: number }, stepMinutes: number, length: number): number[] {
  const out = new Set<number>();
  if (points === null) {
    for (let start = window.fromMinutes; start + length <= window.toMinutes; start += stepMinutes) out.add(start);
  } else {
    for (const point of points) {
      if (point + length <= window.toMinutes) out.add(point);
      if (point - length >= window.fromMinutes) out.add(point - length);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * The free starts of a brick in the world as it is: the prune's CANDIDATE and, unless `withRooms` is false, with a room that holds.
 * Without rooms the count is the teacher's, the classes' and the board's alone, which is what most bricks' difficulty is made of and a good deal
 * cheaper to ask; a brick's own start is always asked with its room.
 */
function freeStartsOf(
  possible: PossibleWorld,
  brick: FillBrick,
  window: { days: readonly number[]; fromMinutes: number; toMinutes: number },
  stepMinutes: number,
  points: readonly number[] | null,
  withRooms: boolean,
): { subject: PossibleSubject; starts: Start[] } {
  const unit = possible.context.unitOf.get(brick.lesson.id) as SwapUnit;
  const subject: PossibleSubject = { unit, lesson: brick.lesson, unplaced: true };
  const prepared = prepare(possible, subject);
  const needs = possible.needsOf(brick.lesson);
  const allowed = needs === null ? [] : roomsByFit(possible.rooms, needs, undefined);
  const length = brick.lesson.endMinutes - brick.lesson.startMinutes;
  const times = startTimesOf(points, window, stepMinutes, length);
  const starts: Start[] = [];
  for (const dayOfWeek of window.days) {
    for (const startMinutes of times) {
      const probe = probeAt(possible, subject, prepared, dayOfWeek, startMinutes);
      if (probe.kind !== 'CANDIDATE') continue;
      if (!withRooms) {
        starts.push({ dayOfWeek, startMinutes, roomId: null });
        continue;
      }
      const room = roomAt(possible, allowed, brick.lesson, { dayOfWeek, startMinutes, endMinutes: startMinutes + length });
      if (room === undefined) continue;
      starts.push({ dayOfWeek, startMinutes, roomId: room.roomId });
    }
  }
  return { subject, starts };
}

/** group -> the groups that hold a pupil of it: what a lesson of one takes from the others (the clash rule's own reading of the rosters). */
function relatedGroupsOf(data: SwapData): Map<string, Set<string>> {
  const related = new Map<string, Set<string>>();
  for (const groups of data.rosters.groupsByStudent.values()) {
    for (const a of groups) {
      let set = related.get(a);
      if (!set) related.set(a, (set = new Set([a])));
      for (const b of groups) set.add(b);
    }
  }
  return related;
}

const lengthOf = (brick: FillBrick): number => brick.lesson.endMinutes - brick.lesson.startMinutes;
const byLongest = (a: FillBrick, b: FillBrick): number => lengthOf(b) - lengthOf(a) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** What a brick takes from the world and what the world takes from it, for the incremental count: who it needs and which rooms it can only get. */
interface Needs {
  teachers: string[];
  groups: string[];
  /** Its allowed rooms when they are few enough that a lesson laid in one can take its last start; null when the room is no question of its order. */
  scarceRooms: ReadonlySet<string> | null;
}

/** A room kind with this few rooms that may take a brick is a question of its order: a classroom among twenty is not. */
const SCARCE_ROOMS = 3;

/**
 * Lays the bricks, one at a time. The world is built again after every brick laid (SwapContext is read-only by design and owned by the swap
 * search), which is the planner's own cost and is counted in `stats.worldMs`.
 */
export async function planFill(world: FillWorld, bricks: readonly FillBrick[], window: { days: readonly number[]; fromMinutes: number; toMinutes: number }, options: FillOptions): Promise<FillPlan> {
  const now = options.now ?? Date.now;
  const began = now();
  const stats: FillPlan['stats'] = { bricks: bricks.length, worlds: 0, elapsedMs: 0, worldMs: 0, probeMs: 0, costMs: 0, judgeMs: 0, orderingProbes: 0 };
  const placed: FillPlaced[] = [];
  const left: FillLeft[] = [];
  const standing: SwapLesson[] = [];
  let remaining = [...bricks].sort(byLongest);
  const judgeTries = options.judgeTries ?? 6;
  const points = options.starts === 'POINTS' ? pointsOf(world.data, window) : null;

  const build = (): PossibleWorld => {
    const started = now();
    const built = worldOf(world, standing, remaining);
    stats.worlds += 1;
    stats.worldMs += now() - started;
    return built;
  };
  let possible = build();

  /** The free starts each brick had when it was last counted (the incremental order and KEEP_OPEN read them). */
  const startsOfBrick = new Map<string, Start[]>();
  const count = (brick: FillBrick, withRooms: boolean): number => {
    const started = now();
    const { starts } = freeStartsOf(possible, brick, window, options.stepMinutes, points, withRooms);
    startsOfBrick.set(brick.key, starts);
    stats.probeMs += now() - started;
    stats.orderingProbes += 1;
    return starts.length;
  };
  const counts = new Map<string, number>();
  const byCount = (a: FillBrick, b: FillBrick): number => (counts.get(a.key) ?? 0) - (counts.get(b.key) ?? 0) || byLongest(a, b);

  // The static orders are settled before anything is laid; the incremental one counts once here and again for the bricks a laid lesson touches.
  if (options.order === 'FEWEST_ONCE') {
    for (const brick of remaining) counts.set(brick.key, count(brick, true));
    remaining.sort(byCount);
  }
  const needs = new Map<string, Needs>();
  const related = options.order === 'FEWEST' ? relatedGroupsOf(world.data) : null;
  // A school with a replacing group has no plain relation between groups (SwapContext keeps to the groups themselves): every brick is then touched.
  const everyBrickTouched = options.order === 'FEWEST' && world.data.groups.some((group) => group.replacesSubjectId !== null);
  if (options.order === 'FEWEST') {
    for (const brick of remaining) {
      const own = possible.needsOf(brick.lesson);
      const allowed = own === null ? [] : roomsByFit(possible.rooms, own, undefined);
      needs.set(brick.key, {
        teachers: [brick.lesson.teacherId, brick.lesson.coTeacherId].filter((id): id is string => id !== null),
        groups: [brick.lesson.studentGroupId, ...brick.lesson.extraGroupIds],
        scarceRooms: allowed.length > 0 && allowed.length <= SCARCE_ROOMS ? new Set(allowed.map((room) => room.id)) : null,
      });
      counts.set(brick.key, count(brick, needs.get(brick.key)!.scarceRooms !== null));
    }
  }
  /** After a lesson is laid: the bricks it can have taken a start from are counted again. */
  const recountAfter = (lesson: SwapLesson): void => {
    const teachers = new Set([lesson.teacherId, lesson.coTeacherId].filter((id): id is string => id !== null));
    const reach = new Set<string>();
    for (const groupId of [lesson.studentGroupId, ...lesson.extraGroupIds]) for (const other of related!.get(groupId) ?? [groupId]) reach.add(other);
    for (const brick of remaining) {
      const own = needs.get(brick.key)!;
      const touched =
        everyBrickTouched ||
        own.teachers.some((id) => teachers.has(id)) ||
        own.groups.some((id) => reach.has(id)) ||
        (own.scarceRooms !== null && lesson.roomId !== null && own.scarceRooms.has(lesson.roomId));
      if (touched) counts.set(brick.key, count(brick, own.scarceRooms !== null));
    }
  };

  while (remaining.length > 0) {
    if (options.budgetMs !== undefined && now() - began > options.budgetMs) {
      for (const brick of remaining) left.push({ brick, reason: 'TIME', freeStarts: -1 });
      remaining = [];
      break;
    }
    let next: FillBrick;
    if (options.order === 'FEWEST_EXACT') {
      for (const brick of remaining) counts.set(brick.key, count(brick, true));
      next = [...remaining].sort(byCount)[0]!;
    } else if (options.order === 'FEWEST') {
      next = [...remaining].sort(byCount)[0]!;
    } else {
      next = remaining[0]!;
    }

    let probeStart = now();
    const { subject, starts } = freeStartsOf(possible, next, window, options.stepMinutes, points, true);
    stats.probeMs += now() - probeStart;
    remaining = remaining.filter((brick) => brick !== next);

    if (starts.length === 0) {
      // Nothing was laid, so the world is the one that was read: it already has this brick as a lesson that stands nowhere.
      left.push({ brick: next, reason: 'NO_FREE_START', freeStarts: 0 });
      continue;
    }

    probeStart = now();
    let ordered: Array<{ start: Start; costed: CostedStart | null }>;
    if (options.choice === 'EARLIEST') {
      ordered = starts.map((start) => ({ start, costed: null }));
    } else {
      ordered = starts
        .map((start) => ({
          start,
          costed: costOf(possible, subject, { dayOfWeek: start.dayOfWeek, startMinutes: start.startMinutes, rooms: new Map([[next.lesson.id, start.roomId]]), roomChanged: false }),
        }))
        .sort((a, b) => byScore(a.costed!, b.costed!));
    }
    if (options.choice === 'KEEP_OPEN' && options.order === 'FEWEST') {
      const reach = new Set<string>();
      for (const groupId of [next.lesson.studentGroupId, ...next.lesson.extraGroupIds]) for (const other of related!.get(groupId) ?? [groupId]) reach.add(other);
      const mine = needs.get(next.key)!;
      const neighbours = remaining.filter((brick) => {
        const own = needs.get(brick.key)!;
        return own.teachers.some((id) => mine.teachers.includes(id)) || own.groups.some((id) => reach.has(id));
      });
      const weighed = ordered.slice(0, KEEP_OPEN_WIDTH).map((entry, index) => {
        let killed = 0;
        let lost = 0;
        for (const brick of neighbours) {
          const theirs = startsOfBrick.get(brick.key) ?? [];
          if (theirs.length === 0) continue;
          const theirLength = lengthOf(brick);
          const taken = theirs.filter((other) => other.dayOfWeek === entry.start.dayOfWeek && entry.start.startMinutes < other.startMinutes + theirLength && other.startMinutes < entry.start.startMinutes + lengthOf(next));
          if (taken.length === theirs.length) killed += 1;
          lost += taken.length / theirs.length;
        }
        return { entry, index, killed, lost };
      });
      weighed.sort((a, b) => a.killed - b.killed || a.lost - b.lost || a.index - b.index);
      ordered = [...weighed.map((item) => item.entry), ...ordered.slice(KEEP_OPEN_WIDTH)];
    }
    stats.costMs += now() - probeStart;

    let chosen: { start: Start; costed: CostedStart | null; rank: number } | null = null;
    const judgeStart = now();
    const length = lengthOf(next);
    for (let index = 0; index < Math.min(ordered.length, judgeTries); index += 1) {
      const entry = ordered[index]!;
      const accepted = options.judge
        ? await options.judge({ brick: next, dayOfWeek: entry.start.dayOfWeek, startMinutes: entry.start.startMinutes, endMinutes: entry.start.startMinutes + length, roomId: entry.start.roomId })
        : true;
      if (accepted) {
        chosen = { ...entry, rank: index + 1 };
        break;
      }
    }
    stats.judgeMs += now() - judgeStart;

    if (chosen === null) {
      left.push({ brick: next, reason: 'JUDGE', freeStarts: starts.length });
      continue;
    }
    const lesson: SwapLesson = {
      ...next.lesson,
      dayOfWeek: chosen.start.dayOfWeek,
      startMinutes: chosen.start.startMinutes,
      endMinutes: chosen.start.startMinutes + length,
      roomId: chosen.start.roomId,
      isLocked: true,
      isGenerated: false,
    };
    standing.push(lesson);
    const result: FillPlaced = {
      brick: next,
      dayOfWeek: lesson.dayOfWeek,
      startMinutes: lesson.startMinutes,
      endMinutes: lesson.endMinutes,
      roomId: lesson.roomId,
      score: chosen.costed?.score ?? 0,
      costs: chosen.costed?.costs ?? [],
      freeStarts: starts.length,
      rank: chosen.rank,
    };
    placed.push(result);
    options.onPlaced?.(result);
    if (remaining.length > 0) {
      possible = build();
      if (options.order === 'FEWEST') recountAfter(lesson);
    }
  }

  stats.elapsedMs = now() - began;
  return { placed, left, stats };
}
