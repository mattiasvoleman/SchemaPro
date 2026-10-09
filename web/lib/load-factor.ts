/**
 * Ett ämnes faktor (Subjects.loadFactor, staffing Fas 3), as a form reads it.
 *
 * The bounds are Subjects_loadFactor_is_sane's (migration 20261010100000) and
 * the subject DTO's: 0,5..3 with at most three decimals, 1 = "the minutes as
 * they are". Written out here rather than imported from lib/staffing-forms,
 * because the subjects page carries this and must not carry the staffing forms
 * with it; the arithmetic is two lines.
 *
 * The factor is only READ when the school's tjänstefördelning counts with
 * Faktor (StaffingPolicy.loadModel FACTOR); a MINUTES school may set one and
 * nothing moves. The fields that edit it say so.
 */

export const LOAD_FACTOR_MIN = 0.5;
export const LOAD_FACTOR_MAX = 3;
export const LOAD_FACTOR_DECIMALS = 3;

/**
 * The factor a field holds, or null when it is not one: a decimal comma or
 * point, at most three decimals, inside 0,5..3. An empty field is null too —
 * the column is NOT NULL, so "no factor" is 1, said as 1.
 */
export function parseLoadFactor(value: string): number | null {
  const trimmed = value.trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const [, fraction = ""] = trimmed.split(".");
  if (fraction.length > LOAD_FACTOR_DECIMALS) return null;
  const factor = Number(trimmed);
  if (!Number.isFinite(factor) || factor < LOAD_FACTOR_MIN || factor > LOAD_FACTOR_MAX) {
    return null;
  }
  return factor;
}

/** "1", "0,8", "1,125" — the way the field shows a stored factor. */
export function formatLoadFactor(factor: number | null | undefined): string {
  const value = factor ?? 1;
  return String(Math.round(value * 1000) / 1000).replace(".", ",");
}
