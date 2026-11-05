/**
 * A number cell as a school writes one, read the same way in every number
 * column of every import file.
 *
 * Digits, then a decimal part after a comma or a point — the comma is what
 * Swedish Excel writes, the point what everything else does — and in a
 * percent column a trailing "%" with or without a space. So 3, 3,0 and 3.0
 * are the same three lessons, and 12,5, 12.5 and "12,5 %" the same
 * nedsättning. A decimal part longer than the column holds (3,5 lessons,
 * 66,6667 %) is refused, and so is everything Number() would have let
 * through though nobody writes it in a cell: 0x3, 1e1, a thousands
 * separator, and a sign except where the column takes one (a floor). The
 * caller says what the column takes.
 *
 * Its own module because the lokal timplan's reader (lib/timplan-csv.ts)
 * ships with its page and must not pull in lib/csv.ts.
 */
export function readNumber(
  cell: string,
  {
    decimals = 0,
    percent = false,
    signed = false,
  }: { decimals?: number; percent?: boolean; signed?: boolean } = {},
): number | null {
  const text = percent ? cell.trim().replace(/\s*%$/, "") : cell.trim();
  // A floor below ground is -1, and Excel may write its minus as U+2212.
  const match = /^([-\u2212]?)(\d+)(?:[.,](\d+))?$/.exec(text);
  if (!match || (match[1] !== "" && !signed)) return null;
  const fraction = (match[3] ?? "").replace(/0+$/, "");
  if (fraction.length > decimals) return null;
  const value = Number(`${match[2]}.${fraction || "0"}`);
  return match[1] === "" || value === 0 ? value : -value;
}
