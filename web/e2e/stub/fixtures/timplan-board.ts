import { uid, KIND } from "../sessions";
import { Reply } from "../gateway-routes";
import { BLOCK_POST_IDS, blockWeekBoard, isBlockWeekScenario } from "./timplan-block-placements";
import { GROUPS, REQUIREMENTS, ROOMS, SUBJECTS, TEACHERS, YEAR } from "./world";
import type { TeachingRequirement } from "../../../lib/types";
import { placementTimetable } from "./placement-back";
import { HOLDS, PLACEMENT_WARNINGS_SCENARIO, isWarningsScenario, warningsOfRows } from "./timplan-warnings";

/**
 * Förlägg i veckan (GET /teaching-requirements/placements/board), as the
 * gateway answers it.
 *
 * THE WORLD PLACES NOTHING, so by default the board is every post of the year
 * counted with nothing placed and no lesson kept, which is what the page shows
 * in the visual and aria baselines' own world. The week with rows in it is a
 * scenario (x-stub-scenario, e2e/signed-in.ts askForScenario) asked for by the
 * suite that measures it (placement-week.smoke.spec.ts):
 *
 *   Svenska 7A   Anna     Tuesday 10:00–11:00 in NO-salen                 holds
 *   Matematik 7A Bo       Thursday 13:15–14:15                             does NOT hold:
 *                         the teacher has another lesson then
 *   Idrott 7A    David    Friday 17:00–18:00 in Idrottshallen, odd weeks   holds: the day goes to 18:00
 *
 * and one lesson Generera keeps (Matematik 7A, Bo, Monday 08:00–09:00, locked,
 * which answers one of the post's three lessons) and a meal 7A placed by hand
 * on Tuesday 11:00–11:30.
 *
 * Salen är valfri: the second scenario is the same week with a fourth row that
 * names no room (the engine chooses it at every Generera), and the gateway
 * answers it with roomId and roomName null:
 *
 *   Engelska 7A  Anna     Wednesday 09:00–10:00, no room                  holds
 *
 * Förlägg i veckan skriver (A2): the same week, but the stub REMEMBERS what is written to it, per scenario name, which
 * is the one thing the stub does for a write. A scenario that starts with PLACEMENT_WRITE_SCENARIO is a small gateway of
 * its own: it holds Svenska 7A (Tuesday 10:00, NO-salen) and Matematik 7A (Thursday 13:15, does not hold) and the kept
 * lesson and meal above, counts the posts from the rows it holds, gives each post a key (`rowsKey`) that changes with
 * every PUT, and refuses a PUT whose `baseKey` is not the post's key (409 REQUIREMENT_PLACEMENTS_STALE). Give every test
 * its own scenario name (`placement-write:<unique>`), since the suites run side by side against one stub.
 *
 *   placement-write:<id>          takes every write
 *   placement-write-refuse:<id>   refuses every write for the last row (REQUIREMENT_PLACEMENT_REFUSED, TEACHER)
 *   placement-write-stale:<id>    answers the first write of a post with 409 REQUIREMENT_PLACEMENTS_STALE, as if somebody
 *                                 else had written it first, and takes the next (made on top of the key it then reads)
 *
 * Varningar medan man lägger (D1): a scenario that starts with placement-write-warnings is the write scenario with a third row (Idrott 7A, Friday), warnings of every
 * kind on the board and in the answer of a save, and other schools' holds on a teacher and a room (timplan-warnings.ts has them and says which).
 *
 * Förlägg i veckan, the blocks (C2): the board has a `blocks` field (an older gateway has none, and the world's other scenarios keep it empty, so
 * that the baselines of the page do not move). A scenario that starts with placement-block-week is the same kind of small gateway for the world's
 * block "Språkval åk 7" (timplan-block-placements.ts says which scenarios there are): the block, its lessons, its key, and its two posts counted
 * from the lessons it holds; one lesson Generera keeps (Cecilia, Wednesday 10:00–11:00) so that a drop has something to meet.
 */

