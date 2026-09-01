import type { LunchSitting } from "@/lib/types";
import { timeToMinutes } from "@/lib/utils";

export interface FlowEntry {
  startMinutes: number;
  endMinutes: number;
  /** Group ids seated together at this moment, in the order given. */
  studentGroupIds: string[];
  seated: number;
}

/**
 * One day's sittings, merged into the waves a kitchen actually serves.
 *
 * Classes that start at the same minute are one wave. Classes that merely
 * OVERLAP are not: 11:00-11:30 and 11:15-11:45 are two servings that share a
 * quarter of an hour, and a kitchen reading them as one would set out half the
 * trays at the wrong time. Merging by start is what a serving line does.
 *
 * `seated` is the sum of the wave's own headcounts, not the peak across the
 * day — peakSeated answers that, and the two are different questions: one is
 * how many trays this wave needs, the other whether the hall is big enough.
 */
export function lunchFlow(sittings: LunchSitting[], dayOfWeek: number): FlowEntry[] {
  const byStart = new Map<number, FlowEntry>();

  for (const sitting of sittings) {
    if (sitting.dayOfWeek !== dayOfWeek) continue;
    const startMinutes = timeToMinutes(sitting.startTime);
    const endMinutes = timeToMinutes(sitting.endTime);
    const wave = byStart.get(startMinutes);
    if (wave) {
      wave.studentGroupIds.push(sitting.studentGroupId);
      wave.seated += sitting.headcount;
      // A wave is as long as its longest member: two classes sitting down
      // together may not be given the same number of minutes to eat.
      wave.endMinutes = Math.max(wave.endMinutes, endMinutes);
    } else {
      byStart.set(startMinutes, {
        startMinutes,
        endMinutes,
        studentGroupIds: [sitting.studentGroupId],
        seated: sitting.headcount,
      });
    }
  }

  return [...byStart.values()].sort((a, b) => a.startMinutes - b.startMinutes);
}

/**
 * The most children in the hall at any one moment on this day.
 *
 * A sweep over the sittings' own boundaries rather than over the waves: two
 * waves that overlap are in the hall together, and summing the waves would
 * under-count exactly when the answer matters. Every change in occupancy
 * happens at some sitting's start, so the starts are the only instants worth
 * sampling.
 */
export function peakSeated(sittings: LunchSitting[], dayOfWeek: number): number {
  const today = sittings.filter((sitting) => sitting.dayOfWeek === dayOfWeek);
  let peak = 0;
  for (const at of today) {
    const instant = timeToMinutes(at.startTime);
    const seated = today.reduce(
      (sum, other) =>
        timeToMinutes(other.startTime) <= instant &&
        timeToMinutes(other.endTime) > instant
          ? sum + other.headcount
          : sum,
      0,
    );
    peak = Math.max(peak, seated);
  }
  return peak;
}
