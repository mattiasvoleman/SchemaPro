import type { ConflictHit } from "@/lib/conflicts";
import type { MasterLesson } from "@/lib/types";

/*
 * UNDANTAG MED FLIT (E1b), as the page reads it.
 *
 * An administrator may answer "Lägg ändå" to a no for the stage's ramtid or the class's meal. The gateway saves the rule's NAME on the lesson
 * (MasterLessons.exemptFrom: FRAME, LUNCH), locks the lesson, and ends the exemption when the lesson's time, lock or place changes
 * (docs/schedule-editing.md). These are the two things the page does with it: which rules a refusal can be answered yes to, and which hits
 * the grid finds are no conflict because the lesson stands there on purpose.
 */

/** The two rules that can be exempted, in the order the gateway writes them. A teacher, a room, a class, a closed hour, another school's time and the school day cannot. */
export const EXEMPT_RULES = ["FRAME", "LUNCH"] as const;
export type ExemptRule = (typeof EXEMPT_RULES)[number];

/** The rules a refusal's `reasons` (comma-joined, as the gateway sends them) can be answered yes to: only when they are all of them exemptable. */
export function exemptableReasons(reasons: string | undefined): ExemptRule[] | null {
  if (!reasons) return null;
  const found = reasons.split(",");
  if (!found.every((reason) => (EXEMPT_RULES as readonly string[]).includes(reason))) return null;
  return EXEMPT_RULES.filter((rule) => found.includes(rule));
}

export interface ExemptionSplit {
  /** The grid's conflicts, without a hit the lesson is exempt from, and without a lesson that has nothing else. */
  conflicts: ReadonlyMap<string, readonly ConflictHit[]>;
  /**
   * Lesson id → the rules it has been given an exemption for: every placed lesson that carries one, as the publication counts them
   * (PUB_EXEMPTIONS reads the column and not the board). The header says how many, and the list names each.
   */
  exemptions: ReadonlyMap<string, readonly ExemptRule[]>;
  /**
   * Lesson id → the rules of those it breaks NOW: what it stands against on purpose. A rule not here is an exemption nothing needs at the
   * moment (Generera has laid the class's meal elsewhere): it stays on the lesson, and the lesson stays locked, until its time, lock or place changes.
   */
  standing: ReadonlyMap<string, readonly ExemptRule[]>;
}

/**
 * Takes the hits of the rules a lesson is exempt from out of the clash map. An exemption never lifts another hit. A rule the lesson has an
 * exemption for and does not break now is still an exemption (the gateway has saved it, and the publication counts it), said apart from the ones
 * that hold something (`standing`). A page where no lesson has one gets its own map back, unchanged, so that nothing is drawn again for it.
 */
export function splitExemptions(
  conflictMap: ReadonlyMap<string, readonly ConflictHit[]>,
  lessonById: ReadonlyMap<string, MasterLesson>,
): ExemptionSplit {
  const exemptions = new Map<string, readonly ExemptRule[]>();
  const standing = new Map<string, readonly ExemptRule[]>();
  let conflicts: Map<string, readonly ConflictHit[]> | null = null;
  for (const [id, lesson] of lessonById) {
    // A lesson on the tray occupies nothing, and the gateway ends its exemption there: the publication does not count it either.
    if (!lesson.exemptFrom || lesson.exemptFrom.length === 0 || lesson.isParked) continue;
    const given = EXEMPT_RULES.filter((rule) => lesson.exemptFrom!.includes(rule));
    if (given.length === 0) continue;
    exemptions.set(id, given);
    const hits = conflictMap.get(id) ?? [];
    const breaking = given.filter((rule) => hits.some((found) => found.kind === rule));
    if (breaking.length === 0) continue;
    standing.set(id, breaking);
    conflicts ??= new Map(conflictMap);
    const rest = hits.filter((found) => !(breaking as readonly string[]).includes(found.kind));
    if (rest.length > 0) conflicts.set(id, rest);
    else conflicts.delete(id);
  }
  return { conflicts: conflicts ?? conflictMap, exemptions, standing };
}
