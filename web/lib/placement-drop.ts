import type { ConflictHit, Placement } from "@/lib/conflicts";
import { mirrorHits, REASON_OF_HIT, type MirrorContext } from "@/lib/placement-mirror";
import { keptCardId, type BoardPlacement, type BoardPost } from "@/lib/placement-board";
import type { RoomPreference } from "@/lib/queries";
import type { PlacementRecurrence, PlacementRefusalReason } from "@/lib/requirement-placements";
import { PLACEMENT_DAY_END, PLACEMENT_DAY_START, PLACEMENT_GRID_MINUTES, clockOfMinutes } from "@/lib/requirement-placement-text";
import { timeToMinutes } from "@/lib/utils";

/*
 * Förlägg i veckan: can a lesson stand here? What the ghost under a drag, the
 * arrow keys and the sentence under the fields say, from the mirror of the judge
 * (placement-mirror.ts). The gateway answers at the drop and its sentence is
 * the one shown; this is what is known before it.
 *
 * Pure.
 */

/** A lesson being laid or moved: what the clash rule needs to know of it besides where it is. */
export interface Mover {
  /** The card's id (a lesson that is moved: its own place is not in its way) or a brick's. */
  id: string;
  post: Pick<BoardPost, "studentGroupId" | "subjectId" | "coTeacherId" | "startDate" | "endDate">;
  teacherId: string | null;
  roomId: string | null;
  recurrence: PlacementRecurrence;
}

/** Where the lesson would stand: a day and a clock span. */
export interface Span {
  dayOfWeek: number;
  startMinutes: number;
  endMinutes: number;
}

/**
 * Why a lesson cannot stand somewhere, or that it can.
 *
 *   KEPT      a lesson Generera keeps: it is changed in the grundschema, not here
 *   LENGTH    a placed lesson's length is the post's; it is not stretched in the week
 *   DAY       outside the school day (Monday to Friday, 08:00 to 18:00, on the five-minute grid)
 *   CLASH     the clash rule's first hit: its reason and the other lesson's figures, as the gateway's sentence takes them
 */
export type Drop =
  | { kind: "OK" }
  | { kind: "KEPT" }
  | { kind: "LENGTH" }
  | { kind: "DAY" }
  | { kind: "CLASH"; reason: PlacementRefusalReason; params?: Record<string, string | number> };

export const OK: Drop = { kind: "OK" };

/** The school day a förläggning must stand inside (placement-fit.ts insideSchoolDay). */
export function insideSchoolDay(span: Span): boolean {
  return (
    Number.isInteger(span.dayOfWeek) &&
    span.dayOfWeek >= 1 &&
    span.dayOfWeek <= 5 &&
    span.startMinutes >= PLACEMENT_DAY_START &&
    span.endMinutes <= PLACEMENT_DAY_END &&
    span.startMinutes % PLACEMENT_GRID_MINUTES === 0 &&
    span.endMinutes % PLACEMENT_GRID_MINUTES === 0 &&
    span.endMinutes > span.startMinutes
  );
}

/** What the other lesson of a hit is called in the gateway's sentence: its class and subject, a weekday and a time; never a person. */
export interface OtherNames {
  group: (id: string) => string | undefined;
  subject: (id: string) => string | undefined;
}

function paramsOfHit(context: MirrorContext, hit: ConflictHit, names: OtherNames): Record<string, string | number> | undefined {
  const other = hit.otherLessonId === undefined ? undefined : context.others.find((placement) => placement.id === hit.otherLessonId);
  if (!other) return undefined;
  const className = names.group(other.studentGroupId);
  const subjectName = other.subjectId ? names.subject(other.subjectId) : undefined;
  if (className === undefined || subjectName === undefined) return undefined;
  return {
    otherKind: other.id?.startsWith(keptCardId("")) ? "LESSON" : "PLACEMENT",
    className,
    subjectName,
    day: other.dayOfWeek,
    start: clockOfMinutes(other.startMinutes),
    end: clockOfMinutes(other.endMinutes),
  };
}

const placementOf = (mover: Mover, span: Span): Placement => ({
  id: mover.id,
  dayOfWeek: span.dayOfWeek,
  startMinutes: span.startMinutes,
  endMinutes: span.endMinutes,
  teacherId: mover.teacherId,
  coTeacherId: mover.post.coTeacherId,
  roomId: mover.roomId,
  studentGroupId: mover.post.studentGroupId,
  subjectId: mover.post.subjectId,
  recurrence: mover.recurrence,
  startDate: mover.post.startDate,
  endDate: mover.post.endDate,
});

