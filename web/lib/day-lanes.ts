/**
 * Lanes for one day's lessons: overlapping lessons side by side, each told
 * its lane and how many lanes the day has.
 *
 * ONE laneCount for the whole day, not per cluster: a lesson far from any
 * overlap is drawn as narrow as the day's busiest hour. That is the
 * timetable's rule (components/schedule/timetable-grid.tsx, whose tests pin
 * it) and Schemavisaren's (app/v/[token]), which draws the same week for the
 * families — so a class's printed week and the admin's grid agree on where a
 * lesson sits. Lifted out of the grid for the viewer, unchanged.
 *
 * Greedy by start, then end: each lesson takes the first lane free by its
 * start, else a new one.
 */
export function layoutDay<T extends { startMinutes: number; endMinutes: number }>(
  lessons: readonly T[],
): Array<T & { lane: number; laneCount: number }> {
  const sorted = [...lessons].sort(
    (a, b) => a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes,
  );
  const laneEnds: number[] = [];
  const positioned: Array<T & { lane: number }> = [];

  for (const lesson of sorted) {
    let lane = laneEnds.findIndex((end) => end <= lesson.startMinutes);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(0);
    }
    laneEnds[lane] = lesson.endMinutes;
    positioned.push({ ...lesson, lane });
  }

  const laneCount = Math.max(1, laneEnds.length);
  return positioned.map((lesson) => ({ ...lesson, laneCount }));
}
