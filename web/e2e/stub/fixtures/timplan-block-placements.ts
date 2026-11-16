import { uid, KIND } from "../sessions";
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
