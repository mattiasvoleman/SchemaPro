import { Reply, route, type GatewayContext, type GatewayRoute } from "../gateway-routes";
import { LUNCH_SITTINGS } from "./school-days";
import { GROUP_LIST, MASTER_LESSONS, SUBJECTS } from "./world";

/**
 * Where a lesson can stand, as the gateway answers it (src/calendar/possible-times.service.ts), for the browser suites of the board (E3):
 * POST /master-lessons/possible-times.
 *
 * It judges the fixture school's own lessons by the clash rule's three arms (a teacher, a room or a class that share a clock) and by the
 * class's meal, as the stub's judge does (gateway-lesson-judge.ts), which is enough to give every shape of answer the board paints: a
 * start that is free, one shut by the lunch, one held by a lesson that is named, and one held by several. The best times are the free
 * ones nearest the lesson's own, so that a spec can say which one is "1" without a ranking of its own. It is a stand-in for the answer's
 * SHAPE; what the gateway's judge says is held to the real judge by scripts/test/probe-mojliga-tider.ts.
 */

interface Body {
  lessonId?: string;
  from?: string;
  to?: string;
  stepMinutes?: number;
  limit?: number;
}

const minutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
const overlaps = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 && b0 < a1;
const subjectName = (id: string) => Object.values(SUBJECTS).find((subject) => subject.id === id)?.name ?? "";
const className = (id: string) => GROUP_LIST.find((group) => group.id === id)?.name ?? "";

type Answer =
  | { kind: "STANDS" }
  | { kind: "FREE" }
  | { kind: "CLOSED"; code: "LUNCH"; params: Record<string, never> }
  | { kind: "IN_THE_WAY"; blockerId: string }
  | { kind: "CROWDED"; units: number; locked: boolean };

function possibleTimes(context: GatewayContext): unknown {
  if (!context.person) return new Reply(401, { message: "Unauthorized" });
  const body = (context.body ?? {}) as Body;
  const lesson = MASTER_LESSONS.find((candidate) => candidate.id === body.lessonId);
  if (!lesson) return new Reply(404, { detail: "Master lesson not found." });
  const from = minutes(body.from ?? "07:00");
  const to = minutes(body.to ?? "18:00");
  const step = body.stepMinutes ?? 5;
  const limit = body.limit ?? 12;
  const length = minutes(lesson.endTime) - minutes(lesson.startTime);
  const own = { day: lesson.dayOfWeek, start: minutes(lesson.startTime) };

  const answerAt = (day: number, start: number): Answer => {
    if (day === own.day && start === own.start) return { kind: "STANDS" };
    const end = start + length;
    if (LUNCH_SITTINGS.some((sitting) => sitting.studentGroupId === lesson.studentGroupId && sitting.dayOfWeek === day && overlaps(start, end, minutes(sitting.startTime), minutes(sitting.endTime)))) {
      return { kind: "CLOSED", code: "LUNCH", params: {} };
    }
    const holding = MASTER_LESSONS.filter(
      (other) =>
        other.id !== lesson.id &&
        !other.isParked &&
        other.dayOfWeek === day &&
        overlaps(start, end, minutes(other.startTime), minutes(other.endTime)) &&
        (other.studentGroupId === lesson.studentGroupId || (lesson.teacherId !== null && (other.teacherId === lesson.teacherId || other.coTeacherId === lesson.teacherId)) || (lesson.roomId !== null && other.roomId === lesson.roomId)),
    );
    if (holding.length === 0) return { kind: "FREE" };
    if (holding.length === 1 && !holding[0]!.isLocked) return { kind: "IN_THE_WAY", blockerId: holding[0]!.id };
    return { kind: "CROWDED", units: holding.length, locked: holding.some((other) => other.isLocked) };
  };

  const days = [1, 2, 3, 4, 5].map((dayOfWeek) => {
    const runs: Array<Record<string, unknown>> = [];
    let open: { run: Record<string, unknown>; key: string } | null = null;
    for (let start = from; start + length <= to; start += step) {
      const answer = answerAt(dayOfWeek, start);
      const key = JSON.stringify(answer);
      if (open && open.key === key && (open.run["toMinutes"] as number) + step === start) {
        open.run["toMinutes"] = start;
        continue;
      }
      const run: Record<string, unknown> = { dayOfWeek, fromMinutes: start, toMinutes: start, ...answer };
      runs.push(run);
      open = { run, key };
    }
    return { dayOfWeek, runs };
  });

  const free: Array<{ dayOfWeek: number; start: number }> = [];
  for (const { dayOfWeek } of days) {
    for (let start = from; start + length <= to; start += 30) if (answerAt(dayOfWeek, start).kind === "FREE") free.push({ dayOfWeek, start });
  }
  free.sort((a, b) => Math.abs(a.dayOfWeek - own.day) - Math.abs(b.dayOfWeek - own.day) || Math.abs(a.start - own.start) - Math.abs(b.start - own.start) || a.start - b.start);
  const options = free.slice(0, limit).map((time, index) => ({
    rank: index + 1,
    dayOfWeek: time.dayOfWeek,
    startMinutes: time.start,
    endMinutes: time.start + length,
    lessons: [{ lessonId: lesson.id, roomId: lesson.roomId, startMinutes: time.start, endMinutes: time.start + length }],
    roomChanged: false,
    costs: [],
    wishes: { met: 0, avoided: 0 },
    score: index,
  }));

  const blockers: Record<string, unknown> = {};
  for (const { runs } of days) {
    for (const run of runs) {
      const id = run["blockerId"] as string | undefined;
      const other = id ? MASTER_LESSONS.find((candidate) => candidate.id === id) : undefined;
      if (id && other) {
        blockers[id] = { lessonId: id, className: className(other.studentGroupId), subjectName: subjectName(other.subjectId), dayOfWeek: other.dayOfWeek, startMinutes: minutes(other.startTime), endMinutes: minutes(other.endTime), isLocked: other.isLocked };
      }
    }
  }
  return {
    academicYearId: lesson.academicYearId,
    subject: {
      lessonId: lesson.id,
      className: className(lesson.studentGroupId),
      subjectName: subjectName(lesson.subjectId),
      minutes: length,
      lessonIds: [lesson.id],
      isLocked: lesson.isLocked,
      unplaced: false,
      current: { dayOfWeek: own.day, startMinutes: own.start, endMinutes: own.start + length },
    },
    stepMinutes: step,
    options,
    days,
    blockers,
    stats: { starts: 0, closed: 0, inTheWay: 0, crowded: 0, judged: 0, refused: 0, free: free.length, truncated: false, elapsedMs: 0, phasesMs: {} },
  };
}

export const possibleTimesRoutes: GatewayRoute[] = [route("POST", "/api/v1/master-lessons/possible-times", possibleTimes)];
