/**
 * Minutes since midnight as a wall clock: 485 → "08:05".
 *
 * For windows the school day pages COMPUTE from their rows (lib/frame-times,
 * lib/rasts, lib/lunch-flow all answer in minutes), so they print in the same
 * HH:MM as the stored times beside them. Ramtider, raster and lunchsittningar
 * each carried a copy of this under a different name (clock, clock, hhmm).
 */
export function clock(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}
