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

/**
 * Lanes per overlap CLUSTER, for Schemavisaren's printed week.
 *
 * The admin grid draws a day as narrow as its busiest hour (layoutDay, kept
 * as it is): a planner reads the day's structure. A family's door sheet does
 * not. A språkval of three groups at 10:50 squeezed every other lesson of the
 * day into a third of the column, clipping the room and the teacher, which
 * are what a pupil needs from the sheet. Here a lesson that overlaps nothing
 * is full width, and only the lessons that overlap one another, directly or
 * through a chain, share their cluster's lanes.
 */
export function layoutClusters<T extends { startMinutes: number; endMinutes: number }>(
  lessons: readonly T[],
): Array<T & { lane: number; laneCount: number }> {
  const sorted = [...lessons].sort(
    (a, b) => a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes,
  );
  const out: Array<T & { lane: number; laneCount: number }> = [];
  let cluster: T[] = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    if (cluster.length > 0) out.push(...layoutDay(cluster));
    cluster = [];
  };
  for (const lesson of sorted) {
    if (lesson.startMinutes >= clusterEnd) {
      flush();
      clusterEnd = lesson.endMinutes;
    } else {
      clusterEnd = Math.max(clusterEnd, lesson.endMinutes);
    }
    cluster.push(lesson);
  }
  flush();
  return out;
}