export const PLACEMENT_WEEK_SCENARIO = "placement-week";
export const PLACEMENT_WEEK_ANY_ROOM_SCENARIO = "placement-week-any-room";
export const PLACEMENT_WRITE_SCENARIO = "placement-write";
export const PLACEMENT_WRITE_REFUSE_SCENARIO = "placement-write-refuse";
export const PLACEMENT_WRITE_STALE_SCENARIO = "placement-write-stale";

/** The key of a post with no rows: the same for every post (the gateway's rowsKeyOf of nothing). */
export const EMPTY_ROWS_KEY = "e3b0c44298fc1c14";
const SEED_ROWS_KEY = "k000000000000007";

const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

const lengthsOf = (post: TeachingRequirement): number[] =>
  (post.lessonLengths ?? []).length > 1
    ? [...(post.lessonLengths ?? [])].sort((a, b) => b - a)
    : Array.from({ length: post.lessonsPerWeek }, () => post.minutesPerLesson);

interface Part {
  teacherId: string | null;
  minutes: number;
  count: number;
  locked: number;
  placed: number;
  left: number;
  cannotPlace: "NO_TEACHER" | null;
}

/** A post counted by length, `locked` and `placed` lessons of it answered. */
function partsOf(post: TeachingRequirement, answered: { locked?: number; placed?: number } = {}): Part[] {
  const byLength = new Map<number, number>();
  for (const minutes of lengthsOf(post)) byLength.set(minutes, (byLength.get(minutes) ?? 0) + 1);
  return [...byLength].map(([minutes, count]) => {
    const locked = answered.locked ?? 0;
    const placed = answered.placed ?? 0;
    return { teacherId: post.teacherId, minutes, count, locked, placed, left: count - locked - placed, cannotPlace: null };
  });
}

const post = (n: number) => REQUIREMENTS.find((entry) => entry.id === uid(KIND.requirement, n))!;

const row = (n: number, requirementId: string, day: number, start: number, minutes: number, roomId: string | null, over: Record<string, unknown> = {}) => ({
  id: uid(KIND.misc, 800 + n),
  requirementId,
  dayOfWeek: day,
  startTime: clock(start),
  endTime: clock(start + minutes),
  minutes,
  roomId,
  roomName: roomId === null ? null : (Object.values(ROOMS).find((entry) => entry.id === roomId)?.name ?? ""),
  recurrence: "ALL_WEEKS",
  teacherId: null,
  changedAt: "2026-11-13T08:00:00.000Z",
  verdict: { ok: true },
  ...over,
});

/** The three rows of the scenario. */
const WEEK_ROWS = [
  row(1, post(1).id, 2, 10 * 60, 60, ROOMS.lab.id),
  row(2, post(2).id, 4, 13 * 60 + 15, 60, ROOMS.r101.id, {
    verdict: {
      ok: false,
      reason: "TEACHER",
      params: { otherKind: "LESSON", className: "7B", subjectName: "Matematik", day: 4, start: "13:00", end: "14:00" },
    },
  }),
  row(3, post(4).id, 5, 17 * 60, 60, ROOMS.gym.id, { recurrence: "ODD_WEEKS", changedAt: "2026-11-13T08:10:00.000Z" }),
];

/** The fourth row of the second scenario: a förläggning that leaves the room to the engine. */
const ANY_ROOM_ROW = row(4, post(3).id, 3, 9 * 60, 60, null, { changedAt: "2026-11-13T08:20:00.000Z" });

const isWriteScenario = (scenario: string | null): scenario is string => scenario !== null && scenario.startsWith(PLACEMENT_WRITE_SCENARIO);

type Row = ReturnType<typeof row>;

interface Written {
  rows: Row[];
  keys: Map<string, string>;
  counter: number;
  staleOnce: boolean;
}

/** What the stub remembers of the write scenarios, by scenario name. */
const written = new Map<string, Written>();

