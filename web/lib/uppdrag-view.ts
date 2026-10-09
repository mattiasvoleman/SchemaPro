/**
 * The uppdragsbeskrivning's arithmetic-free parts (staffing Fas 3): which
 * period a row runs, and which of the template's boxes a teacher's uppdrag
 * tick. Every figure on the page is the gateway's (GET /staffing/load's
 * assignments and annual); this module only sorts words.
 */

import type { TeacherAssignment } from "@/lib/teacher-load";
import type { TeacherDutyKind } from "@/lib/types";

export type AssignmentPeriod =
  | { kind: "year" }
  | { kind: "odd" }
  | { kind: "even" }
  | { kind: "dated"; from: string | null; to: string | null; recurrence: "ALL" | "ODD" | "EVEN" };

/** "Hela läsåret", "Udda veckor", or the row's own dates (and weeks). */
export function periodOf(
  assignment: Pick<TeacherAssignment, "recurrence" | "startDate" | "endDate">,
): AssignmentPeriod {
  const recurrence =
    assignment.recurrence === "ODD_WEEKS" ? "ODD" : assignment.recurrence === "EVEN_WEEKS" ? "EVEN" : "ALL";
  if (assignment.startDate || assignment.endDate) {
    return { kind: "dated", from: assignment.startDate, to: assignment.endDate, recurrence };
  }
  return recurrence === "ODD" ? { kind: "odd" } : recurrence === "EVEN" ? { kind: "even" } : { kind: "year" };
}

/**
 * The boxes of a municipal uppdragsbeskrivning's "Övriga uppdrag" (the shape
 * Göteborgs Stad's template uses, rev. 2024-03-18: Mentor, Ämnesansvarig,
 * VFU, APL, Övrigt — plus Förstelärare and APT/konferens, which this app
 * records as uppdrag of their own), each ticked when the teacher holds an
 * uppdrag of that kind this year. Every kind lands in exactly one box.
 */
export const UPPDRAG_BOXES = [
  "MENTOR",
  "AMNESANSVAR",
  "FORSTELARARE",
  "VFU",
  "APL",
  "APT",
  "OVRIGT",
] as const;
export type UppdragBox = (typeof UPPDRAG_BOXES)[number];

export function boxOf(kind: TeacherDutyKind): UppdragBox {
  switch (kind) {
    case "MENTORSKAP":
      return "MENTOR";
    case "AMNESANSVAR":
      return "AMNESANSVAR";
    case "FORSTELARARE":
      return "FORSTELARARE";
    case "VFU_HANDLEDNING":
      return "VFU";
    case "APL":
      return "APL";
    case "APT_KONFERENS":
      return "APT";
    default:
      return "OVRIGT";
  }
}

export function tickedBoxes(duties: readonly { kind: TeacherDutyKind }[]): Set<UppdragBox> {
  return new Set(duties.map((duty) => boxOf(duty.kind)));
}
