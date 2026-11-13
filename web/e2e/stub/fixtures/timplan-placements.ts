import { uid, KIND } from "../sessions";
import { REQUIREMENTS, ROOMS, TEACHERS } from "./world";

/**
 * Förlägg on a post that shares its lessons between teachers (Delade
 * lektioner), as the gateway answers it.
 *
 * THE WORLD PLACES NOTHING AND SHARES NOTHING, and no suite but one wants it
 * to: a share is a mark in the timplan's cells and a placement another, and the
 * visual and aria baselines hold those cells. So the shared post is a
 * scenario (x-stub-scenario, e2e/signed-in.ts askForScenario), asked for by the
 * suite that places its lessons (requirement-placements-shared.smoke.spec.ts),
 * and every other read answers none, as before.
 *
 * The post is Biologi för 7A (REQUIREMENTS 5: two lessons à 60, Cecilia), which
 * the suite makes four lessons of two lengths in what the browser is answered
 * (the world's row is left as it is; PostgREST knows no scenario):
 *
 *   Cecilia   1 × 60            the post's huvudlärare, who takes what no share takes
 *   Bo        1 × 60 and 1 × 40
 *   nobody    1 × 60            a share whose teacher was deleted since
 *
 * Two lessons are placed: Cecilia's on Tuesday and Bo's of 40 minutes on
 * Thursday, both every week. (A pair of odd and even weeks per teacher is the
 * dialog's component test's: components/timplan/placement-dialog.test.tsx.)
 */

export const SHARED_PLACEMENTS_SCENARIO = "shared-placements";

/** The post and what the suite makes of it in the browser's read of the table. */
export const SHARED_POST = REQUIREMENTS.find((row) => row.id === uid(KIND.requirement, 5))!;
export const SHARED_POST_SHAPE = {
  lessonsPerWeek: 4,
  minutesPerLesson: 60,
  lessonLengths: [60, 60, 60, 40],
} as const;

/** The post's shares, as GET /teaching-requirements/shares answers them. */
export const SHARED_POST_SHARES = [
  { requirementId: SHARED_POST.id, teacherId: TEACHERS.bo.id, lessons: 1, minutes: 60 },
  { requirementId: SHARED_POST.id, teacherId: TEACHERS.bo.id, lessons: 1, minutes: 40 },
  { requirementId: SHARED_POST.id, teacherId: null, lessons: 1, minutes: 60 },
];

interface Placed {
  id: string;
  requirementId: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  minutes: number;
  roomId: string;
  roomName: string;
  recurrence: "ALL_WEEKS" | "ODD_WEEKS" | "EVEN_WEEKS";
  teacherId: string | null;
}

const clock = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

const roomNameOf = (roomId: string) => Object.values(ROOMS).find((room) => room.id === roomId)?.name ?? "";

/** One row as the gateway answers it, from the fields a PUT takes. */
function placed(index: number, requirementId: string, input: Record<string, unknown>): Placed {
  const minutes = Number(input.minutes);
  const [hours = 0, mins = 0] = String(input.startTime).split(":").map(Number);
  return {
    id: uid(KIND.misc, 700 + index),
    requirementId,
    dayOfWeek: Number(input.dayOfWeek),
    startTime: String(input.startTime),
    endTime: clock(hours * 60 + mins + minutes),
    minutes,
    roomId: String(input.roomId),
    roomName: roomNameOf(String(input.roomId)),
    recurrence: input.recurrence as Placed["recurrence"],
    // A post that shares nothing is placed without a teacher, and answers none.
    teacherId: typeof input.teacherId === "string" ? input.teacherId : null,
  };
}

/** The shared post's two placed lessons, in the order the gateway answers them (day, then start). */
const SHARED_POST_PLACED: Placed[] = [
  placed(1, SHARED_POST.id, {
    dayOfWeek: 2,
    startTime: "10:00",
    minutes: 60,
    roomId: ROOMS.lab.id,
    recurrence: "ALL_WEEKS",
    teacherId: SHARED_POST.teacherId,
  }),
  placed(2, SHARED_POST.id, {
    dayOfWeek: 4,
    startTime: "13:15",
    minutes: 40,
    roomId: ROOMS.r101.id,
    recurrence: "ALL_WEEKS",
    teacherId: TEACHERS.bo.id,
  }),
];

/** The year's placed lessons (GET /teaching-requirements/placements). */
export const placedInYear = (scenario: string | null): Placed[] =>
  scenario === SHARED_PLACEMENTS_SCENARIO ? SHARED_POST_PLACED : [];

/** One post's rows with a verdict for each, all holding (GET /teaching-requirements/:id/placements). */
export function placedOf(requirementId: string, scenario: string | null) {
  const rows = placedInYear(scenario).filter((row) => row.requirementId === requirementId);
  return { placements: rows, verdicts: rows.map((_, index) => ({ index, ok: true })) };
}

/** What a PUT stores: the rows it was sent, as the gateway answers them. */
export function placementsStored(requirementId: string, body: unknown) {
  const sent = (body as { placements?: Record<string, unknown>[] } | undefined)?.placements ?? [];
  const rows = sent.map((input, index) => placed(index + 1, requirementId, input));
  return { placements: rows, verdicts: rows.map((_, index) => ({ index, ok: true })) };
}
