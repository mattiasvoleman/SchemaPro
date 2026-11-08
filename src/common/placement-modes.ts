import type { PlacementRuleMode } from '@prisma/client';

/**
 * Placeringsregler (20270126090000): which of the three rules is OFFERED hard.
 *
 *   edge    rule 1, not first or last in the class's day
 *   places  rule 2, at most N different rooms and M different buildings a day
 *   shared  rule 3, the pupils of a shared room fitting its capacity
 *
 * Only rule 3 is. A hard rule 1 cost 4.5 times the first timetable with eight
 * workers (23 with one) and a hard rule 2 2.8 to 3.6 times (9 with one), the
 * track of the hard sammanhängande undervisning that was dropped for its cost,
 * against a production limit of 60 s for Generera, and nothing measures the
 * objective phase with either; a soft rule 2 kept every limit it was measured
 * on. The engine still builds all six, so offering a hard rule later is this
 * table, the CHECK of that rule (a migration of its own), the API's refusal and
 * the card, and nothing in the engine.
 *
 * The API refuses a request that names HARD for a rule that is not offered
 * (src/resources/placement-rules.ts), the database refuses it for every other
 * way in (LunchSettings_placement…Mode_off_or_soft_check), and this file is the
 * last line: a row that still holds one (written before the CHECK, by an owner,
 * or by a migration that was not run) is READ as SOFT by the generator and by
 * the Skolregler endpoint, so the generator never builds the cost that is the
 * reason it is not offered and the card never draws a mode it cannot show.
 */
export type PlacementRule = 'edge' | 'places' | 'shared';

export const HARD_OFFERED: Readonly<Record<PlacementRule, boolean>> = {
  edge: false,
  places: false,
  shared: true,
};

/** The mode the rule is held at: a HARD that is not offered is SOFT, and anything else is as stored. */
export function offeredMode<T extends PlacementRuleMode | null | undefined>(rule: PlacementRule, mode: T): T | 'SOFT' {
  return mode === 'HARD' && !HARD_OFFERED[rule] ? 'SOFT' : mode;
}
