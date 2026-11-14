import { uid, KIND } from "../sessions";
import { REQUIREMENTS, ROOMS, SUBJECTS, TEACHERS, YEAR } from "./world";
import type { TeachingRequirement } from "../../../lib/types";

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
 */

export const PLACEMENT_WEEK_SCENARIO = "placement-week";

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

const row = (n: number, requirementId: string, day: number, start: number, minutes: number, roomId: string, over: Record<string, unknown> = {}) => ({
  id: uid(KIND.misc, 800 + n),
  requirementId,
  dayOfWeek: day,
  startTime: clock(start),
  endTime: clock(start + minutes),
  minutes,
  roomId,
  roomName: Object.values(ROOMS).find((entry) => entry.id === roomId)?.name ?? "",
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

/** The year's board, for the year the world has and for any other (which has no post). */
export function boardOfYear(yearId: string, scenario: string | null) {
  const week = scenario === PLACEMENT_WEEK_SCENARIO && yearId === YEAR.id;
  const posts = yearId === YEAR.id ? REQUIREMENTS.filter((entry) => entry.academicYearId === yearId) : [];
  return {
    academicYearId: yearId,
    placements: week ? WEEK_ROWS : [],
    posts: posts.map((entry) => ({
      id: entry.id,
      studentGroupId: entry.studentGroupId,
      subjectId: entry.subjectId,
      teacherId: entry.teacherId,
      recurrence: entry.recurrence,
      startDate: entry.startDate,
      endDate: entry.endDate,
      cannotPlace: entry.blockId ? "BLOCK" : null,
      parts: partsOf(entry, week ? answeredOf(entry.id) : {}),
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
  };
}

/** What answers the scenario's posts: the row that places one lesson, the kept lesson that covers another. */
function answeredOf(requirementId: string): { locked?: number; placed?: number } {
  if (requirementId === post(1).id) return { placed: 1 };
  if (requirementId === post(2).id) return { placed: 1, locked: 1 };
  if (requirementId === post(4).id) return { placed: 1 };
  return {};
}