function writtenOf(scenario: string): Written {
  let state = written.get(scenario);
  if (!state) {
    const warned = scenario.startsWith(PLACEMENT_WARNINGS_SCENARIO);
    state = {
      // The warnings scenario also holds Idrott 7A's Friday row, which has the room-less warnings of its own.
      rows: warned ? [...WEEK_ROWS] : [WEEK_ROWS[0]!, WEEK_ROWS[1]!],
      keys: new Map([
        [post(1).id, "k000000000000001"],
        [post(2).id, "k000000000000002"],
        ...(warned ? ([[post(4).id, "k000000000000003"]] as const) : []),
      ]),
      counter: 0,
      staleOnce: scenario.startsWith(PLACEMENT_WRITE_STALE_SCENARIO),
    };
    written.set(scenario, state);
  }
  return state;
}

/** Lessons the rows place: a pair of halves on an every-week post is ONE lesson, a lone half none (placement-fit.ts). */
function placedByRows(entry: TeachingRequirement, rows: readonly Row[]): number {
  const own = rows.filter((candidate) => candidate.requirementId === entry.id);
  const whole = own.filter((candidate) => candidate.recurrence === "ALL_WEEKS").length;
  const odd = own.filter((candidate) => candidate.recurrence === "ODD_WEEKS").length;
  const even = own.filter((candidate) => candidate.recurrence === "EVEN_WEEKS").length;
  return entry.recurrence === "ALL_WEEKS" ? whole + Math.min(odd, even) : whole + odd + even;
}

/** The year's board, for the year the world has and for any other (which has no post). */
export function boardOfYear(yearId: string, scenario: string | null) {
  const board = yearId === YEAR.id && isBlockWeekScenario(scenario) ? blockWeekOfYear(yearId, scenario) : plainBoardOfYear(yearId, scenario);
  // What the fixed week says of each row, and the other schools' hold: only in the scenario that has them, so that the page's other baselines are what they were.
  return yearId === YEAR.id && isWarningsScenario(scenario) ? { ...board, warnings: warningsOfRows(board.placements), holds: HOLDS } : board;
}

function plainBoardOfYear(yearId: string, scenario: string | null) {
  const anyRoom = scenario === PLACEMENT_WEEK_ANY_ROOM_SCENARIO && yearId === YEAR.id;
  const remembered = yearId === YEAR.id && isWriteScenario(scenario) ? writtenOf(scenario) : null;
  const week = remembered !== null || ((scenario === PLACEMENT_WEEK_SCENARIO || anyRoom) && yearId === YEAR.id);
  const posts = yearId === YEAR.id ? REQUIREMENTS.filter((entry) => entry.academicYearId === yearId) : [];
  return {
    academicYearId: yearId,
    timetable: placementTimetable(yearId, scenario),
    placements: remembered ? remembered.rows : week ? (anyRoom ? [...WEEK_ROWS, ANY_ROOM_ROW] : WEEK_ROWS) : [],
    posts: posts.map((entry) => ({
      id: entry.id,
      studentGroupId: entry.studentGroupId,
      subjectId: entry.subjectId,
      teacherId: entry.teacherId,
      coTeacherId: entry.coTeacherId ?? null,
      recurrence: entry.recurrence,
      startDate: entry.startDate,
      endDate: entry.endDate,
      // The pupils' ombyte and dusch around the post's lessons (Idrott 7A has ten before and fifteen after): the gateway's own figures.
      minutesBefore: entry.minutesBefore,
      minutesAfter: entry.minutesAfter,
      cannotPlace: entry.blockId ? "BLOCK" : null,
      parts: partsOf(
        entry,
        remembered
          ? { locked: entry.id === post(2).id ? 1 : 0, placed: placedByRows(entry, remembered.rows) }
          : week
            ? answeredOf(entry.id, anyRoom)
            : {},
      ),
      rowsKey: remembered ? (remembered.keys.get(entry.id) ?? EMPTY_ROWS_KEY) : week && answeredOf(entry.id, anyRoom).placed ? SEED_ROWS_KEY : EMPTY_ROWS_KEY,
    })),
    kept: week
      ? [
          {
            id: uid(KIND.masterLesson, 800),
            dayOfWeek: 1,
            startTime: "08:00",
            endTime: "09:00",
            studentGroupId: post(2).studentGroupId,
            extraGroupIds: [],
            subjectId: SUBJECTS.ma.id,
            teacherId: TEACHERS.bo.id,
            coTeacherId: null,
            roomId: ROOMS.r102.id,
            recurrence: "ALL_WEEKS",
            startDate: null,
            endDate: null,
            locked: true,
            generated: false,
          },
        ]
      : [],
    meals: week
      ? [
          {
            id: uid(KIND.misc, 850),
            studentGroupId: post(2).studentGroupId,
            dayOfWeek: 2,
            startTime: "11:00",
            endTime: "11:30",
            startDate: null,
            endDate: null,
          },
        ]
      : [],
    // The world's other scenarios keep the blocks off the board, so that the page's baselines are what they were.
    blocks: [] as ReturnType<typeof blockWeekBoard>["blocks"],
  };
}

