/**
 * The strength band a soft rule's weight falls in.
 *
 * The API accepts 1–1000, but a bare number tells an admin nothing: is 50 a
 * lot? The slider therefore covers the band schools actually use and pairs the
 * number with a word, so the setting can be reasoned about without knowing how
 * the optimizer sums its objectives.
 */
export const STRENGTH_MIN = 10;
export const STRENGTH_MAX = 200;
export const STRENGTH_STEP = 10;
export const STRENGTH_DEFAULT = 50;

export type StrengthBand = "weak" | "normal" | "strong" | "veryStrong";

export function strengthBand(weight: number): StrengthBand {
  if (weight < 30) return "weak";
  if (weight < 80) return "normal";
  if (weight < 150) return "strong";
  return "veryStrong";
}

/**
 * Slider bounds that can still show the value they are given.
 *
 * A rule saved with a weight above the usual band — by an earlier version, an
 * import, or the API directly — must not be silently dragged down to 200 the
 * moment somebody opens the form. The slider stretches to fit instead.
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
