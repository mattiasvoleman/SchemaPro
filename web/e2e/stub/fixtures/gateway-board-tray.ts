import { Reply, route, type GatewayContext, type GatewayRoute } from "../gateway-routes";
import { GROUPS, MASTER_LESSONS, SUBJECTS, TEACHERS } from "./world";

/**
 * Att lägga (E4), as the gateway answers it (src/board-tray/), for the browser suites of the board: GET /board-tray and POST /board-tray/lay.
 *
 * The tray is the fixture school's: two bricks. Engelska for 7B (one lesson of sixty minutes, which nobody has laid) is the one that can be laid,
 * and the fixture's parked lesson (Bild for 8A, which has no teacher) is a brick that is a lesson on the parking and cannot be laid until it has
 * one. A lay answers what the gateway answers and writes nothing: the stub's world is one for every spec, and a lay that changed it would change
 * the next spec's. What the gateway counts and judges is held to the real one by scripts/test/probe-att-lagga.ts.
 */

const PART_KEY = "0123456789abcdef";
const PARKED = MASTER_LESSONS.find((lesson) => lesson.isParked)!;
const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

function tray(context: GatewayContext): unknown {
  if (!context.person) return new Reply(401, { message: "Unauthorized" });
  const yearId = context.query.get("academicYearId") ?? PARKED.academicYearId;
  const brick = {
    postId: "00000000-0000-4000-8000-0000000000a1",
    nth: 1,
    partKey: PART_KEY,
    lessonId: null,
    studentGroupId: GROUPS.g7B.id,
    subjectId: SUBJECTS.en.id,
    teacherId: TEACHERS.anna.id,
    coTeacherId: null,
    minutes: 60,
    recurrence: "ALL_WEEKS",
    startDate: null,
    endDate: null,
    blockId: null,
    cannotPlace: null,
    possibleTimes: null,
  };
  const parked = {
    ...brick,
    postId: "00000000-0000-4000-8000-0000000000a2",
    partKey: "fedcba9876543210",
    lessonId: PARKED.id,
    studentGroupId: PARKED.studentGroupId,
    subjectId: PARKED.subjectId,
    teacherId: null,
    minutes: 80,
    cannotPlace: "NO_TEACHER",
  };
  return {
    academicYearId: yearId,
    bricks: [parked, brick],
    tally: { lessons: MASTER_LESSONS.length + 1, laid: MASTER_LESSONS.length - 1, placedByRow: 0, left: 2 },
    groups: [
      { studentGroupId: GROUPS.g7B.id, left: 1 },
      { studentGroupId: PARKED.studentGroupId, left: 1 },
    ],
  };
}

function lay(context: GatewayContext): unknown {
  if (!context.person) return new Reply(401, { message: "Unauthorized" });
  const body = (context.body ?? {}) as { dayOfWeek?: number; startTime?: string; minutes?: number; roomId?: string | null };
  const start = Number(body.startTime?.slice(0, 2)) * 60 + Number(body.startTime?.slice(3, 5));
  return {
    lesson: { id: "00000000-0000-4000-8000-0000000000b1", dayOfWeek: body.dayOfWeek, startTime: body.startTime, endTime: clock(start + (body.minutes ?? 60)), roomId: body.roomId ?? null, isLocked: true },
    noRoom: (body.roomId ?? null) === null,
  };
}

export const boardTrayRoutes: GatewayRoute[] = [route("GET", "/api/v1/board-tray", tray), route("POST", "/api/v1/board-tray/lay", lay)];
