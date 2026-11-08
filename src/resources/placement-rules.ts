import { BadRequestException } from '@nestjs/common';
import { Prisma, type PlacementRuleMode } from '@prisma/client';

/**
 * Placeringsregler (20270126090000), the Skolregler half: three rules about
 * where a lesson is placed, each OFF, SOFT or HARD, and OFF for every school
 * until it turns one on.
 *
 *   1. a subject marked not first / not last in a class's day
 *      (placementEdge…, Subject.notFirstInDay / notLastInDay);
 *   2. at most N DIFFERENT room groups and M different buildings in a day,
 *      for a class and for a teacher apart (placementPlaces…, the four
 *      max…PerDay): 1 is a single one, never a change;
 *   3. the pupils of a shared room together fitting its capacity
 *      (placementShared…, Room.canBeShared).
 *
 * This file is what the Skolregler service and its DTO share: the names, the
 * bounds (the database's own CHECKs, LunchSettings_placement…_check and
 * LunchSettings_max…PerDay_check) and the one rule that depends on
 * more than one field.
 */

export const PLACEMENT_RULE_MODES: readonly PlacementRuleMode[] = ['OFF', 'SOFT', 'HARD'];

/** The weights are on the scale of the engine's other objective weights. */
export const PLACEMENT_WEIGHT_MIN = 1;
export const PLACEMENT_WEIGHT_MAX = 1000;
/** 1 is a single room group or building in a day, never a change. */
export const PLACE_LIMIT_MIN = 1;
export const PLACE_LIMIT_MAX = 20;

export const MODE_FIELDS = ['placementEdgeMode', 'placementPlacesMode', 'placementSharedMode'] as const;
export const WEIGHT_FIELDS = ['placementEdgeWeight', 'placementPlacesWeight', 'placementSharedWeight'] as const;
export const PLACE_LIMIT_FIELDS = [
  'maxClassRoomsPerDay',
  'maxTeacherRoomsPerDay',
  'maxClassBuildingsPerDay',
  'maxTeacherBuildingsPerDay',
] as const;

export type ModeField = (typeof MODE_FIELDS)[number];
export type WeightField = (typeof WEIGHT_FIELDS)[number];
export type PlaceLimitField = (typeof PLACE_LIMIT_FIELDS)[number];

/** What a PUT of the Skolregler may carry of these rules: every key optional, absent keeps. */
export type PlacementInput = { [K in ModeField]?: PlacementRuleMode } & { [K in WeightField]?: number } & {
  [K in PlaceLimitField]?: number | null;
};

/** The problem `code` of a rule 2 that is on without a single limit. */
export const PLACEMENT_PLACES_NEEDS_A_LIMIT = 'PLACEMENT_PLACES_NEEDS_A_LIMIT';

/**
 * The problem `code` of rule 1 asked to be HARD. Not offered until it is
 * measured: a hard rule 1 cost 4.5 times the first timetable with eight
 * workers (23 times with one) on the högstadium test school, the same track
 * as the hard sammanhängande undervisning that was dropped for its cost, and
 * the production time limit of Generera is 60 s at the floor. The engine
 * still builds it and the database's CHECK still allows it, so offering it is
 * this refusal, the card and the manual going together.
 */
export const PLACEMENT_EDGE_HARD_NOT_OFFERED = 'PLACEMENT_EDGE_HARD_NOT_OFFERED';

/** The CHECK that says the same in the database (a backstop for the way in that is not this service). */
export const PLACEMENT_PLACES_NEEDS_A_LIMIT_CHECK = 'LunchSettings_placementPlaces_needs_a_limit_check';

/** The ten columns, in the order the form shows them. */
export const PLACEMENT_FIELDS = [
  'placementEdgeMode',
  'placementEdgeWeight',
  'placementPlacesMode',
  'placementPlacesWeight',
  ...PLACE_LIMIT_FIELDS,
  'placementSharedMode',
  'placementSharedWeight',
] as const;

