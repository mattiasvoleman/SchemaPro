import { uid, KIND } from "../sessions";
import { Reply } from "../gateway-routes";
import type { TeachingRequirement } from "../../../lib/types";
import { BLOCKS, GROUPS, ROOMS, SUBJECTS, TEACHERS, YEAR } from "./world";

/**
 * Förlägg blocket (a parallel block's lessons placed before Generera), as the gateway answers it:
 * GET and PUT /teaching-blocks/:id/placements.
 *
 * THE WORLD'S BLOCK, "Språkval åk 7", HAS TWO POSTS (Moderna språk spanska 7–9 and franska 7: two lessons a week, one of 60
 * minutes and one of 40), and the world places nothing. The dialog is shown with THREE posts, so the suite adds a third to what
 * the browser reads of the table (THIRD_POST: Moderna språk för 7B, which Spanska and Franska share a block with) in the same way
 * as requirement-placements-shared.smoke.spec.ts shapes its post: PostgREST knows no scenario, the world's rows are left as they
 * are, and the baselines that hold the matrix are not moved.
 *
 * What the gateway answers for the block, by the scenario the page asked for (x-stub-scenario, e2e/signed-in.ts askForScenario):
 *
 *   BLOCK_PLACEMENTS_SCENARIO            one lesson placed, Tuesday 10:00–11:00, with a room of its own for the first and the
 *                                        second post and none for the third; every verdict holds.
 *   BLOCK_PLACEMENTS_VERDICTS_SCENARIO   two lessons placed (the same first, and Thursday 13:15–13:55); the second does not hold:
 *                                        the first two posts' class is at lunch (said together, once) and the third post's teacher
 *                                        teaches Matematik with 7B then.
 *   BLOCK_PLACEMENTS_STALE_SCENARIO      as the first; a save is refused (BLOCK_PLACEMENTS_STALE): the block has changed.
 *   (no scenario)                        nothing placed.
 *
 * A PUT is stored as sent, every verdict holding, except for a lesson on Monday at 10:00, which clashes with a lesson the third
 * post's teacher has (BLOCK_PLACEMENT_REFUSED, naming the post, lesson by its place in the list). A save is answered with the key
 * it was made on kept: the stub keeps nothing between requests, as it keeps no other write.
 *
 * Förlägg i veckan, the blocks (C2): the week's page writes a block's lessons and reads them again from the board, so a scenario that starts
 * with BLOCK_WEEK_SCENARIO is a small gateway of its own, which REMEMBERS what is written to it, per scenario name (the one thing the stub does for
 * a write, as placement-write does for a post). It holds the world's block "Språkval åk 7" (its two posts, one lesson of 60 minutes and one of 40
 * a week), keeps the lessons in (day, start) order and gives every list a new key, and refuses a PUT whose `baseKey` is not the block's key
 * (409 BLOCK_PLACEMENTS_STALE). Give every test its own scenario name (`placement-block-week:<unique>`): the suites run side by side against one stub.
 *
 *   placement-block-week:<id>           nothing placed; takes every write
 *   placement-block-week-red:<id>       two lessons placed, Tuesday 10:00 (60 min, a room for the first post) and Thursday 13:15 (40 min), which
 *                                       does not hold for the second post (its teacher teaches Matematik with 7B then); takes every write, and a
 *                                       lesson that stands where it did keeps its verdict
 *   placement-block-week-follower:<id>  the block takes another block's times: it cannot be placed by hand, and says whose
 *   placement-block-week-stale:<id>     the first write is answered 409 BLOCK_PLACEMENTS_STALE, as if somebody had written first, and the next is taken
 *                                       (made on top of the key the week then reads)
 *   placement-block-week-refuse:<id>    every write is refused for its last lesson (BLOCK_PLACEMENT_REFUSED, TEACHER, the second post)
 */

export const BLOCK_PLACEMENTS_SCENARIO = "block-placements";
export const BLOCK_PLACEMENTS_VERDICTS_SCENARIO = "block-placements-verdicts";
export const BLOCK_PLACEMENTS_STALE_SCENARIO = "block-placements-stale";

/** The block the world has, and its two posts. */
export const BLOCK = BLOCKS[0]!;

