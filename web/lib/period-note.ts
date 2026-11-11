/**
 * Terminer: where in the läsår a refusal was counted.
 *
 * The generator counts a week at a time, and a school with dated posts has
 * several: the autumn's posts, the spring's, the week two terms share. A
 * refusal counted in one of them says which. The engine names it by an index
 * (`period`), the API turns that into the first stretch of days the period
 * has (`periodFrom`, `periodTo`), how many stretches it has in all
 * (`periodStretches`), and — for a week of odd or even weeks only — which
 * (`parity`). This reads those four out of a sentence's params, or nothing
 * when the refusal names no period: every refusal of a school that dates no
 * post.
 */
export interface PeriodDates {
  /** YYYY-MM-DD. */
  from: string;
  to: string;
  /** Whether the period has more stretches of weeks than the one named. */
  more: boolean;
  parity: "ODD_WEEKS" | "EVEN_WEEKS" | "ALL";
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function periodDatesOf(params: Record<string, string | number> | null | undefined): PeriodDates | null {
  if (!params) return null;
  const { periodFrom: from, periodTo: to, periodStretches: stretches, parity } = params;
  if (typeof from !== "string" || typeof to !== "string" || !DAY.test(from) || !DAY.test(to)) return null;
  return {
    from,
    to,
    more: typeof stretches === "number" && stretches > 1,
    parity: parity === "ODD_WEEKS" || parity === "EVEN_WEEKS" ? parity : "ALL",
  };
}

/**
 * A day of the läsår as a school reads it: "11 januari 2027", "11 January
 * 2027". Read in UTC, as the day was written: a date has no hour to shift.
 */
export function periodDay(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "sv-SE", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00.000Z`));
}