/**
 * The board of a block-week scenario: the year's posts counted with nothing placed of their own, the block with the lessons the scenario holds, its two
 * posts' parts counted from those lessons (a lesson of the block answers one lesson of each post, of its length), and one lesson Generera keeps: Cecilia's,
 * on Wednesday 10:00–11:00, which a drop of the block's lesson there meets.
 */
function blockWeekOfYear(yearId: string, scenario: string) {
  const base = plainBoardOfYear(yearId, null);
  const { blocks, rows } = blockWeekBoard(scenario);
  const members = new Set(BLOCK_POST_IDS.slice(0, 2));
  return {
    ...base,
    posts: base.posts.map((entry) =>
      members.has(entry.id)
        ? {
            ...entry,
            parts: entry.parts.map((part) => {
              const placed = rows.filter((lesson) => lesson.minutes === part.minutes).length;
              return { ...part, placed, left: Math.max(0, part.count - placed) };
            }),
          }
        : entry,
    ),
    kept: [
      {
        id: uid(KIND.masterLesson, 801),
        dayOfWeek: 3,
        startTime: "10:00",
        endTime: "11:00",
        studentGroupId: GROUPS.g7B.id,
        extraGroupIds: [],
        subjectId: SUBJECTS.ma.id,
        teacherId: TEACHERS.cecilia.id,
        coTeacherId: null,
        roomId: ROOMS.r102.id,
        recurrence: "ALL_WEEKS",
        startDate: null,
        endDate: null,
        locked: true,
        generated: false,
      },
    ],
    blocks,
  };
}

const nextKey = (state: Written): string => `k9${String(++state.counter).padStart(14, "0")}`;

/**
 * PUT /teaching-requirements/:id/placements in a write scenario: the post's list replaced with new row ids and a new
 * key, as the gateway does, and a `baseKey` that is not the post's key refused with 409 REQUIREMENT_PLACEMENTS_STALE.
 */
export function writePlacements(requirementId: string, body: unknown, scenario: string) {
  const state = writtenOf(scenario);
  const { placements: sent = [], baseKey } = (body ?? {}) as { placements?: Record<string, unknown>[]; baseKey?: string };
  const stale = () =>
    new Reply(409, {
      statusCode: 409,
      code: "REQUIREMENT_PLACEMENTS_STALE",
      message: "Postens förläggningar har ändrats sedan du läste dem. Läs om dem och försök igen.",
      params: { requirementId },
    });
  if (scenario.startsWith(PLACEMENT_WRITE_REFUSE_SCENARIO)) {
    return new Reply(409, {
      statusCode: 409,
      code: "REQUIREMENT_PLACEMENT_REFUSED",
      message: "Förläggning: Läraren har redan en annan lektion.",
      params: { index: Math.max(0, sent.length - 1), reason: "TEACHER", otherKind: "LESSON", className: "7B", subjectName: "Matematik", day: 3, start: "10:00", end: "11:00" },
    });
  }
  const current = state.keys.get(requirementId) ?? EMPTY_ROWS_KEY;
  if (state.staleOnce) {
    // Somebody else wrote the post first: its key is another now, and the page that read the old one is refused.
    state.staleOnce = false;
    state.keys.set(requirementId, nextKey(state));
    return stale();
  }
  if (baseKey !== undefined && baseKey !== current) return stale();
  const rows = sent.map((input, index) => {
    const startTime = String(input["startTime"]);
    const minutes = Number(input["minutes"]);
    const end = Number(startTime.slice(0, 2)) * 60 + Number(startTime.slice(3, 5)) + minutes;
    const roomId = (input["roomId"] as string | null | undefined) ?? null;
    return row(100 + state.counter * 10 + index, requirementId, Number(input["dayOfWeek"]), end - minutes, minutes, roomId, {
      recurrence: input["recurrence"] ?? "ALL_WEEKS",
      teacherId: (input["teacherId"] as string | undefined) ?? null,
      changedAt: new Date().toISOString(),
    });
  });
  state.rows = [...state.rows.filter((entry) => entry.requirementId !== requirementId), ...rows];
  const key = nextKey(state);
  state.keys.set(requirementId, key);
  return {
    placements: rows,
    verdicts: rows.map((_, index) => ({ index, ok: true })),
    rowsKey: key,
    // What the week says of the rows just written, by their new ids (the scenario with warnings only: an older gateway answers none).
    ...(isWarningsScenario(scenario) ? { warnings: warningsOfRows(rows) } : {}),
  };
}