/** The third post of the block, added to the browser's read of the table by the suite: a class's, not a teaching group's. */
export const THIRD_POST: TeachingRequirement = {
  id: uid(KIND.requirement, 14),
  academicYearId: YEAR.id,
  subjectId: SUBJECTS.m2.id,
  studentGroupId: GROUPS.g7B.id,
  teacherId: TEACHERS.david.id,
  coTeacherId: null,
  lessonsPerWeek: 2,
  minutesPerLesson: 60,
  lessonLengths: [60, 40],
  minutesBefore: 0,
  minutesAfter: 0,
  teacherLoadPercent: 100,
  coTeacherLoadPercent: 100,
  ownDistribution: false,
  maxLessonsPerDay: null,
  minDaysBetween: null,
  recurrence: "ALL_WEEKS",
  startDate: null,
  endDate: null,
  blockId: BLOCK.id,
};

/** The block's posts by id, as the gateway judges them: the world's two (requirements 11 and 13) and the third. */
export const BLOCK_POST_IDS = [uid(KIND.requirement, 11), uid(KIND.requirement, 13), THIRD_POST.id];

/** The block's lesson lengths, longest first, one per lesson. */
const LENGTHS = [60, 40];

interface BlockRoom {
  requirementId: string;
  roomId: string;
  roomName: string;
}

interface BlockLesson {
  id: string;
  blockId: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  minutes: number;
  recurrence: "ALL_WEEKS";
  rooms: BlockRoom[];
}

const clock = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

const roomNameOf = (roomId: string) => Object.values(ROOMS).find((room) => room.id === roomId)?.name ?? "";

function lesson(n: number, input: { dayOfWeek: number; startTime: string; minutes: number; rooms?: { requirementId: string; roomId: string }[] }): BlockLesson {
  const [hours = 0, mins = 0] = input.startTime.split(":").map(Number);
  return {
    id: uid(KIND.misc, 7100 + n),
    blockId: BLOCK.id,
    dayOfWeek: input.dayOfWeek,
    startTime: input.startTime,
    endTime: clock(hours * 60 + mins + input.minutes),
    minutes: input.minutes,
    recurrence: "ALL_WEEKS",
    rooms: (input.rooms ?? []).map((room) => ({ ...room, roomName: roomNameOf(room.roomId) })),
  };
}

const TUESDAY = lesson(1, {
  dayOfWeek: 2,
  startTime: "10:00",
  minutes: 60,
  rooms: [
    { requirementId: BLOCK_POST_IDS[0]!, roomId: ROOMS.r101.id },
    { requirementId: BLOCK_POST_IDS[1]!, roomId: ROOMS.lab.id },
  ],
});
const THURSDAY = lesson(2, { dayOfWeek: 4, startTime: "13:15", minutes: 40 });

const placedIn = (scenario: string | null): BlockLesson[] =>
  scenario === BLOCK_PLACEMENTS_VERDICTS_SCENARIO ? [TUESDAY, THURSDAY] : scenario === BLOCK_PLACEMENTS_SCENARIO || scenario === BLOCK_PLACEMENTS_STALE_SCENARIO ? [TUESDAY] : [];

/** The key a read carries, which a save answers with when nothing has changed. */
export const ROWS_KEY = "00000000000000000000000000000001";

/** One verdict per lesson and post, in lesson order and, within a lesson, in the posts' order. */
function verdictsOf(rows: readonly BlockLesson[], scenario: string | null) {
  return rows.flatMap((row, index) =>
    BLOCK_POST_IDS.map((requirementId) => {
      if (scenario === BLOCK_PLACEMENTS_VERDICTS_SCENARIO && row === THURSDAY) {
        if (requirementId === THIRD_POST.id) {
          return {
            index,
            requirementId,
            ok: false,
            reason: "TEACHER",
            params: { otherKind: "LESSON", className: "7B", subjectName: "Matematik", day: 4, start: "13:00", end: "14:00" },
          };
        }
        return { index, requirementId, ok: false, reason: "LUNCH" };
      }
      return { index, requirementId, ok: true };
    }),
  );
}

/** GET /teaching-blocks/:id/placements. */
export function blockPlacementsOf(scenario: string | null) {
  const rows = placedIn(scenario);
  return { placements: rows, verdicts: verdictsOf(rows, scenario), rowsKey: ROWS_KEY, lengths: LENGTHS };
}

