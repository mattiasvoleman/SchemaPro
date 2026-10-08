/*
 * Which of a requirement's lessons the hand-placed ones already answer.
 *
 * The proxy subtracts every preserved lesson that covers a requirement's weeks
 * (coversDemand in optimization-proxy.service.ts) from what it asks the engine
 * to place. With one length per requirement that is a count: each covering
 * lock cancels one lesson, whatever its own length. With lektionslängder it is
 * a question of WHICH lesson — a locked 80 of idrott 1 × 80 + 1 × 40 leaves
 * the 40 to place, not the 80 — so the subtraction is over lengths:
 *
 *  1. Exact matches first. A locked 40 cancels a 40, and nothing a later rule
 *     decides can take that 40 away from it.
 *  2. Every other lock, longest first, cancels the NEAREST remaining length;
 *     on a tie, the SHORTER one. The minutes then err toward over-delivery —
 *     an extra few minutes on the timetable, where the administrator sees
 *     them — which is the direction the proxy's coverage paragraph already
 *     chooses over a lesson quietly missing.
 *  3. A lock beyond the demand cancels nothing; the remainder never goes below
 *     empty.
 *
 * For a uniform requirement every rule above reduces to today's: one length,
 * so each covering lock cancels one lesson whatever it lasts. The answer is
 * the remaining lengths, longest first.
 */
export function coverLockedLessons(
  lengths: readonly number[],
  lockedMinutes: readonly number[],
): number[] {
  const remaining = [...lengths].sort((a, b) => b - a);
  const unmatched: number[] = [];
  for (const minutes of lockedMinutes) {
    const at = remaining.indexOf(minutes);
    if (at >= 0) remaining.splice(at, 1);
    else unmatched.push(minutes);
  }
  for (const minutes of unmatched.sort((a, b) => b - a)) {
    if (remaining.length === 0) break;
    let best = 0;
    for (let i = 1; i < remaining.length; i += 1) {
      const distance = Math.abs(remaining[i]! - minutes);
      const bestDistance = Math.abs(remaining[best]! - minutes);
      // Longest first, so a later index is never longer: a tie moves to it.
      if (distance <= bestDistance) best = i;
    }
    remaining.splice(best, 1);
  }
  return remaining;
}
