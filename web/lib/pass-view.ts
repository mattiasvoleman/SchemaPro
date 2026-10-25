import type { CoverMessage, PassBoardItem } from "@/lib/cover-types";

/*
 * What the board shows and offers for an absent rastvakt's pass, as pure
 * functions — beside lib/cover-view.ts and not in it: that module is in the
 * board's own chunk and seven other routes', and these are read only by the
 * board's lazy Rastvakt section (supervision-passes.tsx), so a school without
 * passes downloads none of them.
 */

/*
 * AN ABSENT RASTVAKT'S PASS (Rastvakt i vardagen, 20261210090000), by the
 * gateway's rules (src/cover/supervision-cover.service.ts):
 *   - "Tillsätt vikarie" and "Utan ersättare" need the pass OPEN (or a vikarie
 *     who is away themself, `decisionStale`) and not ended;
 *   - "Ångra" needs a decision and a pass not ended;
 *   - a decision left on a day the pass no longer runs (`runs` false: a lov
 *     added since, its teacher deactivated) is undone, never replaced;
 *   - switching decisions is Ångra, then decide.
 */

/** The badge a pass shows. */
export type PassStatusKey = "OPEN" | "COVERED" | "NO_COVER" | "PASSED";

export function passStatusKey(item: PassBoardItem): PassStatusKey {
  if (item.status === "OPEN") return item.passed ? "PASSED" : "OPEN";
  return item.status === "COVERED" ? "COVERED" : "NO_COVER";
}

export interface PassActions {
  assign: boolean;
  noCover: boolean;
  undo: boolean;
}

export function passActions(item: PassBoardItem, now: number): PassActions {
  const live = new Date(item.endsAt).getTime() > now;
  const open = item.status === "OPEN" && live && item.runs !== false;
  return { assign: open, noCover: open, undo: item.decision !== null && live };
}

export const passKey = (item: Pick<PassBoardItem, "shiftId" | "date">) => `${item.shiftId}:${item.date}`;

/**
 * The rules the gateway REFUSES a hand-picked vikarie for a pass on: busy with
 * a lesson or another pass then (SUPERVISION_SUBSTITUTE_BUSY), away, the
 * pass's own teacher, not an active teacher. The rest are warned.
 */
const REFUSED_PASS_PICK = new Set(["BUSY_LESSON", "BUSY_SUPERVISION", "ABSENT", "ON_LESSON", "INACTIVE"]);

/** "Annan lärare" for a pass: every active teacher not suggested, less those the gateway would refuse. */
export function otherPassTeacherOptions<T extends { id: string }>(
  teachers: readonly T[],
  item: Pick<PassBoardItem, "absentTeacherId"> | null,
  data: { candidates: { userId: string }[]; excluded: { userId: string; codes: CoverMessage[] }[] } | undefined,
): T[] {
  const left = new Set([
    ...(data?.candidates ?? []).map((candidate) => candidate.userId),
    ...(item ? [item.absentTeacherId] : []),
    ...(data?.excluded ?? [])
      .filter((entry) => entry.codes.some((code) => REFUSED_PASS_PICK.has(code.code)))
      .map((entry) => entry.userId),
  ]);
  return teachers.filter((teacher) => !left.has(teacher.id));
}

/** The passes by date, in time order, for the week view. */
export function passesByDate(items: readonly PassBoardItem[]): { date: string; passes: PassBoardItem[] }[] {
  const byDate = new Map<string, PassBoardItem[]>();
  for (const item of [...items].sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.shiftId.localeCompare(b.shiftId))) {
    byDate.set(item.date, [...(byDate.get(item.date) ?? []), item]);
  }
  return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, passes]) => ({ date, passes }));
}