/** PUT /teaching-blocks/:id/placements: the status and the body the gateway answers with. */
export function blockPlacementsStored(body: unknown, scenario: string | null): { status: number; body: unknown } {
  if (scenario === BLOCK_PLACEMENTS_STALE_SCENARIO) {
    return {
      status: 409,
      body: {
        statusCode: 409,
        message: "Blockets förläggningar har ändrats sedan du läste dem. Läs om blocket och gör om ändringen.",
        code: "BLOCK_PLACEMENTS_STALE",
      },
    };
  }
  const sent = (body as { placements?: { dayOfWeek: number; startTime: string; minutes: number; rooms?: { requirementId: string; roomId: string }[] }[] } | undefined)?.placements ?? [];
  const clashAt = sent.findIndex((input) => input.dayOfWeek === 1 && input.startTime === "10:00");
  if (clashAt >= 0) {
    return {
      status: 409,
      body: {
        statusCode: 409,
        message: `Förläggning ${clashAt + 1}: Läraren har redan Matematik 7B måndag 10:00–11:00.`,
        code: "BLOCK_PLACEMENT_REFUSED",
        params: {
          index: clashAt,
          requirementId: THIRD_POST.id,
          reason: "TEACHER",
          otherKind: "LESSON",
          className: "7B",
          subjectName: "Matematik",
          day: 1,
          start: "10:00",
          end: "11:00",
        },
      },
    };
  }
  const rows = sent.map((input, index) => lesson(10 + index, input));
  return { status: 200, body: { placements: rows, verdicts: verdictsOf(rows, null), rowsKey: ROWS_KEY, lengths: LENGTHS } };
}

// ---------------------------------------------------------------- the week's page (C2)

export const BLOCK_WEEK_SCENARIO = "placement-block-week";
export const BLOCK_WEEK_RED_SCENARIO = "placement-block-week-red";
export const BLOCK_WEEK_FOLLOWER_SCENARIO = "placement-block-week-follower";
export const BLOCK_WEEK_STALE_SCENARIO = "placement-block-week-stale";
export const BLOCK_WEEK_REFUSE_SCENARIO = "placement-block-week-refuse";

/** The block a follower scenario says the world's block follows: another block, with no post. */
export const LEADER_BLOCK_ID = uid(KIND.misc, 6002);

export const isBlockWeekScenario = (scenario: string | null): scenario is string => scenario !== null && scenario.startsWith(BLOCK_WEEK_SCENARIO);

interface BlockWeekState {
  rows: BlockLesson[];
  counter: number;
  key: string;
  staleOnce: boolean;
}

const weekState = new Map<string, BlockWeekState>();
const keyOf = (n: number): string => String(n).padStart(32, "0");

const weekStateOf = (scenario: string): BlockWeekState => {
  let state = weekState.get(scenario);
  if (!state) {
    state = {
      rows: scenario.startsWith(BLOCK_WEEK_RED_SCENARIO) ? [TUESDAY, THURSDAY] : [],
      counter: 1,
      key: keyOf(1),
      staleOnce: scenario.startsWith(BLOCK_WEEK_STALE_SCENARIO),
    };
    weekState.set(scenario, state);
  }
  return state;
};

/** Whether the stub holds a lesson as one that does not hold: Thursday 13:15 in the red scenario, wherever the list puts it, as long as it is there. */
const isRed = (scenario: string, row: Pick<BlockLesson, "dayOfWeek" | "startTime">): boolean =>
  scenario.startsWith(BLOCK_WEEK_RED_SCENARIO) && row.dayOfWeek === 4 && row.startTime === "13:15";

const CLASH = { otherKind: "LESSON", className: "7B", subjectName: "Matematik", day: 4, start: "13:00", end: "14:00" };

/** One verdict per lesson and post: the second post fails on the red lesson (the first holds; said once, with the reason). */
function weekVerdictsOf(rows: readonly BlockLesson[], scenario: string) {
  return rows.flatMap((row, index) =>
    BLOCK_POST_IDS.slice(0, 2).map((requirementId, at) =>
      isRed(scenario, row) && at === 1 ? { index, requirementId, ok: false, reason: "TEACHER", params: CLASH } : { index, requirementId, ok: true },
    ),
  );
}