/** The first thing in the way of the lesson at this span, in the order the grundschema reports (the booking first, the ramtid and the meal after). */
export function dropOf(context: MirrorContext, mover: Mover, span: Span, names: OtherNames): Drop {
  if (!insideSchoolDay(span)) return { kind: "DAY" };
  const hit = mirrorHits(context, placementOf(mover, span)).find((candidate) => REASON_OF_HIT[candidate.kind] !== null);
  if (!hit) return OK;
  const params = paramsOfHit(context, hit, names);
  return { kind: "CLASH", reason: REASON_OF_HIT[hit.kind]!, ...(params ? { params } : {}) };
}

/**
 * The next time after `from` on which the lesson stands free: forward in the
 * week by `stepMinutes` (a quarter of an hour by default) to the end of the day,
 * then on the next weekday from the start of the day, round to the start. The
 * spot `from` itself is not offered. Null when the whole week is taken.
 *
 * The grundschema's own search of free times (placement-search.ts) is not used:
 * it holds a lesson against lessons and the teacher's constraints only, and
 * offers a time the ghost shows red for a ramtid, a meal or a class that shares
 * pupils. This one asks the same mirror the ghost does.
 */
export function nextFreeSpot(
  context: MirrorContext,
  mover: Mover,
  minutes: number,
  from: { dayOfWeek: number; startMinutes: number },
  names: OtherNames,
  stepMinutes = 15,
): { dayOfWeek: number; startMinutes: number } | null {
  const slotsPerDay = Math.floor((PLACEMENT_DAY_END - PLACEMENT_DAY_START - minutes) / stepMinutes) + 1;
  if (slotsPerDay <= 0) return null;
  // Positions in the week: day by day, from the start of the day, on the step.
  const slots = 5 * slotsPerDay;
  const first = (from.dayOfWeek - 1) * slotsPerDay + Math.floor((from.startMinutes - PLACEMENT_DAY_START) / stepMinutes) + 1;
  // Once round the week, not including `from` itself.
  for (let step = 0; step < slots - 1; step++) {
    const index = (((first + step) % slots) + slots) % slots;
    const dayOfWeek = Math.floor(index / slotsPerDay) + 1;
    const startMinutes = PLACEMENT_DAY_START + (index % slotsPerDay) * stepMinutes;
    const spot = { dayOfWeek, startMinutes, endMinutes: startMinutes + minutes };
    if (dropOf(context, mover, spot, names).kind === "OK") return { dayOfWeek, startMinutes };
  }
  return null;
}

/** The mover of a förläggning that is moved: its own card id, its post and its row's room, teacher and weeks. */
export function moverOfRow(id: string, row: Pick<BoardPlacement, "roomId" | "teacherId" | "recurrence">, post: BoardPost): Mover {
  return { id, post, teacherId: row.teacherId ?? post.teacherId, roomId: row.roomId, recurrence: row.recurrence };
}

/** `HH:MM` as minutes, or null when it is no time (an empty field). */
export const minutesOfField = (value: string): number | null => {
  if (!/^\d{1,2}:\d{2}$/.test(value)) return null;
  const minutes = timeToMinutes(value);
  return Number.isFinite(minutes) ? minutes : null;
};

/**
 * The room to offer for a lesson: the room the post's other förläggningar stand in,
 * else a room its subject's rule names, else the room the filter picked, else none
 * (the engine chooses it).
 */
export function suggestedRoom(input: {
  postRows: readonly Pick<BoardPlacement, "roomId">[];
  rules: readonly RoomPreference[];
  subjectId: string;
  /** The class's year, for a rule that holds for some years only. */
  gradeLevel: number | null;
  filterRooms: readonly string[];
}): string | null {
  const counts = new Map<string, number>();
  for (const row of input.postRows) if (row.roomId) counts.set(row.roomId, (counts.get(row.roomId) ?? 0) + 1);
  const common = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (common) return common[0];
  const rule = input.rules.find(
    (candidate) =>
      candidate.subjectId === input.subjectId &&
      candidate.rooms.length > 0 &&
      (candidate.minGradeLevel === null || (input.gradeLevel !== null && input.gradeLevel >= candidate.minGradeLevel)) &&
      (candidate.maxGradeLevel === null || (input.gradeLevel !== null && input.gradeLevel <= candidate.maxGradeLevel)),
  );
  if (rule) return rule.rooms[0]!.roomId;
  return input.filterRooms.length === 1 ? input.filterRooms[0]! : null;
}
