/**
 * The strength band a soft rule's weight falls in.
 *
 * The scale is the engine's own. Every objective — spread, teacher gaps,
 * disruption, the preferred-free and preferred-busy wishes — is summed into
 * one linear objective, so a room preference of 5 is worth exactly as much per
 * violation as a preferred-busy violation, and less than a disruption (8). The
 * slider therefore shares the range the objective weights on the generation
 * page use (0–50), and the bands are anchored to the numbers it competes with:
 *
 *     spread            3
 *     preferred_busy    5   <- the engine's own default for this
 *     disruption        8
 *     preferred_free   10
 *
 * An earlier version ran 10–200 with a default of 50. Nothing rejected it —
 * the API accepts 1–1000 — but every setting on it outweighed the whole rest
 * of the objective, so "weak" already meant "beats everything".
 */
export const STRENGTH_MIN = 1;
export const STRENGTH_MAX = 50;
export const STRENGTH_STEP = 1;
/** The engine's own weight_room_preference, so the form agrees with the default. */
export const STRENGTH_DEFAULT = 5;

export type StrengthBand = "weak" | "normal" | "strong" | "veryStrong";

/** Bands read against the objectives above, not against the slider's own span. */
export function strengthBand(weight: number): StrengthBand {
  if (weight < 3) return "weak"; // below spread
  if (weight < 10) return "normal"; // between spread and preferred_free
  if (weight < 25) return "strong"; // above every other objective
  return "veryStrong"; // several times everything else combined
}

/**
 * Slider bounds that can still show the value they are given.
 *
 * A rule saved with a weight above the usual band — by the earlier 10–200 scale,
 * an import, or the API directly — must not be silently dragged down the moment
 * somebody opens the form. The slider stretches to fit instead, which matters
 * more now than before: every rule created under the old scale sits above this
 * one's maximum.
 */
export function strengthBounds(weight: number): { min: number; max: number } {
  return {
    min: Math.min(STRENGTH_MIN, weight),
    max: Math.max(STRENGTH_MAX, weight),
  };
}

/** Clamps a slider value to something the API will accept. */
export function clampStrength(weight: number): number {
  if (!Number.isFinite(weight)) return STRENGTH_DEFAULT;
  return Math.min(1000, Math.max(1, Math.round(weight)));
}