/** What answers the scenario's posts: the row that places one lesson, the kept lesson that covers another. */
function answeredOf(requirementId: string, anyRoom = false): { locked?: number; placed?: number } {
  if (requirementId === post(1).id) return { placed: 1 };
  if (anyRoom && requirementId === post(3).id) return { placed: 1 };
  if (requirementId === post(2).id) return { placed: 1, locked: 1 };
  if (requirementId === post(4).id) return { placed: 1 };
  return {};
}

/**
 * The latest schedule (GET /teaching-requirements/placements/latest): what the last Generera laid and nobody has taken over, which "Visa
 * senaste schemat" draws behind the week. Four lessons of 7A and one of 7B: a Monday lesson and a Wednesday one in a free hour, one on
 * Tuesday 10:00 where the scenario places Svenska 7A (the förläggning stands on it, which is allowed: nothing is judged against a lesson the
 * next Generera replaces), and two parallel at Thursday 08:00 so that the layer lays two side by side. The world's kept lessons are not here:
 * they are the week's own.
 */
export function latestOfYear(academicYearId: string) {
  const lesson = (index: number, over: Record<string, unknown>) => ({
    id: uid(KIND.masterLesson, 900 + index),
    extraGroupIds: [],
    coTeacherId: null,
    recurrence: "ALL_WEEKS",
    startDate: null,
    endDate: null,
    locked: false,
    generated: true,
    ...over,
  });
  const base = { studentGroupId: GROUPS.g7A.id, roomId: ROOMS.r102.id };
  return {
    academicYearId,
    lessons: [
      lesson(1, { ...base, dayOfWeek: 1, startTime: "09:15", endTime: "10:15", subjectId: SUBJECTS.ma.id, teacherId: TEACHERS.bo.id }),
      lesson(2, { ...base, dayOfWeek: 2, startTime: "10:00", endTime: "11:00", subjectId: SUBJECTS.sv.id, teacherId: TEACHERS.anna.id }),
      lesson(3, { ...base, dayOfWeek: 3, startTime: "13:00", endTime: "14:00", subjectId: SUBJECTS.ma.id, teacherId: TEACHERS.bo.id }),
      lesson(4, { ...base, dayOfWeek: 4, startTime: "08:00", endTime: "09:00", subjectId: SUBJECTS.sv.id, teacherId: TEACHERS.anna.id }),
      lesson(5, { ...base, dayOfWeek: 4, startTime: "08:00", endTime: "09:00", subjectId: SUBJECTS.ma.id, teacherId: TEACHERS.bo.id, extraGroupIds: [GROUPS.g7B.id] }),
      lesson(6, { ...base, studentGroupId: GROUPS.g7B.id, dayOfWeek: 5, startTime: "10:00", endTime: "11:00", subjectId: SUBJECTS.ma.id, teacherId: TEACHERS.bo.id }),
    ],
  };
}