/**
 * The columns a request names, and only those. A Skolregler tab loaded before
 * these rules existed PUTs the row without them and must not turn off a rule a
 * colleague turned on, so absent is not a value: it leaves the column as it is
 * (and, on a school's first row, as the column's default: OFF, 250, no limit).
 * A limit may be null, which clears it.
 */
export function placementDataOf(dto: PlacementInput): PlacementInput {
  const data: Record<string, unknown> = {};
  for (const field of PLACEMENT_FIELDS) {
    if (dto[field] !== undefined) data[field] = dto[field];
  }
  return data as PlacementInput;
}

/** Whether the request says anything about rule 2, which is the only rule that depends on more than one field. */
export function touchesPlacesRule(dto: PlacementInput): boolean {
  return dto.placementPlacesMode !== undefined || PLACE_LIMIT_FIELDS.some((field) => dto[field] !== undefined);
}

/** What the row holds of rule 2, or nothing when the school has no row yet. */
export type StoredPlacesRule = { placementPlacesMode: PlacementRuleMode } & {
  [K in PlaceLimitField]: number | null;
};

/**
 * Rule 2 that is SOFT or HARD needs at least one limit: a mode with no number
 * is a rule nothing can read, and the engine refuses a block that limits
 * nothing. Judged on the row AS IT WOULD BE: what the request names over what
 * is stored, so turning the rule on needs a limit set in the same request or
 * before it, and clearing the last limit of a rule that is on is refused.
 * Turning the rule OFF with every limit cleared is allowed.
 *
 * The other two rules need nothing: rule 1 with no subject marked, and rule 3
 * with no room marked, are allowed and do nothing, because a school turns the
 * rule on and then marks (the gateway sends the engine nothing for a rule that
 * has nothing to apply to).
 */
export function assertPlacesHaveALimit(dto: PlacementInput, stored: StoredPlacesRule | null): void {
  const mode = dto.placementPlacesMode ?? stored?.placementPlacesMode ?? 'OFF';
  if (mode === 'OFF') return;
  const hasALimit = PLACE_LIMIT_FIELDS.some((field) => (dto[field] !== undefined ? dto[field] : (stored?.[field] ?? null)) !== null);
  if (!hasALimit) throw placesNeedALimit();
}

/**
 * Rule 1 is OFF or SOFT until it has been measured hard. Stateless: a request
 * that names HARD is refused, whatever the row holds, so a school never gets
 * into a state the card cannot draw. Swedish, as the rest of this form's
 * refusals: the card shows the sentence under the same code in both languages
 * (placementRules.errors).
 */
export function edgeCannotBeHard(): BadRequestException {
  return new BadRequestException({
    message:
      'placementEdgeMode: regeln om första och sista lektionen på dagen kan inte vara hård ännu (HARD): ' +
      'den är inte mätt på en stor skola och kan göra Generera mycket långsam. Använd OFF eller SOFT.',
    code: PLACEMENT_EDGE_HARD_NOT_OFFERED,
  });
}

export function placesNeedALimit(): BadRequestException {
  return new BadRequestException({
    message:
      'placementPlacesMode: regeln om olika salar och byggnader per dag som mjuk eller hård behöver minst en gräns: ' +
      'klassens eller lärarens olika salar eller byggnader per dag.',
    code: PLACEMENT_PLACES_NEEDS_A_LIMIT,
  });
}

/**
 * The CHECK above, met by a request that raced another: the read said a limit
 * was there and the write found it gone. The database's refusal arrives as
 * P2039 with the constraint's name in the driver's message, and is the same
 * 400 the service gives first.
 */
export function isPlacesNeedALimitCheck(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  const cause = (error.meta as { driverAdapterError?: { cause?: { originalMessage?: unknown } } } | undefined)
    ?.driverAdapterError?.cause;
  const text = typeof cause?.originalMessage === 'string' ? cause.originalMessage : error.message;
  return text.includes(PLACEMENT_PLACES_NEEDS_A_LIMIT_CHECK);
}
