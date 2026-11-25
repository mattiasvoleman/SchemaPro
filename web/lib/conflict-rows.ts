import type { ConflictHit } from "@/lib/conflicts";
import type { MasterLesson } from "@/lib/types";

/*
 * THE KROCKLISTA'S ROWS: every lesson of the grundschema that stands against a rule, and what it stands against, from what the page already
 * holds (the clash map the grid paints, lib/conflicts.ts detectConflicts). Nothing is asked of the gateway.
 *
 * Each reason is said in the sentence the gateway's refusal of a save is said in (common.codes.MASTER_LESSON_REFUSED), so one reason is
 * one sentence in the toast, in Justera lektion and here: the reason is the refusal's own, and so are the values it is written from. The
 * other lesson a clash names is told by class, subject, day and time, never by a person.
 *
 * Read by the list alone, which is fetched on the first press of "Visa vilka", so it is not in the page's first load.
 */

/** The values of common.codes.MASTER_LESSON_REFUSED for one reason, as the gateway sends them, or null for a reason that has no sentence there. */
export interface ConflictReason {
  /** The grid's kind of rule. */
  kind: ConflictHit["kind"];
  /** What the sentence is written from; null for ROOM_LOCK, which the gateway has no refusal for and the list words itself. */
  values: Record<string, string | number> | null;
}

export interface ConflictRow {
  lesson: MasterLesson;
  reasons: ConflictReason[];
}

/** HH:MM from the database's HH:MM:SS. */
const clock = (time: string): string => time.slice(0, 5);

export interface ConflictNames {
  group: (id: string) => string;
  subject: (id: string) => string;
}

/** What a clash names of the other lesson: its class, its subject, its day and its time. */
function otherOf(other: MasterLesson | undefined, names: ConflictNames): Record<string, string | number> {
  if (!other) return {};
  return {
    otherKind: "LESSON",
    className: names.group(other.studentGroupId),
    subjectName: names.subject(other.subjectId),
    day: other.dayOfWeek,
    start: clock(other.startTime),
    end: clock(other.endTime),
  };
}

function reasonOf(hit: ConflictHit, lessonById: ReadonlyMap<string, MasterLesson>, names: ConflictNames): ConflictReason {
  const other = hit.otherLessonId === undefined ? undefined : lessonById.get(hit.otherLessonId);
  switch (hit.kind) {
    case "TEACHER":
    case "ROOM":
    case "GROUP":
      return { kind: hit.kind, values: { reason: hit.kind, ...otherOf(other, names), ...(hit.pupilBufferOnly ? { pupilTime: 1 } : {}) } };
    case "AVAILABILITY":
    case "FRAME":
    case "LUNCH":
      // The grid says a closed hour as one kind, whether it is the teacher's, the room's, the class's or a year's: the sentence for
      // "some resource of the lesson" is the one with no resource named (the sentence's `other`).
      return { kind: hit.kind, values: { reason: hit.kind } };
    case "ROOM_LOCK":
      return { kind: hit.kind, values: null };
  }
}

/** The lessons that stand against a rule, in the week's order (day, then clock, then name), each with its reasons in the grid's order. */
export function conflictRows(
  conflictMap: ReadonlyMap<string, readonly ConflictHit[]>,
  lessonById: ReadonlyMap<string, MasterLesson>,
  names: ConflictNames,
): ConflictRow[] {
  const rows: ConflictRow[] = [];
  for (const [id, hits] of conflictMap) {
    const lesson = lessonById.get(id);
    if (!lesson || hits.length === 0) continue;
    // A clash with the same lesson found twice (the grid reads one clash as one hit, but a lesson can clash with two) is told once each.
    const seen = new Set<string>();
    const reasons: ConflictReason[] = [];
    for (const hit of hits) {
      const reason = reasonOf(hit, lessonById, names);
      const key = `${reason.kind}|${hit.otherLessonId ?? ""}|${hit.pupilBufferOnly ? 1 : 0}`;
      if (seen.has(key)) continue;
      seen.add(key);
      reasons.push(reason);
    }
    rows.push({ lesson, reasons });
  }
  return rows.sort(
    (a, b) =>
      a.lesson.dayOfWeek - b.lesson.dayOfWeek ||
      a.lesson.startTime.localeCompare(b.lesson.startTime) ||
      names.group(a.lesson.studentGroupId).localeCompare(names.group(b.lesson.studentGroupId), "sv") ||
      a.lesson.id.localeCompare(b.lesson.id),
  );
}
