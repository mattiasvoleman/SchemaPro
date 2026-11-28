import { Reply, route, type GatewayContext, type GatewayRoute } from "../gateway-routes";
import { GROUPS, MASTER_LESSONS, ROOMS, SUBJECTS, TEACHERS } from "./world";

/**
 * Lägg det som går (E7a), as the gateway answers it (src/board-fill/), for the browser suite of the board: POST /board-fill/propose and /apply.
 *
 * The tray is the fixture school's (gateway-board-tray.ts): two bricks. A proposal for the class or the school lays the one that can be laid
 * (Engelska for 7B, on Tuesday at 09:00 in the first room) and leaves the one nobody teaches, as the gateway does it. An apply answers what the
 * gateway answers and writes nothing: the stub's world is one for every spec, and a write that changed it would change the next spec's. What the
 * gateway chooses and judges is held to the real one by scripts/test/probe-lagg-det-som-gar.ts.
 */

const PARKED = MASTER_LESSONS.find((lesson) => lesson.isParked)!;
const POST_A = "00000000-0000-4000-8000-0000000000a1";
const POST_B = "00000000-0000-4000-8000-0000000000a2";
const BASIS = "0123456789abcdef0123456789abcdef";

function propose(context: GatewayContext): unknown {
  if (!context.person) return new Reply(401, { message: "Unauthorized" });
  const body = (context.body ?? {}) as { academicYearId?: string; scope?: string; studentGroupId?: string };
  const english = { key: `${POST_A}|${TEACHERS.anna.id}|60|1`, postId: POST_A, studentGroupId: GROUPS.g7B.id, subjectId: SUBJECTS.en.id, teacherId: TEACHERS.anna.id, minutes: 60, lessonId: null };
  const nobodys = { key: `${POST_B}|-|80|1`, postId: POST_B, studentGroupId: PARKED.studentGroupId, subjectId: PARKED.subjectId, teacherId: null, minutes: 80, lessonId: PARKED.id };
  const wantsEnglish = body.scope !== "CLASS" || body.studentGroupId === GROUPS.g7B.id;
  const wantsParked = body.scope !== "CLASS" || body.studentGroupId === PARKED.studentGroupId;
  return {
    academicYearId: body.academicYearId ?? PARKED.academicYearId,
    answeredBy: "FILL",
    basis: BASIS,
    asked: Number(wantsEnglish) + Number(wantsParked),
    placed: wantsEnglish
      ? [{ ...english, dayOfWeek: 2, startMinutes: 540, endMinutes: 600, roomId: ROOMS.r101.id, noRoom: false, freeStarts: 12, rank: 1, costs: [] }]
      : [],
    left: wantsParked ? [{ ...nobodys, reason: "NO_TEACHER" }] : [],
    moved: [],
    truncated: false,
    stats: { elapsedMs: 40, worldMs: 10, probeMs: 20, costMs: 5, judgeMs: 5, worlds: 2 },
  };
}

function apply(context: GatewayContext): unknown {
  if (!context.person) return new Reply(401, { message: "Unauthorized" });
  const body = (context.body ?? {}) as { academicYearId?: string; items?: Array<{ key: string }> };
  return {
    academicYearId: body.academicYearId ?? PARKED.academicYearId,
    versionId: "00000000-0000-4000-8000-0000000000c1",
    laid: (body.items ?? []).map((item, index) => ({ key: item.key, lessonId: `00000000-0000-4000-8000-0000000000d${index}`, created: true, noRoom: false })),
  };
}

export const boardFillRoutes: GatewayRoute[] = [route("POST", "/api/v1/board-fill/propose", propose), route("POST", "/api/v1/board-fill/apply", apply)];
