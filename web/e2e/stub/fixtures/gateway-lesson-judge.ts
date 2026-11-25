import { Reply, route, type GatewayContext, type GatewayRoute } from "../gateway-routes";
import { LUNCH_SITTINGS } from "./school-days";
import { GROUP_LIST, MASTER_LESSONS, SUBJECTS } from "./world";

/**
 * The judge of a hand edit as the gateway answers it (src/calendar/lesson-judge.ts), for the browser suites of Justera lektion and the
 * krocklista (e2e/lesson-judge.smoke.spec.ts): the läsande frågan (POST /master-lessons/judge) and the PATCH it is the question of, which says
 * no with MASTER_LESSON_REFUSED and the reason's params.
 *
 * It judges the fixture school's own lessons by the clash rule's three arms (the teacher, the room, the class, which share a clock) and by
 * the class's meal, which is enough to give every shape of answer the page words: a clash that names the other lesson by class, subject,
 * day and time, a rule that names none, and a drag that is let through. The PATCH writes nothing: the stub's tables are read-only.
 */

interface Move {
  lessonId: string;
  dayOfWeek?: number;
  startTime?: string;
  endTime?: string;
  teacherId?: string | null;
  roomId?: string | null;
}
interface Refusal {
  reason: string;
  params: Record<string, string | number>;
  text: string;
}

const DAYS = ["", "måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag", "söndag"];
const subjectName = (id: string) => Object.values(SUBJECTS).find((subject) => subject.id === id)?.name ?? "";
const className = (id: string) => GROUP_LIST.find((group) => group.id === id)?.name ?? "";
const minutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
const overlaps = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 && b0 < a1;

const SENTENCE: Record<string, string> = {
  TEACHER: "Läraren har redan",
  ROOM: "Salen är redan upptagen av",
  GROUP: "Klassen har redan",
};

function refusalsOf(move: Move): Refusal[] | null {
  const lesson = MASTER_LESSONS.find((candidate) => candidate.id === move.lessonId);
  if (!lesson) return null;
  const day = move.dayOfWeek ?? lesson.dayOfWeek;
  const start = minutes(move.startTime ?? lesson.startTime);
  const end = minutes(move.endTime ?? lesson.endTime);
  const teacherId = move.teacherId !== undefined ? move.teacherId : lesson.teacherId;
  const roomId = move.roomId !== undefined ? move.roomId : lesson.roomId;
  const found: Refusal[] = [];
  for (const reason of ["TEACHER", "ROOM", "GROUP"] as const) {
    for (const other of MASTER_LESSONS) {
      if (other.id === lesson.id || other.isParked || other.dayOfWeek !== day) continue;
      if (!overlaps(start, end, minutes(other.startTime), minutes(other.endTime))) continue;
      const clashes =
        reason === "TEACHER"
          ? teacherId !== null && (other.teacherId === teacherId || other.coTeacherId === teacherId)
          : reason === "ROOM"
            ? roomId !== null && other.roomId === roomId
            : other.studentGroupId === lesson.studentGroupId;
      if (!clashes) continue;
      const params = {
        otherKind: "LESSON",
        className: className(other.studentGroupId),
        subjectName: subjectName(other.subjectId),
        day: other.dayOfWeek,
        start: other.startTime.slice(0, 5),
        end: other.endTime.slice(0, 5),
      };
      found.push({
        reason,
        params,
        text: `${SENTENCE[reason]} ${params.subjectName} ${params.className} ${DAYS[params.day]} ${params.start}–${params.end}.`,
      });
      break;
    }
  }
  const meal = LUNCH_SITTINGS.find(
    (sitting) =>
      sitting.studentGroupId === lesson.studentGroupId &&
      sitting.dayOfWeek === day &&
      overlaps(start, end, minutes(sitting.startTime), minutes(sitting.endTime)),
  );
  if (meal) found.push({ reason: "LUNCH", params: {}, text: "Tiden ligger på klassens lunch." });
  return found;
}

function judge(context: GatewayContext): unknown {
  if (!context.person) return new Reply(401, { message: "Unauthorized" });
  const moves = ((context.body as { moves?: Move[] } | null)?.moves ?? []).map((move) => {
    const refusals = refusalsOf(move);
    return { lessonId: move.lessonId, ok: refusals !== null && refusals.length === 0, refusals: refusals ?? [] };
  });
  return { ok: moves.every((move) => move.ok), moves };
}

function patch(context: GatewayContext): unknown {
  if (!context.person) return new Reply(401, { message: "Unauthorized" });
  const id = context.params["id"]!;
  const refusals = refusalsOf({ ...(context.body as Omit<Move, "lessonId">), lessonId: id });
  if (refusals === null) return new Reply(404, { detail: "Master lesson not found." });
  if (refusals.length > 0) {
    const first = refusals[0]!;
    return new Reply(409, {
      status: 409,
      title: "Conflict",
      detail: refusals.map((refusal) => refusal.text).join(" "),
      code: "MASTER_LESSON_REFUSED",
      params: { reason: first.reason, reasons: refusals.map((refusal) => refusal.reason).join(","), ...first.params },
    });
  }
  const lesson = MASTER_LESSONS.find((candidate) => candidate.id === id)!;
  return { ...lesson, ...(context.body as object), propagatedLessons: 0, removedCalendarLessons: 0, warnings: [] };
}

export const lessonJudgeRoutes: GatewayRoute[] = [
  route("POST", "/api/v1/master-lessons/judge", judge),
  route("PATCH", "/api/v1/master-lessons/:id", patch),
];