/** What the board says of the world's block in a block-week scenario (timplan-board.ts): the block with its lessons, a verdict for each post, and its key. */
export function blockWeekBoard(scenario: string) {
  const state = weekStateOf(scenario);
  const follower = scenario.startsWith(BLOCK_WEEK_FOLLOWER_SCENARIO);
  const rows = state.rows.map((row, index) => ({
    id: row.id,
    dayOfWeek: row.dayOfWeek,
    startTime: row.startTime,
    endTime: row.endTime,
    minutes: row.minutes,
    recurrence: row.recurrence,
    rooms: row.rooms,
    changedAt: "2026-11-13T08:00:00.000Z",
    verdicts: weekVerdictsOf([row], scenario).map((verdict) => ({ requirementId: verdict.requirementId, ok: verdict.ok, ...(verdict.ok ? {} : { reason: verdict.reason, params: verdict.params }) })),
    index,
  }));
  const blocks = [
    {
      id: BLOCK.id,
      name: BLOCK.name,
      // The members that are the world's own: the block's lessons are theirs two and two.
      memberIds: [...BLOCK_POST_IDS.slice(0, 2)].sort(),
      lengths: LENGTHS,
      recurrence: "ALL_WEEKS",
      followsBlockId: follower ? LEADER_BLOCK_ID : null,
      cannotPlace: follower ? "FOLLOWER" : null,
      rows: rows.map(({ index: _index, ...row }) => row),
      rowsKey: state.key,
    },
    ...(follower
      ? [{ id: LEADER_BLOCK_ID, name: "Ledarblocket", memberIds: [], lengths: [], recurrence: null, followsBlockId: null, cannotPlace: "EMPTY", rows: [], rowsKey: keyOf(0) }]
      : []),
  ];
  return { blocks, rows: state.rows };
}

/** GET /teaching-blocks/:id/placements in a block-week scenario: what the dialog on Timplansposter reads, from what the week wrote. */
export function blockWeekRead(scenario: string) {
  const state = weekStateOf(scenario);
  return { placements: state.rows, verdicts: weekVerdictsOf(state.rows, scenario), rowsKey: state.key, lengths: LENGTHS };
}

/**
 * PUT /teaching-blocks/:id/placements in a block-week scenario: the list replaced with new ids in (day, start) order and a new key, as the gateway does,
 * a `baseKey` that is not the block's key refused (409 BLOCK_PLACEMENTS_STALE), and the scenarios' own refusals.
 */
export function blockWeekWrite(body: unknown, scenario: string): Reply | { placements: BlockLesson[]; verdicts: ReturnType<typeof weekVerdictsOf>; rowsKey: string; lengths: number[] } {
  const state = weekStateOf(scenario);
  const { placements: sent = [], baseKey } = (body ?? {}) as { placements?: { dayOfWeek: number; startTime: string; minutes: number; rooms?: { requirementId: string; roomId: string }[] }[]; baseKey?: string };
  const stale = () =>
    new Reply(409, {
      statusCode: 409,
      code: "BLOCK_PLACEMENTS_STALE",
      message: "Blockets förläggningar har ändrats sedan du läste dem. Läs om blocket och gör om ändringen.",
    });
  if (scenario.startsWith(BLOCK_WEEK_REFUSE_SCENARIO)) {
    return new Reply(409, {
      statusCode: 409,
      code: "BLOCK_PLACEMENT_REFUSED",
      message: "Förläggning: Läraren har redan en annan lektion.",
      params: { index: Math.max(0, sent.length - 1), requirementId: BLOCK_POST_IDS[1]!, reason: "TEACHER", ...CLASH },
    });
  }
  if (state.staleOnce) {
    // Somebody else wrote the block first: its key is another now, and the page that read the old one is refused.
    state.staleOnce = false;
    state.key = keyOf(++state.counter);
    return stale();
  }
  if (baseKey !== undefined && baseKey !== state.key) return stale();
  const ordered = [...sent].sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startTime.localeCompare(b.startTime));
  const rows = ordered.map((input, index) => lesson(100 + state.counter * 10 + index, { ...input, rooms: input.rooms ?? [] }));
  state.rows = rows;
  state.key = keyOf(++state.counter);
  return { placements: rows, verdicts: weekVerdictsOf(rows, scenario), rowsKey: state.key, lengths: LENGTHS };
}
