import { closingConstraints, toPlacement, type ConflictHit } from "@/lib/conflicts";
import type { ExemptRule } from "@/lib/exemptions";
import type { GradeSpan } from "@/lib/grade-span";
import type { ProblemLookup } from "@/lib/api-error-text";
import { problemSentence } from "@/lib/problem-codes";
import type { AvailabilityConstraint, MasterLesson } from "@/lib/types";

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

/** Whether the two lessons are held by a class in common, as the judge reads it: either's own class or an extra class. */
const sharesAClass = (a: MasterLesson, b: MasterLesson): boolean => {
  const held = new Set([a.studentGroupId, ...a.extraGroupIds]);
  return [b.studentGroupId, ...b.extraGroupIds].some((id) => held.has(id));
};

/** What the judge calls the rule of a weekly row: the resource it closes, or GRADE_RULE for a rule on whole årskurser. */
const closedBy = (row: AvailabilityConstraint | undefined): Record<string, string> =>
  row === undefined
    ? { reason: "AVAILABILITY" }
    : row.resourceType === "GRADE_LEVEL"
      ? { reason: "GRADE_RULE" }
      : { reason: "AVAILABILITY", resource: row.resourceType === "TEACHER" ? "TEACHER" : row.resourceType === "ROOM" ? "ROOM" : "GROUP" };

function reasonOf(
  hit: ConflictHit,
  lesson: MasterLesson,
  closing: AvailabilityConstraint | undefined,
  lessonById: ReadonlyMap<string, MasterLesson>,
  names: ConflictNames,
): ConflictReason {
  const other = hit.otherLessonId === undefined ? undefined : lessonById.get(hit.otherLessonId);
  switch (hit.kind) {
    case "TEACHER":
    case "ROOM":
    case "GROUP":
      // A clash of classes with no class in common (pupils they share, or named ones) is the judge's PUPILS, as the judge tells it
      // (src/calendar/lesson-judge.ts clashRefusalOf), and its sentence is not the one for the class itself.
      return {
        kind: hit.kind,
        values: {
          reason: hit.kind === "GROUP" && other && !sharesAClass(lesson, other) ? "PUPILS" : hit.kind,
          ...otherOf(other, names),
          ...(hit.pupilBufferOnly ? { pupilTime: 1 } : {}),
        },
      };
    case "AVAILABILITY":
      // The grid says a closed hour as one kind; the row that closed it says whose it is, and a year rule is the judge's GRADE_RULE.
      // With no rules to ask (`rules` left out), the sentence for "some resource of the lesson" (the sentence's `other`).
      return { kind: hit.kind, values: closedBy(closing) };
    case "FRAME":
    case "LUNCH":
      return { kind: hit.kind, values: { reason: hit.kind } };
    case "ROOM_LOCK":
      return { kind: hit.kind, values: null };
  }
}

/** A lesson that stands against a rule ON PURPOSE (Undantag med flit), and the rules. */
export interface ExemptRow {
  lesson: MasterLesson;
  rules: readonly ExemptRule[];
}

/** The lessons with an exemption, in the week's order (day, then clock, then id): what the krocklistan says under "Undantag". */
export function exemptRows(exemptions: ReadonlyMap<string, readonly ExemptRule[]>, lessonById: ReadonlyMap<string, MasterLesson>): ExemptRow[] {
  const rows: ExemptRow[] = [];
  for (const [id, rules] of exemptions) {
    const lesson = lessonById.get(id);
    if (lesson && rules.length > 0) rows.push({ lesson, rules });
  }
  return rows.sort((a, b) => a.lesson.dayOfWeek - b.lesson.dayOfWeek || a.lesson.startTime.localeCompare(b.lesson.startTime) || a.lesson.id.localeCompare(b.lesson.id));
}

/**
 * What a lesson's reasons say, one sentence each, in the sentences a refused save is said in: the list's rows and the grid's cards
 * (the card's note) read the same words from here, so a clash is one sentence wherever it is told. A reason with no sentence (one a
 * newer gateway has words for and this web has none) is left out, and `roomLock` words the one the gateway has no refusal for.
 */
export function reasonSentences(reasons: readonly ConflictReason[], roomLock: string, tCommon: ProblemLookup): string[] {
  return reasons
    .map((reason) => (reason.values === null ? roomLock : (problemSentence("MASTER_LESSON_REFUSED", reason.values, tCommon) ?? "")))
    .filter((sentence) => sentence !== "");
}

/** The lessons that stand against a rule, in the week's order (day, then clock, then name), each with its reasons in the grid's order. */
/** What the grid's weekly rows are read against, to say whose hour an AVAILABILITY hit closes: the page's own constraints and year spans. */
export interface ConflictRules {
  constraints: AvailabilityConstraint[];
  gradeSpanOf?: Map<string, GradeSpan>;
}

export function conflictRows(
  conflictMap: ReadonlyMap<string, readonly ConflictHit[]>,
  lessonById: ReadonlyMap<string, MasterLesson>,
  names: ConflictNames,
  rules?: ConflictRules,
): ConflictRow[] {
  const rows: ConflictRow[] = [];
  for (const [id, hits] of conflictMap) {
    const lesson = lessonById.get(id);
    if (!lesson || hits.length === 0) continue;
    // A clash with the same lesson found twice (the grid reads one clash as one hit, but a lesson can clash with two) is told once each.
    const seen = new Set<string>();
    const reasons: ConflictReason[] = [];
    // The grid pushes one AVAILABILITY hit for each row that closes the hour, in the rows' order: the n-th hit is the n-th row.
    const closing = rules ? closingConstraints(toPlacement(lesson), rules.constraints, rules.gradeSpanOf) : [];
    let closed = 0;
    for (const hit of hits) {
      const reason = reasonOf(hit, lesson, hit.kind === "AVAILABILITY" ? closing[closed++] : undefined, lessonById, names);
      const key = `${reason.kind}|${hit.otherLessonId ?? ""}|${hit.pupilBufferOnly ? 1 : 0}|${JSON.stringify(reason.values)}`;
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
